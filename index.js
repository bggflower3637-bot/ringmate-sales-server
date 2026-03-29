import express from "express";
import WebSocket from "ws";

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("OpenAI Realtime webhook server running");
});

app.post("/openai-realtime-webhook", async (req, res) => {
  try {
    const event = req.body;
    console.log("Incoming webhook event:", JSON.stringify(event, null, 2));

    // OpenAI webhook에는 먼저 바로 응답
    res.status(200).send("ok");

    if (event?.type !== "realtime.call.incoming") {
      return;
    }

    const callId = event?.data?.call_id;
    if (!callId) {
      console.log("No call_id found");
      return;
    }

    // 1) 전화 accept
    const acceptRes = await fetch(
      `https://api.openai.com/v1/realtime/calls/${callId}/accept`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          type: "realtime",
          model: "gpt-realtime",
          instructions: `
You are Alex from Ringmate.

ROLE:
- You are a natural outbound caller for Ringmate.
- You sound human, warm, calm, and confident.

IMPORTANT:
- Start speaking immediately when the call connects.
- Do NOT wait for the user to speak first.
- Keep sentences short.
- Ask one short question at a time.
- Do not sound robotic or scripted.
- Do not give long explanations.
- In the first few seconds, do not sound overly salesy.

STYLE:
- Natural
- Conversational
- Slightly warm
- Professional but casual

GOAL:
- Start the conversation smoothly.
- Find out whether they are handling calls manually.
- Keep the flow natural.
          `
        })
      }
    );

    const acceptText = await acceptRes.text();
    console.log("ACCEPT STATUS:", acceptRes.status);
    console.log("ACCEPT BODY:", acceptText);

    if (!acceptRes.ok) {
      console.log("Accept failed, stopping here.");
      return;
    }

    // 2) accept 후 websocket 연결
    const ws = new WebSocket(
      `wss://api.openai.com/v1/realtime?call_id=${callId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1"
        }
      }
    );

    ws.on("open", () => {
      console.log("Realtime websocket connected for call:", callId);

      // 3) 연결되자마자 첫 멘트 강제 생성
      ws.send(
        JSON.stringify({
          type: "response.create",
          response: {
            instructions: `
Start speaking immediately.
Do not wait for the user to speak first.

Say:
"Hey — this is Alex from Ringmate... quick question. Are you the one handling calls over there?"

After that:
- Pause briefly
- Let the user answer
- Continue naturally
            `
          }
        })
      );
    });

    ws.on("message", (data) => {
      console.log("Realtime event:", data.toString());
    });

    ws.on("error", (err) => {
      console.error("Realtime websocket error:", err);
    });

    ws.on("close", () => {
      console.log("Realtime websocket closed for call:", callId);
    });
  } catch (error) {
    console.error("Webhook error:", error);
    if (!res.headersSent) {
      res.status(500).send("error");
    }
  }
});

const port = process.env.PORT || 10000;
app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on port ${port}`);
});
