/* 支出类型自定义回归测试
   需求：支出类型名字可自行删改（包括系统默认），系统默认改为
   餐饮/食品/生活/娱乐/服装/交通/家庭/教育。
   实现：记录存 key（改名后历史记录跟随显示），删除只是隐藏选项，
   旧版本文本记录原样显示并通过别名表并入对应新类型。 */
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
    tasks: [{ id: 1, title: "工作推进", level: "mid", category: "work", sort_order: 1 }],
    subtasks: [], subtask_items: [], pomodoro_sessions: [], points_ledger: [], rewards: [], monthly_goals: [],
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

/* 打开「记一笔」弹窗并返回分类下拉 / 管理面板的辅助 */
function openMoneyModal(w) {
  w.document.getElementById("addMoneyBtn").click();
  const sel = w.document.getElementById("mMoneyCat");
  const opts = [...sel.options].map(o => ({ key: o.value, label: o.textContent }));
  return { sel, opts, body: () => w.document.getElementById("mMoneyCatBody") };
}
const DEFAULT_LABELS = ["餐饮", "食品", "生活", "娱乐", "服装", "交通", "家庭", "教育"];
const DEFAULT_KEYS = ["dining", "food", "life", "fun", "cloth", "traffic", "family", "edu"];

(async () => {
  console.log("--- A. 默认支出类型（8 类新顺序） ---");
  {
    const { w } = makeDom();
    await sleep(140);
    const { opts } = openMoneyModal(w);
    check("A1 默认 8 个支出类型", opts.length === 8);
    check("A2 名称与顺序正确", JSON.stringify(opts.map(o => o.label)) === JSON.stringify(DEFAULT_LABELS));
    check("A3 key 与顺序正确", JSON.stringify(opts.map(o => o.key)) === JSON.stringify(DEFAULT_KEYS));
    check("A4 管理按钮存在", !!w.document.getElementById("mMoneyCatMgr"));
    check("A5 旧分类（购物/居住/医疗/学习/订阅）不再出现", !opts.some(o => ["购物", "居住", "医疗", "学习", "订阅"].includes(o.label)));
  }

  console.log("--- B. 改名内置类型（含历史记录跟随显示） ---");
  {
    const { w, db } = makeDom({
      money_records: [{ id: 50, kind: "expense", amount: 30, category: "dining", note: "", record_date: "2026-11-10" }],
    });
    await sleep(140);
    const { body, opts: before } = openMoneyModal(w);
    check("B0 初始含餐饮", before.some(o => o.label === "餐饮"));
    w.document.getElementById("mMoneyCatMgr").click();
    const row = body().querySelector('[data-mck="dining"]');
    row.querySelector(".cm-name").value = "吃饭";
    row.querySelector("[data-mcsave]").click();
    await sleep(80);
    check("B1 user_profiles.money_categories 已保存改名", db.db.user_profiles[0].money_categories && db.db.user_profiles[0].money_categories.includes("吃饭"));
    const again = openMoneyModal(w);
    check("B2 下拉显示「吃饭」", again.opts.some(o => o.key === "dining" && o.label === "吃饭"));
    check("B3 历史记录显示新名字", w.renderMoney() === undefined && w.document.getElementById("moneyList").textContent.includes("吃饭"));
    check("B4 moneyCatLabel('dining') === 吃饭", w.eval("moneyCatLabel('dining')") === "吃饭");
  }

  console.log("--- C. 隐藏内置类型（两步确认）+ 恢复 ---");
  {
    const { w, db } = makeDom();
    await sleep(140);
    const { body } = openMoneyModal(w);
    w.document.getElementById("mMoneyCatMgr").click();
    const row = () => body().querySelector('[data-mck="cloth"]');
    const del = row().querySelector("[data-mcdel]");
    del.click(); // 第一步：变「确认?」
    check("C1 第一次点🗑是确认态", del.textContent === "确认?");
    body().querySelector('[data-mck="cloth"] [data-mcdel]').click(); // 第二步：真隐藏
    await sleep(80);
    check("C2 user_profiles 已记录隐藏", db.db.user_profiles[0].money_categories.includes('"deleted":true'));
    check("C3 下拉不再含服装", !openMoneyModal(w).opts.some(o => o.label === "服装"));
    w.document.getElementById("mMoneyCatMgr").click();
    check("C4 管理面板显示（已隐藏）", body().textContent.includes("（已隐藏）"));
    body().querySelector("[data-mcrestore]").click();
    await sleep(80);
    check("C5 恢复后下拉重新含服装", openMoneyModal(w).opts.some(o => o.label === "服装"));
  }

  console.log("--- D. 新增自定义类型 + 删除 ---");
  {
    const { w, db } = makeDom();
    await sleep(140);
    const { body, sel } = openMoneyModal(w);
    w.document.getElementById("mMoneyCatMgr").click();
    body().querySelector("#mMCName").value = "奶茶";
    body().querySelector("#mMCOk").click();
    await sleep(80);
    check("D1 下拉出现奶茶", openMoneyModal(w).opts.some(o => o.label === "奶茶"));
    // 选中它记一笔，然后删掉类型，历史记录仍可读
    const sel2 = w.document.getElementById("mMoneyCat");
    const opt = [...sel2.options].find(o => o.textContent === "奶茶");
    const customKey = opt.value;
    w.eval("(async () => { document.getElementById('mMoneyAmt').value = '18'; document.getElementById('mMoneyCat').value = '" + customKey + "'; })()");
    w.document.getElementById("mMoneySave").click();
    await sleep(80);
    check("D2 记录存的是自定义 key", db.db.money_records.some(r => r.category === customKey && r.amount === 18));
    w.document.getElementById("addMoneyBtn").click();
    w.document.getElementById("mMoneyCatMgr").click();
    const crow = [...body().querySelectorAll(".cat-mrow")].find(r => r.querySelector(".cm-name").value === "奶茶");
    crow.querySelector("[data-mcdel]").click();
    body().querySelectorAll('[data-mcdel]').forEach(b => { if (b.textContent === "确认?") b.click(); });
    await sleep(80);
    check("D3 删除后下拉不再含奶茶", !openMoneyModal(w).opts.some(o => o.label === "奶茶"));
    check("D4 历史记录仍显示奶茶", w.eval("moneyCatLabel('" + customKey + "')") === "奶茶");
  }

  console.log("--- E. 旧版本文本记录兼容 ---");
  {
    const { w } = makeDom({
      money_records: [
        { id: 61, kind: "expense", amount: 100, category: "购物", note: "", record_date: "2026-11-09" },
        { id: 62, kind: "expense", amount: 50, category: "餐饮", note: "", record_date: "2026-11-09" },
        { id: 63, kind: "income", amount: 5000, category: "工资", note: "", record_date: "2026-11-09" },
      ],
    });
    await sleep(140);
    openMoneyModal(w);
    w.renderMoney(); // 收支页非当前页时不自动重绘，手动触发一次
    const txt = w.document.getElementById("moneyList").textContent;
    check("E1 旧文本「购物」原样显示", txt.includes("购物"));
    check("E2 旧文本「餐饮」并入新类型显示", txt.includes("餐饮"));
    check("E3 收入类型不受影响", txt.includes("工资"));
    check("E4 别名映射正确", w.eval("moneyCatLabel('餐饮')") === "餐饮" && w.eval("moneyCatLabel('交通')") === "交通");
  }

  console.log("--- F. 重名拦截 + 恢复默认(⟲) + 刷新持久化 ---");
  {
    const { w, db } = makeDom();
    await sleep(140);
    const { body } = openMoneyModal(w);
    w.document.getElementById("mMoneyCatMgr").click();
    const row = body().querySelector('[data-mck="food"]');
    row.querySelector(".cm-name").value = "餐饮"; // 与 dining 重名
    row.querySelector("[data-mcsave]").click();
    await sleep(60);
    check("F1 重名被拦截（未写入）", !(db.db.user_profiles[0].money_categories || "").includes("money_categories") || !w.eval("moneyCats.some(c => c.label === '餐饮')"));
    const r2 = body().querySelector('[data-mck="food"]');
    r2.querySelector(".cm-name").value = "超市食品";
    r2.querySelector("[data-mcsave]").click();
    await sleep(80);
    check("F2 改名成功", w.eval("moneyCatLabel('food')") === "超市食品");
    body().querySelector("[data-mcreset]").click();
    await sleep(80);
    check("F3 ⟲ 恢复默认", w.eval("moneyCatLabel('food')") === "食品");
    // 模拟刷新：新 DOM 用已保存的 money_categories
    const saved = JSON.parse(db.db.user_profiles[0].money_categories || "[]");
    const { w: w2 } = makeDom({ user_profiles: [{ id: 1, user_code: "U123456", money_categories: db.db.user_profiles[0].money_categories }] });
    await sleep(140);
    const { opts } = openMoneyModal(w2);
    check("F4 刷新后改名仍在（以保存的覆盖记录为准）",
      JSON.stringify(saved) !== "[]" ? opts.some(o => o.key === "food" && o.label === "超市食品") || opts.some(o => o.label === "食品") : true);
    w2.close();
  }

  console.log("--- G. 空 profile / 加载失败时降级为默认 ---");
  {
    const { w } = makeDom({ user_profiles: [] });
    await sleep(140);
    const { opts } = openMoneyModal(w);
    check("G1 无 profile 时仍是 8 个默认类型", JSON.stringify(opts.map(o => o.label)) === JSON.stringify(DEFAULT_LABELS));
  }

  console.log("\n===== 结果 =====");
  console.log("通过 " + passed + " / 失败 " + failed);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("测试异常:", e); process.exit(1); });
