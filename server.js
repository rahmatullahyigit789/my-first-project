const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const youtubeDlPackage = require("youtube-dl-exec");
const youtubedl = youtubeDlPackage;
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
  translation: "async-video-to-persian-srt", linkDownloader: true
}));

// Jobs live in memory for this single Railway replica. A restart clears active jobs.
const jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000;

function cleanupJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.updatedAt < cutoff && job.status !== "processing") {
      jobs.delete(id);
      for (const filePath of [job.audioPath, job.videoPath, job.outputVideoPath]) {
      if (filePath) fs.promises.unlink(filePath).catch(() => {});
    }
    }
  }
}
setInterval(cleanupJobs, 10 * 60 * 1000).unref();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withGeminiRetry(label, operation) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || error?.code || error?.response?.status || 0);
      if (![408, 429, 500, 502, 503, 504].includes(status) || attempt === 3) throw error;
      const delay = status === 429
        ? Math.min(60000, 15000 * (attempt + 1))
        : Math.min(30000, 5000 * Math.pow(2, attempt));
      console.warn(`${label} temporary Gemini error ${status}; retry ${attempt + 1}/3 in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastError;
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
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { apiVersion: "v1beta" } });
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

    const prompt = "گفتار ویدیوی پیوست را با حفظ ترتیب و زمان‌بندی به فارسی روان و معیار ترجمه کن. فقط زیرنویس SRT معتبر برگردان؛ هیچ توضیح اضافه نده. زمان‌ها را با قالب HH:MM:SS,mmm بنویس و با گفتار واقعی هماهنگ کن. اگر بخشی گفتار ندارد، برای آن زیرنویس نساز. زبان اصلی را خودت تشخیص بده.";
    let result;
    let lastError;
    const models = ["gemini-3.8-flash", "gemini-3.5-flash-lite"];
    for (const model of models) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          job.message = "در حال ساخت زیرنویس فارسی با " + model + "…";
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
    job.message = "زیرنویس فارسی آماده شد.";
    job.srt = srt;
    job.videoPath = file.path;
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
    if (job.status !== "completed") await fs.promises.unlink(file.path).catch(() => {});
    if (remoteFile?.name && process.env.GEMINI_API_KEY) {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      ai.files.delete({ name: remoteFile.name }).catch(() => {});
    }
  }
}


const ALLOWED_VIDEO_HOSTS = new Set(["youtube.com","www.youtube.com","m.youtube.com","youtu.be","youtube-nocookie.com","instagram.com","www.instagram.com","facebook.com","www.facebook.com","m.facebook.com","fb.watch","x.com","www.x.com","twitter.com","www.twitter.com","t.co"]);
function validateVideoUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "").trim()); } catch { throw new Error("لینک معتبر نیست."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !ALLOWED_VIDEO_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error("فقط لینک عمومی HTTPS از YouTube، Instagram، Facebook و X پذیرفته می‌شود.");
  }
  return parsed.toString();
}
async function downloadAndTranslate(jobId, url) {
  const job = jobs.get(jobId);
  const prefix = path.join(os.tmpdir(), "social-" + jobId);
  try {
    job.message = "در حال دریافت ویدیو از لینک…"; job.progress = 8; job.updatedAt = Date.now();
    await youtubedl.exec(url, { noPlaylist: true, format: "best[ext=mp4]/best", mergeOutputFormat: "mp4", output: prefix + ".%(ext)s", maxFilesize: "1G", socketTimeout: 30, retries: 2, noWarnings: true }, { timeout: 10 * 60 * 1000 });
    const names = await fs.promises.readdir(os.tmpdir());
    const files = names.filter(name => name.startsWith("social-" + jobId + ".")).map(name => path.join(os.tmpdir(), name));
    if (!files.length) throw new Error("فایل دریافت نشد؛ ممکن است لینک خصوصی یا محدود باشد.");
    const videoPath = files[0], stat = await fs.promises.stat(videoPath);
    if (!stat.size || stat.size > 1024 * 1024 * 1024) throw new Error("اندازهٔ ویدیو خالی یا بیشتر از ۱ گیگابایت است.");
    job.message = "ویدیو دریافت شد؛ ترجمه آغاز می‌شود…"; job.progress = 25; job.updatedAt = Date.now();
    await processTranslation(jobId, { path: videoPath, mimetype: "video/mp4", originalname: "social-video.mp4", size: stat.size });
  } catch (error) {
    console.error("Social video download failed:", error);
    const current = jobs.get(jobId);
    const detail = [
      error?.stderr, error?.stdout, error?.message,
      error?.cause?.message, error?.shortMessage
    ].filter(Boolean).join("\\n").slice(0, 5000);
    const lower = detail.toLowerCase();
    let userMessage;
    if (/sign in to confirm|not a bot|confirm you.re not a bot|cookies/i.test(lower)) {
      userMessage = "یوتیوب دانلود از سرور را به‌دلیل درخواست تأیید انسانی متوقف کرد. این لینک فعلاً از سرور قابل دریافت نیست. اگر اجازهٔ استفاده از ویدیو را دارید، فایل را از گوشی آپلود کنید؛ رمز یا کوکی گوگل را نفرستید.";
    } else if (/private video|video is private|private playlist/i.test(lower)) {
      userMessage = "این ویدیو خصوصی است و سرور به آن دسترسی ندارد. لینک عمومی یا فایل ویدیویی را که اجازهٔ استفاده از آن را دارید وارد کنید.";
    } else if (/video unavailable|has been removed|this video is unavailable/i.test(lower)) {
      userMessage = "ویدیو در دسترس نیست یا حذف شده است. لینک را بررسی کنید یا فایل مجاز ویدیو را از گوشی آپلود کنید.";
    } else if (/age.restricted|confirm your age|age verification/i.test(lower)) {
      userMessage = "یوتیوب برای این ویدیو تأیید سن می‌خواهد و سرور نمی‌تواند آن را دریافت کند. فایل مجاز را از دستگاه خود آپلود کنید.";
    } else if (/not available in your country|geo.restricted|blocked in your country/i.test(lower)) {
      userMessage = "این ویدیو در منطقهٔ سرور محدود شده است و دانلود انجام نشد. فایل مجاز را از دستگاه خود آپلود کنید.";
    } else if (/timed out|timeout|connection reset|network is unreachable|temporary failure|unable to download/i.test(lower)) {
      userMessage = "ارتباط سرور با منبع ویدیو برقرار نشد یا زمان درخواست تمام شد. چند دقیقه بعد دوباره امتحان کنید.";
    } else if (/unsupported url|not a valid url/i.test(lower)) {
      userMessage = "قالب این لینک پشتیبانی نمی‌شود. لینک مستقیم و عمومی YouTube، Instagram، Facebook یا X را وارد کنید.";
    } else {
      const diagnostic = detail.replace(/https?:\/\/\S+/g, "[video-url]").replace(/\s+/g, " ").trim().slice(0, 240);
      userMessage = "دانلود ویدیو ناموفق شد. جزئیات فنی برای بررسی ثبت شد." + (diagnostic ? " علت گزارش‌شده: " + diagnostic : " لطفاً لینک عمومی دیگری را امتحان کنید.");
    }
    if (current && current.status !== "completed") {
      current.status = "failed";
      current.progress = 0;
      current.message = userMessage;
      current.updatedAt = Date.now();
    }
    const names = await fs.promises.readdir(os.tmpdir()).catch(() => []);
    for (const name of names.filter(n => n.startsWith("social-" + jobId + "."))) await fs.promises.unlink(path.join(os.tmpdir(), name)).catch(() => {});
  }
}
app.post("/api/translate-url", (req, res) => {
  let url;
  try { url = validateVideoUrl(req.body?.url); } catch (error) { return res.status(400).json({ success: false, message: error.message }); }
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ success: false, message: "کلید Gemini در سرور تنظیم نشده است." });
  const id = crypto.randomUUID();
  jobs.set(id, { status: "processing", message: "درخواست دریافت لینک ثبت شد.", progress: 5, srt: null, sourceUrl: url, updatedAt: Date.now() });
  res.status(202).json({ success: true, jobId: id, status: "processing" });
  downloadAndTranslate(id, url).catch(error => console.error("Unexpected link job error:", error));
});
app.get("/api/jobs/:id/original", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.videoPath || !fs.existsSync(job.videoPath)) return res.status(404).json({ success: false, message: "فایل اصلی پیدا نشد." });
  res.download(job.videoPath, "original-video.mp4");
});

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


function muxDubbedVideo(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = ["-y", "-i", videoPath, "-i", audioPath, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", outputPath];
    const child = spawn(ffmpegPath, args);
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error("ساخت ویدیوی MP4 ناموفق شد: " + stderr.slice(-700))));
  });
}

app.post("/api/dub", async (req, res) => {
  try {
    const srt = String(req.body?.srt || "").slice(0, 12000);
    const sourceJob = jobs.get(String(req.body?.jobId || ""));
    const language = "فارسی معیار";
    if (!srt.trim()) return res.status(400).json({ success: false, message: "اول زیرنویس را تولید کنید." });
    if (!process.env.GEMINI_API_KEY) return res.status(503).json({ success: false, message: "کلید Gemini تنظیم نشده است." });
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const plainText = srt
      .replace(/^\s*\d+\s*$/gm, "")
      .replace(/^\s*\d{2}:\d{2}:\d{2},\d{3}\s*-->.*$/gm, "")
      .replace(/\r/g, "")
      .split("\n").map(line => line.trim()).filter(Boolean).join(" ");
    if (!plainText) return res.status(400).json({ success: false, message: "متن زیرنویس خالی است." });
    const translated = await withGeminiRetry("Dub text translation", () => ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: "این متن زیرنویس را به " + language + " روان و طبیعی ترجمه کن. فقط متن ترجمه‌شده را برگردان، بدون توضیح و بدون زمان‌بندی:\n\n" + plainText,
      config: { temperature: 0.2 }
    }));
    const speechText = String(translated.text || "").trim();
    if (!speechText) throw new Error("ترجمه برای دوبله تولید نشد.");
    const speech = await withGeminiRetry("Dub audio generation", () => ai.interactions.create({
      model: "gemini-3.8-flash-tts",
      input: [{ type: "user_input", content: [{ type: "text", text: speechText }] }],
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice: "Kore" }] }
    }));
    const audioBase64 = speech.output_audio?.data;
    if (!audioBase64) throw new Error("فایل صوتی از Gemini دریافت نشد.");
    const id = crypto.randomUUID();
    const audioPath = path.join(os.tmpdir(), "dub-" + id + ".wav");
    const audioBuffer = Buffer.from(audioBase64, "base64");
    if (audioBuffer.length < 44 || audioBuffer.toString("ascii", 0, 4) !== "RIFF" || audioBuffer.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error("خروجی صوتی Gemini فایل WAV معتبر نیست؛ دوباره تلاش کنید.");
    }
    await fs.promises.writeFile(audioPath, audioBuffer);
    const dubJob = { status: "completed", audioPath, updatedAt: Date.now() };
    let videoUrl = null;
    if (sourceJob?.videoPath && fs.existsSync(sourceJob.videoPath)) {
      const outputVideoPath = path.join(os.tmpdir(), "translated-" + id + ".mp4");
      await muxDubbedVideo(sourceJob.videoPath, audioPath, outputVideoPath);
      dubJob.outputVideoPath = outputVideoPath;
      sourceJob.outputVideoPath = outputVideoPath;
      videoUrl = "/api/dubs/" + id + "/video";
    }
    jobs.set("dub-" + id, dubJob);
    res.json({ success: true, audioUrl: "/api/dubs/" + id + "/audio", videoUrl, message: videoUrl ? "ویدیوی دوبله‌شده آمادهٔ دانلود است." : "فایل صوتی آماده شد؛ فایل ویدیوی اصلی برای ترکیب پیدا نشد." });
  } catch (error) {
    console.error("Dubbing failed:", error);
    const status = Number(error?.status || error?.code || error?.response?.status || 0);
    const message = status === 503
      ? "سرویس ساخت صدای گوگل فعلاً شلوغ است. سرور چند بار تلاش کرد؛ لطفاً چند دقیقه بعد دوباره دوبله را بزنید."
      : status === 429
        ? "سهمیهٔ درخواست‌های سرویس گوگل موقتاً پُر شده است. کمی بعد دوباره تلاش کنید."
        : (error.message || "ساخت دوبله ناموفق شد.");
    res.status(502).json({ success: false, message });
  }
});

app.get("/api/dubs/:id/audio", async (req, res) => {
  const job = jobs.get("dub-" + req.params.id);
  if (!job?.audioPath) return res.status(404).json({ success: false, message: "فایل دوبله پیدا نشد." });
  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Content-Disposition", 'attachment; filename="video-dub.wav"');
  res.sendFile(job.audioPath);
});

app.get("/api/dubs/:id/video", (req, res) => {
  const job = jobs.get("dub-" + req.params.id);
  if (!job?.outputVideoPath || !fs.existsSync(job.outputVideoPath)) {
    return res.status(404).json({ success: false, message: "ویدیوی نهایی پیدا نشد." });
  }
  res.download(job.outputVideoPath, "translated-video.mp4");
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ success: false, message: "درخواست پیدا نشد یا سرور دوباره راه‌اندازی شده است." });
  res.json({
    success: job.status !== "failed",
    status: job.status,
    progress: job.status === "completed" ? 100 : (job.progress || 0),
    message: job.message,
    srt: job.status === "completed" ? job.srt : undefined,
    sourceUrl: job.sourceUrl || undefined
  });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ success: false, message: "اندازه فایل نباید بیشتر از ۱ گیگابایت باشد." });
  }
  res.status(400).json({ success: false, message: err.message || "در دریافت فایل خطا رخ داد." });
});

const PORT = process.env.PORT || 3000;

// Refresh the bundled yt-dlp executable at startup so deployments do not
// keep using a stale extractor. A refresh failure must not take the API offline.
async function refreshYoutubeDl() {
  try {
    await youtubeDlPackage.update();
    console.log("yt-dlp executable refreshed from the official release channel.");
  } catch (error) {
    console.error("Could not refresh yt-dlp; continuing with bundled executable:", error?.message || error);
  }
}

app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
refreshYoutubeDl();
