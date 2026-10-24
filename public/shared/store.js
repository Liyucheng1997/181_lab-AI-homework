// 班级 / 作业 / 提交 / AI 设置的业务逻辑
// 本机服务端（server.js）和纯网页版（static-backend.js）共用：两边只负责「数据存哪儿、照片存哪儿」
import { gradeWithAI, mockGrade, normalizeResults, verifyApiKey, describeError, MODEL, EFFORTS } from "./grader.js";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const uid = () => crypto.randomUUID().slice(0, 8);
const maskKey = (k) => (k ? `${k.slice(0, 7)}••••${k.slice(-4)}` : "");

/**
 * io: {
 *   db, saveDb(),                       // 数据对象与持久化
 *   settings, saveSettings(),           // { apiKey, baseURL, effort, remember }
 *   envKey, envBaseURL,                 // 环境变量（仅服务端）
 *   saveImage(file) -> name, readImage(name) -> { base64, mediaType }, deleteImage(name),
 *   browser                             // 是否为纯网页版
 * }
 */
export function createStore(io) {
  const db = io.db;
  const settings = io.settings;

  // 网页填写的 Key 优先，其次是环境变量
  const activeKey = () => settings.apiKey || io.envKey || "";
  const activeBaseURL = () => settings.baseURL || io.envBaseURL || "";
  const hasApiKey = () => Boolean(activeKey());
  const publicSettings = () => ({
    mode: io.browser ? "browser" : "server",
    hasApiKey: hasApiKey(),
    keySource: settings.apiKey ? "web" : io.envKey ? "env" : "",
    keyMasked: maskKey(activeKey()),
    baseURL: settings.baseURL,
    effort: settings.effort,
    remember: settings.remember !== false,
    model: MODEL
  });

  const findClass = (id) => {
    const cls = db.classes.find((c) => c.id === id);
    if (!cls) throw new HttpError(404, "班级不存在");
    return cls;
  };
  const normQuestions = (questions) =>
    questions.map((q, i) => ({
      no: String(q.no || i + 1),
      answer: String(q.answer || "").trim(),
      points: Number(q.points) || 0
    }));
  const dropImage = async (name) => {
    try {
      await io.deleteImage(name);
    } catch {}
  };

  const routes = {
    // ---------- 通用 ----------
    "GET /api/health": () => ({ ok: true, ...publicSettings() }),
    "GET /api/state": () => db,
    "GET /api/settings": () => publicSettings(),

    "PUT /api/settings": async ({ body }) => {
      const { apiKey, baseURL, effort, clearKey, remember } = body;
      const next = { ...settings };
      if (typeof baseURL === "string") next.baseURL = baseURL.trim().replace(/\/+$/, "");
      if (EFFORTS.includes(effort)) next.effort = effort;
      if (typeof remember === "boolean") next.remember = remember;
      if (clearKey) next.apiKey = "";
      if (typeof apiKey === "string" && apiKey.trim()) next.apiKey = apiKey.trim();
      // 换了 Key 或地址时先实际连一次，避免存进去一个用不了的 Key
      const keyChanged = next.apiKey !== settings.apiKey || next.baseURL !== settings.baseURL;
      const key = next.apiKey || io.envKey;
      if (keyChanged && key) {
        try {
          await verifyApiKey({ apiKey: key, baseURL: next.baseURL || io.envBaseURL });
        } catch (err) {
          throw new HttpError(400, describeError(err));
        }
      }
      Object.assign(settings, next);
      io.saveSettings();
      return publicSettings();
    },

    // ---------- 班级与学生 ----------
    "POST /api/classes": ({ body }) => {
      const name = String(body.name || "").trim();
      if (!name) throw new HttpError(400, "班级名称不能为空");
      const cls = { id: uid(), name, students: [] };
      db.classes.push(cls);
      io.saveDb();
      return cls;
    },

    "PUT /api/classes/:id": ({ params, body }) => {
      const cls = findClass(params.id);
      if (body.name) cls.name = String(body.name).trim();
      io.saveDb();
      return cls;
    },

    "DELETE /api/classes/:id": async ({ params }) => {
      const cls = findClass(params.id);
      const asgIds = db.assignments.filter((a) => a.classId === cls.id).map((a) => a.id);
      for (const s of db.submissions.filter((s) => asgIds.includes(s.assignmentId))) await dropImage(s.image);
      db.submissions = db.submissions.filter((s) => !asgIds.includes(s.assignmentId));
      db.assignments = db.assignments.filter((a) => a.classId !== cls.id);
      db.classes = db.classes.filter((c) => c.id !== cls.id);
      io.saveDb();
      return { ok: true };
    },

    "POST /api/classes/:id/students": ({ params, body }) => {
      const cls = findClass(params.id);
      // 支持批量：body.list = [{name,no}]，或单个 {name,no}
      const list = Array.isArray(body.list) ? body.list : [body];
      const added = [];
      for (const item of list) {
        const name = String(item.name || "").trim();
        if (!name) continue;
        const stu = { id: uid(), name, no: String(item.no || "").trim() };
        cls.students.push(stu);
        added.push(stu);
      }
      if (!added.length) throw new HttpError(400, "没有有效的学生信息");
      io.saveDb();
      return added;
    },

    "DELETE /api/classes/:id/students/:sid": async ({ params }) => {
      const cls = findClass(params.id);
      cls.students = cls.students.filter((s) => s.id !== params.sid);
      for (const s of db.submissions.filter((s) => s.studentId === params.sid)) await dropImage(s.image);
      db.submissions = db.submissions.filter((s) => s.studentId !== params.sid);
      io.saveDb();
      return { ok: true };
    },

    // ---------- 作业（含标准答案） ----------
    "POST /api/assignments": ({ body }) => {
      const { classId, name, date, questions } = body;
      if (!db.classes.find((c) => c.id === classId)) throw new HttpError(400, "请选择班级");
      if (!name || !Array.isArray(questions) || !questions.length)
        throw new HttpError(400, "作业名称与题目不能为空");
      const asg = {
        id: uid(),
        classId,
        name: String(name).trim(),
        date: date || new Date().toISOString().slice(0, 10),
        questions: normQuestions(questions)
      };
      db.assignments.push(asg);
      io.saveDb();
      return asg;
    },

    "PUT /api/assignments/:id": ({ params, body }) => {
      const asg = db.assignments.find((a) => a.id === params.id);
      if (!asg) throw new HttpError(404, "作业不存在");
      const { name, date, questions } = body;
      if (name) asg.name = String(name).trim();
      if (date) asg.date = date;
      if (Array.isArray(questions) && questions.length) asg.questions = normQuestions(questions);
      io.saveDb();
      return asg;
    },

    "DELETE /api/assignments/:id": async ({ params }) => {
      for (const s of db.submissions.filter((s) => s.assignmentId === params.id)) await dropImage(s.image);
      db.submissions = db.submissions.filter((s) => s.assignmentId !== params.id);
      db.assignments = db.assignments.filter((a) => a.id !== params.id);
      io.saveDb();
      return { ok: true };
    },

    // ---------- 作业提交（上传图片） ----------
    "POST /api/submissions": async ({ body, file }) => {
      const { assignmentId, studentId } = body;
      const asg = db.assignments.find((a) => a.id === assignmentId);
      if (!asg) throw new HttpError(400, "作业不存在");
      if (!file) throw new HttpError(400, "请上传作业图片");
      if (!IMAGE_TYPES.includes(file.type)) throw new HttpError(400, "仅支持 jpg / png / webp / gif 图片");
      const image = await io.saveImage(file);
      // 同一学生同一作业重复上传：覆盖旧的
      const old = db.submissions.find((s) => s.assignmentId === assignmentId && s.studentId === studentId);
      if (old) {
        await dropImage(old.image);
        db.submissions = db.submissions.filter((s) => s.id !== old.id);
      }
      const sub = {
        id: uid(),
        assignmentId,
        studentId,
        image,
        status: "pending",
        results: null,
        overallComment: "",
        totalScore: 0,
        gradedAt: null
      };
      db.submissions.push(sub);
      io.saveDb();
      return sub;
    },

    "DELETE /api/submissions/:id": async ({ params }) => {
      const sub = db.submissions.find((s) => s.id === params.id);
      if (sub) {
        await dropImage(sub.image);
        db.submissions = db.submissions.filter((s) => s.id !== sub.id);
        io.saveDb();
      }
      return { ok: true };
    },

    // ---------- AI 批改 ----------
    "POST /api/submissions/:id/grade": async ({ params, body }) => {
      const sub = db.submissions.find((s) => s.id === params.id);
      if (!sub) throw new HttpError(404, "提交不存在");
      const asg = db.assignments.find((a) => a.id === sub.assignmentId);
      const cls = db.classes.find((c) => c.id === asg?.classId);
      const stu = cls?.students.find((s) => s.id === sub.studentId);
      if (!asg || !stu) throw new HttpError(400, "关联的作业或学生不存在");

      let raw;
      if (body.mock === true) {
        raw = mockGrade({ questions: asg.questions });
      } else {
        if (!hasApiKey())
          throw new HttpError(400, "还没有填写 API Key，请先在左下角「AI 设置」里填写。也可以先用「模拟批改」体验流程。");
        try {
          const { base64, mediaType } = await io.readImage(sub.image);
          raw = await gradeWithAI({
            apiKey: activeKey(),
            baseURL: activeBaseURL(),
            effort: settings.effort,
            imageBase64: base64,
            mediaType,
            studentName: stu.name,
            questions: asg.questions
          });
        } catch (err) {
          console.error("批改失败:", err);
          throw new HttpError(500, `批改失败：${describeError(err)}`);
        }
      }
      sub.results = normalizeResults(asg, raw);
      sub.overallComment = String(raw.overall_comment || "");
      sub.totalScore = sub.results.reduce((s, r) => s + r.score, 0);
      sub.status = "graded";
      sub.gradedAt = new Date().toISOString();
      io.saveDb();
      return sub;
    },

    // 老师手动调整批改结果（改判定/分数/批注/标记位置）
    "PUT /api/submissions/:id": ({ params, body }) => {
      const sub = db.submissions.find((s) => s.id === params.id);
      if (!sub) throw new HttpError(404, "提交不存在");
      const { results, overallComment, scorePos } = body;
      if (scorePos && typeof scorePos.x === "number" && typeof scorePos.y === "number") {
        sub.scorePos = { x: scorePos.x, y: scorePos.y };
      }
      if (Array.isArray(results)) {
        sub.results = results.map((r) => {
          const points = Number(r.points) || 0;
          const score = Math.min(points, Math.max(0, Number(r.score) || 0));
          return { ...r, points, score };
        });
        sub.totalScore = sub.results.reduce((s, r) => s + r.score, 0);
      }
      if (typeof overallComment === "string") sub.overallComment = overallComment;
      io.saveDb();
      return sub;
    }
  };

  // "PUT /api/classes/:id" → { method, regex }
  const table = Object.entries(routes).map(([key, fn]) => {
    const [method, pattern] = key.split(" ");
    const regex = new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$");
    return { method, regex, fn };
  });

  async function handle(method, path, body = {}, file = null) {
    for (const r of table) {
      if (r.method !== method) continue;
      const m = r.regex.exec(path);
      if (m) return r.fn({ params: m.groups || {}, body: body || {}, file });
    }
    throw new HttpError(404, "接口不存在");
  }

  return { handle, hasApiKey, activeKey };
}
