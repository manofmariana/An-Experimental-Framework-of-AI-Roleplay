/**
 * 服务端/部署配置。
 *
 * server.json（项目根，已 gitignore，模板 server.json.example）只管部署面：
 * listen / Host 白名单 / IP 白名单 / allowKeysExposure；用户 API preset 与
 * secret 在 data/<username>/ 三资源，不进入本文件。
 *
 * 优先级：resolveServerConfig 纯函数内 env（OFAIR_HOST/OFAIR_PORT）> listen 块
 * > 默认；缺文件 = 全默认 loopback 放开（127.0.0.1:8787、空白名单 = 不限制、
 * allowKeysExposure=false）。影响监听的配置需重启生效，不声称热更新。
 *
 * basicAuth/ssl/proxy/broadcast 四块：接受配置但加载时 console.warn
 * 「已配置但未实现，忽略」——不做半成品假安全。理由：
 * - basicAuth：浏览器 WebSocket 无法携带 Authorization 头，凭证需要
 *   cookie/session 设计，仅 HTTP 拦 Basic 会留 WS 缺口；
 * - ssl：需要 https server 分叉，超出本地应用可行性边界；
 * - proxy/broadcast：本期无消费方。
 */
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./config.js";
import { ServerConfigSchema, type ServerConfig } from "./contracts/config.js";

/** server.json 默认位置（项目根；已 gitignore——防用户放入凭证后误提交）。 */
export const SERVER_CONFIG_FILE = path.join(PROJECT_ROOT, "server.json");

export const DEFAULT_LISTEN_HOST = "127.0.0.1";
export const DEFAULT_LISTEN_PORT = 8787;

/** 本期接受但未实现的配置块（加载时逐块 warn「忽略」）。 */
const UNIMPLEMENTED_BLOCKS = ["basicAuth", "ssl", "proxy", "broadcast"] as const;

/** 解析后的服务端配置（缺省全填好；unimplemented 记录已配置但未实现的块名）。 */
export interface ResolvedServerConfig {
  listen: { host: string; port: number };
  hostWhitelist: string[];
  ipWhitelist: string[];
  allowKeysExposure: boolean;
  /** 已配置但本期未实现的块名（basicAuth/ssl/proxy/broadcast 子集），供启动 warn。 */
  unimplemented: string[];
}

/**
 * 解析 server.json 载荷（纯函数，可单测）：raw = null 表示缺文件 → 全默认。
 * env 的 OFAIR_HOST/OFAIR_PORT 优先于 listen 块（与现状一致）；OFAIR_PORT 非
 * 0-65535 整数即抛错（不比 Number() 出 NaN 悄悄进 listen 更好）。结构非法抛
 * Error（逐 issue 路径 + 原因）。
 */
export function resolveServerConfig(
  raw: unknown | null,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedServerConfig {
  let file: ServerConfig = {};
  if (raw !== null) {
    const result = ServerConfigSchema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join(".") || "(顶层)"}: ${issue.message}`)
        .join("；");
      throw new Error(`server.json 校验失败：${issues}`);
    }
    file = result.data;
  }

  let host = file.listen?.host ?? DEFAULT_LISTEN_HOST;
  let port = file.listen?.port ?? DEFAULT_LISTEN_PORT;
  if (env.OFAIR_HOST !== undefined && env.OFAIR_HOST !== "") host = env.OFAIR_HOST;
  if (env.OFAIR_PORT !== undefined && env.OFAIR_PORT !== "") {
    const parsed = Number(env.OFAIR_PORT);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      throw new Error(`环境变量 OFAIR_PORT 非法: ${JSON.stringify(env.OFAIR_PORT)}（须为 0-65535 整数）`);
    }
    port = parsed;
  }

  const unimplemented = UNIMPLEMENTED_BLOCKS.filter((key) => file[key] !== undefined);
  return {
    listen: { host, port },
    hostWhitelist: file.hostWhitelist ?? [],
    ipWhitelist: file.ipWhitelist ?? [],
    allowKeysExposure: file.allowKeysExposure ?? false,
    unimplemented,
  };
}

/**
 * 加载 server.json（IO 壳）：缺文件 → 全默认 loopback；JSON 损坏/结构非法 → 抛错
 * （启动失败优于带病运行）。已配置但未实现的块逐块 console.warn「忽略」。
 */
export function loadServerConfig(
  filePath: string = SERVER_CONFIG_FILE,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedServerConfig {
  if (!fs.existsSync(filePath)) return resolveServerConfig(null, env);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(`server.json 不是合法 JSON: ${filePath}`);
  }
  const resolved = resolveServerConfig(raw, env);
  for (const block of resolved.unimplemented) {
    console.warn(`[server.json] 配置块 ${block} 已配置但未实现，忽略（不做半成品假安全）`);
  }
  return resolved;
}
