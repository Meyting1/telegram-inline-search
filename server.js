
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const LANGSEARCH_KEY = process.env.LANGSEARCH_API_KEY;
const PIXABAY_KEY = process.env.PIXABAY_API_KEY;
const PUBLIC_URL = process.env.PUBLIC_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const articles = new Map();
const imageCache = new Map();

const IMAGE_PAGE_SIZE = 30;
const VIDEO_PAGE_SIZE = 15;

app.get("/", (req, res) => {
  res.send("MoroorgarBot is running!");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/telegram-webhook", (req, res) => {
  if (
    !WEBHOOK_SECRET ||
    req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET
  ) {
    return res.sendStatus(403);
  }

  res.sendStatus(200);
  const update = req.body;

  if (update.message?.text) {
    const command = update.message.text.split(" ")[0].split("@")[0];

    if (command === "/start") {
      showWelcome(update.message.chat.id).catch(console.error);
    }
  }

  if (update.callback_query) {
    handleCallback(update.callback_query).catch(console.error);
  }

  if (update.inline_query) {
    answerInlineQuery(update.inline_query).catch(console.error);
  }
});

async function telegram(method, data) {
  const response = await axios.post(
    `${TELEGRAM_API}/${method}`,
    data,
    { timeout: 20000 }
  );
  return response.data;
}

async function showWelcome(chatId) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      "👋 سلام! به ربات مور و گر خوش اومدی.\n\n" +
      "با این ربات می‌تونی مستقیماً داخل تلگرام جستجو کنی.\n\n" +
      "لطفاً نوع جست‌وجوت رو انتخاب کن:",
    reply_markup: {
      inline_keyboard: [
        [{
          text: "🔎 جستجوی وب",
          switch_inline_query_current_chat: ""
        }],
        [{
          text: "🖼 جستجوی عکس‌ها",
          switch_inline_query_current_chat: "img "
        }],
        [{
          text: "🎬 جستجوی ویدئوها",
          switch_inline_query_current_chat: "vid "
        }]
      ]
    }
  });
}

// ---------------- WEB SEARCH ----------------

