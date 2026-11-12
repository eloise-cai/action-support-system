/* 情绪急救包新玩法回归测试：电子木鱼 + 赛博算卦
   - 急救包列表新增两个条目（muyu / divine）
   - 木鱼：点木鱼或按 Enter 敲一下，+1 功德；弹窗关闭后 Enter 监听移除
   - 算卦：按 Enter 求签，出签文+解曰；可反复再抽
   - Enter 不应被输入框/按钮焦点劫持（INPUT/TEXTAREA/SELECT/BUTTON 忽略） */
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
  const calls = { inserts: [], updates: [], deletes: [] };
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
            calls.inserts.push({ table, obj });
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
              calls.updates.push({ table, patch, col, val });
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
            calls.deletes.push({ table, col, val });
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
  return { from: t => query(t), db, calls };
}

function makeDom(extra) {
  const dom = new JSDOM(HTML, { url: "https://localhost/", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  const db = makeDb(Object.assign({
    tasks: [], subtasks: [], subtask_items: [], pomodoro_sessions: [], points_ledger: [], rewards: [],
    monthly_goals: [], money_records: [], longterm_tasks: [], checkin_items: [], checkin_records: [],
    year_goals: [], user_profiles: [{ id: 1, user_code: "U123456" }],
    worry_notes: [], belief_reviews: [], abc_records: [],
  }, extra || {}));
  w.WorkBuddyCloud = {
    createWorkBuddyCloud: () => ({
      auth: {
        getSession: async () => ({ data: { session: { user: { id: "u1", name: "17301834189" } } }, error: null }),
        getUser: async () => ({ data: { user: { id: "u1", name: "17301834189" } }, error: null }),
        onAuthStateChange: () => {},
        signOut: async () => ({}),
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
  return { w, db };
}

function gotoMind(w, key) {
  const btn = [...w.document.querySelectorAll(".mind-sub")].find(b => b.dataset.mind === key);
  btn.click();
}
function pressEnter(w, target) {
  const ev = new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  (target || w.document.body).dispatchEvent(ev);
  return ev.defaultPrevented;
}
const modalOpen = w => !w.document.getElementById("modalOverlay").classList.contains("hidden");

(async () => {
  console.log("== A 组：急救包列表条目 ==");
  { const { w } = makeDom(); await sleep(60);
    const fa = w.eval("FIRST_AID");
    check("A1 FIRST_AID 共 10 条", Array.isArray(fa) && fa.length === 10);
    check("A2 第 9 条是电子木鱼(muyu)", fa[8] && fa[8].muyu === true && fa[8].title.includes("电子木鱼"));
    check("A3 第 10 条是赛博算卦(divine)", fa[9] && fa[9].divine === true && fa[9].title.includes("赛博算卦"));
    check("A4 两条 desc 都提示按 Enter", fa[8].desc.includes("Enter") && fa[9].desc.includes("Enter"));
  }

  console.log("== B 组：电子木鱼 ==");
  { const { w } = makeDom(); await sleep(60);
    gotoMind(w, "aid"); await sleep(30);
    const grid = w.document.getElementById("aidGrid");
    check("B1 急救包渲染出 10 个条目", grid.querySelectorAll("[data-aid]").length === 10);
    grid.querySelector('[data-aid="8"]').click(); await sleep(20);
    check("B2 弹窗打开且是木鱼面板", modalOpen(w) && !!w.document.getElementById("muyuBtn"));
    check("B3 木鱼面板没有步骤列表", !w.document.querySelector("#modalBox .aid-steps"));
    const cnt = () => w.document.getElementById("muyuCount").textContent;
    check("B4 初始功德 0", cnt() === "今日功德：0");
    w.document.getElementById("muyuBtn").click(); await sleep(10);
    check("B5 点木鱼 +1", cnt() === "今日功德：1");
    const float = w.document.querySelector("#muyuStage .muyu-float");
    check("B6 出现飘字动画元素", !!float);
    check("B6b 木鱼是 SVG 图形而非 emoji", !!w.document.querySelector("#muyuBtn svg") && !!w.document.querySelector("#muyuBtn svg #muyuWood"));
    check("B6c 敲击出现涟漪环元素", !!w.document.querySelector("#muyuStage .muyu-ring"));
    const prevented = pressEnter(w);
    check("B7 按 Enter 敲木鱼 → 功德 2", cnt() === "今日功德：2");
    check("B8 Enter 默认行为被阻止", prevented === true);
    // 焦点在按钮上时 Enter 不重复触发（防双敲）
    const btn = w.document.querySelector('#modalBox [data-close="1"]');
    btn.focus && btn.focus();
    pressEnter(w, btn);
    check("B9 焦点在按钮上按 Enter 不敲木鱼", cnt() === "今日功德：2");
    // 关弹窗后监听应移除
    btn.click(); await sleep(20);
    check("B10 弹窗已关闭", !modalOpen(w));
    let leaked = false;
    try { pressEnter(w); } catch (e) { leaked = true; }
    check("B11 关弹窗后按 Enter 无残留监听（面板已卸载且不报错）", !leaked && !w.document.getElementById("muyuCount"));
  }

  console.log("== C 组：赛博算卦 ==");
  { const { w } = makeDom(); await sleep(60);
    gotoMind(w, "aid"); await sleep(30);
    w.document.getElementById("aidGrid").querySelector('[data-aid="9"]').click(); await sleep(20);
    check("C1 弹窗打开且是求签面板", modalOpen(w) && !!w.document.getElementById("divineBtn"));
    const empty = w.document.getElementById("divineEmpty");
    const res = w.document.getElementById("divineResult");
    check("C2 初始显示「心诚则灵」占位", empty && !empty.classList.contains("hidden") && res.classList.contains("hidden"));
    pressEnter(w); await sleep(10);
    check("C3 按 Enter 出签", !res.classList.contains("hidden"));
    check("C4 签文含签级+解曰", res.textContent.includes("签") && res.textContent.includes("解曰"));
    const first = res.innerHTML;
    pressEnter(w); await sleep(10);
    check("C5 可反复再抽（内容更新）", res.innerHTML.length > 0);
    check("C6 占位已隐藏", empty.classList.contains("hidden"));
    // 关弹窗再开别的，Enter 不再触发抽签
    w.document.querySelector('#modalBox [data-close="1"]').click(); await sleep(20);
    pressEnter(w); await sleep(10);
    check("C7 关弹窗后 Enter 不再抽签", !modalOpen(w));
    void first;
  }

  console.log("== D 组：原有急救包条目不受影响 ==");
  { const { w } = makeDom(); await sleep(60);
    gotoMind(w, "aid"); await sleep(30);
    const grid = w.document.getElementById("aidGrid");
    grid.querySelector('[data-aid="0"]').click(); await sleep(20);
    check("D1 冲动冲浪弹窗正常", modalOpen(w) && !!w.document.getElementById("urgeTime"));
    w.document.querySelector('#modalBox [data-close="1"]').click(); await sleep(20);
    grid.querySelector('[data-aid="2"]').click(); await sleep(20);
    check("D2 盒式呼吸弹窗正常", modalOpen(w) && !!w.document.getElementById("breathBox"));
    // 呼吸条目也无步骤冲突：普通条目仍有步骤列表
    check("D3 普通条目仍有步骤列表", !!w.document.querySelector("#modalBox .aid-steps"));
    w.document.querySelector('#modalBox [data-close="1"]').click(); await sleep(20);
    grid.querySelector('[data-aid="8"]').click(); await sleep(20);
    check("D4 木鱼弹窗再次打开正常", modalOpen(w) && !!w.document.getElementById("muyuBtn"));
  }

  console.log("\n通过 " + passed + " / 失败 " + failed);
  process.exit(failed ? 1 : 0);
})();
