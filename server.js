const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 1024 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    if (!file.mimetype || !file.mimetype.startsWith("video/")) {
      return callback(new Error("فقط فایل ویدیویی پذیرفته می‌شود."));
    }
    callback(null, true);
  }
});

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "Video Translator is running" });
});

// This endpoint safely receives a video file. Translation is a separate future step.
app.post("/api/intake", upload.single("video"), (req, res) => {
  if (req.file) {
    return res.status(202).json({
      success: true,
      status: "received",
      message: "ویدیو دریافت شد؛ موتور ترجمه هنوز وصل نشده است.",
      file: { originalName: req.file.originalname, size: req.file.size }
    });
  }

  const videoUrl = typeof req.body.videoUrl === "string" ? req.body.videoUrl.trim() : "";
  if (!videoUrl) {
    return res.status(400).json({ success: false, message: "لینک یا فایل ویدیو لازم است." });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(videoUrl);
  } catch {
    return res.status(400).json({ success: false, message: "لینک ویدیو معتبر نیست." });
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return res.status(400).json({ success: false, message: "فقط لینک‌های HTTP یا HTTPS پذیرفته می‌شوند." });
  }

  return res.status(202).json({
    success: true,
    status: "link_received",
    message: "لینک دریافت شد؛ دریافت خودکار از شبکه‌های اجتماعی هنوز فعال نشده است."
  });
});

app.post("/api/translate", (req, res) => {
  res.status(501).json({
    success: false,
    message: "موتور هوش مصنوعی ترجمه و دوبله هنوز تنظیم نشده است."
  });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ success: false, message: "اندازه فایل نباید بیشتر از ۱ گیگابایت باشد." });
  }
  if (err) {
    return res.status(400).json({ success: false, message: err.message || "در دریافت فایل خطا رخ داد." });
  }
  next();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
