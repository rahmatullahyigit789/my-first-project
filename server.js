const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { GoogleGenAI, createPartFromUri } = require("@google/genai");

const app = express();
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith("video/")) {
      return cb(new Error("فقط فایل ویدیویی پذیرفته می‌شود."));
    }
    cb(null, true);
  }
});

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/api/health", (req, res) => res.json({
  status: "ok",
  geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
  translation: "async-video-to-dari-srt"
}));

// Jobs live in memory for this single Railway replica. A restart clears active jobs.
const jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000;

function cleanupJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.updatedAt < cutoff && job.status !== "processing") jobs.delete(id);
  }
}
setInterval(cleanupJobs, 10 * 60 * 1000).unref();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryable(error) {
  const status = Number(error?.status || error?.code || error?.response?.status || 0);
  const code = error?.code || error?.cause?.code || "";
  return [408, 429, 500, 502, 503, 504].includes(status) ||
    ["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"].includes(code);
}

async function uploadToGemini(ai, file) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await ai.files.upload({
        file: file.path,
        config: { mimeType: file.mimetype, displayName: file.originalname }
      });
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === 2) throw error;
      await sleep(3000 * (attempt + 1));
    }
  }
  throw lastError || new Error("بارگذاری ویدیو در Gemini ناموفق شد.");
}

