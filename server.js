
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const crypto = require("crypto");
const sharp = require("sharp");

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
const pendingEditPhotos = new Map();
const marketCategoryByChat = new Map();
let marketPriceCache = { data: null, fetchedAt: 0 };

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

const PHOTO_EDIT_STYLES = {
  portrait: { label: "👤 پرتره حرفه‌ای", prompt: "Transform the person in the input photo into a polished professional studio portrait. Preserve the same person's recognizable identity, facial structure, age, hairstyle, skin tone, and natural features. Use flattering soft studio lighting, a refined background, realistic skin texture, and professional portrait photography. Do not add people or change who the person is." },
  cartoon: { label: "🎭 کارتونی", prompt: "Transform the person in the input photo into a beautiful high-quality 3D animated cartoon portrait. Preserve the person's recognizable identity, facial structure, hairstyle, and key features while applying a polished expressive animated-film art style. Keep the composition focused on the same person." },
  cinematic: { label: "🎬 سینمایی", prompt: "Give the input photo a premium cinematic film look with atmospheric lighting, refined contrast, rich but natural color grading, subtle depth, and professional movie-still composition. Preserve the same subject, identity, facial features, pose, and important scene details." },
  color: { label: "🌈 اصلاح رنگ", prompt: "Perform professional natural photo correction on the input image. Improve white balance, exposure, color accuracy, contrast, highlights, shadows, and moderate saturation. Reduce visible noise and improve clarity while preserving the original people, identity, objects, composition, and realistic appearance. Do not stylize or replace anything." },
  restore: { label: "🛠 ترمیم عکس قدیمی", prompt: "Carefully restore the old or damaged photograph. Remove scratches, dust, stains, creases, fading, and image deterioration; improve clarity and tonal balance. If it is black and white, apply subtle historically plausible natural colorization. Preserve the original composition, recognizable facial identities, expressions, clothing, and period details. Do not invent or modernize details." },
  background: { label: "🖼 تغییر پس‌زمینه", prompt: "Replace the background of the input photo with an elegant professional photographic background that complements the subject. Carefully preserve the same person's identity, face, hair, clothing, body shape, pose, and edges. Use realistic lighting and natural integration. Do not alter the subject." }
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

  if (update.message?.text || update.message?.photo) {
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
        [{ text: "🤖 چت با هوش مصنوعی" }],
        [{ text: "💰 قیمت بازار" }]
      ],
      resize_keyboard: true,
      is_persistent: true,
      input_field_placeholder: "اول نوع جست‌وجو رو انتخاب کن"
    }
  });
}


async function showMarketMenu(chatId) {
  chatModes.set(chatId, "market_menu");
  return telegram("sendMessage", {
    chat_id: chatId,
    text: "💰 کدوم بخش از قیمت‌های بازار رو می‌خوای ببینی؟",
    reply_markup: {
      keyboard: [
        [{ text: "₿ رمزارزها" }],
        [{ text: "💱 ارزهای خارجی" }, { text: "🪙 طلا و سکه" }],
        [{ text: "🔙 منوی اصلی" }]
      ],
      resize_keyboard: true,
      is_persistent: true
    }
  });
}

