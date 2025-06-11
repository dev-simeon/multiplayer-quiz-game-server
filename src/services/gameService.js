// server/src/services/gameService.js
import fetch from "node-fetch";
import {
  getRoom as getRoomModel,
  updateRoom as updateRoomModel,
  batchUpdateRoom as batchUpdateRoomModel, // For startGame
} from "../models/roomModel.js";
import {
  getPlayersByRoomSorted,
  getPlayer as getPlayerModel,
  updatePlayer as updatePlayerModel,
  incrementPlayerScore as incrementPlayerScoreModel,
  getRoomScores as getRoomScoresModel,
  batchResetPlayerScore as batchResetPlayerScoreModel,
} from "../models/playerModel.js";
import {
  getQuestion as getQuestionModel,
  getAllQuestions as getAllQuestionsModel,
  batchStoreQuestions as batchStoreQuestionsModel,
} from "../models/questionModel.js";
import { FieldValue, db } from "../models/dbConfig.js";

let ioServer;

const DEFAULT_QUESTIONS_PER_PLAYER = 5;
const DEFAULT_TURN_TIMEOUT_SEC = 30;
const DEFAULT_STEAL_TIMEOUT_SEC = 15;
const DEFAULT_ALLOW_STEAL = true;
const DEFAULT_BONUS_FOR_STEAL = 1;

const activeRoomTimers = new Map();

export function initGameService(io) {
  ioServer = io;
  if (ioServer)
    console.log("GameService initialized with Socket.IO server instance.");
  else
    console.error(
      "GameService initialization: Socket.IO server instance is undefined!"
    );
}

// --- Timer Utility Functions ---
function makeRoomTimerKey(roomId, phase) {
  return `${roomId}:${phase}`;
}

function clearActiveRoomTimer(roomId, phase) {
  const timerKey = makeRoomTimerKey(roomId, phase);
  if (activeRoomTimers.has(timerKey)) {
    clearTimeout(activeRoomTimers.get(timerKey));
    activeRoomTimers.delete(timerKey);
    // console.log(`Timer cleared: ${timerKey}`); // Less verbose
  }
}

function clearAllTimersForRoom(roomId) {
  clearActiveRoomTimer(roomId, "turn");
  clearActiveRoomTimer(roomId, "steal");
  console.log(`All active game timers cleared for room ${roomId}.`);
}

// --- Core Game State Progression Helpers ---
async function findNextOnlinePlayerInFixedOrder(
  roomId,
  roomData,
  startAfterUid
) {
  const activeTurnOrderUids = roomData.activeTurnOrderUids || [];
  if (activeTurnOrderUids.length === 0) {
    return { nextPlayerUid: null, nextPlayerIndexInOrder: -1 };
  }

  let startIndex = activeTurnOrderUids.indexOf(startAfterUid);
  if (startIndex === -1) {
    // If startAfterUid not found (e.g. left, or initial call for first player)
    // Fallback: use currentPlayerIndexInOrder if available, else start from beginning
    startIndex =
      roomData.currentPlayerIndexInOrder !== undefined &&
      roomData.currentPlayerIndexInOrder !== -1
        ? roomData.currentPlayerIndexInOrder
        : -1; // -1 ensures loop starts at index 0 for first player
    // console.warn(`Player ${startAfterUid} not in activeTurnOrderUids for room ${roomId}. Search base index: ${startIndex}.`);
  }

  for (let i = 1; i <= activeTurnOrderUids.length; i++) {
    const nextPlayerIndexInOrder =
      (startIndex + i) % activeTurnOrderUids.length;
    const nextPlayerUidCandidate = activeTurnOrderUids[nextPlayerIndexInOrder];
    const player = await getPlayerModel(roomId, nextPlayerUidCandidate);
    if (player && player.online && (player.role === "player" || !player.role)) {
      return { nextPlayerUid: nextPlayerUidCandidate, nextPlayerIndexInOrder };
    }
  }
  console.log(
    `No next online 'player' found in fixed order for room ${roomId} after attempting to start from Uid: ${startAfterUid} (resolved to index ${startIndex}).`
  );
  return { nextPlayerUid: null, nextPlayerIndexInOrder: -1 };
}

