/* 集成冒烟测试：app.js + companion.js 一起加载
   验证 boot() 是否按账号身份打开/关闭「钟磬」入口，且主应用不报错 */
const { JSDOM } = require("C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/jsdom");
const fs = require("fs");

const ROOT = "C:/Users/Administrator/WorkBuddy/2026-10-29-14-52-27/";
const APP = fs.readFileSync(ROOT + "app.js", "utf-8");
const COMP = fs.readFileSync(ROOT + "companion.js", "utf-8");
const HTML = fs.readFileSync(ROOT + "index.html", "utf-8").replace(/<script[\s\S]*?<\/script>/g, "");

let passed = 0, failed = 0;
const check = (n, c) => { c ? (passed++, console.log("  ok  " + n)) : (failed++, console.log("FAIL  " + n)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function chainable(rows) {
  const q = {
    select() { return q; }, order() { return q; }, limit() { return q; }, eq() { return q; },
    gte() { return q; }, lte() { return q; }, in() { return q; }, neq() { return q; },
    single() { return Promise.resolve({ data: rows[0] || null, error: null }); },
    insert(o) { return Promise.resolve({ data: [Object.assign({ id: 1 }, o)], error: null }); },
    update(o) { return Promise.resolve({ data: [{ id: 1 }], error: null }); },
    delete() { return Promise.resolve({ data: [], error: null }); },
    then(res, rej) { return Promise.resolve({ data: rows, error: null }).then(res, rej); },
  };
  return q;
}

function makeDom(user) {
  const dom = new JSDOM(HTML, { url: "https://localhost/", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  w.WorkBuddyCloud = {
    createWorkBuddyCloud: () => ({
      auth: {
        getSession: async () => ({ data: { session: user ? { user } : null }, error: null }),
        getUser: async () => ({ data: { user }, error: null }),
        onAuthStateChange: () => {},
        signOut: async () => ({}),
        sendOtp: async () => ({ data: { verificationId: "v", isExistingUser: true }, error: null }),
        verifyOtp: async () => ({ data: { user }, error: null }),
      },
      database: { from: () => chainable([]) },
      llm: {
        models: { list: async () => [{ id: "m-test" }] },
        chat: { completions: { create: async function* () { yield { choices: [{ delta: { content: "嗯。" } }] }; } } },
      },
    }),
  };
  const a = w.document.createElement("script");
  a.textContent = COMP;
  w.document.body.appendChild(a);
  const b = w.document.createElement("script");
  b.textContent = APP;
  w.document.body.appendChild(b);
  return w;
}

(async () => {
  /* 本人登录 */
  {
    const w = makeDom({ id: "2115701435453677568", name: "17301834189", phone: null });
    await sleep(400);
    check("T1 本人登录后钟磬入口可见", !w.document.getElementById("tabBtnCompanion").classList.contains("hidden"));
    check("T2 主应用进入 appView", !w.document.getElementById("appView").classList.contains("hidden"));
    // 点击钟磬 tab
    w.document.getElementById("tabBtnCompanion").click();
    await sleep(50);
    check("T3 点击后陪伴版面显示", !w.document.getElementById("tab-companion").classList.contains("hidden"));
    check("T4 其他版面被隐藏", w.document.getElementById("tab-cards").classList.contains("hidden"));
    // 回到任务列表
    w.document.querySelector('.tab[data-tab="cards"]').click();
    await sleep(30);
    check("T5 可正常切回任务列表", !w.document.getElementById("tab-cards").classList.contains("hidden")
      && w.document.getElementById("tab-companion").classList.contains("hidden"));
  }

  /* 其他用户登录 */
  {
    const w = makeDom({ id: "2117101511677841408", name: "17521653391", phone: "+86 17521653391" });
    await sleep(400);
    check("T6 其他用户看不到钟磬入口", w.document.getElementById("tabBtnCompanion").classList.contains("hidden"));
    check("T7 其他用户主应用正常", !w.document.getElementById("appView").classList.contains("hidden"));
  }

  console.log("\n结果: " + passed + " 通过 / " + failed + " 失败");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
