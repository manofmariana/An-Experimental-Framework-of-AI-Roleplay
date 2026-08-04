/**
 * 接入边界集成测试（integration：真实 HTTP/WS）。
 * harness 注入非默认 serverConfig →
 * - 错 Host / 未命中 ipWhitelist 的 HTTP 请求 → 403 FORBIDDEN envelope（/api/* 与静态同边界）；
 * - WS upgrade：Origin 与 Host 不匹配 → 403 拒绝；无 Origin / 匹配 Origin → 放行；
 * - allowKeysExposure=true → secrets view 返回明文；false → 403 FORBIDDEN。
 * 全部资源目录经 harness 注入临时根，不触碰真实用户数据。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { describe, it } from "node:test";
import WebSocket from "ws";
import { resolveServerConfig, type ResolvedServerConfig } from "../src/serverConfig.js";
import { serverHarness, type ServerHarness } from "./harness/server.js";

/** 注入用配置基座：默认 loopback 放开 + 覆盖项。 */
function cfg(over?: Partial<ResolvedServerConfig>): ResolvedServerConfig {
  return { ...resolveServerConfig(null, {}), ...over };
}

/** 原始 GET（可自定义 Host 等头）；返回 {status, json}。 */
function rawGet(
  port: number,
  path_: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: { ok: boolean; error?: { code: string } } }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: path_, method: "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              ok: boolean;
              error?: { code: string };
            },
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** WS upgrade 探测：'open' 或 HTTP 拒绝状态码。 */
function wsUpgrade(
  port: number,
  headers: Record<string, string> = {},
): Promise<number | "open"> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    ws.on("open", () => {
      ws.close();
      resolve("open");
    });
    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    ws.on("error", reject);
  });
}

/** 经 legacy config.json 迁移种子一把 deepseek key，返回其 id。 */
async function seedSecret(h: ServerHarness, key: string): Promise<string> {
  fs.writeFileSync(h.configFile, JSON.stringify({ api_key: key, model: "m" }), "utf8");
  const resp = await rawGet(h.port, "/api/config");
  assert.equal(resp.status, 200);
  const data = (resp.json as unknown as { data: { secrets: { deepseek: { id: string }[] } } })
    .data;
  return data.secrets.deepseek[0]!.id;
}

describe("HTTP 接入边界（Host / IP 白名单）", () => {
  it("默认 loopback：127.0.0.1/localhost Host 放行；错 Host → 403 FORBIDDEN envelope", async (t) => {
    const h = await serverHarness(t);
    const okLocal = await rawGet(h.port, "/api/config", { Host: "localhost" });
    assert.equal(okLocal.status, 200);
    const denied = await rawGet(h.port, "/api/config", { Host: "evil.example" });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.ok, false);
    assert.equal(denied.json.error?.code, "FORBIDDEN");
    // 静态服务同边界
    const deniedStatic = await rawGet(h.port, "/", { Host: "evil.example" });
    assert.equal(deniedStatic.status, 403);
  });

  it("hostWhitelist 命中放行；ipWhitelist 未命中 → 403", async (t) => {
    const h = await serverHarness(t, {
      serverConfig: cfg({ hostWhitelist: ["ofair.lan"], ipWhitelist: ["127.0.0.1"] }),
    });
    assert.equal((await rawGet(h.port, "/api/config", { Host: "ofair.lan:8787" })).status, 200);
    assert.equal((await rawGet(h.port, "/api/config", { Host: "other.lan" })).status, 403);
    // ipWhitelist 只放 127.0.0.1：本机请求经 ::ffff:127.0.0.1 归一后命中
    assert.equal((await rawGet(h.port, "/api/config")).status, 200);
  });

  it("ipWhitelist 不含本机 → 一律 403", async (t) => {
    const h = await serverHarness(t, { serverConfig: cfg({ ipWhitelist: ["10.9.9.9"] }) });
    assert.equal((await rawGet(h.port, "/api/config")).status, 403);
    assert.equal(await wsUpgrade(h.port), 403);
  });
});

describe("WS upgrade 接入边界（Origin）", () => {
  it("无 Origin（非浏览器客户端）→ 放行；匹配 Origin → 放行", async (t) => {
    const h = await serverHarness(t);
    assert.equal(await wsUpgrade(h.port), "open");
    assert.equal(
      await wsUpgrade(h.port, { Origin: `http://127.0.0.1:${h.port}` }),
      "open",
    );
  });

  it("Origin 与 Host 不匹配 → 403 拒绝", async (t) => {
    const h = await serverHarness(t);
    assert.equal(await wsUpgrade(h.port, { Origin: "http://evil.example" }), 403);
    // localhost 与 127.0.0.1 互不相同（hostname 精确匹配）
    assert.equal(await wsUpgrade(h.port, { Origin: "http://localhost:8787" }), 403);
  });
});

describe("allowKeysExposure → secrets view", () => {
  it("true → 返回明文；false（默认）→ 403 FORBIDDEN", async (t) => {
    const key = "sk-e4-plaintext-7777";
    const open = await serverHarness(t, { serverConfig: cfg({ allowKeysExposure: true }) });
    const openId = await seedSecret(open, key);
    const view = await rawGet(open.port, `/api/secrets/deepseek/${openId}/view`);
    assert.equal(view.status, 200);
    const value = (view.json as unknown as { data: { value: string } }).data.value;
    assert.equal(value, key);

    const closed = await serverHarness(t);
    const closedId = await seedSecret(closed, key);
    const denied = await rawGet(closed.port, `/api/secrets/deepseek/${closedId}/view`);
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error?.code, "FORBIDDEN");
    assert.ok(!JSON.stringify(denied.json).includes(key), "403 响应不得含明文 key");
  });
});
