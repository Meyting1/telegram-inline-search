
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
const chatModes = new Map();
const chatImagePages = new Map();
const chatWebPages = new Map();
const chatVideoPages = new Map();
const aiModelByChat = new Map();
const aiConversations = new Map();

const AI_MODELS = {
  fast: {
    label: "⚡ سریع - GPT OSS 20B",
    id: "openai/gpt-oss-20b"
  },
  balanced: {
    label: "🧠 متعادل - Qwen 3.8 27B",
    id: "qwen/qwen3.8-27b"
  },
  advanced: {
    label: "🚀 پیشرفته - GPT OSS 120B",
    id: "openai/gpt-oss-120b"
  }
};

const IMAGE_PAGE_SIZE = 30;
const VIDEO_PAGE_SIZE = 15;
const CHAT_VIDEO_PAGE_SIZE = 6;
const CHAT_WEB_PAGE_SIZE = 8;

app.get("/", (req, res) => {
  res.send("MorvarBot is running!");
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
    processChatMessage(update.message).catch(console.error);
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
  chatModes.delete(chatId);
  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      "👋 سلام! به ربات مرورگر خوش اومدی.\n\n" +
      "از منوی پایین نوع جست‌وجو رو انتخاب کن؛ بعد عبارتت رو بنویس تا نتایج همین‌جا نمایش داده بشن.",
    reply_markup: {
      keyboard: [
        [{ text: "🔎 جستجوی وب" }, { text: "🖼 جستجوی عکس‌ها" }],
        [{ text: "🎬 جستجوی ویدئوها" }],
        [{ text: "🤖 چت با هوش مصنوعی" }]
      ],
      resize_keyboard: true,
      is_persistent: true,
      input_field_placeholder: "اول نوع جست‌وجو رو انتخاب کن"
    }
  });
}

async function selectChatMode(chatId, mode) {
  chatModes.set(chatId, mode);
  const prompts = {
    web: "🔎 عبارت جست‌وجوی وب رو بنویس:",
    image: "🖼 عبارت جست‌وجوی عکس رو بنویس:",
    video: "🎬 عبارت جست‌وجوی ویدئو رو بنویس:"
  };
  await telegram("sendMessage", {
    chat_id: chatId,
    text: prompts[mode],
    reply_markup: {
      keyboard: [
        [{ text: "🔎 جستجوی وب" }, { text: "🖼 جستجوی عکس‌ها" }],
        [{ text: "🎬 جستجوی ویدئوها" }],
        [{ text: "🤖 چت با هوش مصنوعی" }]
      ],
      resize_keyboard: true,
      is_persistent: true
    }
  });
}

async function showAiMenu(chatId) {
  chatModes.set(chatId, "ai_select");
  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      "🤖 یکی از مدل‌های هوش مصنوعی رو انتخاب کن:\n\n" +
      "⚡ سریع: مناسب سؤال‌های روزمره\n" +
      "🧠 متعادل: مناسب ترجمه، نوشتن و تحلیل معمولی\n" +
      "🚀 پیشرفته: مناسب سؤال‌های پیچیده‌تر",
    reply_markup: {
      keyboard: [
        [{ text: AI_MODELS.fast.label }],
        [{ text: AI_MODELS.balanced.label }],
        [{ text: AI_MODELS.advanced.label }],
        [{ text: "🔙 منوی اصلی" }]
      ],
      resize_keyboard: true,
      is_persistent: true
    }
  });
}

async function selectAiModel(chatId, modelKey) {
  const selected = AI_MODELS[modelKey];
  if (!selected) return showAiMenu(chatId);

  aiModelByChat.set(chatId, selected.id);
  return showAiModeMenu(chatId);
}

async function showAiModeMenu(chatId) {
  chatModes.set(chatId, "ai_mode_select");
  const selectedModel = Object.values(AI_MODELS).find(
    model => model.id === aiModelByChat.get(chatId)
  );
  await telegram("sendMessage", {
    chat_id: chatId,
    text:
      "✅ مدل انتخاب‌شده: " + (selectedModel?.label || "هوش مصنوعی") + "\n\n" +
      "حالا مشخص کن چه کاری می‌خوای انجام بدی:",
    reply_markup: {
      keyboard: [
        [{ text: "💬 چت متنی" }],
        [{ text: "🖼 ساخت تصویر" }, { text: "🎬 ساخت ویدیو" }],
        [{ text: "🔄 تغییر مدل" }, { text: "🔙 منوی اصلی" }]
      ],
      resize_keyboard: true,
      is_persistent: true
    }
  });
}

