// AI 作业智能批改系统 —— 本地服务
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { gradeWithAI, mockGrade, hasApiKey } from "./lib/grader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const DB_FILE = path.join(DATA_DIR, "db.json");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- 极简 JSON 存储 ----------
let db = { classes: [], assignments: [], submissions: [] };
if (fs.existsSync(DB_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    console.warn("db.json 解析失败，使用空数据库");
  }
}
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const uid = () => crypto.randomUUID().slice(0, 8);

// ---------- 上传 ----------
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    cb(null, `${Date.now()}_${uid()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.mimetype);
    cb(ok ? null : new Error("仅支持 jpg / png / webp / gif 图片"), ok);
  }
});

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR));
app.use("/vendor", express.static(path.join(__dirname, "node_modules/chart.js/dist")));

// ---------- 通用 ----------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, hasApiKey: hasApiKey(), model: process.env.GRADER_MODEL || "claude-opus-4-8" });
});

app.get("/api/state", (req, res) => res.json(db));

// ---------- 班级与学生 ----------
app.post("/api/classes", (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "班级名称不能为空" });
  const cls = { id: uid(), name, students: [] };
  db.classes.push(cls);
  save();
  res.json(cls);
});

app.put("/api/classes/:id", (req, res) => {
  const cls = db.classes.find((c) => c.id === req.params.id);
  if (!cls) return res.status(404).json({ error: "班级不存在" });
  if (req.body.name) cls.name = String(req.body.name).trim();
  save();
  res.json(cls);
});

app.delete("/api/classes/:id", (req, res) => {
  const cls = db.classes.find((c) => c.id === req.params.id);
  if (!cls) return res.status(404).json({ error: "班级不存在" });
  const asgIds = db.assignments.filter((a) => a.classId === cls.id).map((a) => a.id);
  db.submissions = db.submissions.filter((s) => !asgIds.includes(s.assignmentId));
  db.assignments = db.assignments.filter((a) => a.classId !== cls.id);
  db.classes = db.classes.filter((c) => c.id !== cls.id);
  save();
  res.json({ ok: true });
});

app.post("/api/classes/:id/students", (req, res) => {
  const cls = db.classes.find((c) => c.id === req.params.id);
  if (!cls) return res.status(404).json({ error: "班级不存在" });
  // 支持批量：body.list = [{name,no}]，或单个 {name,no}
  const list = Array.isArray(req.body.list) ? req.body.list : [req.body];
  const added = [];
  for (const item of list) {
    const name = String(item.name || "").trim();
    if (!name) continue;
    const stu = { id: uid(), name, no: String(item.no || "").trim() };
    cls.students.push(stu);
    added.push(stu);
  }
  if (!added.length) return res.status(400).json({ error: "没有有效的学生信息" });
  save();
  res.json(added);
});

app.delete("/api/classes/:id/students/:sid", (req, res) => {
  const cls = db.classes.find((c) => c.id === req.params.id);
  if (!cls) return res.status(404).json({ error: "班级不存在" });
  cls.students = cls.students.filter((s) => s.id !== req.params.sid);
  db.submissions = db.submissions.filter((s) => s.studentId !== req.params.sid);
  save();
  res.json({ ok: true });
});

// ---------- 作业（含标准答案） ----------
app.post("/api/assignments", (req, res) => {
  const { classId, name, date, questions } = req.body;
  if (!db.classes.find((c) => c.id === classId)) return res.status(400).json({ error: "请选择班级" });
  if (!name || !Array.isArray(questions) || !questions.length)
    return res.status(400).json({ error: "作业名称与题目不能为空" });
  const asg = {
    id: uid(),
    classId,
    name: String(name).trim(),
    date: date || new Date().toISOString().slice(0, 10),
    questions: questions.map((q, i) => ({
      no: String(q.no || i + 1),
      answer: String(q.answer || "").trim(),
      points: Number(q.points) || 0
    }))
  };
  db.assignments.push(asg);
  save();
  res.json(asg);
});

app.put("/api/assignments/:id", (req, res) => {
  const asg = db.assignments.find((a) => a.id === req.params.id);
  if (!asg) return res.status(404).json({ error: "作业不存在" });
  const { name, date, questions } = req.body;
  if (name) asg.name = String(name).trim();
  if (date) asg.date = date;
  if (Array.isArray(questions) && questions.length) {
    asg.questions = questions.map((q, i) => ({
      no: String(q.no || i + 1),
      answer: String(q.answer || "").trim(),
      points: Number(q.points) || 0
    }));
  }
  save();
  res.json(asg);
});

app.delete("/api/assignments/:id", (req, res) => {
  db.submissions = db.submissions.filter((s) => s.assignmentId !== req.params.id);
  db.assignments = db.assignments.filter((a) => a.id !== req.params.id);
  save();
  res.json({ ok: true });
});

// ---------- 作业提交（上传图片） ----------
app.post("/api/submissions", upload.single("image"), (req, res) => {
  const { assignmentId, studentId } = req.body;
  const asg = db.assignments.find((a) => a.id === assignmentId);
  if (!asg) return res.status(400).json({ error: "作业不存在" });
  if (!req.file) return res.status(400).json({ error: "请上传作业图片" });
  // 同一学生同一作业重复上传：覆盖旧的
  const old = db.submissions.find((s) => s.assignmentId === assignmentId && s.studentId === studentId);
  if (old) {
    try {
      fs.unlinkSync(path.join(UPLOAD_DIR, old.image));
    } catch {}
    db.submissions = db.submissions.filter((s) => s.id !== old.id);
  }
  const sub = {
    id: uid(),
    assignmentId,
    studentId,
    image: req.file.filename,
    status: "pending",
    results: null,
    overallComment: "",
    totalScore: 0,
    gradedAt: null
  };
  db.submissions.push(sub);
  save();
  res.json(sub);
});

app.delete("/api/submissions/:id", (req, res) => {
  const sub = db.submissions.find((s) => s.id === req.params.id);
  if (sub) {
    try {
      fs.unlinkSync(path.join(UPLOAD_DIR, sub.image));
    } catch {}
    db.submissions = db.submissions.filter((s) => s.id !== sub.id);
    save();
  }
  res.json({ ok: true });
});

// 把 AI 返回的结果与题目合并，并裁剪分数
function normalizeResults(asg, raw) {
  return asg.questions.map((q, i) => {
    const r =
      raw.questions.find((x) => String(x.no) === String(q.no)) || raw.questions[i] || {};
    const points = Number(q.points) || 0;
    let score = Math.min(points, Math.max(0, Number(r.score) || 0));
    let verdict = ["correct", "wrong", "partial", "unclear"].includes(r.verdict)
      ? r.verdict
      : "unclear";
    if (verdict === "correct") score = points;
    if (verdict === "wrong" || verdict === "unclear") score = 0;
    return {
      no: String(q.no),
      points,
      answer: q.answer,
      studentAnswer: String(r.student_answer || ""),
      verdict,
      score,
      comment: String(r.comment || ""),
      x: Math.min(1000, Math.max(0, Number(r.x) || 700)),
      y: Math.min(1000, Math.max(0, Number(r.y) || Math.round(100 + (i * 800) / asg.questions.length)))
    };
  });
}

// ---------- AI 批改 ----------
app.post("/api/submissions/:id/grade", async (req, res) => {
  const sub = db.submissions.find((s) => s.id === req.params.id);
  if (!sub) return res.status(404).json({ error: "提交不存在" });
  const asg = db.assignments.find((a) => a.id === sub.assignmentId);
  const cls = db.classes.find((c) => c.id === asg?.classId);
  const stu = cls?.students.find((s) => s.id === sub.studentId);
  if (!asg || !stu) return res.status(400).json({ error: "关联的作业或学生不存在" });

  const useMock = req.body?.mock === true;
  try {
    let raw;
    if (useMock) {
      raw = mockGrade({ questions: asg.questions });
    } else {
      if (!hasApiKey())
        return res.status(400).json({
          error: "未配置 ANTHROPIC_API_KEY，无法调用 AI 批改。可先用「模拟批改」体验流程。"
        });
      const imgPath = path.join(UPLOAD_DIR, sub.image);
      const imageBase64 = fs.readFileSync(imgPath).toString("base64");
      const ext = path.extname(sub.image).toLowerCase();
      const mediaType =
        ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/jpeg";
      raw = await gradeWithAI({
        imageBase64,
        mediaType,
        studentName: stu.name,
        questions: asg.questions
      });
    }
    sub.results = normalizeResults(asg, raw);
    sub.overallComment = String(raw.overall_comment || "");
    sub.totalScore = sub.results.reduce((s, r) => s + r.score, 0);
    sub.status = "graded";
    sub.gradedAt = new Date().toISOString();
    save();
    res.json(sub);
  } catch (err) {
    console.error("批改失败:", err);
    res.status(500).json({ error: `批改失败：${err.message || err}` });
  }
});

// 老师手动调整批改结果（改判定/分数/批注/标记位置）
app.put("/api/submissions/:id", (req, res) => {
  const sub = db.submissions.find((s) => s.id === req.params.id);
  if (!sub) return res.status(404).json({ error: "提交不存在" });
  const { results, overallComment, scorePos } = req.body;
  if (scorePos && typeof scorePos.x === "number" && typeof scorePos.y === "number") {
    sub.scorePos = { x: scorePos.x, y: scorePos.y };
  }
  if (Array.isArray(results)) {
    sub.results = results.map((r) => {
      const points = Number(r.points) || 0;
      let score = Math.min(points, Math.max(0, Number(r.score) || 0));
      return { ...r, points, score };
    });
    sub.totalScore = sub.results.reduce((s, r) => s + r.score, 0);
  }
  if (typeof overallComment === "string") sub.overallComment = overallComment;
  save();
  res.json(sub);
});

const PORT = process.env.PORT || 3170;
app.listen(PORT, () => {
  console.log(`AI 作业批改系统已启动: http://localhost:${PORT}`);
  console.log(`AI 批改: ${hasApiKey() ? "已启用 (" + (process.env.GRADER_MODEL || "claude-opus-4-8") + ")" : "未配置 ANTHROPIC_API_KEY，仅可使用模拟批改"}`);
});
