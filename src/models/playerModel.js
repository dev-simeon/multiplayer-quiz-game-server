// server/src/models/playerModel.js
import {
  db,
  FieldValue,
  ROOMS_COLLECTION,
  PLAYERS_COLLECTION,
} from "./dbConfig.js";

/**
 * Gets a specific player from a room by their UID.
 * @param {string} roomId - The ID of the room.
 * @param {string} uid - The UID of the player.
 * @returns {Promise<object|null>} The player data object (without ID) or null if not found.
 */
export async function getPlayer(roomId, uid) {
  if (!roomId || !uid)
    throw new Error("Room ID and UID are required for getPlayer.");
  const playerDoc = await db
    .collection(ROOMS_COLLECTION)
    .doc(roomId)
    .collection(PLAYERS_COLLECTION)
    .doc(uid)
    .get();
  return playerDoc.exists ? { id: playerDoc.id, ...playerDoc.data() } : null;
}

/**
 * Adds a new player document to a room.
 * @param {string} roomId - The ID of the room.
 * @param {string} uid - The UID of the player.
 * @param {object} playerData - Data for the new player.
 * @returns {Promise<void>}
 */
export async function addPlayer(roomId, uid, playerData) {
  if (!roomId || !uid)
    throw new Error("Room ID and UID are required for addPlayer.");
  return db
    .collection(ROOMS_COLLECTION)
    .doc(roomId)
    .collection(PLAYERS_COLLECTION)
    .doc(uid)
    .set(playerData);
}

/**
 * Updates a specific player's data in a room.
 * @param {string} roomId - The ID of the room.
 * @param {string} uid - The UID of the player.
 * @param {object} data - An object containing the fields and values to update.
 * @returns {Promise<void>}
 */
export async function updatePlayer(roomId, uid, data) {
  if (!roomId || !uid)
    throw new Error("Room ID and UID are required for updatePlayer.");
  return db
    .collection(ROOMS_COLLECTION)
    .doc(roomId)
    .collection(PLAYERS_COLLECTION)
    .doc(uid)
    .update(data);
}

/**
 * Deletes a player document from a room.
 * @param {string} roomId - The ID of the room.
 * @param {string} uid - The UID of the player to delete.
 * @returns {Promise<void>}
 */
export async function deletePlayer(roomId, uid) {
  if (!roomId || !uid)
    throw new Error("Room ID and UID are required for deletePlayer.");
  return db
    .collection(ROOMS_COLLECTION)
    .doc(roomId)
    .collection(PLAYERS_COLLECTION)
    .doc(uid)
    .delete();
}

/**
 * Gets all players in a room, sorted by joinOrder.
 * Includes 'id', 'name', 'score', 'online', 'joinOrder', 'role'.
 * @param {string} roomId - The ID of the room.
 * @returns {Promise<Array<object>>} An array of player objects.
 */
export async function getPlayersByRoomSorted(roomId) {
  if (!roomId)
    throw new Error("Room ID is required for getPlayersByRoomSorted.");
  const playersSnap = await db
    .collection(ROOMS_COLLECTION)
    .doc(roomId)
    .collection(PLAYERS_COLLECTION)
    .orderBy("joinOrder", "asc")
    .get();

  if (playersSnap.empty) return [];
  return playersSnap.docs.map((doc) => ({
    id: doc.id,
    name: doc.data().name,
    score: doc.data().score || 0,
    online: doc.data().online === true,
    joinOrder: doc.data().joinOrder,
    role: doc.data().role || "player", // Default role
    // include other fields if necessary
  }));
}

/**
 * Gets all player documents in a room for use within a Firestore transaction.
 * @param {FirebaseFirestore.Transaction} tx - The Firestore transaction object.
 * @param {string} roomId - The ID of the room.
 * @returns {Promise<FirebaseFirestore.QuerySnapshot>} Snapshot of the players subcollection.
 */
export async function getPlayersInRoomForTransaction(tx, roomId) {
  if (!roomId)
    throw new Error("Room ID is required for getPlayersInRoomForTransaction.");
  const playerCollectionRef = db
    .collection(ROOMS_COLLECTION)
    .doc(roomId)
    .collection(PLAYERS_COLLECTION);
  return tx.get(playerCollectionRef);
}

/**
 * Sets a player document within a Firestore transaction.
 * @param {FirebaseFirestore.Transaction} tx - The Firestore transaction.
 * @param {string} roomId - The ID of the room.
 * @param {string} uid - The UID of the player.
 * @param {object} playerData - Data for the player.
 */
export function setPlayerInTransaction(tx, roomId, uid, playerData) {
  if (!roomId || !uid)
    throw new Error("Room ID and UID are required for setPlayerInTransaction.");
  const playerDocRef = db
    .collection(ROOMS_COLLECTION)
    .doc(roomId)
    .collection(PLAYERS_COLLECTION)
    .doc(uid);
  tx.set(playerDocRef, playerData);
}

// --- Functions previously in gameService.js that belong to playerModel ---

/**
 * Atomically increments a player's score.
 * @param {string} roomId - The ID of the room.
 * @param {string} uid - The UID of the player.
 * @param {number} amount - The amount to increment the score by.
 * @returns {Promise<void>}
 */
export async function incrementPlayerScore(roomId, uid, amount) {
  if (!roomId || !uid)
    throw new Error("Room ID and UID are required for incrementPlayerScore.");
  return db
    .collection(ROOMS_COLLECTION)
    .doc(roomId)
    .collection(PLAYERS_COLLECTION)
    .doc(uid)
    .update({
      score: FieldValue.increment(amount),
    });
}

/**
 * Gets the scores of all players in a room.
 * @param {string} roomId - The ID of the room.
 * @returns {Promise<object>} An object mapping player UIDs to their scores.
 */
export async function getRoomScores(roomId) {
  if (!roomId) throw new Error("Room ID is required for getRoomScores.");
  const playersSnap = await db
    .collection(ROOMS_COLLECTION)
    .doc(roomId)
    .collection(PLAYERS_COLLECTION)
    .get();
  const scores = {};
  playersSnap.forEach((doc) => {
    scores[doc.id] = doc.data().score || 0;
  });
  return scores;
}

/**
 * Adds a player score reset (to 0) operation to a Firestore batch.
 * @param {FirebaseFirestore.WriteBatch} batch - The Firestore batch.
 * @param {string} roomId - The ID of the room.
 * @param {string} playerId - The ID of the player.
 */
export function batchResetPlayerScore(batch, roomId, playerId) {
  if (!roomId || !playerId)
    throw new Error(
      "Room ID and Player ID are required for batchResetPlayerScore."
    );
  const playerRef = db
    .collection(ROOMS_COLLECTION)
    .doc(roomId)
    .collection(PLAYERS_COLLECTION)
    .doc(playerId);
  batch.update(playerRef, { score: 0 });
}
