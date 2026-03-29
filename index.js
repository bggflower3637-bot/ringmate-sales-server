import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import OpenAI from "openai";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Ringmate Sales AI server running");
});

app.post("/voice", (req, res) => {
  console.log("📞 Incoming call");

  res.type("text/xml");
  res.send(`
    <Response>
      <Connect>
        <ConversationRelay
          url="wss://ringmate-sales-server.onrender.com/ws"
          welcomeGreeting=" "
          interruptible="speech"
          language="en-US"
          ttsProvider="Google"
          voice="en-US-Standard-C" />
      </Connect>
    </Response>
  `);
});

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(text = "") {
  return text.replace(/\s+/g, " ").trim();
}

function detectIntent(text = "") {
  const t = text.toLowerCase().trim();

  if (!t) return "unknown";

  if (
    /not interested|no thanks|don't need|do not need|already have|we're good|we are good|stop calling|take me off|remove me|nope/.test(
      t
    )
  ) {
    return "reject";
  }

  if (
    /busy|in a meeting|call me later|can't talk|cannot talk|not a good time|driving|with a client|with customer/.test(
      t
    )
  ) {
    return "busy";
  }

  if (
    /yes|yeah|yep|sure|okay|ok|possibly|maybe|i think so|interested|sounds good|that could help/.test(
      t
    )
  ) {
    return "positive";
  }

  if (
    /what is this|who is this|what do you do|can you explain|how does it work|tell me more|what does ringmate do/.test(
      t
    )
  ) {
    return "curious";
  }

  if (
    /manual|myself|me|we do it ourselves|front desk|receptionist|staff handles it/.test(
      t
    )
  ) {
    return "manual";
  }

  if (
    /system|software|platform|service|answering service|ai|automation|ivr|we already use/.test(
      t
    )
  ) {
    return "existing_system";
  }

  if (
    /miss calls|after hours|voicemail|too many calls|hard to keep up|busy times|overflow|weekends/.test(
      t
    )
  ) {
    return "pain";
  }

  if (/\b\d+\b/.test(t)) {
    return "number";
  }

  return "unknown";
}

function detectCallVolume(text = "") {
  const t = text.toLowerCase();
  const match = t.match(/\b(\d{1,3})\b/);
  if (!match) return null;

  const num = Number(match[1]);
  if (Number.isNaN(num)) return null;
  return num;
}

function createSessionState() {
  return {
    stage: "intro",
    leadScore: 0,
    customer: {
      handlingMode: null, // manual | existing_system | unknown
      hasPain: null,
      callVolume: null,
      interestLevel: null, // low | medium | high
      askedWhatItIs: false,
      busyNow: false,
    },
    memory: [],
    lastAssistantText: "",
    lastUserText: "",
    finished: false,
  };
}

function remember(state, key, value) {
  state.memory.push({ key, value, at: Date.now() });
  if (state.memory.length > 20) {
    state.memory = state.memory.slice(-20);
  }
}

function updateStateFromUser(state, userText, intent) {
  state.lastUserText = userText;

  if (intent === "manual") {
    state.customer.handlingMode = "manual";
    state.leadScore += 8;
    remember(state, "handlingMode", "manual");
  }

  if (intent === "existing_system") {
    state.customer.handlingMode = "existing_system";
    state.leadScore -= 2;
    remember(state, "handlingMode", "existing_system");
  }

  if (intent === "pain") {
    state.customer.hasPain = true;
    state.leadScore += 10;
    remember(state, "hasPain", true);
  }

  if (intent === "busy") {
    state.customer.busyNow = true;
    state.leadScore -= 1;
    remember(state, "busyNow", true);
  }

  if (intent === "curious") {
    state.customer.askedWhatItIs = true;
    state.leadScore += 4;
    remember(state, "askedWhatItIs", true);
  }

  if (intent === "positive") {
    state.leadScore += 6;
  }

  if (intent === "reject") {
    state.customer.interestLevel = "low";
    state.leadScore -= 15;
  }

  const volume = detectCallVolume(userText);
  if (volume !== null) {
    state.customer.callVolume = volume;
    remember(state, "callVolume", volume);

    if (volume >= 20) state.leadScore += 12;
    else if (volume >= 10) state.leadScore += 8;
    else if (volume >= 5) state.leadScore += 4;
  }
}

function getShortContextSummary(state) {
  const parts = [];

  parts.push(`stage=${state.stage}`);
  parts.push(`leadScore=${state.leadScore}`);

  if (state.customer.handlingMode) {
    parts.push(`handlingMode=${state.customer.handlingMode}`);
  }

  if (state.customer.hasPain !== null) {
    parts.push(`hasPain=${state.customer.hasPain}`);
  }

  if (state.customer.callVolume !== null) {
    parts.push(`callVolume=${state.customer.callVolume}`);
  }

  if (state.customer.interestLevel) {
    parts.push(`interestLevel=${state.customer.interestLevel}`);
  }

  if (state.customer.askedWhatItIs) {
    parts.push(`askedWhatItIs=true`);
  }

  if (state.customer.busyNow) {
    parts.push(`busyNow=true`);
  }

  return parts.join(", ");
}

