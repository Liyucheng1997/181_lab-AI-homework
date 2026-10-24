// AI 作业智能批改系统 —— 本地服务
// 业务逻辑在 public/shared/store.js（与纯网页版共用），这里只负责：数据存文件、照片存磁盘、HTTP 路由
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createStore, HttpError, IMAGE_TYPES } from "./public/shared/store.js";
import { MODEL } from "./public/shared/grader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const DB_FILE = path.join(DATA_DIR, "db.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- 极简 JSON 存储 ----------
function readJson(file, fallback, label) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    console.warn(`${label} 解析失败，使用默认值`);
    return fallback;
  }
}
const db = readJson(DB_FILE, { classes: [], assignments: [], submissions: [] }, "db.json");
// AI 设置（网页里填写的 API Key，仅存本机 data/settings.json）
const settings = readJson(SETTINGS_FILE, { apiKey: "", baseURL: "", effort: "high" }, "settings.json");

const MEDIA_TYPES = { ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };
const store = createStore({
  db,
  settings,
  envKey: process.env.ANTHROPIC_API_KEY,
  envBaseURL: process.env.ANTHROPIC_BASE_URL,
  saveDb: () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)),
  saveSettings: () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)),
  // multer 已把照片写进 uploads/，这里只返回文件名
  saveImage: async (file) => file.name,
  readImage: async (name) => ({
    base64: fs.readFileSync(path.join(UPLOAD_DIR, name)).toString("base64"),
    mediaType: MEDIA_TYPES[path.extname(name).toLowerCase()] || "image/jpeg"
  }),
  deleteImage: async (name) => fs.unlinkSync(path.join(UPLOAD_DIR, name))
});

// ---------- 上传 ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
      cb(null, `${Date.now()}_${crypto.randomUUID().slice(0, 8)}${ext}`);
    }
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = IMAGE_TYPES.includes(file.mimetype);
    cb(ok ? null : new HttpError(400, "仅支持 jpg / png / webp / gif 图片"), ok);
  }
});

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR));
app.use("/vendor", express.static(path.join(__dirname, "node_modules/chart.js/dist")));

app.all(/^\/api\//, upload.single("image"), async (req, res) => {
  const file = req.file && { name: req.file.filename, type: req.file.mimetype };
  try {
    res.json(await store.handle(req.method, req.path, req.body, file));
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// multer 的文件类型 / 大小错误
app.use((err, req, res, next) => {
  const msg = err.code === "LIMIT_FILE_SIZE" ? "图片不能超过 15MB" : err.message;
  res.status(err.status || 400).json({ error: msg });
});

const PORT = process.env.PORT || 3170;
app.listen(PORT, () => {
  console.log(`AI 作业批改系统已启动: http://localhost:${PORT}`);
  console.log(`AI 批改: ${store.hasApiKey() ? `已启用 (${MODEL})` : "未配置 API Key，可在网页「AI 设置」中填写"}`);
});
