/* ============ 初始化 ============ */
const publicConfig = {
  endpoint: "https://task-pomodoro.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_25jmKgPG9pW6Mx4K5LxZTk_QcXKD2oqNmNHv36Q2CVCvUSpZe6XK3yq",
};
const cloud = WorkBuddyCloud.createWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl,
  publishableKey: publicConfig.publishableKey,
});

const LEVELS = {
  high: { label: "重要紧急", color: "#ff8f93", bg: "#4b2b33", border: "rgba(229,72,77,.5)" },
  mid: { label: "中等优先", color: "#ffc76b", bg: "#463a26", border: "rgba(245,166,35,.45)" },
  low: { label: "较低优先", color: "#8ab4ff", bg: "#26374f", border: "rgba(79,140,255,.45)" },
};

/* 任务分类（内置 + 用户自定义，自定义存 user_profiles.custom_categories JSON） */
const CATEGORIES = {
  work: { label: "工作", icon: "💼" },
  study: { label: "学习", icon: "📚" },
  life: { label: "生活", icon: "🏠" },
  hobby: { label: "爱好娱乐", icon: "🎮" },
  fitness: { label: "健身", icon: "🏋️" },
};
let customCats = []; // 用户自定义分类 [{ key, label, icon }]
function catMap() {
  const m = Object.assign({}, CATEGORIES);
  for (const c of customCats) m[c.key] = { label: c.label, icon: c.icon || "📁", custom: true };
  return m;
}
function catOf(task) {
  return catMap()[task && task.category] || { label: "未分类", icon: "📁" };
}

/* ============ 全局状态 ============ */
let tasks = [];
let subtasks = [];
let sessions = [];
let items = []; // 第三层：子任务下的子项
let allSubtasks = []; // 含「已归档任务」下的子任务：月历打卡要认它们
let archivedTaskIds = new Set(); // 已沉淀（归档）的任务：出列表 / 分层 / 统计，但记录留在库里
let archivedTasks = []; // 已沉淀任务的完整行（供「已沉淀」区展示与恢复）
let points = []; // 积分流水
let rewards = []; // 心愿奖励
let goals = []; // 月目标
let moneyRecords = []; // 收支记录
let moneyPeriod = "week"; // 收支页统计口径：week | month | year
let moneyAnchor = null; // 收支页当前查看的锚点日期 { y, m, d }（null = 当前周期）
let longtermTasks = []; // 长线任务（含子任务，parent_id 关联）
let checkinItems = []; // 项目打卡：想坚持的小事
let checkinRecords = []; // 打卡记录 { item_id, checkin_date }
let ltView = null; // 长线月历当前查看的 { y, m }（null = 本月）
let userCode = null; // 用户唯一 ID（user_profiles）
let monthView = null; // 月历当前查看的 { y, m }（null = 本月）
let events = []; // 当前选中日期的日程
let selectedDate = localDateStr(new Date());
let currentTaskId = null; // 分层页当前任务
let timer = null; // { subtaskId, taskId, total, remaining, running, startedAt, intervalId }
/* 降低启动成本：任务列表页视图（today=今日三件事 / all=全部任务），默认今天只看 3 件 */
let cardsMode = "today";
try { cardsMode = localStorage.getItem("pomo_cards_mode") === "all" ? "all" : "today"; } catch (e) {}
let pickSkip = new Set(); // 「换一个」时暂时跳过的子任务

function $id(id) { return document.getElementById(id); }
/* 静态页可能被浏览器缓存旧版 HTML：元素缺失时 bind 不报错，页面其余功能照常 */
function bind(id, evt, fn) { const el = $id(id); if (el) el.addEventListener(evt, fn); }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function localDateStr(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function fmtDur(sec) {
  if (!sec || sec <= 0) return "0分钟";
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (h > 0) return m > 0 ? h + "小时" + m + "分钟" : h + "小时";
  return m + "分钟";
}
function toast(msg, isErr) {
  const t = $id("toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 2600);
}
async function db(promise, okMsg) {
  const { data, error } = await promise;
  if (error) {
    if (error.code === "42501") toast("没有权限操作这条数据，请重新登录后再试", true);
    else toast(error.message || "操作失败，请重试", true);
    throw error;
  }
  if (okMsg) toast(okMsg);
  return data;
}

/* ============ 登录 ============ */
let pendingOtp = null; // { phone, verificationId, isExistingUser }
let codeCountdown = 0;

function showLogin() {
  $id("loginView").classList.remove("hidden");
  $id("appView").classList.add("hidden");
}
function showApp() {
  $id("loginView").classList.add("hidden");
  $id("appView").classList.remove("hidden");
}

bind("sendCodeBtn", "click", async () => {
  const phone = $id("phoneInput").value.trim();
  if (!/^1\d{10}$/.test(phone)) {
    $id("phoneError").textContent = "请输入正确的 11 位手机号";
    return;
  }
  $id("phoneError").textContent = "";
  $id("loginError").textContent = "";
  const btn = $id("sendCodeBtn");
  btn.disabled = true;
  const sent = await cloud.auth.sendOtp({ phone });
  if (sent.error) {
    $id("loginError").textContent = sent.error.message || "验证码发送失败";
    btn.disabled = false;
    return;
  }
  pendingOtp = { phone, verificationId: sent.data.verificationId, isExistingUser: sent.data.isExistingUser };
  toast("验证码已发送，请查收短信");
  codeCountdown = 60;
  btn.textContent = codeCountdown + "s";
  const iv = setInterval(() => {
    codeCountdown--;
    if (codeCountdown <= 0) { clearInterval(iv); btn.disabled = false; btn.textContent = "获取验证码"; }
    else btn.textContent = codeCountdown + "s";
  }, 1000);
});

bind("loginBtn", "click", async () => {
  const phone = $id("phoneInput").value.trim();
  const code = $id("codeInput").value.trim();
  if (!/^1\d{10}$/.test(phone)) { $id("phoneError").textContent = "请输入正确的 11 位手机号"; return; }
  if (!pendingOtp || pendingOtp.phone !== phone) {
    $id("loginError").textContent = "请先为当前手机号获取验证码";
    return;
  }
  if (!code) { $id("loginError").textContent = "请输入验证码"; return; }
  $id("loginBtn").disabled = true;
  const completed = await cloud.auth.verifyOtp({
    phone: pendingOtp.phone,
    verificationId: pendingOtp.verificationId,
    isExistingUser: pendingOtp.isExistingUser,
    token: code,
  });
  $id("loginBtn").disabled = false;
  if (completed.error) {
    $id("loginError").textContent = completed.error.message || "验证失败，请重试";
    return;
  }
  pendingOtp = null;
  await boot();
});

bind("logoutBtn", "click", async () => {
  if (timer) stopTimer(false);
  await cloud.auth.signOut();
});

/* ============ 数据加载 ============ */
async function loadAll() {
  const [t, s, p, it, pt, rw, gl, mr, lt, ci, cr] = await Promise.all([
    cloud.database.from("tasks").select("*").order("sort_order").order("id"),
    cloud.database.from("subtasks").select("*").order("id"),
    cloud.database.from("pomodoro_sessions").select("*").order("started_at").limit(5000),
    cloud.database.from("subtask_items").select("*").order("id"),
    cloud.database.from("points_ledger").select("*").order("id").limit(3000),
    cloud.database.from("rewards").select("*").order("id"),
    cloud.database.from("monthly_goals").select("*").order("id"),
    cloud.database.from("money_records").select("*").order("record_date").order("id").limit(5000),
    cloud.database.from("longterm_tasks").select("*").order("sort_order").order("id"),
    cloud.database.from("checkin_items").select("*").order("id"),
    cloud.database.from("checkin_records").select("*").order("checkin_date").order("id").limit(5000),
  ]);
  const err = t.error || s.error || p.error || it.error || pt.error || rw.error || gl.error || mr.error || lt.error || ci.error || cr.error;
  if (err) {
    toast("数据加载失败：" + (err.message || "请刷新重试"), true);
    return;
  }
  const rawTasks = t.data || [];
  archivedTaskIds = new Set(rawTasks.filter(x => x.archived).map(x => x.id));
  archivedTasks = rawTasks.filter(x => x.archived);
  tasks = rawTasks.filter(x => !x.archived);          // 列表 / 分层 / 统计只看活跃任务
  allSubtasks = s.data || [];
  subtasks = allSubtasks.filter(x => !archivedTaskIds.has(x.task_id));
  sessions = p.data || [];                            // 全量：归档任务的历史专注仍要计入月历
  const archSubIds = new Set(allSubtasks.filter(x => archivedTaskIds.has(x.task_id)).map(x => x.id));
  items = (it.data || []).filter(x => !archSubIds.has(x.subtask_id));
  points = pt.data || [];
  rewards = rw.data || [];
  goals = gl.data || [];
  moneyRecords = mr.data || [];
  longtermTasks = lt.data || [];
  checkinItems = ci.data || [];
  checkinRecords = cr.data || [];
  renderPointsChip();
}

async function boot() {
  const { data: session, error } = await cloud.auth.getSession();
  if (error || !session) { showLogin(); return; }
  showApp();
  $id("userLabel").textContent = "已登录";
  await loadAll();
  ensureUserProfile(); // 用户唯一 ID（异步，不阻塞）
  restoreTimer();
  restoreRest(); // 休息中途刷新/锁屏回来，接着计时
  renderAll();
  renderFloat();
  setTimeout(guideOnEnter, 2500); // 默认落在任务列表，伙伴打个招呼
  initChat(); // 心理页：加载模型列表与历史对话（异步，不阻塞）
}

/* 用户 ID：首次登录自动生成，之后可自行改成昵称（全局唯一，被占用则改不了） */
let profileId = null;
let moneyBase = { save: 0, invest: 0 }; // 储蓄/投资基础金额（记录流水之外的存量，可自行修改）
async function ensureUserProfile() {
  try {
    const got = await cloud.database.from("user_profiles").select("*").limit(1);
    if (got && got.data && got.data[0]) {
      profileId = got.data[0].id;
      userCode = got.data[0].user_code;
      moneyBase.save = parseFloat(got.data[0].save_base) || 0;
      moneyBase.invest = parseFloat(got.data[0].invest_base) || 0;
      try { customCats = JSON.parse(got.data[0].custom_categories || "[]") || []; } catch (e) { customCats = []; }
      if (got.data[0].theme) applyTheme(got.data[0].theme); // 恢复上次用的皮肤
    } else if (got && !got.error) {
      for (let i = 0; i < 5 && !userCode; i++) {
        const code = "U" + String(Math.floor(100000 + Math.random() * 900000));
        const ins = await cloud.database.from("user_profiles").insert({ user_code: code }).select();
        if (ins && ins.data && ins.data[0]) {
          profileId = ins.data[0].id;
          userCode = ins.data[0].user_code;
        }
        // 唯一冲突（撞号）时自动换号重试
      }
    }
  } catch (e) { /* 静默：不影响主流程 */ }
  updateUserLabel();
}
function updateUserLabel() {
  const lbl = $id("userLabel");
  if (lbl && userCode) {
    lbl.textContent = "🪪 " + userCode;
    lbl.title = "我的 ID（点击修改成昵称）";
    lbl.style.cursor = "pointer";
  }
}

bind("userLabel", "click", () => {
  if (!userCode) return;
  openModal(
    "<h3>我的 ID</h3>" +
    '<p style="color:var(--text-sub);font-size:13px;margin-top:-8px;margin-bottom:10px">当前 ID：<b style="color:var(--text)">' + esc(userCode) + "</b> · 全局唯一，可以随时改成你喜欢的昵称</p>" +
    '<label class="modal-label">新 ID（2-16 个字，中英文/数字都行，不能有空格）</label>' +
    '<input id="mIdInput" class="modal-input" maxlength="16" value="' + esc(userCode) + '" placeholder="例如：小明 / action_2026">' +
    '<div class="modal-actions">' +
    '<button class="btn ghost" id="mIdCopy">复制当前 ID</button>' +
    '<button class="btn primary" id="mIdSave">保存</button>' +
    "</div>"
  );
  const input = $id("mIdInput");
  input.focus();
  input.select();
  bind("mIdCopy", "click", () => {
    const ok = () => toast("已复制：" + userCode);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(userCode).then(ok, ok);
    else ok();
  });
  const save = async () => {
    const v = input.value.trim();
    if (v === userCode) { closeModal(); return; }
    if (v.length < 2) { toast("ID 至少 2 个字符", true); return; }
    if (/\s/.test(v)) { toast("ID 里不能有空格", true); return; }
    try {
      const res = await cloud.database.from("user_profiles").update({ user_code: v }).eq("id", profileId).select();
      if (res && res.error) {
        toast(res.error.code === "23505" ? "这个 ID 已经被别人用了，换一个吧" : (res.error.message || "保存失败，请重试"), true);
        return;
      }
      if (res && res.data && res.data[0]) userCode = res.data[0].user_code;
      else userCode = v;
      updateUserLabel();
      closeModal();
      toast("ID 已改为：🪪 " + userCode);
    } catch (e) { /* 静默 */ }
  };
  bind("mIdSave", "click", save);
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) save(); });
});

cloud.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT") {
    tasks = []; subtasks = []; sessions = []; items = []; events = [];
    points = []; rewards = []; goals = []; moneyRecords = []; userCode = null; profileId = null; moneyPeriod = "week"; moneyAnchor = null;
    moneyBase = { save: 0, invest: 0 };
    customCats = [];
    archivedTasks = [];
    longtermTasks = []; checkinItems = []; checkinRecords = [];
    applyTheme("default"); // 退出登录恢复默认主题
    chatMsgs = []; abcRecords = []; abcLoaded = false;
    saveChatStorage();
    exitLayer();
    showLogin();
  }
});

/* ============ Tab 切换 ============ */
document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tab-pane").forEach(p => p.classList.add("hidden"));
    $id("tab-" + btn.dataset.tab).classList.remove("hidden");
    if (btn.dataset.tab === "schedule") renderSchedule();
    if (btn.dataset.tab === "layers") renderLayers();
    if (btn.dataset.tab === "mind") renderMind();
    if (btn.dataset.tab === "points") renderPoints();
    if (btn.dataset.tab === "month") renderMonth();
    if (btn.dataset.tab === "money") renderMoney();
    if (btn.dataset.tab === "cards") guideOnEnter(); // 进入任务列表时的伙伴引导
  });
});

/* ============ 任务卡片 ============ */
function taskSubs(taskId) { return subtasks.filter(s => s.task_id === taskId); }
function taskSeconds(taskId) {
  return sessions.filter(x => x.task_id === taskId).reduce((a, b) => a + (b.duration_seconds || 0), 0);
}
function subSeconds(subId) {
  return sessions.filter(x => x.subtask_id === subId).reduce((a, b) => a + (b.duration_seconds || 0), 0);
}

/* 推荐引擎：优先级高 → 进行中 → 更小/更明确时长的排前面（降低「做哪个」的决策成本） */
function subScore(s) {
  const w = { high: 3, mid: 2, low: 1 };
  const t = tasks.find(x => x.id === s.task_id);
  return (w[t ? t.level : "mid"] || 2) * 10 + (subSeconds(s.id) > 0 ? 3 : 0) + (s.est_minutes ? Math.max(0, 6 - Math.min(6, s.est_minutes / 10)) : 0);
}
function computePicks() {
  const undone = subtasks.filter(s => !s.done && !pickSkip.has(s.id));
  return undone.sort((a, b) => subScore(b) - subScore(a) || a.id - b.id).slice(0, 3);
}
function pickBestSub() {
  const undone = subtasks.filter(s => !s.done);
  if (!undone.length) return null;
  return undone.sort((a, b) => subScore(b) - subScore(a) || a.id - b.id)[0];
}

/* 今日三件事的卡片：一眼一个选择，▶ 直接开计时 */
function todayCardHtml(s) {
  const task = tasks.find(t => t.id === s.task_id);
  const lv = LEVELS[task ? task.level : "mid"] || LEVELS.mid;
  const cat = catOf(task);
  const its = items.filter(i => i.subtask_id === s.id);
  const doneCnt = its.filter(i => i.done).length;
  const chipHtml = its.length ? its.map(i =>
    '<div class="sub-chip' + (i.done ? " is-done" : "") + '" data-item="' + i.id + '">' +
    '<span class="sub-check" data-checkitem="' + i.id + '">✓</span>' +
    '<span class="sub-name">' + esc(i.title) + '</span>' +
    '<button class="sub-del" data-delitem="' + i.id + '" title="删除子子任务">✕</button>' +
    '</div>').join("") : '<div class="subtask-empty">暂无子子任务</div>';
  const meta = (task ? cat.icon + " " + esc(task.title) + " · " : "") + doneCnt + "/" + its.length + " 子子任务 · 已用 " + fmtDur(subSeconds(s.id)) +
    (s.est_minutes ? ' · 建议 ' + s.est_minutes + ' 分钟' : "");
  return '<div class="task-card" style="--card-color:' + lv.bg + ';--card-border:' + lv.border + ';--dot-color:' + lv.color + '">' +
    '<div class="task-head"><span class="cat-badge" title="' + cat.label + '">' + cat.icon + '</span>' +
    '<span class="task-title layer-card-title" data-submodal="' + s.id + '" title="进入规划与番茄钟">' + esc(s.title) + '</span>' +
    '<button class="task-edit" data-renamesub="' + s.id + '" title="修改名称">✎</button>' +
    '<button class="task-del" data-delsub="' + s.id + '" title="删除">✕</button>' +
    '</div>' +
    '<div class="task-meta">' + meta + '</div>' +
    '<div class="sub-grid">' + chipHtml + '</div>' +
    '<div class="today-btns">' +
    '<button class="btn primary" data-startsub="' + s.id + '">▶ 开始专注</button>' +
    '<button class="btn ghost" data-swapsub="' + s.id + '">换一个</button>' +
    '</div></div>';
}

function renderCards() {
  const grid = $id("cardsGrid");
  renderReturnBar();
  const mT = $id("modeTodayBtn"), mA = $id("modeAllBtn");
  if (mT) mT.classList.toggle("active", cardsMode === "today");
  if (mA) mA.classList.toggle("active", cardsMode === "all");
  if (!tasks.length) {
    grid.innerHTML = '<div class="cards-empty">还没有任务，点右上角「新建任务」或用上方「一句话记事」开始吧 🍅</div>' + settledSectionHtml();
    return;
  }
  if (cardsMode === "today") {
    let picks = computePicks();
    if (!picks.length && subtasks.some(s => !s.done)) { pickSkip.clear(); picks = computePicks(); }
    if (!picks.length) {
      grid.innerHTML = '<div class="cards-empty">' + (subtasks.some(s => !s.done) ? "没有可推荐的待办" : "所有子任务都完成了，好好休息 🎉") + "</div>";
    } else {
      grid.innerHTML = '<div class="today-hint">今天先做这 ' + picks.length + ' 件就好，别的都不用看 👇</div><div class="cards-grid today-grid">' +
        picks.map(s => todayCardHtml(s)).join("") + "</div>";
    }
    return;
  }
  grid.innerHTML = tasks.map(t => {
    const subs = taskSubs(t.id);
    const allDone = subs.length > 0 && subs.every(s => s.done);
    const lv = LEVELS[t.level] || LEVELS.mid;
    const cat = catOf(t);
    const doneCnt = subs.filter(s => s.done).length;
    const subHtml = subs.length ? subs.map(s => {
      const sec = subSeconds(s.id);
      return '<div class="sub-chip' + (s.done ? " is-done" : "") + '" data-sub="' + s.id + '" title="' + esc(s.title) + '">' +
        '<span class="sub-check" data-check="' + s.id + '">✓</span>' +
        '<span class="sub-name">' + esc(s.title) + '</span>' +
        (sec > 0 ? '<span class="sub-time">' + fmtDur(sec) + '</span>' : "") +
        '<button class="sub-del" data-delsub="' + s.id + '" title="删除子任务">✕</button>' +
        '</div>';
    }).join("") : '<div class="subtask-empty">暂无子任务</div>';
    return '<div class="task-card' + (allDone ? " done-card" : "") + '" style="--card-color:' + lv.bg + ';--card-border:' + lv.border + ';--dot-color:' + lv.color + '">' +
      '<div class="task-head">' +
      '<span class="cat-badge" title="' + cat.label + '">' + cat.icon + '</span>' +
      '<span class="task-title task-title-edit" data-renametask="' + t.id + '" title="点击修改任务名称">' + esc(t.title) + '</span>' +
      (allDone ? '<button class="task-settle" data-settle="' + t.id + '" title="纳入已沉淀任务">📦</button>' : "") +
      '<button class="task-layer" data-layer="' + t.id + '" title="进入分层页">›</button>' +
      '<button class="task-del" data-deltask="' + t.id + '" title="删除任务">✕</button>' +
      '</div>' +
      '<div class="task-meta">' + cat.label + ' · ' + lv.label + ' · ' + doneCnt + '/' + subs.length + ' 完成 · ' + fmtDur(taskSeconds(t.id)) + '</div>' +
      '<div class="sub-grid">' + subHtml + '</div>' +
      '<div class="add-subtask">' +
      '<input placeholder="添加子任务，回车确认" data-addsub="' + t.id + '">' +
      '<button data-addsubbtn="' + t.id + '">＋</button>' +
      '</div></div>';
  }).join("") + settledSectionHtml();
}

// 卡片区事件委托（任务级 + 今日三件事卡片 + 子任务级共用一条链，避免重复弹窗）
bind("cardsGrid", "click", async (e) => {
  const settledBtn = e.target.closest("#settledToggle");
  if (settledBtn) {
    const l = $id("settledList");
    if (l) l.classList.toggle("hidden");
    return;
  }
  const rstBtn = e.target.closest("[data-restore]");
  if (rstBtn) {
    await restoreTask(+rstBtn.dataset.restore);
    return;
  }
  const delSt = e.target.closest("[data-delsettled]");
  if (delSt) {
    const id = +delSt.dataset.delsettled;
    if (delSt.dataset.armed !== "1") {
      delSt.dataset.armed = "1";
      delSt.classList.add("armed");
      delSt.textContent = "确认删除？";
      setTimeout(() => {
        if (!document.body.contains(delSt)) return;
        delSt.dataset.armed = "";
        delSt.classList.remove("armed");
        delSt.textContent = "🗑";
      }, 3000);
      return;
    }
    await hardDeleteTask(id);
    return;
  }
  const settleBtn = e.target.closest("[data-settle]");
  if (settleBtn) {
    await offerSettle(+settleBtn.dataset.settle);
    return;
  }
  const layerBtn = e.target.closest("[data-layer]");
  const renTask = e.target.closest("[data-renametask]");
  const delTask = e.target.closest("[data-deltask]");
  const startBtn = e.target.closest("[data-startsub]");
  const swapBtn = e.target.closest("[data-swapsub]");

  try {
    if (layerBtn) {
      enterLayer(+layerBtn.dataset.layer);
      return;
    }
    if (renTask) {
      const t = tasks.find(x => x.id === +renTask.dataset.renametask);
      if (t) renameTask(t);
      return;
    }
    if (delTask) {
      const id = +delTask.dataset.deltask;
      const t = tasks.find(x => x.id === id);
      if (!t) return;
      const subs = taskSubs(id);
      const done = subs.length > 0 && subs.every(s => s.done);
      const ok = await confirmDialog({
        title: "删除任务",
        desc: done
          ? "「" + esc(t.title) + "」已完成。删除后任务不再出现在列表和统计里，但月历打卡、专注记录和积分会保留。"
          : "「" + esc(t.title) + "」还没完成。删除后所有相关数据（含专注记录和积分）会一并清除，无法恢复。",
        okText: "删除任务",
      });
      if (ok) await deleteTask(id);
      return;
    }
    if (startBtn) {
      const s = subtasks.find(x => x.id === +startBtn.dataset.startsub);
      if (s) openSubtaskModal(s, true); // 直接开计时，不再选时长
      return;
    }
    if (swapBtn) {
      pickSkip.add(+swapBtn.dataset.swapsub);
      renderCards();
      return;
    }
    const check = e.target.closest("[data-check]");
    if (check) {
      e.stopPropagation();
      const id = +check.dataset.check;
      const s = subtasks.find(x => x.id === id);
      if (!s) return;
      const nd = !s.done;
      const wasDone = s.done;
      const wasAllDone = (() => { const ss = taskSubs(s.task_id); return ss.length > 0 && ss.every(x => x.done); })();
      const rows = await db(cloud.database.from("subtasks").update({ done: nd, done_at: nd ? new Date().toISOString() : null }).eq("id", id).select());
      if (rows && rows.length) Object.assign(s, rows[0]);
      renderAll();
      await awardOnSubtaskToggle(s, wasDone, wasAllDone);
      if (nd) {
        celebrate();
        sayCompanion("恭喜你！变得更棒啦！");
        const subs = taskSubs(s.task_id);
        if (subs.length && subs.every(x => x.done)) await offerSettle(s.task_id);
      }
      return;
    }
    const addBtn = e.target.closest("[data-addsubbtn]");
    if (addBtn) {
      const input = document.querySelector('input[data-addsub="' + addBtn.dataset.addsubbtn + '"]');
      await addSubtask(+addBtn.dataset.addsubbtn, input);
      return;
    }
    const chipEl = e.target.closest(".sub-chip[data-sub]");
    if (chipEl) {
      const s = subtasks.find(x => x.id === +chipEl.dataset.sub);
      if (s) openSubtaskModal(s);
      return;
    }
    // 其余（子项勾选/删除、子任务改名/删除、卡片标题进弹窗）复用分层页逻辑
    await onSubtaskGridClick(e);
  } catch (err) { /* db() 已提示 */ }
});

bind("cardsGrid", "keydown", (e) => {
  /* 输入法组词中按回车是在确认拼音/候选词，不是提交——放行会误存（英文/中文输入法都受影响） */
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter" && e.target.dataset && e.target.dataset.addsub) {
    addSubtask(+e.target.dataset.addsub, e.target);
  }
});

async function addSubtask(taskId, input) {
  if (!input) return;
  const title = input.value.trim();
  if (!title) { toast("请输入子任务内容", true); return; }
  const rows = await db(cloud.database.from("subtasks").insert({ task_id: taskId, title }).select());
  if (rows && rows[0]) subtasks.push(rows[0]);
  renderAll();
  /* 输入框被 renderAll 重建：找到新的那个并保持焦点，方便一口气加完所有阶段 */
  const next = document.querySelector('input[data-addsub="' + taskId + '"]');
  if (next) next.focus();
}