async function setupNextTurnOrEndGame(
  roomId,
  newCurrentTurnPlayerUid,
  newPlayerIndexInOrder,
  newQuestionDbIndex
) {
  const roomDoc = await getRoomModel(roomId);
  if (!roomDoc.exists)
    throw new Error(`Room ${roomId} not found for setting up next turn.`);
  const roomData = roomDoc.data();
  const gameSettings = roomData.gameSettings || {};

  if (newQuestionDbIndex >= roomData.questionCount) {
    clearAllTimersForRoom(roomId);
    const finalScores = await getRoomScoresModel(roomId);
    await updateRoomModel(roomId, {
      state: "ended",
      currentTurnUid: null,
      currentQuestionDbIndex: newQuestionDbIndex,
      currentPlayerIndexInOrder: -1,
      currentStealAttempt: null,
    });
    ioServer.in(roomId).emit("gameEnded", finalScores);
    console.log(
      `Game ended in room ${roomId}. All ${roomData.questionCount} questions played.`
    );
    return {
      nextPhase: "endGame",
      finalScores,
      totalQuestions: roomData.questionCount,
    };
  }

  const nextQuestion = await getQuestionModel(roomId, newQuestionDbIndex);
  if (!nextQuestion) {
    console.error(
      `Failed to load question ${newQuestionDbIndex} for room ${roomId}. Ending game.`
    );
    clearAllTimersForRoom(roomId);
    const finalScores = await getRoomScoresModel(roomId);
    await updateRoomModel(roomId, {
      state: "ended",
      currentTurnUid: null,
      currentPlayerIndexInOrder: -1,
    });
    ioServer.in(roomId).emit("gameEnded", finalScores);
    ioServer
      .in(roomId)
      .emit("gameError", {
        message: `Error loading question ${newQuestionDbIndex}. Game ended.`,
      });
    return {
      nextPhase: "endGame",
      finalScores,
      totalQuestions: roomData.questionCount,
    };
  }

  const playerDoc = await getPlayerModel(roomId, newCurrentTurnPlayerUid);
  if (
    !playerDoc ||
    !playerDoc.online ||
    (playerDoc.role && playerDoc.role !== "player")
  ) {
    console.warn(
      `Target player ${newCurrentTurnPlayerUid} for next turn in room ${roomId} is invalid/offline/spectator. Finding substitute.`
    );
    const {
      nextPlayerUid: substituteUid,
      nextPlayerIndexInOrder: substituteIndex,
    } = await findNextOnlinePlayerInFixedOrder(
      roomId,
      roomData,
      newCurrentTurnPlayerUid
    );

    if (!substituteUid) {
      console.log(
        `No substitute online player found in room ${roomId}. Ending game.`
      );
      clearAllTimersForRoom(roomId);
      const finalScores = await getRoomScoresModel(roomId);
      await updateRoomModel(roomId, {
        state: "ended",
        currentTurnUid: null,
        currentPlayerIndexInOrder: -1,
      });
      ioServer.in(roomId).emit("gameEnded", finalScores);
      return {
        nextPhase: "endGame",
        finalScores,
        totalQuestions: roomData.questionCount,
      };
    }
    newCurrentTurnPlayerUid = substituteUid;
    newPlayerIndexInOrder = substituteIndex;
    console.log(
      `Substituted next turn to player ${newCurrentTurnPlayerUid} at index ${newPlayerIndexInOrder}.`
    );
  }

  await updateRoomModel(roomId, {
    currentTurnUid: newCurrentTurnPlayerUid,
    currentPlayerIndexInOrder: newPlayerIndexInOrder,
    currentQuestionDbIndex: newQuestionDbIndex,
    currentStealAttempt: null,
  });

  const turnTimeoutSec =
    gameSettings.turnTimeoutSec || DEFAULT_TURN_TIMEOUT_SEC;
  await scheduleGameTimeout({
    roomId,
    questionId: nextQuestion.id,
    uidForTimeout: newCurrentTurnPlayerUid,
    phase: "turn",
    timeoutSeconds: turnTimeoutSec,
  });

  ioServer.in(roomId).emit("nextTurn", {
    question: nextQuestion,
    turnUid: newCurrentTurnPlayerUid,
    timeout: turnTimeoutSec,
    currentQuestionNum: newQuestionDbIndex + 1,
    totalQuestions: roomData.questionCount,
  });
  // console.log(`Room ${roomId}: Next turn for player ${newCurrentTurnPlayerUid} (Index ${newPlayerIndexInOrder}) with Q:${nextQuestion.id} (DB Index: ${newQuestionDbIndex}).`); // Already detailed in schedule
  return {
    nextPhase: "nextTurn",
    nextQuestion,
    nextUid: newCurrentTurnPlayerUid,
    turnTimeout: turnTimeoutSec,
    currentQuestionNum: newQuestionDbIndex + 1,
    totalQuestions: roomData.questionCount,
  };
}

