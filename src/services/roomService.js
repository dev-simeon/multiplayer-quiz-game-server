// server/src/services/roomService.js
import { generateRoomCode } from "../utils/index.js";

// Model Imports (actual paths to your model files)
import {
  getRoom as getRoomModel,
  updateRoom as updateRoomModel,
  deleteRoom as deleteRoomModel,
  getRoomByCode as getRoomByCodeModel,
  createRoomWithHost as createRoomWithHostModel, // Consolidated model function
} from "../models/roomModel.js";
import {
  getPlayer as getPlayerModel,
  addPlayer as addPlayerModel, // General add player
  updatePlayer as updatePlayerModel,
  deletePlayer as deletePlayerModel,
  getPlayersByRoomSorted as getPlayersByRoomSortedModel,
  getPlayersInRoomForTransaction, // For use within transactions
  setPlayerInTransaction, // For use within transactions
} from "../models/playerModel.js";
import {
  db,
  FieldValue,
  ROOMS_COLLECTION,
  PLAYERS_COLLECTION,
} from "../models/dbConfig.js";

const MAX_PLAYERS_ROLE_COUNT = 8; // Max users with 'player' role
const MAX_SPECTATORS_COUNT = 5; // Max users with 'spectator' role
const MAX_TOTAL_USERS_IN_ROOM = MAX_PLAYERS_ROLE_COUNT + MAX_SPECTATORS_COUNT;

export async function createRoom({ uid, name }) {
  const code = generateRoomCode();
  const roomId = db.collection(ROOMS_COLLECTION).doc().id; // Generate ID upfront

  // Fetch global user profile
  let displayName = name;
  let avatarUrl = null;
  try {
    const userProfileDoc = await db.collection('users').doc(uid).get();
    if (userProfileDoc.exists) {
      const userProfile = userProfileDoc.data();
      displayName = userProfile.displayName || name;
      avatarUrl = userProfile.avatarUrl || null;
    }
  } catch (e) {
    // fallback to provided name
  }

  const roomData = {
    code,
    hostUid: uid,
    state: "waiting",
    createdAt: FieldValue.serverTimestamp(),
    // Game-specific state fields initialized to defaults or null
    questionCount: 0,
    currentQuestionDbIndex: 0,
    currentTurnUid: null,
    activeTurnOrderUids: [],
    currentPlayerIndexInOrder: -1, // -1 indicates not yet started or no one's turn
    currentStealAttempt: null,
    gameSettings: {
      questionsPerPlayer: 5,
      turnTimeoutSec: 30, // User's updated default
      stealTimeoutSec: 15, // User's updated default
      allowSteal: true,
      bonusForSteal: 1,
    },
  };

  const hostPlayerData = {
    uid,
    name: displayName,
    avatarUrl,
    joinOrder: 1,
    score: 0,
    online: true,
    role: "player", // Host is always a 'player'
    joinedAt: FieldValue.serverTimestamp(),
  };

  // Use a model function to perform the batched/transactional creation
  await createRoomWithHostModel(roomId, roomData, hostPlayerData);

  console.log(`Room created: ${roomId} with code ${code} by host ${uid}`);
  return { id: roomId, code, hostUid: uid };
}

