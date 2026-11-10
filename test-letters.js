/* 钟磬陪伴空间：信件往来 + 共鸣讨论 回归测试
   覆盖：信件渲染/写信流式回信/落库/快捷键；话题列表/新建/进入讨论/删除/返回 */
const { JSDOM } = require("C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/jsdom");
const fs = require("fs");

const ROOT = "C:/Users/Administrator/WorkBuddy/2026-10-29-14-52-27/";
const COMPANION_JS = fs.readFileSync(ROOT + "companion.js", "utf-8");
const INDEX_HTML = fs.readFileSync(ROOT + "index.html", "utf-8").replace(/<script[\s\S]*?<\/script>/g, "");

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log("  ok  " + name); }
  else { failed++; console.log("FAIL  " + name); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const visible = (w, id) => !w.document.getElementById(id).classList.contains("hidden");

function makeDb(tables) {
  const db = {};
  for (const k of Object.keys(tables || {})) db[k] = tables[k].map(r => Object.assign({}, r));
  let seq = 1000;
  const calls = { inserts: [], deletes: [], updates: [], llm: 0, prompts: [], modelsUsed: [] };
  function query(table) {
    const q = {
      _filters: [],
      select() { return q; },
      eq(col, val) { q._filters.push([col, val]); return q; },
      order() { return q; },
      limit() {
        let rows = db[table] || [];
        for (const [c, v] of q._filters) rows = rows.filter(r => String(r[c]) === String(v));
        return Promise.resolve({ data: rows.map(r => Object.assign({}, r)), error: null });
      },
      update(patch) {
        return {
          eq(col, val) {
            calls.updates.push({ table, patch, col, val });
            (db[table] || []).forEach(r => { if (String(r[col]) === String(val)) Object.assign(r, patch); });
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
      /* 忠实模拟 SDK：查询构造器是懒执行的 thenable，只有 then、没有 catch */
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
      delete() {
        return {
          eq(col, val) {
            calls.deletes.push({ table, col, val });
            db[table] = (db[table] || []).filter(r => String(r[col]) !== String(val));
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
    };
    return q;
  }
  return { from: t => query(t), db, calls };
}

const DEFAULT_MODELS = [
  { id: "auto", name: "Auto" },
  { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
  { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash" },
  { id: "kimi-k2.5", name: "Kimi-K2.5" },
  { id: "hunyuan-chat", name: "Hunyuan-Turbos" },
  { id: "glm-5.3", name: "GLM-5.3" },
];

function makeDom({ tables = {}, models } = {}) {
  const dom = new JSDOM(INDEX_HTML, { url: "https://localhost/", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  const db = makeDb(tables);
  const modelList = models || DEFAULT_MODELS;

  w.cloud = {
    database: { from: t => db.from(t) },
    llm: {
      models: { list: async () => modelList },
      chat: {
        completions: {
          create: async function* (args) {
            db.calls.llm++;
            db.calls.modelsUsed.push(args.model);
            db.calls.prompts.push(args.messages.map(m => m.role + ":" + m.content).join(" | "));
            yield { choices: [{ delta: { content: "（回信）" } }] };
            yield { choices: [{ delta: { content: "见字如面。" } }] };
          },
        },
      },
    },
  };
  w.toast = () => {};

  const s = w.document.createElement("script");
  s.textContent = COMPANION_JS;
  w.document.body.appendChild(s);
  return { w, db, C: w.Companion };
}

const OWNER = { id: "2115701435453677568", name: "17301834189" };

(async () => {
  /* 1. 空态渲染 */
  {
    const { w, C } = makeDom();
    C.boot(OWNER);
    await sleep(30);
    check("L1 信件空态引导写信", w.document.getElementById("zqLetterList").textContent.indexOf("第一封信") >= 0);
    check("L2 话题空态引导新建", w.document.getElementById("zqTopicList").textContent.indexOf("还没有话题") >= 0);
    check("L3 日记 7 篇仍在左栏", w.document.querySelectorAll(".zq-diary-item").length === 7);
    check("L4 写信入口默认隐藏编辑区", visible(w, "zqLetterNew") && !visible(w, "zqLetterCompose"));
    check("L5 话题室默认隐藏", !visible(w, "zqTopicRoom") && visible(w, "zqTopicHome"));
  }

  /* 2. 写信：流式回信 + 落库 */
  {
    const { w, db, C } = makeDom();
    C.boot(OWNER);
    await sleep(30);
    w.document.getElementById("zqLetterNew").click();
    check("L6 提笔写信打开编辑区", visible(w, "zqLetterCompose") && !visible(w, "zqLetterNew"));
    w.document.getElementById("zqLetterInput").value = "今天在地铁上想起北京那天。";
    w.document.getElementById("zqLetterSend").click();
    await sleep(150);
    const ls = Array.from(w.document.querySelectorAll(".zq-letter"));
    check("L7 我的信上屏", ls.some(e => e.classList.contains("me") && e.textContent.indexOf("地铁上想起北京") >= 0));
    check("L8 他的回信流式完整", ls.some(e => e.classList.contains("him") && e.textContent.indexOf("（回信）见字如面。") >= 0));
    const saved = db.calls.inserts.filter(x => x.table === "zq_letters");
    check("L9 双向落库 zq_letters", saved.length === 2 && saved[0].obj.role === "user" && saved[1].obj.role === "assistant");
    check("L10 回信上下文以人设为 system 且含全部信件", db.calls.prompts.length === 1 && db.calls.prompts[0].indexOf("system:你是钟磬") === 0);
    check("L11 编辑区清空", w.document.getElementById("zqLetterInput").value === "");
    // Ctrl+Enter 快捷寄出
    w.document.getElementById("zqLetterInput").value = "第二封。";
    w.document.getElementById("zqLetterInput").dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    await sleep(150);
    check("L12 Ctrl+Enter 也能寄出", db.db.zq_letters.length === 4);
  }

  /* 3. 历史信件渲染（角色/日期） */
  {
    const { w, C } = makeDom({
      tables: {
        zq_letters: [
          { id: 1, role: "user", content: "第一封信的内容", created_at: "2026-11-01T09:00:00.000Z" },
          { id: 2, role: "assistant", content: "他的第一封回信", created_at: "2026-11-02T21:00:00.000Z" },
        ],
      },
    });
    C.boot(OWNER);
    await sleep(30);
    const ls = Array.from(w.document.querySelectorAll(".zq-letter"));
    check("L13 历史两封信都渲染", ls.length === 2);
    check("L14 我信/他信类名正确", ls[0].classList.contains("me") && ls[1].classList.contains("him"));
    check("L15 信上有署名与日期", ls[0].textContent.indexOf("菜菜 · 2026-11-01") >= 0 && ls[1].textContent.indexOf("磬 · 2026-11-02") >= 0);
    // 收起编辑区
    w.document.getElementById("zqLetterNew").click();
    w.document.getElementById("zqLetterCancel").click();
    check("L16 收起后按钮复位", visible(w, "zqLetterNew") && !visible(w, "zqLetterCompose"));
  }

  /* 4. 话题：列表 + 新建 */
  {
    const { w, db, C } = makeDom({
      tables: {
        zq_topics: [
          { id: 1, title: "《爱在》三部曲", kind: "电影", created_at: "2026-11-01T09:00:00.000Z" },
          { id: 2, title: "日本行复盘", kind: "旅游", created_at: "2026-11-03T09:00:00.000Z" },
        ],
      },
    });
    C.boot(OWNER);
    await sleep(30);
    const items = w.document.querySelectorAll(".zq-topic-item");
    check("L17 两个话题都列出", items.length === 2);
    check("L18 最新话题排前面", items[0].textContent.indexOf("日本行复盘") >= 0);
    check("L19 类型徽标正确", items[0].querySelector(".zq-topic-kind").textContent === "旅游");
    // 新建
    w.document.getElementById("zqTopicNew").click();
    check("L20 新建表单打开", visible(w, "zqTopicForm"));
    check("L21 8 种类型齐全", w.document.querySelectorAll("#zqTopicKinds .zq-kind").length === 8);
    check("L22 默认类型是电影", w.document.querySelector('#zqTopicKinds .zq-kind.on').dataset.kind === "电影");
    w.document.querySelector('#zqTopicKinds [data-kind="音乐剧"]').click();
    check("L23 可切换类型", w.document.querySelector('#zqTopicKinds .zq-kind.on').dataset.kind === "音乐剧");
    w.document.getElementById("zqTopicTitle").value = "剧院魅影";
    w.document.getElementById("zqTopicCreate").click();
    await sleep(120);
    const saved = db.calls.inserts.filter(x => x.table === "zq_topics");
    check("L24 话题落库且类型正确", saved.length === 1 && saved[0].obj.title === "剧院魅影" && saved[0].obj.kind === "音乐剧");
    check("L25 创建后自动进入讨论室", visible(w, "zqTopicRoom") && w.document.getElementById("zqTopicRoomTitle").textContent.indexOf("剧院魅影") >= 0);
    check("L26 空讨论室有引导", w.document.getElementById("zqTopicMsgs").textContent.indexOf("先说说你的看法") >= 0);
    // 空名拦截
    w.document.getElementById("zqTopicBack").click();
    w.document.getElementById("zqTopicNew").click();
    w.document.getElementById("zqTopicCreate").click();
    check("L27 空名字不建话题", db.calls.inserts.filter(x => x.table === "zq_topics").length === 1);
  }

  /* 5. 话题讨论：发送/记忆/落库 */
  {
    const { w, db, C } = makeDom({
      tables: {
        zq_topics: [{ id: 7, title: "《美的历程》", kind: "书籍", created_at: "2026-11-01T09:00:00.000Z" }],
        zq_topic_msgs: [
          { id: 1, topic_id: 7, role: "user", content: "我觉得魏晋是最美的章节。", created_at: "2026-11-01T10:00:00.000Z" },
          { id: 2, topic_id: 7, role: "assistant", content: "楚汉的浪漫更早，也更野。", created_at: "2026-11-01T10:05:00.000Z" },
        ],
      },
    });
    C.boot(OWNER);
    await sleep(30);
    w.document.querySelector(".zq-topic-open").click();
    await sleep(50);
    check("L28 进入讨论室加载历史", w.document.querySelectorAll("#zqTopicMsgs .zq-msg").length === 2);
    check("L29 标题带类型", w.document.getElementById("zqTopicRoomTitle").textContent.indexOf("书籍") >= 0);
    w.document.getElementById("zqTopicInput").value = "但盛唐气象才是顶点。";
    w.document.getElementById("zqTopicSend").click();
    await sleep(150);
    const bubbles = Array.from(w.document.querySelectorAll("#zqTopicMsgs .zq-msg")).map(e => e.textContent);
    check("L30 观点消息上屏", bubbles.some(t => t.indexOf("盛唐气象") >= 0));
    check("L31 他流式接住并回应", bubbles.some(t => t.indexOf("（回信）见字如面。") >= 0));
    const saved = db.calls.inserts.filter(x => x.table === "zq_topic_msgs");
    check("L32 讨论落库且绑定 topic_id", saved.length === 2 && saved.every(x => Number(x.obj.topic_id) === 7));
    check("L33 讨论上下文带话题定制提示词", db.calls.prompts.some(p => p.indexOf("书籍") >= 0 && p.indexOf("美的历程") >= 0));
    // Enter 发送 / Shift+Enter 换行
    const ti = w.document.getElementById("zqTopicInput");
    ti.value = "再聊一个角度";
    ti.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await sleep(150);
    check("L34 Enter 直接发送（用户+回复共 2 条）", db.db.zq_topic_msgs.length === 6);
    // 返回
    w.document.getElementById("zqTopicBack").click();
    check("L35 返回后回到话题列表", visible(w, "zqTopicHome") && !visible(w, "zqTopicRoom"));
  }

  /* 6. 删除话题：两步确认，联动删楼层 */
  {
    const { w, db, C } = makeDom({
      tables: {
        zq_topics: [{ id: 9, title: "临时话题", kind: "其他", created_at: "2026-11-01T09:00:00.000Z" }],
        zq_topic_msgs: [{ id: 1, topic_id: 9, role: "user", content: "x", created_at: "2026-11-01T09:00:00.000Z" }],
      },
    });
    C.boot(OWNER);
    await sleep(30);
    const del = w.document.querySelector(".zq-topic-del");
    del.click();
    check("L36 第一次点只进入确认态", del.textContent.indexOf("确认") >= 0 && (db.db.zq_topics || []).length === 1);
    del.click();
    await sleep(80);
    check("L37 二次点击删话题与楼层", (db.db.zq_topics || []).length === 0 && (db.db.zq_topic_msgs || []).length === 0);
    check("L38 删除请求两表都发出", db.calls.deletes.length === 2);
  }

  /* 7. 登出重置清空信箱与话题 */
  {
    const { w, db, C } = makeDom({
      tables: {
        zq_letters: [{ id: 1, role: "user", content: "s", created_at: "2026-11-01T09:00:00.000Z" }],
        zq_topics: [{ id: 2, title: "t", kind: "电影", created_at: "2026-11-01T09:00:00.000Z" }],
      },
    });
    C.boot(OWNER);
    await sleep(30);
    C.reset();
    const st = C._state();
    check("L39 重置后信箱与话题清空", st.letters === 0 && st.topics === 0 && st.topicMsgs === 0);
    check("L40 重置后入口隐藏", !visible(w, "tabBtnCompanion"));
  }

  /* 8. 模型选择与松弛开关 */
  {
    const { w, db, C } = makeDom({ tables: { user_profiles: [{ id: 1 }] } });
    C.boot(OWNER);
    await sleep(60);
    const sel = w.document.getElementById("zqModelSel");
    check("M1 下拉有推荐分组", !!sel.querySelector('optgroup[label="推荐（更像当面说话）"]'));
    check("M2 默认选中 DeepSeek V4 Pro", sel.value === "deepseek-v4-pro");
    check("M3 推荐项带口味说明", sel.textContent.indexOf("中文自然") >= 0);
    check("M4 松弛开关默认打开", w.document.getElementById("zqRelax").checked === true);

    sel.value = "glm-5.3";
    sel.dispatchEvent(new w.Event("change"));
    await sleep(60);
    check("M5 切换后写入云端偏好", db.calls.updates.some(u => u.table === "user_profiles" && u.patch.zq_model === "glm-5.3"));

    w.document.getElementById("zqChatInput").value = "试试新模型";
    w.document.getElementById("zqSend").click();
    await sleep(150);
    check("M6 请求真的换了模型", db.calls.modelsUsed[0] === "glm-5.3");

    const cb = w.document.getElementById("zqRelax");
    cb.checked = false;
    cb.dispatchEvent(new w.Event("change"));
    await sleep(60);
    check("M7 关闭松弛会落库", db.calls.updates.some(u => u.patch.zq_style === "strict"));
    w.document.getElementById("zqChatInput").value = "再说一句";
    w.document.getElementById("zqSend").click();
    await sleep(150);
    check("M8 收紧后提示词不含松弛段", db.calls.prompts[db.calls.prompts.length - 1].indexOf("更松弛") < 0);
  }

  /* 9. 云端已有偏好时优先 */
  {
    const { w, C } = makeDom({ tables: { user_profiles: [{ id: 1, zq_model: "kimi-k2.5", zq_style: "strict" }] } });
    C.boot(OWNER);
    await sleep(60);
    check("M9 云端偏好优先（Kimi）", w.document.getElementById("zqModelSel").value === "kimi-k2.5");
    check("M10 云端 strict 关闭松弛", w.document.getElementById("zqRelax").checked === false);
  }

  /* 10. 静态护栏：SDK 构造器只有 then（懒执行），用 .catch 会抛错且请求不发 */
  {
    const chainCatch = /from\([\s\S]{0,240}?\.catch\(/.test(COMPANION_JS);
    check("L41 没有对数据库构造器链式 .catch", !chainCatch);
    const anyCatch = (COMPANION_JS.match(/\.catch\(/g) || []).length;
    check("L42 源码里不再有任何 .catch 调用", anyCatch === 0);
  }

  console.log("\n结果: " + passed + " 通过 / " + failed + " 失败");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