bind("addTaskBtn", "click", () => {
  openModal(
    "<h3>新建任务</h3>" +
    '<label class="modal-label">任务标题（如：学英语）</label>' +
    '<input id="mTaskTitle" class="modal-input" placeholder="输入任务标题" maxlength="50">' +
    '<label class="modal-label">分类</label>' +
    categoryPickerHtml("work") +
    '<label class="modal-label">重要程度（决定卡片颜色）</label>' +
    levelPickerHtml("mid") +
    '<div class="modal-actions">' +
    '<button class="btn ghost" data-close="1">取消</button>' +
    '<button class="btn primary" id="mTaskSave">创建</button>' +
    "</div>"
  );
  const getLevel = bindLevelPicker("mid");
  const getCat = bindCategoryPicker("work");
  bind("mTaskSave", "click", async () => {
    const title = $id("mTaskTitle").value.trim();
    if (!title) { toast("请输入任务标题", true); return; }
    const maxSort = tasks.reduce((a, b) => Math.max(a, b.sort_order || 0), 0);
    const rows = await db(cloud.database.from("tasks").insert({ title, level: getLevel(), category: getCat(), sort_order: maxSort + 1 }).select());
    if (rows && rows[0]) tasks.push(rows[0]);
    closeModal();
    renderAll();
  });
  $id("mTaskTitle").focus();
});

/* ============ 降低启动成本：现在就做 / 今日三件事 / 一句话捕获 ============ */
/* 「现在就做」：0 决策——有进行中的计时就接着来，否则系统替你挑一个并直接开始计时 */
bind("doNowBtn", "click", () => {
  if (timer) {
    const s = subtasks.find(x => x.id === timer.subtaskId);
    if (s) { openSubtaskModal(s, true); return; }
  }
  const s = pickBestSub();
  if (!s) { toast(tasks.length ? "所有子任务都完成了，太棒了 🎉" : "先用「一句话记事」记下要做的事吧"); return; }
  openSubtaskModal(s, true);
});

bind("modeTodayBtn", "click", () => { cardsMode = "today"; try { localStorage.setItem("pomo_cards_mode", "today"); } catch (e) {} renderCards(); });
bind("modeAllBtn", "click", () => { cardsMode = "all"; try { localStorage.setItem("pomo_cards_mode", "all"); } catch (e) {} renderCards(); });

/* 一句话捕获：解析「任务：子任务 15分钟」/「背单词15分钟」/「整理半小时」 */
function parseCapture(text) {
  let t = text.trim();
  let minutes = null;
  let m = t.match(/半\s*小时/);
  if (m) { minutes = 30; t = (t.slice(0, m.index) + t.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim(); }
  m = t.match(/(\d{1,3})\s*(?:分钟|分\b|min|mins)/i);
  if (m) { minutes = Math.min(240, +m[1]); t = (t.slice(0, m.index) + t.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim(); }
  let taskName = null, subName = t;
  const sep = t.match(/^([^:：,，/|]+)[:：,，/|]\s*(.+)$/);
  if (sep) { taskName = sep[1].trim(); subName = sep[2].trim(); }
  return { taskName: taskName || null, subName: subName.trim(), minutes };
}

async function quickCapture() {
  const input = $id("captureInput");
  const text = input.value.trim();
  if (!text) return;
  const p = parseCapture(text);
  if (!p.subName) { toast("试试这样写：学英语：背单词 15分钟", true); return; }
  let task = p.taskName ? tasks.find(t => t.title === p.taskName) : tasks.find(t => t.title === "收件箱");
  try {
    if (!task) {
      const maxSort = tasks.reduce((a, b) => Math.max(a, b.sort_order || 0), 0);
      const rows = await db(cloud.database.from("tasks").insert({
        title: p.taskName || "收件箱",
        level: "mid",
        category: p.taskName ? "work" : "life",
        sort_order: maxSort + 1,
      }).select());
      if (rows && rows[0]) { task = rows[0]; tasks.push(task); }
    }
    const rows2 = await db(cloud.database.from("subtasks").insert({
      task_id: task.id, title: p.subName, est_minutes: p.minutes,
    }).select());
    if (rows2 && rows2[0]) subtasks.push(rows2[0]);
    input.value = "";
    renderAll();
    toast("已收进「" + task.title + "」：" + p.subName + (p.minutes ? "（建议 " + p.minutes + " 分钟）" : ""));
  } catch (e) { /* db() 已提示 */ }
}
bind("captureBtn", "click", quickCapture);
bind("captureInput", "keydown", (e) => { if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) quickCapture(); });

/* 完成庆祝：彩纸 + 上行三连音（即时反馈，多巴胺） */
function celebrate() {
  try {
    const box = document.createElement("div");
    box.className = "celebrate";
    const colors = ["#e5484d", "#f5a623", "#2fbf71", "#4f8cff", "#b18cff", "#ff8fab"];
    for (let i = 0; i < 28; i++) {
      const s = document.createElement("i");
      s.style.left = Math.random() * 100 + "%";
      s.style.background = colors[i % colors.length];
      s.style.animationDelay = (Math.random() * 0.3) + "s";
      s.style.animationDuration = (1.2 + Math.random() * 0.9) + "s";
      box.appendChild(s);
    }
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 2500);
  } catch (e) {}
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [523, 659, 784].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = f;
      o.connect(g); g.connect(ctx.destination);
      const t0 = ctx.currentTime + i * 0.12;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.16, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
      o.start(t0); o.stop(t0 + 0.32);
    });
  } catch (e) {}
}

/* ============ 分层页面（子任务作为卡片标题） ============ */
function enterLayer(taskId) {
  currentTaskId = taskId;
  document.querySelector(".tabs").classList.add("hidden");
  document.querySelector("main").classList.add("hidden");
  $id("layerView").classList.remove("hidden");
  renderLayer();
  window.scrollTo(0, 0);
  guideOnEnter(); // 进入卡片界面时的伙伴引导
}

function exitLayer() {
  currentTaskId = null;
  $id("layerView").classList.add("hidden");
  document.querySelector(".tabs").classList.remove("hidden");
  document.querySelector("main").classList.remove("hidden");
}

bind("layerBackBtn", "click", exitLayer);

function renderLayer() {
  const task = tasks.find(t => t.id === currentTaskId);
  if (!task) { exitLayer(); return; }
  $id("layerTitle").textContent = task.title;
  /* 主任务的执行计划（子任务有，主任务也该有）：默认有内容就展开 */
  const planWrap = $id("layerPlanWrap");
  if (planWrap) {
    planWrap.innerHTML = '<details class="task-plan"' + (task.plan ? " open" : "") + ">" +
      '<summary>📋 执行计划 / 要点</summary>' +
      '<textarea id="layerPlanText" placeholder="写下这个任务的整体计划、要点或备注…">' + esc(task.plan || "") + "</textarea>" +
      '<button class="btn ghost small" id="layerPlanSave" style="margin-top:6px">保存计划</button>' +
      "</details>";
    bind("layerPlanSave", "click", async () => {
      const plan = $id("layerPlanText").value;
      const rows = await db(cloud.database.from("tasks").update({ plan }).eq("id", task.id).select());
      if (rows && rows[0]) Object.assign(task, rows[0]);
      toast("计划已保存");
    });
  }
  const grid = $id("layerGrid");
  const subs = taskSubs(task.id);
  if (!subs.length) {
    grid.innerHTML = '<div class="cards-empty">该任务还没有子任务，回到任务列表添加后，就能在这里按子任务分层</div>';
    return;
  }
  grid.innerHTML = subs.map(s => subtaskCardHtml(s, false)).join("");
}

/* 一张「子任务为标题」的卡片 */
function subtaskCardHtml(s, showTask) {
  const task = tasks.find(t => t.id === s.task_id);
  const lv = LEVELS[task ? task.level : "mid"] || LEVELS.mid;
  const cat = catOf(task);
  const its = items.filter(i => i.subtask_id === s.id);
  const doneCnt = its.filter(i => i.done).length;
  /* 变绿规则：子任务本身勾选了完成，或（有子子任务且全部完成）。
     之前只看子子任务，导致「已完成但没有子子任务」的卡片永远不变绿 */
  const allDone = s.done || (its.length > 0 && its.every(i => i.done));
  const chipHtml = its.length ? its.map(i =>
    '<div class="sub-chip' + (i.done ? " is-done" : "") + '" data-item="' + i.id + '">' +
    '<span class="sub-check" data-checkitem="' + i.id + '">✓</span>' +
    '<span class="sub-name">' + esc(i.title) + '</span>' +
    '<button class="sub-del" data-delitem="' + i.id + '" title="删除子子任务">✕</button>' +
    '</div>').join("") : '<div class="subtask-empty">暂无子子任务</div>';
  const meta = (showTask && task ? cat.icon + " " + esc(task.title) + " · " : "") + (s.done ? "已完成 ✓ · " : "") +
    doneCnt + "/" + its.length + " 子子任务 · 用时 " + fmtDur(subSeconds(s.id));
  return '<div class="task-card' + (allDone ? " done-card" : "") + '" style="--card-color:' + lv.bg + ';--card-border:' + lv.border + ';--dot-color:' + lv.color + '">' +
    '<div class="task-head"><span class="cat-badge" title="' + cat.label + '">' + cat.icon + '</span>' +
    '<span class="task-title layer-card-title" data-submodal="' + s.id + '" title="进入规划与番茄钟">' + esc(s.title) + '</span>' +
    '<button class="task-edit" data-renamesub="' + s.id + '" title="修改子任务名称">✎</button>' +
    '<button class="task-del" data-delsub="' + s.id + '" title="删除该卡片">✕</button>' +
    '</div>' +
    '<div class="task-meta">' + meta + '</div>' +
    '<div class="sub-grid">' + chipHtml + '</div>' +
    '<div class="add-subtask">' +
    '<input placeholder="添加子子任务，回车确认" data-additem="' + s.id + '">' +
    '<button data-additembtn="' + s.id + '">＋</button>' +
    '</div></div>';
}

/* 独立页面：所有子任务平铺成卡片 */
function renderLayers() {
  const grid = $id("layersGrid");
  const kw = ($id("layersSearch").value || "").trim().toLowerCase();
  let list = subtasks.slice();
  if (kw) list = list.filter(s => s.title.toLowerCase().includes(kw));
  if (!list.length) {
    grid.innerHTML = '<div class="cards-empty">' + (subtasks.length ? "没有匹配的卡片" : "还没有子任务卡片，先去任务列表添加子任务") + "</div>";
    return;
  }
  grid.innerHTML = list.map(s => subtaskCardHtml(s, true)).join("");
}

async function addItem(subtaskId, input) {
  if (!input) return;
  const title = input.value.trim();
  if (!title) { toast("请输入子子任务内容", true); return; }
  const rows = await db(cloud.database.from("subtask_items").insert({ subtask_id: subtaskId, title }).select());
  if (rows && rows[0]) items.push(rows[0]);
  input.value = "";
  renderAll();
}

async function toggleItemDone(it) {
  const rows = await db(cloud.database.from("subtask_items").update({ done: !it.done, done_at: !it.done ? new Date().toISOString() : null }).eq("id", it.id).select());
  if (rows && rows.length) Object.assign(it, rows[0]);
  renderAll();
  await awardPoints(it.done ? 3 : -3, (it.done ? "完成子子任务：" : "取消子子任务：") + it.title, "item", it.id);
  if (it.done) {
    celebrate();
    const sib = items.filter(i => i.subtask_id === it.subtask_id);
    if (sib.length && sib.every(x => x.done)) {
      const s = subtasks.find(x => x.id === it.subtask_id);
      toast("🎉 「" + (s ? s.title : "") + "」的子子任务全部完成，卡片已变绿！");
    }
  }
}

/* 子子任务弹窗：规划 + 番茄钟，完成只作用于子项本身（计时仍归到所属子任务，统计不受影响） */
function openItemModal(it) {
  const s = subtasks.find(x => x.id === it.subtask_id);
  const task = s ? tasks.find(t => t.id === s.task_id) : null;
  settleTimerFor(s ? s.id : null);
  const isThisTimer = timer && s && timer.subtaskId === s.id;
  const defMin = isThisTimer ? Math.round(timer.total / 60) : 25;
  openModal(
    '<div class="modal-head-row">' +
    "<h3>" + esc(it.title) + "</h3>" +
    '<button class="link-btn" id="mRenameItem">✎ 重命名</button>' +
    "</div>" +
    '<div style="color:var(--text-sub);font-size:13px;margin-top:-10px;margin-bottom:6px">子子任务 · 属于「' + esc(s ? s.title : "") + "」" + (task ? " · " + esc(task.title) : "") + '</div>' +
    '<label class="modal-label">任务规划（怎么做这一小步）</label>' +
    '<textarea id="mIPlan" class="modal-textarea" placeholder="写下执行计划、要点或备注…">' + esc(it.plan || "") + "</textarea>" +
    '<button class="btn ghost small" id="mIPlanSave" style="margin-top:8px">保存规划</button>' +
    '<label class="modal-label">番茄钟计时</label>' +
    '<div class="pomo-durs" id="pomoDurs">' +
    [5, 15, 25, 45].map(d => '<button class="pomo-dur-btn' + (d === defMin ? " active" : "") + '" data-dur="' + d + '"' + (isThisTimer && timer.running ? " disabled" : "") + ">" + d + "分钟</button>").join("") +
    "</div>" +
    '<div class="pomo-face" id="pomoFace"><div class="pomo-time" id="pomoTime">25:00</div><div class="pomo-status" id="pomoStatus">准备开始</div></div>' +
    '<div class="pomo-btns">' +
    '<button class="btn primary" id="pomoStartBtn">开始</button>' +
    '<button class="btn ghost" id="pomoStopBtn">结束并记录</button>' +
    "</div>" +
    '<div class="modal-actions" style="margin-top:16px">' +
    '<button class="btn ' + (it.done ? "ghost" : "primary") + '" id="mIDoneBtn">' + (it.done ? "取消完成 ✓" : "完成子子任务 ✓") + "</button>" +
    '<button class="btn ghost" data-close="1">关闭</button>' +
    "</div>" +
    '<button class="btn ghost danger-text block" id="mDelItemBtn" style="margin-top:10px">删除这个子子任务</button>'
  );

  if (!isThisTimer && s) {
    timer = { subtaskId: s.id, taskId: s.task_id, total: defMin * 60, remaining: defMin * 60, running: false, intervalId: null, startedAt: null, elapsed: 0, runSince: null };
  }
  renderTimerFace();

  bind("mIPlanSave", "click", async () => {
    const plan = $id("mIPlan").value;
    const rows = await db(cloud.database.from("subtask_items").update({ plan }).eq("id", it.id).select());
    if (rows && rows.length) Object.assign(it, rows[0]);
    toast("规划已保存");
  });

  bind("mRenameItem", "click", () => renameItem(it));

  bind("mDelItemBtn", "click", async () => {
    const ok = await confirmDialog({
      title: "删除子子任务",
      desc: "「" + esc(it.title) + "」删除后无法恢复，确定吗？",
      okText: "删除",
    });
    if (!ok) { openItemModal(it); return; }
    const rows = await db(cloud.database.from("subtask_items").delete().eq("id", it.id).select());
    if (blocked(rows)) { toast("删除失败，请重新登录后再试", true); return; }
    items = items.filter(x => x.id !== it.id);
    closeModal();
    renderAll();
  });

  bind("pomoDurs", "click", (e) => {
    const b = e.target.closest(".pomo-dur-btn");
    if (!b || timer.running) return;
    setTimerDuration(+b.dataset.dur);
    $id("pomoDurs").querySelectorAll(".pomo-dur-btn").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    renderTimerFace();
  });

  bind("pomoStartBtn", "click", () => { startTimer(); });

  bind("pomoStopBtn", "click", () => {
    syncTimer();
    if (timerElapsedSec() < 1) { toast("还没有开始计时", true); return; }
    const elapsed = Math.min(timer.total, Math.round(timerElapsedSec()));
    stopTimer(true);
    toast("本次专注已记录 " + fmtDur(elapsed) + " · +" + Math.max(1, Math.round(elapsed / 300)) + " 分");
    closeModal();
    if (elapsed >= 300 && s) setTimeout(() => openRest(s), 400); // 干了一段了，先安排休息再谈回来
  });

  bind("mIDoneBtn", "click", async () => {
    const willDone = !it.done;
    if (timer && timer.subtaskId === (s ? s.id : null)) stopTimer(true);
    await toggleItemDone(it);
    closeModal();
    if (willDone) toast("子子任务已完成 ✓");
  });
}

function renameItem(it) {
  openModal(
    "<h3>修改子子任务</h3>" +
    '<label class="modal-label">名称</label>' +
    '<input id="mRenItemTitle" class="modal-input" maxlength="50" value="' + esc(it.title) + '" placeholder="输入名称">' +
    '<div class="modal-actions">' +
    '<button class="btn ghost" data-close="1">取消</button>' +
    '<button class="btn primary" id="mRenItemSave">保存</button>' +
    "</div>"
  );
  const input = $id("mRenItemTitle");
  input.focus();
  input.select();
  const save = async () => {
    const title = input.value.trim();
    if (!title) { toast("请输入名称", true); return; }
    const rows = await db(cloud.database.from("subtask_items").update({ title }).eq("id", it.id).select());
    if (blocked(rows)) { toast("保存失败，请重新登录后再试", true); return; }
    Object.assign(it, { title });
    if (rows && rows[0]) Object.assign(it, rows[0]);
    closeModal();
    renderAll();
    toast("子子任务已更新");
  };
  bind("mRenItemSave", "click", save);
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) save(); });
}

async function onSubtaskGridClick(e) {
  const delSub = e.target.closest("[data-delsub]");
  const renSub = e.target.closest("[data-renamesub]");
  const delItem = e.target.closest("[data-delitem]");
  const checkItem = e.target.closest("[data-checkitem]");
  const addBtn = e.target.closest("[data-additembtn]");
  const subModal = e.target.closest("[data-submodal]");
  const chip = e.target.closest(".sub-chip");
  try {
    if (delSub) {
      const id = +delSub.dataset.delsub;
      const s = subtasks.find(x => x.id === id);
      const ok = await confirmDialog({
        title: "删除子任务",
        desc: "「" + esc(s ? s.title : "") + "」及其子子任务、番茄钟记录会一并删除，无法恢复。",
        okText: "删除",
      });
      if (ok) await deleteSubtask(id);
    } else if (renSub) {
      const s = subtasks.find(x => x.id === +renSub.dataset.renamesub);
      if (s) renameSubtask(s);
    } else if (delItem) {
      const id = +delItem.dataset.delitem;
      const rows = await db(cloud.database.from("subtask_items").delete().eq("id", id).select());
      if (blocked(rows)) { toast("删除失败，请重新登录后再试", true); return; }
      items = items.filter(i => i.id !== id);
      renderAll();
    } else if (checkItem) {
      e.stopPropagation();
      const it = items.find(x => x.id === +checkItem.dataset.checkitem);
      if (!it) return;
      await toggleItemDone(it);
    } else if (addBtn) {
      const input = document.querySelector('input[data-additem="' + addBtn.dataset.additembtn + '"]');
      await addItem(+addBtn.dataset.additembtn, input);
    } else if (subModal) {
      const s = subtasks.find(x => x.id === +subModal.dataset.submodal);
      if (s) openSubtaskModal(s);
    } else if (chip) {
      const it = items.find(x => x.id === +chip.dataset.item);
      if (it) openItemModal(it);
    }
  } catch (err) { /* db() 已提示 */ }
}

bind("layerGrid", "click", onSubtaskGridClick);
bind("layersGrid", "click", onSubtaskGridClick);

bind("layerGrid", "keydown", (e) => {
  if (e.key === "Enter" && e.target.dataset && e.target.dataset.additem) {
    addItem(+e.target.dataset.additem, e.target);
  }
});
bind("layersGrid", "keydown", (e) => {
  if (e.key === "Enter" && e.target.dataset && e.target.dataset.additem) {
    addItem(+e.target.dataset.additem, e.target);
  }
});
bind("layersSearch", "input", renderLayers);

bind("addLayerCardBtn", "click", () => {
  if (!tasks.length) { toast("请先在「任务列表」创建一个任务", true); return; }
  openModal(
    "<h3>新建卡片</h3>" +
    '<label class="modal-label">卡片名称（如：动量、反转、A）</label>' +
    '<input id="mCardTitle" class="modal-input" placeholder="输入卡片名称" maxlength="50">' +
    '<label class="modal-label">归属任务</label>' +
    '<select id="mCardTask" class="modal-input">' +
    tasks.map(t => '<option value="' + t.id + '">' + esc(t.title) + "</option>").join("") +
    "</select>" +
    '<div class="modal-actions">' +
    '<button class="btn ghost" data-close="1">取消</button>' +
    '<button class="btn primary" id="mCardSave">创建</button>' +
    "</div>"
  );
  bind("mCardSave", "click", async () => {
    const title = $id("mCardTitle").value.trim();
    const taskId = +$id("mCardTask").value;
    if (!title) { toast("请输入卡片名称", true); return; }
    const rows = await db(cloud.database.from("subtasks").insert({ task_id: taskId, title }).select());
    if (rows && rows[0]) subtasks.push(rows[0]);
    closeModal();
    renderAll();
    toast("卡片已创建");
  });
  $id("mCardTitle").focus();
});

/* ============ 子任务弹窗（规划 + 番茄钟） ============
   计时口径：全部按「真实时间戳」算，不用「每秒减一」。
   浏览器切到后台/锁屏会节流 setInterval（低到 1 次/分钟甚至冻结），
   递减计数会漂移、走完也不触发；这里改成
   remaining = total - (已累计秒数 + 本段已跑秒数)，任何时刻读都准。 */

function timerElapsedSec() {
  if (!timer) return 0;
  const base = timer.elapsed || 0;
  const live = (timer.running && timer.runSince) ? (Date.now() - timer.runSince) / 1000 : 0;
  return base + live;
}
function syncTimer() {
  if (!timer) return 0;
  timer.remaining = Math.max(0, Math.round(timer.total - timerElapsedSec()));
  return timer.remaining;
}

/* 换时长：如果这一轮已经走完（或已用时长超过新时长），就把已用清掉重新算，
   否则会立刻显示 00:00、点开始也没反应 */
function setTimerDuration(mins) {
  if (!timer || timer.running) return;
  const oldTotal = timer.total;
  const used = timerElapsedSec();
  timer.total = mins * 60;
  if (used >= oldTotal || used >= timer.total) {
    timer.elapsed = 0;
    timer.startedAt = null;
  }
  timer.remaining = Math.max(0, Math.round(timer.total - timerElapsedSec()));
}

function renderTimerFace() {
  const face = $id("pomoFace");
  if (!face || !timer) return;
  syncTimer();
  const m = Math.floor(timer.remaining / 60), s = timer.remaining % 60;
  $id("pomoTime").textContent = String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  face.classList.toggle("running", timer.running);
  $id("pomoStatus").textContent = timer.running ? "专注中…" : (timer.remaining === 0 ? "本次已完成" : "准备开始");
  const startBtn = $id("pomoStartBtn");
  if (startBtn) startBtn.textContent = timer.running ? "暂停" : (timer.remaining === 0 ? "再来一轮" : "开始");
  renderFloat();
}

function renderFloat() {
  const f = $id("pomoFloat");
  if (!timer) { f.classList.add("hidden"); return; }
  syncTimer();
  const m = Math.floor(timer.remaining / 60), s = timer.remaining % 60;
  $id("pomoFloatTime").textContent = String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  f.classList.remove("hidden");
}

/* 计时状态持久化：刷新页面、换设备、关掉页面后回来都能「继续上次」 */
function saveTimerState() {
  try {
    if (!timer) return;
    syncTimer();
    const el = timerElapsedSec();
    if (!timer.running && el <= 0) { localStorage.removeItem("pomo_timer_v1"); return; }
    localStorage.setItem("pomo_timer_v1", JSON.stringify({
      subtaskId: timer.subtaskId, taskId: timer.taskId,
      total: timer.total, remaining: timer.remaining, startedAt: timer.startedAt,
      elapsed: el, running: !!timer.running, runSince: timer.runSince || null,
      savedAt: Date.now(),
    }));
  } catch (e) {}
}
function clearTimerState() { try { localStorage.removeItem("pomo_timer_v1"); } catch (e) {} }

function restoreTimer() {
  let st = null;
  try { st = JSON.parse(localStorage.getItem("pomo_timer_v1") || "null"); } catch (e) {}
  if (!st || !st.subtaskId) return;
  const sub = subtasks.find(s => s.id === st.subtaskId);
  if (!sub) { clearTimerState(); return; }

  /* 隔了大半天（12 小时以上）就别追认了，避免昨天的一轮在今天突然入账 */
  const gapH = st.savedAt ? (Date.now() - st.savedAt) / 3600000 : 0;
  if (st.running && gapH > 12) { clearTimerState(); return; }

  const total = st.total || 1500;
  let elapsed = typeof st.elapsed === "number"
    ? st.elapsed
    : Math.max(0, total - (typeof st.remaining === "number" ? st.remaining : total));
  /* 离开时还在跑 → 把「保存那一刻之后」的这段时间也如实算进去（这就是「继续计时」） */
  if (st.running && st.savedAt) elapsed += Math.max(0, (Date.now() - st.savedAt) / 1000);

  if (elapsed >= total) {
    /* 你不在的时候这一轮已经走完 → 直接结算，不留「00:00 还得手动点一下」的残局 */
    const startIso = st.startedAt || new Date(Date.now() - total * 1000).toISOString();
    const pts = Math.max(1, Math.round(total / 300));
    timer = null;
    renderFloat();
    saveSession(st.taskId, st.subtaskId, total, startIso, true).then(() => {
      toast("🍅 离开的时候「" + sub.title + "」这一轮已经走完了 · 记录 " + fmtDur(total) + "，+" + pts + " 分");
    }).catch(() => {});
    clearTimerState();
    return;
  }

  timer = {
    subtaskId: st.subtaskId, taskId: st.taskId, total,
    remaining: Math.max(0, Math.round(total - elapsed)),
    elapsed, running: false, runSince: null, intervalId: null,
    startedAt: st.startedAt || new Date().toISOString(),
  };
  if (st.running) {
    timer.runSince = Date.now();
    timer.running = true;
    timer.intervalId = setInterval(timerTick, 500);
    renderTimerFace();
    renderFloat();
    toast("「" + sub.title + "」计时接着走，还剩 " + fmtDur(timer.remaining));
  } else {
    renderFloat();
    toast("接上次：「" + sub.title + "」还剩 " + fmtDur(timer.remaining) + "，点右下角 🍅 继续");
  }
}

function startTimer() {
  if (!timer) return;
  if (spark) { clearInterval(spark.intervalId); spark = null; } // 真开始计时了，点火层作废
  if (timer.remaining === 0 && timerElapsedSec() >= timer.total) { // 再来一轮
    timer.elapsed = 0;
    timer.remaining = timer.total;
    timer.startedAt = null;
  }
  if (timer.running) { // 暂停：把本段时长结算进 elapsed
    clearInterval(timer.intervalId);
    timer.elapsed = timerElapsedSec();
    timer.runSince = null;
    timer.running = false;
    syncTimer();
  } else {
    if (!timer.elapsed) timer.elapsed = 0;
    if (!timer.startedAt) timer.startedAt = new Date().toISOString();
    timer.runSince = Date.now();
    timer.running = true;
    timer.intervalId = setInterval(timerTick, 500);
  }
  renderTimerFace();
  saveTimerState();
}

