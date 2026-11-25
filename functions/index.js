const crypto = require("node:crypto");
const { initializeApp } = require("firebase-admin/app");
const { FieldValue, Timestamp, getFirestore } = require("firebase-admin/firestore");
const { logger } = require("firebase-functions");
const { defineSecret, defineString } = require("firebase-functions/params");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");

initializeApp();

const db = getFirestore();
const REGION = "us-central1";
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");
const EMAIL_FROM = defineString("EMAIL_FROM", {
  description: "Verified Resend sender, for example 日序 <reminders@example.com>",
});
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const MAX_ATTEMPTS = 3;
const LEASE_MS = 5 * 60 * 1000;
const RETRY_DELAYS_MS = [5 * 60 * 1000, 15 * 60 * 1000];

function reminderRef(userId, taskId) {
  return db.collection("users").doc(userId).collection("reminders").doc(taskId);
}

function titleForEmail(value) {
  return String(value || "未命名任務").replace(/[\r\n\t]+/g, " ").trim().slice(0, 90) || "未命名任務";
}

function emailIsValid(value) {
  return typeof value === "string" && value.length <= 254 && EMAIL_PATTERN.test(value);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function buildReminderEmail(job) {
  const title = titleForEmail(job.title);
  const dueLine = job.due ? `截止日期：${job.due}\n` : "";
  const at = String(job.localAt || "").replace("T", " ");
  const safeTitle = escapeHtml(title);
  const safeAt = escapeHtml(at);
  const safeDue = job.due ? `<p>截止日期：${escapeHtml(job.due)}</p>` : "";
  const text = `日序任務提醒\n\n${title}\n提醒時間：${at}\n${dueLine}\n開啟日序，查看並更新你的任務。`;
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.7;color:#20243a"><h2>日序任務提醒</h2><p>提醒時間：${safeAt}</p><p style="font-size:18px;font-weight:700">${safeTitle}</p>${safeDue}<p>開啟日序，查看並更新你的任務。</p><p><a href="https://tim9664.github.io/App-class/">開啟日序</a></p></div>`;
  return { subject: `日序提醒：${title}`, text, html };
}

exports.syncTaskReminder = onDocumentWritten(
  {
    document: "users/{userId}/tasks/{taskId}",
    region: REGION,
    maxInstances: 10,
  },
  async (event) => {
    const { userId, taskId } = event.params;
    const ref = reminderRef(userId, taskId);
    const task = event.data?.after.exists ? event.data.after.data() : null;

    await db.runTransaction(async (transaction) => {
      const existingSnapshot = await transaction.get(ref);
      const existing = existingSnapshot.exists ? existingSnapshot.data() : null;

      if (!task || !task.reminder || task.done || task.cancelled) {
        if (existing && !["sent", "failed"].includes(existing.state)) {
          transaction.set(ref, {
            state: "cancelled",
            cancelReason: !task ? "task_deleted" : task.done || task.cancelled ? "task_closed" : "reminder_removed",
            updatedAt: FieldValue.serverTimestamp(),
            leaseUntil: FieldValue.delete(),
          }, { merge: true });
        }
        return;
      }

      const reminder = task.reminder;
      const scheduledAt = typeof reminder.atUtc === "string" ? reminder.atUtc : "";
      const scheduledMillis = Date.parse(scheduledAt);
      if (!Number.isFinite(scheduledMillis) || !emailIsValid(reminder.email)) {
        transaction.set(ref, {
          uid: userId,
          taskId,
          title: titleForEmail(task.title),
          email: typeof reminder.email === "string" ? reminder.email.slice(0, 254) : "",
          localAt: typeof reminder.at === "string" ? reminder.at : "",
          due: task.due || null,
          scheduledAt,
          state: "failed",
          lastError: "提醒資料不完整，請重新設定提醒時間與收件信箱。",
          updatedAt: FieldValue.serverTimestamp(),
          leaseUntil: FieldValue.delete(),
        }, { merge: true });
        return;
      }

      const sameSchedule = existing && existing.scheduledAt === scheduledAt && existing.email === reminder.email;
      if (sameSchedule && existing.state !== "cancelled") {
        transaction.set(ref, {
          title: titleForEmail(task.title),
          due: task.due || null,
          localAt: reminder.at,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return;
      }

      if (scheduledMillis <= Date.now() - 5 * 60 * 1000) {
        transaction.set(ref, {
          uid: userId,
          taskId,
          title: titleForEmail(task.title),
          email: reminder.email,
          localAt: reminder.at,
          due: task.due || null,
          scheduledAt,
          sendAt: Timestamp.fromMillis(scheduledMillis),
          state: "cancelled",
          cancelReason: "reminder_time_passed",
          updatedAt: FieldValue.serverTimestamp(),
          leaseUntil: FieldValue.delete(),
        }, { merge: true });
        return;
      }

      transaction.set(ref, {
        uid: userId,
        taskId,
        title: titleForEmail(task.title),
        email: reminder.email,
        localAt: reminder.at,
        due: task.due || null,
        scheduledAt,
        sendAt: Timestamp.fromMillis(Math.max(scheduledMillis, Date.now())),
        nextAttemptAt: Timestamp.fromMillis(Math.max(scheduledMillis, Date.now())),
        state: "pending",
        attempts: 0,
        cancelReason: FieldValue.delete(),
        lastError: FieldValue.delete(),
        leaseUntil: FieldValue.delete(),
        createdAt: existing?.createdAt || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
  },
);

async function claimReminder(ref) {
  return db.runTransaction(async (transaction) => {
    const jobSnapshot = await transaction.get(ref);
    if (!jobSnapshot.exists) return null;
    const job = jobSnapshot.data();
    const now = Timestamp.now();

    if (["sent", "cancelled", "failed"].includes(job.state)) return null;
    if (job.state === "pending" && job.nextAttemptAt?.toMillis() > now.toMillis()) return null;
    if (job.state === "processing" && job.leaseUntil?.toMillis() > now.toMillis()) return null;

    const userId = ref.parent.parent.id;
    const taskRef = db.collection("users").doc(userId).collection("tasks").doc(job.taskId);
    const taskSnapshot = await transaction.get(taskRef);
    const task = taskSnapshot.exists ? taskSnapshot.data() : null;
    const stillMatches = task && !task.done && !task.cancelled &&
      task.reminder?.atUtc === job.scheduledAt && task.reminder?.email === job.email;

    if (!stillMatches) {
      if (job.state !== "sent" && job.state !== "failed") {
        transaction.update(ref, {
          state: "cancelled",
          cancelReason: !taskSnapshot.exists ? "task_deleted" : "task_changed",
          updatedAt: FieldValue.serverTimestamp(),
          leaseUntil: FieldValue.delete(),
        });
      }
      return null;
    }

    const attempts = Number(job.attempts || 0) + 1;
    transaction.update(ref, {
      state: "processing",
      attempts,
      leaseUntil: Timestamp.fromMillis(now.toMillis() + LEASE_MS),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { job: { ...job, uid: userId }, attempts };
  });
}

async function markSent(ref, attempts) {
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists || snapshot.data().state !== "processing" || snapshot.data().attempts !== attempts) return;
    transaction.update(ref, {
      state: "sent",
      sentAt: FieldValue.serverTimestamp(),
      lastError: FieldValue.delete(),
      leaseUntil: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

async function markFailedOrRetry(ref, attempts, error) {
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists || snapshot.data().state !== "processing" || snapshot.data().attempts !== attempts) return;
    const retryDelay = RETRY_DELAYS_MS[attempts - 1];
    const retry = attempts < MAX_ATTEMPTS && retryDelay != null;
    transaction.update(ref, {
      state: retry ? "pending" : "failed",
      nextAttemptAt: retry ? Timestamp.fromMillis(Date.now() + retryDelay) : FieldValue.delete(),
      lastError: String(error?.message || error || "郵件服務暫時無法寄送").slice(0, 300),
      leaseUntil: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

async function sendReminder(job) {
  if (!emailIsValid(job.email)) throw new Error("收件地址格式無效");
  const content = buildReminderEmail(job);
  const key = crypto.createHash("sha256")
    .update(`${job.uid}:${job.taskId}:${job.scheduledAt}`)
    .digest("hex");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY.value()}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({
      from: EMAIL_FROM.value(),
      to: [job.email],
      subject: content.subject,
      text: content.text,
      html: content.html,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `郵件服務回應 ${response.status}`);
  return payload;
}

exports.sendDueReminders = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: "Etc/UTC",
    region: REGION,
    maxInstances: 1,
    memory: "256MiB",
    timeoutSeconds: 120,
    secrets: [RESEND_API_KEY],
  },
  async () => {
    const now = Timestamp.now();
    const [pendingSnapshot, expiredLeaseSnapshot] = await Promise.all([
      db.collectionGroup("reminders")
        .where("state", "==", "pending")
        .where("nextAttemptAt", "<=", now)
        .orderBy("nextAttemptAt", "asc")
        .limit(100)
        .get(),
      db.collectionGroup("reminders")
        .where("state", "==", "processing")
        .where("leaseUntil", "<=", now)
        .orderBy("leaseUntil", "asc")
        .limit(100)
        .get(),
    ]);
    const refs = new Map();
    for (const doc of [...pendingSnapshot.docs, ...expiredLeaseSnapshot.docs]) refs.set(doc.ref.path, doc.ref);

    for (const ref of refs.values()) {
      const claimed = await claimReminder(ref);
      if (!claimed) continue;
      try {
        await sendReminder(claimed.job);
        await markSent(ref, claimed.attempts);
        logger.info("Email reminder sent", { taskId: claimed.job.taskId, userId: claimed.job.uid });
      } catch (error) {
        await markFailedOrRetry(ref, claimed.attempts, error);
        logger.error("Email reminder delivery failed", {
          taskId: claimed.job.taskId,
          userId: claimed.job.uid,
          attempt: claimed.attempts,
          error: String(error?.message || error).slice(0, 300),
        });
      }
    }
  },
);
