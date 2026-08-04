/**
 * HTTP API 路由表。
 *
 * 轻量路由：{method, pattern, handler} 表 + `:param` 段匹配，不引入框架。
 * 判定顺序：先匹配路径（跨 method）——路径无匹配 → 404 UNKNOWN_ENDPOINT；
 * 路径有匹配但 method 无 → 405 METHOD_NOT_ALLOWED + Allow 头。
 * handler 返回 data → 200 {ok:true,data}；抛错 → toApiError 收敛 → envelope 失败响应。
 * 路由表组装（createApiHandler）是本模块对各分域 routes 的唯一收口。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConfigServiceDeps } from "../../application/configService.js";
import type { SessionCoordinator } from "../../application/sessionCoordinator.js";
import type { UserDirectories } from "../../resources/userDirectories.js";
import { ApiError, toApiError } from "./errors.js";
import { sendFailure, sendOk } from "./response.js";
import { activeSessionRoutes } from "./routes/activeSession.js";
import { characterRoutes } from "./routes/characters.js";
import { configRoutes } from "./routes/config.js";
import { presetRoutes } from "./routes/presets.js";
import { promptRoutes } from "./routes/prompts.js";
import { secretRoutes } from "./routes/secrets.js";
import { sessionRoutes } from "./routes/sessions.js";
import { worldRoutes } from "./routes/worlds.js";

/** 路由依赖（组成根 index.ts 注入；测试经 serverHarness 注入临时目录/fake 协调器）。 */
export interface ApiDeps {
  coordinator: SessionCoordinator;
  dirs: UserDirectories;
  /** 配置事务依赖（config/secrets/presets 三域共用；含迁移闸路径与热应用回调） */
  config: ConfigServiceDeps;
  /** 明文密钥暴露开关（组成根从 server.json 注入；缺省/false → secrets view 403） */
  allowKeysExposure?: boolean;
}

export interface RouteContext {
  req: IncomingMessage;
  url: URL;
  params: Record<string, string>;
  deps: ApiDeps;
}

export type RouteHandler = (ctx: RouteContext) => unknown | Promise<unknown>;

export interface Route {
  method: string;
  /** "/api/sessions/:id/:kind" 形态；`:name` 段捕获进 params */
  pattern: string;
  handler: RouteHandler;
}

function splitSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

/** 段级匹配：字面段相等，`:param` 段捕获。段数不等即不匹配。 */
function matchPattern(pattern: string, pathSegs: string[]): Record<string, string> | null {
  const patternSegs = splitSegments(pattern);
  if (patternSegs.length !== pathSegs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegs.length; i++) {
    const p = patternSegs[i]!;
    const seg = decodeURIComponent(pathSegs[i]!);
    if (p.startsWith(":")) {
      params[p.slice(1)] = seg;
    } else if (p !== seg) {
      return null;
    }
  }
  return params;
}

/**
 * 组装 /api/* 处理器。返回 true = 已处理（/api/* 路径），false = 非 API 路径（交静态服务）。
 * 写操作生效规则：config/secrets/presets 域走配置事务热应用立即生效；world/character 域
 * markStale 后下次 new_session 生效；prompts 域热加载下一轮生效。
 */
export function createApiHandler(
  deps: ApiDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const routes: Route[] = [
    ...configRoutes(deps),
    ...secretRoutes(deps),
    ...presetRoutes(deps),
    ...worldRoutes(deps),
    ...characterRoutes(deps),
    ...promptRoutes(deps),
    ...sessionRoutes(deps),
    ...activeSessionRoutes(deps),
  ];

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    if (!pathname.startsWith("/api/")) return false;

    const method = req.method ?? "GET";
    const pathSegs = splitSegments(pathname);
    const pathMatches: { route: Route; params: Record<string, string> }[] = [];
    for (const route of routes) {
      const params = matchPattern(route.pattern, pathSegs);
      if (params !== null) pathMatches.push({ route, params });
    }

    if (pathMatches.length === 0) {
      sendFailure(res, new ApiError(404, "UNKNOWN_ENDPOINT", `未知端点: ${method} ${pathname}`));
      return true;
    }
    const found = pathMatches.find((m) => m.route.method === method);
    if (found === undefined) {
      const allow = [...new Set(pathMatches.map((m) => m.route.method))].join(", ");
      sendFailure(
        res,
        new ApiError(405, "METHOD_NOT_ALLOWED", `方法不允许: ${method} ${pathname}（Allow: ${allow}）`),
        { Allow: allow },
      );
      return true;
    }

    try {
      const data = await found.route.handler({ req, url, params: found.params, deps });
      sendOk(res, data ?? {});
    } catch (err) {
      sendFailure(res, toApiError(err));
    }
    return true;
  };
}
