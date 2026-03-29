import express from "express";

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("OpenAI Realtime webhook server running");
});

app.post("/openai-realtime-webhook", async (req, res) => {
  try {
    const event = req.body;
    console.log("Incoming webhook event:", JSON.stringify(event, null, 2));

    // OpenAI 쪽에는 먼저 빨리 200 응답
    res.status(200).send("ok");

    if (event?.type !== "realtime.call.incoming") {
      return;
    }

    const callId = event?.data?.call_id;
    if (!callId) {
      console.log("No call_id found");
      return;
    }

    const response = await fetch(
      `https://api.openai.com/v1/realtime/calls/${callId}/accept`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          type: "realtime",
          model: "gpt-realtime",
          instructions: `
You are Alex from Ringmate.
Speak naturally, warmly, and confidently.
Keep responses short and conversational.
Sound like a real human, not a robot.
Start with a brief greeting.
          `
        })
      }
    );

    const text = await response.text();
    console.log("ACCEPT STATUS:", response.status);
    console.log("ACCEPT BODY:", text);

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
