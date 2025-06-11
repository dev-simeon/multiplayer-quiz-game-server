// server/src/app.js
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import http from "http"; // Import http module
import { Server as SocketIOServer } from "socket.io"; // Import Socket.IO Server
import initializeSocketHandlers from "./socket/index.js"; // Your main socket handler initializer

const app = express();
const httpServer = http.createServer(app); // Create HTTP server from Express app

// Environment variables (consider using a .env file and dotenv package)
const CLIENT_ORIGIN =
  process.env.CLIENT_ORIGIN ||
  "https://multiplayer-quiz-game-client.vercel.app";
const ALLOWED_ORIGINS = [
  CLIENT_ORIGIN,
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]; // Add other development origins

// 🛡️ Security headers
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", ...ALLOWED_ORIGINS],
        styleSrc: ["'self'", "'unsafe-inline'", ...ALLOWED_ORIGINS],
        imgSrc: ["'self'", "data:", ...ALLOWED_ORIGINS],
        connectSrc: ["'self'", ...ALLOWED_ORIGINS], // For API calls and WebSockets
        fontSrc: ["'self'", "data:", ...ALLOWED_ORIGINS], // If you use custom fonts
        // Add other directives as necessary
      },
    },
  })
);

// 🌐 CORS for Express
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        console.warn(`CORS: Origin ${origin} not allowed.`);
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

// 📦 Parse JSON, URL-encoded & cookies
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(cookieParser());

// --- Initialize Socket.IO ---
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        console.warn(`Socket CORS: Origin ${origin} not allowed.`);
        callback(new Error("Not allowed by CORS for WebSockets"));
      }
    },
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Initialize your custom socket event handlers and middleware
// This function should handle all socket related setup including auth, room and game handlers.
initializeSocketHandlers(io);

// --- API Routes ---
app.get("/api/health", (req, res) => {
  res
    .status(200)
    .json({
      status: "UP",
      timestamp: new Date().toISOString(),
      message: "Server is healthy",
    });
});

// Placeholder for other API routes
// import mainApiRouter from './routes/index.js'; // Example if you have an API router
// app.use('/api/v1', mainApiRouter);

// 🔀 Fallback for unhandled routes (especially non-API GET requests)
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) {
    // If it's not an API path, and no other route handled it, it's a 404.
    return res.status(404).json({ message: "Resource not found." });
  }
  // If it's an API path that wasn't handled by a specific router, it's also a 404 for the API.
  res.status(404).json({ message: "API endpoint not found." });
});

// 🔥 Global error handler (must be the last middleware)
app.use((err, req, res, next) => {
  console.error("💥 UNCAUGHT ERROR:", err.stack || err);
  const statusCode = err.status || 500;
  const message = err.message || "Internal Server Error";

  res.status(statusCode).json({
    status: "error",
    statusCode,
    message:
      process.env.NODE_ENV === "production" && statusCode === 500
        ? "Internal Server Error"
        : message,
  });
});

// Export the httpServer to be used by your server startup script (server.js)
export { httpServer };