async function generateImageForChat(chatId, requestText) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !apiToken) {
    return telegram("sendMessage", {
      chat_id: chatId,
      text: "اتصال سرویس ساخت تصویر هنوز تنظیم نشده است."
    });
  }

  const prefix = /^(?:\/(?:draw|image)(?:@\w+)?\s*|(?:تصویر|عکس|نقاشی)\s*(?:بساز|تولید\s*کن|ایجاد\s*کن|بکش)\s*[:：-]?\s*|(?:generate|create|draw)\s+(?:an?\s+)?(?:image|picture|photo)\s*[:：-]?\s*)/i;
  const rawPrompt = String(requestText || "").replace(prefix, "").trim();

  if (!rawPrompt) {
    return telegram("sendMessage", {
      chat_id: chatId,
      text: "توضیح تصویر رو هم بنویس؛ مثلاً: تصویر بساز: یک ماشین فضایی در شهر آینده"
    });
  }

  let statusMessageId = null;
  try {
    const status = await telegram("sendMessage", {
      chat_id: chatId,
      text: "⏳ درخواستت دریافت شد؛ دارم تصویرت رو می‌سازم. لطفاً کمی صبر کن..."
    });
    statusMessageId = status.result?.message_id || null;
  } catch (statusError) {
    console.error("Could not send image-generation status:", statusError.message);
  }

  await telegram("sendChatAction", {
    chat_id: chatId,
    action: "upload_photo"
  });

  try {
    let prompt = rawPrompt;
    if (/[\u0600-\u06FF]/.test(rawPrompt)) {
      const translated = await translateSearchQuery(rawPrompt.slice(0, 400));
      if (translated) prompt = translated;
    }

    const endpoint =
      "https://api.cloudflare.com/client/v4/accounts/" +
      accountId +
      "/ai/run/@cf/black-forest-labs/flux-1-schnell";
    const result = await axios.post(
      endpoint,
      { prompt: prompt.slice(0, 2048), steps: 4 },
      {
        headers: {
          Authorization: "Bearer " + apiToken,
          "Content-Type": "application/json"
        },
        timeout: 120000
      }
    );

    const imageBase64 = result.data?.result?.image;
    if (!imageBase64) {
      throw new Error(
        result.data?.errors?.[0]?.message || "Cloudflare returned no image data"
      );
    }

    const imageBuffer = Buffer.from(imageBase64, "base64");
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("caption", "🎨 تصویر ساخته‌شده با هوش مصنوعی مرورگر");
    form.append(
      "photo",
      new Blob([imageBuffer], { type: "image/jpeg" }),
      "morvarbot-image.jpg"
    );

    await axios.post(TELEGRAM_API + "/sendPhoto", form, {
      timeout: 60000
    });
    if (statusMessageId) {
      try {
        await telegram("deleteMessage", {
          chat_id: chatId,
          message_id: statusMessageId
        });
      } catch (deleteError) {
        console.error("Could not delete image status message:", deleteError.message);
      }
    }
    console.log("Image generated and sent with Cloudflare Workers AI.");
  } catch (error) {
    if (statusMessageId) {
      try {
        await telegram("deleteMessage", {
          chat_id: chatId,
          message_id: statusMessageId
        });
      } catch (deleteError) {
        console.error("Could not delete image status message:", deleteError.message);
      }
    }
    const status = error.response?.status;
    console.error(
      "Cloudflare image generation error:",
      error.response?.data || error.message
    );

    let message =
      "ساخت تصویر ناموفق بود. لطفاً دوباره با توضیح کوتاه‌تری امتحان کن.";
    if (status === 401 || status === 403) {
      message = "دسترسی Cloudflare تأیید نشد؛ کلید API و مجوز Workers AI باید بررسی شود.";
    } else if (status === 429) {
      message = "سهمیه رایگان روزانه ساخت تصویر فعلاً تمام شده؛ بعد از صفر شدن سهمیه دوباره امتحان کن.";
    }

    return telegram("sendMessage", {
      chat_id: chatId,
      text: message
    });
  }
}

