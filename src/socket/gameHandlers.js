// server/src/socket/gameHandlers.js
import {
  startGame as serviceStartGame,
  submitAnswer as serviceSubmitAnswer,
  handleSteal as serviceHandleSteal,
  cleanupOnDisconnect, // gameService handles marking players offline in active games & advancing state
  handleRejoinGame as serviceHandleRejoinGame, // Import the new rejoin handler
} from "../services/gameService.js";
// Assuming you might use getRoomModel for host validation eventually
// import { getRoom as getRoomModel } from '../models/roomModel.js';

// In-memory play again votes and timers
const playAgainVotes = {}; // { [roomId]: Set<uid> }
const playAgainRoomTimers = new Map(); // { [roomId]: NodeJS.Timeout }
const PLAY_AGAIN_VOTE_TIMEOUT_MS = 30000; // 30 seconds for voting
const PLAY_AGAIN_REQUIRED_VOTES = 2; // Minimum votes to start

function clearPlayAgainStateForRoom(roomId) {
  if (playAgainVotes[roomId]) {
    delete playAgainVotes[roomId];
  }
  if (playAgainRoomTimers.has(roomId)) {
    clearTimeout(playAgainRoomTimers.get(roomId));
    playAgainRoomTimers.delete(roomId);
  }
  console.log(`[PlayAgain] State cleared for room ${roomId}`);
}

