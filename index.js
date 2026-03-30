import express from "express";
import WebSocket from "ws";

const app = express();
app.use(express.json());

const activeCalls = new Map();

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.get("/", (req, res) => {
  res.send("Ringmate SIP realtime server running");
});

app.post("/openai-realtime-webhook", async (req, res) => {
  try {
    const event = req.body;
    console.log("Incoming webhook event:", JSON.stringify(event, null, 2));

    res.status(200).send("ok");

    if (event?.type !== "realtime.call.incoming") return;

    const callId = event?.data?.call_id;
    if (!callId) {
      console.log("No call_id found");
      return;
    }

    if (activeCalls.has(callId)) {
      console.log("Call already being handled:", callId);
      return;
    }

    activeCalls.set(callId, {
      startedAt: Date.now(),
      accepted: false,
      ws: null,
      openerSent: false
    });

    const acceptRes = await fetch(
      `https://api.openai.com/v1/realtime/calls/${callId}/accept`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          type: "realtime",
          model: "gpt-realtime",
          audio: {
            output: {
              voice: "cedar"
            }
          },
          instructions: `
You are Alex from Ringmate.

IDENTITY
- You are a real-sounding business caller.
- You are calm, respectful, mature, and easy to talk to.

VOICE
- Speak slowly.
- Speak a little more slowly than normal business speech.
- Use a calm, grounded, slightly warm tone.
- Never sound rushed.
- Never sound overly cheerful.
- Never sound like a telemarketer.
- Never sound like you are reading a script.

PACING
- Keep sentences short.
- Say one idea at a time.
- Pause naturally between sentences.
- Let each sentence land before moving on.
- Do not stack ideas together.
- Do not speak in long paragraphs.

CONVERSATION STYLE
- Start gently.
- Greet first.
- Sound polite and human.
- Ask permission before getting into the reason for the call.
- Do not jump into sales language.
- Do not pressure.
- Ask only one short question at a time.
- After they answer, acknowledge briefly and continue naturally.

OPENING STYLE
- Start with a polite hello.
- Briefly introduce yourself.
- Ask if now is a bad time.
- Ask if you can ask a quick question.
- Keep the opening soft and conversational.

GOAL
- Have a natural conversation.
- Build comfort first.
- Then find out whether they are handling calls manually.
- If there is interest, offer a human follow-up.
- If they are busy or not interested, end politely and briefly.

IMPORTANT
- Begin speaking first when the call connects.
- But do not come in too strong.
- The first few seconds should feel human, calm, and easy.
          `
        })
      }
    );

    const acceptText = await acceptRes.text();
    console.log("ACCEPT STATUS:", acceptRes.status);
    console.log("ACCEPT BODY:", acceptText);

    if (!acceptRes.ok) {
      activeCalls.delete(callId);
      return;
    }

    activeCalls.set(callId, {
      ...activeCalls.get(callId),
      accepted: true
    });

    const ws = new WebSocket(
      `wss://api.openai.com/v1/realtime?call_id=${callId}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1"
        }
      }
    );

    activeCalls.set(callId, {
      ...activeCalls.get(callId),
      ws
    });

    let sessionReady = false;

    ws.on("open", () => {
      console.log("Realtime websocket connected for call:", callId);

      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            model: "gpt-realtime",
            instructions: `
You are Alex from Ringmate.

Speak slowly and naturally.
Sound calm, mature, and human.
Never rush.
Never sound scripted.
Keep each sentence short.
Pause naturally between sentences.
Start soft.
Ask permission before getting into the call.
Do not sound salesy.
Do not push.
One question at a time.
            `
          }
        })
      );
    });

    const sendOpening = () => {
      const state = activeCalls.get(callId);
      if (!state || state.openerSent || !sessionReady) return;

      state.openerSent = true;
      activeCalls.set(callId, state);

      ws.send(
        JSON.stringify({
          type: "response.create",
          response: {
            instructions: `
Start speaking now.

Speak slowly.
Sound calm, natural, and polite.
Do not rush.
Pause naturally between each sentence.

Say this style of opener:

"Hi, this is Alex... with Ringmate."

Small natural pause.

"How are you today?"

Small natural pause.

"I was hoping to ask you something real quick... if this is an okay time."

Then stop and wait for their answer.

If they say yes, continue gently.
If they sound busy, apologize briefly and keep it short.
            `
          }
        })
      );
    };

    ws.on("message", (data) => {
      const text = data.toString();
      console.log("Realtime event:", text);

      try {
        const msg = JSON.parse(text);

        if (msg.type === "session.updated" || msg.type === "session.created") {
          sessionReady = true;
          sendOpening();
        }

        if (msg.type === "error") {
          console.error("Realtime error event:", JSON.stringify(msg, null, 2));
        }
      } catch (err) {
        console.error("Failed to parse realtime message:", err);
      }
    });

    ws.on("error", (err) => {
      console.error("Realtime websocket error:", err);
    });

    ws.on("close", () => {
      console.log("Realtime websocket closed for call:", callId);
      activeCalls.delete(callId);
    });

    setTimeout(() => {
      if (activeCalls.has(callId)) {
        console.log("Cleaning up stale call:", callId);
        try {
          activeCalls.get(callId)?.ws?.close();
        } catch {}
        activeCalls.delete(callId);
      }
    }, 10 * 60 * 1000);
  } catch (error) {
    console.error("Webhook error:", error);
    if (!res.headersSent) {
      res.status(500).send("error");
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
