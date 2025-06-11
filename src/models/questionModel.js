// server/src/models/questionModel.js
import {
  db,
  FieldValue,
  ROOMS_COLLECTION,
  QUESTIONS_COLLECTION,
} from "./dbConfig.js";

/**
 * Gets a specific question from a room's question subcollection by its DB index (ID).
 * @param {string} roomId - The ID of the room.
 * @param {string} questionId - The ID of the question (e.g., '0', '1').
 * @returns {Promise<object|null>} The question object or null if not found.
 */
export async function getQuestion(roomId, questionId) {
  if (!roomId || !questionId)
    throw new Error("Room ID and Question ID are required for getQuestion.");
  const questionDoc = await db
    .collection(ROOMS_COLLECTION)
    .doc(roomId)
    .collection(QUESTIONS_COLLECTION)
    .doc(String(questionId))
    .get(); // Ensure questionId is string
  return questionDoc.exists
    ? { id: questionDoc.id, ...questionDoc.data() }
    : null;
}

/**
 * Gets all questions for a room, ordered by their ID (which should be their stringified index).
 * @param {string} roomId - The ID of the room.
 * @returns {Promise<Array<object>>} An array of question objects.
 */
export async function getAllQuestions(roomId) {
  if (!roomId) throw new Error("Room ID is required for getAllQuestions.");
  const questionsSnap = await db
    .collection(ROOMS_COLLECTION)
    .doc(roomId)
    .collection(QUESTIONS_COLLECTION)
    .orderBy(FieldValue.documentId()) // Order by document ID ('0', '1', '2', ...)
    .get();
  return questionsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

/**
 * Adds multiple question set operations to a Firestore batch.
 * Each question object in questionsData should have an 'id' field for its document ID.
 * @param {FirebaseFirestore.WriteBatch} batch - The Firestore batch.
 * @param {string} roomId - The ID of the room.
 * @param {Array<object>} questionsData - Array of question objects to store.
 */
export function batchStoreQuestions(batch, roomId, questionsData) {
  if (!roomId) throw new Error("Room ID is required for batchStoreQuestions.");
  const roomQuestionsRef = db
    .collection(ROOMS_COLLECTION)
    .doc(roomId)
    .collection(QUESTIONS_COLLECTION);
  questionsData.forEach((question) => {
    if (!question.id) {
      console.warn(
        "Question data missing ID, skipping in batchStoreQuestions:",
        question
      );
      return;
    }
    const questionDocRef = roomQuestionsRef.doc(String(question.id)); // Ensure ID is string
    batch.set(questionDocRef, question);
  });
}
