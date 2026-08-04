/**
 * 静态文件服务（D3 从 index.ts 原样搬出）：伺服 web/，拒目录穿越。
 */
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { PROJECT_ROOT } from "../config.js";

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
export function serveStatic(res: http.ServerResponse, pathname: string): void {
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
