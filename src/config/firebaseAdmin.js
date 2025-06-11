// server/src/config/firebaseAdmin.js
import admin from 'firebase-admin';
import fs from 'fs';
import { FIREBASE_SERVICE_ACCOUNT } from './index.js';

let serviceAccount;

if (process.env.NODE_ENV === 'production') {
  // Production: Use env variable (for Railway/hosted)
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON env variable is required in production.');
  }
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} else {
  // Development: Use file path
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT env variable is required in development.');
  }
  serviceAccount = JSON.parse(fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT, 'utf8'));
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

console.log('✅ Firebase Admin SDK initialized with service account.');

export default admin;