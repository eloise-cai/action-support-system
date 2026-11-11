/* 想法暂存盒 + 挑战信念工作表 回归测试
   心理板块新增两个子页：
   - 🫙 想法暂存：写下来外化焦虑，之后变成任务 / 标记不在控制范围 / 放下
   - 🧩 挑战信念：CBT 练习 5（情境→卡点→相信度→挑战八问→思维方式→新认知→复评）
   数据表：worry_notes / belief_reviews（RLS owner_id=auth.uid()，桩内模拟） */
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
            // 模拟数据库列默认值（真实后端 insert 返回的行带默认值）
            const DEF = { worry_notes: { status: "parked" }, belief_reviews: { record_date: "2026-11-11" } };
            const row = Object.assign({ id: ++seq, created_at: new Date().toISOString() }, DEF[table] || {}, obj);
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

/* 切换到指定心理子页（点子页按钮） */
function gotoMind(w, key) {
  const btn = [...w.document.querySelectorAll(".mind-sub")].find(b => b.dataset.mind === key);
  btn.click();
}
function confirmOk(w) {
  const ok = w.document.getElementById("mConfirmOk");
  if (ok) ok.click();
}

(async () => {
  console.log("--- A. 页面结构与初始化 ---");
  {
    const { w } = makeDom();
    await sleep(140);
    check("A1 心理子页含暂存盒与挑战信念入口",
      !!w.document.querySelector('[data-mind="park"]') && !!w.document.querySelector('[data-mind="belief"]'));
    gotoMind(w, "belief");
    check("A2 挑战八问已渲染", w.document.querySelectorAll("#blQuestions .bl-q").length === 8);
    check("A3 八种思维方式 chips 已渲染", w.document.querySelectorAll("#blDistort .bl-dchip").length === 8);
    gotoMind(w, "park");
    check("A4 暂存页空态文案", w.document.getElementById("parkList").textContent.includes("安静"));
    check("A5 子页切换正确（chat 隐藏 / park 显示）",
      w.document.getElementById("mind-chat").classList.contains("hidden") &&
      !w.document.getElementById("mind-park").classList.contains("hidden"));
  }

  console.log("--- B. 想法暂存盒：写入与处理 ---");
  {
    const { w, db } = makeDom();
    await sleep(140);
    gotoMind(w, "park");
    w.document.getElementById("parkInput").value = "万一量化这条路走不通怎么办";
    w.document.getElementById("parkSaveBtn").click();
    await sleep(80);
    check("B1 已写入 worry_notes", db.db.worry_notes.some(r => r.content.includes("走不通") && r.status === "parked"));
    check("B2 列表渲染出待处理条目", w.document.getElementById("parkList").textContent.includes("走不通"));
    check("B3 输入框已清空", w.document.getElementById("parkInput").value === "");
    // 变成任务
    w.document.querySelector("[data-parktask]").click();
    await sleep(100);
    check("B4 任务已创建（标题=想法）", db.db.tasks.some(t => t.title.includes("走不通")));
    check("B5 想法标记为 task 并关联 task_id",
      db.db.worry_notes.some(r => r.status === "task" && r.task_id));
    check("B6 已处理区显示「已变成任务」", w.document.getElementById("parkDoneList").textContent.includes("已变成任务"));
    check("B7 待处理区回到空态", w.document.getElementById("parkList").textContent.includes("安静"));
  }
  {
    const { w, db } = makeDom({
      worry_notes: [
        { id: 71, content: "焦虑想法一", status: "parked", created_at: new Date().toISOString() },
        { id: 72, content: "担心明天汇报", status: "parked", created_at: new Date().toISOString() },
      ],
    });
    await sleep(140);
    gotoMind(w, "park");
    await sleep(80);
    // 标记不在控制范围
    [...w.document.querySelectorAll("[data-parkbeyond]")][0].click();
    await sleep(80);
    check("B8 标记不在控制范围", db.db.worry_notes.find(r => r.id === 71).status === "beyond");
    // 放下
    [...w.document.querySelectorAll("[data-parkdone]")][0].click();
    await sleep(80);
    check("B9 放下标记 done", db.db.worry_notes.find(r => r.id === 72).status === "done");
    check("B10 状态文案显示", w.document.getElementById("parkDoneList").textContent.includes("不在我的控制范围"));
    // 删除（确认弹窗）
    const beforeCnt = db.db.worry_notes.length;
    [...w.document.querySelectorAll("[data-delpark]")][0].click();
    await sleep(60);
    confirmOk(w);
    await sleep(60);
    check("B11 删除走确认弹窗并生效", db.db.worry_notes.length === beforeCnt - 1 && db.calls.deletes.some(d => d.table === "worry_notes"));
  }

  console.log("--- C. 挑战信念工作表 ---");
  {
    const { w, db } = makeDom();
    await sleep(140);
    gotoMind(w, "belief");
    w.document.getElementById("blSituation").value = "今天只完成了一张卡片";
    w.document.getElementById("blBelief").value = "我什么都做不好，一直都在浪费时间";
    w.document.getElementById("blBefore").value = "80";
    // 回答两问
    const tas = w.document.querySelectorAll("#blQuestions textarea");
    tas[0].value = "更多是习惯性自我否定，事实是今天完成了 1 张卡 + 2 个番茄钟";
    tas[2].value = "「什么都」「一直」都是极端措辞，事实并非如此";
    // 选两个思维方式
    const chips = [...w.document.querySelectorAll("#blDistort .bl-dchip")];
    chips.find(c => c.textContent === "灾难化").click();
    chips.find(c => c.textContent === "以偏概全").click();
    w.document.getElementById("blNew").value = "今天完成了 1 张卡，这是真实的进展";
    w.document.getElementById("blAfter").value = "35";
    w.document.getElementById("blSaveBtn").click();
    await sleep(100);
    const row = db.db.belief_reviews[0];
    check("C1 记录已写入", !!row && row.belief.includes("做不好"));
    check("C2 相信度前后为 80/35", row.believe_before === 80 && row.believe_after === 35);
    check("C3 挑战答案以 JSON 保存且含两问", (() => {
      const a = JSON.parse(row.answers || "{}");
      return a["0"] && a["2"] && !a["1"];
    })());
    check("C4 思维方式为逗号串", row.distortion === "灾难化,以偏概全");
    check("C5 新认知已保存", row.new_belief.includes("真实的进展"));
    // 列表渲染
    check("C6 列表显示前后分数", w.document.getElementById("blList").textContent.includes("80%") && w.document.getElementById("blList").textContent.includes("35%"));
    check("C7 下降≥30 显示「松动了很多」", w.document.getElementById("blList").textContent.includes("松动了很多"));
    check("C8 挑战过程折叠可见", w.document.getElementById("blList").textContent.includes("挑战过程"));
    // 表单已清空
    check("C9 保存后表单清空", w.document.getElementById("blBelief").value === "" &&
      [...w.document.querySelectorAll("#blDistort .bl-dchip")].every(c => !c.classList.contains("on")));
  }
  {
    // 只填卡点也能保存；分数不动时文案不同
    const { w } = makeDom();
    await sleep(140);
    gotoMind(w, "belief");
    w.document.getElementById("blBelief").value = "我必须做到完美才行";
    w.document.getElementById("blBefore").value = "60";
    w.document.getElementById("blAfter").value = "60";
    w.document.getElementById("blSaveBtn").click();
    await sleep(100);
    check("C10 只填卡点可保存", w.eval("beliefRecords.length") === 1);
    check("C11 分数未降显示「还蛮坚定的」", w.document.getElementById("blList").textContent.includes("还蛮坚定的"));
    // 删除
    w.document.querySelector("[data-delbelief]").click();
    await sleep(60);
    confirmOk(w);
    await sleep(60);
    check("C12 删除生效", w.eval("beliefRecords.length") === 0);
  }

  console.log("--- D. 刷新持久化 ---");
  {
    const saved1 = JSON.stringify([{ id: 81, content: "存款焦虑", status: "parked" }]);
    const saved2 = JSON.stringify([{ id: 82, record_date: "2026-11-11", belief: "我总是搞砸", believe_before: 70, believe_after: 30, answers: "{}", distortion: "", situation: "", new_belief: "上次并没有搞砸" }]);
    const { w } = makeDom({
      worry_notes: [{ id: 81, content: "存款焦虑", status: "parked" }],
      belief_reviews: [{ id: 82, record_date: "2026-11-11", belief: "我总是搞砸", believe_before: 70, believe_after: 30, answers: "{}", distortion: "", situation: "", new_belief: "上次并没有搞砸" }],
    });
    await sleep(140);
    gotoMind(w, "park");
    gotoMind(w, "belief");
    await sleep(100);
    check("D1 刷新后暂存盒仍显示", w.document.getElementById("parkList").textContent.includes("存款焦虑"));
    check("D2 刷新后挑战记录仍显示（30% 与新认知）",
      w.document.getElementById("blList").textContent.includes("30%") && w.document.getElementById("blList").textContent.includes("上次并没有搞砸"));
    void saved1; void saved2;
  }

  console.log("\n===== 结果 =====");
  console.log("通过 " + passed + " / 失败 " + failed);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("测试异常:", e); process.exit(1); });
