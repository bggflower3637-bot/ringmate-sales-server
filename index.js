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
if (!fs.existsSync(ttsDir)) fs.mkdirSync(ttsDir);
if (!fs.existsSync(fillersDir)) fs.mkdirSync(fillersDir);

app.use("/tts", express.static(ttsDir));
app.use("/fillers", express.static(fillersDir));

const calls = new Map();

function now() {
  return new Date().toISOString();
}

function logStep(callSid, step, extra = "") {
  console.log(`[${now()}] [${callSid}] ${step}${extra ? ` | ${extra}` : ""}`);
}

function getCallState(callSid) {
  if (!calls.has(callSid)) {
    calls.set(callSid, {
      queue: [],
      isPlaying: false,
      generationDone: false,
      lastAudioAt: Date.now(),
      destroyed: false,
      currentTurnId: null,
    });
  }
  return calls.get(callSid);
}

function cleanupCall(callSid) {
  const state = calls.get(callSid);
  if (!state) return;
  state.destroyed = true;
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

  if (turnId && state.currentTurnId && turnId !== state.currentTurnId) {
    return;
  }

  state.queue.push({ audioUrl, type, turnId });
  logStep(callSid, "audio_enqueued", `${type} | queue=${state.queue.length}`);
}

async function pumpAudioQueue(callSid) {
  const state = getCallState(callSid);
  if (state.destroyed || state.isPlaying) return;

  state.isPlaying = true;

  try {
    while (state.queue.length > 0 && !state.destroyed) {
      const item = state.queue.shift();

      if (item.turnId && item.turnId !== state.currentTurnId) {
        continue;
      }

      await instructTwilioToPlay(callSid, item.audioUrl);
      state.lastAudioAt = Date.now();
      logStep(callSid, "audio_played", item.type);
    }
  } catch (err) {
    console.error("pumpAudioQueue error:", err.message);
  } finally {
    state.isPlaying = false;
  }
}

async function startAssistantResponse(callSid, transcript, turnId) {
  const state = getCallState(callSid);
  if (state.destroyed) return;

  let buffer = "";
  logStep(callSid, "openai_start", `turn=${turnId}`);

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

    if (state.currentTurnId !== turnId) {
      logStep(callSid, "turn_cancelled", `old_turn=${turnId}`);
      return;
    }

    buffer += token;

    while (true) {
      const { chunk, remaining } = extractSpeakableChunk(buffer);
      if (!chunk) break;

      buffer = remaining;
      logStep(callSid, "tts_start", chunk);
      const audioUrl = await generateElevenTTS(chunk);
      logStep(callSid, "tts_done", chunk);

      if (state.currentTurnId !== turnId) {
        return;
      }

      enqueueAudio(callSid, audioUrl, "speech", turnId);
      pumpAudioQueue(callSid).catch(console.error);
    }
  }

  if (buffer.trim() && state.currentTurnId === turnId) {
    logStep(callSid, "tts_start_final", buffer.trim());
    const audioUrl = await generateElevenTTS(buffer.trim());
    logStep(callSid, "tts_done_final", buffer.trim());
    enqueueAudio(callSid, audioUrl, "speech", turnId);
    pumpAudioQueue(callSid).catch(console.error);
  }

  if (state.currentTurnId === turnId) {
    state.generationDone = true;
    logStep(callSid, "generation_done", `turn=${turnId}`);
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
  logStep(callSid, "twilio_play_start", audioUrl);

  const twiml = `
<Response>
  <Play>${audioUrl}</Play>
  <Pause length="1"/>
  <Redirect method="POST">${BASE_URL}/voice/waiting?callSid=${encodeURIComponent(callSid)}</Redirect>
</Response>
  `.trim();

  await twilioClient.calls(callSid).update({ twiml });

  await sleep(900);
  logStep(callSid, "twilio_play_sent", audioUrl);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

setInterval(() => {
  for (const [callSid, state] of calls.entries()) {
    if (state.destroyed) continue;

    const silenceMs = Date.now() - state.lastAudioAt;
    const queueEmpty = state.queue.length === 0;

    if (
      silenceMs > 800 &&
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
}, 250);

app.post("/voice/incoming", (req, res) => {
  const callSid = req.body.CallSid;
  getCallState(callSid);
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

    logStep(callSid, "turn_received", transcript);

    enqueueAudio(callSid, randomPick(FILLERS), "filler", turnId);
    pumpAudioQueue(callSid).catch(console.error);

    startAssistantResponse(callSid, transcript, turnId).catch(console.error);

    res.json({ ok: true, turnId });
  } catch (err) {
    console.error("/voice/turn-ended error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
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