export async function joinRoom({ uid, name, code }) {
  const roomQueryResult = await getRoomByCodeModel(code);
  if (!roomQueryResult || roomQueryResult.empty) {
    throw new Error("Room not found with that code.");
  }
  const roomDocSnapshot = roomQueryResult.docs[0];
  const roomRef = roomDocSnapshot.ref; // Firestore DocumentReference
  const roomId = roomRef.id;
  let roomData = roomDocSnapshot.data();

  if (roomData.state === "ended") {
    throw new Error("This game has ended and cannot be joined for now.");
    // Future: Could allow rejoining 'ended' rooms to see scores or trigger 'play again'
  }

  return db.runTransaction(async (tx) => {
    const freshRoomDoc = await tx.get(roomRef); // Re-fetch room data inside transaction
    if (!freshRoomDoc.exists)
      throw new Error("Room disappeared during transaction.");
    roomData = freshRoomDoc.data(); // Use freshest room data

    const playerCollectionRef = roomRef.collection(PLAYERS_COLLECTION);
    const playerDocRef = playerCollectionRef.doc(uid);
    const existingPlayerDoc = await tx.get(playerDocRef);

    let playerRole = roomData.state === "active" ? "spectator" : "player";
    let assignedJoinOrder;

    if (existingPlayerDoc.exists) {
      // Player is rejoining
      const existingPlayerData = existingPlayerDoc.data();
      playerRole =
        roomData.state === "active" && existingPlayerData.role !== "player"
          ? "spectator"
          : existingPlayerData.role || "player";
      tx.update(playerDocRef, { online: true, role: playerRole }); // Keep original role if possible, unless forced spectator
      console.log(
        `Player ${uid} rejoining room ${roomId}. Existing Role: ${existingPlayerData.role}, New/Confirmed Role: ${playerRole}.`
      );
      return {
        id: roomId,
        code: roomData.code,
        role: playerRole,
        roomState: roomData.state,
      };
    }

    // New player joining
    const allPlayersInRoomSnap = await tx.get(playerCollectionRef);
    const currentTotalUsers = allPlayersInRoomSnap.size;

    if (currentTotalUsers >= MAX_TOTAL_USERS_IN_ROOM) {
      throw new Error("Room is at maximum capacity.");
    }

    if (playerRole === "player") {
      const currentPlayersWithPlayerRole = allPlayersInRoomSnap.docs.filter(
        (doc) => doc.data().role === "player"
      ).length;
      if (currentPlayersWithPlayerRole >= MAX_PLAYERS_ROLE_COUNT) {
        if (roomData.state === "waiting") {
          const currentSpectators = allPlayersInRoomSnap.docs.filter(
            (doc) => doc.data().role === "spectator"
          ).length;
          if (currentSpectators < MAX_SPECTATORS_COUNT) {
            playerRole = "spectator";
            console.log(
              `Room full for 'player' roles, joining ${uid} as 'spectator' in waiting room ${roomId}.`
            );
          } else {
            throw new Error("Room is full for players and spectators.");
          }
        } else {
          throw new Error("Room is full for players.");
        }
      }
    } else {
      const currentSpectators = allPlayersInRoomSnap.docs.filter(
        (doc) => doc.data().role === "spectator"
      ).length;
      if (currentSpectators >= MAX_SPECTATORS_COUNT) {
        throw new Error("Room is full for spectators.");
      }
    }

    assignedJoinOrder = currentTotalUsers + 1; // Simple increment for join order

    // Fetch global user profile
    let displayName = name;
    let avatarUrl = null;
    try {
      const userProfileDoc = await db.collection('users').doc(uid).get();
      if (userProfileDoc.exists) {
        const userProfile = userProfileDoc.data();
        displayName = userProfile.displayName || name;
        avatarUrl = userProfile.avatarUrl || null;
      }
    } catch (e) {
      // fallback to provided name
    }

    const newPlayerData = {
      uid,
      name: displayName,
      avatarUrl,
      joinOrder: assignedJoinOrder,
      score: 0,
      online: true,
      role: playerRole,
      joinedAt: FieldValue.serverTimestamp(),
    };
    setPlayerInTransaction(tx, roomId, uid, newPlayerData); // Use model func

    console.log(
      `Player ${uid} successfully joined room ${roomId} as ${playerRole}.`
    );
    return {
      id: roomId,
      code: roomData.code,
      role: playerRole,
      roomState: roomData.state,
    };
  });
}

export async function leaveRoom({ uid, roomId }) {
  const roomDoc = await getRoomModel(roomId);
  if (!roomDoc.exists) {
    console.warn(
      `leaveRoom: Room ${roomId} not found. No action taken for player ${uid}.`
    );
    return { hostChanged: false, roomDeleted: false };
  }
  const roomData = roomDoc.data();

  // Delete the player from the room's player subcollection
  await deletePlayerModel(roomId, uid);
  console.log(`Player ${uid} record deleted from room ${roomId}.`);

  const remainingPlayers = await getPlayersByRoomSortedModel(roomId); // Get all players, sorted

  let hostChanged = false;
  let newHostUid = null;
  let roomDeleted = false;

  if (!remainingPlayers || remainingPlayers.length === 0) {
    await deleteRoomModel(roomId);
    roomDeleted = true;
    console.log(`Room ${roomId} deleted as it became empty.`);
  } else {
    if (roomData.hostUid === uid) {
      // If the leaving player was the host
      // Find next host:
      // 1. Prioritize online 'player' roles by joinOrder.
      // 2. Then any 'player' role (offline) by joinOrder.
      // 3. Then any online 'spectator' by joinOrder (will be promoted to 'player').
      // 4. Then any 'spectator' (offline) by joinOrder (will be promoted to 'player').
      let nextHostCandidate =
        remainingPlayers.find((p) => p.online && p.role === "player") ||
        remainingPlayers.find((p) => p.role === "player") ||
        remainingPlayers.find((p) => p.online && p.role === "spectator") ||
        remainingPlayers[0]; // Fallback to the very first player in list if all else fails

      if (nextHostCandidate) {
        newHostUid = nextHostCandidate.id; // UID of player model is 'id'
        const updateData = { hostUid: newHostUid };
        await updateRoomModel(roomId, updateData);
        hostChanged = true;
        console.log(
          `Host ${uid} left room ${roomId}. New host: ${newHostUid}.`
        );

        // If the new host was a spectator, promote them to player
        if (nextHostCandidate.role === "spectator") {
          await updatePlayerModel(roomId, newHostUid, { role: "player" });
          console.log(
            `New host ${newHostUid} was a spectator, promoted to player.`
          );
        }
      } else {
        // This should not happen if remainingPlayers is not empty.
        // If it does, it implies an issue with player data or logic.
        console.error(
          `CRITICAL: Room ${roomId} has remaining players but no suitable host found after ${uid} left. Deleting room.`
        );
        await deleteRoomModel(roomId); // Safety: delete inconsistent room
        roomDeleted = true;
      }
    }
  }
  return { hostChanged, newHostUid, roomDeleted };
}

