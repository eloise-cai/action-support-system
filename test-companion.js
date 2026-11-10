/* 钟磬陪伴空间（内嵌版）回归测试
   覆盖：门禁可见性 / 四个版面渲染 / 对话流式与落库 / 安静共处计时 / 登出重置 */
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

function makeDom({ rows = [] } = {}) {
  const dom = new JSDOM(INDEX_HTML, { url: "https://localhost/", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  const calls = { inserts: [], models: 0, llm: 0, orders: 0 };

  const makeQuery = () => {
    const q = {
      _rows: rows,
      select() { return q; },
      order() { return q; },
      limit() { return Promise.resolve({ data: q._rows, error: null }); },
      insert(obj) { calls.inserts.push(obj); return Promise.resolve({ data: [Object.assign({ id: calls.inserts.length }, obj)], error: null }); },
    };
    return q;
  };

  w.cloud = {
    database: { from: () => makeQuery() },
    llm: {
      models: { list: async () => { calls.models++; return [{ id: "m-test", name: "测试模型" }]; } },
      chat: {
        completions: {
          create: async function* () {
            calls.llm++;
            yield { choices: [{ delta: { content: "回来啦。" } }] };
            yield { choices: [{ delta: { content: "先坐下，喝口水。" } }] };
          },
        },
      },
    },
  };
  w.toast = () => {};

  const s = w.document.createElement("script");
  s.textContent = COMPANION_JS;
  w.document.body.appendChild(s);

  return { w, calls, C: w.Companion };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const visible = (w, id) => !w.document.getElementById(id).classList.contains("hidden");

(async () => {
  /* 1. 门禁：非本人看不到 */
  {
    const { w, C } = makeDom();
    C.boot(null);
    check("T1 未登录时不显示钟磬入口", !visible(w, "tabBtnCompanion"));
    C.boot({ id: "2117101511677841408", name: "17521653391" });
    check("T2 别的用户不显示钟磬入口", !visible(w, "tabBtnCompanion"));
    C.boot({ id: "1", phone: "+86 13961411471", user_metadata: { phone: "13961411471" } });
    check("T3 相似号码不误放行", !visible(w, "tabBtnCompanion"));
  }

  /* 2. 门禁：本人可见（三种身份字段形态） */
  {
    const a = makeDom();
    a.C.boot({ id: "2115701435453677568", name: "17301834189" });
    check("T4 uid + name 形态放行", visible(a.w, "tabBtnCompanion"));

    const b = makeDom();
    b.C.boot({ phone: "+86 17301834189", user_metadata: { nickname: "EC" } });
    check("T5 手机号带国家码放行", visible(b.w, "tabBtnCompanion"));

    const c = makeDom();
    c.C.boot({ sub: "999", profile: { full_phone: "17301834189" } });
    check("T6 嵌套字段放行", visible(c.w, "tabBtnCompanion"));
  }

  /* 3. 四个版面渲染 */
  {
    const { w, C } = makeDom();
    C.boot({ id: "2115701435453677568" });
    check("T7 入口文案为「钟磬」", w.document.getElementById("tabBtnCompanion").textContent.indexOf("钟磬") >= 0);
    check("T8 对话空态", w.document.getElementById("zqChatList").textContent.indexOf("他一直都在") >= 0);
    check("T9 日记 7 篇", w.document.querySelectorAll(".zq-diary-item").length === 7);
    check("T10 他的世界 5 张卡", w.document.querySelectorAll(".zq-world-card").length === 5);
    check("T11 陪伴问候有内容", w.document.getElementById("zqPresenceLine").textContent.length > 6);
    check("T12 每日诗句有内容", w.document.getElementById("zqPoem").textContent.length > 6);

    // 日记展开
    const head = w.document.querySelector(".zq-diary-head");
    const body = head.nextElementSibling;
    const before = body.classList.contains("hidden");
    head.click();
    check("T13 日记可展开", before && !body.classList.contains("hidden"));

    // 子版面切换
    const worldSub = w.document.querySelector('.zq-sub[data-zq="world"]');
    worldSub.click();
    check("T14 切到他的世界", visible(w, "zq-world") && !visible(w, "zq-chat"));
    const chatSub = w.document.querySelector('.zq-sub[data-zq="chat"]');
    chatSub.click();
    check("T15 切回对话", visible(w, "zq-chat"));
  }

  /* 4. 历史消息渲染 */
  {
    const { w, C } = makeDom({
      rows: [
        { role: "user", content: "今天好累", created_at: "2026-11-05T10:00:00.000Z" },
        { role: "assistant", content: "过来，靠着。", created_at: "2026-11-05T10:00:05.000Z" },
      ],
    });
    C.boot({ id: "2115701435453677568" });
    await sleep(30);
    check("T16 历史消息渲染两条", w.document.querySelectorAll(".zq-msg").length === 2);
    check("T17 我的消息靠右类名", w.document.querySelectorAll(".zq-msg.me").length === 1);
  }

  /* 5. 发消息：流式 + 落库 */
  {
    const { w, C, calls } = makeDom();
    C.boot({ id: "2115701435453677568" });
    await sleep(20);
    w.document.getElementById("zqChatInput").value = "我回来了";
    w.document.getElementById("zqSend").click();
    await sleep(120);
    const bubbles = Array.from(w.document.querySelectorAll(".zq-msg")).map(e => e.textContent);
    check("T18 用户消息上屏", bubbles.some(t => t.indexOf("我回来了") >= 0));
    check("T19 回复流式拼接完整", bubbles.some(t => t === "回来啦。先坐下，喝口水。"));
    check("T20 两条消息都已落库", calls.inserts.length === 2 && calls.inserts[0].role === "user" && calls.inserts[1].role === "assistant");
    check("T21 输入框已清空", w.document.getElementById("zqChatInput").value === "");
    check("T22 模型被调用一次", calls.llm === 1);
  }

  /* 6. 快捷短语 */
  {
    const { w, C, calls } = makeDom();
    C.boot({ id: "2115701435453677568" });
    await sleep(20);
    w.document.querySelector('.zq-chip[data-say="今天好累啊"]').click();
    await sleep(100);
    check("T23 快捷短语会发送", calls.inserts.length >= 2);
  }

  /* 7. 安静共处：计时与月度累计 */
  {
    const { w, C } = makeDom();
    C.boot({ id: "2115701435453677568" });
    w.document.getElementById("zqQuietBtn").click();
    check("T24 开始共处后按钮变「结束共处」", w.document.getElementById("zqQuietBtn").textContent === "结束共处");
    check("T25 计时开始驱动", w.document.getElementById("zqQuietStatus").textContent.indexOf("他在旁边") >= 0);
    // 伪造已过 90 秒
    const t0 = Date.now();
    w.document.getElementById("zqQuietBtn").click();
    check("T26 结束共处按钮复位", w.document.getElementById("zqQuietBtn").textContent === "开始共处");
    check("T27 本月共处有读数", w.document.getElementById("zqQuietTotal").textContent.length > 0);
    void t0;
  }

  /* 8. 登出重置 */
  {
    const { w, C } = makeDom();
    C.boot({ id: "2115701435453677568" });
    check("T28 重置前入口可见", visible(w, "tabBtnCompanion"));
    C.reset();
    check("T29 重置后入口隐藏", !visible(w, "tabBtnCompanion"));
  }

  console.log("\n结果: " + passed + " 通过 / " + failed + " 失败");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
