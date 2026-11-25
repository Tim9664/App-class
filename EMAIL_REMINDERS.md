# Email reminders

Task reminders are stored with a local date/time, an exact UTC timestamp, and a recipient address. A Firestore trigger mirrors each active reminder into the private `users/{uid}/reminders/{taskId}` queue. A scheduled Firebase Function checks the queue once per minute, sends due messages through Resend, retries temporary failures up to three times, and records `pending`, `processing`, `sent`, `failed`, or `cancelled` status. Users can read their own delivery status; browser clients cannot create or change queue records.

The reminder is a one-time email for a task. Completing or cancelling a task before its reminder time cancels delivery. Times are converted to UTC in the browser, so the selected local time is retained when the scheduled function runs.

## One-time deployment setup

1. Upgrade Firebase project `appclass-4667a` from the current Spark plan to Blaze. Scheduled Cloud Functions require a billing account.
2. Create a Resend account, verify a sending domain you control, and create an API key with email sending access. GitHub Pages does not provide a sender domain, so use a verified domain address for `EMAIL_FROM`.
3. Install Firebase CLI and sign in to the account with access to `appclass-4667a`.
4. From the repository root, set the API key using the interactive prompt:

   ```sh
   firebase functions:secrets:set RESEND_API_KEY --project appclass-4667a
   ```

   Paste the key only into the CLI prompt. Do not put it in source files, GitHub Pages, or chat.

5. Deploy the functions, rules, and indexes:

   ```sh
   firebase deploy --only functions,firestore:rules,firestore:indexes --project appclass-4667a
   ```

   The first deploy prompts for `EMAIL_FROM`; enter a verified sender such as `日序 <reminders@example.com>` and keep the generated `.env.appclass-4667a` file out of Git.

The website itself remains hosted on GitHub Pages. Firebase Functions, Firestore rules, and Firestore indexes are deployed to Firebase separately. The Firebase project was on Spark when this implementation was prepared, so live sending will not begin until billing is enabled, the Resend values are configured, and the backend deploy succeeds.
