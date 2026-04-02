import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
const HEYGEN_AVATAR_ID = process.env.HEYGEN_AVATAR_ID;
const HEYGEN_VOICE_ID = process.env.HEYGEN_VOICE_ID;

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateScript({
  recipient_name,
  sender_name,
  occasion,
  tone,
  relationship,
  extra_note,
}) {
  const prompt = `
You are writing a short spoken video message for a digital message card.

Requirements:
- 60 to 110 words
- warm, natural, spoken English
- not too dramatic
- no emojis
- no stage directions
- no quotation marks
- end naturally with the sender's name
- suitable for an avatar video

Recipient name: ${recipient_name || ""}
Sender name: ${sender_name || ""}
Occasion: ${occasion || ""}
Tone: ${tone || ""}
Relationship: ${relationship || ""}
Extra note: ${extra_note || ""}

Write only the final message text.
`.trim();

  const response = await openai.responses.create({
    model: "gpt-5.4",
    input: prompt,
  });

  const script = (response.output_text || "").trim();

  if (!script) {
    throw new Error("OpenAI returned an empty script.");
  }

  return script;
}

async function createHeyGenVideo({ script }) {
  requireEnv("HEYGEN_API_KEY", HEYGEN_API_KEY);
  requireEnv("HEYGEN_AVATAR_ID", HEYGEN_AVATAR_ID);
  requireEnv("HEYGEN_VOICE_ID", HEYGEN_VOICE_ID);

  const createRes = await fetch("https://api.heygen.com/v2/video/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": HEYGEN_API_KEY,
    },
    body: JSON.stringify({
      video_inputs: [
        {
          character: {
            type: "avatar",
            avatar_id: HEYGEN_AVATAR_ID,
          },
          voice: {
            type: "text",
            input_text: script,
            voice_id: HEYGEN_VOICE_ID,
            speed: 1,
          },
          background: {
            type: "color",
            value: "#F7F7F7",
          },
        },
      ],
      dimension: {
        width: 1280,
        height: 720,
      },
    }),
  });

  const createData = await createRes.json();

  if (!createRes.ok) {
    throw new Error(
      `HeyGen create failed: ${createRes.status} ${JSON.stringify(createData)}`
    );
  }

  const videoId = createData?.data?.video_id || createData?.video_id;
  if (!videoId) {
    throw new Error(`HeyGen did not return video_id: ${JSON.stringify(createData)}`);
  }

  return { videoId, raw: createData };
}

async function getHeyGenVideoStatus(videoId) {
  const statusRes = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`, {
    method: "GET",
    headers: {
      "X-Api-Key": HEYGEN_API_KEY,
      "Accept": "application/json",
    },
  });

  const statusData = await statusRes.json();

  if (!statusRes.ok) {
    throw new Error(
      `HeyGen status failed: ${statusRes.status} ${JSON.stringify(statusData)}`
    );
  }

  return statusData;
}

app.get("/", (req, res) => {
  res.send("digital-message-card-server is running");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    hasHeyGenKey: !!process.env.HEYGEN_API_KEY,
    hasAvatarId: !!process.env.HEYGEN_AVATAR_ID,
    hasVoiceId: !!process.env.HEYGEN_VOICE_ID,
  });
});

app.post("/create-message-card", async (req, res) => {
  try {
    requireEnv("OPENAI_API_KEY", process.env.OPENAI_API_KEY);
    requireEnv("HEYGEN_API_KEY", HEYGEN_API_KEY);

    const {
      recipient_name,
      sender_name,
      occasion,
      tone,
      relationship,
      extra_note,
    } = req.body || {};

    if (!recipient_name || !sender_name || !occasion) {
      return res.status(400).json({
        ok: false,
        error: "recipient_name, sender_name, and occasion are required.",
      });
    }

    const script = await generateScript({
      recipient_name,
      sender_name,
      occasion,
      tone,
      relationship,
      extra_note,
    });

    const { videoId } = await createHeyGenVideo({ script });

    // up to ~2 minutes polling
    let finalStatus = null;
    for (let i = 0; i < 24; i++) {
      await sleep(5000);
      const statusData = await getHeyGenVideoStatus(videoId);

      const data = statusData?.data || statusData;
      const status = data?.status;

      if (status === "completed") {
        finalStatus = data;
        break;
      }

      if (status === "failed") {
        return res.status(500).json({
          ok: false,
          step: "heygen_render",
          video_id: videoId,
          status: data,
        });
      }
    }

    if (!finalStatus) {
      return res.status(202).json({
        ok: true,
        message: "Video generation started but not finished yet.",
        video_id: videoId,
        script,
      });
    }

    const videoUrl =
      finalStatus?.video_url ||
      finalStatus?.url ||
      finalStatus?.video_share_page_url ||
      null;

    return res.json({
      ok: true,
      script,
      video_id: videoId,
      video_url: videoUrl,
      heygen_status: finalStatus,
    });
  } catch (error) {
    console.error("create-message-card error:", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "Unknown server error",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
