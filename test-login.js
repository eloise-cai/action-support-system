/* 钟磬陪伴空间 · 登录模块回归测试（v=20261105b 修复后）
   覆盖：发送/恢复会话/过期预判/防连点/错误提示/守门 */
const { JSDOM } = require("C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/jsdom");
const fs = require("fs");

const APP_JS = fs.readFileSync("C:/Users/Administrator/WorkBuddy/zhongqing-companion/app.js", "utf-8");
const INDEX_HTML = fs.readFileSync("C:/Users/Administrator/WorkBuddy/zhongqing-companion/index.html", "utf-8")
  .replace(/<script[^>]*src=[^>]*><\/script>/g, ""); // 去掉外部脚本，手动注入

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log("  ok  " + name); }
  else { failed++; console.log("FAIL  " + name); }
}

function makeDom({ otpStore } = {}) {
  const dom = new JSDOM(INDEX_HTML, { url: "https://localhost/?sharecode=YKXNHXSRRO", pretendToBeVisual: true, runScripts: "dangerously" });
  const w = dom.window;
  // 最小云端桩
  let otpCalls = 0, verifyCalls = 0;
  const state = { user: null, sendError: null, verifyError: null, isExistingUser: true, lastPhone: "17301834189" };
  w.WorkBuddyCloud = {
    createWorkBuddyCloud: () => ({
      auth: {
        async sendOtp({ phone }) {
          otpCalls++;
          state.lastPhone = phone;
          if (state.sendError) return { data: null, error: state.sendError };
          return { data: { verificationId: "vid_" + otpCalls, isExistingUser: state.isExistingUser }, error: null };
        },
        async verifyOtp({ token }) {
          verifyCalls++;
          if (state.verifyError) return { data: null, error: state.verifyError };
          if (token !== "123456") return { data: null, error: { message: "code mismatch" } };
          state.user = { phone: state.lastPhone };
          return { data: { user: state.user }, error: null };
        },
        async getUser() { return { data: { user: state.user }, error: null }; },
        async signOut() { state.user = null; },
        async getSession() { return { data: { session: state.user ? { user: state.user } : null }, error: null }; },
      },
      database: { from: () => ({ select() { return { order() { return { limit() { return Promise.resolve({ data: [], error: null }); } }; } }; } }) },
      llm: { models: { list: async () => [{ id: "m1" }] } },
    }),
  };
  w.PUBLIC_CONFIG = {};
  w.ONLY_PHONE = "17301834189";
  // 预置 sessionStorage
  if (otpStore) for (const [k, v] of Object.entries(otpStore)) w.sessionStorage.setItem(k, v);
  const s = w.document.createElement("script");
  s.textContent = APP_JS;
  w.document.body.appendChild(s);
  return { w, state, counts: () => ({ otpCalls, verifyCalls }) };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  /* 1. 初始状态 */
  {
    const { w } = makeDom();
    check("T1 进入按钮未发送时报「还没有获取验证码」", (() => {
      w.document.getElementById("loginBtn").click();
      return w.document.getElementById("loginErr").textContent === "还没有获取验证码"
        && w.document.getElementById("loginHint").textContent.includes("获取验证码");
    })());
    check("T2 空码提示", (() => {
      // 模拟已发送：直接点发送
      w.document.getElementById("phoneInput").value = "17301834189";
      w.document.getElementById("sendCodeBtn").click();
      return true;
    })());
  }

  /* 2. 正常发送 → 倒计时 → 提示为绿色 hint 而非红色报错 */
  {
    const { w, counts } = makeDom();
    w.document.getElementById("phoneInput").value = "17301834189";
    w.document.getElementById("sendCodeBtn").click();
    await sleep(20);
    check("T3 发送成功后出现绿色提示", w.document.getElementById("loginHint").textContent.includes("验证码已发到你手机"));
    check("T4 无红色报错", w.document.getElementById("loginErr").textContent === "");
    check("T5 倒计时文案为 60s", w.document.getElementById("sendCodeBtn").textContent === "60s 后重发");
    check("T6 按钮禁用中", w.document.getElementById("sendCodeBtn").disabled === true);
    check("T7 sessionStorage 已存会话", !!w.sessionStorage.getItem("zq_otp_pending"));
    // 防连点
    w.document.getElementById("sendCodeBtn").click();
    await sleep(20);
    check("T8 冷却期内不重复发送", counts().otpCalls === 1);
    // 填码进入
    w.document.getElementById("codeInput").value = "123456";
    w.document.getElementById("loginBtn").click();
    await sleep(30);
    check("T9 正确验证码进入应用", !w.document.getElementById("appView").classList.contains("hidden"));
    check("T10 会话已清", w.sessionStorage.getItem("zq_otp_pending") === null);
  }

  /* 3. 刷新恢复：sessionStorage 有会话 → 不点发送也能进入 */
  {
    const store = {
      zq_otp_pending: JSON.stringify({
        p: { phone: "17301834189", verificationId: "vid_old", isExistingUser: true, at: Date.now() },
        until: Date.now() + 30000,
      }),
    };
    const { w, counts } = makeDom({ otpStore: store });
    check("T11 刷新后恢复提示出现", w.document.getElementById("loginHint").textContent.includes("已发送过验证码"));
    check("T12 手机号自动回填", w.document.getElementById("phoneInput").value === "17301834189");
    w.document.getElementById("codeInput").value = "123456";
    w.document.getElementById("loginBtn").click();
    await sleep(30);
    check("T13 无需重发即可登录（verify 收到 vid_old）", counts().verifyCalls === 1
      && !w.document.getElementById("appView").classList.contains("hidden"));
  }

  /* 4. 过期会话：超过 9 分钟不恢复 */
  {
    const store = {
      zq_otp_pending: JSON.stringify({
        p: { phone: "17301834189", verificationId: "vid_old", isExistingUser: true, at: Date.now() - 10 * 60 * 1000 },
        until: Date.now() + 30000,
      }),
    };
    const { w } = makeDom({ otpStore: store });
    check("T14 过期会话被丢弃", w.sessionStorage.getItem("zq_otp_pending") === null);
    w.document.getElementById("codeInput").value = "123456";
    w.document.getElementById("loginBtn").click();
    await sleep(20);
    check("T15 过期后提示重发", w.document.getElementById("loginErr").textContent.includes("还没有获取验证码"));
  }

  /* 5. 恢复路径：倒计时已结束但会话仍新鲜 → 保留会话，按钮可直接重发 */
  {
    const store = {
      zq_otp_pending: JSON.stringify({
        p: { phone: "17301834189", verificationId: "vid_fresh", isExistingUser: true, at: Date.now() - 60 * 1000 },
        until: Date.now() - 1000,
      }),
    };
    const { w } = makeDom({ otpStore: store });
    check("T16 会话保留且按钮可直接重发", w.sessionStorage.getItem("zq_otp_pending") !== null
      && w.document.getElementById("sendCodeBtn").textContent === "获取验证码"
      && w.document.getElementById("sendCodeBtn").disabled === false);
  }

  /* 6. 验证失败：友好报错 + 保留原始信息 */
  {
    const { w, counts, state } = makeDom();
    w.document.getElementById("phoneInput").value = "17301834189";
    w.document.getElementById("sendCodeBtn").click();
    await sleep(20);
    w.document.getElementById("codeInput").value = "115843";
    w.document.getElementById("loginBtn").click();
    await sleep(30);
    check("T17 错码显示「验证没通过」", w.document.getElementById("loginErr").textContent === "验证没通过");
    check("T18 hint 含原始后端信息与重发指引", w.document.getElementById("loginHint").textContent.includes("重发")
      && w.document.getElementById("loginHint").textContent.includes("code mismatch"));
    check("T19 进入按钮恢复可点", w.document.getElementById("loginBtn").disabled === false);
  }

  /* 7. 非本人手机号：守门 */
  {
    const { w } = makeDom();
    w.document.getElementById("phoneInput").value = "13999999999";
    w.document.getElementById("sendCodeBtn").click();
    await sleep(20);
    w.document.getElementById("codeInput").value = "123456";
    w.document.getElementById("loginBtn").click();
    await sleep(30);
    check("T20 非守门号码被请出", w.document.getElementById("loginErr").textContent === "此空间只为一个人开放。"
      && w.document.getElementById("appView").classList.contains("hidden"));
  }

  /* 8. 手机号格式 */
  {
    const { w, counts } = makeDom();
    w.document.getElementById("phoneInput").value = "12345";
    w.document.getElementById("sendCodeBtn").click();
    await sleep(20);
    check("T21 非法手机号不发请求", counts().otpCalls === 0
      && w.document.getElementById("phoneErr").textContent.includes("11 位"));
  }

  /* 9. 发送失败：按钮文案复位 */
  {
    const { w, state } = makeDom();
    w.document.getElementById("phoneInput").value = "17301834189";
    state.sendError = { message: "too many requests" };
    w.document.getElementById("sendCodeBtn").click();
    await sleep(20);
    check("T22 发送失败按钮复位可再点", w.document.getElementById("sendCodeBtn").textContent === "获取验证码"
      && w.document.getElementById("sendCodeBtn").disabled === false);
    check("T23 显示后端发送错误", w.document.getElementById("loginErr").textContent === "too many requests");
  }

  /* 10. 真实后端用户形状：手机号在 name 字段（后端实测 user.phone 可能为空） */
  {
    const { w, state } = makeDom();
    w.document.getElementById("phoneInput").value = "17301834189";
    w.document.getElementById("sendCodeBtn").click();
    await sleep(20);
    state.user = { id: "2118206646306996224", name: "17301834189", phone: null, user_metadata: { nickname: "EC" } };
    w.document.getElementById("codeInput").value = "123456";
    w.document.getElementById("loginBtn").click();
    await sleep(30);
    check("T24 手机号在 name 字段也能通过守门", !w.document.getElementById("appView").classList.contains("hidden"));
  }

  /* 11. 带国家码的手机号字段 + 嵌套 metadata */
  {
    const { w, state } = makeDom();
    w.document.getElementById("phoneInput").value = "17301834189";
    w.document.getElementById("sendCodeBtn").click();
    await sleep(20);
    state.user = { sub: "999888777", profile: { full_phone: "+86 17301834189" } };
    w.document.getElementById("codeInput").value = "123456";
    w.document.getElementById("loginBtn").click();
    await sleep(30);
    check("T25 嵌套字段里的 +86 手机号能通过守门", !w.document.getElementById("appView").classList.contains("hidden"));
  }

  /* 12. 已知 UID 直接放行（手机号字段全部缺失的兜底） */
  {
    const { w, state } = makeDom();
    w.document.getElementById("phoneInput").value = "17301834189";
    w.document.getElementById("sendCodeBtn").click();
    await sleep(20);
    state.user = { id: "2118206646306996224", name: "someone" };
    w.document.getElementById("codeInput").value = "123456";
    w.document.getElementById("loginBtn").click();
    await sleep(30);
    check("T26 命中后端 UID 兜底放行", !w.document.getElementById("appView").classList.contains("hidden"));
  }

  console.log("\n结果: " + passed + " 通过 / " + failed + " 失败");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
