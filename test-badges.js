/* 勋章墙稳定性回归测试
   需求：删除任务/卡片后，积分页的勋章版面不受影响——原先点亮的徽章仍然点亮。
   根因：徽章计数原来只读活跃列表（subtasks / items），软删卡片、归档任务会把它们剔除。
   修复：计数改用全量数组（allSubtasks / allItems），新建行两边同时登记。 */
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

const TASKS = [{ id: 1, title: "工作推进", level: "mid", category: "work", sort_order: 1 }];
/* 3 张今日已完成卡片 + 1 张未完成；2 个已完成的子子项 → 今日完成数 = 5 */
const SUBS = [
  { id: 11, task_id: 1, title: "已完成A", done: true, done_at: today + "T09:00:00+08:00" },
  { id: 12, task_id: 1, title: "已完成B", done: true, done_at: today + "T10:00:00+08:00" },
  { id: 13, task_id: 1, title: "已完成C", done: true, done_at: today + "T11:00:00+08:00" },
  { id: 14, task_id: 1, title: "未完成D", done: false, done_at: null },
];
const ITEMS = [
  { id: 21, subtask_id: 11, title: "子项1", done: true, done_at: today + "T09:30:00+08:00" },
  { id: 22, subtask_id: 12, title: "子项2", done: true, done_at: today + "T10:30:00+08:00" },
  { id: 23, subtask_id: 14, title: "子项3", done: false, done_at: null },
];

function makeDom(extra) {
  const dom = new JSDOM(HTML, { url: "https://localhost/", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  const db = makeDb(Object.assign({
    tasks: TASKS, subtasks: SUBS, subtask_items: ITEMS,
    pomodoro_sessions: [], points_ledger: [], rewards: [], monthly_goals: [],
    money_records: [], longterm_tasks: [], checkin_items: [], checkin_records: [],
    year_goals: [], user_profiles: [{ id: 1, user_code: "U123456" }],
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

function state(w, expr) { return w.eval(expr); }
/* 从徽章墙 DOM 数出「每日组」的完成数与点亮数
   注意：徽章墙只在积分页渲染，这里显式触发一次 renderPoints() */
function badgeStat(w) {
  try { w.renderPoints(); } catch (e) {}
  const wall = w.document.getElementById("badgeWall");
  const group = wall && wall.querySelector(".badge-group");
  if (!group) return { count: -1, lit: -1 };
  const head = group.querySelector(".badge-group-t").textContent;
  const m = head.match(/(\d+)\s*个完成/);
  const count = m ? +m[1] : -1;
  const lit = group.querySelectorAll(".badge-chip.lit").length;
  const total = group.querySelectorAll(".badge-chip").length;
  return { count, lit, total };
}

(async () => {
  console.log("--- A. 初始状态与徽章点亮 ---");
  {
    const { w } = makeDom();
    await sleep(140);
    const st = badgeStat(w);
    check("A1 今日完成数 = 3 卡片 + 2 子项 = 5", st.count === 5);
    check("A2 每日三个徽章（1/3/5）全点亮", st.lit === 3 && st.total === 3);
    check("A3 计数来自全量数组（allItems 已就位）", state(w, "Array.isArray(allItems) && allItems.length === 3"));
  }

  console.log("--- B. 删除绿色已完成卡片（软删） ---");
  {
    const { w, db } = makeDom();
    await sleep(140);
    const before = badgeStat(w);
    await w.deleteSubtask(11);
    await sleep(60);
    const after = badgeStat(w);
    check("B1 卡片确实被软删（deleted=true）", db.db.subtasks.some(r => r.id === 11 && r.deleted === true));
    check("B2 今日完成数不变（仍 5）", after.count === before.count && after.count === 5);
    check("B3 徽章仍然点亮（3 个）", after.lit === 3);
    check("B4 该卡片下的完成子项仍计入（allItems 保留）", state(w, "allItems.some(i => i.id === 21)"));
  }

  console.log("--- C. 删除已完成任务（归档） ---");
  {
    const { w, db } = makeDom({ subtasks: SUBS.filter(s => s.done) }); // 全部已完成，满足归档条件
    await sleep(140);
    const before = badgeStat(w);
    await w.deleteTask(1);
    await sleep(60);
    const after = badgeStat(w);
    check("C1 任务走归档（archived=true）", db.db.tasks.some(t => t.id === 1 && t.archived === true));
    check("C2 今日完成数不变（3 卡片 + 2 子项 = 5）", after.count === before.count && after.count === 5);
    check("C3 徽章仍然全部点亮（3 个）", after.lit === 3);
  }

  console.log("--- D. 刷新后仍点亮 ---");
  {
    const { w } = makeDom();
    await sleep(140);
    await w.deleteSubtask(11);
    await sleep(60);
    await w.loadAll(); // 模拟刷新
    await sleep(100);
    const st = badgeStat(w);
    check("D1 刷新后活跃列表不含软删卡片", !state(w, "subtasks").some(s => s.id === 11));
    check("D2 刷新后全量数组含它", state(w, "allSubtasks.some(s => s.id === 11 && s.deleted)"));
    check("D3 刷新后今日完成数仍 5", st.count === 5);
    check("D4 刷新后徽章仍点亮", st.lit === 3);
  }

  console.log("--- E. 未完成卡片真删不影响计数 ---");
  {
    const { w, db } = makeDom();
    await sleep(140);
    await w.deleteSubtask(14);
    await sleep(60);
    const st = badgeStat(w);
    check("E1 未完成卡片走了真删", db.calls.deletes.some(d => d.table === "subtasks" && String(d.val) === "14"));
    check("E2 今日完成数仍 5", st.count === 5);
    check("E3 徽章仍点亮", st.lit === 3);
  }

  console.log("--- F. 新完成的卡片即时计入（trackSubtask / trackItem） ---");
  {
    const { w } = makeDom();
    await sleep(140);
    w.eval("trackSubtask({ id: 991, task_id: 1, title: '刚完成', done: true, done_at: '" + today + "T12:00:00+08:00' }); renderAll();");
    await sleep(60);
    let st = badgeStat(w);
    check("F1 新建并完成一张卡片 → 计数 +1（6）", st.count === 6);
    w.eval("trackItem({ id: 992, subtask_id: 991, title: '子项', done: true, done_at: '" + today + "T12:10:00+08:00' }); renderAll();");
    await sleep(60);
    st = badgeStat(w);
    check("F2 再完成一个子项 → 计数 +1（7）", st.count === 7);
    check("F3 两处登记不重复（活跃列表各出现一次）",
      state(w, "subtasks.filter(s => s.id === 991).length === 1 && allSubtasks.filter(s => s.id === 991).length === 1")
      && state(w, "items.filter(i => i.id === 992).length === 1 && allItems.filter(i => i.id === 992).length === 1"));
  }

  console.log("--- G. 取消勾选仍会让计数下降（预期行为，不是 bug） ---");
  {
    const { w } = makeDom();
    await sleep(140);
    w.eval("(async () => { const s = subtasks.find(x => x.id === 11); s.done = false; s.done_at = null; renderAll(); })()");
    await sleep(80);
    const st = badgeStat(w);
    check("G1 取消完成后今日计数下降（4）", st.count === 4);
  }

  console.log("\n===== 结果 =====");
  console.log("通过 " + passed + " / 失败 " + failed);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("测试异常:", e); process.exit(1); });