function timerTick() {
  if (!timer) return;
  syncTimer();
  if (timer.remaining <= 0) { finishTimerRound(); return; }
  renderTimerFace();
}

function finishTimerRound() {
  if (!timer) return;
  /* 先算「超时多久」再动状态，否则 runSince 被清掉就永远算出 0 */
  const overrun = Math.max(0, timerElapsedSec() - timer.total);
  clearInterval(timer.intervalId);
  timer.running = false;
  timer.runSince = null;
  const secs = timer.total;
  timer.elapsed = secs;
  timer.remaining = 0;
  const finSub = subtasks.find(x => x.id === timer.subtaskId);
  const pts = Math.max(1, Math.round(secs / 300));
  clearTimerState();
  renderTimerFace();
  /* 记录写库是异步的：等它落完再提示，否则「+5 积分」会把这句话顶掉 */
  recordSession(secs, true).then(() => {
    toast(overrun > 120
      ? "🍅 你不在的时候这一轮已经走完了 · 记录 " + fmtDur(secs) + "，+" + pts + " 分"
      : "🍅 番茄钟完成！记录 " + fmtDur(secs) + " · +" + pts + " 分");
  });
  try { new Audio("data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==").play().catch(() => {}); } catch (e) {}
  /* 一轮结束 → 直接进入「分级休息」，不让用户自己在「再撑一会 / 休息」之间反复内耗。
     但如果这一轮是你离开很久之后才走完的，回来第一件事不该是「被安排休息」。 */
  if (finSub && overrun <= 120) setTimeout(() => { if (!rest && !spark) openRest(finSub); }, 1100);
  setTimeout(maybeDrop, 1600); // 惊喜掉落：专注自然走完后小概率彩蛋
}

function stopTimer(record) {
  if (!timer) return 0;
  clearInterval(timer.intervalId);
  syncTimer();
  const elapsed = Math.min(timer.total, Math.round(timerElapsedSec()));
  if (record && elapsed > 0) recordSession(elapsed, true); // 提示由调用方合成，避免被「+N 积分」顶掉
  timer = null;
  clearTimerState();
  renderFloat();
  return elapsed;
}

/* 打开另一个子任务时，把上一个计时收尾（超过 1 分钟则记录） */
function settleTimerFor(subId) {
  if (!timer || timer.subtaskId === subId) return;
  clearInterval(timer.intervalId);
  syncTimer();
  const old = timer;
  const elapsed = Math.min(old.total, Math.round(timerElapsedSec()));
  timer = null;
  clearTimerState();
  renderFloat();
  if (elapsed >= 60) {
    saveSession(old.taskId, old.subtaskId, elapsed, old.startedAt);
    toast("上一轮专注已自动记录 " + fmtDur(elapsed));
  }
}

/* 真的离开页面（切 App / 锁屏 / 关标签）时计时也不中断：
   ① 数字按时间戳算，后台节流不会让它漂移；
   ② 切回来立刻校准一次，走完了就当场结算；
   ③ 每 10 秒 + 每次切走都落盘，手机被系统杀掉也不丢。 */
function resyncAll() {
  if (timer && timer.running) {
    syncTimer();
    if (timer.remaining <= 0) finishTimerRound();
    else renderTimerFace();
  } else if (timer) {
    renderFloat();
  }
  if (rest) restTick();
  if (spark) {
    const left = (spark.endAt - Date.now()) / 1000;
    const el = $id("sparkTime");
    if (el) el.textContent = mmss(left);
    if (left <= 0) finishSpark("done");
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { if (timer) saveTimerState(); }
  else resyncAll();
});
window.addEventListener("focus", resyncAll);
window.addEventListener("pageshow", (e) => { if (e.persisted) resyncAll(); });
window.addEventListener("pagehide", () => { if (timer) saveTimerState(); });
setInterval(() => { if (timer && timer.running) saveTimerState(); }, 10000);

async function saveSession(taskId, subtaskId, seconds, startedAt, quiet) {
  const payload = {
    task_id: taskId,
    subtask_id: subtaskId,
    duration_seconds: Math.round(seconds),
    started_at: startedAt,
    session_date: localDateStr(new Date(startedAt)),
  };
  const rows = await db(cloud.database.from("pomodoro_sessions").insert(payload).select());
  if (rows && rows[0]) sessions.push(rows[0]);
  renderAll();
  /* 专注也赚分：每 5 分钟 +1（不足 5 分钟按 1 分给，肯定「开始」本身）
     quiet=true 时不单独弹积分提示，交给调用方合成一条更好的话 */
  const pts = Math.max(1, Math.round(seconds / 300));
  await awardPoints(pts, "专注 " + Math.max(1, Math.round(seconds / 60)) + " 分钟", "session", rows && rows[0] ? rows[0].id : null, quiet);
  return pts;
}

async function recordSession(seconds, quiet) {
  if (!timer || seconds <= 0) return 0;
  try {
    return await saveSession(timer.taskId, timer.subtaskId, seconds, timer.startedAt, quiet);
  } catch (e) { return 0; /* db() 已提示 */ }
}

function openSubtaskModal(sub, autoStart, skipRitual) {
  settleTimerFor(sub.id);
  const task = tasks.find(t => t.id === sub.task_id);
  const isThisTimer = timer && timer.subtaskId === sub.id;
  /* 默认时长：恢复中的计时 → 原时长；子任务有建议时长且在预设里 → 建议时长；否则 25 分钟 */
  const defMin = isThisTimer ? Math.round(timer.total / 60) : ([5, 15, 25, 45].indexOf(sub.est_minutes) >= 0 ? sub.est_minutes : 25);
  openModal(
    '<div class="modal-head-row">' +
    "<h3>" + esc(sub.title) + "</h3>" +
    '<button class="link-btn" id="mRenameSub">✎ 重命名</button>' +
    "</div>" +
    '<div style="color:var(--text-sub);font-size:13px;margin-top:-10px;margin-bottom:6px">所属任务：' + esc(task ? task.title : "") + '</div>' +
    '<label class="modal-label">任务规划（怎么做这一步）</label>' +
    '<textarea id="mPlan" class="modal-textarea" placeholder="写下执行计划、要点或备注…">' + esc(sub.plan || "") + "</textarea>" +
    '<button class="btn ghost small" id="mPlanSave" style="margin-top:8px">保存规划</button>' +
    '<label class="modal-label">番茄钟计时</label>' +
    '<div class="pomo-durs" id="pomoDurs">' +
    [5, 15, 25, 45].map(d => '<button class="pomo-dur-btn' + (d === defMin ? " active" : "") + '" data-dur="' + d + '"' + (isThisTimer && timer.running ? " disabled" : "") + ">" + d + "分钟</button>").join("") +
    "</div>" +
    '<div class="pomo-face" id="pomoFace"><div class="pomo-time" id="pomoTime">25:00</div><div class="pomo-status" id="pomoStatus">准备开始</div></div>' +
    '<div class="pomo-btns">' +
    '<button class="btn primary" id="pomoStartBtn">开始</button>' +
    '<button class="btn ghost" id="pomoStopBtn">结束并记录</button>' +
    "</div>" +
    '<div class="modal-actions" style="margin-top:16px">' +
    '<button class="btn ' + (sub.done ? "ghost" : "primary") + '" id="mDoneBtn">' + (sub.done ? "取消完成 ✓" : "完成子任务 ✓") + "</button>" +
    '<button class="btn ghost" data-close="1">关闭</button>' +
    "</div>" +
    '<button class="btn ghost danger-text block" id="mDelSubBtn" style="margin-top:10px">删除这个子任务</button>'
  );

  if (!isThisTimer) {
    timer = { subtaskId: sub.id, taskId: sub.task_id, total: defMin * 60, remaining: defMin * 60, running: false, intervalId: null, startedAt: null, elapsed: 0, runSince: null };
  }
  renderTimerFace();

  if (autoStart && !timer.running) {
    if (skipRitual) { // 刚点过火，已经动起来了，不必再热身
      if (!timer.startedAt) timer.startedAt = new Date().toISOString();
      startTimer();
    } else {
      showRitual(sub); // 先「身体就位」，再自动开始
    }
  }

  bind("mPlanSave", "click", async () => {
    const plan = $id("mPlan").value;
    const rows = await db(cloud.database.from("subtasks").update({ plan }).eq("id", sub.id).select());
    if (rows && rows.length) Object.assign(sub, rows[0]);
    toast("规划已保存");
    renderCards();
  });

  bind("mRenameSub", "click", () => renameSubtask(sub));

  bind("mDelSubBtn", "click", async () => {
    const ok = await confirmDialog({
      title: "删除子任务",
      desc: "「" + esc(sub.title) + "」及其子子任务、番茄钟记录会一并删除，无法恢复。",
      okText: "删除",
    });
    if (!ok) { openSubtaskModal(sub); return; }
    if (timer && timer.subtaskId === sub.id) { clearInterval(timer.intervalId); timer = null; renderFloat(); }
    await deleteSubtask(sub.id);
  });

  bind("pomoDurs", "click", (e) => {
    const b = e.target.closest(".pomo-dur-btn");
    if (!b || timer.running) return;
    setTimerDuration(+b.dataset.dur);
    $id("pomoDurs").querySelectorAll(".pomo-dur-btn").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    renderTimerFace();
  });

  bind("pomoStartBtn", "click", () => { startTimer(); });

  bind("pomoStopBtn", "click", () => {
    syncTimer();
    if (timerElapsedSec() < 1) { toast("还没有开始计时", true); return; }
    const elapsed = Math.min(timer.total, Math.round(timerElapsedSec()));
    stopTimer(true);
    toast("本次专注已记录 " + fmtDur(elapsed) + " · +" + Math.max(1, Math.round(elapsed / 300)) + " 分");
    closeModal();
    if (elapsed >= 300) setTimeout(() => openRest(sub), 400); // 干了一段了，先安排休息再谈回来
  });

  bind("mDoneBtn", "click", async () => {
    const nd = !sub.done;
    const wasDone = sub.done;
    const wasAllDone = (() => { const ss = taskSubs(sub.task_id); return ss.length > 0 && ss.every(x => x.done); })();
    const rows = await db(cloud.database.from("subtasks").update({ done: nd, done_at: nd ? new Date().toISOString() : null }).eq("id", sub.id).select());
    if (rows && rows.length) Object.assign(sub, rows[0]);
    if (timer && timer.subtaskId === sub.id) stopTimer(true);
    closeModal();
    renderAll();
    await awardOnSubtaskToggle(sub, wasDone, wasAllDone);
    if (nd) {
      celebrate(); sayCompanion("恭喜你！变得更棒啦！"); toast("子任务已完成 ✓");
      const subs2 = taskSubs(sub.task_id);
      if (subs2.length && subs2.every(x => x.done)) await offerSettle(sub.task_id);
    }
  });
}

/* ============ 启动仪式：身体就位（与心理页联动） ============
   现在就做/开始专注时先弹 3 秒就位仪式（坐下·水放手边·耳机戴上）；
   连续跳过 2 次不责备，而是温和引导去情绪急救包做 30 秒身体练习。 */
let ritualSkips = 0;
try { ritualSkips = parseInt(localStorage.getItem("pomo_ritual_skip") || "0", 10) || 0; } catch (e) {}
let ritualIntervalId = null;

function saveRitualSkips() { try { localStorage.setItem("pomo_ritual_skip", String(ritualSkips)); } catch (e) {} }

function stopRitual() {
  if (ritualIntervalId) { clearInterval(ritualIntervalId); ritualIntervalId = null; }
  const layer = $id("ritualLayer");
  if (layer) layer.remove();
}

function startNow() {
  stopRitual();
  if (timer && !timer.running) {
    if (!timer.startedAt || timer.remaining === 0) timer.startedAt = new Date().toISOString();
    startTimer();
  }
}

function showRitual(sub) {
  const box = $id("modalBox");
  if (!box) return;
  stopRitual(); // 清掉旧仪式层与倒计时，避免叠加
  const needsAid = ritualSkips >= 2; // 连续跳过 2 次：给温和的引导，而不是直接开始
  const layer = document.createElement("div");
  layer.className = "ritual-layer";
  layer.id = "ritualLayer";
  let html = '<div class="ritual-title">🧘 身体就位</div>' +
    '<div class="ritual-sub">三件小事，让开始变容易</div>' +
    '<div class="ritual-steps"><span>🪑 坐下，双脚踩地</span><span>💧 水放在手边</span><span>🎧 耳机戴上（可选）</span></div>';
  if (needsAid) {
    html += '<div class="ritual-aid"><div class="ritual-aid-txt">💛 连续两次跳过啦，完全没关系。<br>如果只是不想动，直接开始就好；<br>如果身体发紧、心里发堵，可以先让自己舒服 30 秒：</div>' +
      '<div class="ritual-aid-btns">' +
      '<button class="btn ghost" id="ritualBreath">🫁 盒式呼吸</button>' +
      '<button class="btn ghost" id="ritualFidget">🧶 手上玩点什么</button>' +
      "</div></div>" +
      '<div class="ritual-count ritual-count-idle">怎么舒服怎么来</div>';
  } else {
    html += '<div class="ritual-count" id="ritualCount">3</div>';
  }
  html += '<div class="ritual-btns">' +
    '<button class="btn primary" id="ritualGo">▶ 就位，开始</button>' +
    '<button class="btn ghost" id="ritualSkip">跳过仪式，直接开始</button>' +
    "</div>";
  layer.innerHTML = html;
  box.appendChild(layer);

  if (!needsAid) {
    let n = 3;
    const setCount = () => { const el = $id("ritualCount"); if (el) el.textContent = n; };
    ritualIntervalId = setInterval(() => {
      n--;
      if (n <= 0) { startNow(); return; }
      setCount();
    }, 1000);
  }

  bind("ritualGo", "click", () => { ritualSkips = 0; saveRitualSkips(); startNow(); });
  bind("ritualSkip", "click", () => {
    ritualSkips++;
    saveRitualSkips();
    if (ritualSkips >= 2) showRitual(sub); // 重绘为温和引导
    else startNow();
  });
  const goAid = (idx) => {
    stopRitual();
    openFirstAid(FIRST_AID[idx], () => {
      ritualSkips = 0;
      saveRitualSkips();
      openSubtaskModal(sub); // 练完回到规划+番茄钟，准备好了一键开始
    });
  };
  const rb = $id("ritualBreath"), rf = $id("ritualFidget");
  if (rb) rb.addEventListener("click", () => goAid(1));
  if (rf) rf.addEventListener("click", () => goAid(6));
}

/* ============ 启动 & 回归：点火 / 分级休息 / 回来第一步 ============
   依据：AuDHD 的困难是双端的——冷启动难，切换也贵（autistic inertia + monotropism）。
   所以这里不做「更自律」的设计，只做三件事：
   1) 起点缩到 2 分钟，并给一个确定能走的出口（有出口，大脑才敢进去）
   2) 休息分级：浅休息不切场景（回来便宜）；深休息先留一句「回来第一步」（回来不用重建上下文）
   3) 回来时给台阶：先读锚点，再点 2 分钟，而不是直接面对整块任务 */

const ANCHOR_KEY = "pomo_anchor_v1";
const REST_KEY = "pomo_rest_v1";
let anchor = null;          // { subtaskId, text, at } 离开前留下的「回来第一步」
let spark = null;           // { sub, minutes, total, endAt, intervalId } 点火倒计时
let rest = null;            // { kind, minutes, subtaskId, endAt, intervalId, warned } 休息倒计时

try { anchor = JSON.parse(localStorage.getItem(ANCHOR_KEY) || "null"); } catch (e) { anchor = null; }

function mmss(sec) {
  sec = Math.max(0, Math.round(sec));
  return String(Math.floor(sec / 60)).padStart(2, "0") + ":" + String(sec % 60).padStart(2, "0");
}

function flowOpen(html) {
  const layer = $id("flowLayer");
  if (!layer) return;
  layer.innerHTML = '<div class="flow-card">' + html + "</div>";
  layer.classList.remove("hidden");
}
function flowClose() {
  const layer = $id("flowLayer");
  if (!layer) return;
  layer.classList.add("hidden");
  layer.innerHTML = "";
}

/* ---- 回来第一步（锚点） ---- */
function setAnchor(sub, text) {
  anchor = { subtaskId: sub ? sub.id : null, text: text || "", at: Date.now() };
  try { localStorage.setItem(ANCHOR_KEY, JSON.stringify(anchor)); } catch (e) {}
  renderReturnBar();
}
function clearAnchor() {
  anchor = null;
  try { localStorage.removeItem(ANCHOR_KEY); } catch (e) {}
  renderReturnBar();
}
/* 首屏「上次停在这里」：一进页面就有具体的第一步，不用面对一堆卡片做选择 */
function renderReturnBar() {
  const bar = $id("returnBar");
  if (!bar) return;
  /* 超过 36 小时的旧锚点就别再挂着了，避免「上次停在这里」变成压力 */
  if (anchor && anchor.at && Date.now() - anchor.at > 36 * 3600 * 1000) {
    anchor = null;
    try { localStorage.removeItem(ANCHOR_KEY); } catch (e) {}
  }
  const sub = anchor ? subtasks.find(s => s.id === anchor.subtaskId) : null;
  if (!anchor || !sub || sub.done) {
    if (anchor && sub && sub.done) clearAnchor();
    bar.classList.add("hidden");
    bar.innerHTML = "";
    return;
  }
  bar.classList.remove("hidden");
  bar.innerHTML =
    '<div class="rb-left">' +
    '<div class="rb-tag">🧲 上次停在这里</div>' +
    '<div class="rb-title">' + esc(sub.title) + (anchor.text ? " · " + esc(anchor.text) : "") + "</div>" +
    '<div class="rb-hint">不用重新想，就接这一步</div>' +
    "</div>" +
    '<div class="rb-btns">' +
    '<button class="btn primary" data-rbspark="1">▶ 就做 2 分钟</button>' +
    '<button class="btn ghost" data-rbclear="1">清掉</button>' +
    "</div>";
}

/* ---- 点火：2 分钟 / 5 分钟（到点就能走） ---- */
function openSpark(sub) {
  const s = sub || pickBestSub();
  if (!s) {
    toast(tasks.length ? "所有子任务都完成了，先去歇会儿 🎉" : "先用「一句话记事」记下要做的事吧");
    return;
  }
  spark = null;
  flowOpen(
    '<div class="flow-emoji">⚡</div>' +
    '<div class="flow-title">点火</div>' +
    '<div class="flow-sub">目标不是做完，只是「碰一下」。到点你随时可以走。</div>' +
    '<div class="flow-target">🎯 ' + esc(s.title) + "</div>" +
    '<div class="spark-durs">' +
    '<button class="spark-dur active" data-smin="2"><b>2 分钟</b><span>只碰一下</span></button>' +
    '<button class="spark-dur" data-smin="5"><b>5 分钟</b><span>到点就能走</span></button>' +
    "</div>" +
    '<div class="flow-hint">5 分钟用的是「反正只要 5 分钟」这个台阶 —— 大脑答应得下来，进去之后往往不止 5 分钟。</div>' +
    '<button class="btn primary block" id="sparkGo">🔥 点火</button>' +
    '<button class="btn ghost block" id="sparkCancel" style="margin-top:8px">先不</button>'
  );
  let min = 2;
  const layer = $id("flowLayer");
  layer.querySelectorAll("[data-smin]").forEach(b => {
    b.addEventListener("click", () => {
      min = +b.dataset.smin;
      layer.querySelectorAll("[data-smin]").forEach(x => x.classList.toggle("active", x === b));
    });
  });
  bind("sparkGo", "click", () => beginSpark(s, min));
  bind("sparkCancel", "click", flowClose);
}

function beginSpark(sub, minutes) {
  const total = minutes * 60;
  spark = { sub, minutes, total, endAt: Date.now() + total * 1000, intervalId: null };
  flowOpen(
    '<div class="flow-emoji">🔥</div>' +
    '<div class="flow-title">' + minutes + " 分钟</div>" +
    '<div class="flow-sub">不用做好，只要动起来。</div>' +
    '<div class="spark-time" id="sparkTime">' + mmss(total) + "</div>" +
    '<div class="flow-target">🎯 ' + esc(sub.title) + "</div>" +
    '<button class="btn primary block" id="sparkEarly">我已经动起来了</button>' +
    '<button class="btn ghost block" id="sparkStop" style="margin-top:8px">停，不记了</button>'
  );
  bind("sparkEarly", "click", () => finishSpark("early"));
  bind("sparkStop", "click", () => {
    if (!spark) return;
    clearInterval(spark.intervalId);
    const el = Math.round((spark.total * 1000 - (spark.endAt - Date.now())) / 1000);
    const s = spark.sub;
    spark = null;
    flowClose();
    if (el >= 60) {
      saveSession(s.task_id, s.id, el, new Date(Date.now() - el * 1000).toISOString()).catch(() => {});
      toast("记下 " + fmtDur(el) + "，动了就算数");
    } else {
      toast("没关系，下次再点一次就行");
    }
  });
  spark.intervalId = setInterval(() => {
    if (!spark) return;
    const left = (spark.endAt - Date.now()) / 1000;
    const el = $id("sparkTime");
    if (el) el.textContent = mmss(left);
    if (left <= 0) finishSpark("done");
  }, 250);
}

function finishSpark(reason) {
  if (!spark) return;
  clearInterval(spark.intervalId);
  const s = spark.sub;
  const elapsed = spark.total * 1000 - (spark.endAt - Date.now());
  const seconds = Math.max(60, Math.round(elapsed / 1000));
  spark = null;
  saveSession(s.task_id, s.id, seconds, new Date(Date.now() - seconds * 1000).toISOString()).catch(() => {});
  celebrate();
  awardPoints(3, "点火成功：" + s.title, "subtask", s.id);
  flowOpen(
    '<div class="flow-emoji">🔥</div>' +
    '<div class="flow-title">点火成功</div>' +
    '<div class="flow-sub">你已经不在冷启动里了。接下来选一个，不用想太久。</div>' +
    '<div class="flow-target">🎯 ' + esc(s.title) + " · 已记 " + fmtDur(seconds) + "</div>" +
    '<button class="btn primary block" id="sparkGo25">▶ 接着做 25 分钟</button>' +
    '<div class="flow-row">' +
    '<button class="btn ghost" id="sparkDone">✓ 就到这里</button>' +
    '<button class="btn ghost" id="sparkRest">☕ 歇一会</button>' +
    "</div>"
  );
  bind("sparkGo25", "click", () => {
    flowClose();
    openSubtaskModal(s, true, true); // 跳过就位仪式，直接接上——刚动过，不需要再热身
  });
  bind("sparkDone", "click", () => {
    flowClose();
    clearAnchor();
    toast("已记 " + fmtDur(seconds) + "，动了就算数 ✓");
  });
  bind("sparkRest", "click", () => { flowClose(); openRest(s); });
}

/* ---- 分级休息：浅休息不切场景 / 深休息先留线 ---- */
function openRest(sub) {
  const s = sub || (timer ? subtasks.find(x => x.id === timer.subtaskId) : null) || pickBestSub();
  flowOpen(
    '<div class="flow-emoji">☕</div>' +
    '<div class="flow-title">现在休息</div>' +
    '<div class="flow-sub">休息不是奖励，是下一轮的成本。先选一种。</div>' +
    '<button class="rest-opt" data-rest="light">' +
    '<span class="ro-icon">🫧</span>' +
    '<span class="ro-body"><b>浅休息 · 5 分钟</b>' +
    "<i>起身、喝水、看远处、闭眼躺着。不碰屏幕。</i>" +
    "<em>不切场景，回来最容易</em></span>" +
    "</button>" +
    '<button class="rest-opt" data-rest="deep">' +
    '<span class="ro-icon">🎮</span>' +
    '<span class="ro-body"><b>深休息 · 20 分钟</b>' +
    "<i>刷手机、游戏、看剧都行，不用克制。</i>" +
    "<em>回来要 5 分钟缓冲，这是正常的，不是你废</em></span>" +
    "</button>" +
    '<button class="btn ghost block" id="restNone" style="margin-top:10px">先不休息，接着做</button>'
  );
  const layer = $id("flowLayer");
  layer.querySelectorAll("[data-rest]").forEach(b => {
    b.addEventListener("click", () => {
      if (b.dataset.rest === "light") startRest("light", 5, s, "");
      else askAnchor(s);
    });
  });
  bind("restNone", "click", () => {
    flowClose();
    if (s) openSubtaskModal(s, true, true);
  });
}

function askAnchor(s) {
  const keep = anchor && s && anchor.subtaskId === s.id ? anchor.text : "";
  flowOpen(
    '<div class="flow-emoji">🧵</div>' +
    '<div class="flow-title">先留一根线</div>' +
    '<div class="flow-sub">去玩的时候，大脑会整个切走 —— 这不是意志力问题。' +
    "写一句「回来第一件事」，等下就不用重新找状态。</div>" +
    '<input id="anchorInput" class="modal-input" maxlength="60" placeholder="例：打开 cursor，接着跑昨天的回测" value="' + esc(keep) + '">' +
    '<p class="flow-hint">不写也行，但写了回来会明显容易一点。</p>' +
    '<button class="btn primary block" id="anchorGo">开始 20 分钟休息</button>' +
    '<button class="btn ghost block" id="anchorSkip" style="margin-top:8px">随便吧，直接休息</button>'
  );
  const input = $id("anchorInput");
  bind("anchorGo", "click", () => {
    const txt = input.value.trim();
    if (s) setAnchor(s, txt);
    startRest("deep", 20, s, txt);
  });
  bind("anchorSkip", "click", () => {
    if (s) setAnchor(s, s.title);
    startRest("deep", 20, s, "");
  });
  input.focus();
}

function startRest(kind, minutes, sub, anchorText) {
  if (rest && rest.intervalId) clearInterval(rest.intervalId);
  rest = {
    kind, minutes, subtaskId: sub ? sub.id : null,
    endAt: Date.now() + minutes * 60000, intervalId: null, warned: {},
  };
  try {
    localStorage.setItem(REST_KEY, JSON.stringify({
      kind, minutes, subtaskId: rest.subtaskId, endAt: rest.endAt,
    }));
  } catch (e) {}
  flowClose();
  renderRestBar();
  rest.intervalId = setInterval(restTick, 500);
  toast(kind === "screen" ? "行，这 10 分钟是正经休息，不用有负罪感。到点我会叫你 📱"
    : kind === "deep" ? "去玩吧。剩 3 分钟时我会提醒你收尾 🧵"
    : "起来动一下，5 分钟后见 🫧");
}

