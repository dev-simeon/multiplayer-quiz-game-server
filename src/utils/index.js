// server/src/utils/index.js
import crypto from 'crypto';

/**
 * Generate a unique, human-friendly room code.
 * Defaults to 6 uppercase alphanumeric characters.
 * @param {number} length
 * @returns {string}
 */
export function generateRoomCode(length = 6) {
  // Generate random bytes, then map to allowed chars
  const bytes = crypto.randomBytes(length);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // exclude confusing chars
  let code = '';
  for (let i = 0; i < length; i++) {
    // Use byte modulo char length
    const idx = bytes[i] % chars.length;
    code += chars[idx];
  }
  return code;
}