async function scheduleGameTimeout({
  roomId,
  questionId,
  uidForTimeout,
  phase,
  timeoutSeconds,
}) {
  if (!ioServer) {
    console.error(
      "CRITICAL: ioServer not initialized. Cannot schedule game timeout."
    );
    return;
  }
  const timerKey = makeRoomTimerKey(roomId, phase);
  const timeoutMs = timeoutSeconds * 1000;

  clearActiveRoomTimer(roomId, phase);

  console.log(
    `Scheduling ${phase} timeout for room ${roomId} (player: ${uidForTimeout}, Q: ${questionId}) for ${timeoutSeconds}s. Key: ${timerKey}`
  );
  activeRoomTimers.set(
    timerKey,
    setTimeout(async () => {
      activeRoomTimers.delete(timerKey);
      console.log(
        `Timeout FIRED: ${timerKey} for player ${uidForTimeout}, Q: ${questionId}`
      );

      const roomDoc = await getRoomModel(roomId);
      if (!roomDoc.exists || roomDoc.data().state !== "active") {
        console.log(
          `Room ${roomId} not active or found. Timeout ${timerKey} ignored (room state: ${
            roomDoc.data()?.state
          }).`
        );
        return;
      }
      const roomData = roomDoc.data();

      const expectedUidForTimeout =
        phase === "turn"
          ? roomData.currentTurnUid
          : roomData.currentStealAttempt
          ? roomData.currentStealAttempt.stealerUid
          : null;
      const currentQuestionForPhase = await getQuestionModel(
        roomId,
        roomData.currentQuestionDbIndex
      ); // This is the Q for the current state in DB

      if (
        !currentQuestionForPhase ||
        currentQuestionForPhase.id !== questionId ||
        uidForTimeout !== expectedUidForTimeout
      ) {
        console.log(`Timeout ${timerKey} is STALE or for wrong context.
          Current Turn UID in DB: ${roomData.currentTurnUid}, Steal UID: ${roomData.currentStealAttempt?.stealerUid}
          Current Question ID in DB for index ${roomData.currentQuestionDbIndex}: ${currentQuestionForPhase?.id} (timer was for QID: ${questionId})
          Expected UID for this timeout: ${uidForTimeout} (timer was for UID: ${expectedUidForTimeout})
          Ignoring timeout.`);
        return;
      }

      const playerToTimeout = await getPlayerModel(roomId, uidForTimeout);
      if (!playerToTimeout || !playerToTimeout.online) {
        console.log(
          `Player ${uidForTimeout} for timed out action ${timerKey} is now OFFLINE. Proceeding with timeout simulation.`
        );
      }

      try {
        console.log(
          `Processing ${phase} timeout for ${uidForTimeout} on Q:${questionId} in room ${roomId}. Player online: ${playerToTimeout?.online}`
        );
        if (phase === "turn") {
          await submitAnswer({
            roomId,
            uid: uidForTimeout,
            questionId,
            answerIndex: -1,
            isTimeout: true,
          });
        } else {
          // phase === 'steal'
          await handleSteal({
            roomId,
            uid: uidForTimeout,
            questionId,
            answerIndex: -1,
            isTimeout: true,
          });
        }
      } catch (err) {
        console.error(
          `Error processing ${phase} timeout for ${timerKey} (player ${uidForTimeout}, Q ${questionId}):`,
          err
        );
        ioServer
          .in(roomId)
          .emit("gameError", {
            message: `Server error during timeout: ${err.message}. Attempting to recover.`,
          });
        try {
          let playerContextForNext = uidForTimeout; // Player whose action led to error or who timed out
          let nextQDbIndex = roomData.currentQuestionDbIndex + 1; // Generally, move to next question
          let nextTurnPlayerForRecovery = null;
          let nextTurnPlayerIndexForRecovery = -1;

          if (phase === "steal") {
            // If steal processing errored, the stealer (uidForTimeout) should get the next new question.
            nextTurnPlayerForRecovery = uidForTimeout;
            nextTurnPlayerIndexForRecovery =
              roomData.activeTurnOrderUids.indexOf(uidForTimeout);
          } else {
            // 'turn' phase error
            const { nextPlayerUid, nextPlayerIndexInOrder } =
              await findNextOnlinePlayerInFixedOrder(
                roomId,
                roomData,
                playerContextForNext
              );
            nextTurnPlayerForRecovery = nextPlayerUid;
            nextTurnPlayerIndexForRecovery = nextPlayerIndexInOrder;
          }

          if (
            nextTurnPlayerForRecovery &&
            nextTurnPlayerIndexForRecovery !== -1
          ) {
            console.log(
              `Timeout recovery: Moving to next question (idx ${nextQDbIndex}) for player ${nextTurnPlayerForRecovery}`
            );
            await setupNextTurnOrEndGame(
              roomId,
              nextTurnPlayerForRecovery,
              nextTurnPlayerIndexForRecovery,
              nextQDbIndex
            );
          } else {
            console.log(
              `Timeout recovery: No online players left or error determining next. Ending game ${roomId}.`
            );
            clearAllTimersForRoom(roomId);
            const finalScores = await getRoomScoresModel(roomId);
            await updateRoomModel(roomId, {
              state: "ended",
              currentTurnUid: null,
              currentPlayerIndexInOrder: -1,
            });
            ioServer.in(roomId).emit("gameEnded", finalScores);
          }
        } catch (recoveryError) {
          console.error(
            `Critical error during timeout recovery for room ${roomId}:`,
            recoveryError
          );
          ioServer
            .in(roomId)
            .emit("gameError", {
              message: `Critical server error. Game may be unstable.`,
            });
        }
      }
    }, timeoutMs)
  );
}

// --- Main Exported Game Logic Functions ---

