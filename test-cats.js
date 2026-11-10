/* 分类管理 回归测试：内置分类改名/隐藏/恢复/复位 + 自定义分类不受影响 + 落库 */
const { JSDOM } = require("C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/jsdom");
const fs = require("fs");

const ROOT = "C:/Users/Administrator/WorkBuddy/2026-10-29-14-52-27/";
const APP = fs.readFileSync(ROOT + "app.js", "utf-8");
const HTML = fs.readFileSync(ROOT + "index.html", "utf-8").replace(/<script[\s\S]*?<\/script>/g, "");

let passed = 0, failed = 0;
const check = (n, c) => { c ? (passed++, console.log("  ok  " + n)) : (failed++, console.log("FAIL  " + n)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const INIT_CATS = [
  { key: "work", label: "上班", icon: "💼", base: true },   // 内置改名
  { key: "life", deleted: true },                            // 内置隐藏
  { key: "c100", label: "实习", icon: "🌱" },                // 自定义
];

function makeDb(tables) {
  const db = {};
  for (const k of Object.keys(tables || {})) db[k] = tables[k].map(r => Object.assign({}, r));
  let seq = 500;
  const calls = { inserts: [], updates: [], deletes: [] };
  function query(table) {
    const q = {
      _filters: [],
      select() { return q; },
      order() { return q; },
      limit() {
        let rows = db[table] || [];
        for (const [c, v] of q._filters) rows = rows.filter(r => String(r[c]) === String(v));
        return Promise.resolve({ data: rows.map(r => Object.assign({}, r)), error: null });
      },
      single() {
        let rows = db[table] || [];
        for (const [c, v] of q._filters) rows = rows.filter(r => String(r[c]) === String(v));
        return Promise.resolve({ data: rows[0] || null, error: null });
      },
      eq(col, val) { q._filters.push([col, val]); return q; },
      insert(obj) {
        let done = null;
        const run = () => {
          if (!done) {
            calls.inserts.push({ table, obj });
            const row = Object.assign({ id: ++seq }, obj);
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
            const builder = {
              select() {
                calls.updates.push({ table, patch, col, val });
                (db[table] || []).forEach(r => { if (String(r[col]) === String(val)) Object.assign(r, patch); });
                const out = (db[table] || []).filter(r => String(r[col]) === String(val)).map(r => Object.assign({}, r));
                return Promise.resolve({ data: out, error: null });
              },
              then(onF, onR) {
                calls.updates.push({ table, patch, col, val });
                (db[table] || []).forEach(r => { if (String(r[col]) === String(val)) Object.assign(r, patch); });
                const out = (db[table] || []).filter(r => String(r[col]) === String(val)).map(r => Object.assign({}, r));
                return Promise.resolve({ data: out, error: null }).then(onF, onR);
              },
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
            return Promise.resolve({ data: [], error: null });
          },
        };
      },
    };
    return q;
  }
  return { from: t => query(t), db, calls };
}

function makeDom(userProfiles) {
  const dom = new JSDOM(HTML, { url: "https://localhost/", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  const db = makeDb({ user_profiles: userProfiles || [] });
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

function makePicker(w) {
  const div = w.document.createElement("div");
  div.id = "mCatPick";
  w.document.body.appendChild(div);
  const getCat = w.bindCategoryPicker("work");
  return { div, getCat };
}

(async () => {
  /* C1 覆盖记录生效：改名/隐藏/自定义并存 */
  {
    const { w } = makeDom([{ id: 7, user_code: "U123456", custom_categories: JSON.stringify(INIT_CATS) }]);
    await sleep(400);
    const m = w.catMap();
    check("C1a 内置改名生效", m.work && m.work.label === "上班");
    check("C1b 隐藏的内置分类不出现", !m.life);
    check("C1c 自定义分类正常", m.c100 && m.c100.label === "实习");
    check("C1d 未动的内置分类保持默认", m.study && m.study.label === "学习");
  }

  /* C2 管理面板：内置行可编辑，改名带 ⟲，隐藏行显示恢复 */
  {
    const { w } = makeDom([{ id: 7, user_code: "U123456", custom_categories: JSON.stringify(INIT_CATS) }]);
    await sleep(400);
    const { div } = makePicker(w);
    w.renderCatManage(div, null);
    const workRow = div.querySelector('.cat-mrow[data-k="work"]');
    check("C2a 改名后的内置分类预填新值", workRow.querySelector(".cm-name").value === "上班");
    check("C2b 改名过的内置分类有 ⟲ 复位", !!workRow.querySelector("[data-catreset='work']"));
    const lifeRow = div.querySelector('.cat-mrow[data-k="life"]');
    check("C2c 隐藏的内置分类显示恢复按钮", !!lifeRow.querySelector("[data-catrestore='life']") && lifeRow.textContent.includes("已隐藏"));
    check("C2d 自定义分类仍在列", !!div.querySelector('.cat-mrow[data-k="c100"]'));
    check("C2e 五个内置分类都出现", div.querySelectorAll(".cat-mrow").length === 6);
  }

  /* C3 改内置分类名 → 落库为覆盖记录 */
  {
    const { w, db } = makeDom([{ id: 7, user_code: "U123456", custom_categories: JSON.stringify(INIT_CATS) }]);
    await sleep(400);
    const { div, getCat } = makePicker(w);
    w.renderCatManage(div, null);
    const row = div.querySelector('.cat-mrow[data-k="study"]');
    row.querySelector(".cm-name").value = "科研";
    row.querySelector("[data-catsave='study']").click();
    await sleep(60);
    check("C3a 落库到 user_profiles", db.calls.updates.length === 1 && db.calls.updates[0].table === "user_profiles");
    const saved = JSON.parse(db.db.user_profiles[0].custom_categories);
    const ov = saved.find(c => c.key === "study");
    check("C3b 覆盖记录内容正确", ov && ov.label === "科研" && !ov.deleted);
    check("C3c 立即生效", w.catMap().study.label === "科研");
    check("C3d 原有覆盖不受影响", JSON.parse(db.db.user_profiles[0].custom_categories).some(c => c.key === "work" && c.label === "上班"));
  }

  /* C4 隐藏内置分类：两步确认 → deleted 记录，catMap 不再出现 */
  {
    const { w, db } = makeDom([{ id: 7, user_code: "U123456", custom_categories: JSON.stringify(INIT_CATS) }]);
    await sleep(400);
    const { div } = makePicker(w);
    w.renderCatManage(div, null);
    const btn = div.querySelector('.cat-mrow[data-k="fitness"] [data-catdel]');
    btn.click();
    await sleep(30);
    check("C4a 第一次点只武装", db.calls.updates.length === 0);
    btn.click();
    await sleep(40);
    const saved = JSON.parse(db.db.user_profiles[0].custom_categories);
    check("C4b 第二次点写入 deleted 记录", saved.some(c => c.key === "fitness" && c.deleted === true));
    check("C4c 健身分类从选择器消失", !w.catMap().fitness);
    check("C4d 面板出现恢复入口", !!div.querySelector("[data-catrestore='fitness']"));
  }

  /* C5 恢复隐藏的内置分类 */
  {
    const { w } = makeDom([{ id: 7, user_code: "U123456", custom_categories: JSON.stringify(INIT_CATS) }]);
    await sleep(400);
    const { div } = makePicker(w);
    w.renderCatManage(div, null);
    div.querySelector("[data-catrestore='life']").click();
    await sleep(40);
    check("C5 恢复后回到默认分类", w.catMap().life && w.catMap().life.label === "生活");
  }

  /* C6 ⟲ 复位改名的内置分类 */
  {
    const { w } = makeDom([{ id: 7, user_code: "U123456", custom_categories: JSON.stringify(INIT_CATS) }]);
    await sleep(400);
    const { div } = makePicker(w);
    w.renderCatManage(div, null);
    div.querySelector("[data-catreset='work']").click();
    await sleep(40);
    const m = w.catMap();
    check("C6 复位后回到「工作」", m.work && m.work.label === "工作");
  }

  /* C7 重名拦截：改成已有分类的名字不落库 */
  {
    const { w, db } = makeDom([{ id: 7, user_code: "U123456", custom_categories: JSON.stringify(INIT_CATS) }]);
    await sleep(400);
    const { div } = makePicker(w);
    w.renderCatManage(div, null);
    const row = div.querySelector('.cat-mrow[data-k="study"]');
    row.querySelector(".cm-name").value = "实习"; // 已被自定义分类占用
    row.querySelector("[data-catsave='study']").click();
    await sleep(40);
    check("C7 重名不落库", db.calls.updates.length === 0);
  }

  /* C8 自定义分类的改名/删除路径不受影响 */
  {
    const { w, db } = makeDom([{ id: 7, user_code: "U123456", custom_categories: JSON.stringify(INIT_CATS) }]);
    await sleep(400);
    const { div } = makePicker(w);
    w.renderCatManage(div, null);
    const row = div.querySelector('.cat-mrow[data-k="c100"]');
    row.querySelector(".cm-name").value = "兼职";
    row.querySelector("[data-catsave='c100']").click();
    await sleep(40);
    const saved = JSON.parse(db.db.user_profiles[0].custom_categories);
    check("C8a 自定义改名仍走原路径", saved.some(c => c.key === "c100" && c.label === "兼职"));
    const del = div.querySelector('.cat-mrow[data-k="c100"] [data-catdel]');
    del.click(); await sleep(20); del.click(); await sleep(30);
    const saved2 = JSON.parse(db.db.user_profiles[0].custom_categories);
    check("C8b 自定义删除仍正常", !saved2.some(c => c.key === "c100"));
  }

  /* C9 空自定义时也始终有「⚙ 管理」入口 */
  {
    const { w } = makeDom([]);
    await sleep(400);
    const html = w.catOptionsHtml("");
    check("C9 管理按钮恒在", html.includes("mCatManage") && html.includes("mCatAdd"));
    check("C9b 默认五个分类齐全", ["work", "study", "life", "hobby", "fitness"].every(k => html.includes('data-cat="' + k + '"')));
  }

  console.log("\n结果: " + passed + " 通过 / " + failed + " 失败");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
