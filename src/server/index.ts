/**
 * WebUI 服务组成根（优化阶段 D3）：只装配依赖并启动——WsTransport（连接/字节）+
 * WsController（协议解析 → Coordinator → 回复成形）+ createApiHandler（/api/* envelope）
 * + serveStatic（web/）；Coordinator 的 displayFactory/onTransition 重绑到本服广播。
 * 可注入 {host, port, coordinator, dirs, configFile}（测试基建；缺省走 env/生产现状）。
 */
import http from "node:http";
import { SessionCoordinator } from "../application/sessionCoordinator.js";
import { CONFIG_FILE } from "../config.js";
import { resolveUserDirectories, type UserDirectories } from "../resources/userDirectories.js";
import { WebDisplay } from "./display.js";
import { toApiError } from "./http/errors.js";
import { createApiHandler } from "./http/router.js";
import { sendFailure } from "./http/response.js";
import { serveStatic } from "./static.js";
import { WsController } from "./ws-controller.js";
import { WsTransport } from "./ws-transport.js";

/** 可注入启动参数（测试基建：coordinator/dirs/configFile + 随机端口；缺省走 env/生产现状）。 */
export interface StartServerOptions {
  host?: string;
  port?: number;
  coordinator?: SessionCoordinator;
  /** 测试注入临时资源目录（runs/worlds/prompts），不触碰真实用户数据 */
  dirs?: UserDirectories;
  configFile?: string;
}

export function startServer(options?: StartServerOptions): http.Server {
  const host = options?.host ?? process.env.AIRP_HOST ?? "127.0.0.1";
  const port = options?.port ?? Number(process.env.AIRP_PORT ?? 8787);

  // 威胁模型：配置里有 API key，只应绑 loopback
  const isLoopback = host === "localhost" || host.startsWith("127.") || host === "::1";
  if (!isLoopback) {
    console.warn(`[警告] 正在绑定非 loopback 地址 ${host}——config.json 含 API key，公网暴露有风险！`);
  }

  const transport = new WsTransport();
  const coordinator =
    options?.coordinator ??
    new SessionCoordinator((runId) => new WebDisplay(runId, (msg) => transport.broadcast(msg)));
  // 显示层重绑到本服广播（注入 coordinator 同样生效；WebDisplay 按 runId 绑定消息身份）
  coordinator.displayFactory = (runId) => new WebDisplay(runId, (msg) => transport.broadcast(msg));
  // 每次提交一条 Transition（onCommit 钩子驱动）
  coordinator.onTransition = (transition) => transport.broadcast(transition);

  const controller = new WsController(coordinator, transport);
  transport.onConnect = (ws) => controller.onConnect(ws);
  transport.onMessage = (raw, ws) => controller.onMessage(raw, ws);

  const handleApi = createApiHandler({
    coordinator,
    dirs: options?.dirs ?? resolveUserDirectories(),
    configFile: options?.configFile ?? CONFIG_FILE,
  });

  const server = http.createServer((req, res) => {
    void (async () => {
      if (await handleApi(req, res)) return;
      serveStatic(res, new URL(req.url ?? "/", "http://localhost").pathname);
    })().catch((err) => sendFailure(res, toApiError(err)));
  });
  transport.attach(server);

  server.listen(port, host, () => {
    const address = server.address();
    const actual = typeof address === "object" && address !== null ? address.port : port;
    console.log(`Agent-AIRP WebUI · http://${host}:${actual}（管理 API + 游玩）`);
    if (options?.coordinator === undefined && coordinator.currentRunId === null) {
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