export async function startGame({ roomId, settings }) {
  const roomDoc = await getRoomModel(roomId);
  if (!roomDoc.exists) throw new Error(`Room ${roomId} not found.`);
  const existingRoomData = roomDoc.data();

  const allPlayersInRoom = await getPlayersByRoomSorted(roomId);
  const onlineParticipatingPlayers = allPlayersInRoom.filter(
    (p) => p.online && (p.role === "player" || !p.role)
  );

  if (onlineParticipatingPlayers.length < 2) {
    throw new Error(
      "At least two online 'player' role users are required to start the game."
    );
  }

  const gameSettings = {
    questionsPerPlayer:
      settings?.questionsPerPlayer ||
      existingRoomData.gameSettings?.questionsPerPlayer ||
      DEFAULT_QUESTIONS_PER_PLAYER,
    turnTimeoutSec:
      settings?.turnTimeoutSec ||
      existingRoomData.gameSettings?.turnTimeoutSec ||
      DEFAULT_TURN_TIMEOUT_SEC,
    stealTimeoutSec:
      settings?.stealTimeoutSec ||
      existingRoomData.gameSettings?.stealTimeoutSec ||
      DEFAULT_STEAL_TIMEOUT_SEC,
    allowSteal:
      settings?.allowSteal !== undefined
        ? settings.allowSteal
        : existingRoomData.gameSettings?.allowSteal !== undefined
        ? existingRoomData.gameSettings.allowSteal
        : DEFAULT_ALLOW_STEAL,
    bonusForSteal:
      settings?.bonusForSteal !== undefined
        ? settings.bonusForSteal
        : existingRoomData.gameSettings?.bonusForSteal !== undefined
        ? existingRoomData.gameSettings.bonusForSteal
        : DEFAULT_BONUS_FOR_STEAL,
  };

  const totalQuestionCount =
    onlineParticipatingPlayers.length * gameSettings.questionsPerPlayer;
  console.log(
    `Starting game in room ${roomId} for ${onlineParticipatingPlayers.length} players. Total Qs: ${totalQuestionCount}. Effective Settings:`,
    gameSettings
  );

  const fetchResponse = await fetch(
    `https://opentdb.com/api.php?amount=${totalQuestionCount}&type=multiple`
  );
  if (!fetchResponse.ok)
    throw new Error(`Failed to fetch questions: ${fetchResponse.statusText}`);
  const { results: questionItems } = await fetchResponse.json();

  if (!questionItems || questionItems.length < totalQuestionCount) {
    throw new Error(
      `Not enough questions fetched (${
        questionItems?.length || 0
      }/${totalQuestionCount}).`
    );
  }

  const batch = db.batch();
  const questionsToStore = questionItems.map((item, idx) => {
    const options = [...item.incorrect_answers, item.correct_answer].sort(
      () => 0.5 - Math.random()
    );
    return {
      id: String(idx),
      text: item.question,
      options,
      correctIndex: options.indexOf(item.correct_answer),
      category: item.category,
      difficulty: item.difficulty,
    };
  });
  batchStoreQuestionsModel(batch, roomId, questionsToStore);

  const activeTurnOrderUids = onlineParticipatingPlayers.map((p) => p.id);
  const firstTurnPlayerUid = activeTurnOrderUids[0];
  const firstPlayerIndexInOrder = 0;

  // Use batchUpdateRoomModel for atomicity with other batch operations if possible,
  // or ensure this main update happens before player score resets if not batched with them.
  // For this structure, we'll update the room first, then batch player scores.
  // Or, if batchUpdateRoomModel is available and works with other batch items, use it.
  // Here, assuming batchUpdateRoomModel is for adding to an *existing* batch.
  const roomUpdateData = {
    state: "active",
    currentQuestionDbIndex: 0,
    questionCount: totalQuestionCount,
    currentTurnUid: firstTurnPlayerUid,
    activeTurnOrderUids: activeTurnOrderUids,
    currentPlayerIndexInOrder: firstPlayerIndexInOrder,
    currentStealAttempt: null,
    gameSettings: gameSettings,
    startedAt: FieldValue.serverTimestamp(),
  };
  batchUpdateRoomModel(batch, roomId, roomUpdateData);

  for (const player of onlineParticipatingPlayers) {
    batchResetPlayerScoreModel(batch, roomId, player.id);
  }
  await batch.commit();

  const allQuestionsForClient = await getAllQuestionsModel(roomId);
  const firstQuestion = await getQuestionModel(roomId, 0);
  if (!firstQuestion) throw new Error("Failed to load first question.");

  await scheduleGameTimeout({
    roomId,
    questionId: firstQuestion.id,
    uidForTimeout: firstTurnPlayerUid,
    phase: "turn",
    timeoutSeconds: gameSettings.turnTimeoutSec,
  });

  const initialScores = await getRoomScoresModel(roomId);
  // Ensure playerInfoForClient has all currently online players (including spectators if any, for full list)
  // But filter for game participation if this list is for "active game players"
  const allPlayersForInitialList = await getPlayersByRoomSorted(roomId);

  return {
    question: firstQuestion,
    turnUid: firstTurnPlayerUid,
    turnTimeout: gameSettings.turnTimeoutSec,
    scores: initialScores,
    players: allPlayersForInitialList.map((p) => ({
      // Send all players, client can filter display by role
      uid: p.id,
      name: p.name,
      score: initialScores[p.id] || 0,
      online: p.online,
      role: p.role || "player",
    })),
    totalQuestions: totalQuestionCount,
    currentQuestionNum: 1,
    questions: allQuestionsForClient,
    gameSettings: gameSettings,
    hostId: existingRoomData.hostUid,
  };
}

