// AI 批改核心：把作业照片 + 标准答案交给 Claude 视觉模型，返回逐题批改结果
// 本机服务端（Node）和纯网页版（浏览器）共用这一份代码
export const MODEL = "claude-opus-5-5";
export const EFFORTS = ["low", "medium", "high", "xhigh"];

const IN_BROWSER = typeof window !== "undefined";

// SDK 按需加载：Node 从 node_modules 解析，浏览器通过 index.html 的 importmap 指向打包好的 vendor 文件
let Anthropic = null;
async function loadSDK() {
  if (!Anthropic) Anthropic = (await import("@anthropic-ai/sdk")).default;
  return Anthropic;
}
function makeClient(SDK, { apiKey, baseURL }, extra = {}) {
  // 浏览器直连时 SDK 需要显式同意（Key 由老师自己填写、只发往 Claude API）
  return new SDK({ apiKey, ...(baseURL ? { baseURL } : {}), ...(IN_BROWSER ? { dangerouslyAllowBrowser: true } : {}), ...extra });
}

// 按「Key + 地址」缓存客户端，网页里改了 Key 后自动换新
let cached = { sig: "", client: null };
async function getClient(opts) {
  const SDK = await loadSDK();
  const sig = `${opts.apiKey}|${opts.baseURL || ""}`;
  if (cached.sig !== sig) cached = { sig, client: makeClient(SDK, opts) };
  return cached.client;
}

// 校验 Key：查询一次模型信息，不产生 token 费用
export async function verifyApiKey(opts) {
  const SDK = await loadSDK();
  await makeClient(SDK, opts, { maxRetries: 0 }).models.retrieve(MODEL);
}

// 把 SDK 的错误翻译成老师看得懂的中文
export function describeError(err) {
  const SDK = Anthropic;
  if (SDK) {
    if (err instanceof SDK.AuthenticationError) return "API Key 无效或已被撤销，请在「AI 设置」里重新填写";
    if (err instanceof SDK.PermissionDeniedError) return "该 API Key 没有调用 Claude Opus 5.5 的权限";
    if (err instanceof SDK.NotFoundError) return "接口地址或模型不可用，请检查「API 地址」设置";
    if (err instanceof SDK.RateLimitError) return "请求太频繁或额度不足，请稍后再试";
    if (err instanceof SDK.BadRequestError) return `请求被拒绝：${err.message}`;
    if (err instanceof SDK.APIConnectionError) return "无法连接到 Claude API，请检查网络或「API 地址」设置";
    if (err instanceof SDK.APIError) return `Claude API 出错（${err.status ?? "未知"}）：${err.message}`;
  }
  return err?.message || String(err);
}

// 结构化输出 schema：保证模型必定返回可解析的 JSON
const RESULT_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          no: { type: "string", description: "题号，与标准答案中的题号一致" },
          student_answer: { type: "string", description: "识别出的学生手写答案原文，无法辨认写空字符串" },
          verdict: { type: "string", enum: ["correct", "wrong", "partial", "unclear"] },
          score: { type: "number", description: "该题得分，不超过该题满分" },
          comment: { type: "string", description: "简短中文批注，答对时留空" },
          x: { type: "integer", description: "标记位置横坐标，0-1000 相对图片宽度" },
          y: { type: "integer", description: "标记位置纵坐标，0-1000 相对图片高度" }
        },
        required: ["no", "student_answer", "verdict", "score", "comment", "x", "y"],
        additionalProperties: false
      }
    },
    overall_comment: { type: "string", description: "一句话总评，老师手写评语口吻" }
  },
  required: ["questions", "overall_comment"],
  additionalProperties: false
};

