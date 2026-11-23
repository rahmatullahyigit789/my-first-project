const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
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
  translation: "video-to-dari-srt"
}));

function srtClean(value) {
  return String(value || "").replace(/\x60{3}(?:srt)?/gi, "").trim();
}

app.post("/api/translate", upload.single("video"), async (req, res) => {
  const tempPath = req.file?.path;
  let remoteFile;
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({ success: false, message: "کلید Gemini در سرور تنظیم نشده است." });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: "لطفاً فایل ویدیویی را انتخاب کنید. دریافت مستقیم لینک شبکه‌های اجتماعی هنوز فعال نیست." });
    }

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    remoteFile = await ai.files.upload({
      file: tempPath,
      config: { mimeType: req.file.mimetype, displayName: req.file.originalname }
    });

    let status = remoteFile.state;
    for (let i = 0; i < 60 && status !== "ACTIVE"; i++) {
      if (status === "FAILED") throw new Error("پردازش فایل ویدیویی توسط Gemini ناموفق شد.");
      await new Promise(resolve => setTimeout(resolve, 2000));
      remoteFile = await ai.files.get({ name: remoteFile.name });
      status = remoteFile.state;
    }
    if (status !== "ACTIVE") throw new Error("آماده‌سازی ویدیو بیش از حد طول کشید؛ دوباره تلاش کنید.");

    const prompt = `گفتار ویدیوی پیوست را با حفظ ترتیب و زمان‌بندی به زبان دری افغانستان ترجمه کن. فقط زیرنویس SRT معتبر برگردان؛ هیچ توضیح اضافه نده. شماره هر قطعه، زمان شروع و پایان با قالب HH:MM:SS,mmm و متن طبیعی دری باشد. زمان‌ها باید با گفتار واقعی هماهنگ باشند. اگر بخشی گفتار ندارد، برای آن زیرنویس نساز. زبان اصلی را خودت تشخیص بده.`;
    let result;
    let lastModelError;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        result = await ai.models.generateContent({
          model: "gemini-3.8-flash",
          contents: [createPartFromUri(remoteFile.uri, remoteFile.mimeType), prompt],
          config: { temperature: 0.2 }
        });
        lastModelError = null;
        break;
      } catch (modelError) {
        lastModelError = modelError;
        const status = Number(modelError.status || modelError.code || 0);
        const retryable = [429, 500, 502, 503, 504].includes(status);
        if (!retryable || attempt === 3) throw modelError;
        await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
      }
    }
    if (lastModelError || !result) throw lastModelError || new Error("پاسخی از Gemini دریافت نشد.");
    const srt = srtClean(result.text);
    if (!srt || !/\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/.test(srt)) {
      throw new Error("Gemini زیرنویس SRT معتبر تولید نکرد. لطفاً ویدیوی کوتاه‌تری آزمایش کنید.");
    }
    res.json({ success: true, status: "translated", language: "دری افغانستان", srt });
  } catch (error) {
    console.error("Translation error:", error);
    const status = Number(error.status || error.code || 0);
    const httpStatus = [429, 500, 502, 503, 504].includes(status) ? 503 : 500;
    const message = httpStatus === 503
      ? "سرویس هوش مصنوعی فعلاً شلوغ است. چند دقیقه بعد دوباره تلاش کنید."
      : (error.message || "در ترجمه ویدیو خطا رخ داد.");
    res.status(httpStatus).json({ success: false, message });
  } finally {
    if (tempPath) fs.promises.unlink(tempPath).catch(() => {});
    if (remoteFile?.name && process.env.GEMINI_API_KEY) {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      ai.files.delete({ name: remoteFile.name }).catch(() => {});
    }
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ success: false, message: "اندازه فایل نباید بیشتر از ۱ گیگابایت باشد." });
  }
  res.status(400).json({ success: false, message: err.message || "در دریافت فایل خطا رخ داد." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
