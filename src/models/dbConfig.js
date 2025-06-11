// server/src/models/dbConfig.js
import admin from "../config/firebaseAdmin.js"; // Ensure this path is correct

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const ROOMS_COLLECTION = "rooms";
const PLAYERS_COLLECTION = "players";
const QUESTIONS_COLLECTION = "questions";

export {
  db,
  FieldValue,
  ROOMS_COLLECTION,
  PLAYERS_COLLECTION,
  QUESTIONS_COLLECTION,
};