async function searchWeb(query) {
  const response = await axios.post(
    "https://api.langsearch.com/v1/web-search",
    { query, count: 8 },
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

// ---------------- IMAGE SEARCH ----------------

async function searchImages(query, page = 1) {
  const cacheKey = `${query.toLowerCase().trim()}:${page}`;
  const cached = imageCache.get(cacheKey);

  if (cached && Date.now() - cached.time < 23 * 60 * 60 * 1000) {
    return cached.data;
  }

  const response = await axios.get("https://pixabay.com/api/", {
    params: {
      key: PIXABAY_KEY,
      q: query.slice(0, 100),
      image_type: "photo",
      safesearch: false,
      order: "popular",
      per_page: IMAGE_PAGE_SIZE,
      page
    },
    timeout: 20000
  });

  const data = {
    hits: response.data.hits || [],
    totalHits: response.data.totalHits || 0
  };

  imageCache.set(cacheKey, {
    data,
    time: Date.now()
  });

  return data;
}

// ---------------- VIDEO SEARCH ----------------

// Translate Persian queries to English when possible.
async function translateVideoQuery(query) {
  try {
    const response = await axios.get(
      "https://api.mymemory.translated.net/get",
      {
        params: {
          q: query.slice(0, 400),
          langpair: "fa|en"
        },
        timeout: 15000
      }
    );

    const translated =
      response.data?.responseData?.translatedText?.trim();

    if (
      Number(response.data?.responseStatus) === 200 &&
      translated
    ) {
      return translated;
    }
  } catch (error) {
    console.error("Translation error:", error.message);
  }

  return query;
}

// Ordinary video source
async function searchPixabayVideos(query, page = 1) {
  const response = await axios.get(
    "https://pixabay.com/api/videos/",
    {
      params: {
        key: PIXABAY_KEY,
        q: query.slice(0, 100),
        lang: "en",
        video_type: "all",
        safesearch: false,
        order: "popular",
        per_page: VIDEO_PAGE_SIZE,
        page
      },
      timeout: 25000
    }
  );

  return {
    results: response.data.hits || [],
    count: Number(response.data.totalHits || 0)
  };
}

// Second video source
async function searchSecondVideoSource(query, page = 1) {
  const response = await axios.get(
    "https://adultembed.com/api/database/browse/",
    {
      params: {
        search: query.slice(0, 150),
        orientation: "all",
        sort: "popular",
        page,
        page_size: VIDEO_PAGE_SIZE
      },
      headers: {
        "X-Site-URL": PUBLIC_URL
      },
      timeout: 25000
    }
  );

  return {
    results: response.data.results || [],
    count: Number(response.data.count || 0)
  };
}

function parseVideoOffset(offset) {
  if (!offset) {
    return { firstPage: 1, secondPage: 1 };
  }

  const match = /^p(\d+)-a(\d+)$/.exec(offset);

  if (!match) {
    return { firstPage: 1, secondPage: 1 };
  }

  return {
    firstPage: Math.max(1, Number(match[1]) || 1),
    secondPage: Math.max(1, Number(match[2]) || 1)
  };
}

function interleaveVideos(first, second) {
  const combined = [];
  const max = Math.max(first.length, second.length);

  for (let i = 0; i < max; i++) {
    if (first[i]) combined.push(first[i]);
    if (second[i]) combined.push(second[i]);
  }

  return combined.slice(0, 50);
}

function formatFirstVideo(video) {
  const rendition =
    video.videos?.medium?.url
      ? video.videos.medium
      : video.videos?.small;

  if (!video.id || !rendition?.url) return null;

  const title = (video.tags || "Video").slice(0, 180);
  const duration = Number(video.duration || 0);
  const thumbnail =
    rendition.thumbnail ||
    video.videos?.tiny?.thumbnail ||
    "";

  const result = {
    type: "article",
    id: `px-${video.id}`,
    title: `🎬 ${title}`.slice(0, 200),
    description:
      `مدت: ${duration ? duration + " ثانیه" : "نامشخص"}`,
    input_message_content: {
      message_text:
        `🎬 ${title}\n\n` +
        `مدت ویدئو: ${duration || "نامشخص"} ثانیه`
    },
    reply_markup: {
      inline_keyboard: [[
        {
          text: "▶️ تماشای ویدئو",
          url: rendition.url
        },
        {
          text: "مشاهده منبع",
          url: video.pageURL
        }
      ]]
    }
  };

  if (/^https?:\/\//i.test(thumbnail)) {
    result.thumbnail_url = thumbnail;
    result.thumbnail_width = rendition.width || 320;
    result.thumbnail_height = rendition.height || 180;
  }

  return result;
}

function formatSecondVideo(video) {
  if (!video.id) return null;

  const playerUrl =
    `https://adultembed.com/player/embed/${video.id}/`;

  const title = (video.title || "Video").slice(0, 180);
  const thumbnail = video.thumbnail || "";

  const result = {
    type: "article",
    id: `ae-${video.id}`,
    title: `🎬 ${title}`.slice(0, 200),
    description: `مدت: ${video.duration || "نامشخص"}`,
    input_message_content: {
      message_text:
        `🎬 ${title}\n\n` +
        `مدت ویدئو: ${video.duration || "نامشخص"}`
    },
    reply_markup: {
      inline_keyboard: [[
        {
          text: "▶️ تماشای ویدئو",
          url: playerUrl
        }
      ]]
    }
  };

  if (/^https?:\/\//i.test(thumbnail)) {
    result.thumbnail_url = thumbnail;
    result.thumbnail_width = 320;
    result.thumbnail_height = 180;
  }

  return result;
}

async function fetchBothVideoSources(query, firstPage, secondPage) {
  const [firstResult, secondResult] = await Promise.allSettled([
    searchPixabayVideos(query, firstPage),
    searchSecondVideoSource(query, secondPage)
  ]);

  const firstData =
    firstResult.status === "fulfilled"
      ? firstResult.value
      : { results: [], count: 0 };

  const secondData =
    secondResult.status === "fulfilled"
      ? secondResult.value
      : { results: [], count: 0 };

  if (firstResult.status === "rejected") {
    console.error("First video source error:", firstResult.reason?.message);
  }

  if (secondResult.status === "rejected") {
    console.error("Second video source error:", secondResult.reason?.message);
  }

  return { firstData, secondData };
}

async function answerVideoInlineQuery(query, text) {
  const videoQuery = text.replace(/^vid\s*/i, "").trim();

  if (!videoQuery) {
    return telegram("answerInlineQuery", {
      inline_query_id: query.id,
      cache_time: 1,
      results: [{
        type: "article",
        id: "video-help",
        title: "🎬 جستجوی ویدئوها",
        description: "عبارت مورد نظرت رو وارد کن.",
        input_message_content: {
          message_text: "🎬 عبارت مورد نظرت رو برای جستجوی ویدئو وارد کن."
        }
      }]
    });
  }

  const { firstPage, secondPage } =
    parseVideoOffset(query.offset);

  const searchTerm = await translateVideoQuery(videoQuery);

  let data = await fetchBothVideoSources(
    searchTerm,
    firstPage,
    secondPage
  );

  // If translated search returns nothing, try the original query.
  if (
    data.firstData.results.length === 0 &&
    data.secondData.results.length === 0 &&
    searchTerm.toLowerCase() !== videoQuery.toLowerCase()
  ) {
    data = await fetchBothVideoSources(
      videoQuery,
      firstPage,
      secondPage
    );
  }

  const firstResults = data.firstData.results
    .map(formatFirstVideo)
    .filter(Boolean);

  const secondResults = data.secondData.results
    .map(formatSecondVideo)
    .filter(Boolean);

  const results = interleaveVideos(
    firstResults,
    secondResults
  );

  if (results.length === 0) {
    results.push({
      type: "article",
      id: "no-videos",
      title: "ویدئویی پیدا نشد",
      description: "عبارت دیگری رو امتحان کن.",
      input_message_content: {
        message_text: "برای این عبارت ویدئویی پیدا نشد."
      }
    });
  }

  const hasMoreFirst =
    data.firstData.count > firstPage * VIDEO_PAGE_SIZE;

  const hasMoreSecond =
    data.secondData.count > secondPage * VIDEO_PAGE_SIZE;

  const answer = {
    inline_query_id: query.id,
    results,
    cache_time: 10,
    is_personal: true
  };

  if (hasMoreFirst || hasMoreSecond) {
    answer.next_offset =
      `p${hasMoreFirst ? firstPage + 1 : firstPage}` +
      `-a${hasMoreSecond ? secondPage + 1 : secondPage}`;
  }

  return telegram("answerInlineQuery", answer);
}

// ---------------- ARTICLE READER ----------------

function saveArticle(url, title, summary) {
  const id = crypto.randomBytes(6).toString("hex");

  articles.set(id, {
    url,
    title,
    summary,
    pages: null
  });

  while (articles.size > 500) {
    articles.delete(articles.keys().next().value);
  }

  return id;
}

async function extractArticle(url) {
  const parsed = new URL(url);

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Unsupported URL");
  }

  const response = await axios.get(url, {
    timeout: 20000,
    maxContentLength: 5 * 1024 * 1024,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; MoroorgarBot/1.0)"
    }
  });

  const $ = cheerio.load(response.data);

  $(
    "script, style, nav, footer, header, aside, iframe, form, noscript, svg"
  ).remove();

  const title =
    $("meta[property='og:title']").attr("content") ||
    $("h1").first().text().trim() ||
    $("title").text().trim() ||
    "Article";

  let container = $("article").first();

  if (!container.length) container = $("main").first();
  if (!container.length) container = $("body");

  const paragraphs = [];

  container.find("h1, h2, h3, p, li, blockquote").each((i, el) => {
    const value = $(el).text().replace(/\s+/g, " ").trim();

    if (value.length > 25 && !paragraphs.includes(value)) {
      paragraphs.push(value);
    }
  });

  let content = paragraphs.join("\n\n");

  if (content.length < 100) {
    content = container.text().replace(/\s+/g, " ").trim();
  }

  if (!content || content.length < 50) {
    throw new Error("Could not extract article text");
  }

  return {
    title: title.slice(0, 250),
    content: content.slice(0, 50000)
  };
}

