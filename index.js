const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const sessions = {};

/**
 * 새 세션 생성
 */
function createNewSession() {
  return {
    state: "START",
    history: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * placeholder 문자열인지 확인
 * 예:
 *  - {{call.id}}
 *  - {{session.id}}
 *  - {input}
 *  - {{message}}
 */
function isPlaceholder(value) {
  if (value === undefined || value === null) return true;

  const v = String(value).trim();
  if (!v) return true;

  return v.includes("{") || v.includes("}");
}

/**
 * 테스트 시작 인사인지 확인
 */
function isGreeting(message) {
  const m = String(message || "").trim().toLowerCase();
  return ["hi", "hello", "hey"].includes(m);
}

/**
 * 세션 키 결정
 * - 실제 callId가 있으면 그걸 사용
 * - placeholder면 테스트용 고정 세션 사용
 */
function getSessionKey(rawCallId) {
  if (!isPlaceholder(rawCallId)) {
    return String(rawCallId).trim();
  }

  // 브라우저 테스트에서는 치환이 안 되므로 테스트용 세션으로 처리
  return "__browser_test_session__";
}

/**
 * 응답 생성 FSM
 */
function getReplyForSession(session, message) {
  const userMessage = String(message || "").trim().toLowerCase();

  if (session.state === "START") {
    session.state = "QUALIFY";
    return "Quick question — how are you currently handling incoming calls and bookings?";
  }

  if (session.state === "QUALIFY") {
    session.state = "PAIN";
    return "Got it. Do you ever miss calls or feel overwhelmed during busy hours?";
  }

  if (session.state === "PAIN") {
    session.state = "CLOSE";
    return "That’s exactly where we help. We handle missed calls and booking requests automatically so you don’t lose leads during busy times. Would you be open to hearing how it works?";
  }

  if (session.state === "CLOSE") {
    if (
      userMessage.includes("yes") ||
      userMessage.includes("sure") ||
      userMessage.includes("okay") ||
      userMessage.includes("ok") ||
      userMessage.includes("interested")
    ) {
      return "Great — Ringmate can answer missed calls, respond instantly, and help capture booking opportunities automatically. Would you be open to a quick demo this week?";
    }

    if (
      userMessage.includes("no") ||
      userMessage.includes("not interested") ||
      userMessage.includes("busy")
    ) {
      return "No worries — I can follow up another time. Have a great day!";
    }

    return "Would you be open to a quick walkthrough of how Ringmate can help with missed calls and bookings?";
  }

  return "Would you be open to a quick walkthrough of how Ringmate can help with missed calls and bookings?";
}

app.get("/", (req, res) => {
  res.send("Ringmate Sales AI Engine Running");
});

/**
 * 전체 세션 초기화
 * 테스트 전에 필요하면 호출
 */
app.post("/debug/reset", (req, res) => {
  Object.keys(sessions).forEach((key) => delete sessions[key]);
  console.log("All sessions cleared");
  res.json({ ok: true, message: "All sessions cleared" });
});

/**
 * 메시지 webhook
 */
app.post("/webhook/message", (req, res) => {
  try {
    const rawCallId = req.body.callId;
    const message = req.body.message || "";

    const sessionKey = getSessionKey(rawCallId);

    // 브라우저 테스트에서 인사로 시작하면 세션 초기화
    if (sessionKey === "__browser_test_session__" && isGreeting(message)) {
      delete sessions[sessionKey];
    }

    if (!sessions[sessionKey]) {
      sessions[sessionKey] = createNewSession();
    }

    const session = sessions[sessionKey];
    session.updatedAt = new Date().toISOString();

    const reply = getReplyForSession(session, message);

    session.history.push({
      user: message,
      assistant: reply,
      at: new Date().toISOString(),
    });

    console.log("Incoming:", {
      rawCallId,
      sessionKey,
      message,
      stateAfter: session.state,
    });

    return res.json({ reply });
  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(500).json({
      reply: "Sorry, something went wrong on our end.",
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
