/**
 * HTTP 响应与请求体工具（优化阶段 D3，docs/optimization-review.md §9「HTTP envelope」）。
 *
 * 全部 /api/* 响应统一外围结构：
 *   成功 { ok: true, data }（mutation 的 note/revision 等信息放 data 内）；
 *   失败 { ok: false, error: { code, message, details? } }。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError } from "./errors.js";

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}

/** 写 JSON 响应（可选额外头，如 405 的 Allow）。 */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

/** 成功应答（envelope 包裹）。 */
export function sendOk(res: ServerResponse, data: unknown, status = 200): void {
  const body: ApiSuccess<unknown> = { ok: true, data };
  sendJson(res, status, body);
}

/** 失败应答（envelope 包裹 + 可选头）。 */
export function sendFailure(
  res: ServerResponse,
  err: ApiError,
  headers?: Record<string, string>,
): void {
  const body: ApiFailure = {
    ok: false,
    error: {
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    },
  };
  sendJson(res, err.status, body, headers);
}

/** 读请求体全文。 */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 解析 JSON 请求体；非法 JSON → 400 BAD_JSON。 */
export function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new ApiError(400, "BAD_JSON", "请求体不是合法 JSON");
  }
}

/** 取请求体的字符串字段（缺失/类型不符 → 400 VALIDATION_ERROR）。 */
export function requireStringField(obj: unknown, field: string): string {
  const value = (obj as Record<string, unknown>)?.[field];
  if (typeof value !== "string") {
    throw new ApiError(400, "VALIDATION_ERROR", `请求体缺少字符串字段: ${field}`);
  }
  return value;
}
