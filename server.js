
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const LANGSEARCH_KEY = process.env.LANGSEARCH_API_KEY;

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

app.get("/", (req, res) => {
  res.send("MoroorgarBot is running!");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, bot: "MoroorgarBot" });
});

async function telegram(method, data) {
  const response = await axios.post(
    `${TELEGRAM_API}/${method}`,
    data,
    { timeout: 10000 }
  );
  return response.data;
}

async function searchWeb(query) {
  const response = await axios.post(
    "https://api.langsearch.com/v1/web-search",
    {
      query,
      count: 8,
      summary: true
    },
    {
      headers: {
        Authorization: `Bearer ${LANGSEARCH_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 8000
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

  if (!text) {
    return telegram("answerInlineQuery", {
      inline_query_id: query.id,
      cache_time: 1,
      results: [{
        type: "article",
        id: "start",
        title: "Search the web",
        description: "Type something after @Moroorgarbot",
        input_message_content: {
          message_text:
            "🔎 MoroorgarBot\n\nType a search term after @Moroorgarbot."
        }
      }]
    });
  }

  try {
    const pages = await searchWeb(text);

    const results = pages.slice(0, 8).map((page, index) => {
      const title = page.name || "Untitled page";
      const url = page.url || "";
      const description = page.snippet || page.text || "";

      return {
        type: "article",
        id: String(index + 1),
        title: title.slice(0, 200),
        description: description.slice(0, 180),
        url: url,
        input_message_content: {
          message_text:
            `🔎 ${title}\n\n${description.slice(0, 700)}\n\n${url}`,
          disable_web_page_preview: false
        }
      };
    });

    if (results.length === 0) {
      results.push({
        type: "article",
        id: "empty",
        title: "No results found",
        description: "Try another search term.",
        input_message_content: {
          message_text: "No search results found. Try another query."
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
        description: "Please try again in a moment.",
        input_message_content: {
          message_text:
            "Sorry, search is temporarily unavailable. Please try again."
        }
      }]
    });
  }
}

let offset = 0;
let running = true;

async function pollTelegram() {
  while (running) {
    try {
      const response = await telegram("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["inline_query"]
      });

      if (!response.ok) continue;

      for (const update of response.result) {
        offset = update.update_id + 1;

        if (update.inline_query) {
          answerInlineQuery(update.inline_query).catch(error => {
            console.error("Inline error:", error.message);
          });
        }
      }
    } catch (error) {
      console.error("Telegram polling error:", error.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MoroorgarBot server running on port ${PORT}`);

  if (!BOT_TOKEN || !LANGSEARCH_KEY) {
    console.error("Missing required environment variables!");
    return;
  }

  pollTelegram();
});

process.on("SIGTERM", () => {
  running = false;
  process.exit(0);
});