function restTick() {
  if (!rest) return;
  const left = (rest.endAt - Date.now()) / 1000;
  renderRestBar();
  if (rest.kind !== "light" && !rest.warned.m3 && left <= 180 && left > 110) {
    rest.warned.m3 = true;
    toast(rest.kind === "screen" ? "还有 3 分钟，想看的先存着，别开新的" : "还有 3 分钟，可以开始收尾了（不用马上停）");
    maybePrecommit(); // 转换点预承诺：在「回去」这个缝隙到来之前留线，而不是到了那一刻现想
  }
  if (rest.kind === "light" && !rest.warned.m3 && left <= 180 && left > 110) {
    rest.warned.m3 = true;
    maybePrecommit(); // 浅休息也一样：剩 2 分钟时轻问一句，不问就算了
  }
  if (!rest.warned.m1 && left <= 60 && left > 5) {
    rest.warned.m1 = true;
    toast("还有 1 分钟，慢慢来");
  }
  if (left <= 0) endRest();
}

/* 转换点预承诺：只问一次，有线就不问；点了就存进锚点，首屏「上次停在这里」会接住 */
function maybePrecommit() {
  if (!rest || rest.warned.pre) return;
  rest.warned.pre = true;
  const s = subtasks.find(x => x.id === rest.subtaskId);
  if (!s) return;
  if (anchor && anchor.text && anchor.subtaskId === s.id) return; // 已有现成的线
  askPrecommit(s);
}

function askPrecommit(s) {
  const left = rest ? mmss(Math.max(0, (rest.endAt - Date.now()) / 1000)) : "";
  flowOpen(
    '<div class="flow-emoji">🧵</div>' +
    '<div class="flow-title">趁还没回去，先留一根线</div>' +
    '<div class="flow-sub">「玩完 → 回来」这条缝隙最不受理控。趁现在留一句回来第一步，等下就不用重新做决定。' +
    (left ? "（休息还剩 " + left + "）" : "") + "</div>" +
    '<div class="flow-chips">' +
    '<button class="chip" data-ct="接着做：' + esc(s.title) + '">接着做刚才的</button>' +
    '<button class="chip" data-ct="先喝水、活动两下，然后：' + esc(s.title) + '">先喝水再回来</button>' +
    "</div>" +
    '<input id="anchorInput" class="modal-input" maxlength="60" placeholder="回来第一件事，一句话就行">' +
    '<button class="btn primary block" id="pcGo">就这句，继续休息</button>' +
    '<button class="btn ghost block" id="pcSkip" style="margin-top:8px">算了</button>'
  );
  const input = $id("anchorInput");
  $id("flowLayer").querySelectorAll("[data-ct]").forEach(b => {
    b.addEventListener("click", () => { input.value = b.dataset.ct; input.focus(); });
  });
  bind("pcGo", "click", () => {
    const txt = input.value.trim();
    if (txt) { setAnchor(s, txt); awardPoints(1, "提前留了回来第一步", "anchor", null); }
    flowClose();
  });
  bind("pcSkip", "click", flowClose);
  input.focus();
}

function renderRestBar() {
  const bar = $id("restBar");
  if (!bar) return;
  if (!rest) {
    bar.className = "rest-bar hidden";
    bar.innerHTML = "";
    return;
  }
  const left = Math.max(0, Math.round((rest.endAt - Date.now()) / 1000));
  const meta = { deep: ["🎮", "深休息"], light: ["🫧", "浅休息"], screen: ["📱", "刷屏许可"] }[rest.kind] || ["🫧", "休息"];
  const ending = rest.kind !== "light" && left <= 180;
  bar.className = "rest-bar" + (ending ? " is-ending" : "");
  bar.innerHTML =
    '<span class="rb-emoji">' + meta[0] + "</span>" +
    '<span class="rb-txt">' + meta[1] + " · " + mmss(left) + "</span>" +
    '<button class="btn primary small" id="restBack">我回来了</button>';
  bind("restBack", "click", endRest);
}

function endRest() {
  if (rest && rest.intervalId) clearInterval(rest.intervalId);
  const sid = rest ? rest.subtaskId : null;
  rest = null;
  try { localStorage.removeItem(REST_KEY); } catch (e) {}
  renderRestBar();
  const sub = (sid && subtasks.find(s => s.id === sid)) || pickBestSub();
  showReturn(sub);
}

/* ---- 回归仪式：把「回到工作」拆成 3 步，先读锚点再点火 ---- */
function showReturn(sub) {
  const s = sub || (anchor && subtasks.find(x => x.id === anchor.subtaskId)) || pickBestSub();
  if (!s) { flowClose(); return; }
  const anchorText = anchor && anchor.subtaskId === s.id ? anchor.text : "";
  flowOpen(
    '<div class="flow-emoji">🧲</div>' +
    '<div class="flow-title">回来就好</div>' +
    '<div class="flow-sub">从休息切回工作，本来就要花力气。三步，把成本降到最低。</div>' +
    '<div class="return-steps">' +
    '<div class="rs"><span class="rs-n">1</span>慢慢呼一口气，肩膀掉下来</div>' +
    '<div class="rs"><span class="rs-n">2</span>接下来只做这一件：<b>' + esc(s.title) + "</b></div>" +
    (anchorText ? '<div class="rs"><span class="rs-n">3</span>你走之前留的：<b>' + esc(anchorText) + "</b></div>" : "") +
    '<div class="rs"><span class="rs-n">' + (anchorText ? "4" : "3") + "</span>先做 2 分钟，做完再决定要不要继续</div>" +
    "</div>" +
    '<button class="btn primary block" id="returnGo">▶ 点火 2 分钟</button>' +
    '<div class="flow-row">' +
    '<button class="btn ghost" id="returnOpen">先打开看看</button>' +
    '<button class="btn ghost" id="returnLater">等会再说</button>' +
    "</div>"
  );
  const arrived = () => awardPoints(2, "休息后回来了", "rest", null);
  bind("returnGo", "click", () => { arrived(); flowClose(); beginSpark(s, 2); });
  bind("returnOpen", "click", () => { arrived(); flowClose(); openSubtaskModal(s, false); });
  bind("returnLater", "click", () => {
    flowClose();
    setAnchor(s, anchorText);
    toast("给你留着：回来点上面那条「上次停在这里」就行");
  });
}

/* 刷新 / 换设备回来后接着休息倒计时（休息中途锁屏也不会丢） */
function restoreRest() {
  let st = null;
  try { st = JSON.parse(localStorage.getItem(REST_KEY) || "null"); } catch (e) {}
  if (!st || !st.endAt) return;
  if (Date.now() - st.endAt > 6 * 3600 * 1000) { // 隔了大半天，别弹「回来吧」了
    try { localStorage.removeItem(REST_KEY); } catch (e) {}
    return;
  }
  rest = {
    kind: st.kind || "light", minutes: st.minutes || 5, subtaskId: st.subtaskId,
    endAt: st.endAt, intervalId: null, warned: {},
  };
  rest.intervalId = setInterval(restTick, 500);
  renderRestBar();
  if (rest.endAt <= Date.now()) endRest();
}

bind("sparkBtn", "click", () => openSpark(null));
bind("returnBar", "click", (e) => {
  if (e.target.closest("[data-rbspark]")) {
    const sub = anchor ? subtasks.find(s => s.id === anchor.subtaskId) : null;
    if (sub) openSpark(sub);
    return;
  }
  if (e.target.closest("[data-rbclear]")) {
    clearAnchor();
    toast("已清掉，回到普通视图");
  }
});

/* ============ 归纳统计 ============ */
/* 任务 DDL：剩 N 天 / 过期提醒 */
function ddlInfo(d) {
  const s = ymd(d);
  if (!s) return null;
  const diff = Math.round((new Date(s) - new Date(localDateStr(new Date()))) / 86400000);
  if (diff < 0) return { text: "已过期 " + (-diff) + " 天", cls: " ddl-over" };
  if (diff === 0) return { text: "今天截止", cls: " ddl-soon" };
  if (diff <= 3) return { text: "剩 " + diff + " 天", cls: " ddl-soon" };
  return { text: "剩 " + diff + " 天", cls: "" };
}
function ddlChipHtml(t) {
  const info = ddlInfo(t.deadline);
  return '<span class="ddl-chip' + (info ? info.cls : "") + '" data-ddl="' + t.id + '" title="点击设置 / 修改截止日期">⏰ ' +
    (info ? ymd(t.deadline).slice(5).replace("-", "/") + " · " + info.text : "设置截止日期") + "</span>";
}
function openDdlModal(t) {
  openModal(
    "<h3>设置截止日期</h3>" +
    '<label class="modal-label">「' + esc(t.title) + '」的 DDL（到这天前做完；点「清除」去掉）</label>' +
    '<input id="mDdlDate" type="date" class="modal-input" value="' + (t.deadline ? ymd(t.deadline) : "") + '">' +
    '<div class="modal-actions">' +
    '<button class="btn ghost" data-close="1">取消</button>' +
    '<button class="btn ghost" id="mDdlClear">清除</button>' +
    '<button class="btn primary" id="mDdlSave">保存</button>' +
    "</div>"
  );
  const save = async v => {
    const rows = await db(cloud.database.from("tasks").update({ deadline: v }).eq("id", t.id).select());
    if (rows && rows[0]) Object.assign(t, rows[0]);
    closeModal();
    renderAll();
    if (v) toast("已设置：⏰ " + ymd(v) + " 截止");
  };
  bind("mDdlSave", "click", () => save($id("mDdlDate").value || null));
  bind("mDdlClear", "click", () => save(null));
}
bind("statsList", "click", e => {
  const chip = e.target.closest("[data-ddl]");
  if (!chip) return;
  const t = tasks.find(x => x.id === +chip.dataset.ddl);
  if (t) openDdlModal(t);
});

function renderStats() {
  const box = $id("statsList");
  if (!tasks.length) {
    box.innerHTML = '<div class="stats-empty">暂无数据，先去创建任务吧</div>';
    return;
  }
  const totalSec = sessions.reduce((a, b) => a + (b.duration_seconds || 0), 0);
  const catCount = {};
  tasks.forEach(t => { const k = t.category || "none"; catCount[k] = (catCount[k] || 0) + 1; });
  const catLine = Object.keys(catCount).map(k => {
    const c = catMap()[k] || { icon: "📁", label: "未分类" };
    return c.icon + " " + c.label + " " + catCount[k];
  }).join("　");
  let html = '<div class="stat-row" style="border-left:3px solid var(--accent)">' +
    '<div class="stat-top"><span class="stat-title">📊 总览</span>' +
    '<span class="stat-nums">任务 <b>' + tasks.length + '</b> 个 · 子任务 <b>' + subtasks.length + '</b> 个 · 子子任务 <b>' + items.length + '</b> 个 · 累计专注 <b class="n-time">' + fmtDur(totalSec) + "</b></span></div>" +
    '<div class="stat-sub">' + catLine + "</div></div>";

  html += tasks.map(t => {
    const subs = taskSubs(t.id);
    const sec = taskSeconds(t.id);
    const lv = LEVELS[t.level] || LEVELS.mid;
    const cat = catOf(t);
    /* 进度口径：有子子任务的子任务按其子子任务计（完成数/总数），没拆的子任务按自身 1 个计 */
    let doneCnt = 0, totalCnt = 0;
    subs.forEach(s => {
      const its = items.filter(i => i.subtask_id === s.id);
      if (its.length) {
        doneCnt += its.filter(i => i.done).length;
        totalCnt += its.length;
      } else {
        totalCnt += 1;
        if (s.done) doneCnt += 1;
      }
    });
    const undone = totalCnt - doneCnt;
    const pct = totalCnt ? Math.round(doneCnt / totalCnt * 100) : 0;
    const dinfo = ddlInfo(t.deadline);
    const subLine = subs.length
      ? subs.map(s => {
          const its = items.filter(i => i.subtask_id === s.id);
          const self = '<span class="' + (s.done ? "done-mark" : "undone-mark") + '">' + (s.done ? "✓" : "○") + " " + esc(s.title) + "（" + fmtDur(subSeconds(s.id)) + "）</span>";
          if (!its.length) return self;
          return self + '<span class="item-marks">' + its.map(i =>
            '<span class="' + (i.done ? "done-mark" : "undone-mark") + '">' + (i.done ? "✓" : "○") + " " + esc(i.title) + "</span>").join("　") + "</span>";
        }).join("　")
      : '<span style="opacity:.6">暂无子任务</span>';
    return '<div class="stat-row' + (dinfo && dinfo.cls ? ' ddl-row' : '') + '" style="border-left:3px solid var(--accent)">' +
      '<div class="stat-top"><span class="stat-title"><span class="stat-cat">' + cat.icon + ' ' + cat.label + '</span>' + esc(t.title) + '</span>' +
      '<span class="stat-nums">' + ddlChipHtml(t) +
      '<span>已完成 <b class="n-done">' + doneCnt + "</b></span>" +
      "<span>未完成 <b class=\"n-undone\">" + undone + "</b></span>" +
      '<span>已用时 <b class="n-time">' + fmtDur(sec) + "</b></span>" +
      "</span></div>" +
      '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="stat-sub">' + subLine + "</div>" +
      "</div>";
  }).join("");
  box.innerHTML = html;
}

/* ============ 积分体系 & 心愿兑换 ============ */
/* 规则：完成子任务 +10 / 子任务全清空 +5 / 完成子子任务 +3 / 专注每 5 分钟 +1；取消完成原额扣回 */
function pointsBalance() { return points.reduce((a, b) => a + (b.delta || 0), 0); }
function pointsEarnedTotal() { return points.filter(p => (p.delta || 0) > 0).reduce((a, b) => a + b.delta, 0); }
function pointsSpentTotal() { return points.filter(p => (p.delta || 0) < 0).reduce((a, b) => a - b.delta, 0); }
function pointsToday() {
  const today = localDateStr(new Date());
  return points.filter(p => localDateStr(new Date(p.created_at || Date.now())) === today)
    .reduce((a, b) => a + (b.delta || 0), 0);
}

function renderPointsChip() {
  const chip = $id("ptsChip");
  if (!chip) return;
  chip.textContent = "⭐ " + pointsBalance();
  chip.classList.remove("hidden");
}

async function awardPoints(delta, reason, refType, refId, quiet) {
  if (!delta) return;
  try {
    const rows = await db(cloud.database.from("points_ledger").insert({
      delta, reason, ref_type: refType || null, ref_id: refId == null ? null : refId,
    }).select());
    if (rows && rows[0]) points.push(rows[0]);
    renderPointsChip();
    if (!$id("tab-points").classList.contains("hidden")) renderPoints();
    if (!quiet) toast((delta > 0 ? "+" : "") + delta + " 积分 · " + reason);
  } catch (e) { /* db() 已提示 */ }
}

/* 子任务勾选/取消时结算积分（含「整任务清空」奖励与扣回） */
async function awardOnSubtaskToggle(sub, wasDone, wasAllDone) {
  if (!wasDone) {
    await awardPoints(10, "完成子任务：" + sub.title, "subtask", sub.id);
    const subs = taskSubs(sub.task_id);
    if (subs.length && subs.every(x => x.done)) {
      const t = tasks.find(x => x.id === sub.task_id);
      await awardPoints(5, "清空任务：" + (t ? t.title : ""), "task", sub.task_id);
    }
  } else {
    await awardPoints(-10, "取消完成：" + sub.title, "subtask", sub.id);
    if (wasAllDone) {
      const t = tasks.find(x => x.id === sub.task_id);
      await awardPoints(-5, "取消清空：" + (t ? t.title : ""), "task", sub.task_id);
    }
  }
}

function renderPoints() {
  const bal = pointsBalance();
  if ($id("ptsBalance")) $id("ptsBalance").textContent = bal;
  if ($id("ptsEarned")) $id("ptsEarned").textContent = pointsEarnedTotal();
  if ($id("ptsSpent")) $id("ptsSpent").textContent = pointsSpentTotal();
  if ($id("ptsToday")) $id("ptsToday").textContent = pointsToday();
  renderPointsChip();
  renderBadgeWall();
  renderSkinChallenges();

  const list = $id("rewardsList");
  if (list) {
    if (!rewards.length) {
      list.innerHTML = '<div class="stats-empty">还没有心愿奖励。<br>想一件平时舍不得买的小东西（一杯手冲、一场电影、一副耳机），点右上角「＋ 添加奖励」给它定个积分价格 🎁</div>';
    } else {
      /* 排序：负债中的超前兑换在最前 → 未兑换普通奖励（价格低优先）→ 已了结的 */
      const sorted = rewards.slice().sort((a, b) => {
        const ra = a.redeemed ? 1 : 0, rb = b.redeemed ? 1 : 0;
        if (ra !== rb) return ra - rb;
        const da = a.kind === "advance" ? 0 : 1, dbk = b.kind === "advance" ? 0 : 1;
        if (da !== dbk) return da - dbk;
        return a.cost - b.cost;
      });
      list.innerHTML = sorted.map(r => {
        const cost = Math.max(1, r.cost || 1);
        if (r.kind === "advance") {
          /* 超前兑换：先享受后还债，像信用卡分期，每次自己定还多少 */
          const repaid = r.repaid || 0;
          const remain = Math.max(0, cost - repaid);
          const pct = Math.min(100, Math.round(repaid / cost * 100));
          const cleared = remain <= 0 || !!r.redeemed;
          const bal = pointsBalance();
          return '<div class="reward-card is-advance' + (cleared ? " is-redeemed" : "") + '">' +
            '<button class="reward-del" data-delreward="' + r.id + '" title="删除">✕</button>' +
            '<div class="reward-top"><span class="reward-title editable" data-editreward="' + r.id + '" title="单击修改名称和积分">💳 ' + esc(r.title) + '</span>' +
            '<span class="reward-cost editable" data-editreward="' + r.id + '" title="单击修改名称和积分">' + cost + ' 积分</span></div>' +
            (cleared
              ? '<div class="reward-kind-badge ok">✓ 已还清</div>'
              : '<div class="reward-kind-badge">负债中 · 还差 ' + remain + ' 积分</div>') +
            (r.note ? '<div class="reward-note">' + esc(r.note) + '</div>' : "") +
            '<div class="progress-bar"><div class="progress-fill repay-fill" style="width:' + pct + '%"></div></div>' +
            '<div class="reward-foot">' +
            (cleared
              ? '<span class="reward-done">✓ 已还清' + (r.redeemed_at ? " · " + String(r.redeemed_at).slice(0, 10) : "") + " 🎉</span>"
              : '<span class="reward-need">已还 ' + repaid + " / " + cost + "</span>" +
                (bal > 0
                  ? '<button class="btn primary small" data-repay="' + r.id + '">💳 还款</button>'
                  : '<span class="reward-need">余额不足，先去赚积分</span>')) +
            "</div></div>";
        }
        const pct = Math.min(100, Math.round(bal / cost * 100));
        const can = bal >= cost && !r.redeemed;
        return '<div class="reward-card' + (r.redeemed ? " is-redeemed" : "") + '">' +
          '<button class="reward-del" data-delreward="' + r.id + '" title="删除">✕</button>' +
          '<div class="reward-top"><span class="reward-title editable" data-editreward="' + r.id + '" title="单击修改名称和积分">🎁 ' + esc(r.title) + '</span>' +
          '<span class="reward-cost editable" data-editreward="' + r.id + '" title="单击修改名称和积分">' + cost + ' 积分</span></div>' +
          (r.note ? '<div class="reward-note">' + esc(r.note) + '</div>' : "") +
          '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
          '<div class="reward-foot">' +
          (r.redeemed
            ? '<span class="reward-done">✓ 已兑换' + (r.redeemed_at ? " · " + String(r.redeemed_at).slice(0, 10) : "") + "</span>"
            : (can
              ? '<button class="btn primary small" data-redeem="' + r.id + '">立即兑换</button>'
              : '<span class="reward-need">还差 ' + (cost - bal) + ' 积分</span>')) +
          "</div></div>";
      }).join("");
    }
  }

  const log = $id("pointsLog");
  if (log) {
    const recent = points.slice().sort((a, b) => b.id - a.id).slice(0, 20);
    log.innerHTML = recent.length ? recent.map(p => {
      const t = p.created_at ? new Date(p.created_at) : null;
      const stamp = t ? String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0") + " " +
        String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0") : "";
      return '<div class="plog-row"><span class="plog-reason">' + esc(p.reason || "") + '</span>' +
        '<span class="plog-time">' + stamp + "</span>" +
        '<span class="plog-delta ' + (p.delta > 0 ? "plus" : "minus") + '">' + (p.delta > 0 ? "+" : "") + p.delta + "</span></div>";
    }).join("") : '<div class="stats-empty">还没有积分记录，去完成一个子任务试试</div>';
  }
}

bind("addRewardBtn", "click", () => {
  let rewardKind = "normal";
  openModal(
    "<h3>添加心愿奖励</h3>" +
    '<label class="modal-label">奖励类型</label>' +
    '<div class="kind-picker" id="mRewardKind">' +
    '<button type="button" class="kind-opt active" data-kind="normal">🎯 普通奖励 <small>攒够再买</small></button>' +
    '<button type="button" class="kind-opt" data-kind="advance">💳 超前兑换 <small>先享受，分期还给自己</small></button>' +
    "</div>" +
    '<label class="modal-label">奖励名称</label>' +
    '<input id="mRewardTitle" class="modal-input" maxlength="50" placeholder="例：一副降噪耳机 / 一杯手冲 / 音乐剧门票">' +
    '<label class="modal-label" id="mRewardCostLabel">需要多少积分兑换</label>' +
    '<input id="mRewardCost" class="modal-input" type="number" min="1" step="10" value="200">' +
    '<label class="modal-label">备注（可选，提醒自己为什么值得）</label>' +
    '<input id="mRewardNote" class="modal-input" maxlength="80" placeholder="例：专注满 20 小时后买，奖励自己">' +
    '<div class="modal-actions">' +
    '<button class="btn ghost" data-close="1">取消</button>' +
    '<button class="btn primary" id="mRewardSave">添加</button>' +
    "</div>"
  );
  const input = $id("mRewardTitle");
  input.focus();
  document.querySelectorAll("#mRewardKind .kind-opt").forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#mRewardKind .kind-opt").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      rewardKind = b.dataset.kind;
      $id("mRewardCostLabel").textContent = rewardKind === "advance" ? "总价（已享受的部分折算成多少积分，之后分期还）" : "需要多少积分兑换";
    });
  });
  const save = async () => {
    const title = input.value.trim();
    const cost = Math.max(1, parseInt($id("mRewardCost").value, 10) || 100);
    const note = $id("mRewardNote").value.trim();
    if (!title) { toast("请输入奖励名称", true); return; }
    const rows = await db(cloud.database.from("rewards").insert({ title, cost, note, kind: rewardKind }).select());
    if (rows && rows[0]) rewards.push(rows[0]);
    closeModal();
    renderPoints();
    toast(rewardKind === "advance" ? "已记录超前兑换：💳 " + title + "，慢慢还给自己" : "已添加心愿：🎁 " + title);
  };
  bind("mRewardSave", "click", save);
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) save(); });
});

bind("rewardsList", "click", async (e) => {
  const del = e.target.closest("[data-delreward]");
  const red = e.target.closest("[data-redeem]");
  const rep = e.target.closest("[data-repay]");
  const ed = e.target.closest("[data-editreward]");
  try {
    if (ed) {
      const r = rewards.find(x => x.id === +ed.dataset.editreward);
      if (r) openRewardEditModal(r);
      return;
    }
    if (del) {
      const id = +del.dataset.delreward;
      const r = rewards.find(x => x.id === id);
      const debtLeft = r && r.kind === "advance" && !r.redeemed ? Math.max(0, (r.cost || 0) - (r.repaid || 0)) : 0;
      const ok = await confirmDialog({
        title: "删除心愿",
        desc: "「" + esc(r ? r.title : "") + "」将被移除（已获得的积分不受影响）。" +
          (debtLeft > 0 ? "<br>注意：这笔还有 <b>" + debtLeft + "</b> 积分没还，删除等于原谅自己这笔债。" : ""),
        okText: "删除",
      });
      if (ok) {
        await db(cloud.database.from("rewards").delete().eq("id", id).select());
        rewards = rewards.filter(x => x.id !== id);
        renderPoints();
      }
      return;
    }
    if (rep) {
      const r = rewards.find(x => x.id === +rep.dataset.repay);
      if (!r || r.kind !== "advance") return;
      openRepayModal(r);
      return;
    }
    if (red) {
      const id = +red.dataset.redeem;
      const r = rewards.find(x => x.id === id);
      if (!r) return;
      if (pointsBalance() < r.cost) { toast("积分还不够", true); return; }
      const ok = await confirmDialog({
        title: "兑换这份奖励",
        desc: "花费 <b>" + r.cost + "</b> 积分兑换「" + esc(r.title) + "」？<br>兑换后积分会扣掉，记得真的把这件东西买给自己。",
        okText: "兑换",
      });
      if (!ok) return;
      await awardPoints(-r.cost, "兑换心愿：" + r.title, "reward", r.id);
      const rows = await db(cloud.database.from("rewards").update({ redeemed: true, redeemed_at: new Date().toISOString() }).eq("id", r.id).select());
      if (rows && rows[0]) Object.assign(r, rows[0]);
      renderPoints();
      celebrate();
      toast("🎉 兑换成功！去把它买给自己吧～");
    }
  } catch (err) { /* db() 已提示 */ }
});

/* 单击奖励卡名字/积分：改名 + 改积分价格（还债进度按新价格重算，已还金额不动） */
function openRewardEditModal(r) {
  openModal(
    "<h3>修改心愿</h3>" +
    '<label class="modal-label">奖励名称</label>' +
    '<input id="mRewTitle" class="modal-input" maxlength="50" value="' + esc(r.title) + '">' +
    '<label class="modal-label">积分价格</label>' +
    '<input id="mRewCost" class="modal-input" type="number" min="1" step="10" value="' + Math.max(1, r.cost || 1) + '">' +
    (r.kind === "advance" ? '<p style="color:var(--text-sub);font-size:12.5px;margin-top:-6px">改价不影响已还金额（已还 ' + (r.repaid || 0) + " 积分），还债进度按新价格重算。</p>" : "") +
    '<div class="modal-actions">' +
    '<button class="btn ghost" data-close="1">取消</button>' +
    '<button class="btn primary" id="mRewSave">保存</button>' +
    "</div>"
  );
  const titleInput = $id("mRewTitle");
  titleInput.focus();
  titleInput.select();
  const save = async () => {
    const title = titleInput.value.trim();
    const cost = Math.max(1, parseInt($id("mRewCost").value, 10) || 0);
    if (!title) { toast("请输入奖励名称", true); return; }
    if (!cost) { toast("请输入积分价格", true); return; }
    if (title === r.title && cost === r.cost) { closeModal(); return; }
    const rows = await db(cloud.database.from("rewards").update({ title, cost }).eq("id", r.id).select());
    if (rows && rows[0]) Object.assign(r, rows[0]);
    closeModal();
    renderPoints();
    toast("已修改心愿：" + title + " · " + cost + " 积分");
  };
  bind("mRewSave", "click", save);
  [titleInput, $id("mRewCost")].forEach(inp => inp.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) save(); }));
}