export async function submitAnswer({
  roomId,
  uid,
  questionId,
  answerIndex,
  isTimeout = false,
}) {
  const roomDoc = await getRoomModel(roomId);
  if (!roomDoc.exists || roomDoc.data().state !== "active") {
    console.warn(
      `submitAnswer: Game not active or room ${roomId} DNE. State: ${
        roomDoc.data()?.state
      }`
    );
    return { noActionTaken: true, message: "Game not active." };
  }
  const roomData = roomDoc.data();

  // If it's a timeout, the uid is who *should have* answered.
  // If it's a direct submission, it must be their turn.
  if (!isTimeout && roomData.currentTurnUid !== uid) {
    console.warn(
      `submitAnswer: Not player ${uid}'s turn. Current: ${roomData.currentTurnUid}.`
    );
    throw new Error(`Not your turn.`);
  }
  // If it IS a timeout, but the current turn UID in DB is no longer this player, this timeout is stale.
  if (isTimeout && roomData.currentTurnUid !== uid) {
    console.log(
      `submitAnswer: Stale timeout for player ${uid}, Q ${questionId}. Current turn is ${roomData.currentTurnUid}. Ignoring.`
    );
    return { staleTimeout: true, noActionTaken: true };
  }

  const currentQuestion = await getQuestionModel(
    roomId,
    roomData.currentQuestionDbIndex
  );
  if (!currentQuestion || currentQuestion.id !== questionId) {
    console.warn(
      `submitAnswer: Question ID mismatch for Q ${questionId} (DB has ${currentQuestion?.id} for index ${roomData.currentQuestionDbIndex}). Room: ${roomId}.`
    );
    // If it's a timeout for an old question, it's stale.
    if (isTimeout)
      return {
        staleTimeout: true,
        noActionTaken: true,
        message: "Question mismatch for timeout.",
      };
    throw new Error("Question ID mismatch or question not found.");
  }

  clearActiveRoomTimer(roomId, "turn");
  // console.log(`Player ${uid} (current turn: ${roomData.currentTurnUid}) submitted answer (timeout: ${isTimeout}) for Q:${questionId} in room ${roomId}.`);

  const isCorrect = !isTimeout && currentQuestion.correctIndex === answerIndex;
  if (isCorrect) {
    await incrementPlayerScoreModel(roomId, uid, 1);
  }

  const updatedScores = await getRoomScoresModel(roomId);
  const resultBase = {
    correct: isCorrect,
    correctIndex: currentQuestion.correctIndex,
    questionId: questionId,
    scores: updatedScores,
    uidOfAnswerer: uid,
    totalQuestions: roomData.questionCount,
  };

  if (isCorrect) {
    const { nextPlayerUid, nextPlayerIndexInOrder } =
      await findNextOnlinePlayerInFixedOrder(roomId, roomData, uid);
    if (!nextPlayerUid) {
      // No one else to play
      clearAllTimersForRoom(roomId);
      await updateRoomModel(roomId, {
        state: "ended",
        currentTurnUid: null,
        currentPlayerIndexInOrder: -1,
      });
      return {
        ...resultBase,
        nextPhase: "endGame",
        finalScores: updatedScores,
      };
    }
    const updatedRoomState = await setupNextTurnOrEndGame(
      roomId,
      nextPlayerUid,
      nextPlayerIndexInOrder,
      roomData.currentQuestionDbIndex + 1
    );
    return { ...resultBase, ...updatedRoomState };
  } else {
    // Incorrect answer or timeout for currentTurnUid
    const gameSettings = roomData.gameSettings || {};
    if (!gameSettings.allowSteal) {
      console.log(
        `Room ${roomId}: Steal disabled by game settings. Advancing turn after incorrect answer by ${uid}.`
      );
      const { nextPlayerUid, nextPlayerIndexInOrder } =
        await findNextOnlinePlayerInFixedOrder(roomId, roomData, uid);
      if (!nextPlayerUid) {
        /* End game */
        clearAllTimersForRoom(roomId);
        await updateRoomModel(roomId, {
          state: "ended",
          currentTurnUid: null,
          currentPlayerIndexInOrder: -1,
        });
        return {
          ...resultBase,
          nextPhase: "endGame",
          finalScores: updatedScores,
        };
      }
      const updatedRoomState = await setupNextTurnOrEndGame(
        roomId,
        nextPlayerUid,
        nextPlayerIndexInOrder,
        roomData.currentQuestionDbIndex + 1
      );
      return { ...resultBase, ...updatedRoomState };
    }

    const { nextPlayerUid: stealerUidIfAny } =
      await findNextOnlinePlayerInFixedOrder(roomId, roomData, uid); // Player immediately after 'uid'

    if (stealerUidIfAny && stealerUidIfAny !== uid) {
      // Must be a different player
      await updateRoomModel(roomId, {
        currentStealAttempt: {
          stealerUid: stealerUidIfAny,
          questionDbIndex: roomData.currentQuestionDbIndex,
        },
      });
      await scheduleGameTimeout({
        roomId,
        questionId: currentQuestion.id,
        uidForTimeout: stealerUidIfAny,
        phase: "steal",
        timeoutSeconds: gameSettings.stealTimeoutSec,
      });
      console.log(
        `Room ${roomId}: Steal opportunity for ${stealerUidIfAny} on Q:${currentQuestion.id} after ${uid} answered incorrectly.`
      );
      return {
        ...resultBase,
        nextPhase: "steal",
        nextUid: stealerUidIfAny,
        stealTimeout: gameSettings.stealTimeoutSec,
        questionId: currentQuestion.id,
      };
    } else {
      console.log(
        `Room ${roomId}: No distinct eligible 'player' for steal found for Q:${currentQuestion.id} after ${uid}. Advancing turn.`
      );
    }

    const {
      nextPlayerUid: nextPlayerAfterNoSteal,
      nextPlayerIndexInOrder: nextIndexAfterNoSteal,
    } = await findNextOnlinePlayerInFixedOrder(roomId, roomData, uid);
    if (!nextPlayerAfterNoSteal) {
      /* End game */
      clearAllTimersForRoom(roomId);
      await updateRoomModel(roomId, {
        state: "ended",
        currentTurnUid: null,
        currentPlayerIndexInOrder: -1,
      });
      return {
        ...resultBase,
        nextPhase: "endGame",
        finalScores: updatedScores,
      };
    }
    const updatedRoomState = await setupNextTurnOrEndGame(
      roomId,
      nextPlayerAfterNoSteal,
      nextIndexAfterNoSteal,
      roomData.currentQuestionDbIndex + 1
    );
    return { ...resultBase, ...updatedRoomState };
  }
}

