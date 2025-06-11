import dotenv from 'dotenv';
dotenv.config(); // Load environment variables from .env file

export const PORT = process.env.PORT;
export const FIREBASE_SERVICE_ACCOUNT = process.env.GOOGLE_APPLICATION_CREDENTIALS;
export const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN;
export const ALLOWED_ORIGINS = [
  CLIENT_ORIGIN,
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]; // Add other development origins
export const NODE_ENV = process.env.NODE_ENV;
// Add other environment variables as needed