async function handleAiMessage(chatId, userId, userText) {
  const groqKey = process.env.GROQ_API_KEY;
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!groqKey && !openRouterKey && !geminiKey) {
    return telegram("sendMessage", {
      chat_id: chatId,
      text: "اتصال هوش مصنوعی هنوز کامل تنظیم نشده. لطفاً بعداً دوباره امتحان کن."
    });
  }

  const model = aiModelByChat.get(chatId) || AI_MODELS.fast.id;
  const history = aiConversations.get(chatId) || [];
  const nextHistory = [...history, { role: "user", content: userText }].slice(-10);
  const messages = [
    {
      role: "system",
      content:
        "You are the AI assistant inside the Persian Telegram bot named «مرورگر» (MorvarBot). Your name is مرورگر. Never claim to be ChatGPT, OpenAI, Groq, or another provider/model. If asked who you are, say you are the AI assistant of مرورگر. Reply in the user's language, especially Persian when they write Persian. Be accurate, friendly, and concise. If unsure, say so."
    },
    ...nextHistory
  ];

  const providers = [];
  if (groqKey) {
    providers.push({
      name: "Groq",
      url: "https://api.groq.com/openai/v1/chat/completions",
      key: groqKey,
      body: {
        model,
        messages,
        max_completion_tokens: 900,
        temperature: 0.7
      },
      headers: {}
    });
  }
  if (openRouterKey) {
    providers.push({
      name: "OpenRouter",
      url: "https://openrouter.ai/api/v1/chat/completions",
      key: openRouterKey,
      body: {
        model: "openrouter/free",
        messages,
        max_tokens: 900
      },
      headers: {
        "HTTP-Referer": "https://moroorgarbot.onrender.com",
        "X-Title": "MorvarBot"
      }
    });
  }
  if (geminiKey) {
    providers.push({
      name: "Gemini",
      url:
        "https://generativelanguage.googleapis.com/v1beta/models/" +
        "gemini-3.1-flash-lite:generateContent?key=" +
        encodeURIComponent(geminiKey),
      key: null,
      body: {
        systemInstruction: {
          parts: [{ text: messages[0].content }]
        },
        contents: nextHistory.map(item => ({
          role: item.role === "assistant" ? "model" : "user",
          parts: [{ text: item.content }]
        })),
        generationConfig: {
          maxOutputTokens: 900,
          temperature: 0.7
        }
      },
      headers: {},
      type: "gemini"
    });
  }

  let answer = "";
  let lastError = null;

  for (const provider of providers) {
    try {
      const response = await axios.post(
        provider.url,
        provider.body,
        {
          headers: {
            ...(provider.key ? { Authorization: "Bearer " + provider.key } : {}),
            "Content-Type": "application/json",
            ...provider.headers
          },
          timeout: 60000
        }
      );

      if (provider.type === "gemini") {
        answer = response.data?.candidates?.[0]?.content?.parts
          ?.map(part => part.text || "")
          .join("")
          .trim();
      } else {
        answer = response.data?.choices?.[0]?.message?.content?.trim();
      }
      if (!answer) {
        const blockReason = response.data?.promptFeedback?.blockReason;
        throw new Error(blockReason ? "Gemini blocked prompt: " + blockReason : "Empty AI response");
      }
      console.log("AI response served by:", provider.name);
      break;
    } catch (error) {
      lastError = error;
      console.error(
        provider.name + " AI error:",
        error.response?.data || error.message
      );
    }
  }

  if (!answer) {
    const status = lastError?.response?.status;
    let errorText = "فعلاً سرویس‌های هوش مصنوعی پاسخگو نیستند. کمی بعد دوباره امتحان کن.";
    if (status === 401 || status === 403) {
      errorText = "یکی از کلیدهای اتصال هوش مصنوعی معتبر نیست یا دسترسی آن تأیید نشده. تنظیمات سرویس‌ها باید بررسی شود.";
    } else if (status === 429) {
      errorText = "محدودیت درخواست سرویس‌های رایگان فعلاً پر شده. کمی بعد دوباره امتحان کن.";
    }
    return telegram("sendMessage", {
      chat_id: chatId,
      text: errorText
    });
  }

  aiConversations.set(chatId, [
    ...nextHistory,
    { role: "assistant", content: answer }
  ].slice(-10));

  const chunks = answer.match(/[\s\S]{1,3800}/g) || [answer];
  for (const chunk of chunks) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: chunk
    });
  }
}

