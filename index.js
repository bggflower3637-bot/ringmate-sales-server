import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import axios from "axios";
import OpenAI from "openai";
import twilio from "twilio";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.PUBLIC_BASE_URL;

if (!BASE_URL) {
  console.error("Missing PUBLIC_BASE_URL in environment variables.");
  process.exit(1);
}

const requiredEnv = [
  "OPENAI_API_KEY",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_ID",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

const publicDir = path.join(process.cwd(), "public");
const ttsDir = path.join(publicDir, "tts");
const fillersDir = path.join(publicDir, "fillers");

if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);
if (!fs.existsSync(ttsDir)) fs.mkdirSync(ttsDir, { recursive: true });
if (!fs.existsSync(fillersDir)) fs.mkdirSync(fillersDir, { recursive: true });

app.use("/tts", express.static(ttsDir));
app.use("/fillers", express.static(fillersDir));

const calls = new Map();
const SILENCE_THRESHOLD_MS = 900;
const SILENCE_CHECK_INTERVAL_MS = 250;
const MAX_QUEUE_ITEMS = 12;

function now() {
  return new Date().toISOString();
}

function logStep(callSid, step, extra = "") {
  console.log(`[${now()}] [${callSid}] ${step}${extra ? ` | ${extra}` : ""}`);
}

function safeTextPreview(text, max = 90) {
  if (!text) return "";
  const cleaned = String(text).replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}

function getCallState(callSid) {
  if (!calls.has(callSid)) {
    calls.set(callSid, {
      queue: [],
      isPlaying: false,
      generationDone: true,
      lastAudioAt: Date.now(),
      destroyed: false,
      currentTurnId: null,
      currentCallStatus: "unknown",
      turnStartedAt: null,
    });
  }
  return calls.get(callSid);
}

function cleanupCall(callSid) {
  const state = calls.get(callSid);
  if (!state) return;

  state.destroyed = true;
  state.queue = [];
  state.isPlaying = false;
  logStep(callSid, "cleanup_call");
  calls.delete(callSid);
}

const FILLERS = [
  `${BASE_URL}/fillers/yeah.mp3`,
  `${BASE_URL}/fillers/got-it.mp3`,
  `${BASE_URL}/fillers/right.mp3`,
  `${BASE_URL}/fillers/okay.mp3`,
];

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function enqueueAudio(callSid, audioUrl, type = "speech", turnId = null) {
  const state = getCallState(callSid);
  if (state.destroyed) return;

  if (turnId && state.currentTurnId && turnId !== state.currentTurnId) {
    logStep(callSid, "skip_enqueue_old_turn", `${type}`);
    return;
  }

  if (state.queue.length >= MAX_QUEUE_ITEMS) {
    state.queue.shift();
    logStep(callSid, "queue_trimmed", `max=${MAX_QUEUE_ITEMS}`);
  }

  state.queue.push({ audioUrl, type, turnId });
  logStep(callSid, "audio_enqueued", `${type} | queue=${state.queue.length}`);
}

async function getTwilioCallStatus(callSid) {
  try {
    const call = await twilioClient.calls(callSid).fetch();
    return call?.status || "unknown";
  } catch (err) {
    logStep(callSid, "twilio_fetch_failed", err.message);
    return "unknown";
  }
}

function isPlayableStatus(status) {
  return ["in-progress", "ringing", "queued"].includes(status);
}

async function canPlayToCall(callSid) {
  if (!calls.has(callSid)) return false;
  const state = calls.get(callSid);
  if (!state || state.destroyed) return false;

  const status = await getTwilioCallStatus(callSid);
  state.currentCallStatus = status;
  logStep(callSid, "call_status", status);

  return isPlayableStatus(status);
}