function decideNextAction(state, userText, intent) {
  if (state.finished) {
    return {
      type: "end",
      goal: "close",
      message:
        "Thanks again — appreciate your time. Have a good one.",
    };
  }

  if (intent === "reject") {
    state.stage = "exit";
    state.finished = true;
    return {
      type: "end",
      goal: "exit",
      message:
        "Totally understand — no problem at all. Thanks for your time.",
    };
  }

  if (intent === "busy") {
    state.stage = "exit";
    state.finished = true;
    return {
      type: "end",
      goal: "callback_later",
      message:
        "No worries — sounds like a busy moment. I’ll keep it short. Thanks anyway.",
    };
  }

  if (state.stage === "intro") {
    state.stage = "qualification";
    return {
      type: "ask",
      goal: "qualification",
      message:
        "Quick question — are you handling incoming calls yourself right now, or do you already have some kind of system in place?",
    };
  }

  if (state.stage === "qualification") {
    if (intent === "manual") {
      state.stage = "pain";
      return {
        type: "ask",
        goal: "pain_check",
        message:
          "Got it. Do you ever miss calls or booking requests when things get busy?",
      };
    }

    if (intent === "existing_system") {
      state.stage = "pain";
      return {
        type: "ask",
        goal: "pain_check_existing",
        message:
          "Okay — makes sense. Even with that, do you still run into missed calls or after-hours gaps sometimes?",
      };
    }

    if (intent === "curious") {
      return {
        type: "answer_then_ask",
        goal: "qualification_recover",
        message:
          "We help businesses catch missed calls and book more customers without adding front-desk pressure. Quick question — are you handling calls yourself right now?",
      };
    }

    return {
      type: "ask",
      goal: "qualification_repeat",
      message:
        "Just so I understand — are calls mostly handled by you and your team, or are you already using a system for that?",
    };
  }

  if (state.stage === "pain") {
    if (intent === "positive" || intent === "pain") {
      state.customer.hasPain = true;
      state.stage = "volume";
      return {
        type: "ask",
        goal: "volume",
        message:
          "Yeah — that’s exactly the kind of situation we help with. About how many calls or booking requests do you usually get in a day or week?",
      };
    }

    if (intent === "number") {
      state.stage = "interest_check";
      return {
        type: "ask",
        goal: "interest_check_after_number",
        message:
          "Got it. If there were a way to catch more of those without adding more manual work, would that be worth a look?",
      };
    }

    if (intent === "curious") {
      return {
        type: "answer_then_ask",
        goal: "pain_explain",
        message:
          "It’s basically a phone AI that helps answer missed calls, qualify leads, and help with bookings. Quick question though — do missed calls ever happen when things get busy?",
      };
    }

    state.stage = "volume";
    return {
      type: "ask",
      goal: "volume_soft",
      message:
        "Okay — and roughly how many calls or requests do you deal with in a typical day or week?",
    };
  }

  if (state.stage === "volume") {
    if (state.customer.callVolume !== null) {
      state.stage = "interest_check";
      return {
        type: "ask",
        goal: "interest_check",
        message:
          "Got it. If something could help you capture more of those calls automatically, would you be open to taking a quick look at it?",
      };
    }

    if (intent === "curious") {
      return {
        type: "answer_then_ask",
        goal: "volume_explain",
        message:
          "We help businesses respond to calls more consistently, especially when staff are busy or unavailable. Roughly how many calls do you get in a normal day or week?",
      };
    }

    return {
      type: "ask",
      goal: "volume_repeat",
      message:
        "Even a rough number is fine — is it more like a few calls, ten-ish, or a lot more than that?",
    };
  }

  if (state.stage === "interest_check") {
    if (intent === "positive" || intent === "curious") {
      state.customer.interestLevel = "high";
      state.leadScore += 12;
      state.stage = "handoff";
      state.finished = true;

      return {
        type: "end",
        goal: "handoff",
        message:
          "Nice — sounds like it could be worth a quick follow-up. We can have someone reach out and show you how it works.",
      };
    }

    if (intent === "reject") {
      state.customer.interestLevel = "low";
      state.stage = "exit";
      state.finished = true;
      return {
        type: "end",
        goal: "exit_after_interest_check",
        message:
          "Totally fair — no pressure. Thanks for taking the call.",
      };
    }

    state.customer.interestLevel = "medium";
    state.stage = "handoff";
    state.finished = true;
    return {
      type: "end",
      goal: "soft_handoff",
      message:
        "No problem — I’ll leave it there for now. If it becomes a priority later, it could definitely help with missed-call coverage.",
    };
  }

  return {
    type: "end",
    goal: "fallback_close",
    message:
      "Alright — thanks for your time. Have a great rest of your day.",
  };
}

