// server/src/socket/roomHandlers.js
import {
  getRoom as getRoomModel,
  // updateRoom as updateRoomModel // Not directly used, roomService handles updates
} from "../models/roomModel.js";
import {
  createRoom as serviceCreateRoom,
  joinRoom as serviceJoinRoom,
  leaveRoom as serviceLeaveRoom,
  getRoomPlayers,
  updateGameSettings as serviceUpdateGameSettings, // Import new service function
} from "../services/roomService.js";

import {
  handlePlayerLeave as handlePlayerLeaveGameConsequences,
  // Import if you want to send spectator game state from gameService
  // getActiveGameStateForSpectator as serviceGetActiveGameStateForSpectator
} from "../services/gameService.js";
import { uidToSocketId } from "./index.js";

const emitPlayerListUpdate = async (io, roomId) => {
  try {
    const players = await getRoomPlayers(roomId); // Should include role, online status
    const roomDoc = await getRoomModel(roomId);
    const currentHostUid = roomDoc.exists ? roomDoc.data().hostUid : null;
    const currentRoomState = roomDoc.exists ? roomDoc.data().state : "unknown";
    const currentGameSettings = roomDoc.exists
      ? roomDoc.data().gameSettings
      : {};

    io.in(roomId).emit("updatePlayerList", {
      players,
      hostId: currentHostUid,
      roomState: currentRoomState,
      gameSettings: currentGameSettings, // Also emit current game settings with player list
    });
  } catch (err) {
    console.error(`Failed to emit player list for room ${roomId}:`, err);
  }
};