async function processChatMessage(message) {
  const chatId = message.chat.id;
  const text = (message.text || "").trim();
  const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();

  if (command === "/start") return showWelcome(chatId);
  if (command === "/web") return selectChatMode(chatId, "web");
  if (command === "/img") return selectChatMode(chatId, "image");
  if (command === "/vid") return selectChatMode(chatId, "video");
  if (command === "/ai") return showAiMenu(chatId);
  if (command === "/draw" || command === "/image") {
    return generateImageForChat(chatId, text.replace(/^\/(?:draw|image)(?:@\w+)?\s*/i, ""));
  }

  if (text === "🤖 چت با هوش مصنوعی") return showAiMenu(chatId);
  if (text === "🔙 منوی اصلی") return showWelcome(chatId);
  if (text === "🔄 تغییر مدل") return showAiMenu(chatId);
  if (text === "💬 چت متنی") {
    chatModes.set(chatId, "ai");
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "💬 حالت چت متنی فعاله. سؤالت رو بفرست.",
      reply_markup: {
        keyboard: [
          [{ text: "🔄 تغییر مدل" }, { text: "🆕 گفتگوی جدید" }],
          [{ text: "🔙 منوی اصلی" }]
        ],
        resize_keyboard: true,
        is_persistent: true,
        input_field_placeholder: "پیامت رو برای هوش مصنوعی بنویس..."
      }
    });
    return;
  }
  if (text === "🖼 ساخت تصویر") {
    chatModes.set(chatId, "ai_image");
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "🖼 حالت ساخت تصویر فعاله. توضیح تصویرت رو بفرست؛ مثلاً: یک شهر آینده‌نگر در شب، با نورهای نئونی.",
      reply_markup: {
        keyboard: [
          [{ text: "🔄 تغییر مدل" }, { text: "🔙 منوی اصلی" }]
        ],
        resize_keyboard: true,
        is_persistent: true,
        input_field_placeholder: "توضیح تصویر رو بنویس..."
      }
    });
    return;
  }
  if (text === "🎬 ساخت ویدیو") {
    chatModes.set(chatId, "ai_mode_select");
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "🎬 قابلیت ساخت ویدیو هنوز فعال نشده. به‌محض انتخاب سرویس مناسب، این بخش رو اضافه می‌کنیم."
    });
    return;
  }
  if (text === "🆕 گفتگوی جدید") {
    aiConversations.delete(chatId);
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "گفتگوی جدید شروع شد. سؤالت رو بفرست."
    });
    return;
  }
  if (text === AI_MODELS.fast.label) return selectAiModel(chatId, "fast");
  if (text === AI_MODELS.balanced.label) return selectAiModel(chatId, "balanced");
  if (text === AI_MODELS.advanced.label) return selectAiModel(chatId, "advanced");

  if (text === "🔎 جستجوی وب") return selectChatMode(chatId, "web");
  if (text === "🖼 جستجوی عکس‌ها") return selectChatMode(chatId, "image");
  if (text === "🎬 جستجوی ویدئوها") return selectChatMode(chatId, "video");

  const mode = chatModes.get(chatId);
  if (mode === "ai_select") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "لطفاً اول یکی از سه مدل نمایش‌داده‌شده رو انتخاب کن."
    });
    return;
  }
  if (mode === "ai_mode_select") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "لطفاً یکی از گزینه‌های چت متنی، ساخت تصویر یا ساخت ویدیو رو از منوی پایین انتخاب کن."
    });
    return;
  }
  if (mode === "ai_image") {
    if (!text || text.startsWith("/")) {
      await telegram("sendMessage", {
        chat_id: chatId,
        text: "لطفاً توضیح تصویر رو به صورت متن بفرست."
      });
      return;
    }
    return generateImageForChat(chatId, text);
  }
  if (mode === "ai") {
    if (!text || text.startsWith("/")) {
      await telegram("sendMessage", {
        chat_id: chatId,
        text: "لطفاً پیام متنی‌ات رو برای هوش مصنوعی بفرست."
      });
      return;
    }
    if (/^(?:(?:تصویر|عکس|نقاشی)\s*(?:بساز|تولید\s*کن|ایجاد\s*کن|بکش)(?=$|[\s:：-])|(?:generate|create|draw)\s+(?:an?\s+)?(?:image|picture|photo)(?=$|[\s:：-]))/i.test(text)) {
      return generateImageForChat(chatId, text);
    }
    await telegram("sendChatAction", {
      chat_id: chatId,
      action: "typing"
    });
    return handleAiMessage(chatId, message.from?.id || chatId, text);
  }
  if (!mode) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "برای شروع، یکی از گزینه‌های منوی پایین رو انتخاب کن."
    });
    return;
  }

  if (!text || text.startsWith("/")) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "لطفاً عبارت جست‌وجو رو به صورت متن بفرست."
    });
    return;
  }

  await telegram("sendChatAction", {
    chat_id: chatId,
    action: mode === "image" ? "upload_photo" : "typing"
  });

  try {
    if (mode === "web") {
      let searchTerm = await translateSearchQuery(text);
      let pages = await searchWeb(searchTerm, 50);
      if (!pages.length && searchTerm.toLowerCase() !== text.toLowerCase()) {
        pages = await searchWeb(text, 50);
      }
      const valid = pages.filter(p => /^https?:\/\//i.test(p.url || ""));
      if (!valid.length) {
        return telegram("sendMessage", {
          chat_id: chatId,
          text: "نتیجه‌ای پیدا نشد. عبارت دیگری رو امتحان کن."
        });
      }
      const token = crypto.randomBytes(5).toString("hex");
      chatWebPages.set(token, { chatId, results: valid, page: 0 });
      return sendChatWebPage(token);
    }

    if (mode === "image") {
      let searchTerm = await translateSearchQuery(text);
      let imageData = await searchImages(searchTerm, 1);
      if (
        (!imageData.hits || imageData.hits.length === 0) &&
        searchTerm.toLowerCase() !== text.toLowerCase()
      ) {
        searchTerm = text;
        imageData = await searchImages(searchTerm, 1);
      }
      const token = crypto.randomBytes(5).toString("hex");
      chatImagePages.set(token, { chatId, query: searchTerm, page: 1 });
      return sendChatImagePage(chatId, searchTerm, 1, token);
    }

    if (mode === "video") {
      let query = await translateSearchQuery(text);
      let data = await fetchBothVideoSources(query, 1, 1, CHAT_VIDEO_PAGE_SIZE);
      if (
        data.firstData.results.length === 0 &&
        data.secondData.results.length === 0 &&
        query.toLowerCase() !== text.toLowerCase()
      ) {
        query = text;
        data = await fetchBothVideoSources(query, 1, 1, CHAT_VIDEO_PAGE_SIZE);
      }
      const token = crypto.randomBytes(5).toString("hex");
      chatVideoPages.set(token, { chatId, query, page: 1 });
      return sendChatVideoPage(token, data);
    }
  } catch (error) {
    console.error("Chat search error:", error.response?.data || error.message);
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "جست‌وجو موقتاً ناموفق بود. لطفاً کمی بعد دوباره امتحان کن."
    });
  }
}


