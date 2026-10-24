/* 作业帮 · AI 智能批改 —— 前端逻辑 */
(() => {
  "use strict";

  // ================== 全局状态 ==================
  let DB = { classes: [], assignments: [], submissions: [] };
  let HEALTH = { hasApiKey: false, model: "" };
  let currentReview = null; // { sub, asg, cls, stu }
  let charts = {}; // Chart.js 实例

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // ================== API ==================
  async function api(url, opts = {}) {
    const res = await fetch(url, {
      headers: opts.body instanceof FormData ? {} : { "Content-Type": "application/json" },
      ...opts,
      body: opts.body instanceof FormData ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  }
  async function reload() {
    DB = await api("/api/state");
  }

  // ================== 工具 ==================
  function toast(msg, isErr = false) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.toggle("err", isErr);
    t.classList.remove("hidden");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add("hidden"), 2600);
  }
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function findAsg(id) { return DB.assignments.find((a) => a.id === id); }
  function findCls(id) { return DB.classes.find((c) => c.id === id); }
  function findStu(clsId, stuId) { return findCls(clsId)?.students.find((s) => s.id === stuId); }
  function subOf(asgId, stuId) { return DB.submissions.find((s) => s.assignmentId === asgId && s.studentId === stuId); }
  function asgTotal(asg) { return asg.questions.reduce((s, q) => s + Number(q.points || 0), 0); }
  // 读取 CSS 设计变量（图表配色跟随浅色 / 深色主题）
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function alpha(hex, a) {
    const m = hex.replace("#", "");
    if (m.length !== 6) return hex;
    return `rgba(${parseInt(m.slice(0, 2), 16)},${parseInt(m.slice(2, 4), 16)},${parseInt(m.slice(4, 6), 16)},${a})`;
  }

  // 线性图标（lucide 风格，描边 1.75）
  const ICON_PATHS = {
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6M9 16h4"/>',
    pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    chart: '<path d="M3 3v18h18"/><path d="M18 17V9M13 17V5M8 17v-3"/>'
  };
  function icon(name, size = 18) {
    return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`;
  }
  function emptyHtml(iconName, text, extraStyle = "") {
    return `<div class="empty" ${extraStyle ? `style="${extraStyle}"` : ""}><div class="big">${icon(iconName, 34)}</div>${text}</div>`;
  }

  // 稳定的伪随机（同一标记每次渲染抖动一致，看起来像"写上去就固定了"）
  function seededRand(seedStr) {
    let h = 2166136261;
    for (const c of String(seedStr)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    return () => {
      h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
      return (h >>> 0) / 4294967296;
    };
  }

  // ================== 弹窗 ==================
  function openModal(html) {
    $("#modalBox").innerHTML = html;
    $("#modal").classList.remove("hidden");
  }
  function closeModal() { $("#modal").classList.add("hidden"); }
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

  // ================== 导航 ==================
  $$(".nav-item").forEach((btn) =>
    btn.addEventListener("click", () => {
      $$(".nav-item").forEach((b) => b.classList.toggle("active", b === btn));
      $$(".view").forEach((v) => v.classList.remove("active"));
      $(`#view-${btn.dataset.view}`).classList.add("active");
      renderAll();
    })
  );

  // ================== 班级管理 ==================
  function renderClasses() {
    const wrap = $("#classList");
    if (!DB.classes.length) {
      wrap.innerHTML = emptyHtml("users", "还没有班级，点右上角「新建班级」开始", "grid-column:1/-1");
      return;
    }
    wrap.innerHTML = DB.classes
      .map((c) => {
        const chips = c.students
          .map(
            (s) =>
              `<span class="stu-chip">${esc(s.name)}${s.no ? `<span class="no">#${esc(s.no)}</span>` : ""}<button class="rm" data-act="rm-stu" data-cls="${c.id}" data-stu="${s.id}" title="移除">✕</button></span>`
          )
          .join("");
        return `<div class="class-card">
          <div class="class-card-head">
            <div><h3>${esc(c.name)}</h3><div class="class-meta">${c.students.length} 名学生</div></div>
            <button class="btn small danger" data-act="del-cls" data-cls="${c.id}">删除班级</button>
          </div>
          <div class="stu-chips">${chips || '<span class="muted">暂无学生</span>'}</div>
          <div class="card-actions">
            <button class="btn small" data-act="add-stu" data-cls="${c.id}">＋ 添加学生</button>
            <button class="btn small" data-act="batch-stu" data-cls="${c.id}">批量导入</button>
          </div>
        </div>`;
      })
      .join("");
  }

  $("#btnAddClass").addEventListener("click", () => {
    openModal(`<h2>新建班级</h2>
      <div class="form-row"><label>班级名称</label><input class="input" id="mClsName" placeholder="例如：五年级(2)班" /></div>
      <div class="modal-actions"><button class="btn" data-close>取消</button><button class="btn primary" id="mClsOk">创建</button></div>`);
    $("#mClsName").focus();
    $("#mClsOk").addEventListener("click", async () => {
      try {
        await api("/api/classes", { method: "POST", body: { name: $("#mClsName").value } });
        await reload(); closeModal(); renderAll(); toast("班级已创建");
      } catch (e) { toast(e.message, true); }
    });
  });

  $("#classList").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const { act, cls: clsId, stu: stuId } = btn.dataset;
    try {
      if (act === "del-cls") {
        if (!confirm("删除班级将同时删除其作业与成绩记录，确定？")) return;
        await api(`/api/classes/${clsId}`, { method: "DELETE" });
        await reload(); renderAll(); toast("已删除");
      } else if (act === "rm-stu") {
        if (!confirm("移除该学生将同时删除其成绩记录，确定？")) return;
        await api(`/api/classes/${clsId}/students/${stuId}`, { method: "DELETE" });
        await reload(); renderAll();
      } else if (act === "add-stu") {
        openModal(`<h2>添加学生</h2>
          <div class="form-inline">
            <div class="form-row"><label>姓名</label><input class="input" id="mStuName" placeholder="张小明" /></div>
            <div class="form-row"><label>学号（可选）</label><input class="input" id="mStuNo" placeholder="01" /></div>
          </div>
          <div class="modal-actions"><button class="btn" data-close>取消</button><button class="btn primary" id="mStuOk">添加</button></div>`);
        $("#mStuName").focus();
        $("#mStuOk").addEventListener("click", async () => {
          try {
            await api(`/api/classes/${clsId}/students`, { method: "POST", body: { name: $("#mStuName").value, no: $("#mStuNo").value } });
            await reload(); closeModal(); renderAll(); toast("已添加");
          } catch (err) { toast(err.message, true); }
        });
      } else if (act === "batch-stu") {
        openModal(`<h2>批量导入学生</h2>
          <div class="form-row"><label>每行一个学生，格式：姓名 或 姓名,学号</label>
          <textarea class="input" id="mBatch" rows="8" placeholder="张小明,01\n李小红,02\n王小刚"></textarea></div>
          <div class="modal-actions"><button class="btn" data-close>取消</button><button class="btn primary" id="mBatchOk">导入</button></div>`);
        $("#mBatchOk").addEventListener("click", async () => {
          const list = $("#mBatch").value.split(/\n/).map((l) => l.trim()).filter(Boolean)
            .map((l) => { const [name, no] = l.split(/[,，\t]/).map((x) => x.trim()); return { name, no }; });
          if (!list.length) return toast("请输入学生名单", true);
          try {
            await api(`/api/classes/${clsId}/students`, { method: "POST", body: { list } });
            await reload(); closeModal(); renderAll(); toast(`已导入 ${list.length} 名学生`);
          } catch (err) { toast(err.message, true); }
        });
      }
    } catch (err) { toast(err.message, true); }
  });

  // ================== 作业与答案 ==================
  function qEditorRow(q = { no: "", answer: "", points: "" }) {
    return `<div class="q-editor-row">
      <input class="input q-no" placeholder="1" value="${esc(q.no)}" />
      <input class="input q-ans" placeholder="标准答案" value="${esc(q.answer)}" />
      <input class="input q-pts" type="number" min="0" placeholder="分值" value="${esc(q.points)}" />
      <button class="icon-btn" data-act="rm-q" title="删除本题">✕</button>
    </div>`;
  }

  function openAsgModal(asg = null) {
    const clsOpts = DB.classes.map((c) => `<option value="${c.id}" ${asg?.classId === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
    if (!clsOpts) return toast("请先创建班级", true);
    const rows = (asg?.questions || [{ no: "1", answer: "", points: "" }]).map(qEditorRow).join("");
    openModal(`<h2>${asg ? "编辑作业" : "新建作业"}</h2>
      <div class="form-inline">
        <div class="form-row"><label>所属班级</label><select class="select" id="mAsgCls" ${asg ? "disabled" : ""}>${clsOpts}</select></div>
        <div class="form-row"><label>日期</label><input class="input" id="mAsgDate" type="date" value="${asg?.date || new Date().toISOString().slice(0, 10)}" /></div>
      </div>
      <div class="form-row"><label>作业名称</label><input class="input" id="mAsgName" placeholder="例如：数学练习 第3课" value="${esc(asg?.name || "")}" /></div>
      <div class="form-row"><label>标准答案</label>
        <div class="q-editor-head"><span>题号</span><span>标准答案</span><span>分值</span><span></span></div>
        <div id="qRows">${rows}</div>
        <button class="btn small" id="mAddQ" style="margin-top:4px">＋ 添加一题</button>
      </div>
      <div class="modal-actions"><button class="btn" data-close>取消</button><button class="btn primary" id="mAsgOk">${asg ? "保存" : "创建"}</button></div>`);

    $("#mAddQ").addEventListener("click", () => {
      const n = $$("#qRows .q-editor-row").length + 1;
      $("#qRows").insertAdjacentHTML("beforeend", qEditorRow({ no: String(n), answer: "", points: "" }));
    });
    $("#qRows").addEventListener("click", (e) => {
      if (e.target.closest('[data-act="rm-q"]')) e.target.closest(".q-editor-row").remove();
    });
    $("#mAsgOk").addEventListener("click", async () => {
      const questions = $$("#qRows .q-editor-row").map((row) => ({
        no: $(".q-no", row).value.trim(),
        answer: $(".q-ans", row).value.trim(),
        points: Number($(".q-pts", row).value) || 0
      })).filter((q) => q.answer);
      const body = { classId: $("#mAsgCls").value, name: $("#mAsgName").value, date: $("#mAsgDate").value, questions };
      try {
        if (asg) await api(`/api/assignments/${asg.id}`, { method: "PUT", body });
        else await api("/api/assignments", { method: "POST", body });
        await reload(); closeModal(); renderAll(); toast(asg ? "已保存" : "作业已创建");
      } catch (err) { toast(err.message, true); }
    });
  }

  $("#btnAddAsg").addEventListener("click", () => openAsgModal());

  function renderAssignments() {
    const wrap = $("#asgList");
    if (!DB.assignments.length) {
      wrap.innerHTML = emptyHtml("clipboard", "还没有作业，点右上角「新建作业」录入标准答案");
      return;
    }
    wrap.innerHTML = [...DB.assignments].reverse()
      .map((a) => {
        const cls = findCls(a.classId);
        const subs = DB.submissions.filter((s) => s.assignmentId === a.id);
        const graded = subs.filter((s) => s.status === "graded").length;
        return `<div class="asg-card">
          <div class="asg-info">
            <h3>${esc(a.name)}</h3>
            <div class="asg-badges">
              <span class="badge blue">${esc(cls?.name || "未知班级")}</span>
              <span class="badge">${a.date}</span>
              <span class="badge">${a.questions.length} 题 · 满分 ${asgTotal(a)}</span>
              <span class="badge ${graded ? "green" : ""}">已批改 ${graded}/${cls?.students.length || 0}</span>
            </div>
          </div>
          <button class="btn small" data-act="edit-asg" data-id="${a.id}">编辑答案</button>
          <button class="btn small primary" data-act="go-grade" data-id="${a.id}">去批改 →</button>
          <button class="btn small danger" data-act="del-asg" data-id="${a.id}">删除</button>
        </div>`;
      })
      .join("");
  }

  $("#asgList").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const asg = findAsg(btn.dataset.id);
    if (btn.dataset.act === "edit-asg") openAsgModal(asg);
    else if (btn.dataset.act === "del-asg") {
      if (!confirm("删除作业将同时删除其批改记录，确定？")) return;
      try {
        await api(`/api/assignments/${asg.id}`, { method: "DELETE" });
        await reload(); renderAll(); toast("已删除");
      } catch (err) { toast(err.message, true); }
    } else if (btn.dataset.act === "go-grade") {
      $('[data-view="grading"]').click();
      $("#gradeAsgSelect").value = asg.id;
      renderGrading();
    }
  });

  // ================== 智能批改 ==================
  function renderGradeSelect() {
    const sel = $("#gradeAsgSelect");
    const prev = sel.value;
    sel.innerHTML =
      `<option value="">— 选择要批改的作业 —</option>` +
      DB.classes.map((c) => {
        const asgs = DB.assignments.filter((a) => a.classId === c.id);
        if (!asgs.length) return "";
        return `<optgroup label="${esc(c.name)}">${asgs.map((a) => `<option value="${a.id}">${esc(a.name)}（${a.date}）</option>`).join("")}</optgroup>`;
      }).join("");
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }

  function renderGrading() {
    const asgId = $("#gradeAsgSelect").value;
    const wrap = $("#gradeBody");
    const asg = findAsg(asgId);
    if (!asg) {
      wrap.innerHTML = emptyHtml("pen", "请先在右上方选择一次作业");
      return;
    }
    const cls = findCls(asg.classId);
    const total = asgTotal(asg);
    const pending = cls.students.filter((s) => subOf(asg.id, s.id)?.status === "pending").length;

    const cards = cls.students.map((stu) => {
      const sub = subOf(asg.id, stu.id);
      let stateHtml, scoreHtml = "", actions = "";
      if (!sub) {
        stateHtml = `<span class="stu-state state-none">未上传</span>`;
        actions = `<button class="btn small primary" data-act="upload" data-stu="${stu.id}">上传作业</button>`;
      } else if (sub.status === "pending") {
        stateHtml = `<span class="stu-state state-pending">待批改</span>`;
        actions = `<button class="btn small primary" data-act="grade" data-sub="${sub.id}">AI 批改</button>
          <button class="btn small" data-act="grade-mock" data-sub="${sub.id}">模拟</button>
          <button class="btn ghost small" data-act="upload" data-stu="${stu.id}">重传</button>`;
      } else {
        stateHtml = `<span class="stu-state state-graded">已批改</span>`;
        scoreHtml = `<div class="stu-score">${sub.totalScore}<small> / ${total} 分</small></div>`;
        actions = `<button class="btn small primary" data-act="review" data-sub="${sub.id}">查看批改</button>
          <button class="btn ghost small" data-act="grade" data-sub="${sub.id}">重新批改</button>
          <button class="btn ghost small" data-act="upload" data-stu="${stu.id}">重传</button>`;
      }
      return `<div class="stu-card" id="stucard-${stu.id}">
        <div class="stu-card-top"><span class="stu-name">${esc(stu.name)}${stu.no ? `<span class="stu-no">#${esc(stu.no)}</span>` : ""}</span>${stateHtml}</div>
        ${scoreHtml}
        <div class="stu-card-actions">${actions}</div>
      </div>`;
    }).join("");

    wrap.innerHTML = `
      <div class="grade-toolbar">
        <span class="muted">共 ${cls.students.length} 人 · 待批改 ${pending} 份</span>
        <span style="flex:1"></span>
        <button class="btn" id="btnGradeAllMock" ${pending ? "" : "disabled"}>全部模拟批改</button>
        <button class="btn primary" id="btnGradeAll" ${pending ? "" : "disabled"}>AI 批改全部待批（${pending}）</button>
      </div>
      <div class="stu-grid">${cards}</div>
      <input type="file" id="fileInput" accept="image/*" style="display:none" />`;

    $("#btnGradeAll")?.addEventListener("click", () => gradeAllPending(asg, false));
    $("#btnGradeAllMock")?.addEventListener("click", () => gradeAllPending(asg, true));
  }

  async function gradeAllPending(asg, mock) {
    const cls = findCls(asg.classId);
    const pendings = cls.students.map((s) => subOf(asg.id, s.id)).filter((s) => s?.status === "pending");
    if (!pendings.length) return;
    if (!mock && !HEALTH.hasApiKey) return openSettings("请先填写 API Key 才能使用 AI 批改");
    let done = 0, lastErr = "";
    toast(`开始批改，共 ${pendings.length} 份…`);
    for (const sub of pendings) {
      $(`#stucard-${sub.studentId}`)?.classList.add("busy");
      try {
        await api(`/api/submissions/${sub.id}/grade`, { method: "POST", body: { mock } });
        done++;
      } catch (err) { console.error(err); lastErr = err.message; }
      await reload(); renderGrading();
    }
    if (lastErr && !done) toast(lastErr, true);
    else toast(`批改完成：${done}/${pendings.length} 份${lastErr ? "（部分失败：" + lastErr + "）" : ""}`, Boolean(lastErr));
  }

  $("#gradeAsgSelect").addEventListener("change", renderGrading);

  $("#gradeBody").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const asgId = $("#gradeAsgSelect").value;
    const act = btn.dataset.act;

    if (act === "upload") {
      const stuId = btn.dataset.stu;
      const fi = $("#fileInput");
      fi.onchange = async () => {
        const file = fi.files[0];
        if (!file) return;
        const fd = new FormData();
        fd.append("assignmentId", asgId);
        fd.append("studentId", stuId);
        fd.append("image", file);
        try {
          await api("/api/submissions", { method: "POST", body: fd });
          await reload(); renderGrading(); toast("上传成功，可以开始批改了");
        } catch (err) { toast(err.message, true); }
        fi.value = "";
      };
      fi.click();
    } else if (act === "grade" || act === "grade-mock") {
      const mock = act === "grade-mock";
      if (!mock && !HEALTH.hasApiKey) return openSettings("请先填写 API Key 才能使用 AI 批改");
      btn.disabled = true;
      const label = btn.textContent;
      btn.innerHTML = `<span class="spinner sm"></span>${mock ? "生成中…" : "AI 批改中…"}`;
      try {
        const sub = await api(`/api/submissions/${btn.dataset.sub}/grade`, { method: "POST", body: { mock } });
        await reload(); renderGrading();
        toast("批改完成");
        openReview(sub.id);
      } catch (err) {
        btn.disabled = false; btn.textContent = label;
        toast(err.message, true);
      }
    } else if (act === "review") {
      openReview(btn.dataset.sub);
    }
  });

  // ================== 批改详情（红笔标注） ==================
  const VERDICT_META = {
    correct: { label: "对", icon: "✓", cls: "on-correct" },
    partial: { label: "半对", icon: "◐", cls: "on-partial" },
    wrong: { label: "错", icon: "✗", cls: "on-wrong" },
    unclear: { label: "存疑", icon: "?", cls: "on-unclear" }
  };

  function openReview(subId) {
    const sub = DB.submissions.find((s) => s.id === subId);
    if (!sub || sub.status !== "graded") return;
    const asg = findAsg(sub.assignmentId);
    const cls = findCls(asg.classId);
    const stu = findStu(cls.id, sub.studentId);
    // 深拷贝，编辑不影响原数据，保存时提交
    currentReview = {
      subId: sub.id,
      image: sub.image,
      results: JSON.parse(JSON.stringify(sub.results)),
      overallComment: sub.overallComment || "",
      scorePos: sub.scorePos ? { ...sub.scorePos } : { x: 835, y: 52 },
      asg, cls, stu
    };
    $("#reviewTitle").textContent = `${stu.name} · ${asg.name}（${cls.name}）`;
    const img = $("#reviewImg");
    img.onload = () => { renderMarks(); renderReviewPanel(); };
    img.src = `/uploads/${sub.image}`;
    $("#reviewOverlay").classList.remove("hidden");
  }

  $("#btnCloseReview").addEventListener("click", () => {
    $("#reviewOverlay").classList.add("hidden");
    currentReview = null;
  });

  // ---- 手写红笔标记：生成绘制基元（路径 + 文字），SVG 显示与 canvas 导出共用 ----
  function inkColor(rand, lightBase = 42) {
    const h = 352 + rand() * 10;
    const s = 68 + rand() * 14;
    const l = lightBase - 4 + rand() * 8;
    return `hsl(${h.toFixed(0)}, ${s.toFixed(0)}%, ${l.toFixed(0)}%)`;
  }
  const HAND_FONT = `"KaiTi","STKaiti","Kaiti SC","DFKai-SB",serif`;

  // 单题标记基元。cx,cy 为像素坐标，S 为标记基准尺寸(px)
  function markPrims(r, cx, cy, S, seed) {
    const rand = seededRand(seed);
    const j = (k = 1) => (rand() - 0.5) * S * 0.12 * k; // 抖动
    const color = inkColor(rand);
    const w = S * (0.09 + rand() * 0.035);
    const paths = [], texts = [];
    const P = (x, y) => `${(cx + x).toFixed(1)} ${(cy + y).toFixed(1)}`;

    if (r.verdict === "correct" || r.verdict === "partial") {
      // 对号：短撇 + 长捺，末端上挑，带弧度
      const x1 = -0.42 * S + j(), y1 = 0.02 * S + j();
      const x2 = -0.08 * S + j(0.6), y2 = 0.38 * S + j(0.6);
      const x3 = 0.62 * S + j(), y3 = -0.5 * S + j();
      const c1x = (x1 + x2) / 2 + j(0.8), c1y = (y1 + y2) / 2 + 0.06 * S + j(0.8);
      const c2x = (x2 + x3) / 2 + 0.08 * S + j(), c2y = (y2 + y3) / 2 + 0.1 * S + j();
      paths.push({ d: `M ${P(x1, y1)} Q ${P(c1x, c1y)} ${P(x2, y2)} Q ${P(c2x, c2y)} ${P(x3, y3)}`, w, color, alpha: 0.92 });
      if (r.verdict === "partial") {
        // 半对：对号上再划一斜线
        paths.push({
          d: `M ${P(-0.15 * S + j(), -0.42 * S + j())} Q ${P(0.1 * S + j(), 0 + j())} ${P(0.32 * S + j(), 0.4 * S + j())}`,
          w: w * 0.9, color, alpha: 0.9
        });
      }
    } else if (r.verdict === "wrong") {
      // 叉：两笔略弯的斜线
      paths.push({
        d: `M ${P(-0.38 * S + j(), -0.4 * S + j())} Q ${P(j(1.6), j(1.6))} ${P(0.4 * S + j(), 0.42 * S + j())}`,
        w, color, alpha: 0.92
      });
      paths.push({
        d: `M ${P(0.38 * S + j(), -0.42 * S + j())} Q ${P(j(1.6), j(1.6))} ${P(-0.4 * S + j(), 0.4 * S + j())}`,
        w: w * 0.95, color, alpha: 0.9
      });
    } else {
      // 存疑：手写问号
      texts.push({
        x: cx + j(2), y: cy + S * 0.3, str: "?", size: S * 1.25, color,
        rot: (rand() - 0.5) * 10, weight: "bold", font: HAND_FONT, align: "center"
      });
    }

    // 扣分标注（部分对/错给出 -n）
    const lost = (Number(r.points) || 0) - (Number(r.score) || 0);
    if (lost > 0 && r.verdict !== "unclear") {
      texts.push({
        x: cx + S * 0.95, y: cy + S * 0.15, str: `-${lost}`, size: S * 0.62, color,
        rot: (rand() - 0.5) * 8, weight: "bold", font: HAND_FONT, align: "left"
      });
    }
    // 简短批注
    if (r.comment) {
      texts.push({
        x: cx - S * 0.2, y: cy + S * 0.95, str: r.comment, size: Math.max(13, S * 0.5), color,
        rot: -2 + rand() * 4, weight: "normal", font: HAND_FONT, align: "left"
      });
    }
    return { paths, texts };
  }

  // 总分标记基元
  function scorePrims(review, cx, cy, S) {
    const rand = seededRand(review.subId + "-score");
    const color = inkColor(rand, 40);
    const total = review.results.reduce((s, r) => s + (Number(r.score) || 0), 0);
    const paths = [], texts = [];
    texts.push({
      x: cx, y: cy + S * 0.42, str: `${total}`, size: S * 1.5, color,
      rot: -3 + rand() * 5, weight: "bold", font: HAND_FONT, align: "center"
    });
    texts.push({
      x: cx + S * 1.05, y: cy + S * 0.4, str: "分", size: S * 0.6, color,
      rot: (rand() - 0.5) * 6, weight: "bold", font: HAND_FONT, align: "left"
    });
    // 两道随手划的下划线
    for (let i = 0; i < 2; i++) {
      const y0 = cy + S * (0.72 + i * 0.16) + (rand() - 0.5) * S * 0.05;
      const x0 = cx - S * (1.05 + rand() * 0.15), x1 = cx + S * (1.15 + rand() * 0.2);
      const cyy = y0 + (rand() - 0.5) * S * 0.12;
      paths.push({
        d: `M ${x0.toFixed(1)} ${y0.toFixed(1)} Q ${((x0 + x1) / 2).toFixed(1)} ${cyy.toFixed(1)} ${x1.toFixed(1)} ${(y0 + (rand() - 0.5) * S * 0.08).toFixed(1)}`,
        w: S * (0.07 + rand() * 0.02), color, alpha: 0.85
      });
    }
    // 总评写在总分下方
    if (review.overallComment) {
      texts.push({
        x: cx + S * 1.3, y: cy + S * 1.75, str: review.overallComment, size: Math.max(14, S * 0.5), color,
        rot: -1.5 + rand() * 3, weight: "normal", font: HAND_FONT, align: "right"
      });
    }
    return { paths, texts };
  }

  function primsToSvg(prims) {
    let out = "";
    for (const p of prims.paths) {
      out += `<path d="${p.d}" fill="none" stroke="${p.color}" stroke-width="${p.w.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" opacity="${p.alpha}"/>`;
    }
    for (const t of prims.texts) {
      const anchor = t.align === "center" ? "middle" : t.align === "right" ? "end" : "start";
      out += `<text x="${t.x.toFixed(1)}" y="${t.y.toFixed(1)}" fill="${t.color}" font-family='${t.font}' font-size="${t.size.toFixed(1)}" font-weight="${t.weight}" text-anchor="${anchor}" transform="rotate(${t.rot.toFixed(1)} ${t.x.toFixed(1)} ${t.y.toFixed(1)})">${esc(t.str)}</text>`;
    }
    return out;
  }

  function markSize(imgW) { return Math.max(20, Math.min(64, imgW * 0.042)); }

  function renderMarks() {
    if (!currentReview) return;
    const img = $("#reviewImg");
    const svg = $("#marksSvg");
    const W = img.clientWidth, H = img.clientHeight;
    if (!W) return;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const S = markSize(W);
    let html = "";
    currentReview.results.forEach((r, i) => {
      const cx = (r.x / 1000) * W, cy = (r.y / 1000) * H;
      const prims = markPrims(r, cx, cy, S, `${currentReview.subId}-${r.no}`);
      html += `<g class="mark" data-idx="${i}">${primsToSvg(prims)}</g>`;
    });
    const sp = currentReview.scorePos;
    const sprims = scorePrims(currentReview, (sp.x / 1000) * W, (sp.y / 1000) * H, S * 1.35);
    html += `<g class="mark" data-idx="score">${primsToSvg(sprims)}</g>`;
    svg.innerHTML = html;
  }

  // 拖拽标记
  (() => {
    const svg = $("#marksSvg");
    let dragging = null;
    svg.addEventListener("pointerdown", (e) => {
      const g = e.target.closest("g.mark");
      if (!g) return;
      e.preventDefault();
      dragging = { g, idx: g.dataset.idx, startX: e.clientX, startY: e.clientY, dx: 0, dy: 0 };
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      dragging.dx = e.clientX - dragging.startX;
      dragging.dy = e.clientY - dragging.startY;
      dragging.g.setAttribute("transform", `translate(${dragging.dx},${dragging.dy})`);
    });
    const end = () => {
      if (!dragging || !currentReview) { dragging = null; return; }
      const img = $("#reviewImg");
      const W = img.clientWidth, H = img.clientHeight;
      const ndx = (dragging.dx / W) * 1000, ndy = (dragging.dy / H) * 1000;
      const clamp = (v) => Math.min(1000, Math.max(0, v));
      if (dragging.idx === "score") {
        currentReview.scorePos.x = clamp(currentReview.scorePos.x + ndx);
        currentReview.scorePos.y = clamp(currentReview.scorePos.y + ndy);
      } else {
        const r = currentReview.results[Number(dragging.idx)];
        r.x = clamp(r.x + ndx); r.y = clamp(r.y + ndy);
      }
      dragging = null;
      renderMarks();
    };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);
    window.addEventListener("resize", () => renderMarks());
  })();

  // ---- 右侧编辑面板 ----
  function renderReviewPanel() {
    const rv = currentReview;
    if (!rv) return;
    const totalPts = rv.results.reduce((s, r) => s + (Number(r.points) || 0), 0);
    const totalScore = rv.results.reduce((s, r) => s + (Number(r.score) || 0), 0);
    const items = rv.results.map((r, i) => {
      const vBtns = Object.entries(VERDICT_META).map(([v, m]) =>
        `<button class="verdict-btn ${r.verdict === v ? m.cls : ""}" data-idx="${i}" data-v="${v}" title="${m.label}">${m.icon}</button>`
      ).join("");
      return `<div class="q-item">
        <div class="q-item-head">
          <span class="q-no">第${esc(r.no)}题</span><span class="q-pts">${r.points}分</span>
          <div class="verdict-group">${vBtns}</div>
        </div>
        <div class="q-detail">标准答案：<b>${esc(r.answer)}</b><br/>识别答案：${esc(r.studentAnswer) || '<i class="muted">未识别</i>'}</div>
        <div class="q-edit-row">
          <input class="input score-in" type="number" min="0" max="${r.points}" value="${r.score}" data-idx="${i}" data-f="score" title="得分" />
          <input class="input" placeholder="批注（写在图上）" value="${esc(r.comment)}" data-idx="${i}" data-f="comment" />
        </div>
      </div>`;
    }).join("");
    $("#reviewPanel").innerHTML = `
      <div class="panel-total"><span class="num">${totalScore}</span><span class="den"> / ${totalPts} 分</span></div>
      ${items}
      <div class="panel-comment">
        <label class="muted">总评（写在图上总分下方）</label>
        <textarea class="input" id="overallIn">${esc(rv.overallComment)}</textarea>
      </div>`;
  }
  // 面板事件只绑定一次（委托）
  $("#reviewPanel").addEventListener("click", onPanelClick);
  $("#reviewPanel").addEventListener("input", onPanelInput);

  function onPanelClick(e) {
    const btn = e.target.closest(".verdict-btn");
    if (!btn || !currentReview) return;
    const r = currentReview.results[Number(btn.dataset.idx)];
    r.verdict = btn.dataset.v;
    if (r.verdict === "correct") r.score = r.points;
    else if (r.verdict === "wrong" || r.verdict === "unclear") r.score = 0;
    else if (r.verdict === "partial" && (r.score === 0 || r.score === r.points))
      r.score = Math.max(1, Math.round(r.points / 2));
    renderReviewPanel(); renderMarks();
  }
  function onPanelInput(e) {
    const el = e.target;
    if (!currentReview) return;
    if (el.id === "overallIn") { currentReview.overallComment = el.value; renderMarks(); return; }
    const idx = Number(el.dataset.idx);
    if (Number.isNaN(idx)) return;
    const r = currentReview.results[idx];
    if (el.dataset.f === "score") {
      r.score = Math.min(r.points, Math.max(0, Number(el.value) || 0));
      const totalEl = $(".panel-total .num");
      if (totalEl) totalEl.textContent = currentReview.results.reduce((s, x) => s + (Number(x.score) || 0), 0);
    } else if (el.dataset.f === "comment") r.comment = el.value;
    renderMarks();
  }

  $("#btnSaveReview").addEventListener("click", async () => {
    if (!currentReview) return;
    try {
      const body = {
        results: currentReview.results,
        overallComment: currentReview.overallComment,
        scorePos: currentReview.scorePos
      };
      // scorePos 不在服务端白名单里也无妨，直接一并存 results
      await api(`/api/submissions/${currentReview.subId}`, { method: "PUT", body });
      await reload(); renderGrading();
      toast("已保存");
    } catch (err) { toast(err.message, true); }
  });

  // ---- 导出批改图（原始分辨率 + 红笔标注合成） ----
  $("#btnExportPng").addEventListener("click", async () => {
    const rv = currentReview;
    if (!rv) return;
    const img = $("#reviewImg");
    const W = img.naturalWidth, H = img.naturalHeight;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, W, H);

    const S = markSize(W);
    const allPrims = [];
    rv.results.forEach((r) => {
      allPrims.push(markPrims(r, (r.x / 1000) * W, (r.y / 1000) * H, S, `${rv.subId}-${r.no}`));
    });
    allPrims.push(scorePrims(rv, (rv.scorePos.x / 1000) * W, (rv.scorePos.y / 1000) * H, S * 1.35));

    for (const prims of allPrims) {
      for (const p of prims.paths) {
        ctx.save();
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.w;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.globalAlpha = p.alpha;
        ctx.stroke(new Path2D(p.d));
        ctx.restore();
      }
      for (const t of prims.texts) {
        ctx.save();
        ctx.translate(t.x, t.y);
        ctx.rotate((t.rot * Math.PI) / 180);
        ctx.fillStyle = t.color;
        ctx.font = `${t.weight === "bold" ? "bold " : ""}${t.size}px ${t.font.replace(/"/g, "")}`;
        ctx.textAlign = t.align;
        ctx.globalAlpha = 0.95;
        ctx.fillText(t.str, 0, 0);
        ctx.restore();
      }
    }
    const a = document.createElement("a");
    a.download = `${rv.stu.name}-${rv.asg.name}-批改.png`;
    a.href = canvas.toDataURL("image/png");
    a.click();
    toast("批改图已导出");
  });

  // ================== 成绩分析 ==================
  let analysisTab = "sheet";
  $("#analysisTabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (!tab) return;
    analysisTab = tab.dataset.tab;
    $$("#analysisTabs .tab").forEach((t) => t.classList.toggle("active", t === tab));
    renderAnalysis();
  });

  function destroyCharts() {
    Object.values(charts).forEach((c) => c?.destroy());
    charts = {};
  }

  function pctClass(p) { return p >= 40 ? "pct-high" : p >= 15 ? "pct-mid" : "pct-low"; }

  function clsSelectHtml(id, selected) {
    return `<select class="select" id="${id}">${DB.classes.map((c) => `<option value="${c.id}" ${c.id === selected ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>`;
  }

  const analysisState = { clsId: null, stuId: null, asgId: null };

  function renderAnalysis() {
    destroyCharts();
    const wrap = $("#analysisBody");
    if (!DB.classes.length) {
      wrap.innerHTML = emptyHtml("chart", "请先创建班级并完成批改");
      return;
    }
    if (!analysisState.clsId || !findCls(analysisState.clsId)) analysisState.clsId = DB.classes[0].id;
    if (window.Chart) {
      Chart.defaults.color = cssVar("--text-3");
      Chart.defaults.borderColor = cssVar("--line");
      Chart.defaults.font.family = cssVar("--font");
    }

    if (analysisTab === "sheet") renderSheetTab(wrap);
    else if (analysisTab === "student") renderStudentTab(wrap);
    else renderQuestionTab(wrap);
  }

  // ---- 成绩单 ----
  function renderSheetTab(wrap) {
    const cls = findCls(analysisState.clsId);
    const asgs = DB.assignments.filter((a) => a.classId === cls.id);
    let table = `<div class="empty">该班级暂无作业记录</div>`;
    if (asgs.length && cls.students.length) {
      const head = `<tr><th>学生</th>${asgs.map((a) => `<th>${esc(a.name)}<br/><span style="font-weight:400">${a.date} · 满分${asgTotal(a)}</span></th>`).join("")}<th>平均得分率</th></tr>`;
      const rows = cls.students.map((stu) => {
        let rates = [];
        const cells = asgs.map((a) => {
          const sub = subOf(a.id, stu.id);
          if (sub?.status === "graded") {
            const rate = asgTotal(a) ? (sub.totalScore / asgTotal(a)) * 100 : 0;
            rates.push(rate);
            return `<td class="num"><span class="cell-link" data-sub="${sub.id}">${sub.totalScore}</span></td>`;
          }
          return `<td class="muted">—</td>`;
        }).join("");
        const avg = rates.length ? (rates.reduce((s, r) => s + r, 0) / rates.length).toFixed(1) + "%" : "—";
        return `<tr><td>${esc(stu.name)}</td>${cells}<td class="num">${avg}</td></tr>`;
      }).join("");
      // 班级平均分行
      const avgCells = asgs.map((a) => {
        const graded = cls.students.map((s) => subOf(a.id, s.id)).filter((s) => s?.status === "graded");
        if (!graded.length) return `<td class="muted">—</td>`;
        const avg = graded.reduce((s, x) => s + x.totalScore, 0) / graded.length;
        return `<td class="num">${avg.toFixed(1)}</td>`;
      }).join("");
      table = `<div class="table-wrap"><table class="grid">
        <thead>${head}</thead><tbody>${rows}
        <tr class="avg-row"><td><b>班级平均</b></td>${avgCells}<td></td></tr>
        </tbody></table></div>`;
    }
    wrap.innerHTML = `
      <div class="filter-bar">${clsSelectHtml("shClsSel", analysisState.clsId)}
        <span style="flex:1"></span>
        <button class="btn" id="btnCsv">导出 CSV</button>
      </div>
      <div class="panel"><h3>${esc(cls.name)} · 成绩单</h3>${table}</div>`;
    $("#shClsSel").addEventListener("change", (e) => { analysisState.clsId = e.target.value; renderAnalysis(); });
    $("#btnCsv").addEventListener("click", () => exportCsv(cls, asgs));
  }

  function exportCsv(cls, asgs) {
    const head = ["学生", ...asgs.map((a) => `${a.name}(满分${asgTotal(a)})`)];
    const rows = cls.students.map((stu) => [
      stu.name,
      ...asgs.map((a) => {
        const sub = subOf(a.id, stu.id);
        return sub?.status === "graded" ? sub.totalScore : "";
      })
    ]);
    const csv = "﻿" + [head, ...rows].map((r) => r.join(",")).join("\n");
    const a = document.createElement("a");
    a.download = `${cls.name}-成绩单.csv`;
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.click();
  }

  // ---- 学生分析 ----
  function renderStudentTab(wrap) {
    const cls = findCls(analysisState.clsId);
    if (!analysisState.stuId || !cls.students.find((s) => s.id === analysisState.stuId))
      analysisState.stuId = cls.students[0]?.id || null;
    const stu = cls.students.find((s) => s.id === analysisState.stuId);
    const stuSel = `<select class="select" id="stStuSel">${cls.students.map((s) => `<option value="${s.id}" ${s.id === analysisState.stuId ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>`;

    let body = `<div class="empty">该学生暂无批改记录</div>`;
    const records = [];
    if (stu) {
      for (const a of DB.assignments.filter((x) => x.classId === cls.id)) {
        const sub = subOf(a.id, stu.id);
        if (sub?.status === "graded") records.push({ asg: a, sub });
      }
    }
    if (records.length) {
      const detailRows = records.map(({ asg, sub }) => {
        const total = asgTotal(asg);
        const rate = total ? ((sub.totalScore / total) * 100).toFixed(1) : "0";
        const dots = sub.results.map((r) => {
          const color = r.verdict === "correct" ? "var(--success)" : r.verdict === "partial" ? "var(--warning)" : "var(--danger)";
          return `<span class="dot" style="background:${color}" title="第${esc(r.no)}题：${VERDICT_META[r.verdict]?.label || ""} ${r.score}/${r.points}分${r.comment ? " · " + esc(r.comment) : ""}"></span>`;
        }).join("");
        const wrongs = sub.results.filter((r) => r.verdict !== "correct").map((r) => `第${r.no}题`).join("、") || "全对";
        return `<tr>
          <td>${esc(asg.name)}<br/><span class="muted">${asg.date}</span></td>
          <td class="num"><span class="cell-link" data-sub="${sub.id}">${sub.totalScore} / ${total}</span></td>
          <td class="num"><span class="${pctClass(100 - rate)}">${rate}%</span></td>
          <td>${dots}</td>
          <td>${wrongs}</td>
        </tr>`;
      }).join("");
      body = `
        <div class="panel"><h3>成绩走势（得分率 %）</h3><div class="chart-box"><canvas id="stuChart"></canvas></div></div>
        <div class="panel"><h3>逐次明细</h3><div class="table-wrap"><table class="grid">
          <thead><tr><th>作业</th><th>得分</th><th>得分率</th><th>逐题（悬停查看）</th><th>失分题</th></tr></thead>
          <tbody>${detailRows}</tbody></table></div>
          <div class="legend-note"><span><span class="dot" style="background:var(--success)"></span>正确</span>
          <span><span class="dot" style="background:var(--warning)"></span>部分正确</span>
          <span><span class="dot" style="background:var(--danger)"></span>错误/存疑</span></div>
        </div>`;
    }
    wrap.innerHTML = `<div class="filter-bar">${clsSelectHtml("stClsSel", analysisState.clsId)}${stuSel}</div>${body}`;
    $("#stClsSel").addEventListener("change", (e) => { analysisState.clsId = e.target.value; analysisState.stuId = null; renderAnalysis(); });
    $("#stStuSel")?.addEventListener("change", (e) => { analysisState.stuId = e.target.value; renderAnalysis(); });

    if (records.length && window.Chart) {
      charts.stu = new Chart($("#stuChart"), {
        type: "line",
        data: {
          labels: records.map((r) => r.asg.name),
          datasets: [{
            label: `${stu.name} 得分率`,
            data: records.map((r) => {
              const t = asgTotal(r.asg);
              return t ? +((r.sub.totalScore / t) * 100).toFixed(1) : 0;
            }),
            borderColor: cssVar("--primary"),
            backgroundColor: alpha(cssVar("--primary"), 0.08),
            fill: true,
            tension: 0.35,
            pointRadius: 4,
            pointBackgroundColor: cssVar("--primary")
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: { y: { min: 0, max: 100, ticks: { callback: (v) => v + "%" } } },
          plugins: { legend: { display: false } }
        }
      });
    }
  }

  // ---- 试卷讲评（逐题错误率） ----
  function renderQuestionTab(wrap) {
    const asgs = DB.assignments;
    if (!asgs.length) {
      wrap.innerHTML = emptyHtml("chart", "暂无作业");
      return;
    }
    if (!analysisState.asgId || !findAsg(analysisState.asgId)) analysisState.asgId = asgs[asgs.length - 1].id;
    const asg = findAsg(analysisState.asgId);
    const cls = findCls(asg.classId);
    const asgSel = `<select class="select wide" id="qAsgSel">${DB.classes.map((c) => {
      const list = asgs.filter((a) => a.classId === c.id);
      if (!list.length) return "";
      return `<optgroup label="${esc(c.name)}">${list.map((a) => `<option value="${a.id}" ${a.id === analysisState.asgId ? "selected" : ""}>${esc(a.name)}（${a.date}）</option>`).join("")}</optgroup>`;
    }).join("")}</select>`;

    const graded = DB.submissions.filter((s) => s.assignmentId === asg.id && s.status === "graded");
    let body = `<div class="empty">这次作业还没有批改记录</div>`;
    if (graded.length) {
      const stats = asg.questions.map((q) => {
        let wrong = 0, partial = 0;
        const wrongStus = [];
        for (const sub of graded) {
          const r = sub.results.find((x) => String(x.no) === String(q.no));
          if (!r) continue;
          if (r.verdict === "wrong" || r.verdict === "unclear") {
            wrong++;
            wrongStus.push(findStu(cls.id, sub.studentId)?.name || "?");
          } else if (r.verdict === "partial") {
            partial++;
            wrongStus.push((findStu(cls.id, sub.studentId)?.name || "?") + "(半)");
          }
        }
        const errRate = ((wrong + partial * 0.5) / graded.length) * 100;
        return { q, wrong, partial, errRate, wrongStus };
      });

      const suggests = [...stats].sort((a, b) => b.errRate - a.errRate).map((s) => {
        const lvl = s.errRate >= 40 ? "high" : s.errRate >= 15 ? "mid" : "low";
        const tag = lvl === "high" ? "重点讲解" : lvl === "mid" ? "简要讲评" : "无需讲解";
        return `<div class="suggest-item ${lvl}">
          <span class="suggest-tag">${tag}</span>
          <b>第${esc(s.q.no)}题</b>
          <span class="muted">错误率 ${s.errRate.toFixed(0)}%（${s.wrong} 人错${s.partial ? `，${s.partial} 人半对` : ""}）</span>
          <span style="flex:1"></span>
          <span class="muted" style="max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(s.wrongStus.join("、"))}">${esc(s.wrongStus.join("、"))}</span>
        </div>`;
      }).join("");

      body = `
        <div class="panel"><h3>${esc(asg.name)} · 逐题错误率（已批改 ${graded.length} 份）</h3>
          <div class="chart-box"><canvas id="qChart"></canvas></div>
        </div>
        <div class="panel"><h3>讲评建议 <span class="muted" style="font-weight:400">错误率 ≥40% 建议重点讲解</span></h3>
          <div class="suggest-list">${suggests}</div>
        </div>`;
    }
    wrap.innerHTML = `<div class="filter-bar">${asgSel}</div>${body}`;
    $("#qAsgSel").addEventListener("change", (e) => { analysisState.asgId = e.target.value; renderAnalysis(); });

    if (graded.length && window.Chart) {
      const labels = asg.questions.map((q) => `第${q.no}题`);
      const wrongData = [], partialData = [];
      for (const q of asg.questions) {
        let wrong = 0, partial = 0;
        for (const sub of graded) {
          const r = sub.results.find((x) => String(x.no) === String(q.no));
          if (!r) continue;
          if (r.verdict === "wrong" || r.verdict === "unclear") wrong++;
          else if (r.verdict === "partial") partial++;
        }
        wrongData.push(+((wrong / graded.length) * 100).toFixed(1));
        partialData.push(+((partial / graded.length) * 100).toFixed(1));
      }
      charts.q = new Chart($("#qChart"), {
        type: "bar",
        data: {
          labels,
          datasets: [
            { label: "错误 %", data: wrongData, backgroundColor: alpha(cssVar("--danger"), 0.8), stack: "s", borderRadius: 6 },
            { label: "部分正确 %", data: partialData, backgroundColor: alpha(cssVar("--warning"), 0.6), stack: "s", borderRadius: 6 }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: { y: { min: 0, max: 100, ticks: { callback: (v) => v + "%" } }, x: { stacked: true } },
          plugins: { tooltip: { callbacks: { footer: (items) => "错误率越高越需要课堂讲评" } } }
        }
      });
    }
  }

  // ================== 渲染入口 ==================
  function renderAll() {
    renderClasses();
    renderAssignments();
    renderGradeSelect();
    renderGrading();
    if ($("#view-analysis").classList.contains("active")) renderAnalysis();
  }

  // 弹窗通用关闭
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) closeModal();
  });

  // 分析区：点击成绩数字打开对应批改详情（全局委托，只绑一次）
  $("#analysisBody").addEventListener("click", (e) => {
    const link = e.target.closest(".cell-link");
    if (link) openReview(link.dataset.sub);
  });

  // ================== AI 设置 ==================
  const EFFORT_META = [
    { v: "low", label: "快速" },
    { v: "medium", label: "标准" },
    { v: "high", label: "细致" },
    { v: "xhigh", label: "极致" }
  ];

  function renderAiStatus() {
    const st = $("#aiStatus");
    st.classList.toggle("on", HEALTH.hasApiKey);
    st.innerHTML = HEALTH.hasApiKey
      ? `<span class="status-dot"></span><span class="ai-status-text"><b>AI 批改已就绪</b><span>Claude Opus 5.5</span></span>`
      : `<span class="status-dot"></span><span class="ai-status-text"><b>未填写 API Key</b><span>点此设置，或先用模拟批改</span></span>`;
  }

  function openSettings(notice = "") {
    let effort = HEALTH.effort || "high";
    const keyPh = HEALTH.hasApiKey
      ? `已保存 ${HEALTH.keyMasked}${HEALTH.keySource === "env" ? "（来自环境变量）" : ""}，留空则不修改`
      : "sk-ant-api03-…";
    openModal(`<h2>AI 设置</h2>
      <p class="modal-sub">批改模型：<b>Claude Opus 5.5</b> <span class="mono">${esc(HEALTH.model || "claude-opus-5-5")}</span></p>
      ${notice ? `<div class="notice">${esc(notice)}</div>` : ""}
      <div class="form-row"><label for="mKey">Anthropic API Key</label>
        <div class="input-group">
          <input class="input" id="mKey" type="password" autocomplete="off" spellcheck="false" placeholder="${esc(keyPh)}" />
          <button class="btn small" id="mKeyEye" type="button">显示</button>
        </div>
        <div class="field-hint">在 console.anthropic.com 创建。Key 只保存在本机 data/settings.json，不会写进代码或上传到其他地方。</div>
      </div>
      <div class="form-row"><label>批改强度</label>
        <div class="seg" id="mEffort">${EFFORT_META.map((e) => `<button type="button" data-v="${e.v}" class="${e.v === effort ? "active" : ""}">${e.label}</button>`).join("")}</div>
        <div class="field-hint">强度越高，辨认潦草字迹、判断等价答案越仔细，但更慢、费用更高。推荐「细致」。</div>
      </div>
      <details class="adv" ${HEALTH.baseURL ? "open" : ""}><summary>高级：自定义 API 地址</summary>
        <input class="input" id="mBase" placeholder="https://api.anthropic.com（默认，留空即可）" value="${esc(HEALTH.baseURL || "")}" />
      </details>
      <div class="modal-actions">
        ${HEALTH.keySource === "web" ? '<button class="btn danger" id="mKeyClear">清除 Key</button><span class="spacer"></span>' : ""}
        <button class="btn" data-close>取消</button>
        <button class="btn primary" id="mSetOk">保存并验证</button>
      </div>`);
    $("#mKey").focus();
    $("#mKeyEye").addEventListener("click", (e) => {
      const show = $("#mKey").type === "password";
      $("#mKey").type = show ? "text" : "password";
      e.currentTarget.textContent = show ? "隐藏" : "显示";
    });
    $("#mEffort").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      effort = b.dataset.v;
      $$("#mEffort button").forEach((x) => x.classList.toggle("active", x === b));
    });
    const submit = async (body, okMsg) => {
      const ok = $("#mSetOk");
      ok.disabled = true;
      ok.innerHTML = `<span class="spinner sm light"></span>验证中…`;
      try {
        HEALTH = await api("/api/settings", { method: "PUT", body });
        renderAiStatus(); closeModal(); toast(okMsg);
      } catch (err) {
        ok.disabled = false; ok.textContent = "保存并验证";
        toast(err.message, true);
      }
    };
    $("#mSetOk").addEventListener("click", () =>
      submit({ apiKey: $("#mKey").value, baseURL: $("#mBase").value, effort }, "设置已保存"));
    $("#mKey").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#mSetOk").click(); });
    $("#mKeyClear")?.addEventListener("click", () => {
      if (confirm("确定清除已保存的 API Key？")) submit({ clearKey: true }, "已清除 API Key");
    });
  }
  $("#aiStatus").addEventListener("click", () => openSettings());

  // ================== 深色模式 ==================
  const SUN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
  const MOON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $("#btnTheme").title = theme === "dark" ? "切换到浅色" : "切换到深色";
    $("#btnTheme").innerHTML = theme === "dark" ? SUN : MOON;
  }
  let savedTheme = null;
  try { savedTheme = localStorage.getItem("theme"); } catch {}
  applyTheme(savedTheme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  $("#btnTheme").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    try { localStorage.setItem("theme", next); } catch {}
    if ($("#view-analysis").classList.contains("active")) renderAnalysis();
  });

  // ================== 启动 ==================
  (async () => {
    try {
      HEALTH = await api("/api/health");
      renderAiStatus();
      await reload();
      renderAll();
    } catch (err) {
      toast("初始化失败：" + err.message, true);
    }
  })();
})();