async function pumpAudioQueue(callSid) {
  const state = getCallState(callSid);
  if (!state || state.destroyed || state.isPlaying) return;

  state.isPlaying = true;

  try {
    while (state.queue.length > 0) {
      if (!calls.has(callSid)) return;

      const latestState = calls.get(callSid);
      if (!latestState || latestState.destroyed) return;

      const item = latestState.queue.shift();
      if (!item) continue;

      if (item.turnId && item.turnId !== latestState.currentTurnId) {
        logStep(callSid, "drop_old_turn_audio", item.type);
        continue;
      }

      const playable = await canPlayToCall(callSid);
      if (!playable) {
        logStep(callSid, "call_not_playable_cleanup", latestState.currentCallStatus);
        cleanupCall(callSid);
        return;
      }

      await instructTwilioToPlay(callSid, item.audioUrl);

      if (!calls.has(callSid)) return;
      const refreshed = calls.get(callSid);
      if (!refreshed || refreshed.destroyed) return;

      refreshed.lastAudioAt = Date.now();
      logStep(callSid, "audio_played", item.type);
    }
  } catch (err) {
    console.error("pumpAudioQueue error:", err.message);

    if (
      err.message.includes("not in-progress") ||
      err.message.includes("Call is not in-progress") ||
      err.message.includes("Cannot redirect")
    ) {
      logStep(callSid, "pump_cleanup_not_in_progress");
      cleanupCall(callSid);
      return;
    }
  } finally {
    if (calls.has(callSid)) {
      const latest = calls.get(callSid);
      if (latest) latest.isPlaying = false;
    }
  }
}

async function startAssistantResponse(callSid, transcript, turnId) {
  const state = getCallState(callSid);
  if (state.destroyed) return;

  let buffer = "";
  logStep(callSid, "openai_start", `turn=${turnId} | text=${safeTextPreview(transcript)}`);

  const stream = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    stream: true,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: `
You are a natural phone sales assistant.
Speak like a real person.
Use short conversational phrases.
Prefer 4 to 8 words per sentence.
Never give long explanations.
Respond in 1 to 3 short sentences max.
Sound immediate and conversational.
`.trim(),
      },
      {
        role: "user",
        content: transcript,
      },
    ],
  });

  let sawFirstToken = false;

  for await (const event of stream) {
    const token = event.choices?.[0]?.delta?.content || "";
    if (!token) continue;

    if (!sawFirstToken) {
      sawFirstToken = true;
      logStep(callSid, "openai_first_token", `turn=${turnId}`);
    }

    if (!calls.has(callSid)) return;
    const latest = calls.get(callSid);
    if (!latest || latest.destroyed || latest.currentTurnId !== turnId) {
      logStep(callSid, "turn_cancelled", `old_turn=${turnId}`);
      return;
    }

    buffer += token;

    while (true) {
      const { chunk, remaining } = extractSpeakableChunk(buffer);
      if (!chunk) break;

      buffer = remaining;
      logStep(callSid, "tts_start", safeTextPreview(chunk));
      const audioUrl = await generateElevenTTS(chunk);
      logStep(callSid, "tts_done", safeTextPreview(chunk));

      if (!calls.has(callSid)) return;
      const current = calls.get(callSid);
      if (!current || current.destroyed || current.currentTurnId !== turnId) {
        return;
      }

      enqueueAudio(callSid, audioUrl, "speech", turnId);
      pumpAudioQueue(callSid).catch(console.error);
    }
  }

  if (!calls.has(callSid)) return;
  const latestState = calls.get(callSid);

  if (buffer.trim() && latestState && !latestState.destroyed && latestState.currentTurnId === turnId) {
    logStep(callSid, "tts_start_final", safeTextPreview(buffer.trim()));
    const audioUrl = await generateElevenTTS(buffer.trim());
    logStep(callSid, "tts_done_final", safeTextPreview(buffer.trim()));
    enqueueAudio(callSid, audioUrl, "speech", turnId);
    pumpAudioQueue(callSid).catch(console.error);
  }

  if (calls.has(callSid)) {
    const current = calls.get(callSid);
    if (current && current.currentTurnId === turnId) {
      current.generationDone = true;
      logStep(callSid, "generation_done", `turn=${turnId}`);
    }
  }
}

function extractSpeakableChunk(text) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return { chunk: null, remaining: "" };
  }

  const punctMatch = normalized.match(/^(.{1,90}?[.!?])\s+(.*)$/);
  if (punctMatch) {
    return {
      chunk: punctMatch[1].trim(),
      remaining: punctMatch[2].trim(),
    };
  }

  const words = normalized.split(" ");
  if (words.length >= 8) {
    return {
      chunk: words.slice(0, 8).join(" "),
      remaining: words.slice(8).join(" "),
    };
  }

  return { chunk: null, remaining: text };
}