function srtClean(value) {
  return String(value || "").replace(/`{3}(?:srt)?/gi, "").trim();
}

async function processTranslation(jobId, file) {
  const job = jobs.get(jobId);
  if (!job) {
    await fs.promises.unlink(file.path).catch(() => {});
    return;
  }
  let remoteFile;
  try {
    if (!process.env.GEMINI_API_KEY) throw new Error("کلید Gemini در سرور تنظیم نشده است.");
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    job.message = "ویدیو به سرویس هوش مصنوعی فرستاده شد؛ در حال آماده‌سازی فایل است.";
    job.progress = 35;
    job.updatedAt = Date.now();

    remoteFile = await uploadToGemini(ai, file);

    let status = remoteFile.state;
    for (let i = 0; i < 90 && status !== "ACTIVE"; i++) {
      if (status === "FAILED") throw new Error("آماده‌سازی ویدیو در Gemini ناموفق شد.");
      await sleep(2000);
      remoteFile = await ai.files.get({ name: remoteFile.name });
      status = remoteFile.state;
      job.message = "در حال آماده‌سازی ویدیو برای ترجمه…";
      job.progress = Math.min(55, 40 + Math.floor((i + 1) / 90 * 15));
      job.updatedAt = Date.now();
    }
    if (status !== "ACTIVE") throw new Error("آماده‌سازی ویدیو بیش از سه دقیقه طول کشید.");

    const prompt = "گفتار ویدیوی پیوست را با حفظ ترتیب و زمان‌بندی به زبان دری افغانستان ترجمه کن. فقط زیرنویس SRT معتبر برگردان؛ هیچ توضیح اضافه نده. زمان‌ها را با قالب HH:MM:SS,mmm بنویس و با گفتار واقعی هماهنگ کن. اگر بخشی گفتار ندارد، برای آن زیرنویس نساز. زبان اصلی را خودت تشخیص بده.";
    let result;
    let lastError;
    const models = ["gemini-3.8-flash", "gemini-3.5-flash-lite"];
    for (const model of models) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          job.message = "در حال ساخت زیرنویس دری با " + model + "…";
          job.progress = 65;
          job.updatedAt = Date.now();
          result = await ai.models.generateContent({
            model,
            contents: [createPartFromUri(remoteFile.uri, remoteFile.mimeType), prompt],
            config: { temperature: 0.2 }
          });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (!isRetryable(error) || attempt === 2) break;
          job.message = "سرویس ترجمه موقتاً شلوغ است؛ تلاش دوباره…";
          job.progress = 70;
          job.updatedAt = Date.now();
          await sleep(Math.min(20000, 3000 * Math.pow(2, attempt)));
        }
      }
      if (result) break;
      // A busy primary model falls back to the lighter model before reporting failure.
    }
    if (lastError || !result) throw lastError || new Error("پاسخی از Gemini دریافت نشد.");
    const srt = srtClean(result.text);
    if (!srt || !/\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/.test(srt)) {
      throw new Error("زیرنویس SRT معتبر از Gemini دریافت نشد.");
    }
    job.status = "completed";
    job.progress = 100;
    job.message = "زیرنویس دری آماده شد.";
    job.srt = srt;
    job.updatedAt = Date.now();
  } catch (error) {
    console.error("Translation job failed:", error);
    const status = Number(error?.status || error?.code || error?.response?.status || 0);
    job.status = "failed";
    job.progress = 0;
    job.message = [429, 500, 502, 503, 504].includes(status)
      ? "سرویس Gemini پس از چند تلاش هنوز پاسخ نداد. مشکل از دسترسی موقت سرویس هوش مصنوعی است؛ کمی بعد دوباره امتحان می‌کنیم."
      : (error.message || "در ترجمه ویدیو خطا رخ داد.");
    job.updatedAt = Date.now();
  } finally {
    await fs.promises.unlink(file.path).catch(() => {});
    if (remoteFile?.name && process.env.GEMINI_API_KEY) {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      ai.files.delete({ name: remoteFile.name }).catch(() => {});
    }
  }
}

app.post("/api/translate", upload.single("video"), (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    if (req.file?.path) fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(503).json({ success: false, message: "کلید Gemini در سرور تنظیم نشده است." });
  }
  if (!req.file) {
    return res.status(400).json({ success: false, message: "لطفاً فایل ویدیویی را انتخاب کنید. دریافت مستقیم لینک شبکه‌های اجتماعی هنوز فعال نیست." });
  }
  const id = crypto.randomUUID();
  jobs.set(id, {
    status: "processing",
    message: "درخواست ثبت شد؛ پردازش ویدیو آغاز می‌شود.",
    progress: 10,
    srt: null,
    updatedAt: Date.now()
  });
  // Respond immediately; the browser polls the job endpoint instead of waiting for Gemini.
  res.status(202).json({ success: true, jobId: id, status: "processing" });
  processTranslation(id, req.file).catch(error => {
    console.error("Unexpected job error:", error);
    const job = jobs.get(id);
    if (job) {
      job.status = "failed";
      job.message = "پردازش ویدیو به مشکل خورد. لطفاً بعداً دوباره تلاش کنید.";
      job.updatedAt = Date.now();
    }
  });
});


app.post("/api/dub", async (req, res) => {
  try {
    const srt = String(req.body?.srt || "").slice(0, 12000);
    const language = req.body?.language === "fa" ? "فارسی معیار" : "دری افغانستان";
    if (!srt.trim()) return res.status(400).json({ success: false, message: "اول زیرنویس را تولید کنید." });
    if (!process.env.GEMINI_API_KEY) return res.status(503).json({ success: false, message: "کلید Gemini تنظیم نشده است." });
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const plainText = srt
      .replace(/^\s*\d+\s*$/gm, "")
      .replace(/^\s*\d{2}:\d{2}:\d{2},\d{3}\s*-->.*$/gm, "")
      .replace(/\r/g, "")
      .split("\n").map(line => line.trim()).filter(Boolean).join(" ");
    if (!plainText) return res.status(400).json({ success: false, message: "متن زیرنویس خالی است." });
    const translated = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: "این متن زیرنویس را به " + language + " روان و طبیعی ترجمه کن. فقط متن ترجمه‌شده را برگردان، بدون توضیح و بدون زمان‌بندی:\n\n" + plainText,
      config: { temperature: 0.2 }
    });
    const speechText = String(translated.text || "").trim();
    if (!speechText) throw new Error("ترجمه برای دوبله تولید نشد.");
    const speech = await ai.interactions.create({
      model: "gemini-3.8-flash-tts",
      input: [{ type: "user_input", content: [{ type: "text", text: speechText }] }],
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice: "Kore" }] }
    });
    const audioBase64 = speech.output_audio?.data;
    if (!audioBase64) throw new Error("فایل صوتی از Gemini دریافت نشد.");
    const id = crypto.randomUUID();
    const audioPath = path.join(os.tmpdir(), "dub-" + id + ".wav");
    await fs.promises.writeFile(audioPath, Buffer.from(audioBase64, "base64"));
    jobs.set("dub-" + id, { status: "completed", audioPath, updatedAt: Date.now() });
    res.json({ success: true, audioUrl: "/api/dubs/" + id + "/audio", message: "فایل دوبله آماده شد." });
  } catch (error) {
    console.error("Dubbing failed:", error);
    res.status(502).json({ success: false, message: error.message || "ساخت دوبله ناموفق شد." });
  }
});

app.get("/api/dubs/:id/audio", async (req, res) => {
  const job = jobs.get("dub-" + req.params.id);
  if (!job?.audioPath) return res.status(404).json({ success: false, message: "فایل دوبله پیدا نشد." });
  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Content-Disposition", 'attachment; filename="video-dub.wav"');
  res.sendFile(job.audioPath);
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ success: false, message: "درخواست پیدا نشد یا سرور دوباره راه‌اندازی شده است." });
  res.json({
    success: job.status !== "failed",
    status: job.status,
    progress: job.status === "completed" ? 100 : (job.progress || 0),
    message: job.message,
    srt: job.status === "completed" ? job.srt : undefined
  });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ success: false, message: "اندازه فایل نباید بیشتر از ۱ گیگابایت باشد." });
  }
  res.status(400).json({ success: false, message: err.message || "در دریافت فایل خطا رخ داد." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
