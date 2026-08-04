/**
 * HTTP/WS 接入边界纯判定。
 *
 * 默认 loopback 模式也检查 Host/Origin 边界，防 DNS rebinding 与任意网页
 * 直接驱动本机管理接口：
 * - Host 头必须等于监听地址或命中 hostWhitelist；监听 loopback 时默认白名单
 *   同时含 localhost / 127.* / [::1] 两种写法（防误伤合法本地访问）；
 * - WS Origin 存在时其 host 必须匹配 Host 头；无 Origin 的非浏览器客户端放行；
 * - ipWhitelist 非空时 remoteAddress 必须命中（"::ffff:" 前缀归一）。
 *
 * 纯函数零 IO：只返回 null（放行）或 {status, message}（拒绝），
 * 拒绝的执行（403 envelope / upgrade 拒绝后 destroy）在 index.ts / ws-transport.ts。
 */
import type { ResolvedServerConfig } from "../serverConfig.js";

/** 一次接入判定所需的请求面（HTTP handler / WS upgrade 各自采集）。 */
export interface AccessInput {
  hostHeader?: string | undefined;
  origin?: string | undefined;
  remoteAddress?: string | undefined;
}

/** 拒绝判定（status 恒 403；message 给客户端的人类可读原因，不含敏感信息）。 */
export interface AccessDeny {
  status: number;
  message: string;
}

/** loopback 判定：localhost / 127.0.0.0/8 / ::1（带不带方括号两种写法）。 */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h.startsWith("127.") || h === "::1" || h === "[::1]";
}

/**
 * 从 Host 头取 hostname（剥端口；IPv6 带方括号写法剥成裸 "::1"）。
 * "127.0.0.1:8787" → "127.0.0.1"；"[::1]:8787" → "::1"；"::1" → "::1"。
 */
function hostNameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(1, end);
  }
  // 多个冒号 = 无方括号 IPv6 字面量，无端口
  return h.indexOf(":") === h.lastIndexOf(":") ? h.split(":")[0]! : h;
}

/** 归一化 IP 白名单比较：剥 "::ffff:" IPv4 映射前缀，小写。 */
function normalizeIp(ip: string): string {
  const h = ip.trim().toLowerCase();
  return h.startsWith("::ffff:") ? h.slice("::ffff:".length) : h;
}

/** Host 头检查：监听地址或白名单命中；loopback 监听附默认白名单（localhost / 127.x / ::1）。 */
function checkHost(hostHeader: string | undefined, cfg: ResolvedServerConfig): AccessDeny | null {
  if (hostHeader === undefined || hostHeader.trim() === "") {
    return { status: 403, message: "缺少 Host 头，拒绝访问" };
  }
  const host = hostNameOf(hostHeader);
  const whitelist = cfg.hostWhitelist.map((entry) => hostNameOf(entry));
  if (host === cfg.listen.host.toLowerCase() || whitelist.includes(host)) return null;
  if (isLoopbackHost(cfg.listen.host) && isLoopbackHost(host)) return null;
  return { status: 403, message: `Host 头 ${JSON.stringify(hostHeader)} 不在白名单，拒绝访问` };
}

/** IP 白名单检查：非空时 remoteAddress 必须命中（归一后精确匹配）。 */
function checkIp(remoteAddress: string | undefined, cfg: ResolvedServerConfig): AccessDeny | null {
  if (cfg.ipWhitelist.length === 0) return null;
  if (remoteAddress === undefined) {
    return { status: 403, message: "无法确定来源 IP 且已配置 ipWhitelist，拒绝访问" };
  }
  const allowed = cfg.ipWhitelist.map(normalizeIp);
  if (allowed.includes(normalizeIp(remoteAddress))) return null;
  return { status: 403, message: "来源 IP 不在 ipWhitelist，拒绝访问" };
}

/**
 * HTTP 接入检查（/api/* 与静态服务同边界）：Host + IP 白名单。
 * 返回 null = 放行；否则 403（调用方走 FORBIDDEN envelope）。
 */
export function checkHttpAccess(input: AccessInput, cfg: ResolvedServerConfig): AccessDeny | null {
  return checkHost(input.hostHeader, cfg) ?? checkIp(input.remoteAddress, cfg);
}

/**
 * WS upgrade 接入检查：Host + IP 白名单 + Origin——Origin 存在时其 host 必须
 * 匹配 Host 头（浏览器跨页驱动防线）；无 Origin 的非浏览器客户端放行。
 */
export function checkWsUpgrade(input: AccessInput, cfg: ResolvedServerConfig): AccessDeny | null {
  const base = checkHttpAccess(input, cfg);
  if (base !== null) return base;
  const origin = input.origin;
  if (origin === undefined || origin.trim() === "") return null;
  let originHost: string;
  try {
    originHost = new URL(origin).hostname.toLowerCase();
  } catch {
    return { status: 403, message: `Origin ${JSON.stringify(origin)} 非法，拒绝 upgrade` };
  }
  if (originHost !== hostNameOf(input.hostHeader!)) {
    return { status: 403, message: `Origin ${JSON.stringify(origin)} 与 Host 头不匹配，拒绝 upgrade` };
  }
  return null;
}