async function generateElevenTTS(text) {
  const fileName = `${crypto.randomUUID()}.mp3`;
  const filePath = path.join(ttsDir, fileName);

  const response = await axios({
    method: "post",
    url: `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
    responseType: "arraybuffer",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    data: {
      text,
      model_id: "eleven_flash_v2_5",
      voice_settings: {
        stability: 0.72,
        similarity_boost: 0.8,
        style: 0.03,
      },
    },
    timeout: 15000,
  });

  fs.writeFileSync(filePath, response.data);
  return `${BASE_URL}/tts/${fileName}`;
}

async function instructTwilioToPlay(callSid, audioUrl) {
  try {
    logStep(callSid, "twilio_play_start", audioUrl);

    const twiml = `
<Response>
  <Play>${audioUrl}</Play>
</Response>
`.trim();

    await twilioClient.calls(callSid).update({ twiml });
    await sleep(900);

    logStep(callSid, "twilio_play_sent", audioUrl);
  } catch (err) {
    console.error(`Twilio play error for ${callSid}:`, err.message);

    if (
      err.message.includes("not in-progress") ||
      err.message.includes("Call is not in-progress") ||
      err.message.includes("Cannot redirect")
    ) {
      logStep(callSid, "call_not_in_progress_cleanup");
      cleanupCall(callSid);
      return;
    }

    throw err;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

setInterval(() => {
  for (const [callSid, state] of calls.entries()) {
    if (!state || state.destroyed) continue;
    if (!state.currentTurnId) continue;

    const silenceMs = Date.now() - state.lastAudioAt;
    const queueEmpty = state.queue.length === 0;

    if (
      silenceMs > SILENCE_THRESHOLD_MS &&
      !state.isPlaying &&
      !state.generationDone &&
      queueEmpty
    ) {
      enqueueAudio(callSid, randomPick(FILLERS), "filler", state.currentTurnId);
      pumpAudioQueue(callSid).catch(console.error);
      state.lastAudioAt = Date.now();
      logStep(callSid, "silence_killer_triggered", `${silenceMs}ms`);
    }
  }
}, SILENCE_CHECK_INTERVAL_MS);

app.post("/voice/incoming", (req, res) => {
  const callSid = req.body.CallSid;
  const state = getCallState(callSid);
  state.currentCallStatus = "in-progress";
  logStep(callSid, "incoming_call");

  const twiml = `
<Response>
  <Say>Hi.</Say>
  <Pause length="1"/>
</Response>
`.trim();

  res.type("text/xml").send(twiml);
});

app.post("/voice/waiting", (req, res) => {
  const callSid = req.query.callSid || req.body.CallSid;
  getCallState(callSid);
  logStep(callSid, "waiting");

  const twiml = `
<Response>
  <Pause length="1"/>
</Response>
`.trim();

  res.type("text/xml").send(twiml);
});

app.post("/voice/turn-ended", async (req, res) => {
  try {
    const { callSid, transcript } = req.body;

    if (!callSid || !transcript) {
      return res.status(400).json({ error: "Missing callSid or transcript" });
    }

    const state = getCallState(callSid);
    const turnId = crypto.randomUUID();

    state.currentTurnId = turnId;
    state.generationDone = false;
    state.queue = [];
    state.lastAudioAt = Date.now();
    state.turnStartedAt = Date.now();

    logStep(callSid, "turn_received", safeTextPreview(transcript));

    enqueueAudio(callSid, randomPick(FILLERS), "filler", turnId);
    pumpAudioQueue(callSid).catch(console.error);

    startAssistantResponse(callSid, transcript, turnId).catch((err) => {
      console.error("startAssistantResponse error:", err.message);
      if (calls.has(callSid)) {
        const current = calls.get(callSid);
        if (current && current.currentTurnId === turnId) {
          current.generationDone = true;
        }
      }
    });

    res.json({ ok: true, turnId });
  } catch (err) {
    console.error("/voice/turn-ended error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/voice/status", (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;

  if (callSid) {
    const state = getCallState(callSid);
    state.currentCallStatus = callStatus || state.currentCallStatus;
    logStep(callSid, "status_callback", callStatus || "unknown");

    if (["completed", "busy", "failed", "no-answer", "canceled"].includes(callStatus)) {
      cleanupCall(callSid);
    }
  }

  res.sendStatus(200);
});

app.post("/voice/call-ended", (req, res) => {
  const callSid = req.body.callSid || req.body.CallSid;
  if (callSid) {
    logStep(callSid, "call_ended");
    cleanupCall(callSid);
  }
  res.json({ ok: true });
});

app.get("/", (req, res) => {
  res.send("Ringmate gap-killer server running");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