function splitIntoPages(text, maxLength = 3200) {
  const pages = [];
  let remaining = text.trim();

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      pages.push(remaining);
      break;
    }

    let cut = remaining.lastIndexOf(" ", maxLength);

    if (cut < maxLength * 0.6) {
      cut = maxLength;
    }

    pages.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  return pages;
}

function articlePageText(article, pageIndex) {
  const hostname = new URL(article.url).hostname;
  const total = article.pages.length;

  return (
    `📖 ${article.title}\n\n` +
    `${article.pages[pageIndex]}\n\n` +
    "──────────────\n" +
    `صفحه ${pageIndex + 1} از ${total}\n` +
    `منبع: ${hostname}`
  );
}

function articleKeyboard(id, pageIndex, total) {
  const buttons = [];

  if (pageIndex > 0) {
    buttons.push({
      text: "⬅️ قبلی",
      callback_data: `p:${id}:${pageIndex - 1}`
    });
  }

  if (pageIndex < total - 1) {
    buttons.push({
      text: "بعدی ➡️",
      callback_data: `p:${id}:${pageIndex + 1}`
    });
  }

  return buttons.length
    ? { inline_keyboard: [buttons] }
    : { inline_keyboard: [] };
}

async function handleCallback(query) {
  const data = query.data || "";

  try {
    if (data.startsWith("r:")) {
      const id = data.slice(2);
      const article = articles.get(id);

      if (!article) {
        return telegram("answerCallbackQuery", {
          callback_query_id: query.id,
          text: "این نتیجه منقضی شده است. دوباره جستجو کن."
        });
      }

      await telegram("answerCallbackQuery", {
        callback_query_id: query.id,
        text: "در حال دریافت متن مطلب..."
      });

      const extracted = await extractArticle(article.url);

      article.title = extracted.title || article.title;
      article.pages = splitIntoPages(extracted.content);

      await telegram("editMessageText", {
        inline_message_id: query.inline_message_id,
        text: articlePageText(article, 0),
        reply_markup: articleKeyboard(id, 0, article.pages.length),
        link_preview_options: { is_disabled: true }
      });

      return;
    }

    if (data.startsWith("p:")) {
      const parts = data.split(":");
      const id = parts[1];
      const pageIndex = Number(parts[2]);
      const article = articles.get(id);

      if (
        !article ||
        !article.pages ||
        !Number.isInteger(pageIndex) ||
        pageIndex < 0 ||
        pageIndex >= article.pages.length
      ) {
        return telegram("answerCallbackQuery", {
          callback_query_id: query.id,
          text: "این صفحه دیگر در دسترس نیست."
        });
      }

      await telegram("answerCallbackQuery", {
        callback_query_id: query.id
      });

      await telegram("editMessageText", {
        inline_message_id: query.inline_message_id,
        text: articlePageText(article, pageIndex),
        reply_markup: articleKeyboard(id, pageIndex, article.pages.length),
        link_preview_options: { is_disabled: true }
      });
    }
  } catch (error) {
    console.error("Article error:", error.response?.data || error.message);

    try {
      await telegram("answerCallbackQuery", {
        callback_query_id: query.id,
        text: "دریافت مطلب ناموفق بود. دوباره تلاش کن.",
        show_alert: true
      });
    } catch (e) {
      console.error(e.message);
    }
  }
}

