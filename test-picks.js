/* 自选今日三件事 / 暂时不想做 / 任务排序 / 额外积分+烟花 回归测试
   覆盖：默认推荐、自选弹窗与落库、交回自动推荐、卡片加成标签、收起/取出、排序、
   今日三件事加成与取消扣回、取回后双倍、收起任务不参与推荐 */
const { JSDOM } = require("C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/jsdom");
const fs = require("fs");

const ROOT = "C:/Users/Administrator/WorkBuddy/2026-10-29-14-52-27/";
const APP = fs.readFileSync(ROOT + "app.js", "utf-8");
const HTML = fs.readFileSync(ROOT + "index.html", "utf-8").replace(/<script[\s\S]*?<\/script>/g, "");

let passed = 0, failed = 0;
const check = (n, c) => { c ? (passed++, console.log("  ok  " + n)) : (failed++, console.log("FAIL  " + n)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const today = (() => {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
})();

/* 忠实一点的桩：查询构造器是懒执行 thenable（只有 then），select/order/eq 链最后被 await 时才对内存表求值 */
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
            db[table] = (db[table] || []).filter(r => String(r[col]) !== String(val));
            const builder = { select() { return Promise.resolve({ data: [], error: null }); } };
            return builder;
          },
        };
      },
    };
    return q;
  }
  return { from: t => query(t), db, calls };
}

const TASKS = [
  { id: 1, title: "考研数学", level: "high", category: "study", sort_order: 1 },
  { id: 2, title: "英语", level: "mid", category: "study", sort_order: 2 },
];
const SUBS = [
  { id: 11, task_id: 1, title: "线代第一章" },
  { id: 12, task_id: 1, title: "概率第二章" },
  { id: 13, task_id: 2, title: "阅读真题" },
  { id: 14, task_id: 2, title: "写作模板" },
];

