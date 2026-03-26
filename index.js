const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());

// 생성한 mp3를 Twilio가 가져가게 공개
app.use("/audio", express.static(path.join(__dirname, "audio")));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || "https://ringmate-sales-server.onrender.com";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

// 아주 임시 저장
const calls = new Map();

function escapeXml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function generateSpeechFile(text, fileName) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      output_format: "mp3_22050_32",
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.75,
        style: 0.2,
        use_speaker_boost: true
      }
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ElevenLabs error: ${response.status} ${errText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const audioDir = path.join(__dirname, "audio");
  if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
  }

  const fullPath = path.join(audioDir, fileName);
  fs.writeFileSync(fullPath, buffer);

  return `${BASE_URL}/audio/${fileName}`;
}

async function buildTwimlWithPlayAndGather({ audioUrl, actionUrl }) {
  return `
    <Response>
      <Gather input="speech" action="${escapeXml(actionUrl)}" method="POST" speechTimeout="auto" timeout="2">
        <Play>${escapeXml(audioUrl)}</Play>
      </Gather>
      <Redirect method="POST">${escapeXml(actionUrl)}</Redirect>
    </Response>
  `;
}

// 첫 진입
app.post("/voice/incoming", async (req, res) => {
  try {
    const callSid = req.body.CallSid;
    calls.set(callSid, { turn: 0 });

    const text = "Hi, quick question. Do you handle calls yourself?";
    const fileName = `${callSid}-0.mp3`;
    const audioUrl = await generateSpeechFile(text, fileName);

    res.type("text/xml");
    res.send(await buildTwimlWithPlayAndGather({
      audioUrl,
      actionUrl: "/voice/process",
    }));
  } catch (err) {
    console.error(err);
    res.type("text/xml");
    res.send(`
      <Response>
        <Say>Sorry, something went wrong.</Say>
      </Response>
    `);
  }
});

// 대화 처리
app.post("/voice/process", async (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const userSpeech = (req.body.SpeechResult || "").trim();

    let call = calls.get(callSid);
    if (!call) call = { turn: 0 };

    call.turn += 1;
    calls.set(callSid, call);

    console.log("User said:", userSpeech);

    let responseText = "";

    if (call.turn === 1) {
      responseText = "Got it. Do you miss calls when it gets busy?";
    } else if (call.turn === 2) {
      responseText = "Yeah, that happens. Would that be helpful?";
    } else {
      responseText = "Got it. Have a great day.";
    }

    const fileName = `${callSid}-${call.turn}.mp3`;
    const audioUrl = await generateSpeechFile(responseText, fileName);

    res.type("text/xml");
    res.send(await buildTwimlWithPlayAndGather({
      audioUrl,
      actionUrl: "/voice/process",
    }));
  } catch (err) {
    console.error(err);
    res.type("text/xml");
    res.send(`
      <Response>
        <Say>Sorry, something went wrong.</Say>
      </Response>
    `);
  }
});

app.get("/", (req, res) => {
  res.send("Ringmate Sales AI running");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