/**
 * Register socket handlers for game events.
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 */
export default function registerGameHandlers(io, socket) {
  const emitToRoom = (roomId) => (event, payload) => {
    io.in(roomId).emit(event, payload);
  };

  const isInRoom = (roomId) => {
    return socket.rooms.has(roomId) && roomId !== socket.id;
  };

  socket.on("game:start", async ({ roomId, settings }, callback) => {
    if (!roomId || !isInRoom(roomId) || !socket.user?.uid) {
      return callback?.({
        status: "error",
        message: "Invalid roomId, not in room, or not authenticated.",
      });
    }

    // TODO: Implement host validation if needed:
    // try {
    //   const roomDoc = await getRoomModel(roomId); // Conceptual
    //   if (!roomDoc.exists || roomDoc.data().hostUid !== socket.user.uid) {
    //     return callback?.({ status: "error", message: "Only the host can start the game." });
    //   }
    // } catch (e) {
    //    return callback?.({ status: "error", message: "Error validating host." });
    // }

    const emit = emitToRoom(roomId);
    try {
      const initialState = await serviceStartGame({
        roomId,
        settings: settings || {},
      });
      emit("gameStarted", initialState);
      callback?.({ status: "ok", initialState }); // Send initial state back to host too
      console.log(
        `Game started in room ${roomId} by ${socket.user.uid}. Effective Settings:`,
        initialState.gameSettings
      );
    } catch (error) {
      console.error(
        `Error starting game in room ${roomId} by ${socket.user.uid}:`,
        error
      );
      callback?.({ status: "error", message: error.message });
      emit("gameError", { message: `Failed to start game: ${error.message}` });
    }
  });

  socket.on("submitAnswer", async (data, callback) => {
    const { roomId, questionId, answerIndex } = data;
    const emit = emitToRoom(roomId);

    if (!roomId || !questionId || typeof answerIndex !== "number") {
      return callback?.({
        status: "error",
        message: "Missing or invalid answer data.",
      });
    }
    if (!isInRoom(roomId) || !socket.user?.uid) {
      return callback?.({
        status: "error",
        message: "Unauthorized or not in room.",
      });
    }

    try {
      const result = await serviceSubmitAnswer({
        roomId,
        uid: socket.user.uid,
        questionId,
        answerIndex,
        isTimeout: false,
      });

      if (result.noActionTaken) {
        // Handle cases where service determined no action needed (e.g., stale timeout)
        console.log(
          `submitAnswer for ${
            socket.user.uid
          } in ${roomId} resulted in no action: ${
            result.message || "Stale event"
          }`
        );
        return callback?.({ status: "ok", ...result }); // Acknowledge but don't emit game progression
      }

      emit("answerResult", {
        uid: socket.user.uid,
        name: socket.user.name || socket.user.uid,
        correct: result.correct,
        correctIndex: result.correctIndex,
        questionId: result.questionId,
        uidOfAnswerer: result.uidOfAnswerer,
      });
      emit("scoreUpdate", result.scores);

      if (result.nextPhase === "steal") {
        emit("stealOpportunity", {
          questionId: result.questionId,
          nextUid: result.nextUid,
          stealTimeout: result.stealTimeout,
        });
      } else if (result.nextPhase === "nextTurn") {
        emit("nextTurn", {
          question: result.nextQuestion,
          turnUid: result.nextUid,
          timeout: result.turnTimeout,
          currentQuestionNum: result.currentQuestionNum,
          totalQuestions: result.totalQuestions,
        });
      } else if (result.nextPhase === "endGame") {
        emit("gameEnded", result.finalScores);
      }
      callback?.({ status: "ok", ...result });
    } catch (error) {
      console.error(
        `Error in submitAnswer for room ${roomId}, user ${socket.user.uid}:`,
        error
      );
      callback?.({ status: "error", message: error.message });
      emit("gameError", {
        message: `Error submitting answer: ${error.message}`,
      });
    }
  });

  socket.on("submitSteal", async (data, callback) => {
    const { roomId, questionId, answerIndex } = data;
    const emit = emitToRoom(roomId);

    if (!roomId || !questionId || typeof answerIndex !== "number") {
      return callback?.({
        status: "error",
        message: "Missing or invalid steal data.",
      });
    }
    if (!isInRoom(roomId) || !socket.user?.uid) {
      return callback?.({
        status: "error",
        message: "Unauthorized or not in room.",
      });
    }

    try {
      const stealResult = await serviceHandleSteal({
        roomId,
        uid: socket.user.uid,
        questionId,
        answerIndex,
        isTimeout: false,
      });

      if (stealResult.noActionTaken) {
        console.log(
          `submitSteal for ${
            socket.user.uid
          } in ${roomId} resulted in no action: ${
            stealResult.message || "Stale event"
          }`
        );
        return callback?.({ status: "ok", ...stealResult });
      }

      emit("stealResult", {
        uid: socket.user.uid,
        name: socket.user.name || socket.user.uid,
        correct: stealResult.correct,
        questionId: stealResult.questionId,
        correctIndex: stealResult.correctIndex,
        uidOfAnswerer: stealResult.uidOfAnswerer,
      });
      emit("scoreUpdate", stealResult.scores);

      if (stealResult.nextPhase === "nextTurn") {
        emit("nextTurn", {
          question: stealResult.nextQuestion,
          turnUid: stealResult.nextUid,
          timeout: stealResult.turnTimeout,
          currentQuestionNum: stealResult.currentQuestionNum,
          totalQuestions: stealResult.totalQuestions,
        });
      } else if (stealResult.nextPhase === "endGame") {
        emit("gameEnded", stealResult.finalScores);
      }
      callback?.({ status: "ok", ...stealResult });
    } catch (error) {
      console.error(
        `Error in submitSteal for room ${roomId}, user ${socket.user.uid}:`,
        error
      );
      callback?.({ status: "error", message: error.message });
      emit("gameError", {
        message: `Error submitting steal: ${error.message}`,
      });
    }
  });

  socket.on("playAgainRequest", async ({ roomId }, callback) => {
    if (!roomId || !isInRoom(roomId) || !socket.user?.uid) {
      return callback?.({
        status: "error",
        message: "Invalid request for Play Again.",
      });
    }
    const uid = socket.user.uid;
    const displayName = socket.user.name || uid;

    if (!playAgainVotes[roomId]) playAgainVotes[roomId] = new Set();
    if (playAgainVotes[roomId].has(uid))
      return callback?.({ status: "ok", message: "You have already voted." });

    playAgainVotes[roomId].add(uid);
    const votes = playAgainVotes[roomId].size;
    const roomSockets = await io.in(roomId).allSockets();
    const totalOnlineInRoom = roomSockets.size;

    console.log(
      `[PlayAgain] Room: ${roomId}, Voter: ${displayName} (${uid}), Votes: ${votes}/${totalOnlineInRoom} (Required: ${PLAY_AGAIN_REQUIRED_VOTES})`
    );

    if (
      votes === 1 &&
      !playAgainRoomTimers.has(roomId) &&
      totalOnlineInRoom >= PLAY_AGAIN_REQUIRED_VOTES
    ) {
      const timerId = setTimeout(() => {
        if (
          playAgainVotes[roomId] &&
          playAgainVotes[roomId].size < PLAY_AGAIN_REQUIRED_VOTES
        ) {
          console.log(`[PlayAgain] Voting for room ${roomId} timed out.`);
          io.in(roomId).emit("playAgainFailed", {
            message: "Not enough votes for Play Again in time.",
          });
        }
        clearPlayAgainStateForRoom(roomId);
      }, PLAY_AGAIN_VOTE_TIMEOUT_MS);
      playAgainRoomTimers.set(roomId, timerId);
      console.log(`[PlayAgain] Voting timer started for room ${roomId}.`);
    }

    io.in(roomId).emit("playAgainStatus", {
      votes,
      totalOnline: totalOnlineInRoom,
      requiredToStart: PLAY_AGAIN_REQUIRED_VOTES,
      voterUid: uid,
      voterName: displayName,
    });

    if (
      votes >= PLAY_AGAIN_REQUIRED_VOTES &&
      totalOnlineInRoom >= PLAY_AGAIN_REQUIRED_VOTES
    ) {
      console.log(
        `[PlayAgain] Condition met for room ${roomId}. Starting new game.`
      );
      clearPlayAgainStateForRoom(roomId);
      try {
        // For "Play Again", settings from the previous game in that room could be fetched and reused,
        // or new settings could be passed if host initiates. Defaulting to new game with defaults for now.
        const initialState = await serviceStartGame({ roomId, settings: {} });
        io.in(roomId).emit("gameStarted", initialState);
        callback?.({ status: "ok", gameStarted: true, initialState });
      } catch (error) {
        console.error(
          `[PlayAgain] Error restarting game for room ${roomId}:`,
          error
        );
        callback?.({ status: "error", message: error.message });
        io.in(roomId).emit("gameError", {
          message: `Failed to restart game: ${error.message}`,
        });
      }
    } else {
      callback?.({ status: "ok", gameStarted: false });
    }
  });

  /**
   * Handles player request to rejoin a game/room.
   */
  socket.on("game:rejoin", async ({ roomId }, callback) => {
    if (!roomId || !socket.user?.uid) {
      return callback?.({
        status: "error",
        message: "Invalid rejoin request.",
      });
    }
    const uid = socket.user.uid;
    console.log(`Player ${uid} attempting to rejoin room ${roomId}.`);
    try {
      // Ensure the socket joins the Socket.IO room channel if not already in it
      // (e.g., if this is a new connection after a browser refresh)
      if (!socket.rooms.has(roomId)) {
        socket.join(roomId);
        console.log(
          `Socket ${socket.id} for user ${uid} joined Socket.IO room ${roomId} for rejoin.`
        );
      }

      const rejoinResult = await serviceHandleRejoinGame({ roomId, uid });

      // Send specific rejoin status and game state ONLY to the rejoining player
      callback?.({ status: "ok", ...rejoinResult });

      // The serviceHandleRejoinGame already emits 'updatePlayerList' and 'playerRejoined' to the room.
      console.log(
        `Player ${uid} processed for rejoin in room ${roomId}. New role: ${rejoinResult.playerRole}`
      );
    } catch (error) {
      console.error(
        `Error during game:rejoin for player ${uid} in room ${roomId}:`,
        error
      );
      callback?.({ status: "error", message: error.message });
      // Optionally emit an error to the specific socket if rejoin fails critically
      socket.emit("rejoinError", { roomId, message: error.message });
    }
  });

  socket.on("disconnecting", async () => {
    const uid = socket.user?.uid;
    if (!uid) return;

    const roomsPlayerIsIn = Array.from(socket.rooms).filter(
      (r) => r !== socket.id && r
    );
    if (roomsPlayerIsIn.length > 0) {
      // console.log(`Player ${uid} (socket ${socket.id}) disconnecting from rooms: ${roomsPlayerIsIn.join(", ")}.`);
      try {
        // gameService.cleanupOnDisconnect handles marking player offline in active games
        // and advancing game state if necessary. It also emits 'updatePlayerList'.
        await cleanupOnDisconnect({ roomIdList: roomsPlayerIsIn, uid });
      } catch (error) {
        console.error(
          `Error during gameService.cleanupOnDisconnect for ${uid} on socket ${socket.id}:`,
          error
        );
      }

      for (const roomId of roomsPlayerIsIn) {
        if (playAgainVotes[roomId] && playAgainVotes[roomId].has(uid)) {
          playAgainVotes[roomId].delete(uid);
          console.log(
            `[PlayAgain] Player ${uid} removed from votes for room ${roomId} due to disconnect.`
          );
          const remainingVotes = playAgainVotes[roomId].size;
          if (remainingVotes === 0) {
            clearPlayAgainStateForRoom(roomId);
          } else {
            try {
              // Added try-catch for safety during disconnect
              const roomSockets = await io.in(roomId).allSockets();
              const totalOnlineInRoomAfterDisconnect =
                roomSockets.size > 0 ? Math.max(0, roomSockets.size - 1) : 0;
              io.in(roomId).emit("playAgainStatus", {
                votes: remainingVotes,
                totalOnline: totalOnlineInRoomAfterDisconnect,
                requiredToStart: PLAY_AGAIN_REQUIRED_VOTES,
              });
            } catch (e) {
              console.error(
                `[PlayAgain] Error emitting status update for room ${roomId} during disconnect:`,
                e
              );
            }
          }
        }
      }
    }
  });
}