async function showMarketPrices(chatId, category = "all") {
  chatModes.set(chatId, "market");
  marketCategoryByChat.set(chatId, category);
  const categoryTitles = {
    crypto: "₿ قیمت رمزارزها",
    currency: "💱 قیمت ارزهای خارجی",
    gold: "🪙 قیمت طلا و سکه"
  };

  try {
    const now = Date.now();
    if (!marketPriceCache.data || now - marketPriceCache.fetchedAt > 60000) {
      const response = await axios.get("https://nerkhara.com/api/v1/latest.json", {
        timeout: 15000,
        headers: { "Accept": "application/json" }
      });
      if (!Array.isArray(response.data?.items)) {
        throw new Error("Market API returned an unexpected response");
      }
      marketPriceCache = { data: response.data, fetchedAt: now };
    }

    const items = new Map(marketPriceCache.data.items.map(item => [item.id, item]));
    const rial = value => Math.round(Number(value) * 10);
    const format = value => new Intl.NumberFormat("fa-IR").format(Math.round(value));
    const rateLine = (label, id) => {
      const item = items.get(id);
      if (!item || item.price == null || !Number.isFinite(Number(item.price))) {
        return label + ": فعلاً در دسترس نیست";
      }
      return label + ": " + format(rial(item.price)) + " ریال" +
        (item.stale ? " ⚠️ (داده قدیمی)" : "");
    };

    const usd = items.get("usd");
    const cryptoIds = [
      ["بیت‌کوین", "btc"], ["اتریوم", "eth"], ["تتر", "usdt"],
      ["تون‌کوین", "ton"], ["سولانا", "sol"], ["بایننس‌کوین", "bnb"],
      ["ریپل", "xrp"], ["دوج‌کوین", "doge"], ["ترون", "trx"],
      ["کاردانو", "ada"], ["لایت‌کوین", "ltc"], ["پولکادات", "dot"],
      ["پکس گلد", "paxg"], ["بیت‌کوین کش", "bch"]
    ];
    const cryptoLines = cryptoIds.map(([label, id]) => {
      const item = items.get(id);
      if (!item || item.price == null || !Number.isFinite(Number(item.price))) {
        return label + ": فعلاً در دسترس نیست";
      }
      const isTether = id === "usdt";
      const usdPrice = isTether ? 1 : Number(item.price);
      const localToman = isTether
        ? Number(item.price)
        : (item.price_irt != null && Number.isFinite(Number(item.price_irt))
            ? Number(item.price_irt)
            : (usd && usd.price != null ? usdPrice * Number(usd.price) : null));
      const localText = localToman == null
        ? "قیمت ریالی موجود نیست"
        : format(rial(localToman)) + " ریال";
      const stale = item.stale || (localToman != null && !isTether &&
        item.price_irt == null && usd?.stale) ? " ⚠️ (داده قدیمی)" : "";
      return label + ": $" + new Intl.NumberFormat("en-US", {
        maximumFractionDigits: usdPrice < 1 ? 6 : 2
      }).format(usdPrice) + " | " + localText + stale;
    });

    let text = categoryTitles[category] + "\n━━━━━━━━━━━━━━\n";
    if (category === "crypto") {
      text += "قیمت به دلار و معادل ریالی\n" + cryptoLines.join("\n");
    } else if (category === "currency") {
      text += "نرخ ارز آزاد (ریال)\n" +
        rateLine("دلار آزاد", "usd") + "\n" +
        rateLine("یورو آزاد", "eur");
    } else if (category === "gold") {
      text += "قیمت‌ها به ریال\n" +
        rateLine("طلای ۱۸ عیار، هر گرم", "gold-18k") + "\n" +
        rateLine("سکه بهار آزادی", "coin-bahar-azadi") + "\n" +
        rateLine("سکه امامی", "coin-emami");
    } else {
      text += "برای مشاهده قیمت‌ها، یکی از دسته‌ها رو انتخاب کن.";
    }

    const relevantIds = category === "crypto" ? cryptoIds.map(([, id]) => id)
      : category === "currency" ? ["usd", "eur"]
      : ["gold-18k", "coin-bahar-azadi", "coin-emami"];
    const timestamps = relevantIds.map(id => items.get(id)?.updated_utc)
      .filter(Boolean).map(value => Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : value + "Z"))
      .filter(Number.isFinite);
    const latestTimestamp = timestamps.length ? Math.max(...timestamps) : NaN;
    const updatedText = Number.isFinite(latestTimestamp)
      ? new Intl.DateTimeFormat("fa-IR", {
          timeZone: "Asia/Tehran", dateStyle: "short", timeStyle: "short"
        }).format(new Date(latestTimestamp))
      : "نامشخص";

    text += "\n\n🕒 آخرین زمان ثبت نرخ‌ها: " + updatedText +
      "\nمنبع: NerkhAra (به‌روزرسانی تقریبی هر ۱۰ دقیقه)\nhttps://nerkhara.com";

    return telegram("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: {
        keyboard: [
          [{ text: "🔄 به‌روزرسانی همین بخش" }],
          [{ text: "📂 دسته‌بندی قیمت‌ها" }],
          [{ text: "🔙 منوی اصلی" }]
        ],
        resize_keyboard: true,
        is_persistent: true
      }
    });
  } catch (error) {
    console.error("Market prices error:", error.response?.data || error.message);
    return telegram("sendMessage", {
      chat_id: chatId,
      text: "❌ دریافت قیمت‌ها فعلاً ممکن نشد. لطفاً کمی بعد دوباره امتحان کن.",
      reply_markup: {
        keyboard: [
          [{ text: "🔄 به‌روزرسانی همین بخش" }],
          [{ text: "📂 دسته‌بندی قیمت‌ها" }],
          [{ text: "🔙 منوی اصلی" }]
        ],
        resize_keyboard: true,
        is_persistent: true
      }
    });
  }
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
        [{ text: "🖼 ساخت تصویر" }, { text: "🎨 ویرایش عکس" }],
        [{ text: "🔄 تغییر مدل" }, { text: "🔙 منوی اصلی" }]
      ],
      resize_keyboard: true,
      is_persistent: true
    }
  });
}