export async function getRoomPlayers(roomId) {
  const players = await getPlayersByRoomSortedModel(roomId); // This model fn should fetch all necessary fields
  return players.map((p) => ({
    uid: p.id, // Assuming model convention: player UID is on 'id' property
    name: p.name,
    score: p.score || 0,
    online: p.online === true,
    joinOrder: p.joinOrder,
    role: p.role || "player", // Default for older data, ensure role is always present
  }));
}

/**
 * Allows the host to update game settings for a room in 'waiting' state.
 * @param {object} params
 * @param {string} params.roomId - ID of the room.
 * @param {string} params.hostUid - UID of the user attempting the change (must be host).
 * @param {object} params.newSettings - Object with game settings to update.
 * @returns {Promise<object>} The updated game settings.
 */
export async function updateGameSettings({
  roomId,
  hostUid,
  settingsToUpdate,
}) {
  const roomDoc = await getRoomModel(roomId);
  if (!roomDoc.exists) throw new Error("Room not found.");

  const roomData = roomDoc.data();
  if (roomData.hostUid !== hostUid)
    throw new Error("Only the host can change game settings.");
  if (roomData.state !== "waiting")
    throw new Error(
      "Game settings can only be changed before the game starts."
    );

  // Validate and merge settings
  const currentSettings = roomData.gameSettings || {};
  const validatedNewSettings = { ...currentSettings };

  if (settingsToUpdate.questionsPerPlayer !== undefined) {
    const qpp = parseInt(settingsToUpdate.questionsPerPlayer, 10);
    if (qpp >= 1 && qpp <= 20) validatedNewSettings.questionsPerPlayer = qpp;
    else throw new Error("Questions per player must be between 1 and 20.");
  }
  if (settingsToUpdate.turnTimeoutSec !== undefined) {
    const tts = parseInt(settingsToUpdate.turnTimeoutSec, 10);
    if (tts >= 5 && tts <= 60) validatedNewSettings.turnTimeoutSec = tts;
    else throw new Error("Turn timeout must be between 5 and 60 seconds.");
  }
  if (settingsToUpdate.stealTimeoutSec !== undefined) {
    const sts = parseInt(settingsToUpdate.stealTimeoutSec, 10);
    if (sts >= 3 && sts <= 30) validatedNewSettings.stealTimeoutSec = sts;
    else throw new Error("Steal timeout must be between 3 and 30 seconds.");
  }
  if (settingsToUpdate.allowSteal !== undefined) {
    validatedNewSettings.allowSteal = !!settingsToUpdate.allowSteal;
  }
  if (settingsToUpdate.bonusForSteal !== undefined) {
    const bfs = parseInt(settingsToUpdate.bonusForSteal, 10);
    if (bfs >= 0 && bfs <= 5) validatedNewSettings.bonusForSteal = bfs;
    else throw new Error("Bonus for steal must be between 0 and 5.");
  }
  // Add any other settings you want to allow updating

  await updateRoomModel(roomId, { gameSettings: validatedNewSettings });
  console.log(
    `Game settings updated for room ${roomId} by host ${hostUid}. New settings:`,
    validatedNewSettings
  );
  return validatedNewSettings;
}
