
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const LANGSEARCH_KEY = process.env.LANGSEARCH_API_KEY;
const PUBLIC_URL = process.env.PUBLIC_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

app.get("/", (req, res) => {
  res.send("MoroorgarBot is running!");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, bot: "MoroorgarBot" });
});

app.post("/telegram-webhook", async (req, res) => {
  if (
    req.headers["x-telegram-bot-api-secret-token"] !==
    WEBHOOK_SECRET
  ) {
    return res.sendStatus(403);
  }

  res.sendStatus(200);

  const update = req.body;

  if (update.inline_query) {
    answerInlineQuery(update.inline_query).catch(err => {
      console.error("Inline error:", err.response?.data || err.message);
    });
  }
});

async function telegram(method, data) {
  const response = await axios.post(
    `${TELEGRAM_API}/${method}`,
    data,
    { timeout: 15000 }
  );

  return response.data;
}

async function searchWeb(query) {
  const response = await axios.post(
    "https://api.langsearch.com/v1/web-search",
    {
      query,
      count: 8
    },
    {
      headers: {
        Authorization: `Bearer ${LANGSEARCH_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 25000
    }
  );

  const payload = response.data;

  if (String(payload.code) !== "200") {
    throw new Error(payload.message || "Search API error");
  }

  return payload.data?.webPages?.value || [];
}

async function answerInlineQuery(query) {
  const text = query.query.trim();

  try {
    if (!text) {
      return telegram("answerInlineQuery", {
        inline_query_id: query.id,
        cache_time: 1,
        results: [{
          type: "article",
          id: "start",
          title: "Search the web",
          description: "Type something to find websites.",
          input_message_content: {
            message_text:
              "🔎 MoroorgarBot\nSearch the web by typing a query."
          }
        }]
      });
    }

    console.log("Searching:", text);

    const pages = await searchWeb(text);

    console.log("Search results:", pages.length);

    const results = pages.slice(0, 8).map((page, index) => {
      const title = page.name || "Untitled page";
      const url = page.url || "";
      const description = page.snippet || page.text || "";

      return {
        type: "article",
        id: String(index + 1),
        title: title.slice(0, 200),
        description: description.slice(0, 180),
        input_message_content: {
          message_text:
            `🔎 ${title}\n\n${description.slice(0, 700)}\n\n${url}`
        }
      };
    });

    if (results.length === 0) {
      results.push({
        type: "article",
        id: "empty",
        title: "No results found",
        description: "Try another search.",
        input_message_content: {
          message_text: "No results found. Try another search."
        }
      });
    }

    await telegram("answerInlineQuery", {
      inline_query_id: query.id,
      results,
      cache_time: 30,
      is_personal: true
    });

  } catch (error) {
    console.error(
      "Search error:",
      error.response?.data || error.message
    );

    await telegram("answerInlineQuery", {
      inline_query_id: query.id,
      cache_time: 1,
      results: [{
        type: "article",
        id: "error",
        title: "Search temporarily unavailable",
        description: "Please try again later.",
        input_message_content: {
          message_text: "Search is temporarily unavailable."
        }
      }]
    });
  }
}

async function startBot() {
  if (
    !BOT_TOKEN ||
    !LANGSEARCH_KEY ||
    !PUBLIC_URL ||
    !WEBHOOK_SECRET
  ) {
    console.error("Missing environment variables!");
    process.exit(1);
  }

  const webhookUrl =
    `${PUBLIC_URL.replace(/\/$/, "")}/telegram-webhook`;

  console.log("Setting webhook:", webhookUrl);

  const result = await telegram("setWebhook", {
    url: webhookUrl,
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ["inline_query"],
    drop_pending_updates: true
  });

  if (!result.ok) {
    throw new Error(JSON.stringify(result));
  }

  console.log("Telegram webhook successfully configured.");
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MoroorgarBot running on port ${PORT}`);

  startBot().catch(error => {
    console.error(
      "Startup error:",
      error.response?.data || error.message
    );
  });
});
