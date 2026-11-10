/* ABC 复盘 回归测试：右侧复盘面板渲染/打开表单/保存落库/取消/空校验 */
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
      /* 忠实模拟 SDK：update 后 .eq().select() 返回受影响行 */
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

function makeDom(tables) {
  const dom = new JSDOM(HTML, { url: "https://localhost/", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  const db = makeDb(tables);
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

const REC_PLAIN = { id: 11, record_date: "2026-11-10", a_event: "被上级问进展", b_belief: "觉得自己不行", c_result: "焦虑", emotion: "焦虑", intensity: 6 };
const REC_REVIEWED = { id: 12, record_date: "2026-11-09", a_event: "开发拖延", b_belief: "没促成行动", c_result: "自责", emotion: "修澄", intensity: 8, rv_change: "能，把『必须完美』换成『先跑通』", rv_other: "先做 15 分钟最小版本", rv_gain: "发现自己怕的是评价，不是任务" };

(async () => {
  /* R1 未复盘：显示「＋ 写复盘」引导 + 三个问题提示 */
  {
    const { w } = makeDom({ abc_records: [REC_PLAIN] });
    await sleep(400);
    w.document.querySelector('.tab[data-tab="mind"]').click();
    w.document.querySelector('.mind-sub[data-mind="abc"]').click();
    await sleep(80);
    const item = w.document.querySelector(".abc-item");
    check("R1a 渲染出复盘引导按钮", !!item && !!item.querySelector("[data-rvadd='11']"));
    check("R1b 引导里包含三问文案", item.querySelector(".rv-hint").textContent.includes("能否改变") && item.querySelector(".rv-hint").textContent.includes("其他解决办法") && item.querySelector(".rv-hint").textContent.includes("获得了什么"));
    check("R1c 双栏结构成立", !!item.querySelector(".abc-main") && !!item.querySelector(".abc-review"));
  }

  /* R2 已复盘：右侧显示三问答案 + 修改入口 */
  {
    const { w } = makeDom({ abc_records: [REC_REVIEWED] });
    await sleep(400);
    w.document.querySelector('.tab[data-tab="mind"]').click();
    w.document.querySelector('.mind-sub[data-mind="abc"]').click();
    await sleep(80);
    const item = w.document.querySelector(".abc-item");
    const rv = item.querySelector(".abc-review");
    check("R2a 显示复盘标题", rv.querySelector(".rv-title").textContent === "复盘");
    check("R2b 三问答案齐全", rv.querySelectorAll(".rv-line").length === 3);
    check("R2c 答案内容正确", rv.textContent.includes("先做 15 分钟最小版本"));
    check("R2d 有修改按钮", !!rv.querySelector("[data-rvedit='12']"));
  }

  /* R3 点击「写复盘」：就地打开表单，三空对应三问 */
  {
    const { w } = makeDom({ abc_records: [REC_PLAIN] });
    await sleep(400);
    w.document.querySelector('.tab[data-tab="mind"]').click();
    w.document.querySelector('.mind-sub[data-mind="abc"]').click();
    await sleep(80);
    w.document.querySelector("[data-rvadd='11']").click();
    await sleep(30);
    const tas = w.document.querySelectorAll(".rv-ta");
    check("R3a 打开三个输入框", tas.length === 3);
    check("R3b 占位符对齐三问", tas[0].placeholder.includes("能否改变") && tas[1].placeholder.includes("解决办法") && tas[2].placeholder.includes("获得了什么"));
    check("R3c 有保存/取消按钮", !!w.document.querySelector("[data-rvsave='11']") && !!w.document.querySelector("[data-rvcancel='11']"));
  }

  /* R4 保存：update 落库字段正确，面板切回展示态 */
  {
    const { w, db } = makeDom({ abc_records: [REC_PLAIN] });
    await sleep(400);
    w.document.querySelector('.tab[data-tab="mind"]').click();
    w.document.querySelector('.mind-sub[data-mind="abc"]').click();
    await sleep(80);
    w.document.querySelector("[data-rvadd='11']").click();
    await sleep(30);
    w.document.getElementById("rvTaChange").value = "能改变";
    w.document.getElementById("rvTaOther").value = "换个办法";
    w.document.getElementById("rvTaGain").value = "学到了";
    w.document.querySelector("[data-rvsave='11']").click();
    await sleep(60);
    check("R4a 发出一次 update", db.calls.updates.length === 1);
    check("R4b 更新字段正确", JSON.stringify(db.calls.updates[0].patch) === JSON.stringify({ rv_change: "能改变", rv_other: "换个办法", rv_gain: "学到了" }));
    check("R4c 面板切回展示态", !!w.document.querySelector(".abc-item .rv-title") && w.document.querySelector(".abc-item").textContent.includes("换个办法"));
  }

  /* R5 全空保存：拒绝且不发 update */
  {
    const { w, db } = makeDom({ abc_records: [REC_PLAIN] });
    await sleep(400);
    w.document.querySelector('.tab[data-tab="mind"]').click();
    w.document.querySelector('.mind-sub[data-mind="abc"]').click();
    await sleep(80);
    w.document.querySelector("[data-rvadd='11']").click();
    await sleep(30);
    w.document.querySelector("[data-rvsave='11']").click();
    await sleep(40);
    check("R5 全空不落库", db.calls.updates.length === 0);
  }

  /* R6 取消：表单还原为展示态，不落库 */
  {
    const { w, db } = makeDom({ abc_records: [REC_PLAIN] });
    await sleep(400);
    w.document.querySelector('.tab[data-tab="mind"]').click();
    w.document.querySelector('.mind-sub[data-mind="abc"]').click();
    await sleep(80);
    w.document.querySelector("[data-rvadd='11']").click();
    await sleep(30);
    w.document.querySelector("[data-rvcancel='11']").click();
    await sleep(30);
    check("R6 取消后回到引导态", !!w.document.querySelector("[data-rvadd='11']") && db.calls.updates.length === 0);
  }

  /* R7 已复盘的记录：修改打开表单并预填旧答案 */
  {
    const { w } = makeDom({ abc_records: [REC_REVIEWED] });
    await sleep(400);
    w.document.querySelector('.tab[data-tab="mind"]').click();
    w.document.querySelector('.mind-sub[data-mind="abc"]').click();
    await sleep(80);
    w.document.querySelector("[data-rvedit='12']").click();
    await sleep(30);
    check("R7 修改时预填旧答案", w.document.getElementById("rvTaChange").value.includes("先跑通") && w.document.getElementById("rvTaGain").value.includes("评价"));
  }

  /* R8 两条记录并存：复盘互不串扰 */
  {
    const { w } = makeDom({ abc_records: [REC_PLAIN, REC_REVIEWED] });
    await sleep(400);
    w.document.querySelector('.tab[data-tab="mind"]').click();
    w.document.querySelector('.mind-sub[data-mind="abc"]').click();
    await sleep(80);
    const items = w.document.querySelectorAll(".abc-item");
    check("R8 两条记录各自独立渲染", items.length === 2 && !!items[0].querySelector("[data-rvadd]") && !!items[1].querySelector(".rv-title"));
  }

  console.log("\n结果: " + passed + " 通过 / " + failed + " 失败");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
