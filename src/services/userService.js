import { db } from '../models/dbConfig.js';

/**
 * Ensures a user profile exists in the global users collection.
 * If it doesn't exist, creates it. If it exists, updates lastLogin and optionally displayName/avatarUrl.
 * @param {string} uid - Firebase Auth UID
 * @param {string} displayName - User's display name
 * @param {string|null} avatarUrl - User's avatar URL (optional)
 */
export async function ensureUserProfile(uid, displayName, avatarUrl = null) {
  const userRef = db.collection('users').doc(uid);
  const userDoc = await userRef.get();
  if (!userDoc.exists) {
    await userRef.set({
      displayName,
      avatarUrl,
      createdAt: new Date(),
      lastLogin: new Date(),
      globalStats: {},
    });
  } else {
    await userRef.set(
      {
        lastLogin: new Date(),
        ...(displayName && { displayName }),
        ...(avatarUrl && { avatarUrl }),
      },
      { merge: true }
    );
  }
} 