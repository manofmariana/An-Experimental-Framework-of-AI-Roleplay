/**
 * WebUI 服务组成根：只装配依赖并启动——WsTransport（连接/字节）+
 * WsController（协议解析 → Coordinator → 回复成形）+ createApiHandler（/api/* envelope）
 * + serveStatic（web/）；Coordinator 的 displayFactory/onTransition 重绑到本服广播。
 * 装配 configService 依赖（dirs + env + legacyConfigFile 迁移闸 + 热应用回调 =
 * Coordinator.applyResolvedConfig 转发）注入 HTTP 三配置域路由。
 * server.json（loadServerConfig）→ 接入边界（HTTP handler 与 WS upgrade 入口过
 * accessControl 纯判定，拒绝 → 403）+ allowKeysExposure 注入 ApiDeps；options 注入优先
 * （harness 用），OFAIR_HOST/OFAIR_PORT 优先于 listen 块。
 * 可注入 {host, port, coordinator, dirs, configFile, serverConfigFile, serverConfig}
 * （测试基建；缺省走 env/生产现状）。
 */
import http from "node:http";
import type { ConfigServiceDeps } from "../application/configService.js";
import { SessionCoordinator } from "../application/sessionCoordinator.js";
import { CONFIG_FILE } from "../config.js";
import { resolveUserDirectories, type UserDirectories } from "../resources/userDirectories.js";
import { loadServerConfig, type ResolvedServerConfig } from "../serverConfig.js";
import { checkHttpAccess, checkWsUpgrade } from "./accessControl.js";
import { WebDisplay } from "./display.js";
import { ApiError, toApiError } from "./http/errors.js";
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
  /** 测试注入临时资源目录（assets/save + 三配置资源），不触碰真实用户数据 */
  dirs?: UserDirectories;
  /** 旧 config.json 路径（迁移闸读取源；测试注入临时路径） */
  configFile?: string;
  /** server.json 路径（缺省项目根 server.json；测试注入临时路径防读真实文件） */
  serverConfigFile?: string;
  /** 直接注入解析后的服务端配置（跳过文件读取与 env 合成，测试基建用） */
  serverConfig?: ResolvedServerConfig;
}

export function startServer(options?: StartServerOptions): http.Server {
  // 服务端部署配置（options 注入 > env OFAIR_HOST/OFAIR_PORT > server.json listen > 默认）
  const serverConfig =
    options?.serverConfig ?? loadServerConfig(options?.serverConfigFile);
  const host = options?.host ?? serverConfig.listen.host;
  const port = options?.port ?? serverConfig.listen.port;

  // 威胁模型：配置里有 API key，只应绑 loopback
  const isLoopback =
    host === "localhost" || host.startsWith("127.") || host === "::1" || host === "[::1]";
  if (!isLoopback) {
    console.warn(`[警告] 正在绑定非 loopback 地址 ${host}——config.json 含 API key，公网暴露有风险！`);
    if (serverConfig.hostWhitelist.length === 0 && serverConfig.ipWhitelist.length === 0) {
      console.warn(
        "[警告] server.json 未配置 hostWhitelist/ipWhitelist——任何可达该地址的主机都能驱动管理接口",
      );
    } else {
      console.log(
        `接入边界：hostWhitelist=[${serverConfig.hostWhitelist.join(", ")}] ipWhitelist=[${serverConfig.ipWhitelist.join(", ")}]`,
      );
    }
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

  // 配置事务依赖：三资源路径 + 迁移闸 + 热应用回调（同一份 resolved 转发运行中会话）
  const dirs = options?.dirs ?? resolveUserDirectories();
  const configDeps: ConfigServiceDeps = {
    dirs,
    env: process.env,
    legacyConfigFile: options?.configFile ?? CONFIG_FILE,
    applyResolved: (resolved, settings) => coordinator.applyResolvedConfig(resolved, settings),
  };

  const handleApi = createApiHandler({
    coordinator,
    dirs,
    config: configDeps,
    // secrets view 明文开关由服务端配置持有（缺省 false → 403）
    allowKeysExposure: serverConfig.allowKeysExposure,
  });

  const server = http.createServer((req, res) => {
    // 接入边界：Host/IP 白名单不过 → 403 envelope（/api/* 与静态服务同边界）
    const denied = checkHttpAccess(
      {
        hostHeader: req.headers.host,
        origin: req.headers.origin,
        remoteAddress: req.socket.remoteAddress,
      },
      serverConfig,
    );
    if (denied !== null) {
      sendFailure(res, new ApiError(denied.status, "FORBIDDEN", denied.message));
      return;
    }
    void (async () => {
      if (await handleApi(req, res)) return;
      serveStatic(res, new URL(req.url ?? "/", "http://localhost").pathname);
    })().catch((err) => sendFailure(res, toApiError(err)));
  });
  // 接入边界：WS upgrade 加 Origin 检查（拒绝 → 403 响应后 destroy）
  transport.attach(server, (req) =>
    checkWsUpgrade(
      {
        hostHeader: req.headers.host,
        origin: req.headers.origin,
        remoteAddress: req.socket.remoteAddress,
      },
      serverConfig,
    ),
  );

  server.listen(port, host, () => {
    const address = server.address();
    const actual = typeof address === "object" && address !== null ? address.port : port;
    console.log(`Ofair WebUI · http://${host}:${actual}（管理 API + 游玩）`);
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