async function sendChatWebPage(token) {
  const state = chatWebPages.get(token);
  if (!state) return;
  const start = state.page * CHAT_WEB_PAGE_SIZE;
  const batch = state.results.slice(start, start + CHAT_WEB_PAGE_SIZE);
  for (let i = 0; i < batch.length; i++) {
    const p = batch[i];
    const title = p.name || "بدون عنوان";
    const snippet = (p.snippet || p.text || "").trim().slice(0, 650);
    await telegram("sendMessage", {
      chat_id: state.chatId,
      text: `🔎 ${start + i + 1}. ${title}\\n\\n${snippet}\\n\\n${p.url}`,
      disable_web_page_preview: true
    });
  }
  state.page += 1;
  const hasMore = state.page * CHAT_WEB_PAGE_SIZE < state.results.length;
  await telegram("sendMessage", {
    chat_id: state.chatId,
    text: hasMore ? "برای دیدن نتایج بیشتر، دکمه زیر رو بزن." : "پایان نتایج این جست‌وجو.",
    reply_markup: hasMore ? {
      inline_keyboard: [[{ text: "نتایج بیشتر", callback_data: `cw:${token}` }]]
    } : { inline_keyboard: [] }
  });
}

async function sendChatVideoPage(token, existingData = null) {
  const state = chatVideoPages.get(token);
  if (!state) return;
  const page = state.page;
  const data = existingData || await fetchBothVideoSources(
    state.query, page, page, CHAT_VIDEO_PAGE_SIZE
  );
  const videos = interleaveVideos(
    data.firstData.results.map(v => ({
      title: v.tags || "Video",
      duration: v.duration,
      url: v.videos?.medium?.url || v.videos?.small?.url || v.pageURL,
      sourceUrl: v.pageURL || ""
    })),
    data.secondData.results.map(v => ({
      title: v.title || "Video",
      duration: v.duration,
      url: v.id ? `https://adultembed.com/player/embed/${v.id}/` : "",
      sourceUrl: ""
    }))
  ).filter(v => /^https?:\/\//i.test(v.url || "")).slice(0, CHAT_VIDEO_PAGE_SIZE * 2);

  if (!videos.length) {
    await telegram("sendMessage", {
      chat_id: state.chatId,
      text: "برای این عبارت ویدئویی بیشتری پیدا نشد."
    });
    return;
  }

  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    const buttons = [[{ text: "▶️ تماشای ویدئو", url: v.url }]];
    if (/^https?:\/\//i.test(v.sourceUrl || "")) {
      buttons[0].push({ text: "مشاهده منبع", url: v.sourceUrl });
    }
    await telegram("sendMessage", {
      chat_id: state.chatId,
      text:
        `🎬 ${((page - 1) * CHAT_VIDEO_PAGE_SIZE * 2) + i + 1}. ${String(v.title).slice(0, 220)}\n` +
        (v.duration ? `مدت: ${v.duration}\n` : ""),
      reply_markup: { inline_keyboard: buttons },
      disable_web_page_preview: true
    });
  }

  const hasMore =
    data.firstData.count > page * CHAT_VIDEO_PAGE_SIZE ||
    data.secondData.count > page * CHAT_VIDEO_PAGE_SIZE;
  await telegram("sendMessage", {
    chat_id: state.chatId,
    text: hasMore ? "برای دیدن ویدئوهای بیشتر، دکمه زیر رو بزن." : "پایان نتایج این جست‌وجو.",
    reply_markup: hasMore ? {
      inline_keyboard: [[{ text: "ویدئوهای بیشتر", callback_data: `cv:${token}` }]]
    } : { inline_keyboard: [] }
  });
}
async function sendChatImagePage(chatId, query, page, token) {
  const data = await searchImages(query, page);
  const hits = (data.hits || []).filter(h => h.webformatURL).slice(0, 30);

  if (!hits.length) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "عکس بیشتری برای این جست‌وجو پیدا نشد."
    });
    return;
  }

  // Telegram allows up to 10 media items in each media group.
  for (let start = 0; start < hits.length; start += 10) {
    const media = hits.slice(start, start + 10).map((hit, index) => ({
      type: "photo",
      media: hit.webformatURL,
      ...(start === 0 && index === 0 ? {
        caption: `🖼 ${(hit.tags || query).slice(0, 900)}\nعکاس: ${hit.user || "نامشخص"}`
      } : {})
    }));

    await telegram("sendMediaGroup", {
      chat_id: chatId,
      media
    });
  }

  const hasMore = data.totalHits > page * 30;
  await telegram("sendMessage", {
    chat_id: chatId,
    text: hasMore ? "برای دیدن عکس‌های بیشتر، دکمه زیر رو بزن." : "پایان نتایج این جست‌وجو.",
    reply_markup: hasMore ? {
      inline_keyboard: [[{
        text: "عکس‌های بیشتر",
        callback_data: `ci:${token}`
      }]]
    } : { inline_keyboard: [] }
  });
}

