import express from 'express';
import admin from '../config/firebaseAdmin.js';
import { db } from '../models/dbConfig.js';

const router = express.Router();

// Middleware to verify Firebase token
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.split('Bearer ')[1]
    : null;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Get profile
router.get('/', authenticate, async (req, res) => {
  const doc = await db.collection('users').doc(req.user.uid).get();
  if (!doc.exists) return res.status(404).json({ error: 'Profile not found' });
  res.json(doc.data());
});

// Update profile
router.put('/', authenticate, async (req, res) => {
  const { displayName, avatarUrl } = req.body;
  await db.collection('users').doc(req.user.uid).set(
    { displayName, avatarUrl, lastUpdated: new Date() },
    { merge: true }
  );
  res.json({ success: true });
});

export default router; 