import express from "express";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.post("/voice", (req, res) => {
  res.type("text/xml");
  res.send(`
    <Response>
      <Say>Hello. Ringmate realtime test is connected.</Say>
    </Response>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
