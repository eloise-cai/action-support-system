/* 登录双模式回归测试：短信验证码 / 手机号密码
   覆盖：Tab 切换、密码登录成功与错误分支（未设密码/凭证错误）、
   新用户注册可选设置密码（传给 verifyOtp）、老用户不出现密码框 */
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

function makeDom(authState) {
  const dom = new JSDOM(HTML, { url: "https://localhost/", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  const db = makeDb(TABLES);
  const calls = { pwd: [], otp: [], verify: [] };
  w.WorkBuddyCloud = {
    createWorkBuddyCloud: () => ({
      auth: {
        async sendOtp({ phone }) {
          calls.otp.push({ phone });
          if (authState.sendError) return { data: null, error: authState.sendError };
          return { data: { verificationId: "vid1", isExistingUser: !!authState.isExistingUser }, error: null };
        },
        async verifyOtp(arg) {
          calls.verify.push(arg);
          if (authState.verifyError) return { data: null, error: authState.verifyError };
          if (arg.token !== "123456") return { data: null, error: { message: "code mismatch" } };
          authState.user = { id: "u1", name: "17301834189" };
          return { data: { user: authState.user }, error: null };
        },
        async signInWithPassword(arg) {
          calls.pwd.push(arg);
          if (authState.pwdError) return { data: null, error: authState.pwdError };
          authState.user = { id: "u1", name: "17301834189" };
          return { data: { user: authState.user }, error: null };
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
  const s = w.document.createElement("script");
  s.textContent = APP;
  w.document.body.appendChild(s);
  return { w, calls };
}

(async () => {
  console.log("--- A. Tab 切换 ---");
  {
    const { w } = makeDom({ isExistingUser: true });
    await sleep(120);
    check("A1 默认验证码模式：密码框隐藏", $id => 0 || w.document.getElementById("pwdRows").classList.contains("hidden"));
    check("A2 默认按钮文案为 登录 / 注册", w.document.getElementById("loginBtn").textContent === "登录 / 注册");
    w.document.getElementById("tabPwd").click();
    check("A3 切到密码登录：密码框显示", !w.document.getElementById("pwdRows").classList.contains("hidden"));
    check("A4 验证码行隐藏", w.document.getElementById("otpRows").classList.contains("hidden"));
    check("A5 按钮文案改为 登录", w.document.getElementById("loginBtn").textContent === "登录");
    w.document.getElementById("tabOtp").click();
    check("A6 切回验证码模式", !w.document.getElementById("otpRows").classList.contains("hidden")
      && w.document.getElementById("pwdRows").classList.contains("hidden"));
  }

  console.log("--- B. 密码登录：校验与错误分支 ---");
  {
    const { w, calls } = makeDom({ isExistingUser: true });
    await sleep(120);
    w.document.getElementById("tabPwd").click();
    w.document.getElementById("phoneInput").value = "12345";
    w.document.getElementById("loginBtn").click();
    await sleep(30);
    check("B1 手机号非法提示且未调 SDK", w.document.getElementById("phoneError").textContent.includes("11 位")
      && calls.pwd.length === 0);
    w.document.getElementById("phoneInput").value = "17301834189";
    w.document.getElementById("loginBtn").click();
    await sleep(30);
    check("B2 空密码提示", w.document.getElementById("loginError").textContent === "请输入密码" && calls.pwd.length === 0);
    // 未设密码
    w.document.getElementById("pwdInput").value = "abc123";
    makeDomNothing: ;
    const dom2 = makeDom({ isExistingUser: true, pwdError: { kind: "invalid-request", status: 400, message: "user password not set" } });
    const w2 = dom2.w, calls2 = dom2.calls;
    await sleep(120);
    w2.document.getElementById("tabPwd").click();
    w2.document.getElementById("phoneInput").value = "17301834189";
    w2.document.getElementById("pwdInput").value = "abc123";
    w2.document.getElementById("loginBtn").click();
    await sleep(30);
    check("B3 未设密码 → 指引切回验证码登录", w2.document.getElementById("loginError").textContent.includes("验证码登录"));
    check("B4 未设密码时不进入应用", w2.document.getElementById("appView").classList.contains("hidden"));
    // 凭证错误
    const { w: w3, calls: calls3 } = makeDom({ isExistingUser: true, pwdError: { kind: "invalid_grant", status: 400, message: "Invalid credentials" } });
    await sleep(120);
    w3.document.getElementById("tabPwd").click();
    w3.document.getElementById("phoneInput").value = "17301834189";
    w3.document.getElementById("pwdInput").value = "badpass";
    w3.document.getElementById("loginBtn").click();
    await sleep(30);
    check("B5 密码错误 → 手机号或密码错误", w3.document.getElementById("loginError").textContent === "手机号或密码错误");
    check("B6 signInWithPassword 收到手机号和密码", calls3.pwd.length === 1 && calls3.pwd[0].phone === "17301834189" && calls3.pwd[0].password === "badpass");
  }

  console.log("--- C. 密码登录成功 ---");
  {
    const { w, calls } = makeDom({ isExistingUser: true });
    await sleep(120);
    w.document.getElementById("tabPwd").click();
    w.document.getElementById("phoneInput").value = "17301834189";
    w.document.getElementById("pwdInput").value = "correct-pass";
    w.document.getElementById("loginBtn").click();
    await sleep(120);
    check("C1 密码正确进入应用", !w.document.getElementById("appView").classList.contains("hidden"));
    check("C2 调用参数正确", calls.pwd.length === 1 && calls.pwd[0].password === "correct-pass");
    check("C3 登录页隐藏", w.document.getElementById("loginView").classList.contains("hidden"));
  }

  console.log("--- D. 验证码注册（新用户）可选设置密码 ---");
  {
    // 新用户 + 设置密码
    const { w, calls } = makeDom({ isExistingUser: false });
    await sleep(120);
    w.document.getElementById("phoneInput").value = "13911112222";
    w.document.getElementById("sendCodeBtn").click();
    await sleep(30);
    check("D1 新用户显示设置密码框", !w.document.getElementById("signupPwdRow").classList.contains("hidden"));
    w.document.getElementById("signupPwdInput").value = "abc123";
    w.document.getElementById("codeInput").value = "123456";
    w.document.getElementById("loginBtn").click();
    await sleep(120);
    check("D2 verifyOtp 收到设置的密码", calls.verify.length === 1 && calls.verify[0].password === "abc123");
    check("D3 注册成功进入应用", !w.document.getElementById("appView").classList.contains("hidden"));
  }
  {
    // 新用户不设密码
    const { w, calls } = makeDom({ isExistingUser: false });
    await sleep(120);
    w.document.getElementById("phoneInput").value = "13911113333";
    w.document.getElementById("sendCodeBtn").click();
    await sleep(30);
    w.document.getElementById("codeInput").value = "123456";
    w.document.getElementById("loginBtn").click();
    await sleep(120);
    check("D4 不填密码也能注册", calls.verify.length === 1 && calls.verify[0].password === undefined);
  }
  {
    // 新用户密码过短
    const { w, calls } = makeDom({ isExistingUser: false });
    await sleep(120);
    w.document.getElementById("phoneInput").value = "13911114444";
    w.document.getElementById("sendCodeBtn").click();
    await sleep(30);
    w.document.getElementById("signupPwdInput").value = "123";
    w.document.getElementById("codeInput").value = "123456";
    w.document.getElementById("loginBtn").click();
    await sleep(50);
    check("D6 密码少于 6 位提示且不发验证", w.document.getElementById("loginError").textContent.includes("6 位") && calls.verify.length === 0);
    check("D7 仍停留在登录页", w.document.getElementById("appView").classList.contains("hidden"));
  }
  {
    // 老用户：不出现密码框
    const { w, calls } = makeDom({ isExistingUser: true });
    await sleep(120);
    w.document.getElementById("phoneInput").value = "17301834189";
    w.document.getElementById("sendCodeBtn").click();
    await sleep(30);
    check("D8 老用户不显示设置密码框", w.document.getElementById("signupPwdRow").classList.contains("hidden"));
    w.document.getElementById("codeInput").value = "123456";
    w.document.getElementById("loginBtn").click();
    await sleep(120);
    check("D9 老用户 verifyOtp 不带密码", calls.verify.length === 1 && calls.verify[0].password === undefined);
  }

  console.log("\n结果: " + passed + " 通过 / " + failed + " 失败");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("测试崩溃:", e); process.exit(1); });
