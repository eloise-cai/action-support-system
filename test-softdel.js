/* 删除卡片不伤月历：软删回归测试
   覆盖：绿色已完成卡片删除→软删(deleted=true)、月历打卡计数不变、月专注时长不变、
   未完成卡片仍真删、软删后刷新重载仍保留月历 */
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
const todayDay = new Date().getDate();

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
            const gone = (db[table] || []).filter(r => String(r[col]) === String(val)).map(r => Object.assign({}, r));
            db[table] = (db[table] || []).filter(r => String(r[col]) !== String(val));
            /* 真实后端 delete().select() 返回被删的行，blocked() 靠空数组判失败 */
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

const TASKS = [
  { id: 1, title: "考研数学", level: "high", category: "study", sort_order: 1 },
];
const SUBS = [
  { id: 11, task_id: 1, title: "已完成的卡片", done: true, done_at: today + "T09:00:00+08:00" },
  { id: 12, task_id: 1, title: "未完成的卡片", done: false, done_at: null },
];
const SESSIONS = [
  { id: 101, task_id: 1, subtask_id: 11, duration_seconds: 5 * 3600, session_date: today }, // 5 小时
  { id: 102, task_id: 1, subtask_id: 12, duration_seconds: 1800, session_date: today },
];

function makeDom(extra) {
  const dom = new JSDOM(HTML, { url: "https://localhost/", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  const db = makeDb(Object.assign({
    tasks: TASKS, subtasks: SUBS, pomodoro_sessions: SESSIONS,
    subtask_items: [], points_ledger: [], rewards: [], monthly_goals: [],
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

/* let 声明的内部状态挂在全局词法环境里，不在 window 上 → 用页内 eval 读 */
function state(w, expr) { return w.eval(expr); }

(async () => {
  console.log("--- A. 软删绿色已完成卡片 ---");
  {
    const { w, db } = makeDom();
    await sleep(120);

    const compBefore = w.monthCompletionMap(new Date().getFullYear(), new Date().getMonth())[todayDay] || 0;
    const focusBefore = w.monthFocusMap(new Date().getFullYear(), new Date().getMonth())[todayDay] || 0;
    check("A0 初始月历当天有打卡", compBefore >= 1);
    check("A0 初始月专注 = 5h + 0.5h", focusBefore === 5 * 3600 + 1800);

    const ok = await w.deleteSubtask(11);
    await sleep(50);

    check("A1 删除成功", ok === true);
    check("A2 走的是 update(软删) 而非 delete",
      db.calls.updates.some(u => u.table === "subtasks" && u.patch && u.patch.deleted === true && String(u.val) === "11") &&
      !db.calls.deletes.some(d => d.table === "subtasks" && String(d.val) === "11"));
    const row = db.db.subtasks.find(r => r.id === 11);
    check("A3 数据库里行还在且 deleted=true", !!row && row.deleted === true && row.done === true);
    check("A4 done_at 原样保留", !!row && row.done_at === today + "T09:00:00+08:00");
    check("A5 活跃子任务列表不再含该卡片", !state(w, "subtasks").some(s => s.id === 11));

    const compAfter = w.monthCompletionMap(new Date().getFullYear(), new Date().getMonth())[todayDay] || 0;
    check("A6 月历当天打卡数不变", compAfter === compBefore);
    const focusAfter = w.monthFocusMap(new Date().getFullYear(), new Date().getMonth())[todayDay] || 0;
    check("A7 月专注时长不变", focusAfter === focusBefore);
    check("A8 专注记录一条没少", state(w, "sessions.filter(x=>x.id===101).length===1 && sessions.length===2"));
    check("A9 数据库番茄钟表一条没少", db.db.pomodoro_sessions.length === 2);
  }

  console.log("--- B. 未完成卡片仍真删 ---");
  {
    const { w, db } = makeDom();
    await sleep(120);
    const ok = await w.deleteSubtask(12);
    await sleep(50);
    check("B1 删除成功", ok === true);
    check("B2 走的是 delete(真删)", db.calls.deletes.some(d => d.table === "subtasks" && String(d.val) === "12"));
    check("B3 数据库里行已移除", !db.db.subtasks.some(r => r.id === 12));
    check("B4 该卡片的番茄钟记录从内存清掉", !state(w, "sessions.some(x=>x.subtask_id===12)"));
    check("B5 已完成卡片的记录不受影响", state(w, "sessions.some(x=>x.subtask_id===11)"));
    const comp = w.monthCompletionMap(new Date().getFullYear(), new Date().getMonth())[todayDay] || 0;
    check("B6 月历当天打卡数不受真删影响", comp >= 1);
  }

  console.log("--- C. 软删后重载仍保留月历（模拟刷新） ---");
  {
    const { w, db } = makeDom();
    await sleep(120);
    await w.deleteSubtask(11);
    await sleep(50);
    // 模拟刷新：直接重跑 loadAll（stub 数据库中行已带 deleted=true）
    await w.loadAll();
    await sleep(80);
    check("C1 刷新后活跃列表仍不含软删卡片", !state(w, "subtasks").some(s => s.id === 11));
    check("C2 刷新后 allSubtasks 仍含该行（月历计数源）", state(w, "allSubtasks.some(s=>s.id===11&&s.done&&s.deleted)"));
    const comp = w.monthCompletionMap(new Date().getFullYear(), new Date().getMonth())[todayDay] || 0;
    check("C3 刷新后月历当天打卡数不变", comp >= 1);
    const focus = w.monthFocusMap(new Date().getFullYear(), new Date().getMonth())[todayDay] || 0;
    check("C4 刷新后月专注不变", focus === 5 * 3600 + 1800);
  }

  console.log("\n结果: " + passed + " 通过 / " + failed + " 失败");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("测试崩溃:", e); process.exit(1); });