// ---------------- INLINE SEARCH ROUTER ----------------

async function answerInlineQuery(query) {
  const text = query.query.trim();

  try {
    // IMAGE SEARCH
    if (/^img(?:\s|$)/i.test(text)) {
      const imageQuery = text.replace(/^img\s*/i, "").trim();

      if (!imageQuery) {
        return telegram("answerInlineQuery", {
          inline_query_id: query.id,
          cache_time: 1,
          results: [{
            type: "article",
            id: "image-help",
            title: "🖼 جستجوی عکس‌ها",
            description: "عبارت مورد نظرت رو بعد از img وارد کن.",
            input_message_content: {
              message_text: "عبارت مورد نظرت رو بعد از img وارد کن."
            }
          }]
        });
      }

      const page = Math.max(
        1,
        Math.min(100, Number(query.offset) || 1)
      );

      const imageData = await searchImages(imageQuery, page);

      const results = imageData.hits
        .filter(hit => hit.webformatURL && hit.previewURL)
        .slice(0, IMAGE_PAGE_SIZE)
        .map(hit => ({
          type: "photo",
          id: String(hit.id),
          photo_url: hit.webformatURL,
          thumb_url: hit.previewURL,
          photo_width: hit.webformatWidth || 640,
          photo_height: hit.webformatHeight || 480,
          title: (hit.tags || imageQuery).slice(0, 200),
          description: `تصویر از ${hit.user || "Pixabay"}`,
          caption:
            `🖼 ${hit.tags || imageQuery}\n` +
            `👤 عکاس: ${hit.user || "Pixabay"}\n` +
            "📷 منبع: Pixabay",
          reply_markup: {
            inline_keyboard: [[
              {
                text: "مشاهده در Pixabay",
                url: hit.pageURL
              }
            ]]
          }
        }));

      if (results.length === 0) {
        results.push({
          type: "article",
          id: "no-images",
          title: "عکسی پیدا نشد",
          description: "عبارت دیگری رو امتحان کن.",
          input_message_content: {
            message_text: "برای این عبارت عکسی پیدا نشد."
          }
        });
      }

      const answer = {
        inline_query_id: query.id,
        results,
        cache_time: 10,
        is_personal: true
      };

      if (imageData.totalHits > page * IMAGE_PAGE_SIZE) {
        answer.next_offset = String(page + 1);
      }

      return telegram("answerInlineQuery", answer);
    }

    // VIDEO SEARCH
    if (/^vid(?:\s|$)/i.test(text)) {
      return answerVideoInlineQuery(query, text);
    }

    // WEB SEARCH
    if (!text) {
      return telegram("answerInlineQuery", {
        inline_query_id: query.id,
        cache_time: 1,
        results: [{
          type: "article",
          id: "start",
          title: "جستجوی وب",
          description: "عبارت مورد نظرت رو وارد کن.",
          input_message_content: {
            message_text: "🔎 عبارت مورد نظرت رو برای جستجوی وب وارد کن."
          }
        }]
      });
    }

    const pages = await searchWeb(text);

    const results = pages.slice(0, 8).map((page, index) => {
      const title = page.name || "Untitled page";
      const url = page.url || "";
      const description = (
        page.snippet || page.text || "No description available."
      ).trim();

      if (!/^https?:\/\//i.test(url)) return null;

      const id = saveArticle(url, title, description);

      return {
        type: "article",
        id: String(index + 1),
        title: title.slice(0, 200),
        description: description.slice(0, 180),
        input_message_content: {
          message_text:
            `🔎 ${title}\n\n${description.slice(0, 650)}`
        },
        reply_markup: {
          inline_keyboard: [[
            {
              text: "📖 مطالعه کامل مطلب",
              callback_data: `r:${id}`
            }
          ]]
        }
      };
    }).filter(Boolean);

    if (results.length === 0) {
      results.push({
        type: "article",
        id: "empty",
        title: "نتیجه‌ای پیدا نشد",
        description: "عبارت دیگری رو امتحان کن.",
        input_message_content: {
          message_text: "نتیجه‌ای پیدا نشد. دوباره جستجو کن."
        }
      });
    }

    await telegram("answerInlineQuery", {
      inline_query_id: query.id,
      results,
      cache_time: 10,
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
        title: "جستجو موقتاً در دسترس نیست",
        description: "لطفاً کمی بعد دوباره تلاش کن.",
        input_message_content: {
          message_text: "جستجو موقتاً در دسترس نیست."
        }
      }]
    });
  }
}

// ---------------- START SERVER ----------------

async function startBot() {
  if (
    !BOT_TOKEN ||
    !LANGSEARCH_KEY ||
    !PIXABAY_KEY ||
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
    allowed_updates: [
      "message",
      "inline_query",
      "callback_query"
    ],
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