async function showPhotoEditMenu(chatId, intro = null) {
  chatModes.set(chatId, "ai_edit_select");
  await telegram("sendMessage", {
    chat_id: chatId,
    text: (intro ? intro + "\n\n" : "") +
      "🎨 نوع ویرایش رو انتخاب کن. می‌تونی چند سبک مختلف رو روی همین عکس امتحان کنی:",
    reply_markup: {
      keyboard: [
        [{ text: PHOTO_EDIT_STYLES.portrait.label }, { text: PHOTO_EDIT_STYLES.cartoon.label }],
        [{ text: PHOTO_EDIT_STYLES.cinematic.label }, { text: PHOTO_EDIT_STYLES.color.label }],
        [{ text: PHOTO_EDIT_STYLES.restore.label }, { text: PHOTO_EDIT_STYLES.background.label }],
        [{ text: "📷 ارسال عکس جدید" }, { text: "🔙 منوی اصلی" }]
      ],
      resize_keyboard: true,
      is_persistent: true
    }
  });
}

async function handleIncomingEditPhoto(message) {
  const chatId = message.chat.id;
  const mode = chatModes.get(chatId);
  if (mode !== "ai_edit_wait_photo" && mode !== "ai_edit_select") {
    return telegram("sendMessage", {
      chat_id: chatId,
      text: "برای ویرایش عکس، اول از منوی هوش مصنوعی گزینه «🎨 ویرایش عکس» رو انتخاب کن؛ بعد عکست رو بفرست."
    });
  }
  const photo = message.photo[message.photo.length - 1];
  if (!photo?.file_id) {
    return telegram("sendMessage", {
      chat_id: chatId,
      text: "نتونستم عکس رو دریافت کنم. لطفاً دوباره به‌صورت عکس ارسالش کن."
    });
  }
  pendingEditPhotos.set(chatId, photo.file_id);
  return showPhotoEditMenu(chatId, "✅ عکست دریافت شد.");
}