function buildPrompt(studentName, questions) {
  const total = questions.reduce((s, q) => s + Number(q.points || 0), 0);
  const lines = questions
    .map((q) => `第${q.no}题（${q.points}分）：${q.answer}`)
    .join("\n");
  return `这是学生「${studentName}」的一页作业照片，请像一位认真负责的老师一样批改。

【标准答案】共 ${questions.length} 题，总分 ${total} 分：
${lines}

【批改要求】
1. 在图片中逐题找到学生的手写答案并尽力辨认（可能有涂改、字迹潦草）。
2. 与标准答案对比判定：
   - 完全正确（含等价写法，如 0.5 与 1/2、单位换算正确等）→ verdict=correct，给满分；
   - 部分正确（思路对但结果错、答案不完整、漏单位等）→ verdict=partial，酌情给分；
   - 错误 → verdict=wrong，0 分；
   - 图中找不到该题或完全无法辨认 → verdict=unclear，0 分。
3. 每题给出批改标记的落点坐标 x、y：0-1000 的归一化坐标（x 相对图片宽度，y 相对图片高度），落在该题学生答案**右侧的空白处**，尽量贴近该题答案所在行，各题标记不要重叠。
4. comment 仅在 partial / wrong / unclear 时写一句非常简短的中文批注（例如"粗心了""方法对，计算错了""再检查单位"），答对的题留空。
5. overall_comment 写一句总评，口吻像老师随手写在作业上的评语（例如"字迹工整，继续保持！""基础不错，计算要细心"）。`;
}

export async function gradeWithAI({ apiKey, baseURL, effort, imageBase64, mediaType, studentName, questions }) {
  const client = await getClient({ apiKey, baseURL });
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: EFFORTS.includes(effort) ? effort : "high",
      format: { type: "json_schema", schema: RESULT_SCHEMA }
    },
    // 安全分类器偶尔误拒时，由服务端自动换用推荐的备用模型重试
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system:
      "你是一位有二十年教龄、经验丰富的老师，正在批改学生的纸质作业照片。你识别手写文字的能力很强，评分公正，批注简洁、有温度。",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: imageBase64 }
          },
          { type: "text", text: buildPrompt(studentName, questions) }
        ]
      }
    ]
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") {
    throw new Error("模型拒绝了本次请求，请检查图片内容后重试");
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("批改输出过长被截断，请把作业拆成多张照片后重试");
  }
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("模型未返回批改结果");
  return JSON.parse(textBlock.text);
}

// 模拟批改：不消耗 API，用于试用界面和演示
export function mockGrade({ questions }) {
  const verdictPool = [
    "correct", "correct", "correct", "correct", "correct",
    "partial", "wrong", "correct", "wrong", "correct"
  ];
  const partialComments = ["方法对，计算错了", "答案不完整", "漏了单位", "思路对，再细心些"];
  const wrongComments = ["再想一想", "粗心了", "审题要仔细", "回去复习这一课"];
  const overall = [
    "字迹工整，继续保持！",
    "基础不错，计算要细心。",
    "有进步，再加把劲！",
    "认真完成了，注意易错点。"
  ];
  const n = questions.length;
  const results = questions.map((q, i) => {
    const verdict = verdictPool[Math.floor(Math.random() * verdictPool.length)];
    const points = Number(q.points || 0);
    let score = 0;
    if (verdict === "correct") score = points;
    else if (verdict === "partial") score = Math.max(1, Math.round(points / 2));
    const comment =
      verdict === "partial"
        ? partialComments[Math.floor(Math.random() * partialComments.length)]
        : verdict === "wrong"
          ? wrongComments[Math.floor(Math.random() * wrongComments.length)]
          : "";
    return {
      no: String(q.no),
      student_answer: verdict === "correct" ? String(q.answer) : "（模拟识别）",
      verdict,
      score,
      comment,
      x: 680 + Math.floor(Math.random() * 160),
      y: Math.round(120 + (i * 780) / Math.max(1, n)) + Math.floor(Math.random() * 30)
    };
  });
  return {
    questions: results,
    overall_comment: overall[Math.floor(Math.random() * overall.length)]
  };
}

// 把 AI 返回的结果与题目合并，并裁剪分数
export function normalizeResults(asg, raw) {
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
