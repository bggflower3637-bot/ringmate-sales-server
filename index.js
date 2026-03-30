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
      openerSent: false
    });

    // ✅ CALL ACCEPT (핵심 유지)
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
You are a calm, mature business caller.

MISSION (FIXED)
You are calling about how they handle incoming calls.
You must find out:
- who handles calls
- how calls are handled
- whether missed calls are a problem

Never lose this context.

SPEED (MANDATORY)
- Speak slowly
- Never rush
- Pause after each sentence
- Use short sentences
- One idea per sentence

STYLE
- Calm
- Grounded
- Natural
- Human
- Not salesy
- Not pushy

CONVERSATION CONTROL
- Do not drift into random topics
- Do not become a general assistant
- Move into the purpose within 2–3 turns
- Stay focused on calls

FLOW (STRICT ORDER)

1. Greeting
2. Permission
3. Who handles calls
4. How calls are handled
5. Missed calls / pain
6. Light connection to Ringmate
7. Interest check
8. Exit or follow-up

RECOVERY
If conversation drifts → bring back to:
"how you handle incoming calls"
          `
        })
      }
    );

    if (!acceptRes.ok) {
      activeCalls.delete(callId);
      return;
    }

    // ✅ WebSocket 연결
    const ws = new WebSocket(
      `wss://api.openai.com/v1/realtime?call_id=${callId}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1"
        }
      }
    );

    let sessionReady = false;

    ws.on("open", () => {
      console.log("Realtime connected:", callId);

      // ✅ 대화 흐름 고정
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            model: "gpt-realtime",
            instructions: `
You are Alex from Ringmate.

MISSION
Stay focused on how they handle incoming calls.

SPEED (HARD RULE)
- Speak slowly
- Never rush
- Pause after each sentence
- Keep sentences short

CONTEXT LOCK
- Never leave the call-handling topic
- No random conversation
- No broad business talk

CONVERSATION FLOW

After greeting:

Step 1:
"Are you the one handling calls there?"

Step 2:
"How are you guys handling those right now?"

Step 3:
"Do you ever miss calls… or get them after hours?"

Step 4:
If problem exists:
"Yeah… that’s actually what we help with."

Step 5:
"Is that something you'd be open to taking a look at… at some point?"

RULES
- One question at a time
- Short responses
- Brief acknowledgment only
- Keep moving forward
            `
          }
        })
      );
    });

    const sendOpening = () => {
      const state = activeCalls.get(callId);
      if (!state || state.openerSent || !sessionReady) return;

      state.openerSent = true;

      ws.send(
        JSON.stringify({
          type: "response.create",
          response: {
            instructions: `
Start speaking now.

Speak slowly.
Pause after each sentence.

Say:

"Hi, this is Alex with Ringmate."

Pause.

"Hope you're doing well."

Pause.

"I'll be quick… I just had a quick question about how you're handling your incoming calls."

Pause.

"Is now a bad time?"

Then wait.
            `
          }
        })
      );
    };

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (
          msg.type === "session.created" ||
          msg.type === "session.updated"
        ) {
          sessionReady = true;
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
      if (activeCalls.has(callId)) {
        try {
          activeCalls.get(callId)?.ws?.close();
        } catch {}
        activeCalls.delete(callId);
      }
    }, 10 * 60 * 1000);

  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).send("error");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});