/* 超前兑换还款：像信用卡还款，每次自己定还多少（不能超过剩余负债和当前余额） */
function openRepayModal(r) {
  const cost = Math.max(1, r.cost || 1);
  const repaid = r.repaid || 0;
  const remain = Math.max(0, cost - repaid);
  const bal = pointsBalance();
  openModal(
    "<h3>💳 还债 · " + esc(r.title) + "</h3>" +
    '<p style="color:var(--text-sub);font-size:13px;margin:-6px 0 10px">已还 <b style="color:var(--text)">' + repaid + "</b> / " + cost +
    ' 积分 · 还差 <b style="color:var(--orange)">' + remain + "</b> · 当前余额 <b style=\"color:var(--text)\">" + bal + "</b></p>" +
    '<label class="modal-label">这次还多少积分（还给自己，量力而行）</label>' +
    '<input id="mRepayAmt" class="modal-input" type="number" min="1" max="' + Math.min(remain, bal) + '" placeholder="例：50">' +
    '<div class="repay-quick">' +
    [20, 50, 100, 200].filter(v => v <= Math.min(remain, bal)).map(v => '<button type="button" class="btn ghost small" data-repayquick="' + v + '">' + v + "</button>").join("") +
    "</div>" +
    '<div class="modal-actions">' +
    '<button class="btn ghost" data-close="1">取消</button>' +
    '<button class="btn primary" id="mRepaySave">确认还款</button>' +
    "</div>"
  );
  const input = $id("mRepayAmt");
  input.focus();
  document.querySelectorAll("[data-repayquick]").forEach(b => {
    b.addEventListener("click", () => { input.value = b.dataset.repayquick; });
  });
  const save = async () => {
    const amt = parseInt(input.value, 10);
    if (!amt || amt < 1) { toast("请输入还款积分", true); return; }
    if (amt > remain) { toast("超出剩余负债了（还差 " + remain + "）", true); return; }
    if (amt > pointsBalance()) { toast("余额不够，先去赚积分", true); return; }
    await awardPoints(-amt, "还债：" + r.title, "reward", r.id);
    const newRepaid = Math.min(cost, repaid + amt);
    const cleared = newRepaid >= cost;
    const rows = await db(cloud.database.from("rewards").update(
      cleared ? { repaid: newRepaid, redeemed: true, redeemed_at: new Date().toISOString() } : { repaid: newRepaid }
    ).eq("id", r.id).select());
    if (rows && rows[0]) Object.assign(r, rows[0]);
    closeModal();
    renderPoints();
    if (cleared) {
      celebrate();
      sayCompanion("恭喜你！变得更棒啦！");
      toast("🎉 「" + r.title + "」已还清！这份快乐现在完完全全是你的了");
    } else {
      toast("还款 " + amt + " 积分 · 还差 " + (cost - newRepaid));
    }
  };
  bind("mRepaySave", "click", save);
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) save(); });
}

/* ============ 徽章墙（按周期点亮，下个周期没做到自动熄灭） ============ */
const BADGES = [
  { period: "day", icon: "⭐", label: "今日 1 任务", n: 1 },
  { period: "day", icon: "🔥", label: "今日 3 任务", n: 3 },
  { period: "day", icon: "💎", label: "今日 5 任务", n: 5 },
  { period: "week", icon: "🎯", label: "本周 10 任务", n: 10 },
  { period: "week", icon: "🚀", label: "本周 30 任务", n: 30 },
  { period: "week", icon: "👑", label: "本周 50 任务", n: 50 },
  { period: "month", icon: "🏅", label: "本月 100 任务", n: 100 },
  { period: "month", icon: "🏆", label: "本月 300 任务", n: 300 },
  { period: "month", icon: "🌟", label: "本月 500 任务", n: 500 },
];
const BADGE_GROUPS = { day: "每日", week: "每周", month: "每月" };

function toLocalDateStr(iso) {
  try { return localDateStr(new Date(iso)); } catch (e) { return null; }
}
/* 完成计数：子任务 done_at + 子子任务 done_at（都在本周期内才算） */
function periodDoneCount(period) {
  const now = new Date();
  const map = {};
  const bump = (done, at) => { if (!done || !at) return; const k = toLocalDateStr(at); if (k) map[k] = (map[k] || 0) + 1; };
  for (const s of subtasks) bump(s.done, s.done_at);
  for (const i of items) bump(i.done, i.done_at);
  if (period === "day") return map[localDateStr(now)] || 0;
  if (period === "week") {
    const start = weekStartOf(now);
    let c = 0;
    for (let k = 0; k < 7; k++) { const d = new Date(start); d.setDate(start.getDate() + k); c += map[localDateStr(d)] || 0; }
    return c;
  }
  const pre = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-";
  let c = 0;
  for (const k in map) if (k.indexOf(pre) === 0) c += map[k];
  return c;
}

function renderBadgeWall() {
  const wall = $id("badgeWall");
  if (!wall) return;
  const counts = { day: periodDoneCount("day"), week: periodDoneCount("week"), month: periodDoneCount("month") };
  let html = "";
  for (const p of ["day", "week", "month"]) {
    html += '<div class="badge-group"><div class="badge-group-t">' + BADGE_GROUPS[p] +
      '<b>' + counts[p] + '</b> 个完成</div><div class="badge-row">';
    for (const b of BADGES.filter(x => x.period === p)) {
      const lit = counts[p] >= b.n;
      const pct = Math.min(100, Math.round(counts[p] / b.n * 100));
      html += '<div class="badge-chip' + (lit ? " lit" : "") + '" title="' + b.label +
        (lit ? " · 已点亮 ✨" : " · 还差 " + (b.n - counts[p]) + " 个，下个周期没做到会熄灭") + '">' +
        '<span class="badge-icon">' + b.icon + '</span>' +
        '<span class="badge-name">' + b.label + "</span>" +
        '<div class="badge-bar"><div class="badge-fill" style="width:' + pct + '%"></div></div>' +
        "</div>";
    }
    html += "</div></div>";
  }
  wall.innerHTML = html;
}

/* ============ 收支（周 / 月 / 年 + 储蓄投资） ============ */
function weekStartOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const wd = (x.getDay() + 6) % 7; // 周一为一周开始
  x.setDate(x.getDate() - wd);
  return x;
}
function fmtYuan(n) { return "¥" + (Math.round(n * 100) / 100).toFixed(2); }

const MONEY_CATS = {
  expense: ["餐饮", "交通", "购物", "娱乐", "居住", "医疗", "学习", "订阅", "其他"],
  income: ["工资", "兼职", "理财", "红包", "退款", "其他"],
  save: ["定期存款", "活期存款", "货币基金", "攒钱计划", "其他"],
  invest: ["基金", "股票", "债券", "黄金", "养老账户", "其他"],
};
const MONEY_KINDS = {
  expense: { t: "支", cls: "k-out", amtCls: "c-exp", sign: "−", name: "支出" },
  income: { t: "收", cls: "k-in", amtCls: "c-inc", sign: "+", name: "收入" },
  save: { t: "储", cls: "k-save", amtCls: "c-save", sign: "", name: "储蓄" },
  invest: { t: "投", cls: "k-invest", amtCls: "c-inv", sign: "", name: "投资" },
};

/* 当前统计周期的起止 / 柱状图列 / 标题 */
function moneyRange() {
  const a = moneyAnchor ? new Date(moneyAnchor.y, moneyAnchor.m, moneyAnchor.d) : new Date();
  if (moneyPeriod === "week") {
    const start = weekStartOf(a);
    const end = new Date(start); end.setDate(start.getDate() + 6);
    const cols = [];
    for (let i = 0; i < 7; i++) {
      const s = new Date(start); s.setDate(start.getDate() + i);
      cols.push({ s, e: s, label: "一二三四五六日"[i] });
    }
    return { start, end, cols, group: "day", dense: false,
      label: (start.getMonth() + 1) + "月" + start.getDate() + "日 ~ " + (end.getMonth() + 1) + "月" + end.getDate() + "日" + (moneyAnchor ? "" : "（本周）") };
  }
  if (moneyPeriod === "month") {
    const start = new Date(a.getFullYear(), a.getMonth(), 1);
    const end = new Date(a.getFullYear(), a.getMonth() + 1, 0);
    const cols = [];
    for (let d = 1; d <= end.getDate(); d++) {
      const s = new Date(a.getFullYear(), a.getMonth(), d);
      cols.push({ s, e: s, label: String(d) });
    }
    return { start, end, cols, group: "day", dense: true,
      label: a.getFullYear() + "年" + (a.getMonth() + 1) + "月" + (moneyAnchor ? "" : "（本月）") };
  }
  const start = new Date(a.getFullYear(), 0, 1);
  const end = new Date(a.getFullYear(), 11, 31);
  const cols = [];
  for (let m = 0; m < 12; m++) {
    cols.push({ s: new Date(a.getFullYear(), m, 1), e: new Date(a.getFullYear(), m + 1, 0), label: (m + 1) + "月" });
  }
  return { start, end, cols, group: "month", dense: false,
    label: a.getFullYear() + " 年" + (moneyAnchor ? "" : "（今年）") };
}
function colKey(R, col) {
  return R.group === "day" ? localDateStr(col.s) : localDateStr(col.s).slice(0, 7);
}
function shiftMoney(delta) {
  const a = moneyAnchor ? new Date(moneyAnchor.y, moneyAnchor.m, moneyAnchor.d) : new Date();
  if (moneyPeriod === "week") a.setDate(a.getDate() + delta * 7);
  else if (moneyPeriod === "month") a.setMonth(a.getMonth() + delta);
  else a.setFullYear(a.getFullYear() + delta);
  moneyAnchor = { y: a.getFullYear(), m: a.getMonth(), d: a.getDate() };
  renderMoney();
}

function renderMoney() {
  const R = moneyRange();
  const lbl = $id("periodLabel");
  if (lbl) lbl.textContent = R.label;
  const unit = { week: "本周", month: "本月", year: "今年" }[moneyPeriod];
  for (const [id, t] of [["sumInT", unit + "收入"], ["sumOutT", unit + "支出"], ["sumNetT", unit + "结余"]]) {
    const el = $id(id); if (el) el.textContent = t;
  }

  const sStr = localDateStr(R.start), eStr = localDateStr(R.end);
  const inRange = moneyRecords.filter(r => {
    const k = r.record_date ? String(r.record_date).slice(0, 10) : null;
    return k && k >= sStr && k <= eStr;
  });
  let inc = 0, exp = 0, sv = 0, iv = 0;
  const byKey = {}; // 列 key -> { inc, exp, sv, iv }
  for (const r of inRange) {
    const k = String(r.record_date).slice(0, 10);
    const key = R.group === "day" ? k : k.slice(0, 7);
    if (!byKey[key]) byKey[key] = { inc: 0, exp: 0, sv: 0, iv: 0 };
    const b = byKey[key], amt = parseFloat(r.amount) || 0;
    if (r.kind === "income") { b.inc += amt; inc += amt; }
    else if (r.kind === "expense") { b.exp += amt; exp += amt; }
    else if (r.kind === "save") { b.sv += amt; sv += amt; }
    else { b.iv += amt; iv += amt; }
  }
  if ($id("weekIncome")) $id("weekIncome").textContent = fmtYuan(inc);
  if ($id("weekExpense")) $id("weekExpense").textContent = fmtYuan(exp);
  const net = inc - exp;
  const netEl = $id("weekNet");
  if (netEl) { netEl.textContent = (net >= 0 ? "+" : "−") + fmtYuan(Math.abs(net)); netEl.style.color = net >= 0 ? "var(--green)" : "var(--red)"; }

  /* 储蓄与投资：基础存量 + 累计转入 */
  let totalSave = moneyBase.save, totalInvest = moneyBase.invest;
  for (const r of moneyRecords) {
    if (r.kind === "save") totalSave += parseFloat(r.amount) || 0;
    else if (r.kind === "invest") totalInvest += parseFloat(r.amount) || 0;
  }
  if ($id("totalSave")) $id("totalSave").textContent = fmtYuan(totalSave);
  if ($id("totalInvest")) $id("totalInvest").textContent = fmtYuan(totalInvest);
  if ($id("periodSave")) $id("periodSave").textContent = unit + "转入 " + fmtYuan(sv);
  if ($id("periodInvest")) $id("periodInvest").textContent = unit + "转入 " + fmtYuan(iv);

  /* 柱状图（按支出高度） */
  const todayStr = localDateStr(new Date());
  const curMonthKey = todayStr.slice(0, 7);
  const chart = $id("moneyChart");
  const daysBar = $id("moneyChartDays");
  if (chart) {
    chart.style.gridTemplateColumns = "repeat(" + R.cols.length + ", 1fr)";
    const maxExp = Math.max(1, ...R.cols.map(c => (byKey[colKey(R, c)] || { exp: 0 }).exp));
    chart.innerHTML = R.cols.map(c => {
      const key = colKey(R, c);
      const e = (byKey[key] || { exp: 0 }).exp;
      const h = Math.round(e / maxExp * 100);
      const cur = R.group === "day" ? key === todayStr : key === curMonthKey;
      return '<div class="money-col' + (cur ? " today" : "") + '" title="' + key + (e ? " 支出 " + fmtYuan(e) : " 无支出") +
        ((byKey[key] && (byKey[key].sv || byKey[key].iv)) ? " · 储 " + fmtYuan(byKey[key].sv) + " 投 " + fmtYuan(byKey[key].iv) : "") + '">' +
        (e > 0 ? '<span class="money-col-v">' + Math.round(e) + "</span>" : "") +
        '<div class="money-bar" style="height:' + Math.max(e > 0 ? 6 : 2, h) + '%"></div>' +
        "</div>";
    }).join("");
    if (daysBar) {
      daysBar.style.gridTemplateColumns = "repeat(" + R.cols.length + ", 1fr)";
      daysBar.className = "money-chart-days" + (R.dense ? " dense" : "");
      daysBar.innerHTML = R.cols.map(c => "<span>" + c.label + "</span>").join("");
    }
  }

  /* 明细列表（按天 / 按月分组倒序） */
  const list = $id("moneyList");
  if (list) {
    const keys = R.cols.map(c => colKey(R, c)).reverse();
    const rowsHtml = [];
    for (const key of keys) {
      const dayRows = inRange.filter(r => {
        const k = String(r.record_date).slice(0, 10);
        return (R.group === "day" ? k : k.slice(0, 7)) === key;
      }).sort((a, b) => b.id - a.id);
      if (!dayRows.length) continue;
      let title;
      if (R.group === "day") {
        const d = new Date(key + "T00:00:00");
        title = (d.getMonth() + 1) + "月" + d.getDate() + " 日" + (key === todayStr ? " · 今天" : "");
      } else {
        const d = new Date(key + "-01T00:00:00");
        title = d.getFullYear() + "年" + (d.getMonth() + 1) + "月";
      }
      const g = byKey[key] || { inc: 0, exp: 0 };
      rowsHtml.push('<div class="money-day-t">' + title +
        '<span class="money-day-sum">' +
        (g.inc ? '<b class="c-inc">+' + fmtYuan(g.inc).slice(1) + "</b>" : "") +
        (g.exp ? '<b class="c-exp">−' + fmtYuan(g.exp).slice(1) + "</b>" : "") +
        "</span></div>");
      rowsHtml.push(dayRows.map(r => {
        const m = MONEY_KINDS[r.kind] || MONEY_KINDS.expense;
        const amt = fmtYuan(parseFloat(r.amount) || 0).slice(1);
        return '<div class="money-row"><span class="money-kind ' + m.cls + '">' + m.t + "</span>" +
          '<span class="money-cat">' + esc(r.category || "其他") + "</span>" +
          '<span class="money-note">' + esc(r.note || "") + "</span>" +
          '<span class="money-amt ' + m.amtCls + '">' + (m.sign ? m.sign : "") + amt + "</span>" +
          '<button class="money-del" data-delmoney="' + r.id + '" title="删除">✕</button>' +
          "</div>";
      }).join(""));
    }
    list.innerHTML = rowsHtml.length ? rowsHtml.join("") :
      '<div class="stats-empty">这段时间还没有记录。点右上角「＋ 记一笔」，把收入、开支、储蓄和投资都记下来 🧾</div>';
  }
}

bind("prevPeriodBtn", "click", () => shiftMoney(-1));
bind("nextPeriodBtn", "click", () => shiftMoney(1));
bind("thisPeriodBtn", "click", () => { moneyAnchor = null; renderMoney(); });

/* 单击储蓄/投资卡片：直接修改现有金额（差额存为个人基础存量，流水不动） */
function openMoneyBaseEdit(kind) {
  const isSave = kind === "save";
  const sum = isSave
    ? moneyRecords.reduce((a, r) => a + (r.kind === "save" ? parseFloat(r.amount) || 0 : 0), moneyBase.save)
    : moneyRecords.reduce((a, r) => a + (r.kind === "invest" ? parseFloat(r.amount) || 0 : 0), moneyBase.invest);
  const name = isSave ? "储蓄" : "投资";
  openModal(
    "<h3>修改现有" + name + "</h3>" +
    '<p style="color:var(--text-sub);font-size:13px;margin-top:-8px;margin-bottom:10px">直接输入你现在实际持有的金额；应用里的转入流水不会被动，差额会作为你的初始存量保存。</p>' +
    '<label class="modal-label">现有' + name + '金额（元）</label>' +
    '<input id="mMoneyBase" class="modal-input" type="number" min="0" step="0.01" value="' + (Math.round(sum * 100) / 100) + '">' +
    '<div class="modal-actions">' +
    '<button class="btn ghost" data-close="1">取消</button>' +
    '<button class="btn primary" id="mMoneyBaseSave">保存</button>' +
    "</div>"
  );
  const input = $id("mMoneyBase");
  input.focus();
  input.select();
  const save = async () => {
    const v = parseFloat(input.value);
    if (isNaN(v) || v < 0) { toast("请输入不小于 0 的金额", true); return; }
    if (!profileId) { toast("账号信息未就绪，请稍后再试", true); return; }
    const flowSum = moneyRecords.reduce((a, r) => a + ((isSave ? r.kind === "save" : r.kind === "invest") ? parseFloat(r.amount) || 0 : 0), 0);
    const base = Math.max(0, Math.round((v - flowSum) * 100) / 100);
    const res = await db(cloud.database.from("user_profiles").update(isSave ? { save_base: base } : { invest_base: base }).eq("id", profileId).select());
    if (res && res[0]) {
      if (isSave) moneyBase.save = parseFloat(res[0].save_base) || base;
      else moneyBase.invest = parseFloat(res[0].invest_base) || base;
    } else if (isSave) moneyBase.save = base;
    else moneyBase.invest = base;
    closeModal();
    renderMoney();
    toast("现有" + name + "已更新：" + fmtYuan(isSave ? moneyBase.save + flowSum : moneyBase.invest + flowSum));
  };
  bind("mMoneyBaseSave", "click", save);
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) save(); });
}
bind("editSaveCard", "click", () => openMoneyBaseEdit("save"));
bind("editInvestCard", "click", () => openMoneyBaseEdit("invest"));
bind("tab-money", "click", (e) => {
  const b = e.target.closest(".money-periods .mode-btn");
  if (!b || b.dataset.period === moneyPeriod) return;
  moneyPeriod = b.dataset.period;
  $id("tab-money").querySelectorAll(".money-periods .mode-btn").forEach(x => x.classList.toggle("active", x === b));
  moneyAnchor = null;
  renderMoney();
});

bind("addMoneyBtn", "click", () => {
  const R = moneyRange();
  const defDate = moneyAnchor ? localDateStr(R.end > new Date() ? new Date() : R.end) : localDateStr(new Date());
  const kindBtns = [
    '<button class="kind-opt k-out sel-expense" data-kind="expense">支出 💸</button>',
    '<button class="kind-opt k-in" data-kind="income">收入 💰</button>',
    '<button class="kind-opt k-save" data-kind="save">储蓄 🏦</button>',
    '<button class="kind-opt k-invest" data-kind="invest">投资 📈</button>',
  ].join("");
  openModal(
    "<h3>记一笔</h3>" +
    '<div class="money-kind-pick" id="mKindPick">' + kindBtns + "</div>" +
    '<div class="abc-row2">' +
    "<div><label class=\"modal-label\">金额</label>" +
    '<input id="mMoneyAmt" class="modal-input" type="number" min="0.01" step="0.01" placeholder="0.00"></div>' +
    "<div><label class=\"modal-label\">日期</label>" +
    '<input id="mMoneyDate" class="modal-input" type="date" value="' + defDate + '"></div>' +
    "</div>" +
    '<label class="modal-label">分类</label>' +
    '<select id="mMoneyCat" class="modal-input"></select>' +
    '<label class="modal-label">备注（可选）</label>' +
    '<input id="mMoneyNote" class="modal-input" maxlength="60" placeholder="例：和朋友的晚饭">' +
    '<div class="modal-actions">' +
    '<button class="btn ghost" data-close="1">取消</button>' +
    '<button class="btn primary" id="mMoneySave">保存</button>' +
    "</div>"
  );
  let kind = "expense";
  const catSel = $id("mMoneyCat");
  const fillCats = () => {
    catSel.innerHTML = MONEY_CATS[kind].map(c => "<option>" + c + "</option>").join("");
  };
  fillCats();
  const pick = $id("mKindPick");
  pick.addEventListener("click", (e) => {
    const b = e.target.closest(".kind-opt");
    if (!b || b.dataset.kind === kind) return;
    kind = b.dataset.kind;
    pick.querySelectorAll(".kind-opt").forEach(x => x.classList.remove("sel-expense", "sel-income", "sel-save", "sel-invest"));
    b.classList.add("sel-" + kind);
    fillCats();
  });
  $id("mMoneyAmt").focus();
  const save = async () => {
    const amt = parseFloat($id("mMoneyAmt").value);
    const date = $id("mMoneyDate").value || localDateStr(new Date());
    const note = $id("mMoneyNote").value.trim();
    if (!(amt > 0)) { toast("请输入金额", true); return; }
    const rows = await db(cloud.database.from("money_records").insert({
      kind, amount: Math.round(amt * 100) / 100, category: catSel.value, note, record_date: date,
    }).select());
    if (rows && rows[0]) {
      moneyRecords.push(rows[0]);
      moneyAnchor = { y: Number(date.slice(0, 4)), m: Number(date.slice(5, 7)) - 1, d: Number(date.slice(8, 10)) };
    }
    closeModal();
    renderMoney();
    toast(MONEY_KINDS[kind].name + "已记录：" + fmtYuan(amt));
  };
  bind("mMoneySave", "click", save);
  bind("mMoneyAmt", "keydown", e => { if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) save(); });
});

bind("moneyList", "click", async (e) => {
  const del = e.target.closest("[data-delmoney]");
  if (!del) return;
  const id = +del.dataset.delmoney;
  const r = moneyRecords.find(x => x.id === id);
  const meta = r ? (MONEY_KINDS[r.kind] || MONEY_KINDS.expense) : MONEY_KINDS.expense;
  const ok = await confirmDialog({
    title: "删除这笔记录",
    desc: "「" + meta.name + " " + fmtYuan(r ? parseFloat(r.amount) || 0 : 0) + "」将被删除。",
    okText: "删除",
  });
  if (!ok) return;
  try {
    await db(cloud.database.from("money_records").delete().eq("id", id).select());
    moneyRecords = moneyRecords.filter(x => x.id !== id);
    renderMoney();
  } catch (err) { /* db() 已提示 */ }
});

/* ============ 月历（豆瓣读书式热力格 + 月统计 + 月目标） ============ */
const HEAT_LV = ["lv0", "lv1", "lv2", "lv3", "lv4"]; // 完成数越多颜色越深

function monthOf(y, m) { return { y, m }; } // m: 0-11
function mvDate() {
  const now = new Date();
  return monthView || { y: now.getFullYear(), m: now.getMonth() };
}
function shiftMonth(delta) {
  const v = mvDate();
  const d = new Date(v.y, v.m + delta, 1);
  monthView = { y: d.getFullYear(), m: d.getMonth() };
  renderMonth();
}
function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }

/* 每日完成数：以子任务 done_at 为准（旧数据没有完成时间则不计入方格） */
function monthCompletionMap(y, m) {
  const map = {};
  const pre = y + "-" + String(m + 1).padStart(2, "0") + "-";
  /* 用「全部子任务」（含已归档任务）计数：删除已完成任务后，那一天的打卡数不变 */
  for (const s of allSubtasks) {
    const d = ymd(s.done_at);
    if (!s.done || !d) continue;
    if (d.slice(0, 8) === pre) {
      const day = parseInt(d.slice(8, 10), 10);
      map[day] = (map[day] || 0) + 1;
    }
  }
  return map;
}

/* 把各种日期形态（Date / ISO / YYYY-MM-DD）统一成 YYYY-MM-DD，避免个别行解析失败导致打卡少算 */
function ymd(v) {
  if (v == null) return "";
  if (v instanceof Date) return localDateStr(v);
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[1] + "-" + m[2] + "-" + m[3] : "";
}
function monthFocusMap(y, m) {
  const map = {};
  const pre = y + "-" + String(m + 1).padStart(2, "0") + "-";
  for (const x of sessions) {
    const d = x.session_date || (x.started_at ? x.started_at.slice(0, 10) : "");
    if (d.slice(0, 8) === pre) {
      const day = parseInt(d.slice(8, 10), 10);
      map[day] = (map[day] || 0) + (x.duration_seconds || 0);
    }
  }
  return map;
}

function renderMonth() {
  const { y, m } = mvDate();
  $id("monthLabel").textContent = y + " 年 " + (m + 1) + " 月";
  const today = new Date();
  const isThisMonth = y === today.getFullYear() && m === today.getMonth();
  const dim = daysInMonth(y, m);
  const daysElapsed = isThisMonth ? today.getDate() : dim;

  /* --- 方格热力：周一开头，前置空格 --- */
  const firstDow = (new Date(y, m, 1).getDay() + 6) % 7; // 0=周一
  const compMap = monthCompletionMap(y, m);
  const focusMap = monthFocusMap(y, m);
  const grid = $id("heatGrid");
  let html = "";
  for (let i = 0; i < firstDow; i++) html += '<span class="heat-cell blank"></span>';
  for (let d = 1; d <= dim; d++) {
    const c = compMap[d] || 0;
    const f = focusMap[d] || 0;
    /* 绝对档位：0 / 1 / 2 / 3-4 / 5+，只由当天完成数决定，删任务不会让这一格变色 */
    const lvIdx = c === 0 ? 0 : c === 1 ? 1 : c === 2 ? 2 : c <= 4 ? 3 : 4;
    const isToday = isThisMonth && d === today.getDate();
    const future = isThisMonth && d > today.getDate();
    html += '<span class="heat-cell ' + HEAT_LV[lvIdx] + (future ? " future" : "") + (isToday ? " today" : "") + '" title="' +
      (m + 1) + "月" + d + "日：完成 " + c + " 个 · 专注 " + fmtDur(f) + '">' + d + "</span>";
  }
  grid.innerHTML = html;

  /* --- 月统计 --- */
  const totalFocus = Object.values(focusMap).reduce((a, b) => a + b, 0);
  const focusDays = Object.values(focusMap).filter(v => v > 0).length;
  $id("mFocusTotal").textContent = fmtDur(totalFocus);
  $id("mFocusAvg").textContent = fmtDur(Math.round(totalFocus / Math.max(1, daysElapsed)));
  $id("mFocusDays").textContent = focusDays;

  const pre = y + "-" + String(m + 1).padStart(2, "0") + "-";
  /* 本月完成数：现存子任务 + 已删除任务的打卡档案（去重），删除已完成的任务不会让月历倒退 */
  const doneThisMonth = allSubtasks.filter(s => s.done && ymd(s.done_at).slice(0, 8) === pre).length;
  const totalSubs = subtasks.length;
  const rate = totalSubs ? Math.round(doneThisMonth / totalSubs * 100) : 0;
  $id("mDoneCnt").innerHTML = doneThisMonth + " <small>个</small>";
  $id("mDoneRate").textContent = rate + "%";
  $id("mDoneAvg").textContent = (doneThisMonth / Math.max(1, daysElapsed)).toFixed(1);

  renderCheckins();
  renderGoals();
}