export default function registerRoomHandlers(io, socket) {
  const emitToRoom = (roomId, event, payload) => {
    io.in(roomId).emit(event, payload);
  };

  const isInRoom = (roomId) => {
    return socket.rooms.has(roomId) && roomId !== socket.id;
  };

  socket.on("createRoom", async (data, callback) => {
    if (!socket.user?.uid) {
      return callback?.({
        status: "error",
        message: "Authentication required.",
      });
    }
    try {
      const hostUid = socket.user.uid;
      const hostName = data.playerName || socket.user.name || "Host";
      const { id: roomId, code: roomCode } = await serviceCreateRoom({
        uid: hostUid,
        name: hostName,
      });

      socket.join(roomId);
      callback?.({ status: "ok", roomId, roomCode });
      await emitPlayerListUpdate(io, roomId); // Will now also send initial gameSettings
      console.log(
        `Host ${hostName} (${hostUid}) created room ${roomCode} (${roomId})`
      );
    } catch (error) {
      console.error("Error creating room:", error);
      callback?.({ status: "error", message: error.message });
    }
  });

  socket.on("joinRoom", async ({ roomCode, playerName }, callback) => {
    if (!socket.user?.uid) {
      return callback?.({
        status: "error",
        message: "Authentication required.",
      });
    }
    if (!roomCode) {
      return callback?.({ status: "error", message: "Room code is required." });
    }

    try {
      const uid = socket.user.uid;
      const name = playerName || socket.user.name || "Player";
      const {
        id: roomId,
        code: joinedRoomCode,
        role: playerRole,
        roomState,
      } = await serviceJoinRoom({
        uid,
        name,
        code: roomCode,
      });

      socket.join(roomId);
      callback?.({
        status: "ok",
        roomId,
        roomCode: joinedRoomCode,
        role: playerRole,
        roomState,
      });

      io.in(roomId).emit("playerJoined", { uid, name, role: playerRole });
      await emitPlayerListUpdate(io, roomId);

      console.log(
        `User ${name} (${uid}) joined room ${joinedRoomCode} (${roomId}) as ${playerRole}. Room state: ${roomState}`
      );

      if (playerRole === "spectator" && roomState === "active") {
        socket.emit("spectatingActiveGame", {
          roomId,
          message: "You are spectating an active game.",
          // Consider fetching and sending current game state for spectators.
          // e.g., const gameState = await serviceGetActiveGameStateForSpectator(roomId);
          // socket.emit('currentGameState', gameState); // For the joining spectator only
        });
      }
    } catch (error) {
      console.error(
        `Error joining room ${roomCode} for ${socket.user.uid}:`,
        error
      );
      callback?.({ status: "error", message: error.message });
    }
  });

  socket.on("leaveRoom", async ({ roomId }, callback) => {
    if (!socket.user?.uid || !roomId || !isInRoom(roomId)) {
      return callback?.({
        status: "error",
        message: "Invalid leave room request.",
      });
    }
    const uid = socket.user.uid;
    const displayName = socket.user.name || uid;

    try {
      const roomDoc = await getRoomModel(roomId);
      const roomIsActive = roomDoc.exists && roomDoc.data().state === "active";

      // serviceLeaveRoom performs the full deletion of the player document
      const leaveResult = await serviceLeaveRoom({ uid, roomId });

      if (roomIsActive) {
        // gameService.handlePlayerLeave manages game state changes (e.g., advancing turn if leaver was active)
        // It should NOT modify activeTurnOrderUids itself, but rely on this leaveRoom having done so.
        // The new gameService.handlePlayerLeave is designed for this.
        await handlePlayerLeaveGameConsequences({ roomId, uid });
      }

      socket.leave(roomId);
      callback?.({ status: "ok", ...leaveResult }); // Send back {hostChanged, newHostUid, roomDeleted}

      if (!leaveResult.roomDeleted) {
        // Only emit if room still exists
        io.in(roomId).emit("playerLeft", {
          uid,
          name: displayName,
          newHostUid: leaveResult.newHostUid,
        });
        await emitPlayerListUpdate(io, roomId);
      }
      console.log(
        `Player ${displayName} (${uid}) voluntarily left room ${roomId}. Room deleted: ${leaveResult.roomDeleted}`
      );
    } catch (error) {
      console.error(`Error leaving room ${roomId} for player ${uid}:`, error);
      callback?.({ status: "error", message: error.message });
    }
  });

  /**
   * Host updates game settings for a room in 'waiting' state.
   */
  socket.on(
    "room:updateSettings",
    async ({ roomId, settingsToUpdate }, callback) => {
      if (!socket.user?.uid || !roomId || !settingsToUpdate) {
        return callback?.({
          status: "error",
          message: "Invalid request to update settings.",
        });
      }
      if (!isInRoom(roomId)) {
        return callback?.({
          status: "error",
          message: "Must be in the room to update settings.",
        });
      }

      try {
        const updatedSettings = await serviceUpdateGameSettings({
          roomId,
          hostUid: socket.user.uid, // service will validate if this user is the host
          settingsToUpdate,
        });
        callback?.({ status: "ok", updatedSettings });
        // Emit updated settings to all in room (emitPlayerListUpdate now includes gameSettings)
        await emitPlayerListUpdate(io, roomId);
        console.log(
          `Host ${socket.user.uid} updated settings for room ${roomId}.`
        );
      } catch (error) {
        console.error(
          `Error updating settings for room ${roomId} by ${socket.user.uid}:`,
          error
        );
        callback?.({ status: "error", message: error.message });
      }
    }
  );

  socket.on("disconnecting", async () => {
    const uid = socket.user?.uid;
    if (!uid) return;

    const displayName = socket.user.name || uid;
    const roomsPlayerIsIn = Array.from(socket.rooms).filter(
      (r) => r !== socket.id && r
    );

    // console.log(`Player ${displayName} (${uid}) disconnecting from rooms: ${roomsPlayerIsIn.join(", ")}.`);

    // `gameService.cleanupOnDisconnect` is called by `gameHandler.js`'s `disconnecting` event.
    // That function marks player `online: false` in *active* games and handles game state advancement.
    // The `roomHandler.js` `disconnecting` event should only call `serviceLeaveRoom` (full deletion)
    // for rooms that are *not* currently active.

    for (const roomId of roomsPlayerIsIn) {
      try {
        const roomDoc = await getRoomModel(roomId); // Check current room state
        if (!roomDoc.exists) {
          // console.log(`Room ${roomId} not found during disconnect for ${uid}.`);
          continue;
        }
        const roomData = roomDoc.data();

        if (roomData.state !== "active") {
          // If room is 'waiting' or 'ended', player can be fully removed by roomService.
          console.log(
            `Player ${displayName} (${uid}) disconnecting from NON-ACTIVE room ${roomId}. Performing full leave from room service.`
          );
          const leaveResult = await serviceLeaveRoom({ uid, roomId }); // Full removal by service

          if (!leaveResult.roomDeleted) {
            io.in(roomId).emit("playerLeft", {
              uid,
              name: displayName,
              newHostUid: leaveResult.newHostUid,
            });
            await emitPlayerListUpdate(io, roomId);
          }
        } else {
          // For 'active' rooms, gameService.cleanupOnDisconnect (in gameHandler) handles it.
          // It marks player.online = false and emits updatePlayerList.
          // So, no direct action needed here for ACTIVE games, to avoid conflicts or duplicate processing.
          console.log(
            `Player ${displayName} (${uid}) disconnected from ACTIVE game ${roomId}. gameService.cleanupOnDisconnect handles game state.`
          );
        }
      } catch (err) {
        console.error(
          `Error during disconnect cleanup in roomHandler for player ${uid} in room ${roomId}:`,
          err
        );
      }
    }
  });

  socket.on("lobbyMessage", async ({ roomId, message }, callback) => {
    if (!socket.user?.uid || !roomId || !isInRoom(roomId)) {
      return callback?.({
        status: "error",
        message: "Cannot send lobby message.",
      });
    }
    if (
      !message ||
      typeof message !== "string" ||
      message.trim().length === 0 ||
      message.length > 500
    ) {
      return callback?.({
        status: "error",
        message: "Invalid message content.",
      });
    }
    const fromUid = socket.user.uid;
    const fromName = socket.user.name || fromUid;
    const messageData = {
      fromUid,
      fromName,
      message: message.trim(),
      timestamp: Date.now(),
      type: "lobby",
    };
    io.in(roomId).emit("lobbyMessage", messageData);
    // console.log(`Lobby message from ${fromName} in room ${roomId}: ${messageData.message}`);
    callback?.({ status: "ok" });
  });

  socket.on("privateMessage", ({ roomId, toUid, message }, callback) => {
    if (!socket.user?.uid || !toUid || !message) {
      return callback?.({
        status: "error",
        message: "Missing data for private message.",
      });
    }
    // Optional: PMs could be global or room-contextual. If room-contextual:
    // if (!roomId || !isInRoom(roomId)) {
    //   return callback?.({ status: "error", message: "Must be in a room to send PMs."});
    // }

    const fromUid = socket.user.uid;
    const fromName = socket.user.name || fromUid;
    const toSocketId = uidToSocketId.get(toUid);

    if (!toSocketId) {
      return callback?.({
        status: "error",
        message: "Recipient not online or not found.",
      });
    }
    const messageData = {
      fromUid,
      fromName,
      toUid,
      message,
      timestamp: Date.now(),
      type: "private",
    };
    io.to(toSocketId).emit("privateMessage", messageData);
    socket.emit("privateMessage", { ...messageData, isOwnMessage: true }); // For sender's UI
    // console.log(`PM from ${fromName} to ${toUid} (context room ${roomId || 'N/A'}): ${message}`);
    callback?.({ status: "ok" });
  });
}