function makeDom(extra) {
  const dom = new JSDOM(HTML, { url: "https://localhost/", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  const db = makeDb(Object.assign({ tasks: TASKS, subtasks: SUBS, user_profiles: [{ id: 1, user_code: "U123456" }] }, extra || {}));
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
const cards = w => w.document.querySelectorAll("#cardsGrid .task-card");
const ledger = db => (db.db.points_ledger || []);

(async () => {
  /* A. 今日三件事：默认自动推荐 3 件 + 加成标签 + 自选按钮可见 */
  {
    const { w } = makeDom();
    await sleep(350);
    check("P1 默认显示 3 张今日卡片", cards(w).length === 3);
    check("P2 卡片带加成预告标签", !!w.document.querySelector("#cardsGrid .bonus-badge") &&
      w.document.querySelector("#cardsGrid .bonus-badge").textContent.includes("+50%"));
    const pb = w.document.getElementById("pickBtn");
    check("P3 今日模式「自选」按钮可见", !!pb && !pb.classList.contains("hidden"));
    check("P4 今日提示引导可自选", w.document.querySelector(".today-hint").textContent.includes("自选"));
  }

  /* B. 自选弹窗：分组/勾选/计数/保存落库/卡片只剩所选 */
  {
    const { w, db } = makeDom();
    await sleep(350);
    w.openPickModal();
    await sleep(30);
    check("P5 自选弹窗按任务分组", w.document.querySelectorAll("#pickList .pick-group").length === 2);
    check("P6 列出全部未完成子任务", w.document.querySelectorAll("#pickList [data-pickid]").length === 4);
    w.document.querySelector('#pickList [data-pickid="11"]').click();
    await sleep(20);
    check("P7 勾选后计数为 1", w.document.getElementById("pickCount").textContent === "1");
    check("P8 保存按钮文案随选择变化", w.document.getElementById("pickSave").textContent.includes("就用这 1 件"));
    w.document.getElementById("pickSave").click();
    await sleep(120);
    const saved = JSON.parse((db.db.user_profiles[0].today_picks) || "{}");
    check("P9 自选结果写入 user_profiles.today_picks", Array.isArray(saved[today]) && saved[today].join(",") === "11");
    check("P10 今日列表只剩所选 1 件", cards(w).length === 1);
    check("P11 手动模式下「换一个」改为重新挑", !!w.document.querySelector('#cardsGrid [data-swapsub="11"]'));
    w.document.querySelector('#cardsGrid [data-swapsub="11"]').click();
    await sleep(60);
    check("P11b 点「换一个」打开自选弹窗", !!w.document.querySelector("#pickList"));
    check("P12 手动模式提示语切换", w.document.querySelector(".today-hint").textContent.includes("自己挑的"));
  }

  /* C. 交回自动推荐 */
  {
    const { w, db } = makeDom({ user_profiles: [{ id: 1, user_code: "U123456", today_picks: JSON.stringify({ [today]: [11] }) }] });
    await sleep(350);
    check("C1 读到云端自选（仅 1 件）", cards(w).length === 1);
    w.openPickModal();
    await sleep(30);
    w.document.getElementById("pickAuto").click();
    await sleep(120);
    const saved = JSON.parse((db.db.user_profiles[0].today_picks) || "{}");
    check("C2 交回自动推荐清空当天记录", !saved[today]);
    check("C3 回到自动推荐 3 件", cards(w).length === 3);
  }

  /* D. 今日三件事加成 +50%，取消完成按原额扣回（不刷分） */
  {
    const { w, db } = makeDom();
    await sleep(350);
    // 今日模式先渲染出 picks（todayShownIds 快照），再切到全部任务里勾选
    const pickIds = Array.from(w.document.querySelectorAll("#cardsGrid .task-card .layer-card-title")).map(el => +el.dataset.submodal);
    check("D1 推荐里含高分任务子任务", pickIds.includes(11));
    w.document.getElementById("modeAllBtn").click();
    await sleep(60);
    w.document.querySelector('#cardsGrid [data-check="11"]').click();
    await sleep(200);
    const l1 = ledger(db);
    check("D2 完成得基础 10 分", l1.some(r => r.delta === 10 && r.reason.includes("完成子任务")));
    check("D3 今日三件事内完成额外 +5", l1.some(r => r.delta === 5 && r.reason.includes("今日三件事加成")));
    check("D4 额外分记入 bonus_applied", Number((db.db.subtasks.find(s => s.id === 11) || {}).bonus_applied) === 5);
    check("D5 有额外分时播放烟花", w.document.querySelectorAll(".bonus-layer").length >= 1);
    w.document.querySelector('#cardsGrid [data-check="11"]').click();
    await sleep(200);
    const l2 = ledger(db);
    check("D6 取消完成扣回 10", l2.some(r => r.delta === -10 && r.reason.includes("取消完成")));
    check("D7 取消完成扣回额外 5", l2.some(r => r.delta === -5 && r.reason.includes("取消额外积分")));
    check("D8 取消后清零，不留下可刷的分", Number((db.db.subtasks.find(s => s.id === 11) || {}).bonus_applied) === 0);
  }

  /* E. 全部任务：自选按钮隐藏、排序、收起/展开、取出 +3、取回后完成双倍 */
  {
    const { w, db } = makeDom();
    await sleep(350);
    w.document.getElementById("modeAllBtn").click();
    await sleep(60);
    check("E1 全部任务模式隐藏「自选」", w.document.getElementById("pickBtn").classList.contains("hidden"));
    check("E2 任务卡有排序按钮", w.document.querySelectorAll('#cardsGrid [data-mvup]').length === 2);
    check("E3 任务卡有收起按钮", w.document.querySelectorAll('#cardsGrid [data-shelve]').length === 2);

    w.document.querySelector('#cardsGrid [data-shelve="1"]').click();
    await sleep(120);
    check("E4 收起写入 shelved=true", db.db.tasks.find(t => t.id === 1).shelved === true);
    check("E5 收起后卡片从列表消失", cards(w).length === 1);
    check("E6 出现「暂时不想做」盒子", !!w.document.querySelector(".shelved-box"));
    check("E7 盒子默认折叠", w.document.querySelector(".shelved-list").classList.contains("hidden"));

    w.document.querySelector("[data-shelvedtoggle]").click();
    await sleep(60);
    check("E8 点击展开盒子", !w.document.querySelector(".shelved-list").classList.contains("hidden"));
    check("E9 盒子里能取出", !!w.document.querySelector('[data-unshelve="1"]'));

    w.document.querySelector('[data-unshelve="1"]').click();
    await sleep(200);
    check("E10 取出后 shelved=false", db.db.tasks.find(t => t.id === 1).shelved === false);
    check("E11 取出打上 revived_at", !!db.db.tasks.find(t => t.id === 1).revived_at);
    check("E12 取出 +3 分", ledger(db).some(r => r.delta === 3 && r.reason.includes("取回")));
    check("E13 取出播放轻量烟花", w.document.querySelectorAll(".bonus-layer.lv1").length >= 1);

    w.document.getElementById("modeAllBtn").click();
    await sleep(60);
    w.document.querySelector('#cardsGrid [data-check="12"]').click();
    await sleep(200);
    check("E14 取回后完成给双倍额外 +10", ledger(db).some(r => r.delta === 10 && r.reason.includes("双倍")));
    check("E15 双倍记入 bonus_applied=10", Number((db.db.subtasks.find(s => s.id === 12) || {}).bonus_applied) === 10);
  }

  /* F. 排序真正落库 */
  {
    const { w, db } = makeDom();
    await sleep(350);
    w.document.getElementById("modeAllBtn").click();
    await sleep(60);
    w.document.querySelector('#cardsGrid [data-mvdown="1"]').click();
    await sleep(200);
    check("F1 下移后 sort_order 交换", Number(db.db.tasks.find(t => t.id === 1).sort_order) === 2 &&
      Number(db.db.tasks.find(t => t.id === 2).sort_order) === 1);
  }

  /* G. 收起任务不参与今日三件事（即使之前手动挑过） */
  {
    const { w } = makeDom({
      tasks: [{ id: 1, title: "考研数学", level: "high", category: "study", sort_order: 1, shelved: true }, TASKS[1]],
      user_profiles: [{ id: 1, user_code: "U123456", today_picks: JSON.stringify({ [today]: [11, 12] }) }],
    });
    await sleep(350);
    check("G1 已收起任务的子任务不出现在今日三件事", !w.document.getElementById("cardsGrid").textContent.includes("线代第一章"));
  }

  console.log("\n结果: " + passed + " 通过 / " + failed + " 失败");
  process.exit(failed ? 1 : 0);
})();
