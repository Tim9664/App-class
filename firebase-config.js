// Firebase Web app configuration is public client configuration, not a secret.
// Fill this from Firebase Console > Project settings > Your apps.
export const firebaseConfig = {
  apiKey: "AIzaSyCipsnJgwrG6JDgSbVGduAxcSGJrNO7_MI",
  authDomain: "appclass-4667a.firebaseapp.com",
  projectId: "appclass-4667a",
  storageBucket: "appclass-4667a.firebasestorage.app",
  messagingSenderId: "669234993306",
  appId: "1:669234993306:web:edda248d61196a90e8e723",
  measurementId: "G-PDCC3279BE",
  // Public reCAPTCHA Enterprise site key for Firebase App Check.
  recaptchaSiteKey: "6Lcy_S8uAAAAAM1ir2BrtLmzI-0m9iFgGmSRNITV",
};

export const firebaseConfigured = [
  "apiKey",
  "authDomain",
  "projectId",
  "messagingSenderId",
  "appId",
].every((key) => typeof firebaseConfig[key] === "string" && firebaseConfig[key].trim());