async function editPhotoForChat(chatId, styleKey) {
  const style = PHOTO_EDIT_STYLES[styleKey];
  const fileId = pendingEditPhotos.get(chatId);
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!style || !fileId) {
    return telegram("sendMessage", { chat_id: chatId, text: "اول یک عکس بفرست تا بتونم ویرایشش کنم." });
  }
  if (!accountId || !apiToken) {
    return telegram("sendMessage", { chat_id: chatId, text: "اتصال سرویس ویرایش عکس هنوز تنظیم نشده است." });
  }

  let statusMessageId = null;
  try {
    const status = await telegram("sendMessage", {
      chat_id: chatId,
      text: "⏳ عکس دریافت شد؛ در حال ویرایش تصویرت هستم. لطفاً کمی صبر کن..."
    });
    statusMessageId = status.result?.message_id || null;
  } catch (statusError) {
    console.error("Could not send photo-edit status:", statusError.message);
  }

  try {
    await telegram("sendChatAction", { chat_id: chatId, action: "upload_photo" });
    const fileInfo = await telegram("getFile", { file_id: fileId });
    const filePath = fileInfo.result?.file_path;
    if (!filePath) throw new Error("Telegram did not return a photo file path");

    const download = await axios.get(
      "https://api.telegram.org/file/bot" + BOT_TOKEN + "/" + filePath,
      { responseType: "arraybuffer", timeout: 30000, maxContentLength: 20 * 1024 * 1024 }
    );
    const sourceBuffer = Buffer.from(download.data);
    const processedBuffer = await sharp(sourceBuffer)
      .rotate()
      .resize({ width: 510, height: 510, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();

    const dimensions = await sharp(processedBuffer).metadata();
    const ratio = (dimensions.width || 1) / (dimensions.height || 1);
    const longestSide = 512;
    const outputWidth = ratio >= 1 ? longestSide : Math.max(256, Math.round(longestSide * ratio));
    const outputHeight = ratio >= 1 ? Math.max(256, Math.round(longestSide / ratio)) : longestSide;

    const form = new FormData();
    form.append("prompt", style.prompt);
    form.append("input_image_0", new Blob([processedBuffer], { type: "image/jpeg" }), "morvarbot-source.jpg");
    form.append("width", String(outputWidth));
    form.append("height", String(outputHeight));

    const endpoint = "https://api.cloudflare.com/client/v4/accounts/" +
      accountId + "/ai/run/@cf/black-forest-labs/flux-2-klein-4b";
    const result = await axios.post(endpoint, form, {
      headers: { Authorization: "Bearer " + apiToken },
      timeout: 180000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    const imageBase64 = result.data?.result?.image;
    if (!imageBase64) {
      throw new Error(result.data?.errors?.[0]?.message || "Cloudflare returned no edited image");
    }
    const imageBuffer = await sharp(Buffer.from(imageBase64, "base64"))
      .jpeg({ quality: 90 })
      .toBuffer();
    const sendForm = new FormData();
    sendForm.append("chat_id", String(chatId));
    sendForm.append("caption", "🎨 نتیجه ویرایش عکس — " + style.label);
    sendForm.append("photo", new Blob([imageBuffer], { type: "image/jpeg" }), "morvarbot-edited-photo.jpg");
    await axios.post(TELEGRAM_API + "/sendPhoto", sendForm, { timeout: 60000 });

    if (statusMessageId) {
      try {
        await telegram("deleteMessage", { chat_id: chatId, message_id: statusMessageId });
      } catch (deleteError) {
        console.error("Could not delete photo-edit status:", deleteError.message);
      }
    }
    console.log("Photo edited with Cloudflare FLUX.2 Klein 4B:", styleKey);
    return showPhotoEditMenu(
      chatId,
      "✅ ویرایش انجام شد! می‌تونی سبک دیگه‌ای رو روی همین عکس امتحان کنی یا عکس جدید بفرستی."
    );
  } catch (error) {
    if (statusMessageId) {
      try {
        await telegram("deleteMessage", { chat_id: chatId, message_id: statusMessageId });
      } catch (deleteError) {
        console.error("Could not delete photo-edit status:", deleteError.message);
      }
    }
    const status = error.response?.status;
    console.error("Cloudflare photo editing error:", error.response?.data || error.message);
    let message = "ویرایش عکس ناموفق بود. لطفاً دوباره امتحان کن یا عکس دیگری بفرست.";
    if (status === 401 || status === 403) {
      message = "دسترسی Cloudflare تأیید نشد؛ کلید API و مجوز Workers AI باید بررسی شود.";
    } else if (status === 429) {
      message = "سهمیه رایگان روزانه هوش مصنوعی Cloudflare فعلاً تمام شده؛ بعد از صفر شدن سهمیه دوباره امتحان کن.";
    }
    await telegram("sendMessage", { chat_id: chatId, text: message });
    return showPhotoEditMenu(chatId, "می‌تونی دوباره همین سبک یا یک سبک دیگه رو امتحان کنی.");
  }
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

async function handleAiMessage(chatId, userId, userText, forceProvider = null) {
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

  const selectedProviders = forceProvider
    ? providers.filter(provider => provider.name === forceProvider)
    : providers;

  for (const provider of selectedProviders) {
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

  if (message.photo?.length) return handleIncomingEditPhoto(message);

  if (command === "/start") return showWelcome(chatId);
  if (command === "/web") return selectChatMode(chatId, "web");
  if (command === "/img") return selectChatMode(chatId, "image");
  if (command === "/vid") return selectChatMode(chatId, "video");
  if (command === "/ai") return showAiMenu(chatId);
  if (command === "/prices") return showMarketMenu(chatId);
  if (command === "/gemini-test") {
    const testText = text.replace(/^\/gemini-test(?:@\w+)?\s*/i, "").trim() ||
      "سلام. لطفاً در یک جمله خودت را معرفی کن.";
    await telegram("sendChatAction", { chat_id: chatId, action: "typing" });
    return handleAiMessage(chatId, message.from?.id || chatId, testText, "Gemini");
  }
  if (command === "/draw" || command === "/image") {
    return generateImageForChat(chatId, text.replace(/^\/(?:draw|image)(?:@\w+)?\s*/i, ""));
  }

  if (text === "🤖 چت با هوش مصنوعی") return showAiMenu(chatId);
  if (text === "💰 قیمت بازار" || text === "📂 دسته‌بندی قیمت‌ها") return showMarketMenu(chatId);
  if (text === "₿ رمزارزها") return showMarketPrices(chatId, "crypto");
  if (text === "💱 ارزهای خارجی") return showMarketPrices(chatId, "currency");
  if (text === "🪙 طلا و سکه") return showMarketPrices(chatId, "gold");
  if (text === "🔄 به‌روزرسانی همین بخش") {
    const current = chatModes.get(chatId);
    return showMarketPrices(chatId, marketCategoryByChat.get(chatId) || "currency");
  }
  if (text === "🔙 منوی اصلی") {
    pendingEditPhotos.delete(chatId);
    return showWelcome(chatId);
  }
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
  if (text === "🎨 ویرایش عکس") {
    chatModes.set(chatId, "ai_edit_wait_photo");
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "🎨 حالت ویرایش عکس فعاله. حالا عکس موردنظرت رو به‌صورت Photo (نه فایل) بفرست."
    });
    return;
  }
  if (text === "📷 ارسال عکس جدید") {
    pendingEditPhotos.delete(chatId);
    chatModes.set(chatId, "ai_edit_wait_photo");
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "عکس جدیدت رو به‌صورت Photo بفرست."
    });
    return;
  }
  const selectedPhotoStyle = Object.entries(PHOTO_EDIT_STYLES)
    .find(([, style]) => style.label === text);
  if (selectedPhotoStyle) return editPhotoForChat(chatId, selectedPhotoStyle[0]);
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
  if (mode === "market" || mode === "market_menu") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "برای انتخاب بخش قیمت‌ها، از دکمه‌های منو استفاده کن."
    });
    return;
  }
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
      text: "لطفاً یکی از گزینه‌های چت متنی، ساخت تصویر یا ویرایش عکس رو از منوی پایین انتخاب کن."
    });
    return;
  }
  if (mode === "ai_edit_wait_photo") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "لطفاً عکس رو به‌صورت Photo بفرست تا بتونم ویرایشش کنم."
    });
    return;
  }
  if (mode === "ai_edit_select") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "لطفاً یکی از شش سبک ویرایش رو از منوی پایین انتخاب کن."
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
      { command: "ai", description: "گفتگو با هوش مصنوعی" },
      { command: "prices", description: "قیمت ارز، طلا، سکه و رمزارزها" }
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
