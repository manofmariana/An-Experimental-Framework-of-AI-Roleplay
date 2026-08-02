import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { PROJECT_ROOT } from "../config.js";
import { handleApi } from "./api.js";
import { WebDisplay } from "./display.js";
import { SessionManager } from "./sessionManager.js";
import { parseClientMessage, type ServerMessage } from "./ws-protocol.js";

const WEB_ROOT = path.join(PROJECT_ROOT, "web");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** 静态伺服 web/（拒目录穿越）。 */
function serveStatic(res: http.ServerResponse, pathname: string): void {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = path.resolve(WEB_ROOT, rel);
  if (!file.startsWith(WEB_ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

export function startServer(): http.Server {
  const host = process.env.AIRP_HOST ?? "127.0.0.1";
  const port = Number(process.env.AIRP_PORT ?? 8787);

  // 威胁模型：配置里有 API key，只应绑 loopback
  const isLoopback = host === "localhost" || host.startsWith("127.") || host === "::1";
  if (!isLoopback) {
    console.warn(`[警告] 正在绑定非 loopback 地址 ${host}——config.json 含 API key，公网暴露有风险！`);
  }

  const clients = new Set<WebSocket>();
  const broadcast = (msg: ServerMessage): void => {
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  };
  const manager = new SessionManager(() => new WebDisplay(broadcast));
  // 直接编辑成功后广播 state/events/pipeline 刷新全部客户端（与 WS command 查询同一消息形态；
  // pipeline 必带——直编可能改变 phase（调度变量编辑），前端输入权限/继续按钮立刻跟随）
  manager.onStateRefresh = (state, events) => {
    broadcast({ type: "state", data: state });
    broadcast({ type: "events", data: events });
    const info = manager.pipelineInfo;
    if (info) broadcast({ type: "pipeline", ...info });
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      if (await handleApi(req, res, manager)) return;
      serveStatic(res, new URL(req.url ?? "/", "http://localhost").pathname);
    })().catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: String(err) }));
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      // 重连同步当前会话完整可见状态，避免 UI 停留在过期 history/pipeline。
      if (manager.currentRunId) {
        ws.send(JSON.stringify({ type: "session_started", runId: manager.currentRunId } satisfies ServerMessage));
        ws.send(JSON.stringify({ type: "history", history: manager.currentHistory(), replace: true } satisfies ServerMessage));
        // 断线期间真相层可能已推进：一并同步侧栏/直编缓存
        ws.send(JSON.stringify({ type: "state", data: manager.query("state") } satisfies ServerMessage));
        ws.send(JSON.stringify({ type: "events", data: manager.query("events") } satisfies ServerMessage));
        const info = manager.pipelineInfo;
        if (info) ws.send(JSON.stringify({ type: "pipeline", ...info } satisfies ServerMessage));
      }
      ws.on("close", () => clients.delete(ws));
      ws.on("message", (raw) => {
        void (async () => {
          const sendPipeline = (): void => {
            const info = manager.pipelineInfo;
            if (info) broadcast({ type: "pipeline", ...info });
          };
          // 真相层随轮广播：步边界（turn_done）/回溯/步编辑后推送 state/events，
          // 前端侧栏与直编模态缓存由此保持新鲜（LLM 流式 delta 期间不推，避免狂刷）
          const sendStateEvents = (): void => {
            broadcast({ type: "state", data: manager.query("state") });
            broadcast({ type: "events", data: manager.query("events") });
          };
          try {
            const msg = parseClientMessage(raw.toString());
            if (msg.type === "input") {
              // 首次输入会触发自动建会话：先建好并广播 session_started，
              // 否则前端拿不到 runId（提示词查看等功能依赖它）
              const isAutoCreate = manager.currentRunId === null;
              manager.ensure();
              if (isAutoCreate && manager.currentRunId) {
                broadcast({ type: "session_started", runId: manager.currentRunId });
              }
              await manager.enqueueInput(msg.text);
              broadcast({ type: "turn_done", turn: manager.currentTurn });
              sendStateEvents();
              sendPipeline();
            } else if (msg.type === "command") {
              const data = manager.query(msg.command);
              ws.send(JSON.stringify({ type: msg.command, data } satisfies ServerMessage));
            } else if (msg.type === "new_session") {
              const runId = manager.reset(msg.world_set);
              broadcast({ type: "session_started", runId });
              sendStateEvents(); // 新会话真相层初始态：侧栏立即有内容
              sendPipeline();
            } else if (msg.type === "load_session") {
              const { runId, history } = manager.load(msg.runId);
              broadcast({ type: "session_started", runId });
              broadcast({ type: "history", history });
              sendStateEvents();
              sendPipeline();
            } else if (msg.type === "rollback") {
              await manager.enqueueRollback(msg.seq);
              // 回滚后重新广播历史（对话记录回到目标轮状态；前端先清流区）
              broadcast({ type: "history", history: manager.currentHistory(), replace: true });
              sendStateEvents(); // 事件按 seq 截断、变量反向还原：侧栏缓存同步
              sendPipeline();
            } else if (msg.type === "reroll") {
              await manager.enqueueReroll(msg.seq);
              broadcast({ type: "history", history: manager.currentHistory(), replace: true });
              broadcast({ type: "turn_done", turn: manager.currentTurn });
              sendStateEvents();
              sendPipeline();
            } else if (msg.type === "continue") {
              await manager.enqueueContinue();
              broadcast({ type: "turn_done", turn: manager.currentTurn });
              sendStateEvents();
              sendPipeline();
            } else if (msg.type === "stop") {
              manager.stop(); // 在途任务自行捕获冻结；收尾经原流程的 turn_done/pipeline 广播
            } else if (msg.type === "pause_options") {
              manager.setPauseOptions(msg); // 内存态套用，无需广播（下次状态变化随 pipeline 下发）
            } else if (msg.type === "edit_result") {
              await manager.enqueueEditResult(msg.text);
              const current = manager.ensure().getPipelineCurrent();
              if (current) {
                // 携带 seq+kind+解析后结果：前端按 data 属性寻址原地重渲该卡
                broadcast({ type: "edit_done", kind: current.kind, seq: current.seq, result: current.result });
              }
              sendStateEvents(); // 步编辑整段重放效应：真相层可能已变
              sendPipeline();
            }
          } catch (err) {
            ws.send(
              JSON.stringify({
                type: "error",
                message: err instanceof Error ? err.message : String(err),
              } satisfies ServerMessage),
            );
            // 错误后同步一次流水线状态（如 interrupted 下拒绝继续）
            const info = manager.pipelineInfo;
            if (info) broadcast({ type: "pipeline", ...info });
          }
        })();
      });
    });
  });

  server.listen(port, host, () => {
    console.log(`Agent-AIRP WebUI · http://${host}:${port}（管理 API + 游玩）`);
    if (manager.currentRunId === null) {
      console.log("提示：首次输入玩家意图时会自动创建会话；资源修改后点「新会话」生效。");
    }
  });
  return server;
}

// 直接运行（tsx src/server/index.ts）时启动
const invokedDirectly = process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js");
if (invokedDirectly) {
  startServer();
}