/* --- 月目标 --- */
function goalProgress(g) {
  if (g.link_task_id) {
    return taskSubs(g.link_task_id).filter(s => s.done).length;
  }
  return g.current || 0;
}
function renderGoals() {
  const list = $id("goalsList");
  if (!goals.length) {
    list.innerHTML = '<div class="stats-empty">还没有月目标。点右上角「＋ 新建目标」，比如「本月专注 20 小时」「完成 30 个子任务」💪</div>';
    return;
  }
  list.innerHTML = goals.map(g => {
    const cur = Math.min(goalProgress(g), g.target);
    const pct = Math.min(100, Math.round(goalProgress(g) / g.target * 100));
    const task = g.link_task_id ? tasks.find(t => t.id === g.link_task_id) : null;
    const linked = task ? '<span class="goal-linked" title="进度自动来自该任务已完成子任务数">' + catOf(task).icon + " " + esc(task.title) + "</span>" : "";
    const ctl = g.link_task_id ? "" :
      '<span class="goal-ctl">' +
      '<button data-goaldec="' + g.id + '" title="减少">−</button>' +
      '<button data-goalinc="' + g.id + '" title="增加">＋</button></span>';
    const done = goalProgress(g) >= g.target;
    return '<div class="goal-row' + (done ? " goal-done" : "") + '">' +
      '<div class="goal-top"><span class="goal-title">' + (done ? "🏆 " : "") + esc(g.title) + "</span>" + linked +
      '<span class="goal-nums">' + goalProgress(g) + " / " + g.target + (g.unit ? " " + esc(g.unit) : "") + "</span>" +
      ctl +
      '<button class="sub-del" data-goaldel="' + g.id + '" title="删除目标">✕</button></div>' +
      '<div class="goal-bar"><div class="goal-fill" style="width:' + pct + '%"></div></div>' +
      "</div>";
  }).join("");
}

bind("prevMonthBtn", "click", () => shiftMonth(-1));
bind("nextMonthBtn", "click", () => shiftMonth(1));
bind("thisMonthBtn", "click", () => { monthView = null; renderMonth(); });

/* --- 项目打卡：跟月历同一个月份导航，1..31 每天一格，点一下打卡 --- */
function checkinRecordMap(itemId) {
  const set = new Set();
  for (const r of checkinRecords) if (r.item_id === itemId) set.add(ymd(r.checkin_date));
  return set;
}
function renderCheckins() {
  const list = $id("checkinList");
  if (!list) return;
  if (!checkinItems.length) {
    list.innerHTML = '<div class="stats-empty">还没有打卡项目。点右上角「＋ 添加打卡项」，比如「喝水 8 杯」「背 20 个单词」「23 点前睡」💧</div>';
    return;
  }
  const { y, m } = mvDate();
  const dim = daysInMonth(y, m);
  const now = new Date();
  const isThisMonth = y === now.getFullYear() && m === now.getMonth();
  const todayD = now.getDate();
  const pre = y + "-" + String(m + 1).padStart(2, "0") + "-";
  list.innerHTML = checkinItems.map(it => {
    const set = checkinRecordMap(it.id);
    const monthCnt = [...set].filter(d => d.slice(0, 8) === pre).length;
    let cells = "";
    for (let d = 1; d <= dim; d++) {
      const ds = pre + String(d).padStart(2, "0");
      const future = isThisMonth && d > todayD;
      const checked = set.has(ds);
      const isToday = isThisMonth && d === todayD;
      cells += '<button class="ci-cell' + (checked ? " checked" : "") + (isToday ? " today" : "") + (future ? " future" : "") +
        '" data-ci="' + it.id + '" data-day="' + ds + '" title="' + (m + 1) + "月" + d + "日" + (checked ? " · 已打卡" : "") + '">' +
        (checked ? "✓" : d) + "</button>";
    }
    return '<div class="checkin-row">' +
      '<div class="ci-top"><span class="ci-name" data-cirename="' + it.id + '" title="点击修改名称">' + esc(it.name) + '</span>' +
      '<span class="ci-cnt">本月 ' + monthCnt + " / " + dim + ' 天</span>' +
      '<button class="sub-del" data-cidel="' + it.id + '" title="删除打卡项">✕</button></div>' +
      '<div class="ci-grid">' + cells + "</div></div>";
  }).join("");
}

bind("addCheckinBtn", "click", () => {
  openModal(
    "<h3>添加打卡项目</h3>" +
    '<label class="modal-label">想坚持的小事（一件就好，越小越好）</label>' +
    '<input id="mCiName" class="modal-input" maxlength="20" placeholder="例：喝水 8 杯 / 背 20 个单词 / 23 点前睡">' +
    '<div class="modal-actions">' +
    '<button class="btn ghost" data-close="1">取消</button>' +
    '<button class="btn primary" id="mCiSave">添加</button>' +
    "</div>"
  );
  const input = $id("mCiName");
  input.focus();
  const save = async () => {
    const name = input.value.trim();
    if (!name) { toast("请输入打卡项目名称", true); return; }
    const rows = await db(cloud.database.from("checkin_items").insert({ name }).select());
    if (rows && rows[0]) checkinItems.push(rows[0]);
    closeModal();
    renderCheckins();
    toast("已添加打卡项：" + name);
  };
  bind("mCiSave", "click", save);
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) save(); });
});

/* 打卡/取消：打卡 +2 积分（彩纸庆祝），取消原额扣回（不自欺，防刷分） */
const ciListEl = $id("checkinList");
if (ciListEl) {
  ciListEl.addEventListener("click", async e => {
    const ren = e.target.closest("[data-cirename]");
    if (ren) {
      const it = checkinItems.find(x => x.id == ren.dataset.cirename);
      if (!it) return;
      openModal(
        "<h3>修改打卡项目名称</h3>" +
        '<label class="modal-label">新名称</label>' +
        '<input id="mCiRename" class="modal-input" maxlength="20" value="' + esc(it.name) + '">' +
        '<div class="modal-actions">' +
        '<button class="btn ghost" data-close="1">取消</button>' +
        '<button class="btn primary" id="mCiRenameSave">保存</button>' +
        "</div>"
      );
      const input = $id("mCiRename");
      input.focus();
      input.select();
      const save = async () => {
        const name = input.value.trim();
        if (!name) { toast("名称不能为空", true); return; }
        if (name === it.name) { closeModal(); return; }
        const rows = await db(cloud.database.from("checkin_items").update({ name }).eq("id", it.id).select());
        if (rows && rows[0]) {
          const i = checkinItems.findIndex(x => x.id === it.id);
          if (i >= 0) checkinItems[i] = rows[0];
        }
        closeModal();
        renderCheckins();
        toast("已改名：" + name);
      };
      bind("mCiRenameSave", "click", save);
      input.addEventListener("keydown", e2 => { if (e2.key === "Enter" && !e2.isComposing && e2.keyCode !== 229) save(); });
      return;
    }
    const del = e.target.closest("[data-cidel]");
    if (del) {
      const it = checkinItems.find(x => x.id == del.dataset.cidel);
      if (!it) return;
      const n = checkinRecords.filter(r => r.item_id == it.id).length;
      const ok = await confirmDialog({
        title: "删除「" + it.name + "」？",
        desc: n ? "已有的 " + n + " 条打卡记录会一起删除（积分不回收）。" : "",
        okText: "删除",
      });
      if (!ok) return;
      await db(cloud.database.from("checkin_items").delete().eq("id", it.id));
      checkinItems = checkinItems.filter(x => x.id !== it.id);
      checkinRecords = checkinRecords.filter(r => r.item_id !== it.id);
      renderCheckins();
      return;
    }
    const cell = e.target.closest("[data-ci]");
    if (!cell || cell.classList.contains("future")) return; // 未来日期不能打卡
    const itemId = +cell.dataset.ci, day = cell.dataset.day;
    const it = checkinItems.find(x => x.id === itemId);
    if (!it) return;
    const checked = cell.classList.contains("checked");
    if (!checked) {
      try {
        const rows = await db(cloud.database.from("checkin_records").insert({ item_id: itemId, checkin_date: day }).select());
        if (rows && rows[0]) checkinRecords.push(rows[0]);
        celebrate();
        sayCompanion("打卡成功，小小的坚持也在攒力量！");
        await awardPoints(2, "打卡：" + it.name + " " + day.slice(5), "checkin", itemId);
        renderCheckins();
      } catch (err) { /* db() 已提示（重复打卡会被唯一索引拦下） */ }
    } else {
      const rec = checkinRecords.find(r => r.item_id === itemId && ymd(r.checkin_date) === day);
      if (!rec) return;
      await db(cloud.database.from("checkin_records").delete().eq("id", rec.id));
      checkinRecords = checkinRecords.filter(r => r.id !== rec.id);
      await awardPoints(-2, "取消打卡：" + it.name + " " + day.slice(5), "checkin", itemId);
      renderCheckins();
    }
  });
}


bind("addGoalBtn", "click", () => {
  const taskOpts = tasks.map(t => '<option value="' + t.id + '">' + catOf(t).icon + " " + esc(t.title) + "</option>").join("");
  openModal(
    "<h3>新建月目标</h3>" +
    '<label class="modal-label">目标名称</label>' +
    '<input id="gTitle" class="modal-input" placeholder="如：本月专注 20 小时" maxlength="40">' +
    '<div class="abc-row2">' +
    '<div><label class="modal-label">目标数值</label><input id="gTarget" type="number" min="1" class="modal-input" value="10"></div>' +
    '<div><label class="modal-label">单位（可选）</label><input id="gUnit" class="modal-input" placeholder="个 / 小时 / 次" maxlength="6"></div>' +
    "</div>" +
    '<label class="modal-label">关联任务（可选，进度自动 = 该任务已完成子任务数）</label>' +
    '<select id="gTask" class="modal-input"><option value="">不关联（手动加减进度）</option>' + taskOpts + "</select>" +
    '<div class="modal-actions"><button class="btn ghost" data-close="1">取消</button>' +
    '<button class="btn primary" id="gSave">创建</button></div>'
  );
  bind("gSave", "click", async () => {
    const title = $id("gTitle").value.trim();
    const target = Math.max(1, parseInt($id("gTarget").value, 10) || 0);
    if (!title) { toast("请填写目标名称", true); return; }
    const payload = { title, target, unit: $id("gUnit").value.trim() || null, link_task_id: $id("gTask").value ? +$id("gTask").value : null };
    const rows = await db(cloud.database.from("monthly_goals").insert(payload).select());
    if (rows && rows[0]) goals.push(rows[0]);
    closeModal();
    renderGoals();
    toast("目标已创建 🎯");
  });
  $id("gTitle").focus();
});

bind("goalsList", "click", async (e) => {
  const inc = e.target.closest("[data-goalinc]");
  const dec = e.target.closest("[data-goaldec]");
  const del = e.target.closest("[data-goaldel]");
  try {
    if (inc || dec) {
      const g = goals.find(x => x.id === +(inc || dec).dataset[inc ? "goalinc" : "goaldec"]);
      if (!g) return;
      const nv = Math.max(0, (g.current || 0) + (inc ? 1 : -1));
      const rows = await db(cloud.database.from("monthly_goals").update({ current: nv }).eq("id", g.id).select());
      if (rows && rows.length) Object.assign(g, rows[0]);
      if (nv >= g.target && inc) celebrate();
      renderGoals();
    } else if (del) {
      const id = +del.dataset.goaldel;
      const ok = await confirmDialog({ title: "删除目标", desc: "删除后不可恢复，确定吗？", okText: "删除" });
      if (!ok) return;
      await db(cloud.database.from("monthly_goals").delete().eq("id", id).select());
      goals = goals.filter(x => x.id !== id);
      renderGoals();
    }
  } catch (err) { /* db() 已提示 */ }
});

/* ============ 每日日程 ============ */
bind("prevDayBtn", "click", () => shiftDate(-1));
bind("nextDayBtn", "click", () => shiftDate(1));
bind("todayBtn", "click", () => { selectedDate = localDateStr(new Date()); renderSchedule(); });
bind("datePicker", "change", () => {
  if ($id("datePicker").value) { selectedDate = $id("datePicker").value; renderSchedule(); }
});
function shiftDate(n) {
  const d = new Date(selectedDate + "T00:00:00");
  d.setDate(d.getDate() + n);
  selectedDate = localDateStr(d);
  renderSchedule();
}

async function renderSchedule() {
  $id("datePicker").value = selectedDate;
  const d = new Date(selectedDate + "T00:00:00");
  const week = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  $id("dateLabel").textContent = (selectedDate === localDateStr(new Date()) ? "今天 · " : "") + (d.getMonth() + 1) + "月" + d.getDate() + "日 周" + week;

  const evRes = await cloud.database.from("schedule_events").select("*").eq("event_date", selectedDate).order("start_time");
  if (evRes.error) { toast("日程加载失败：" + evRes.error.message, true); events = []; }
  else events = evRes.data || [];

  const daySessions = sessions.filter(s => s.session_date === selectedDate);

  let html = "";
  for (let h = 0; h < 24; h++) {
    const top = h * 60;
    html += '<div class="hour-line" style="top:' + top + 'px"><span class="hour-label">' + String(h).padStart(2, "0") + ":00</span></div>";
  }

  const blocks = [];
  events.forEach(ev => {
    const sm = toMin(ev.start_time);
    const em = ev.end_time ? Math.max(toMin(ev.end_time), sm + 15) : sm + 60;
    blocks.push({ type: "event", start: sm, end: em, title: ev.title, sub: timeRange(ev.start_time, ev.end_time) + (ev.note ? " · " + ev.note : ""), id: ev.id });
  });
  daySessions.forEach(ps => {
    const st = new Date(ps.started_at);
    const sm = st.getHours() * 60 + st.getMinutes();
    const task = tasks.find(t => t.id === ps.task_id);
    const sub = subtasks.find(s => s.id === ps.subtask_id);
    blocks.push({
      type: "pomo", start: sm, end: sm + Math.max(15, Math.round(ps.duration_seconds / 60)),
      title: "🍅 " + (sub ? sub.title : (task ? task.title : "专注")),
      sub: (task ? task.title : "") + " · " + fmtDur(ps.duration_seconds),
      id: ps.id,
    });
  });

  blocks.sort((a, b) => a.start - b.start);
  // 简单分道，避免重叠完全遮盖
  const lanes = [];
  blocks.forEach(b => {
    let placed = false;
    for (const lane of lanes) {
      if (lane.end <= b.start) { lane.end = b.end; lane.blocks.push(b); b.lane = lane.idx; placed = true; break; }
    }
    if (!placed) { const lane = { idx: lanes.length, end: b.end, blocks: [b] }; lanes.push(lane); b.lane = lane.idx; }
  });

  blocks.forEach(b => {
    const top = b.start;
    const height = Math.max(24, b.end - b.start - 2);
    const left = 6 + b.lane * 16;
    html += '<div class="tl-block ' + (b.type === "pomo" ? "pomo-block" : "event-block") + '" style="top:' + top + "px;height:" + height + "px;left:" + left + 'px" data-block="' + b.type + ":" + b.id + '">' +
      '<div class="tl-title">' + esc(b.title) + "</div>" +
      '<div class="tl-sub">' + esc(b.sub) + "</div></div>";
  });

  if (!blocks.length) html += '<div class="timeline-empty">这一天还没有安排 · 点击右上角「添加日程」写入事项</div>';
  $id("timeline").innerHTML = html;
}

function toMin(t) {
  const p = String(t || "0:0").split(":");
  return (+p[0] || 0) * 60 + (+p[1] || 0);
}
function timeRange(s, e) { return s + (e ? " - " + e : ""); }

bind("timeline", "click", async (e) => {
  const b = e.target.closest(".tl-block");
  if (!b) return;
  const [type, idStr] = b.dataset.block.split(":");
  const id = +idStr;
  if (type === "event") {
    const ev = events.find(x => x.id === id);
    if (!ev) return;
    const ok = await confirmDialog({
      title: "删除日程",
      desc: "删除「" + esc(ev.title) + "」这条日程？",
      okText: "删除",
    });
    if (ok) {
      const rows = await db(cloud.database.from("schedule_events").delete().eq("id", id).select());
      if (blocked(rows)) { toast("删除失败，请重新登录后再试", true); return; }
      events = events.filter(x => x.id !== id);
      renderSchedule();
    }
  } else {
    const ps = sessions.find(x => x.id === id);
    if (!ps) return;
    const sub = subtasks.find(s => s.id === ps.subtask_id);
    if (sub) openSubtaskModal(sub);
    else toast("该记录的子任务已被删除", true);
  }
});

bind("addEventBtn", "click", () => {
  const now = new Date();
  const defStart = String(now.getHours()).padStart(2, "0") + ":00";
  const endH = (now.getHours() + 1) % 24;
  const defEnd = String(endH).padStart(2, "0") + ":00";
  openModal(
    "<h3>添加日程 · " + selectedDate + "</h3>" +
    '<label class="modal-label">事项名称</label>' +
    '<input id="mEvTitle" class="modal-input" placeholder="如：下午会议、锻炼、读书…" maxlength="50">' +
    '<label class="modal-label">开始时间</label>' +
    '<input id="mEvStart" class="modal-input" type="time" value="' + defStart + '">' +
    '<label class="modal-label">结束时间（可留空）</label>' +
    '<input id="mEvEnd" class="modal-input" type="time" value="' + defEnd + '">' +
    '<label class="modal-label">备注（可留空）</label>' +
    '<input id="mEvNote" class="modal-input" placeholder="备注…" maxlength="100">' +
    '<div class="modal-actions">' +
    '<button class="btn ghost" data-close="1">取消</button>' +
    '<button class="btn primary" id="mEvSave">保存</button>' +
    "</div>"
  );
  bind("mEvSave", "click", async () => {
    const title = $id("mEvTitle").value.trim();
    const start = $id("mEvStart").value;
    const end = $id("mEvEnd").value || null;
    const note = $id("mEvNote").value.trim() || null;
    if (!title) { toast("请输入事项名称", true); return; }
    if (!start) { toast("请选择开始时间", true); return; }
    const rows = await db(cloud.database.from("schedule_events").insert({
      event_date: selectedDate, start_time: start, end_time: end, title, note,
    }).select());
    if (rows && rows[0]) events.push(rows[0]);
    closeModal();
    renderSchedule();
    toast("日程已添加");
  });
  $id("mEvTitle").focus();
});

/* ============ 心理页面 ============ */
const CHAT_SYSTEM = "你是一个任务管理应用里的心理陪伴助手，用户可能带有 ADHD 特质、容易焦虑和自我否定。请遵守：1) 用温暖、口语化的简体中文回复，一般不超过 150 字，先共情再建议，不说教、不堆砌大道理；2) 每次回复最多给一个小而具体的行动建议；3) 可以温和地用认知行为疗法（ABC：事件-想法-结果）和正念的思路引导，但不要诊断、不要替代专业治疗；4) 如果用户提到自伤、自杀或伤害他人，请温和而明确地建议立即寻求专业帮助：全国心理援助热线 12356（24 小时），紧急情况拨打 120/110，并陪在TA身边；5) 不聊政治敏感话题，不提供医疗药物建议。";

let llmModels = [];
let chatModel = "";
let chatMsgs = [];
let chatBusy = false;
let chatAbort = null;
let chatConvId = "";
let abcRecords = [];
let abcLoaded = false;
let aidRendered = false;
let breathTimer = null;

function chatStorage() {
  try { return JSON.parse(localStorage.getItem("pomo_chat_v1") || "null"); } catch (e) { return null; }
}
function saveChatStorage() {
  try {
    localStorage.setItem("pomo_chat_v1", JSON.stringify({
      msgs: chatMsgs.slice(-40), convId: chatConvId, model: chatModel,
    }));
  } catch (e) { /* 隐私模式等场景忽略 */ }
}

async function initChat() {
  const saved = chatStorage();
  chatMsgs = (saved && saved.msgs) || [];
  chatConvId = (saved && saved.convId) || ("wb-chat-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8));
  renderChatMsgs();

  const sel = $id("chatModelSel");
  sel.innerHTML = '<option value="">加载模型中…</option>';
  try {
    const res = await cloud.llm.models.list();
    llmModels = (Array.isArray(res) ? res : (res && res.data) || []).filter(m => !m.disabled);
  } catch (e) { llmModels = []; }
  if (!llmModels.length) {
    sel.innerHTML = '<option value="">暂无可用模型</option>';
    return;
  }
  const prefer = ["auto", "hunyuan-chat", "glm-4.6"];
  let pick = llmModels.find(m => saved && saved.model === m.id) ||
    prefer.map(p => llmModels.find(m => m.id === p)).find(Boolean) || llmModels[0];
  chatModel = pick.id;
  sel.innerHTML = llmModels.map(m => '<option value="' + esc(m.id) + '"' + (m.id === chatModel ? " selected" : "") + ">" + esc(m.name || m.id) + "</option>").join("");
}

function renderChatMsgs() {
  const box = $id("chatMsgs");
  if (!chatMsgs.length) {
    box.innerHTML = '<div class="chat-empty">想说什么都可以，这里没有评判 🌱<br>也可以直接告诉我：今天发生了什么、你现在的感受。</div>';
    return;
  }
  box.innerHTML = "";
  chatMsgs.forEach(m => {
    const b = document.createElement("div");
    b.className = "chat-bubble " + (m.role === "user" ? "user" : "assistant");
    b.textContent = m.content;
    box.appendChild(b);
  });
  box.scrollTop = box.scrollHeight;
}

function llmErrMsg(e) {
  const code = e && e.error && e.error.code || "";
  if (code.indexOf("quota_") === 0) return "今天的 AI 额度用完了，明天再来聊聊";
  if (code.indexOf("auth_") === 0) return "模型通道异常，请稍后重试";
  if (code.indexOf("gateway_") === 0 || code.indexOf("model_") === 0) return "模型服务暂时不可用，请点发送重试";
  if (code.indexOf("content") >= 0) return "这条内容没能通过安全检查，换个说法试试";
  return (e && e.message) || "发送失败，请重试";
}

async function sendChat() {
  const input = $id("chatInput");
  const text = input.value.trim();
  if (!text) return;
  if (chatBusy) { toast("AI 还在回复中，稍等一下", true); return; }
  if (!chatModel) { toast("没有可用的大模型，请稍后再试", true); return; }

  input.value = "";
  chatMsgs.push({ role: "user", content: text });
  renderChatMsgs();
  chatBusy = true;
  $id("chatSendBtn").textContent = "停止";
  $id("chatSendBtn").classList.add("ghost");

  const box = $id("chatMsgs");
  const holder = document.createElement("div");
  holder.className = "chat-bubble assistant thinking";
  holder.textContent = "正在回复…";
  box.appendChild(holder);
  box.scrollTop = box.scrollHeight;

  let acc = "";
  chatAbort = new AbortController();
  try {
    for await (const chunk of cloud.llm.chat.completions.create({
      model: chatModel,
      messages: [{ role: "system", content: CHAT_SYSTEM }].concat(chatMsgs.slice(-24)),
      stream: true,
      conversationId: chatConvId,
      signal: chatAbort.signal,
    })) {
      const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      if (d && d.content) {
        if (!acc) holder.classList.remove("thinking");
        acc += d.content;
        holder.textContent = acc;
        box.scrollTop = box.scrollHeight;
      }
    }
    if (acc) {
      chatMsgs.push({ role: "assistant", content: acc });
      saveChatStorage();
    }
  } catch (e) {
    if (acc) {
      chatMsgs.push({ role: "assistant", content: acc });
      saveChatStorage();
      toast("回复被中断，已保留已生成的部分", true);
    } else {
      toast(llmErrMsg(e), true);
      input.value = text; // 把内容还回去，方便重发
    }
  } finally {
    holder.remove();
    chatBusy = false;
    chatAbort = null;
    $id("chatSendBtn").textContent = "发送";
    $id("chatSendBtn").classList.remove("ghost");
    renderChatMsgs();
  }
}

bind("chatSendBtn", "click", () => {
  if (chatBusy && chatAbort) { chatAbort.abort(); return; }
  sendChat();
});
bind("chatInput", "keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); if (!chatBusy) sendChat(); }
});
bind("chatClearBtn", "click", () => {
  chatMsgs = [];
  chatConvId = "wb-chat-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  saveChatStorage();
  renderChatMsgs();
  toast("已开启新对话 🌱");
});
bind("chatModelSel", "change", (e) => {
  chatModel = e.target.value;
  saveChatStorage();
});

/* ---------- ABC 情绪记录 ---------- */
async function loadAbc() {
  const res = await cloud.database.from("abc_records").select("*").order("record_date", { ascending: false }).order("id", { ascending: false }).limit(100);
  if (res.error) { toast("记录加载失败：" + res.error.message, true); return; }
  abcRecords = res.data || [];
  renderAbc();
}

function renderAbc() {
  const box = $id("abcList");
  if (!abcRecords.length) {
    box.innerHTML = '<div class="stats-empty">还没有记录。情绪来的时候，顺手记一条，慢慢就会看清自己的模式 🌱</div>';
    return;
  }
  box.innerHTML = abcRecords.map(r => {
    const it = r.intensity || 0;
    return '<div class="abc-item">' +
      '<button class="abc-del" data-delabc="' + r.id + '" title="删除记录">✕</button>' +
      '<div class="abc-item-top">' +
      '<span class="abc-date">' + esc(r.record_date) + '</span>' +
      (r.emotion ? '<span class="abc-emotion">' + esc(r.emotion) + '</span>' : "") +
      (it ? '<span class="abc-intensity">强度<i style="width:' + (it * 10) + 'px"></i>' + it + '/10</span>' : "") +
      "</div>" +
      '<div class="abc-line"><b>A 事件</b>' + esc(r.a_event) + "</div>" +
      '<div class="abc-line"><b>B 想法</b>' + esc(r.b_belief) + "</div>" +
      '<div class="abc-line"><b>C 结果</b>' + esc(r.c_result) + "</div>" +
      "</div>";
  }).join("");
}