// ---------------- WEB SEARCH ----------------

async function searchWeb(query, count = 8) {
  const response = await axios.post(
    "https://api.langsearch.com/v1/web-search",
    { query, count: Math.min(50, Math.max(1, count)) },
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
async function translateSearchQuery(query) {
  const cleanTranslation = (value) => {
    if (!value || typeof value !== "string") return "";
    return cheerio.load("<div>" + value + "</div>").text().trim();
  };

  // Google Translate first; MyMemory is a fallback.
  try {
    const response = await axios.get(
      "https://translate.googleapis.com/translate_a/single",
      {
        params: {
          client: "gtx",
          sl: "auto",
          tl: "en",
          dt: "t",
          q: query.slice(0, 400)
        },
        timeout: 15000
      }
    );
    const translated = cleanTranslation(
      (response.data?.[0] || []).map(part => part?.[0] || "").join("")
    );
    if (translated && translated.toLowerCase() !== query.toLowerCase()) {
      return translated;
    }
  } catch (error) {
    console.error("Google translation error:", error.message);
  }

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
    const translated = cleanTranslation(
      response.data?.responseData?.translatedText
    );
    if (Number(response.data?.responseStatus) === 200 && translated) {
      return translated;
    }
  } catch (error) {
    console.error("MyMemory translation error:", error.message);
  }

  return query;
}

// Ordinary video source
async function searchPixabayVideos(query, page = 1, perPage = VIDEO_PAGE_SIZE) {
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
        per_page: perPage,
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
async function searchSecondVideoSource(query, page = 1, perPage = VIDEO_PAGE_SIZE) {
  const response = await axios.get(
    "https://adultembed.com/api/database/browse/",
    {
      params: {
        search: query.slice(0, 150),
        orientation: "all",
        sort: "popular",
        page,
        page_size: perPage
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

async function fetchBothVideoSources(query, firstPage, secondPage, perPage = VIDEO_PAGE_SIZE) {
  const [firstResult, secondResult] = await Promise.allSettled([
    searchPixabayVideos(query, firstPage, perPage),
    searchSecondVideoSource(query, secondPage, perPage)
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

  const searchTerm = await translateSearchQuery(videoQuery);

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
      "User-Agent": "Mozilla/5.0 (compatible; MorvarBot/1.0)"
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
    if (data.startsWith("cw:")) {
      const token = data.slice(3);
      const state = chatWebPages.get(token);
      await telegram("answerCallbackQuery", { callback_query_id: query.id });
      if (!state || state.chatId !== query.message?.chat?.id) return;
      await telegram("editMessageReplyMarkup", {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        reply_markup: { inline_keyboard: [] }
      });
      await sendChatWebPage(token);
      return;
    }
    if (data.startsWith("cv:")) {
      const token = data.slice(3);
      const state = chatVideoPages.get(token);
      await telegram("answerCallbackQuery", { callback_query_id: query.id });
      if (!state || state.chatId !== query.message?.chat?.id) return;
      state.page += 1;
      await telegram("editMessageReplyMarkup", {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        reply_markup: { inline_keyboard: [] }
      });
      await sendChatVideoPage(token);
      return;
    }
    if (data.startsWith("ci:")) {
      const token = data.slice(3);
      const state = chatImagePages.get(token);
      await telegram("answerCallbackQuery", { callback_query_id: query.id });
      if (!state || state.chatId !== query.message?.chat?.id) return;
      state.page += 1;
      await telegram("editMessageReplyMarkup", {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        reply_markup: { inline_keyboard: [] }
      });
      await sendChatImagePage(state.chatId, state.query, state.page, token);
      return;
    }
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

      let translatedQuery = await translateSearchQuery(imageQuery);
      let imageData = await searchImages(translatedQuery, page);
      if (
        (!imageData.hits || imageData.hits.length === 0) &&
        translatedQuery.toLowerCase() !== imageQuery.toLowerCase()
      ) {
        translatedQuery = imageQuery;
        imageData = await searchImages(translatedQuery, page);
      }

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

    let searchTerm = await translateSearchQuery(text);
    let pages = await searchWeb(searchTerm);
    if (!pages.length && searchTerm.toLowerCase() !== text.toLowerCase()) {
      pages = await searchWeb(text);
    }

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

  await telegram("setMyCommands", {
    commands: [
      { command: "start", description: "نمایش منوی اصلی" },
      { command: "web", description: "جست‌وجوی وب" },
      { command: "img", description: "جست‌وجوی عکس‌ها" },
      { command: "vid", description: "جست‌وجوی ویدئوها" },
      { command: "ai", description: "گفتگو با هوش مصنوعی" }
    ]
  });

  console.log("Telegram webhook and command menu successfully configured.");
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MorvarBot running on port ${PORT}`);

  startBot().catch(error => {
    console.error(
      "Startup error:",
      error.response?.data || error.message
    );
  });
});
