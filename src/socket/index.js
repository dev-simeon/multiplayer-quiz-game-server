// server/src/socket/index.js
import registerRoomHandlers from './roomHandlers.js';
import registerGameHandlers from './gameHandlers.js';
import { initGameService } from '../services/gameService.js';
import admin from '../config/firebaseAdmin.js';
import { ensureUserProfile } from '../services/userService.js';

// Map to track user UID to their socket.id
const uidToSocketId = new Map();

/**
 * Initializes socket.io handlers with Firebase Auth and game service setup.
 * @param {import('socket.io').Server} io
 */
export default function initializeSocketHandlers(io) {
  // Initialize gameService with the io instance for server-authoritative timeouts
  initGameService(io);

  // Firebase Auth middleware: verify Firebase ID token on connection
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      const err = new Error('Authentication error: token missing');
      err.data = { content: 'Please provide a valid Firebase ID token.' };
      return next(err);
    }
    try {
      const decoded = await admin.auth().verifyIdToken(token);
      socket.user = {
        uid: decoded.uid,
        name: decoded.name || decoded.email,
        picture: decoded.picture || null,
      };
      // Ensure user profile exists/updated
      await ensureUserProfile(
        decoded.uid,
        decoded.name || decoded.email,
        decoded.picture || null
      );
      return next();
    } catch (error) {
      console.error('Socket auth error:', error);
      const err = new Error('Authentication error: token invalid');
      err.data = { content: 'Firebase token is invalid or expired.' };
      return next(err);
    }
  });

  io.on('connection', (socket) => {
    console.log(`✅ Client connected: ${socket.id} (uid: ${socket.user.uid})`);

    // Track UID to socket.id mapping
    uidToSocketId.set(socket.user.uid, socket.id);

    // Welcome message
    socket.emit('message', `Welcome, ${socket.user.name}!`);

    // Register handlers
    registerRoomHandlers(io, socket);
    registerGameHandlers(io, socket);

    // General disconnect handler (not per-room cleanup)
    socket.on('disconnect', (reason) => {
      console.log(`🚪 Client disconnected: ${socket.id}. Reason: ${reason}`);
      // Remove UID mapping on disconnect
      uidToSocketId.delete(socket.user.uid);
      // Room-specific cleanup is handled in 'disconnecting' events in roomHandlers.js / gameHandlers.js
    });
  });
}

// Export the map for use in other handlers
export { uidToSocketId };

