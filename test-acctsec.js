/* 账号安全（老账号自助设置/修改密码）回归测试
   覆盖：入口弹窗、双通道视图切换、短信发送（归一化/账号不存在映射）、
   验证码换 token、reset 设密码（phone_number 主、username 回退）、错误映射、
   旧密码修改通道（SDK resetPasswordForOld）三条错误分支 */
const { JSDOM } = require("C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/jsdom");
const fs = require("fs");

const ROOT = "C:/Users/Administrator/WorkBuddy/2026-10-29-14-52-27/";
const APP = fs.readFileSync(ROOT + "app.js", "utf-8");
const HTML = fs.readFileSync(ROOT + "index.html", "utf-8").replace(/<script[\s\S]*?<\/script>/g, "");

let passed = 0, failed = 0;
const check = (n, c) => { c ? (passed++, console.log("  ok  " + n)) : (failed++, console.log("FAIL  " + n)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeDb(tables) {
  const db = {};
  for (const k of Object.keys(tables || {})) db[k] = tables[k].map(r => Object.assign({}, r));
  let seq = 900;
  function rowsOf(table, filters) {
    let rows = (db[table] || []).slice();
    for (const [c, v] of filters) rows = rows.filter(r => String(r[c]) === String(v));
    return rows.map(r => Object.assign({}, r));
  }
  function query(table) {
    const q = {
      _filters: [],
      select() { return q; },
      order() { return q; },
      limit() { return q; },
      eq(col, val) { q._filters.push([col, val]); return q; },
      single() { return Promise.resolve({ data: rowsOf(table, q._filters)[0] || null, error: null }); },
      then(onF, onR) { return Promise.resolve({ data: rowsOf(table, q._filters), error: null }).then(onF, onR); },
      insert(obj) {
        let done = null;
        const run = () => {
          if (!done) {
            const row = Object.assign({ id: ++seq, created_at: new Date().toISOString() }, obj);
            (db[table] = db[table] || []).push(row);
            done = Promise.resolve({ data: [Object.assign({}, row)], error: null });
          }
          return done;
        };
        const builder = { select: () => builder, then(onF, onR) { return run().then(onF, onR); } };
        return builder;
      },
      update(patch) {
        return {
          eq(col, val) {
            const apply = () => {
              (db[table] || []).forEach(r => { if (String(r[col]) === String(val)) Object.assign(r, patch); });
              return { data: (db[table] || []).filter(r => String(r[col]) === String(val)).map(r => Object.assign({}, r)), error: null };
            };
            const builder = {
              select() { return Promise.resolve(apply()); },
              then(onF, onR) { return Promise.resolve(apply()).then(onF, onR); },
            };
            return builder;
          },
        };
      },
      delete() {
        return {
          eq(col, val) {
            const gone = (db[table] || []).filter(r => String(r[col]) === String(val)).map(r => Object.assign({}, r));
            db[table] = (db[table] || []).filter(r => String(r[col]) !== String(val));
            const builder = { select() { return Promise.resolve({ data: gone, error: null }); } };
            return builder;
          },
        };
      },
    };
    return q;
  }
  return { from: t => query(t), db };
}

const TABLES = {
  tasks: [], subtasks: [], pomodoro_sessions: [], subtask_items: [], points_ledger: [],
  rewards: [], monthly_goals: [], money_records: [], longterm_tasks: [],
  checkin_items: [], checkin_records: [], year_goals: [],
  user_profiles: [{ id: 1, user_code: "U123456" }],
};

/* fetch 桩：按 path 分发脚本化响应 */
function makeFetch(state) {
  return async (url, opts) => {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    state.fetches.push({ path, body });
    const key = state.nextKey || path;
    const script = state.responses[key] || state.responses[path];
    if (!script) return { ok: true, status: 200, json: async () => ({}) };
    if (script.responses && script.responses.length) {
      const one = script.responses.shift(); // 依次出队（用于 reset 回退场景）
      return { ok: one.ok !== false, status: one.status || (one.ok === false ? 400 : 200), json: async () => one.json };
    }
    return { ok: script.ok !== false, status: script.status || (script.ok === false ? 400 : 200), json: async () => script.json };
  };
}

function makeDom(authState, fetchState) {
  const dom = new JSDOM(HTML, { url: "https://localhost/", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  const db = makeDb(TABLES);
  const calls = { old: [] };
  w.WorkBuddyCloud = {
    createWorkBuddyCloud: () => ({
      auth: {
        async sendOtp() { return { data: { verificationId: "vid1", isExistingUser: true }, error: null }; },
        async verifyOtp() { authState.user = { id: "u1", name: "17301834189" }; return { data: { user: authState.user }, error: null }; },
        async signInWithPassword() { authState.user = { id: "u1", name: "17301834189" }; return { data: { user: authState.user }, error: null }; },
        async resetPasswordForOld(arg) {
          calls.old.push(arg);
          if (authState.oldError) return { data: null, error: authState.oldError };
          return { data: { user: { id: "u1" } }, error: null };
        },
        onAuthStateChange: () => {},
        async signOut() { authState.user = null; },
        async getUser() { return { data: { user: authState.user }, error: null }; },
        async getSession() { return { data: authState.user ? { session: { user: authState.user } } : null, error: null }; },
      },
      database: { from: t => db.from(t) },
      llm: {
        models: { list: async () => [{ id: "m-test", name: "测试模型" }] },
        chat: { completions: { create: async function* () { yield { choices: [{ delta: { content: "嗯。" } }] }; } } },
      },
    }),
  };
  if (fetchState) w.fetch = makeFetch(fetchState);
  const s = w.document.createElement("script");
  s.textContent = APP;
  w.document.body.appendChild(s);
  return { w, calls };
}

(async () => {
  console.log("--- A. 入口与视图切换 ---");
  {
    const { w } = makeDom({}, null);
    await sleep(120);
    w.document.getElementById("acctBtn").click();
    check("A1 点击 🔒 打开账号安全弹窗", !w.document.getElementById("modalOverlay").classList.contains("hidden"));
    check("A2 默认显示短信视图", !w.document.getElementById("acctSmsView").classList.contains("hidden")
      && w.document.getElementById("acctOldView").classList.contains("hidden"));
    w.document.getElementById("mAcctSwitchOld").click();
    check("A3 切到旧密码视图", w.document.getElementById("acctSmsView").classList.contains("hidden")
      && !w.document.getElementById("acctOldView").classList.contains("hidden"));
    w.document.getElementById("mAcctSwitchSms").click();
    check("A4 切回短信视图", !w.document.getElementById("acctSmsView").classList.contains("hidden"));
    w.document.getElementById("mConfirmCancel") ; // 无关，防止误判
  }

  console.log("--- B. 发送验证码 ---");
  {
    const state = { fetches: [], responses: { "/.cloud/auth/v1/verification": { json: { verification_id: "v-b-1" } } } };
    const { w } = makeDom({}, state);
    await sleep(120);
    w.document.getElementById("acctBtn").click();
    w.document.getElementById("mAcctPhone").value = "12345";
    w.document.getElementById("mAcctSend").click();
    await sleep(30);
    check("B1 非法手机号提示且未发请求", w.document.getElementById("mAcctError").textContent.includes("11 位") && state.fetches.length === 0);
    w.document.getElementById("mAcctPhone").value = "17301834189";
    w.document.getElementById("mAcctSend").click();
    await sleep(30);
    const f = state.fetches[0];
    check("B2 请求 verification 端点且手机号归一化 +86", !!f && f.path === "/.cloud/auth/v1/verification"
      && f.body.phone_number === "+86 17301834189");
    check("B3 usage 为 PASSWORD_RESET / target USER", f.body.usage === "PASSWORD_RESET" && f.body.target === "USER");
    check("B4 发送成功后按钮进入倒计时", w.document.getElementById("mAcctSend").disabled === true);
    // 账号不存在
    const st2 = { fetches: [], responses: { "/.cloud/auth/v1/verification": { ok: false, status: 400, json: { error: "failed_precondition", error_description: "账号不存在" } } } };
    const { w: w2 } = makeDom({}, st2);
    await sleep(120);
    w2.document.getElementById("acctBtn").click();
    w2.document.getElementById("mAcctPhone").value = "17301834189";
    w2.document.getElementById("mAcctSend").click();
    await sleep(30);
    check("B5 账号不存在 → 引导先注册", w2.document.getElementById("mAcctError").textContent.includes("注册"));
    check("B6 失败后按钮恢复可点", w2.document.getElementById("mAcctSend").disabled === false);
  }

  console.log("--- C. 设置密码（短信通道） ---");
  {
    // C1/C2 校验
    const state = { fetches: [], responses: {
      "/.cloud/auth/v1/verification": { json: { verification_id: "v-reset-1" } },
      "/.cloud/auth/v1/verification/verify": { json: { verification_token: "vt-reset-1" } },
    } };
    const { w } = makeDom({}, state);
    await sleep(120);
    w.document.getElementById("acctBtn").click();
    w.document.getElementById("mAcctSubmit").click();
    await sleep(30);
    check("C1 未发验证码直接提交 → 提示先获取验证码", w.document.getElementById("mAcctError").textContent.includes("获取"));
    // 走到成功路径
    w.document.getElementById("mAcctPhone").value = "17301834189";
    w.document.getElementById("mAcctSend").click();
    await sleep(30);
    w.document.getElementById("mAcctCode").value = "654321";
    w.document.getElementById("mAcctNewPwd").value = "abc12"; // 5 位
    w.document.getElementById("mAcctSubmit").click();
    await sleep(30);
    check("C2 密码少于 6 位被拦截", w.document.getElementById("mAcctError").textContent.includes("6 位") && state.fetches.length === 1);
    w.document.getElementById("mAcctNewPwd").value = "abcdef123";
    w.document.getElementById("mAcctSubmit").click();
    await sleep(60);
    check("C3 verify 请求带 verification_id 与验证码", state.fetches.some(x => x.path === "/.cloud/auth/v1/verification/verify"
      && x.body.verification_id === "v-reset-1" && x.body.verification_code === "654321"));
    const resetCall = state.fetches.find(x => x.path === "/.cloud/auth/v1/reset");
    check("C4 reset 用 phone_number 标识 + 新密码 + token", !!resetCall
      && resetCall.body.phone_number === "+86 17301834189"
      && resetCall.body.new_password === "abcdef123"
      && resetCall.body.verification_token === "vt-reset-1");
    check("C5 成功后弹窗关闭", w.document.getElementById("modalOverlay").classList.contains("hidden"));

    // C6 验证码错误映射
    const st2 = { fetches: [], responses: {
      "/.cloud/auth/v1/verification": { json: { verification_id: "v2" } },
      "/.cloud/auth/v1/verification/verify": { ok: false, status: 400, json: { error: "invalid_argument", error_description: "verification code mismatch" } },
    } };
    const { w: w2 } = makeDom({}, st2);
    await sleep(120);
    w2.document.getElementById("acctBtn").click();
    w2.document.getElementById("mAcctPhone").value = "17301834189";
    w2.document.getElementById("mAcctSend").click();
    await sleep(30);
    w2.document.getElementById("mAcctCode").value = "000000";
    w2.document.getElementById("mAcctNewPwd").value = "abcdef123";
    w2.document.getElementById("mAcctSubmit").click();
    await sleep(30);
    check("C6 验证码错误 → 明确提示", w2.document.getElementById("mAcctError").textContent.includes("验证码不正确"));

    // C7 reset 字段不认 → 回退 username 且成功
    const st3 = { fetches: [], responses: {
      "/.cloud/auth/v1/verification": { json: { verification_id: "v3" } },
      "/.cloud/auth/v1/verification/verify": { json: { verification_token: "vt3" } },
      "/.cloud/auth/v1/reset": { responses: [
        { ok: false, status: 400, json: { error: "invalid_argument", error_description: "invalid ResetPasswordRequest.Email: value is required" } },
        { ok: true, status: 200, json: {} },
      ] },
    } };
    const { w: w3 } = makeDom({}, st3);
    await sleep(120);
    w3.document.getElementById("acctBtn").click();
    w3.document.getElementById("mAcctPhone").value = "17301834189";
    w3.document.getElementById("mAcctSend").click();
    await sleep(30);
    w3.document.getElementById("mAcctCode").value = "111111";
    w3.document.getElementById("mAcctNewPwd").value = "abcdef123";
    w3.document.getElementById("mAcctSubmit").click();
    await sleep(60);
    const resets3 = st3.fetches.filter(x => x.path === "/.cloud/auth/v1/reset");
    check("C7 字段校验失败自动回退 username 标识", resets3.length === 2 && resets3[1].body.username === "+86 17301834189"
      && w3.document.getElementById("modalOverlay").classList.contains("hidden"));

    // C8 token 失效映射
    const st4 = { fetches: [], responses: {
      "/.cloud/auth/v1/verification": { json: { verification_id: "v4" } },
      "/.cloud/auth/v1/verification/verify": { json: { verification_token: "vt4" } },
      "/.cloud/auth/v1/reset": { ok: false, status: 400, json: { error: "invalid_grant", error_description: "verification token expired" } },
    } };
    const { w: w4 } = makeDom({}, st4);
    await sleep(120);
    w4.document.getElementById("acctBtn").click();
    w4.document.getElementById("mAcctPhone").value = "17301834189";
    w4.document.getElementById("mAcctSend").click();
    await sleep(30);
    w4.document.getElementById("mAcctCode").value = "222222";
    w4.document.getElementById("mAcctNewPwd").value = "abcdef123";
    w4.document.getElementById("mAcctSubmit").click();
    await sleep(60);
    check("C8 token 失效 → 提示重新获取验证码", w4.document.getElementById("mAcctError").textContent.includes("重新获取"));
  }

  console.log("--- D. 旧密码修改通道 ---");
  {
    const { w, calls } = makeDom({}, null);
    await sleep(120);
    w.document.getElementById("acctBtn").click();
    w.document.getElementById("mAcctSwitchOld").click();
    w.document.getElementById("mAcctNewPwd2").value = "abcdef123";
    w.document.getElementById("mAcctSubmitOld").click();
    await sleep(30);
    check("D1 空旧密码被拦截且未调 SDK", w.document.getElementById("mAcctError2").textContent.includes("旧密码") && calls.old.length === 0);
    w.document.getElementById("mAcctOldPwd").value = "old123";
    w.document.getElementById("mAcctSubmitOld").click();
    await sleep(30);
    check("D2 resetPasswordForOld 收到旧/新密码", calls.old.length === 1 && calls.old[0].oldPassword === "old123" && calls.old[0].newPassword === "abcdef123");
    check("D3 成功后弹窗关闭", w.document.getElementById("modalOverlay").classList.contains("hidden"));

    const d2 = makeDom({ oldError: { kind: "invalid-request", status: 400, message: "user password not set" } }, null);
    await sleep(120);
    d2.w.document.getElementById("acctBtn").click();
    d2.w.document.getElementById("mAcctSwitchOld").click();
    d2.w.document.getElementById("mAcctOldPwd").value = "x";
    d2.w.document.getElementById("mAcctNewPwd2").value = "abcdef123";
    d2.w.document.getElementById("mAcctSubmitOld").click();
    await sleep(30);
    check("D4 未设过密码 → 指引短信通道", d2.w.document.getElementById("mAcctError2").textContent.includes("短信"));

    const d3 = makeDom({ oldError: { kind: "invalid_grant", status: 400, message: "Invalid credentials" } }, null);
    await sleep(120);
    d3.w.document.getElementById("acctBtn").click();
    d3.w.document.getElementById("mAcctSwitchOld").click();
    d3.w.document.getElementById("mAcctOldPwd").value = "wrong";
    d3.w.document.getElementById("mAcctNewPwd2").value = "abcdef123";
    d3.w.document.getElementById("mAcctSubmitOld").click();
    await sleep(30);
    check("D5 旧密码错误 → 明确提示", d3.w.document.getElementById("mAcctError2").textContent === "旧密码不正确");
  }

  console.log("\n===== 结果 =====");
  console.log("通过 " + passed + " / 失败 " + failed);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("测试异常:", e); process.exit(1); });
