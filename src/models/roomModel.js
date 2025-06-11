// server/src/models/roomModel.js
import {
  db,
  FieldValue,
  ROOMS_COLLECTION,
  PLAYERS_COLLECTION,
} from "./dbConfig.js";

/**
 * Gets a room document by its ID.
 * @param {string} roomId - The ID of the room.
 * @returns {Promise<FirebaseFirestore.DocumentSnapshot>} The room document snapshot.
 */
export async function getRoom(roomId) {
  if (!roomId) throw new Error("Room ID is required for getRoom.");
  return db.collection(ROOMS_COLLECTION).doc(roomId).get();
}

/**
 * Updates a room document.
 * @param {string} roomId - The ID of the room.
 * @param {object} data - An object containing the fields and values to update.
 * @returns {Promise<void>}
 */
export async function updateRoom(roomId, data) {
  if (!roomId) throw new Error("Room ID is required for updateRoom.");
  return db.collection(ROOMS_COLLECTION).doc(roomId).update(data);
}

/**
 * Deletes a room document. Also, consider deleting its subcollections (players, questions)
 * either here via a batched write or through Firebase Functions triggered on room delete.
 * For simplicity, this only deletes the room doc itself. Subcollection cleanup is more complex.
 * @param {string} roomId - The ID of the room.
 * @returns {Promise<void>}
 */
export async function deleteRoom(roomId) {
  if (!roomId) throw new Error("Room ID is required for deleteRoom.");
  // Note: Deleting a document does not delete its subcollections in Firestore.
  // You'd need to implement recursive deletion if required.
  // For now, this focuses on the room document.
  // Consider a Firebase Function for cleaning up subcollections upon room deletion.
  console.warn(
    `Deleting room ${roomId}. Subcollections (players, questions) are NOT automatically deleted by this model function.`
  );
  return db.collection(ROOMS_COLLECTION).doc(roomId).delete();
}

/**
 * Gets a room by its unique code.
 * @param {string} code - The room code.
 * @returns {Promise<FirebaseFirestore.QuerySnapshot>} Query snapshot (may be empty or contain one doc).
 */
export async function getRoomByCode(code) {
  if (!code) throw new Error("Room code is required for getRoomByCode.");
  return db
    .collection(ROOMS_COLLECTION)
    .where("code", "==", code)
    .limit(1)
    .get();
}

/**
 * Creates a room document and the host's player document in a batch.
 * @param {string} roomId - Pre-generated ID for the new room.
 * @param {object} roomData - Data for the room document.
 * @param {object} hostPlayerData - Data for the host's player document.
 * @returns {Promise<void>}
 */
export async function createRoomWithHost(roomId, roomData, hostPlayerData) {
  if (!roomId) throw new Error("Room ID is required for createRoomWithHost.");
  const roomRef = db.collection(ROOMS_COLLECTION).doc(roomId);
  const playerRef = roomRef
    .collection(PLAYERS_COLLECTION)
    .doc(hostPlayerData.uid);

  const batch = db.batch();
  batch.set(roomRef, roomData);
  batch.set(playerRef, hostPlayerData);
  return batch.commit();
}

/**
 * Adds a room update operation to an existing Firestore batch.
 * @param {FirebaseFirestore.WriteBatch} batch - The Firestore batch.
 * @param {string} roomId - The ID of the room.
 * @param {object} data - An object containing the fields and values to update.
 */
export function batchUpdateRoom(batch, roomId, data) {
  if (!roomId) throw new Error("Room ID is required for batchUpdateRoom.");
  const roomRef = db.collection(ROOMS_COLLECTION).doc(roomId);
  batch.update(roomRef, data);
}