bind("abcIntensity", "input", () => { $id("abcIntVal").textContent = $id("abcIntensity").value; });

bind("abcSaveBtn", "click", async () => {
  const a = $id("abcA").value.trim();
  const b = $id("abcB").value.trim();
  const c = $id("abcC").value.trim();
  if (!a || !b || !c) { toast("A 事件、B 想法、C 结果都写一写吧（哪怕一句话）", true); return; }
  try {
    const rows = await db(cloud.database.from("abc_records").insert({
      record_date: $id("abcDate").value || localDateStr(new Date()),
      a_event: a, b_belief: b, c_result: c,
      emotion: $id("abcEmotion").value,
      intensity: +$id("abcIntensity").value,
    }).select());
    if (rows && rows[0]) {
      abcRecords.unshift(rows[0]);
      renderAbc();
      $id("abcA").value = ""; $id("abcB").value = ""; $id("abcC").value = "";
      toast("已记录 ✍️ 觉察本身就是改变的第一步");
    }
  } catch (e) { /* db() 已提示 */ }
});

bind("abcList", "click", async (e) => {
  const btn = e.target.closest("[data-delabc]");
  if (!btn) return;
  const id = +btn.dataset.delabc;
  const rec = abcRecords.find(x => x.id === id);
  const ok = await confirmDialog({
    title: "删除记录",
    desc: "删除 " + esc(rec ? rec.record_date : "") + " 这条 ABC 记录？",
    okText: "删除",
  });
  if (!ok) return;
  try {
    await db(cloud.database.from("abc_records").delete().eq("id", id).select());
    abcRecords = abcRecords.filter(x => x.id !== id);
    renderAbc();
    toast("记录已删除");
  } catch (err) { /* db() 已提示 */ }
});

/* ---------- 情绪急救包 ---------- */
const FIRST_AID = [
  {
    icon: "📱", title: "刷屏冲动冲浪", desc: "想刷手机停不下来时 · 先冲 60 秒浪", urge: true,
    steps: [
      "先不评价自己。想刷不是堕落，是大脑在要刺激、或在止痛。",
      "接下来 60 秒什么都不用做：看着下面的数字往下走。冲动像浪，会自己升起来，也会自己退下去。",
      "60 秒后如果还想刷，就光明正大刷——但要定时。这是和自己的约定：玩可以，无底洞不行。",
    ],
  },
  {
    icon: "👁", title: "5-4-3-2-1 感官接地", desc: "用五感回到当下 · 最快最常用",
    steps: [
      "先做一次深呼吸，然后慢慢在心里（或小声）说出来——",
      "👁 你现在能看到的 5 样东西，一样一样看过去",
      "✋ 你能摸到的 4 样东西，注意它们的温度和质地",
      "👂 你能听到的 3 种声音，远的和近的",
      "👃 你能闻到的 2 种气味",
      "👄 你能尝到的 1 种味道（喝口水也行）",
      "最后再做一次深呼吸，感受一下：现在你在哪里，你是安全的。",
    ],
  },
  {
    icon: "🫁", title: "盒式呼吸", desc: "吸4 · 屏4 · 呼4 · 屏4，跟着方框走", breathing: true,
    steps: [
      "跟着下面的方框：变大时用鼻子吸气，停住时屏息，变小时用嘴慢慢呼气。",
      "做 4 轮左右，心率就会明显慢下来。",
      "头晕是正常的，放慢节奏即可；随时可以停下。",
    ],
  },
  {
    icon: "🧘", title: "快速身体扫描", desc: "从头到脚觉察 · 重建身体联结",
    steps: [
      "闭上眼或垂下视线，做一次深呼吸。",
      "注意力放到头顶和额头：那里紧吗？皱着眉吗？让它松开。",
      "再到下巴、肩膀——肩膀最容易耸着，让它们落下去。",
      "双手：握拳再张开，重复 3 次，感受手心的温度。",
      "最后到脚底：感受脚踩在地上的感觉，想象压力顺着脚流进地面。",
    ],
  },
  {
    icon: "💧", title: "冷水刺激", desc: "生理层面干预 · 效果立竿见影",
    steps: [
      "去洗手间，用冷水洗一把脸，或者用冷水冲手腕 30 秒。",
      "冷会触发「潜水反射」，心率会自然降下来，情绪的浪头会小一圈。",
      "也可以含一颗冰块、拿一罐冰饮料贴在脸上滚一滚。",
      "注意：这是快速降温用的小技巧，不是逃避，冷静之后再处理事情。",
    ],
  },
  {
    icon: "✊", title: "渐进式肌肉放松", desc: "先收紧再放松 · 释放身体紧张",
    steps: [
      "双手：用力握拳 5 秒 → 突然松开，体会「松」的感觉。",
      "肩膀：耸到耳朵边 5 秒 → 「咚」地放下。",
      "脸：紧闭眼睛、咬紧牙 5 秒 → 全部松开。",
      "腿：伸直绷紧 5 秒 → 放松。",
      "记住「紧 → 松」的对比，身体记住了，下次更容易自己松下来。",
    ],
  },
  {
    icon: "🎧", title: "安抚小物 · 戴耳机听歌", desc: "给情绪一个出口，一两首歌就够",
    steps: [
      "戴上耳机，挑一首你最熟、最有安全感的歌（不要新歌）。",
      "音量调到能盖过脑子里的杂音，闭上眼听完一整首。",
      "情绪激动时选慢的、纯音乐的；提不起劲时选你年轻时的歌。",
      "听完就回来，不带手机乱刷——歌是台阶，不是窝。",
    ],
  },
  {
    icon: "🧶", title: "ADHD 扭扭棒", desc: "手上有事做，思绪就落回来",
    steps: [
      "手里拿一个可以反复摆弄的小物：扭扭棒、指尖陀螺、捏捏乐都行。",
      "让手保持有节奏的重复动作，眼睛可以看着屏幕或听着对话。",
      "手被占用后，大脑反而不容易飘走——这不是分心，是给多余的精力一个出口。",
      "开会/学习前先玩一分钟，当作「热身开关」。",
    ],
  },
];

function renderAidGrid() {
  if (aidRendered) return;
  aidRendered = true;
  $id("aidGrid").innerHTML = FIRST_AID.map((item, i) =>
    '<button class="aid-item" data-aid="' + i + '">' +
    '<span class="aid-ic">' + item.icon + "</span>" +
    '<span class="aid-txt"><span class="aid-title">' + item.title + '</span>' +
    '<div class="aid-desc">' + item.desc + "</div></span>" +
    '<span class="aid-arrow">→</span>' +
    "</button>"
  ).join("");
}

let breath = null; // { phase, sec, round, intervalId }
let urge = null; // { endAt, intervalId } 刷屏冲动冲浪倒计时

function stopUrge() {
  if (urge && urge.intervalId) clearInterval(urge.intervalId);
  urge = null;
}

function startBreathing() {
  stopBreathing();
  const phases = [
    { name: "吸气", sec: 4, size: "big" },
    { name: "屏住", sec: 4, size: "big" },
    { name: "呼气", sec: 4, size: "small" },
    { name: "停顿", sec: 4, size: "small" },
  ];
  breath = { phase: 0, sec: phases[0].sec, round: 1, intervalId: null };
  const paint = () => {
    const p = phases[breath.phase];
    const box = $id("breathBox");
    if (!box) return;
    box.className = "breath-box " + p.size;
    $id("breathPhase").textContent = p.name;
    $id("breathCount").textContent = "还剩 " + breath.sec + " 秒";
    $id("breathRound").textContent = "第 " + breath.round + " / 4 轮";
  };
  paint();
  breath.intervalId = setInterval(() => {
    breath.sec--;
    if (breath.sec <= 0) {
      breath.phase = (breath.phase + 1) % 4;
      if (breath.phase === 0) {
        breath.round++;
        if (breath.round > 4) { stopBreathing(); const b = $id("breathBox"); if (b) { b.className = "breath-box"; } const ph = $id("breathPhase"); if (ph) ph.textContent = "完成 ✓"; const cnt = $id("breathCount"); if (cnt) cnt.textContent = "去喝口水，回到正事上来"; const rd = $id("breathRound"); if (rd) rd.textContent = ""; return; }
      }
      breath.sec = phases[breath.phase].sec;
    }
    paint();
  }, 1000);
}

function stopBreathing() {
  if (breath && breath.intervalId) clearInterval(breath.intervalId);
  breath = null;
}

function openFirstAid(item, onClose) {
  let html = '<div class="aid-head"><span class="aid-ic">' + item.icon + "</span><div>" +
    "<h3>" + item.title + '</h3><div class="aid-desc">' + item.desc + "</div></div></div>";
  if (item.breathing) {
    html += '<div class="breath-box small" id="breathBox"><div class="breath-phase" id="breathPhase">准备</div><div class="breath-count" id="breathCount"></div></div>' +
      '<div class="breath-meta" id="breathRound"></div>';
  }
  if (item.urge) {
    html += '<div class="urge-box"><div class="urge-time" id="urgeTime">60</div><div class="urge-cap" id="urgeCap">看着数字往下走，什么都不用做</div></div>' +
      '<div class="flow-row hidden" id="urgeActs">' +
      '<button class="btn ghost" id="urgeScreen">📱 定时刷 10 分钟</button>' +
      '<button class="btn ghost" id="urgeSwap">换个补给</button>' +
      '<button class="btn primary" id="urgeStay">继续手里的事</button>' +
      "</div>";
  }
  html += '<ol class="aid-steps">' + item.steps.map(s => "<li>" + s + "</li>").join("") + "</ol>" +
    '<div class="modal-actions"><button class="btn primary" data-close="1">' + (item.urge ? "先这样" : "我练完了") + "</button></div>";
  openModal(html, () => { stopBreathing(); stopUrge(); if (onClose) onClose(); });
  if (item.breathing) startBreathing();
  if (item.urge) {
    /* 冲动冲浪 60 秒：按时间戳算，切走再回来也准 */
    urge = { endAt: Date.now() + 60000, intervalId: null };
    const tick = () => {
      if (!urge) return;
      const left = Math.max(0, Math.round((urge.endAt - Date.now()) / 1000));
      const t = $id("urgeTime"), c = $id("urgeCap"), acts = $id("urgeActs");
      if (!t) { stopUrge(); return; }
      t.textContent = left;
      if (left <= 0) {
        stopUrge();
        c.textContent = "浪退了一点没有？现在选：";
        acts.classList.remove("hidden");
      }
    };
    urge.intervalId = setInterval(tick, 500);
    tick();
    bind("urgeScreen", "click", () => {
      if (rest) { toast("已经在休息倒计时里了，这轮结束再说", true); return; }
      const s = (anchor && subtasks.find(x => x.id === anchor.subtaskId)) || pickBestSub();
      closeModal();
      startRest("screen", 10, s, anchor && anchor.text ? anchor.text : "");
    });
    bind("urgeSwap", "click", () => {
      closeModal();
      toast("冲动是无聊或焦虑在要东西——去拿真正的补给：走两步、喝水、玩会儿扭扭棒");
    });
    bind("urgeStay", "click", () => {
      closeModal();
      awardPoints(2, "冲动冲浪 60 秒", "urge", null);
      toast("赢了这一浪。回到刚才的事上");
    });
  }
}

bind("aidGrid", "click", (e) => {
  const btn = e.target.closest("[data-aid]");
  if (btn) openFirstAid(FIRST_AID[+btn.dataset.aid]);
});

/* ---------- 心理页子标签 ---------- */
document.querySelectorAll(".mind-sub").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mind-sub").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    ["chat", "abc", "aid"].forEach(k => $id("mind-" + k).classList.toggle("hidden", k !== btn.dataset.mind));
    if (btn.dataset.mind === "abc") loadAbc();
    if (btn.dataset.mind === "aid") renderAidGrid();
  });
});

function renderMind() {
  renderChatMsgs();
}

/* ============ 弹窗通用 ============ */
let modalOnClose = null;
function openModal(html, onClose) {
  modalOnClose = onClose || null;
  $id("modalBox").innerHTML = html;
  $id("modalOverlay").classList.remove("hidden");
}
function closeModal() {
  $id("modalOverlay").classList.add("hidden");
  $id("modalBox").innerHTML = "";
  stopRitual(); // 关弹窗时清掉就位仪式的倒计时
  const cb = modalOnClose;
  modalOnClose = null;
  if (cb) cb();
}

/* 应用内确认弹窗：替代 window.confirm()
   内嵌预览面板与部分手机 WebView 会屏蔽原生 confirm（静默返回 false），
   导致「点了删除却没反应」，所以统一走自绘弹窗。 */
function confirmDialog(opts) {
  return new Promise(resolve => {
    let settled = false;
    const finish = v => {
      if (settled) return;
      settled = true;
      resolve(v);
      closeModal();
    };
    openModal(
      "<h3>" + esc(opts.title || "确认操作") + "</h3>" +
      (opts.desc ? '<p class="confirm-desc">' + opts.desc + "</p>" : "") +
      '<div class="modal-actions">' +
      '<button class="btn ghost" id="mConfirmCancel">取消</button>' +
      '<button class="btn danger" id="mConfirmOk">' + esc(opts.okText || "删除") + "</button>" +
      "</div>",
      () => { if (!settled) { settled = true; resolve(false); } }
    );
    bind("mConfirmOk", "click", () => finish(true));
    bind("mConfirmCancel", "click", () => finish(false));
  });
}

/* 重要程度选择器（新建 / 修改任务共用） */
function levelPickerHtml(sel) {
  return '<div class="level-picker" id="mLevelPick">' +
    Object.keys(LEVELS).map(k =>
      '<button class="level-opt' + (k === sel ? " sel-" + k : "") + '" data-lv="' + k + '">' + LEVELS[k].label + "</button>"
    ).join("") + "</div>";
}
function bindLevelPicker(initial) {
  let level = initial;
  const pick = $id("mLevelPick");
  if (!pick) return () => level;
  pick.addEventListener("click", e => {
    const b = e.target.closest(".level-opt");
    if (!b) return;
    level = b.dataset.lv;
    pick.querySelectorAll(".level-opt").forEach(x => x.className = "level-opt");
    b.className = "level-opt sel-" + level;
  });
  return () => level;
}

/* 分类选择器（新建 / 修改任务共用，末尾带「＋ 自定义」和「⚙ 管理」） */
function catOptionsHtml(sel) {
  const m = catMap();
  return Object.keys(m).map(k => {
    const c = m[k];
    return '<button class="cat-opt' + (k === sel ? " sel" : "") + '" data-cat="' + k + '">' +
      '<span class="cat-ic">' + c.icon + "</span>" + esc(c.label) + "</button>";
  }).join("") +
    '<button class="cat-opt cat-add" id="mCatAdd" title="添加自定义分类">＋ 自定义</button>' +
    (customCats.length ? '<button class="cat-opt cat-add" id="mCatManage" title="修改或删除自定义分类">⚙ 管理</button>' : "");
}
function categoryPickerHtml(sel) {
  return '<div class="cat-picker" id="mCatPick">' + catOptionsHtml(sel) + "</div>";
}
function bindCategoryPicker(initial) {
  let cat = initial || "";
  const pick = $id("mCatPick");
  if (!pick) return () => cat;
  const ref = { get: () => cat, set: v => { cat = v; } };
  pick.addEventListener("click", async e => {
    if (e.target.closest("#mCatAdd")) { renderCatAddForm(pick, ref); return; }
    if (e.target.closest("#mCatManage")) { renderCatManage(pick, ref); return; }
    if (e.target.closest("#mCatBack") || e.target.closest("#mCatCancel")) { pick.innerHTML = catOptionsHtml(ref.get()); return; }
    const sv = e.target.closest("[data-catsave]");
    if (sv) {
      const row = sv.closest(".cat-mrow");
      if (!row) return;
      const icon = (row.querySelector(".cm-ic").value.trim() || "📁").slice(0, 4);
      const label = row.querySelector(".cm-name").value.trim();
      if (!label) { toast("名称不能为空", true); return; }
      if (customCats.some(c => c.key !== sv.dataset.catsave && c.label === label) ||
          Object.values(CATEGORIES).some(c => c.label === label)) { toast("已有同名分类", true); return; }
      await persistCustomCats(customCats.map(c => c.key === sv.dataset.catsave ? { ...c, label, icon } : c));
      renderCatManage(pick, ref);
      toast("分类已更新：" + icon + " " + label);
      return;
    }
    const dl = e.target.closest("[data-catdel]");
    if (dl) {
      if (!dl.classList.contains("armed")) {
        dl.classList.add("armed");
        dl.textContent = "确认?";
        setTimeout(() => { dl.classList.remove("armed"); dl.textContent = "🗑"; }, 3000);
        return;
      }
      await persistCustomCats(customCats.filter(c => c.key !== dl.dataset.catdel));
      renderCatManage(pick, ref);
      toast("分类已删除（用到它的任务显示为「未分类」，数据不受影响）");
      return;
    }
    const b = e.target.closest(".cat-opt");
    if (!b || b.id === "mCatAdd" || b.id === "mCatManage") return;
    cat = b.dataset.cat;
    pick.querySelectorAll(".cat-opt").forEach(x => x.classList.remove("sel"));
    b.classList.add("sel");
  });
  return () => cat;
}

/* 自定义分类统一持久化 */
async function persistCustomCats(next) {
  let saved = next;
  if (profileId) {
    const res = await db(cloud.database.from("user_profiles").update({ custom_categories: JSON.stringify(next) }).eq("id", profileId).select());
    if (res && res[0]) {
      try { saved = JSON.parse(res[0].custom_categories || "[]") || next; } catch (e) { /* 保存失败就用本地值 */ }
    }
  }
  customCats = saved;
  return saved;
}

/* 分类管理：内联列表，改名称/图标 + 删除（两步确认），不开新弹窗避免顶掉任务表单 */
function renderCatManage(pick, ref) {
  const rows = customCats.map(c =>
    '<div class="cat-mrow" data-k="' + c.key + '">' +
    '<input class="cm-ic" maxlength="4" value="' + esc(c.icon || "📁") + '" title="图标（一个 emoji）">' +
    '<input class="cm-name" maxlength="8" value="' + esc(c.label) + '" title="分类名称">' +
    '<button type="button" class="btn primary small" data-catsave="' + c.key + '" title="保存修改">✓</button>' +
    '<button type="button" class="btn ghost small cm-del" data-catdel="' + c.key + '" title="删除该分类">🗑</button>' +
    "</div>").join("");
  pick.innerHTML = '<div class="cat-manage">' +
    '<p class="cm-hint">改名称或图标后点 ✓ 保存；🗑 点一次变成「确认?」再点一次才删除。删除分类不影响已有任务数据（它们会显示为「未分类」）。</p>' +
    (rows || '<p class="cm-hint">还没有自定义分类。</p>') +
    '<button type="button" class="btn ghost small" id="mCatBack">‹ 返回</button></div>';
}

/* 自定义分类：在选择器内联展开一个小表单（不开新弹窗，避免顶掉任务表单），保存到账号并自动选中 */
function renderCatAddForm(pick, ref) {
  const selBtn = pick.querySelector(".cat-opt.sel");
  const selKey = (selBtn && selBtn.dataset.cat) || (ref && ref.get ? ref.get() : "");
  pick.innerHTML = catOptionsHtml(selKey) +
    '<div class="cat-inline" id="mCatInline">' +
    '<input id="mCatIcon" maxlength="4" value="📁" title="图标（一个 emoji）">' +
    '<input id="mCatName" maxlength="8" placeholder="分类名，如：实习">' +
    '<button type="button" class="btn primary small" id="mCatOk" title="保存">✓</button>' +
    '<button type="button" class="btn ghost small" id="mCatCancel" title="取消">✕</button>' +
    "</div>";
  const nameInput = $id("mCatName");
  nameInput.focus();
  const save = async () => {
    const label = nameInput.value.trim();
    const icon = ($id("mCatIcon").value.trim() || "📁").slice(0, 4);
    if (!label) { toast("请输入分类名称", true); return; }
    if (Object.values(catMap()).some(c => c.label === label)) { toast("已有同名分类", true); return; }
    const key = "c" + Date.now();
    await persistCustomCats(customCats.concat([{ key, label, icon }]));
    if (ref && ref.set) ref.set(key);
    pick.innerHTML = catOptionsHtml(key);
    toast("已添加分类：" + icon + " " + label);
  };
  $id("mCatOk").addEventListener("click", save);
  [nameInput, $id("mCatIcon")].forEach(inp => inp.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); save(); } }));
}

/* 写入结果判定：只有明确返回空数组才说明被 RLS 拦下 / 行不存在 */
function blocked(rows) { return Array.isArray(rows) && rows.length === 0; }

/* ============ 删除 / 重命名 ============ */
async function deleteSubtask(id) {
  const rows = await db(cloud.database.from("subtasks").delete().eq("id", id).select());
  if (blocked(rows)) {
    toast("删除失败：这条数据可能不属于当前账号，请重新登录后再试", true);
    return false;
  }
  if (timer && timer.subtaskId === id) { clearInterval(timer.intervalId); timer = null; renderFloat(); }
  subtasks = subtasks.filter(s => s.id !== id);
  sessions = sessions.filter(x => x.subtask_id !== id);
  items = items.filter(i => i.subtask_id !== id);
  renderAll();
  toast("子任务已删除");
  return true;
}

/* 删除任务的两种口径：
   已完成任务 → 只「归档」：任务行留在库里（不真删），列表 / 分层 / 统计看不到它，
     但专注记录因为外键还在，月历打卡格、月专注时长、积分全部原样保留；
   未完成任务 → 真删：数据库级联清掉子任务/子项/专注记录，并把相关积分流水一并删掉。 */
async function deleteTask(id) {
  const goneSubs = subtasks.filter(s => s.task_id === id);
  const goneSubIds = goneSubs.map(s => s.id);
  const goneItems = items.filter(i => goneSubIds.indexOf(i.subtask_id) >= 0);
  const wasDone = goneSubs.length > 0 && goneSubs.every(s => s.done);

  if (wasDone) {
    const upd = await db(cloud.database.from("tasks").update({ archived: true }).eq("id", id).select());
    if (blocked(upd)) {
      toast("删除失败：这条数据可能不属于当前账号，请重新登录后再试", true);
      return false;
    }
    archivedTaskIds.add(id);
    /* 月目标关联到被归档任务的话要解绑，否则刷新后既没标签也没有加减按钮 */
    for (const g of goals.filter(x => x.link_task_id === id)) {
      try { await db(cloud.database.from("monthly_goals").update({ link_task_id: null }).eq("id", g.id).select()); } catch (e) {}
    }
  } else {
    const rows = await db(cloud.database.from("tasks").delete().eq("id", id).select());
    if (blocked(rows)) {
      toast("删除失败：这条数据可能不属于当前账号，请重新登录后再试", true);
      return false;
    }
    const goneSess = sessions.filter(x => x.task_id === id);
    for (const ses of goneSess) {
      try { await db(cloud.database.from("pomodoro_sessions").delete().eq("id", ses.id).select()); } catch (e) {}
    }
    const goneLedger = points.filter(p =>
      (p.ref_type === "subtask" && goneSubIds.some(sid => String(p.ref_id) === String(sid))) ||
      (p.ref_type === "item" && goneItems.some(i => String(p.ref_id) === String(i.id))) ||
      (p.ref_type === "session" && goneSess.some(x => String(p.ref_id) === String(x.id))) ||
      (p.ref_type === "task" && String(p.ref_id) === String(id)));
    for (const p of goneLedger) {
      try { await db(cloud.database.from("points_ledger").delete().eq("id", p.id).select()); } catch (e) {}
    }
    sessions = sessions.filter(x => x.task_id !== id);
    allSubtasks = allSubtasks.filter(x => x.task_id !== id);
    points = points.filter(p => goneLedger.indexOf(p) < 0);
  }

  if (timer && timer.taskId === id) { clearInterval(timer.intervalId); timer = null; renderFloat(); }
  if (anchor && goneSubIds.indexOf(anchor.subtaskId) >= 0) clearAnchor();
  tasks = tasks.filter(x => x.id !== id);
  subtasks = subtasks.filter(s => s.task_id !== id);
  items = items.filter(i => goneSubIds.indexOf(i.subtask_id) < 0);
  goals.forEach(g => { if (g.link_task_id === id) g.link_task_id = null; });
  if (currentTaskId === id) exitLayer();
  renderAll();
  toast(wasDone ? "任务已移出列表 · 月历打卡、专注记录和积分都保留 📅" : "任务已删除，相关记录一并清除");
  return true;
}

function renameTask(task) {
  openModal(
    "<h3>修改任务</h3>" +
    '<label class="modal-label">任务标题</label>' +
    '<input id="mRenTitle" class="modal-input" maxlength="50" value="' + esc(task.title) + '" placeholder="输入任务标题">' +
    '<label class="modal-label">分类</label>' +
    categoryPickerHtml(task.category) +
    '<label class="modal-label">重要程度（决定卡片颜色）</label>' +
    levelPickerHtml(task.level) +
    '<label class="modal-label">任务规划（整体怎么做、要点备忘）</label>' +
    '<textarea id="mTaskPlan" class="modal-textarea" placeholder="写下执行计划、要点或备注…">' + esc(task.plan || "") + "</textarea>" +
    '<div class="modal-actions">' +
    '<button class="btn ghost" data-close="1">取消</button>' +
    '<button class="btn primary" id="mRenSave">保存</button>' +
    "</div>"
  );
  const getLevel = bindLevelPicker(task.level);
  const getCat = bindCategoryPicker(task.category);
  const input = $id("mRenTitle");
  input.focus();
  input.select();
  const save = async () => {
    const title = input.value.trim();
    if (!title) { toast("请输入任务标题", true); return; }
    const patch = { title, level: getLevel(), category: getCat() || null, plan: $id("mTaskPlan") ? $id("mTaskPlan").value : (task.plan || "") };
    const rows = await db(cloud.database.from("tasks").update(patch).eq("id", task.id).select());
    if (blocked(rows)) { toast("保存失败，请重新登录后再试", true); return; }
    Object.assign(task, patch);
    if (rows && rows[0]) Object.assign(task, rows[0]);
    closeModal();
    renderAll();
    toast("任务已更新");
  };
  bind("mRenSave", "click", save);
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) save(); });
}