async function naturalizeMessage(baseMessage, state, userText, abortSignal) {
  const contextSummary = getShortContextSummary(state);

  const response = await openai.chat.completions.create(
    {
      model: "gpt-4o-mini",
      temperature: 0.35,
      max_tokens: 80,
      messages: [
        {
          role: "system",
          content: `
You are rewriting outbound sales call lines for a live phone conversation.

Your job:
- You do NOT decide the business logic
- You do NOT change the meaning
- You ONLY rewrite the provided base line to sound natural on a phone call

Style:
- sound like a real human
- warm, calm, conversational
- short
- usually 1 sentence, sometimes 2 very short sentences
- never formal
- never robotic
- never salesy
- never over-explain
- one question at a time
- use light spoken fillers sometimes: "yeah", "okay", "right", "got it"
- spoken pauses with dashes are allowed
- keep it easy to say aloud
- do not use bullet points
- do not mention being AI unless explicitly included in the base line
- output only the final spoken line

Good tone examples:
- "Yeah — got it. Quick question — are you handling calls yourself right now?"
- "Okay — makes sense. Do you ever miss calls when it gets busy?"
- "Right — got it. About how many calls do you usually get in a day?"
          `.trim(),
        },
        {
          role: "user",
          content: `
Context:
${contextSummary}

User just said:
"${userText}"

Rewrite this naturally for a live phone call:
"${baseMessage}"
          `.trim(),
        },
      ],
    },
    { signal: abortSignal }
  );

  const text =
    response.choices?.[0]?.message?.content?.trim() || baseMessage;

  return cleanText(text);
}

wss.on("connection", (ws) => {
  console.log("🔌 Twilio ConversationRelay connected");

  const state = createSessionState();

  let activeResponseId = 0;
  let currentAbortController = null;
  let isGenerating = false;

  async function sendText(text, last = true) {
    ws.send(
      JSON.stringify({
        type: "text",
        token: text,
        last,
      })
    );
  }

  async function sendThinkingFiller(responseId) {
    const fillers = ["Yeah —", "Okay —", "Got it —", "Right —", "Mm-hmm —"];

    const filler = pickRandom(fillers);

    if (responseId !== activeResponseId) return false;

    await sendText(filler, false);
    await wait(140);

    return responseId === activeResponseId;
  }

  async function handleUserTurn(userText) {
    isGenerating = true;
    activeResponseId += 1;
    const thisResponseId = activeResponseId;

    const abortController = new AbortController();
    currentAbortController = abortController;

    try {
      const intent = detectIntent(userText);
      console.log("🧠 Intent:", intent);

      updateStateFromUser(state, userText, intent);

      const action = decideNextAction(state, userText, intent);
      console.log("🎯 Action:", action);
      console.log("📊 State:", getShortContextSummary(state));

      const fillerValid = await sendThinkingFiller(thisResponseId);
      if (!fillerValid || abortController.signal.aborted) return;

      const finalLine = await naturalizeMessage(
        action.message,
        state,
        userText,
        abortController.signal
      );

      if (abortController.signal.aborted || thisResponseId !== activeResponseId) {
        return;
      }

      await sendText(finalLine, true);
      state.lastAssistantText = finalLine;

      console.log("🤖 Assistant:", finalLine);
    } catch (error) {
      if (error?.name === "AbortError") {
        console.log("⛔ OpenAI request aborted");
        return;
      }

      console.error("❌ Error:", error);

      try {
        await sendText("Sorry — I hit a problem on my side.", true);
      } catch {}
    } finally {
      if (thisResponseId === activeResponseId) {
        currentAbortController = null;
        isGenerating = false;
      }
    }
  }

  sendText("Hi — how’s it going?", true);

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      console.log("📩 From Twilio:", msg);

      if (msg.type === "setup") return;
      if (msg.type !== "prompt") return;

      const userText = cleanText(msg.voicePrompt || msg.transcript || "");
      if (!userText) return;

      console.log("👤 User said:", userText);

      if (currentAbortController) {
        try {
          currentAbortController.abort();
          console.log("⛔ Aborted current response due to interrupt");
        } catch {}
        currentAbortController = null;
        isGenerating = false;
      }

      if (isGenerating) {
        await sendText("Yeah — one sec.", true);
        return;
      }

      await handleUserTurn(userText);
    } catch (error) {
      console.error("❌ WebSocket message error:", error);
    }
  });

  ws.on("close", () => {
    if (currentAbortController) {
      try {
        currentAbortController.abort();
      } catch {}
    }
    console.log("❌ Twilio ConversationRelay disconnected");
  });

  ws.on("error", (err) => {
    console.error("❌ WebSocket error:", err.message);
  });
});

const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