export async function handleSteal({
  roomId,
  uid,
  questionId,
  answerIndex,
  isTimeout = false,
}) {
  const roomDoc = await getRoomModel(roomId);
  if (!roomDoc.exists || roomDoc.data().state !== "active") {
    console.warn(
      `handleSteal: Game not active or room ${roomId} DNE. State: ${
        roomDoc.data()?.state
      }`
    );
    return { noActionTaken: true, message: "Game not active." };
  }
  const roomData = roomDoc.data();
  const gameSettings = roomData.gameSettings || {};

  if (
    !roomData.currentStealAttempt ||
    roomData.currentStealAttempt.stealerUid !== uid ||
    roomData.currentQuestionDbIndex !==
      roomData.currentStealAttempt.questionDbIndex
  ) {
    if (
      isTimeout &&
      (!roomData.currentStealAttempt ||
        roomData.currentStealAttempt.stealerUid !== uid)
    ) {
      console.log(
        `handleSteal: Stale steal timeout for player ${uid}, Q ${questionId}. Current stealer is ${roomData.currentStealAttempt?.stealerUid}. Ignoring.`
      );
      return { staleTimeout: true, noActionTaken: true };
    }
    throw new Error(
      "Not your turn to steal or steal attempt is stale/invalid."
    );
  }
  const currentQuestion = await getQuestionModel(
    roomId,
    roomData.currentQuestionDbIndex
  );
  if (!currentQuestion || currentQuestion.id !== questionId)
    throw new Error("Steal question ID mismatch.");

  clearActiveRoomTimer(roomId, "steal");
  // console.log(`Player ${uid} (stealer) submitted steal (timeout: ${isTimeout}) for Q:${questionId} in room ${roomId}.`);

  const isCorrect = !isTimeout && currentQuestion.correctIndex === answerIndex;
  if (isCorrect) {
    const pointsForSteal = 1 + (gameSettings.bonusForSteal || 0);
    await incrementPlayerScoreModel(roomId, uid, pointsForSteal);
  }

  const updatedScores = await getRoomScoresModel(roomId);
  const resultBase = {
    correct: isCorrect,
    scores: updatedScores,
    questionId,
    uidOfAnswerer: uid,
    correctIndex: currentQuestion.correctIndex,
    totalQuestions: roomData.questionCount,
  };

  const nextTurnPlayerUidForNewQuestion = uid; // Stealer gets the next main turn.
  const stealerIndexInOrder = roomData.activeTurnOrderUids.indexOf(uid);

  if (stealerIndexInOrder === -1) {
    console.error(
      `Stealer ${uid} not found in activeTurnOrderUids. Critical error in room ${roomId}. Ending game.`
    );
    clearAllTimersForRoom(roomId);
    await updateRoomModel(roomId, {
      state: "ended",
      currentTurnUid: null,
      currentPlayerIndexInOrder: -1,
    });
    return {
      ...resultBase,
      nextPhase: "endGame",
      finalScores: updatedScores,
      message: "Critical error: Stealer not in turn order.",
    };
  }

  const updatedRoomState = await setupNextTurnOrEndGame(
    roomId,
    nextTurnPlayerUidForNewQuestion,
    stealerIndexInOrder,
    roomData.currentQuestionDbIndex + 1
  );
  return { ...resultBase, ...updatedRoomState };
}

// --- Player Connectivity Management ---
export async function cleanupOnDisconnect({ roomIdList, uid }) {
  // console.log(`CleanupOnDisconnect for player ${uid}, rooms: ${roomIdList.join(", ")}`);
  for (const roomId of roomIdList) {
    if (roomId === uid || !roomId) continue;
    try {
      const roomDoc = await getRoomModel(roomId);
      if (roomDoc.exists && roomDoc.data().state === "active") {
        const player = await getPlayerModel(roomId, uid);
        if (player && player.online) {
          // Process only if they were marked online
          await updatePlayerModel(roomId, uid, { online: false });
          console.log(
            `Player ${uid} marked as offline in active game room ${roomId}.`
          );

          const roomData = roomDoc.data(); // Re-fetch fresh room data
          const currentQuestion = await getQuestionModel(
            roomId,
            roomData.currentQuestionDbIndex
          );

          let advancedGame = false;
          if (roomData.currentTurnUid === uid) {
            console.log(
              `Disconnected player ${uid} was current turn taker in room ${roomId}. Simulating timeout.`
            );
            clearActiveRoomTimer(roomId, "turn");
            if (currentQuestion) {
              await submitAnswer({
                roomId,
                uid,
                questionId: currentQuestion.id,
                answerIndex: -1,
                isTimeout: true,
              });
              advancedGame = true;
            } else {
              console.error(
                `Cannot simulate turn timeout for ${uid} in ${roomId}, currentQuestion not found (idx ${roomData.currentQuestionDbIndex}). Attempting recovery.`
              );
              // Force advance turn if possible without question context, or end game if stuck
              const { nextPlayerUid, nextPlayerIndexInOrder } =
                await findNextOnlinePlayerInFixedOrder(roomId, roomData, uid);
              if (nextPlayerUid)
                await setupNextTurnOrEndGame(
                  roomId,
                  nextPlayerUid,
                  nextPlayerIndexInOrder,
                  roomData.currentQuestionDbIndex + 1
                );
              else {
                /* TODO: end game logic if no one left */ console.log(
                  "No player to advance to, game should end."
                );
              }
            }
          } else if (
            roomData.currentStealAttempt &&
            roomData.currentStealAttempt.stealerUid === uid
          ) {
            console.log(
              `Disconnected player ${uid} was current stealer in room ${roomId}. Simulating timeout.`
            );
            clearActiveRoomTimer(roomId, "steal");
            if (currentQuestion) {
              await handleSteal({
                roomId,
                uid,
                questionId: currentQuestion.id,
                answerIndex: -1,
                isTimeout: true,
              });
              advancedGame = true;
            } else {
              console.error(
                `Cannot simulate steal timeout for ${uid} in ${roomId}, currentQuestion not found (idx ${roomData.currentQuestionDbIndex}). Attempting recovery.`
              );
              const { nextPlayerUid, nextPlayerIndexInOrder } =
                await findNextOnlinePlayerInFixedOrder(
                  roomId,
                  roomData,
                  roomData.currentTurnUid
                ); // Next after original turn taker
              if (nextPlayerUid)
                await setupNextTurnOrEndGame(
                  roomId,
                  nextPlayerUid,
                  nextPlayerIndexInOrder,
                  roomData.currentQuestionDbIndex + 1
                );
              else {
                /* TODO: end game logic */ console.log(
                  "No player to advance to, game should end."
                );
              }
            }
          }

          if (ioServer) {
            // Always update player list if player was in active game and marked offline
            const updatedPlayersData = await getPlayersByRoomSorted(roomId);
            const currentHostId = (await getRoomModel(roomId)).data()?.hostUid; // Re-fetch hostId
            ioServer.in(roomId).emit("updatePlayerList", {
              players: updatedPlayersData.map((p) => ({
                uid: p.id,
                name: p.name,
                score: p.score,
                online: p.online,
                role: p.role || "player",
              })),
              hostId: currentHostId,
              roomState: (await getRoomModel(roomId)).data()?.state, // Re-fetch state
            });
            ioServer
              .in(roomId)
              .emit("playerOffline", {
                uid,
                name: player?.name || uid,
                roomId,
              });
          }
        }
      }
    } catch (error) {
      console.error(
        `Error during cleanupOnDisconnect for player ${uid} in room ${roomId}:`,
        error
      );
    }
  }
}

