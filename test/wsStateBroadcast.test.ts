import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { SessionManager } from "../src/server/sessionManager.js";

// ---------------------------------------------------------------------------
// 侧栏真相层逐轮广播（state/events 随步边界推送）：
// 服务端在 turn_done（input/continue/reroll）/rollback/edit_result/new_session/
// load_session 后广播 state+events；WS 重连同步一并携带。
// 前端 play.js：sideView 记录当前视图，推送到达仅重渲匹配视图；
// session_started 清缓存防跨会话陈旧；直编模态预填因此始终新鲜。
// 集成基建限制（startServer 走真实 RUNS_DIR + 需 LLM 配置），此处沿用
// wsReroll.test.ts 的源码结构断言 + SessionManager 行为断言。
// ---------------------------------------------------------------------------

const serverSource = fs.readFileSync(path.join(process.cwd(), "src/server/index.ts"), "utf8");
const playSource = fs.readFileSync(path.join(process.cwd(), "web/pages/play.js"), "utf8");

/** 取 index.ts 消息处理中某个分支的源码片段（从分支头到下一个分支/catch）。 */
function branch(source: string, head: string): string {
  const start = source.indexOf(head);
  assert.ok(start >= 0, `分支不存在: ${head}`);
  const rest = source.slice(start + head.length);
  const next = rest.search(/\} else if \(msg\.type ===|\} catch/);
  return rest.slice(0, next >= 0 ? next : undefined);
}

describe("服务端 state/events 逐轮广播", () => {
  it("sendStateEvents 帮助函数经 manager.query 广播 state+events", () => {
    assert.match(serverSource, /const sendStateEvents = \(\): void => \{[\s\S]*?type: "state", data: manager\.query\("state"\)[\s\S]*?type: "events", data: manager\.query\("events"\)[\s\S]*?\};/);
  });

  it("input 分支：turn_done 后广播 state/events（每步边界推送）", () => {
    const b = branch(serverSource, 'msg.type === "input"');
    assert.ok(b.indexOf('type: "turn_done"') < b.indexOf("sendStateEvents()"), "turn_done 应先于 state/events");
    assert.ok(b.indexOf("sendStateEvents()") < b.indexOf("sendPipeline()"));
  });

  it("continue 分支：turn_done 后广播 state/events", () => {
    const b = branch(serverSource, 'msg.type === "continue"');
    assert.ok(b.includes('type: "turn_done"') && b.includes("sendStateEvents()"));
  });

  it("reroll 分支：history/turn_done 后广播 state/events", () => {
    const b = branch(serverSource, 'msg.type === "reroll"');
    assert.ok(b.includes('type: "turn_done"') && b.includes("sendStateEvents()"));
  });

  it("rollback 分支：事件截断后广播 state/events 同步侧栏", () => {
    const b = branch(serverSource, 'msg.type === "rollback"');
    assert.ok(b.includes('type: "history"') && b.includes("sendStateEvents()"));
  });

  it("edit_result 分支：步编辑重放效应后广播 state/events", () => {
    const b = branch(serverSource, 'msg.type === "edit_result"');
    assert.ok(b.includes('type: "edit_done"') && b.includes("sendStateEvents()"));
  });

  it("new_session / load_session：会话建立即推初始 state/events", () => {
    for (const head of ['msg.type === "new_session"', 'msg.type === "load_session"']) {
      assert.ok(branch(serverSource, head).includes("sendStateEvents()"), head);
    }
  });

  it("WS 重连同步携带 state/events（断线期间真相层可能已推进）", () => {
    const reconnect = serverSource.slice(serverSource.indexOf("wss.handleUpgrade"), serverSource.indexOf('ws.on("close"'));
    for (const type of ["session_started", "history", "state", "events", "pipeline"]) {
      assert.ok(reconnect.includes(`type: "${type}"`), `重连同步缺 ${type}`);
    }
  });

  it("直编 onStateRefresh 广播保持不变", () => {
    assert.match(serverSource, /manager\.onStateRefresh = \(state, events\) => \{[\s\S]*?type: "state"[\s\S]*?type: "events"[\s\S]*?type: "pipeline"/);
  });

  it("SessionManager.query 直供 state/events（广播数据源）", () => {
    const manager = new SessionManager(() => ({}) as never);
    const fake = {
      runId: "temp-run",
      setBusy(): void {},
      getState: () => ({ world: { x: 1 }, characters: {} }),
      getEvents: () => [{ seq: 1 }],
      getStats: () => ({}),
    };
    (manager as unknown as { session: unknown }).session = fake;
    assert.deepEqual(manager.query("state"), { world: { x: 1 }, characters: {} });
    assert.deepEqual(manager.query("events"), [{ seq: 1 }]);
  });
});

describe("前端侧栏实时渲染（play.js）", () => {
  it("sideView 记录当前视图，默认事件视图", () => {
    assert.match(playSource, /let sideView = "events";/);
  });

  it("state/events 推送：更新缓存且仅当前视图匹配才重渲", () => {
    assert.match(playSource, /case "state":[\s\S]*?latestState = msg\.data;[\s\S]*?if \(sideView === "state"\) renderSidePanel\(\);/);
    assert.match(playSource, /case "events":[\s\S]*?latestEvents = msg\.data;[\s\S]*?if \(sideView === "events"\) renderSidePanel\(\);/);
  });

  it("renderSidePanel 按视图渲染缓存（状态走 formatStateForPanel 结构化 timer）", () => {
    assert.match(playSource, /function renderSidePanel\(\) \{[\s\S]*?formatStateForPanel\(latestState\)[\s\S]*?JSON\.stringify\(latestEvents, null, 2\)/);
  });

  it("页签按钮：切视图 + 缓存立即渲染 + 查询兜底", () => {
    assert.match(playSource, /b\.onclick = \(\) => \{[\s\S]*?sideView = cmd;[\s\S]*?renderSidePanel\(\);[\s\S]*?command: cmd/);
  });

  it("session_started 清真相层缓存（防跨会话陈旧预填）", () => {
    const handler = playSource.slice(playSource.indexOf('case "session_started"'), playSource.indexOf('case "history"'));
    assert.ok(handler.includes("latestState = null;") && handler.includes("latestEvents = null;") && handler.includes("renderSidePanel();"));
  });

  it("直编模态：缓存未备走 pendingStateEditOpen 查询，到齐后以新缓存开窗", () => {
    assert.match(playSource, /if \(latestState === null \|\| latestEvents === null\) \{[\s\S]*?pendingStateEditOpen = true;/);
    assert.match(playSource, /if \(pendingStateEditOpen && latestEvents !== null\) \{[\s\S]*?openStateEditor\(\)/);
    assert.match(playSource, /if \(pendingStateEditOpen && latestState !== null\) \{[\s\S]*?openStateEditor\(\)/);
  });
});
