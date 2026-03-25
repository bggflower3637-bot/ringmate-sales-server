const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/**
 * In-memory store
 * 실제 운영 때는 Airtable, Supabase, Google Sheets, CRM 등으로 바꾸면 됨
 */
const calls = new Map();

/**
 * ----------------------------
 * Helpers
 * ----------------------------
 */

function normalizeText(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function getCallId(body) {
  return (
    body?.call?.id ||
    body?.callId ||
    body?.message?.call?.id ||
    body?.sessionId ||
    "unknown-call"
  );
}

function getLatestUserMessage(body) {
  /**
   * VAPI payload shape이 환경마다 조금 다를 수 있어서
   * 여러 경우를 최대한 흡수하게 작성
   */
  if (Array.isArray(body?.messages) && body.messages.length > 0) {
    const reversed = [...body.messages].reverse();
    const userMsg = reversed.find((m) => {
      const role = normalizeText(m?.role);
      return role === "user" || role === "caller" || role === "customer";
    });
    if (userMsg?.message) return String(userMsg.message);
    if (userMsg?.content) return String(userMsg.content);
  }

  if (typeof body?.transcript === "string") return body.transcript;
  if (typeof body?.message === "string") return body.message;
  if (typeof body?.userMessage === "string") return body.userMessage;
  if (typeof body?.input === "string") return body.input;

  return "";
}

function createInitialState(callId) {
  return {
    callId,
    stage: "opening",
    branch: null, // manual | system | unknown
    lead: {
      business_name: "",
      call_volume: "",
      pain_point: "",
      interest_level: "cold", // hot | warm | cold
      callback_contact: "",
      notes: []
    },
    lastAssistantMessage:
      "Hi, this is Alex from Ringmate. Quick question — are you currently handling your incoming calls and bookings manually, or do you already have a system in place?",
    history: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function upsertState(callId) {
  if (!calls.has(callId)) {
    calls.set(callId, createInitialState(callId));
  }
  return calls.get(callId);
}

function saveHistory(state, role, text) {
  state.history.push({
    role,
    text,
    at: new Date().toISOString()
  });
  state.updatedAt = new Date().toISOString();
}

function detectManual(text) {
  const t = normalizeText(text);
  return [
    "manual",
    "manually",
    "myself",
    "ourselves",
    "i handle",
    "we handle",
    "we do it ourselves",
    "i do it myself",
    "no system",
    "not using a system",
    "just me",
    "front desk"
  ].some((k) => t.includes(k));
}

function detectHasSystem(text) {
  const t = normalizeText(text);
  return [
    "system",
    "software",
    "service",
    "answering service",
    "receptionist",
    "front desk team",
    "call center",
    "crm",
    "platform",
    "already have",
    "we use"
  ].some((k) => t.includes(k));
}

function detectBusy(text) {
  const t = normalizeText(text);
  return [
    "busy",
    "not a good time",
    "call me later",
    "later",
    "in a meeting",
    "can't talk",
    "cant talk",
    "right now is bad"
  ].some((k) => t.includes(k));
}

function detectNotInterested(text) {
  const t = normalizeText(text);
  return [
    "not interested",
    "no thanks",
    "we're good",
    "we are good",
    "all set",
    "no need",
    "not now",
    "stop calling",
    "take me off",
    "remove me"
  ].some((k) => t.includes(k));
}

function detectPositiveInterest(text) {
  const t = normalizeText(text);
  return [
    "yes",
    "yeah",
    "sure",
    "okay",
    "ok",
    "sounds good",
    "interested",
    "maybe",
    "possibly",
    "open to",
    "that could help",
    "tell me more",
    "demo"
  ].some((k) => t.includes(k));
}

function detectPain(text) {
  const t = normalizeText(text);
  return [
    "miss calls",
    "missing calls",
    "too many calls",
    "hard to keep up",
    "overwhelmed",
    "busy hours",
    "can't answer",
    "cant answer",
    "voicemail",
    "after hours",
    "we lose calls",
    "we miss calls"
  ].some((k) => t.includes(k));
}

function extractCallVolume(text) {
  const t = String(text || "");
  const numberMatch = t.match(/\b(\d{1,4})\b/);
  if (numberMatch) return numberMatch[1];

  if (/a lot|many|quite a few/i.test(t)) return "many";
  if (/few|not many/i.test(t)) return "few";
  if (/dozens/i.test(t)) return "dozens";

  return "";
}

function extractPhoneNumber(text) {
  const raw = String(text || "");
  const match = raw.match(
    /(\+?1[-.\s]?)?(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/
  );
  return match ? match[0] : "";
}

function maybeCaptureBusinessName(text, state) {
  const t = String(text || "").trim();
  if (!state.lead.business_name && t.length > 1 && t.length < 80) {
    if (/dental|clinic|office|practice|smiles|care/i.test(t)) {
      state.lead.business_name = t;
    }
  }
}

function setInterest(state, level) {
  const current = state.lead.interest_level;
  const rank = { cold: 1, warm: 2, hot: 3 };
  if (rank[level] > rank[current]) {
    state.lead.interest_level = level;
  }
}

function buildAssistantResponse(message, endCall = false) {
  /**
   * 중요:
   * 네 현재 VAPI webhook 응답 형식이 이미 있다면
   * 이 wrapper는 네 기존 형식에 맞춰서 유지하고,
   * 아래 message 내용만 넣으면 된다.
   *
   * 아래는 범용적으로 쓰기 쉬운 단순 응답 예시다.
   */
  return {
    message,
    endCall
  };
}

/**
 * ----------------------------
 * Core Sales Flow
 * ----------------------------
 */
function getNextStep(state, userText) {
  const text = normalizeText(userText);

  if (!text) {
    return {
      message:
        "Hi, this is Alex from Ringmate. Quick question — are you currently handling your incoming calls and bookings manually, or do you already have a system in place?",
      nextStage: "opening",
      endCall: false
    };
  }

  // Global exits
  if (detectNotInterested(text)) {
    state.lead.notes.push("Not interested");
    state.lead.pain_point = state.lead.pain_point || "No interest";
    state.lead.interest_level = "cold";

    return {
      message:
        "Totally understand. If things ever get busy and you start missing calls, we’d be happy to help. Have a great day!",
      nextStage: "end",
      endCall: true
    };
  }

  if (detectBusy(text)) {
    setInterest(state, "warm");
    state.lead.notes.push("Busy timing objection");

    return {
      message:
        "No problem at all. Would a quick 5-minute demo later this week be easier for you?",
      nextStage: "close",
      endCall: false
    };
  }

  switch (state.stage) {
    case "opening": {
      if (detectManual(text)) {
        state.branch = "manual";
        state.lead.notes.push("Manual handling");
        return {
          message:
            "Got it. About how many calls or booking requests do you usually get in a day or week?",
          nextStage: "qualification",
          endCall: false
        };
      }

      if (detectHasSystem(text)) {
        state.branch = "system";
        state.lead.notes.push("Already has system");
        return {
          message:
            "Got it — does your current system handle missed calls and booking requests smoothly during busy times?",
          nextStage: "pain_check",
          endCall: false
        };
      }

      return {
        message:
          "Just to clarify — are you mostly handling calls manually, or are you already using a system?",
        nextStage: "opening",
        endCall: false
      };
    }

    case "qualification": {
      const volume = extractCallVolume(userText);
      if (volume) {
        state.lead.call_volume = volume;
      } else {
        state.lead.notes.push(`Call volume response: ${userText}`);
      }

      return {
        message:
          "Do you ever miss calls or feel overwhelmed during busy hours?",
        nextStage: "pain_check",
        endCall: false
      };
    }

    case "pain_check": {
      if (detectPain(text) || detectPositiveInterest(text)) {
        state.lead.pain_point =
          state.lead.pain_point ||
          "Missed calls or pressure during busy hours";
        setInterest(state, "hot");

        return {
          message:
            "That’s exactly where we help. Ringmate is an AI phone assistant that answers every call and helps you capture missed opportunities so you don’t lose customers during busy times. Would you be open to a quick 5-minute demo sometime this week?",
          nextStage: "close",
          endCall: false
        };
      }

      if (state.branch === "system") {
        state.lead.notes.push("Says current system works");
        setInterest(state, "cold");

        return {
          message:
            "That makes sense. If you ever want a backup option for missed calls or after-hours coverage, Ringmate can help. Have a great day!",
          nextStage: "end",
          endCall: true
        };
      }

      return {
        message:
          "Understood. Even then, would you be open to a quick 5-minute demo just to see how Ringmate handles calls during busy times?",
        nextStage: "close",
        endCall: false
      };
    }

    case "close": {
      if (detectPositiveInterest(text)) {
        setInterest(state, "hot");
        return {
          message:
            "Great — what day works best for you? And what’s the best number or contact for a quick follow-up?",
          nextStage: "capture_contact",
          endCall: false
        };
      }

      if (detectNotInterested(text)) {
        state.lead.interest_level = "cold";
        return {
          message:
            "No problem at all. Thanks for your time, and have a great day!",
          nextStage: "end",
          endCall: true
        };
      }

      setInterest(state, "warm");
      return {
        message:
          "No worries — would later this week be easier for a quick 5-minute demo?",
        nextStage: "close",
        endCall: false
      };
    }

    case "capture_contact": {
      const phone = extractPhoneNumber(userText);
      if (phone) {
        state.lead.callback_contact = phone;
      } else {
        state.lead.notes.push(`Contact response: ${userText}`);
      }

      maybeCaptureBusinessName(userText, state);

      return {
        message:
          "Perfect. Thanks — we’ll follow up for a quick demo. Have a great day!",
        nextStage: "end",
        endCall: true
      };
    }

    case "end": {
      return {
        message: "Thank you. Goodbye.",
        nextStage: "end",
        endCall: true
      };
    }

    default: {
      return {
        message:
          "Just to confirm — are you handling calls manually, or are you using a system right now?",
        nextStage: "opening",
        endCall: false
      };
    }
  }
}

/**
 * ----------------------------
 * Routes
 * ----------------------------
 */

app.get("/", (req, res) => {
  res.send("Ringmate Sales AI Engine Running");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    totalCallsTracked: calls.size,
    timestamp: new Date().toISOString()
  });
});

app.post("/webhook", (req, res) => {
  try {
    const body = req.body || {};
    const callId = getCallId(body);
    const userText = getLatestUserMessage(body);

    const state = upsertState(callId);

    if (userText) {
      saveHistory(state, "user", userText);
    }

    const result = getNextStep(state, userText);

    state.stage = result.nextStage;
    state.lastAssistantMessage = result.message;

    saveHistory(state, "assistant", result.message);

    // 디버그 로그
    console.log("----- CALL UPDATE -----");
    console.log("Call ID:", callId);
    console.log("User:", userText);
    console.log("Stage:", state.stage);
    console.log("Branch:", state.branch);
    console.log("Lead:", state.lead);
    console.log("Assistant:", result.message);
    console.log("-----------------------");

    return res.json(buildAssistantResponse(result.message, result.endCall));
  } catch (error) {
    console.error("Webhook error:", error);

    return res.status(500).json({
      message:
        "Sorry, something went wrong on our end. Please try again later.",
      endCall: true
    });
  }
});

/**
 * 디버그용: 저장된 콜 상태 보기
 */
app.get("/calls", (req, res) => {
  res.json(Array.from(calls.values()));
});

app.get("/calls/:callId", (req, res) => {
  const state = calls.get(req.params.callId);
  if (!state) {
    return res.status(404).json({ error: "Call not found" });
  }
  return res.json(state);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