export async function handlePlayerLeave({ roomId, uid }) {
  if (!ioServer) {
    console.warn("handlePlayerLeave: ioServer not initialized.");
    return;
  }
  const roomDocInitial = await getRoomModel(roomId);
  if (!roomDocInitial.exists || roomDocInitial.data().state !== "active") {
    // console.log(`handlePlayerLeave: Room ${roomId} not active or DNE. No game-specific action for player ${uid}.`);
    return; // Only for active games
  }

  let roomData = roomDocInitial.data();
  const playerLeaving = await getPlayerModel(roomId, uid);
  // console.log(`Handling voluntary leave for player ${uid} (${playerLeaving?.name}) from active game room ${roomId}.`);

  // Player is marked offline. Actual document deletion is by roomService.leaveRoom.
  // This function focuses on game state implications of them being permanently gone for this session.
  if (playerLeaving && playerLeaving.online) {
    await updatePlayerModel(roomId, uid, { online: false }); // Mark as offline in our records
    roomData = (await getRoomModel(roomId)).data(); // Re-fetch to ensure consistency
  }

  // Unlike temporary disconnect, for voluntary leave, we *do* remove them from activeTurnOrderUids
  // as they are not expected to rejoin this specific game instance.
  const newActiveTurnOrderUids = (roomData.activeTurnOrderUids || []).filter(
    (playerId) => playerId !== uid
  );
  let newPlayerIndexInOrder = roomData.currentPlayerIndexInOrder;

  if (
    newActiveTurnOrderUids.length < (roomData.activeTurnOrderUids || []).length
  ) {
    // If player was actually removed
    // Adjust currentPlayerIndexInOrder if the removed player was before or at the current index
    const oldIndexOfLeavingPlayer = (
      roomData.activeTurnOrderUids || []
    ).indexOf(uid);
    if (
      oldIndexOfLeavingPlayer !== -1 &&
      oldIndexOfLeavingPlayer <= newPlayerIndexInOrder &&
      newPlayerIndexInOrder > 0
    ) {
      newPlayerIndexInOrder--;
    }
    await updateRoomModel(roomId, {
      activeTurnOrderUids: newActiveTurnOrderUids,
      currentPlayerIndexInOrder: newPlayerIndexInOrder,
    });
    roomData.activeTurnOrderUids = newActiveTurnOrderUids; // Update local copy
    roomData.currentPlayerIndexInOrder = newPlayerIndexInOrder;
  }

  // Check if enough 'player' roles are still in the NEW activeTurnOrderUids and online
  let onlinePlayerRoleCountInNewOrder = 0;
  for (const playerId of newActiveTurnOrderUids) {
    const p = await getPlayerModel(roomId, playerId);
    if (p && p.online && (p.role === "player" || !p.role)) {
      onlinePlayerRoleCountInNewOrder++;
    }
  }

  if (onlinePlayerRoleCountInNewOrder < 2) {
    console.log(
      `Game ended in room ${roomId} (player ${uid} voluntarily left). Less than 2 online 'player' roles remaining in active order.`
    );
    clearAllTimersForRoom(roomId);
    const scores = await getRoomScoresModel(roomId);
    await updateRoomModel(roomId, {
      state: "ended",
      currentTurnUid: null,
      currentStealAttempt: null,
      currentPlayerIndexInOrder: -1,
    });
    ioServer.in(roomId).emit("gameEnded", scores);
    ioServer
      .in(roomId)
      .emit("message", {
        type: "info",
        text: `Game ended: Player ${
          playerLeaving?.name || uid
        } left. Not enough players.`,
      });
    return;
  }

  // If the leaving player was the current turn-taker or stealer, advance the game.
  const currentQuestion = await getQuestionModel(
    roomId,
    roomData.currentQuestionDbIndex
  );
  if (!currentQuestion && roomData.state === "active") {
    console.error(
      `handlePlayerLeave: Critical - active game ${roomId} but currentQuestion not found for index ${roomData.currentQuestionDbIndex}`
    );
    // Attempt to end game gracefully
    const scores = await getRoomScoresModel(roomId);
    await updateRoomModel(roomId, {
      state: "ended",
      currentTurnUid: null,
      currentStealAttempt: null,
    });
    ioServer.in(roomId).emit("gameEnded", scores);
    return;
  }

  if (roomData.currentTurnUid === uid) {
    console.log(
      `Leaving player ${uid} was current turn taker. Simulating timeout to advance game with new turn order.`
    );
    clearActiveRoomTimer(roomId, "turn");
    if (currentQuestion)
      await submitAnswer({
        roomId,
        uid,
        questionId: currentQuestion.id,
        answerIndex: -1,
        isTimeout: true,
      });
    else {
      /* Already handled above if !currentQuestion */
    }
  } else if (
    roomData.currentStealAttempt &&
    roomData.currentStealAttempt.stealerUid === uid
  ) {
    console.log(
      `Leaving player ${uid} was current stealer. Simulating timeout to advance game with new turn order.`
    );
    clearActiveRoomTimer(roomId, "steal");
    if (currentQuestion)
      await handleSteal({
        roomId,
        uid,
        questionId: currentQuestion.id,
        answerIndex: -1,
        isTimeout: true,
      });
    else {
      /* Already handled */
    }
  }

  // Player list will be updated by roomHandler.js which calls serviceLeaveRoom (actual player doc deletion)
  ioServer
    .in(roomId)
    .emit("message", {
      type: "info",
      text: `Player ${
        playerLeaving?.name || uid
      } has left the game. The game continues.`,
    });
}

