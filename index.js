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
    if (!callId) return;

    if (activeCalls.has(callId)) return;

    activeCalls.set(callId, {
      startedAt: Date.now(),
      openerSent: false,
      sessionReady: false,
      ws: null
    });

    // ✅ CALL ACCEPT (구조 그대로 유지)
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
            output: { voice: "cedar" }
          },
          instructions: `
You are Alex from Ringmate.

IDENTITY
- Calm, confident, human caller
- Professional but natural
- Not pushy

MISSION (LOCKED)
- Stay ONLY on how they handle incoming calls
- Do not drift into other topics

SPEECH (MANDATORY)
- Never speak fast
- Short sentences
- Natural pauses

STYLE
- Human
- Brief
- Conversational

FLOW

1. Greeting
2. Who handles calls
3. How calls are handled
4. Missed calls / can't pick up
5. Light solution mention
6. Soft interest check

QUESTION STYLE

Instead of:
"Do you miss calls?"

Say:
"Do you ever run into situations where you just can’t get to them?"

REACTIONS

Use:
- "Got it..."
- "Yeah, that makes sense."
- "I hear that a lot."

CLOSING

Say:
"Would it be worth a quick look?"
          `.trim()
        })
      }
    );

    if (!acceptRes.ok) {
      activeCalls.delete(callId);
      return;
    }

    // ✅ WebSocket 연결 (구조 유지)
    const ws = new WebSocket(
      `wss://api.openai.com/v1/realtime?call_id=${callId}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1"
        }
      }
    );

    const state = activeCalls.get(callId);
    if (state) state.ws = ws;

    const sendOpening = () => {
      const state = activeCalls.get(callId);
      if (!state || state.openerSent || !state.sessionReady) return;

      state.openerSent = true;

      ws.send(
        JSON.stringify({
          type: "response.create",
          response: {
            instructions: `
Start speaking now.

Speak slowly.
Short sentences.
Pause naturally.

Say:

"Hi, this is Alex with Ringmate."

Pause.

"I’ll be quick — I just had a quick question about how you're handling your incoming calls."

Pause.

"Are you usually the one picking those up… or is that someone else?"

Then wait.
            `.trim()
          }
        })
      );
    };

    ws.on("open", () => {
      console.log("Realtime connected:", callId);

      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            model: "gpt-realtime",
            instructions: `
You are Alex from Ringmate.

MISSION
Stay focused on incoming calls.

SPEED
- Slow
- Short sentences
- Natural pauses

FLOW

1.
"Are you usually the one picking those up… or someone else?"

2.
"Got it… how are you handling those right now?"

3.
"Do you ever run into situations where you just can’t get to them?"

4.
If yes:
"Yeah… that’s actually pretty common."

5.
"We’ve been helping businesses capture missed calls automatically."

6.
"Would it be worth a quick look at some point?"

RULES
- One question at a time
- Keep it short
- Stay on topic
            `.trim()
          }
        })
      );
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (
          msg.type === "session.created" ||
          msg.type === "session.updated"
        ) {
          const state = activeCalls.get(callId);
          if (state) state.sessionReady = true;
          sendOpening();
        }

        if (msg.type === "error") {
          console.error("Realtime error:", msg);
        }
      } catch (e) {}
    });

    ws.on("close", () => {
      activeCalls.delete(callId);
    });

    setTimeout(() => {
      const state = activeCalls.get(callId);
      if (state?.ws) {
        try {
          state.ws.close();
        } catch {}
      }
      activeCalls.delete(callId);
    }, 10 * 60 * 1000);

  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).send("error");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});