function renameSubtask(sub) {
  openModal(
    "<h3>修改子任务</h3>" +
    '<label class="modal-label">子任务名称</label>' +
    '<input id="mRenSubTitle" class="modal-input" maxlength="50" value="' + esc(sub.title) + '" placeholder="输入子任务名称">' +
    '<div class="modal-actions">' +
    '<button class="btn ghost" data-close="1">取消</button>' +
    '<button class="btn primary" id="mRenSubSave">保存</button>' +
    "</div>"
  );
  const input = $id("mRenSubTitle");
  input.focus();
  input.select();
  const save = async () => {
    const title = input.value.trim();
    if (!title) { toast("请输入子任务名称", true); return; }
    const rows = await db(cloud.database.from("subtasks").update({ title }).eq("id", sub.id).select());
    if (blocked(rows)) { toast("保存失败，请重新登录后再试", true); return; }
    Object.assign(sub, { title });
    if (rows && rows[0]) Object.assign(sub, rows[0]);
    closeModal();
    renderAll();
    toast("子任务已更新");
  };
  bind("mRenSubSave", "click", save);
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) save(); });
}
/* ============ 沉淀：用户自主选择 ============
   任务的所有子任务都完成时，卡片整框变绿，并弹窗询问用户是否
   「纳入已沉淀任务」；同意才沉淀：出列表 / 分层 / 统计，
   月历打卡、专注记录、积分全部保留；可在任务列表底部的「已沉淀」区恢复或删除。 */
async function settleTask(taskId) {
  const t = tasks.find(x => x.id === taskId);
  if (!t || archivedTaskIds.has(taskId)) return false;
  const subs = taskSubs(taskId);
  if (!subs.length || !subs.every(s => s.done)) return false;
  const upd = await db(cloud.database.from("tasks").update({ archived: true }).eq("id", taskId).select());
  if (blocked(upd)) return false;
  archivedTaskIds.add(taskId);
  t.archived = true;
  archivedTasks = archivedTasks.filter(x => x.id !== taskId).concat([t]);
  tasks = tasks.filter(x => x.id !== taskId);
  subtasks = subtasks.filter(x => x.task_id !== taskId);
  const archSubIds = new Set(allSubtasks.filter(x => x.task_id === taskId).map(x => x.id));
  items = items.filter(i => !archSubIds.has(i.subtask_id));
  /* 月目标关联到被沉淀任务的话要解绑，否则刷新后既没标签也没有加减按钮 */
  for (const g of goals.filter(x => x.link_task_id === taskId)) {
    try { await db(cloud.database.from("monthly_goals").update({ link_task_id: null }).eq("id", g.id).select()); } catch (e) {}
    g.link_task_id = null;
  }
  renderAll();
  celebrate();
  toast("📦 「" + t.title + "」已纳入沉淀（月历与积分保留，可在任务列表底部找回）");
  return true;
}

async function offerSettle(taskId) {
  const t = tasks.find(x => x.id === taskId);
  if (!t || archivedTaskIds.has(taskId)) return;
  const subs = taskSubs(taskId);
  if (!subs.length || !subs.every(s => s.done)) return;
  const ok = await confirmDialog({
    title: "🎉 「" + t.title + "」全部完成！",
    desc: "要把这个任务纳入已沉淀任务吗？沉淀后会移出列表和统计，但月历打卡、专注时长、积分都保留，随时可以恢复。",
    okText: "📦 纳入已沉淀"
  });
  if (ok) {
    const done = await settleTask(taskId);
    if (done) sayCompanion("整个任务都完成啦！已经为你沉淀好 📦");
  } else {
    toast("已保留在列表，卡片变绿啦 ✓；想沉淀时点卡片右上角的 📦 即可");
  }
}

async function restoreTask(id) {
  const upd = await db(cloud.database.from("tasks").update({ archived: false }).eq("id", id).select());
  if (blocked(upd)) { toast("恢复失败：这条数据可能不属于当前账号，请重新登录后再试", true); return; }
  toast("任务已恢复");
  await loadAll();
  renderAll(); // loadAll 只刷新数据不重绘，必须补一次渲染卡片才会回来
}

/* 已沉淀任务的真实删除：任务、子任务、子子任务、专注记录一并清除；
   已获得的积分保留（那是用户实打实赚到的）。二次确认防误删。 */
async function hardDeleteTask(id) {
  const t = archivedTasks.find(x => x.id === id);
  if (!t) return;
  const ok = await confirmDialog({
    title: "彻底删除「" + t.title + "」？",
    desc: "将从数据库中彻底删除该任务：子任务、子子任务、专注记录都会一并清除，且不可恢复。已获得的积分仍然保留。",
    okText: "彻底删除"
  });
  if (!ok) return;
  try {
    await db(cloud.database.from("pomodoro_sessions").delete().eq("task_id", id).select());
    const subRows = allSubtasks.filter(x => x.task_id === id);
    for (const s of subRows) {
      try { await db(cloud.database.from("subtask_items").delete().eq("subtask_id", s.id).select()); } catch (e) {}
      try { await db(cloud.database.from("subtasks").delete().eq("id", s.id).select()); } catch (e) {}
    }
    const rows = await db(cloud.database.from("tasks").delete().eq("id", id).select());
    if (blocked(rows)) { toast("删除失败：这条数据可能不属于当前账号，请重新登录后再试", true); return; }
  } catch (e) {
    toast("删除失败，请稍后重试", true);
    return;
  }
  archivedTasks = archivedTasks.filter(x => x.id !== id);
  archivedTaskIds.delete(id);
  allSubtasks = allSubtasks.filter(x => x.task_id !== id);
  for (const g of goals.filter(x => x.link_task_id === id)) {
    try { await db(cloud.database.from("monthly_goals").update({ link_task_id: null }).eq("id", g.id).select()); } catch (e) {}
    g.link_task_id = null;
  }
  renderAll();
  toast("已彻底删除「" + t.title + "」，积分保留");
}

function settledSectionHtml() {
  if (cardsMode !== "all" || !archivedTasks.length) return "";
  const rows = archivedTasks.slice().sort((a, b) => b.id - a.id).map(t => {
    const cat = catOf(t);
    return '<div class="settled-row"><span class="cat-badge" title="' + cat.label + '">' + cat.icon + "</span>" +
      '<span class="settled-name">' + esc(t.title) + "</span>" +
      '<button class="btn ghost small" data-restore="' + t.id + '">恢复</button>' +
      '<button class="settled-del" data-delsettled="' + t.id + '" title="彻底删除该任务">🗑</button></div>';
  }).join("");
  return '<div class="settled-sec">' +
    '<button id="settledToggle" class="settled-toggle">📦 已沉淀任务（' + archivedTasks.length + "）</button>" +
    '<div id="settledList" class="settled-list hidden">' + rows +
    '<p class="settled-hint">沉淀的任务不占列表和统计，但月历打卡、专注时长、积分都还在；点「恢复」可以拿回来继续用，点「🗑」二次确认后彻底删除。</p></div></div>';
}

bind("modalOverlay", "click", (e) => {
  if (e.target === $id("modalOverlay")) closeModal();
});
bind("modalBox", "click", (e) => {
  if (e.target.closest("[data-close]")) closeModal();
});

/* ============ 悬浮球 ============ */
bind("pomoFloat", "click", () => {
  if (!timer) return;
  const sub = subtasks.find(s => s.id === timer.subtaskId);
  if (sub) openSubtaskModal(sub);
});

/* ============ 长线任务：手账式月历时间线 ============ */
/* 母任务（如：备考基金从业）+ 子任务（第一章、第二章……），每条都有起止日期，
   在右侧月历中以横条（甘特）铺出，像手账里的时间胶带。 */

function ltParents() {
  return longtermTasks.filter(x => !x.parent_id)
    .sort((a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : (a.sort_order || 0) - (b.sort_order || 0)));
}
function ltChildren(pid) {
  return longtermTasks.filter(x => x.parent_id === pid)
    .sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
}
function ltShiftMonth(delta) {
  const now = new Date();
  if (!ltView) ltView = { y: now.getFullYear(), m: now.getMonth() };
  const d = new Date(ltView.y, ltView.m + delta, 1);
  return { y: d.getFullYear(), m: d.getMonth() };
}
/* 任务时间线与本月的交集：[起日, 止日]；完全不在本月返回 null */
function ltSpan(t, y, m) {
  const sFull = ymd(t.start_date), eFull = ymd(t.end_date);
  if (!sFull || !eFull) return null;
  const pre = y + "-" + String(m + 1).padStart(2, "0");
  const sM = sFull.slice(0, 7), eM = eFull.slice(0, 7);
  if (eM < pre || sM > pre) return null;
  const dim = daysInMonth(y, m);
  let d1 = 1, d2 = dim;
  if (sM === pre) d1 = parseInt(sFull.slice(8, 10), 10);
  if (eM === pre) d2 = parseInt(eFull.slice(8, 10), 10);
  return [Math.max(1, d1), Math.min(dim, d2)];
}
function md(dateStr) { /* 2026-11-02 → 11/2 */
  const d = ymd(dateStr);
  return d ? parseInt(d.slice(5, 7), 10) + "/" + parseInt(d.slice(8, 10), 10) : "";
}

function renderLongterm() {
  if (!$id("ltCalGrid")) return; // 旧缓存 HTML：元素不存在时静默跳过
  renderLtCal();
  renderLtList();
}

function renderLtCal() {
  const now = new Date();
  if (!ltView) ltView = { y: now.getFullYear(), m: now.getMonth() };
  const { y, m } = ltView;
  $id("ltMonthLabel").textContent = y + " 年 " + (m + 1) + " 月";
  const dim = daysInMonth(y, m);
  const today = localDateStr(now);
  const monthPre = y + "-" + String(m + 1).padStart(2, "0") + "-";
  const firstDow = (new Date(y, m, 1).getDay() + 6) % 7; // 0=周一

  const dayCell = (d, hd) => {
    const wd = (firstDow + d - 1) % 7;
    const isToday = monthPre + String(d).padStart(2, "0") === today;
    return '<span class="lt-day' + (hd ? " hd" : "") + (wd >= 5 ? " wknd" : "") + (isToday ? " today" : "") + '">' + (hd ? d : "") + "</span>";
  };
  const trackCells = d => { let h = ""; for (let i = 1; i <= dim; i++) h += d ? dayCell(i, false) : '<span class="lt-day"></span>'; return h; };

  let html = '<div class="lt-row lt-head-row"><div class="lt-name"></div><div class="lt-track">';
  /* 甘特表头不按周几前置空格：1..dim 与下方任务行的格子一一对应，
     否则像 11 月这样开头空格多的月份，表头格数比任务行多、数字会被挤到重叠 */
  for (let d = 1; d <= dim; d++) html += dayCell(d, true);
  html += "</div></div>";

  const rows = [];
  for (const p of ltParents()) {
    rows.push({ t: p, isParent: true });
    for (const c of ltChildren(p.id)) rows.push({ t: c, isParent: false });
  }
  if (!rows.length) {
    html += '<div class="lt-empty">还没有长线任务。点上方「＋ 添加长线任务」，比如「备考基金从业」，再拆出第一章、第二章……每条都能设自己的时间线。</div>';
  }
  for (const r of rows) {
    const t = r.t;
    const span = ltSpan(t, y, m);
    html += '<div class="lt-row' + (r.isParent ? "" : " sub") + '">';
    html += '<div class="lt-name" title="' + esc(t.title) + '">' + esc(t.title) + "</div>";
    html += '<div class="lt-track">' + trackCells(false);
    if (span) {
      const [d1, d2] = span;
      const left = (d1 - 1) / dim * 100, w = (d2 - d1 + 1) / dim * 100;
      const cls = "lt-bar " + (r.isParent ? "bar-p" : "bar-c") + (t.done ? " bar-done" : "");
      html += '<span class="' + cls + '" style="left:' + left.toFixed(2) + "%;width:" + w.toFixed(2) + '%">' + (w >= 14 ? esc(t.title) : "") + "</span>";
    }
    if (monthPre === today.slice(0, 8)) {
      const d = parseInt(today.slice(8, 10), 10);
      html += '<span class="lt-today-line" style="left:' + ((d - 0.5) / dim * 100).toFixed(2) + '%"></span>';
    }
    html += "</div></div>";
  }
  $id("ltCalGrid").innerHTML = html;
}

function renderLtList() {
  const wrap = $id("ltList");
  if (!wrap) return;
  const parents = ltParents();
  if (!parents.length) { wrap.innerHTML = ""; return; }
  let html = "";
  for (const p of parents) {
    const kids = ltChildren(p.id);
    const doneN = kids.filter(k => k.done).length;
    html += '<div class="lt-card' + (p.done ? " done" : "") + '">';
    html += '<div class="lt-card-top">';
    html += '<span class="lt-title">' + esc(p.title) + "</span>";
    html += '<span class="lt-dates">' + md(p.start_date) + " - " + md(p.end_date) + "</span>";
    if (kids.length) html += '<span class="lt-prog">子任务 ' + doneN + "/" + kids.length + "</span>";
    html += "</div>";
    html += '<div class="lt-ops">';
    html += '<button class="btn ghost small" data-act="done" data-id="' + p.id + '">' + (p.done ? "↩ 恢复" : "✓ 完成") + "</button>";
    html += '<button class="btn ghost small" data-act="add" data-id="' + p.id + '">＋ 子任务</button>';
    html += '<button class="btn ghost small" data-act="edit" data-id="' + p.id + '">✎ 编辑</button>';
    html += '<button class="btn ghost small" data-act="del" data-id="' + p.id + '">🗑 删除</button>';
    html += "</div>";
    if (kids.length) {
      html += '<div class="lt-subs">';
      for (const k of kids) {
        html += '<div class="lt-sub-item' + (k.done ? " done" : "") + '">';
        html += '<button class="lt-icon-btn" data-act="done" data-id="' + k.id + '">' + (k.done ? "✅" : "⬜") + "</button>";
        html += '<span class="lt-sub-name">' + esc(k.title) + "</span>";
        html += '<span class="lt-sub-dates">' + md(k.start_date) + " - " + md(k.end_date) + "</span>";
        html += '<button class="lt-icon-btn" data-act="edit" data-id="' + k.id + '">✎</button>';
        html += '<button class="lt-icon-btn" data-act="del" data-id="' + k.id + '">🗑</button>';
        html += "</div>";
      }
      html += "</div>";
    }
    html += "</div>";
  }
  wrap.innerHTML = html;
}

/* 新建 / 编辑长线任务（母任务与子任务共用一张表单） */
function openLtModal(parentId, t) {
  const isChild = !!parentId && !t;
  const today = localDateStr(new Date());
  const defEnd = localDateStr(new Date(Date.now() + 26 * 86400000));
  openModal(
    "<h3>" + (t ? "编辑" : isChild ? "添加子任务" : "新建长线任务") + "</h3>" +
    '<label class="modal-label">名称' + (isChild ? "（如：第一章）" : "（如：备考基金从业）") + "</label>" +
    '<input id="mLtTitle" class="modal-input" maxlength="50" value="' + esc(t ? t.title : "") + '">' +
    '<label class="modal-label">开始日期</label>' +
    '<input id="mLtStart" type="date" class="modal-input" value="' + (t ? t.start_date : today) + '">' +
    '<label class="modal-label">结束日期</label>' +
    '<input id="mLtEnd" type="date" class="modal-input" value="' + (t ? t.end_date : defEnd) + '">' +
    '<div class="modal-actions">' +
    '<button class="btn ghost" data-close="1">取消</button>' +
    '<button class="btn primary" id="mLtSave">保存</button>' +
    "</div>"
  );
  bind("mLtSave", "click", async () => {
    const title = $id("mLtTitle").value.trim();
    const start = $id("mLtStart").value, end = $id("mLtEnd").value;
    if (!title) { toast("请输入名称", true); return; }
    if (!start || !end) { toast("请选择开始和结束日期", true); return; }
    if (end < start) { toast("结束日期不能早于开始日期", true); return; }
    const payload = { title, start_date: start, end_date: end };
    let rows;
    if (t) {
      rows = await db(cloud.database.from("longterm_tasks").update(payload).eq("id", t.id).select());
    } else {
      if (isChild) payload.parent_id = parentId;
      payload.sort_order = longtermTasks.filter(x => x.parent_id === parentId).length + 1;
      rows = await db(cloud.database.from("longterm_tasks").insert(payload).select());
    }
    if (rows && rows[0]) {
      const i = longtermTasks.findIndex(x => x.id === rows[0].id);
      if (i >= 0) longtermTasks[i] = rows[0]; else longtermTasks.push(rows[0]);
    }
    closeModal();
    renderLongterm();
  });
  $id("mLtTitle").focus();
}

/* 长线任务列表的事件委托（列表是 innerHTML 重画的，绑在容器上） */
const ltListEl = $id("ltList");
if (ltListEl) {
  ltListEl.addEventListener("click", async e => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const t = longtermTasks.find(x => x.id == btn.dataset.id);
    if (!t) return;
    const act = btn.dataset.act;
    if (act === "done") {
      const wasDone = t.done;
      const rows = await db(cloud.database.from("longterm_tasks").update({ done: !t.done }).eq("id", t.id).select());
      if (rows && rows[0]) {
        const i = longtermTasks.findIndex(x => x.id === rows[0].id);
        if (i >= 0) longtermTasks[i] = rows[0];
      }
      renderLongterm();
      if (!wasDone && rows && rows[0] && rows[0].done) {
        // 里程碑宝箱：子任务（章节）+20，母任务通关 +50
        if (t.parent_id) openChest("章节达成！", "「" + t.title + "」完成，宝箱已就位 📦 +20 积分", 20, "里程碑宝箱：" + t.title);
        else openChest("长线通关！", "「" + t.title + "」完整走完 🎉 +50 积分", 50, "长线通关宝箱：" + t.title);
      }
    } else if (act === "add") {
      openLtModal(t.id, null);
    } else if (act === "edit") {
      openLtModal(t.parent_id, t);
    } else if (act === "del") {
      const n = t.parent_id ? 0 : ltChildren(t.id).length;
      const ok = await confirmDialog({
        title: "删除「" + t.title + "」？",
        desc: n ? "下面挂的 " + n + " 个子任务会一起删除。" : "",
        okText: "删除",
      });
      if (!ok) return;
      await db(cloud.database.from("longterm_tasks").delete().eq("id", t.id));
      longtermTasks = longtermTasks.filter(x => x.id !== t.id && x.parent_id !== t.id);
      renderLongterm();
    }
  });
}

bind("addLtBtn", "click", () => openLtModal(null, null));
bind("ltPrevBtn", "click", () => { ltView = ltShiftMonth(-1); renderLongterm(); });
bind("ltNextBtn", "click", () => { ltView = ltShiftMonth(1); renderLongterm(); });
bind("ltTodayBtn", "click", () => { ltView = null; renderLongterm(); });

/* ============ 主题皮肤（C2）：挑战解锁 + ID 旁选择，已解锁永久保留 ============ */
let currentTheme = "default";
const THEMES = [
  { id: "default", name: "深空蓝", icon: "🌌", desc: "默认主题，永远随身", challenge: null },
  { id: "forest", name: "森林", icon: "🌲", desc: "累计专注满 5 小时解锁",
    challenge: { label: "累计专注时长", target: 300, unit: " 分钟", progress: () => Math.round(sessions.reduce((a, b) => a + (b.duration_seconds || 0), 0) / 60) } },
  { id: "starry", name: "星空", icon: "⭐", desc: "累计获得 500 积分解锁",
    challenge: { label: "累计获得积分", target: 500, unit: " 分", progress: () => pointsEarnedTotal() } },
  { id: "retro", name: "复古手账", icon: "📔", desc: "完成 1 个长线任务解锁",
    challenge: { label: "已完成长线任务", target: 1, unit: " 个", progress: () => longtermTasks.filter(x => !x.parent_id && x.done).length } },
];
function themeUnlocked(id) {
  const t = THEMES.find(x => x.id === id);
  if (!t) return false;
  if (!t.challenge) return true;
  return t.challenge.progress() >= t.challenge.target;
}
function applyTheme(id) {
  if (!document.body) return;
  document.body.classList.remove("theme-forest", "theme-starry", "theme-retro");
  if (id && id !== "default") document.body.classList.add("theme-" + id);
  currentTheme = id || "default";
}
async function saveTheme(id) {
  applyTheme(id);
  try {
    if (profileId) await db(cloud.database.from("user_profiles").update({ theme: id }).eq("id", profileId).select());
  } catch (e) { /* 本地已生效，写库失败不阻塞 */ }
  renderPointsChip();
  if (!$id("tab-points").classList.contains("hidden")) renderPoints();
}

function openSkinModal() {
  const rows = THEMES.map(t => {
    const unlocked = themeUnlocked(t.id);
    let foot;
    if (unlocked) {
      foot = currentTheme === t.id
        ? '<span class="skin-cur">✓ 使用中</span>'
        : '<button class="btn primary small" data-usetheme="' + t.id + '">使用</button>';
    } else {
      const p = Math.min(t.challenge.target, t.challenge.progress());
      const pct = Math.round(p / t.challenge.target * 100);
      foot = '<div class="skin-prog"><span>' + t.challenge.label + " " + p + " / " + t.challenge.target + t.challenge.unit + '</span><div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div></div>';
    }
    return '<div class="skin-card' + (unlocked ? "" : " skin-locked") + (currentTheme === t.id ? " skin-active" : "") + '">' +
      '<div class="skin-preview skin-prev-' + t.id + '"><span>' + t.icon + "</span></div>" +
      '<div class="skin-info"><b>' + t.name + "</b><small>" + t.desc + "</small>" + foot + "</div></div>";
  }).join("");
  openModal(
    "<h3>🎨 主题皮肤</h3>" +
    '<p style="color:var(--text-sub);font-size:13px;margin-top:-8px;margin-bottom:10px">解锁的主题永久保留；挑战进度也会同步显示在「积分奖励」页</p>' +
    '<div class="skin-grid">' + rows + "</div>"
  );
  document.querySelectorAll("[data-usetheme]").forEach(b => {
    b.addEventListener("click", async () => {
      await saveTheme(b.dataset.usetheme);
      closeModal();
      toast("已换上「" + (THEMES.find(x => x.id === b.dataset.usetheme) || {}).name + "」主题 ✨");
      sayCompanion("新皮肤很适合探险！");
    });
  });
}
bind("skinBtn", "click", openSkinModal);

function renderSkinChallenges() {
  const el = $id("skinChallenges");
  if (!el) return;
  el.innerHTML = THEMES.filter(t => t.challenge).map(t => {
    const p = Math.min(t.challenge.target, t.challenge.progress());
    const unlocked = p >= t.challenge.target;
    const pct = unlocked ? 100 : Math.round(p / t.challenge.target * 100);
    return '<div class="skin-challenge' + (unlocked ? " done" : "") + '">' +
      '<div class="skin-ch-top"><span class="skin-ch-name">' + t.icon + " " + t.name + "主题</span>" +
      (unlocked
        ? '<span class="skin-ch-done">✓ 已解锁</span>'
        : '<span class="skin-ch-num">' + p + " / " + t.challenge.target + t.challenge.unit + "</span>") + "</div>" +
      '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="skin-ch-desc">' + (unlocked ? "已永久解锁，点顶栏 🎨 换上吧" : t.desc) + "</div></div>";
  }).join("");
}

/* ============ 里程碑宝箱（C3）：长线任务每达成一段就开一次箱 ============ */
function openChest(head, desc, pts, reason) {
  openModal(
    "<h3>" + head + "</h3>" +
    '<div class="chest-wrap"><div class="chest-emoji" id="chestEmoji">📦</div>' +
    '<p class="chest-desc">' + esc(desc) + "</p>" +
    '<p class="chest-hint">里面有一份坚持的证明</p></div>' +
    '<div class="modal-actions"><button class="btn primary" id="chestOpen">开箱！</button></div>'
  );
  bind("chestOpen", "click", () => {
    const em = $id("chestEmoji");
    if (em) em.textContent = "🎉";
    const btn = $id("chestOpen");
    if (btn) btn.disabled = true;
    celebrate();
    awardPoints(pts, reason);
    sayCompanion("恭喜你！变得更棒啦！");
    setTimeout(closeModal, 1500);
  });
}

/* ============ 惊喜掉落（C4）：专注自然走完后小概率掉彩蛋，只掉不扣（变率强化） ============ */
function maybeDrop() {
  if (Math.random() >= 0.3) return;
  const pts = [5, 8, 10, 15][Math.floor(Math.random() * 4)];
  const icons = ["🎁", "🍀", "🎈", "🍬", "✨"];
  const icon = icons[Math.floor(Math.random() * icons.length)];
  try {
    const old = $id("dropWidget");
    if (old) old.remove();
    const el = document.createElement("div");
    el.id = "dropWidget";
    el.className = "drop-widget";
    el.innerHTML =
      '<div class="drop-icon">' + icon + '</div>' +
      '<div class="drop-body"><b>惊喜掉落！</b><small>运气不错，捡到了 ' + pts + " 积分</small></div>" +
      '<button class="btn primary small" id="dropTake">收下</button>';
    document.body.appendChild(el);
    bind("dropTake", "click", () => {
      el.remove();
      celebrate();
      awardPoints(pts, "惊喜掉落 " + icon);
    });
    setTimeout(() => { if ($id("dropWidget") === el) el.remove(); }, 15000);
  } catch (e) {}
}

/* ============ 伙伴引导：进入任务界面打招呼 / 完成后庆祝 ============ */
let companionEl = null, companionHideTimer = null, lastGuideAt = 0;
const GUIDE_LINES = ["开始探险吗？", "要不试试这个？"];
function sayCompanion(text, ms) {
  try {
    if (!companionEl || !document.body.contains(companionEl)) {
      const old = document.querySelector(".companion");
      if (old) old.remove();
      companionEl = document.createElement("div");
      companionEl.className = "companion";
      companionEl.innerHTML = '<div class="companion-face">🐣</div><div class="companion-bubble"></div>';
      document.body.appendChild(companionEl);
    }
    companionEl.querySelector(".companion-bubble").textContent = text;
    companionEl.classList.add("show");
    clearTimeout(companionHideTimer);
    companionHideTimer = setTimeout(() => { if (companionEl) companionEl.classList.remove("show"); }, ms || 4500);
  } catch (e) {}
}
function guideOnEnter() {
  const now = Date.now();
  if (now - lastGuideAt < 4 * 60 * 1000) return; // 4 分钟内不重复打扰
  lastGuideAt = now;
  sayCompanion(GUIDE_LINES[Math.floor(Math.random() * GUIDE_LINES.length)]);
}

/* ============ 启动 ============ */
function renderAll() {
  renderCards();
  renderStats();
  renderLongterm();
  renderPointsChip();
  if (!$id("layerView").classList.contains("hidden")) renderLayer();
  if (!$id("tab-layers").classList.contains("hidden")) renderLayers();
  if (!$id("tab-schedule").classList.contains("hidden")) renderSchedule();
  if (!$id("tab-points").classList.contains("hidden")) renderPoints();
  if (!$id("tab-month").classList.contains("hidden")) renderMonth();
  if (!$id("tab-money").classList.contains("hidden")) renderMoney();
}

boot();
