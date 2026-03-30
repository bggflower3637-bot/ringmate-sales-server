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

    // ✅ CALL ACCEPT (구조 절대 유지)
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
- Calm, confident, human
- Professional but relaxed
- Not pushy

MISSION (LOCKED)
- Stay ONLY on how they handle calls
- Do not drift

SPEECH (MANDATORY)
- Slow
- Short sentences
- Natural pauses

STYLE
- Human
- Conversational
- Slightly casual

CORE BEHAVIOR
- Ask one thing at a time
- React naturally before next question
- Never rush

REACTIONS
- "Got it..."
- "Yeah, that makes sense."
- "I hear that a lot."

GOAL
- Understand how they handle calls
- Lightly surface missed call problem
- Soft interest check (no pressure)
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

"I’ll be real quick — I was just curious how you’re handling calls over there right now."

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

After opening:

1.
"Got it..."

2.
"When calls come in, are you usually grabbing them live... or calling people back when you can?"

3.
"Yeah, that makes sense."

4.
"Do you ever have moments where calls come in and you’re tied up with something else?"

5.
If yes:
"Yeah — I hear that a lot."

6.
"That’s actually the kind of thing we help with."

7.
"Mainly just making sure those calls don’t slip through."

8.
"Would it be worth a quick look at some point?"

RULES
- One question at a time
- Always react before next question
- Keep it natural
- Do not sound scripted
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