export async function handleRejoinGame({ roomId, uid }) {
  const roomDoc = await getRoomModel(roomId);
  if (!roomDoc.exists) throw new Error(`Room ${roomId} not found for rejoin.`);
  const roomData = roomDoc.data();

  const playerDoc = await getPlayerModel(roomId, uid);
  if (!playerDoc)
    throw new Error(
      `Player ${uid} not found in room ${roomId} records. Cannot rejoin.`
    );

  let playerRole = playerDoc.role || "player"; // Default to player if role not set

  if (roomData.state === "active") {
    const playerIndexInActiveOrder = (
      roomData.activeTurnOrderUids || []
    ).indexOf(uid);

    if (playerIndexInActiveOrder === -1) {
      // Was not part of the original playing group for this specific game instance
      playerRole = "spectator";
      console.log(
        `Player ${uid} rejoining active game ${roomId}. Not in original turn order for this game instance. Assigning spectator.`
      );
    } else {
      // User's rule: "if the turn for the player as reach or passed for his/her own question"
      // This means their slot in the current rotation of questions has passed.
      const theirTurnInCurrentRoundPassed =
        playerIndexInActiveOrder < roomData.currentPlayerIndexInOrder ||
        (playerIndexInActiveOrder === roomData.currentPlayerIndexInOrder &&
          roomData.currentTurnUid !== uid);

      if (theirTurnInCurrentRoundPassed) {
        playerRole = "spectator";
        console.log(
          `Player ${uid} rejoining active game ${roomId}. Original index ${playerIndexInActiveOrder}, current index ${roomData.currentPlayerIndexInOrder} (turn of ${roomData.currentTurnUid}). Assigning spectator as their turn slot passed.`
        );
      } else {
        playerRole = "player"; // Eligible to continue as active player
        console.log(
          `Player ${uid} rejoining active game ${roomId} as player. Original index: ${playerIndexInActiveOrder}.`
        );
      }
    }
    await updatePlayerModel(roomId, uid, { online: true, role: playerRole }); // Update online status and potentially role
  } else if (roomData.state === "waiting" || roomData.state === "ended") {
    playerRole = "player"; // Rejoining lobby or post-game, should be player for next potential game
    await updatePlayerModel(roomId, uid, { online: true, role: playerRole });
    console.log(
      `Player ${uid} rejoining non-active room ${roomId} as ${playerRole}.`
    );
  } else {
    throw new Error(`Room ${roomId} is in an unknown state: ${roomData.state}`);
  }

  // Emit updated player list to all
  if (ioServer) {
    const updatedPlayers = await getPlayersByRoomSorted(roomId); // Get all players for the list
    const hostId = roomData.hostUid;
    ioServer.in(roomId).emit("updatePlayerList", {
      players: updatedPlayers.map((p) => ({
        uid: p.id,
        name: p.name,
        score: p.score,
        online: p.online,
        role: p.role || "player",
      })),
      hostId,
      roomState: roomData.state,
    });
    ioServer
      .in(roomId)
      .emit("playerRejoined", {
        uid,
        name: playerDoc.name,
        newRole: playerRole,
      });
  }

  // Prepare and return game state for the rejoining player
  let rejoinGameState = null;
  if (roomData.state === "active") {
    const currentQuestion =
      playerRole === "player" || playerRole === "spectator"
        ? await getQuestionModel(roomId, roomData.currentQuestionDbIndex)
        : null;
    const currentScores = await getRoomScoresModel(roomId);
    const allGameQuestions = await getAllQuestionsModel(roomId); // For client summary
    const allPlayersInRoomForState = await getPlayersByRoomSorted(roomId);

    rejoinGameState = {
      question: currentQuestion,
      turnUid: roomData.currentTurnUid,
      scores: currentScores,
      players: allPlayersInRoomForState.map((p) => ({
        uid: p.id,
        name: p.name,
        score: p.score,
        online: p.online,
        role: p.role || "player",
      })),
      totalQuestions: roomData.questionCount,
      currentQuestionNum: roomData.currentQuestionDbIndex + 1,
      gameSettings: roomData.gameSettings,
      questions: allGameQuestions,
      hostId: roomData.hostUid,
      currentStealAttempt: roomData.currentStealAttempt,
      activePhaseTimeout: roomData.currentStealAttempt
        ? roomData.gameSettings.stealTimeoutSec
        : roomData.gameSettings.turnTimeoutSec,
      yourRole: playerRole, // Explicitly tell the rejoining client their role
    };
  }

  return {
    rejoinStatus:
      roomData.state === "active" ? "rejoined_active_game" : "rejoined_lobby",
    playerRole: playerRole,
    roomState: roomData.state,
    gameState: rejoinGameState, // This will be null if not an active game
  };
}
