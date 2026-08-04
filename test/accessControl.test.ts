/**
 * 接入边界纯判定 + server.json 解析（unit：严格零 IO）。
 * - checkHttpAccess / checkWsUpgrade 判定矩阵：loopback 默认白名单、
 *   hostWhitelist/ipWhitelist 命中与未命中、WS Origin 匹配/不匹配/缺失/非法；
 * - resolveServerConfig：缺省、env（OFAIR_HOST/OFAIR_PORT）优先级、非法输入拒绝、
 *   未实现块登记。
 * 读文件（loadServerConfig）属 contract 层（test/serverConfig.test.ts）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkHttpAccess, checkWsUpgrade } from "../src/server/accessControl.js";
import {
  DEFAULT_LISTEN_HOST,
  DEFAULT_LISTEN_PORT,
  resolveServerConfig,
  type ResolvedServerConfig,
} from "../src/serverConfig.js";

/** 构造解析后配置（缺省 = 全默认 loopback 放开）。 */
function cfg(over?: Partial<ResolvedServerConfig>): ResolvedServerConfig {
  return {
    listen: { host: DEFAULT_LISTEN_HOST, port: DEFAULT_LISTEN_PORT },
    hostWhitelist: [],
    ipWhitelist: [],
    allowKeysExposure: false,
    unimplemented: [],
    ...over,
  };
}

describe("checkHttpAccess：Host 边界", () => {
  it("loopback 监听：默认白名单放行 localhost / 127.* / [::1]（带不带端口两种写法）", () => {
    for (const host of [
      "127.0.0.1:8787",
      "127.0.0.1",
      "localhost:8787",
      "localhost",
      "127.0.1.9:8787",
      "[::1]:8787",
      "[::1]",
      "::1",
    ]) {
      assert.equal(checkHttpAccess({ hostHeader: host }, cfg()), null, `应放行: ${host}`);
    }
  });

  it("loopback 监听：非 loopback Host / 缺 Host 头 → 403", () => {
    for (const input of [
      { hostHeader: "evil.example" },
      { hostHeader: "192.168.1.10:8787" },
      { hostHeader: "" },
      {},
    ]) {
      const denied = checkHttpAccess(input, cfg());
      assert.equal(denied?.status, 403, `应拒绝: ${JSON.stringify(input)}`);
    }
  });

  it("非 loopback 监听：只放行监听地址本身 + hostWhitelist 命中（大小写不敏感、可带端口）", () => {
    const c = cfg({ listen: { host: "0.0.0.0", port: 8787 }, hostWhitelist: ["ofair.lan"] });
    assert.equal(checkHttpAccess({ hostHeader: "0.0.0.0:8787" }, c), null);
    assert.equal(checkHttpAccess({ hostHeader: "ofair.lan" }, c), null);
    assert.equal(checkHttpAccess({ hostHeader: "ofair.lan:8787" }, c), null);
    assert.equal(checkHttpAccess({ hostHeader: "OFAIR.LAN:8787" }, c), null);
    // loopback 默认值不适用于非 loopback 监听
    assert.equal(checkHttpAccess({ hostHeader: "localhost:8787" }, c)?.status, 403);
    assert.equal(checkHttpAccess({ hostHeader: "127.0.0.1:8787" }, c)?.status, 403);
    assert.equal(checkHttpAccess({ hostHeader: "evil.example" }, c)?.status, 403);
  });
});

describe("checkHttpAccess：ipWhitelist", () => {
  it("空白名单 = 不限制（含 remoteAddress 缺失）", () => {
    assert.equal(checkHttpAccess({ hostHeader: "127.0.0.1" }, cfg()), null);
    assert.equal(
      checkHttpAccess({ hostHeader: "127.0.0.1", remoteAddress: "10.1.2.3" }, cfg()),
      null,
    );
  });

  it("非空：命中放行（'::ffff:' 前缀归一），未命中/缺失 → 403", () => {
    const c = cfg({ ipWhitelist: ["10.0.0.1"] });
    const host = { hostHeader: "127.0.0.1" };
    assert.equal(checkHttpAccess({ ...host, remoteAddress: "10.0.0.1" }, c), null);
    assert.equal(checkHttpAccess({ ...host, remoteAddress: "::ffff:10.0.0.1" }, c), null);
    assert.equal(checkHttpAccess({ ...host, remoteAddress: "10.0.0.2" }, c)?.status, 403);
    assert.equal(checkHttpAccess(host, c)?.status, 403);
  });

  it("Host 与 IP 都拒绝时 Host 先报（判定顺序稳定）", () => {
    const c = cfg({ ipWhitelist: ["10.0.0.1"] });
    const denied = checkHttpAccess({ hostHeader: "evil.example", remoteAddress: "10.0.0.2" }, c);
    assert.match(denied!.message, /Host/);
  });
});

describe("checkWsUpgrade：Origin 边界", () => {
  const c = cfg();
  it("Origin host 与 Host 匹配 → 放行；无 Origin（非浏览器客户端）→ 放行", () => {
    assert.equal(
      checkWsUpgrade({ hostHeader: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" }, c),
      null,
    );
    assert.equal(checkWsUpgrade({ hostHeader: "127.0.0.1:8787" }, c), null);
    assert.equal(checkWsUpgrade({ hostHeader: "127.0.0.1:8787", origin: "" }, c), null);
  });

  it("Origin 与 Host 不匹配 / Origin 非法 → 403", () => {
    assert.equal(
      checkWsUpgrade({ hostHeader: "127.0.0.1:8787", origin: "http://evil.example" }, c)?.status,
      403,
    );
    assert.equal(
      checkWsUpgrade({ hostHeader: "127.0.0.1:8787", origin: "http://localhost:8787" }, c)?.status,
      403,
      "origin hostname 必须与 Host hostname 一致（localhost ≠ 127.0.0.1）",
    );
    assert.equal(
      checkWsUpgrade({ hostHeader: "127.0.0.1:8787", origin: "not a url" }, c)?.status,
      403,
    );
    assert.equal(
      checkWsUpgrade({ hostHeader: "127.0.0.1:8787", origin: "null" }, c)?.status,
      403,
    );
  });

  it("Host/IP 拒绝同样生效（与 HTTP 同边界）", () => {
    assert.equal(checkWsUpgrade({ hostHeader: "evil.example" }, c)?.status, 403);
    const withIp = cfg({ ipWhitelist: ["10.0.0.1"] });
    assert.equal(
      checkWsUpgrade({ hostHeader: "127.0.0.1", remoteAddress: "1.2.3.4" }, withIp)?.status,
      403,
    );
  });
});

describe("resolveServerConfig：缺省与 env 优先级", () => {
  it("缺文件（null）= 全默认 loopback 放开", () => {
    assert.deepEqual(resolveServerConfig(null, {}), {
      listen: { host: "127.0.0.1", port: 8787 },
      hostWhitelist: [],
      ipWhitelist: [],
      allowKeysExposure: false,
      unimplemented: [],
    });
  });

  it("文件 listen/白名单/allowKeysExposure 生效；未知顶层字段（注释）透传不拒", () => {
    const resolved = resolveServerConfig(
      {
        _说明: "注释",
        listen: { host: "0.0.0.0", port: 9000 },
        hostWhitelist: ["ofair.lan"],
        ipWhitelist: ["10.0.0.1"],
        allowKeysExposure: true,
      },
      {},
    );
    assert.deepEqual(resolved.listen, { host: "0.0.0.0", port: 9000 });
    assert.deepEqual(resolved.hostWhitelist, ["ofair.lan"]);
    assert.deepEqual(resolved.ipWhitelist, ["10.0.0.1"]);
    assert.equal(resolved.allowKeysExposure, true);
  });

  it("OFAIR_HOST / OFAIR_PORT 优先于 listen 块；空串忽略", () => {
    const resolved = resolveServerConfig(
      { listen: { host: "0.0.0.0", port: 9000 } },
      { OFAIR_HOST: "192.168.1.5", OFAIR_PORT: "1234" },
    );
    assert.deepEqual(resolved.listen, { host: "192.168.1.5", port: 1234 });
    const fallback = resolveServerConfig(
      { listen: { host: "0.0.0.0", port: 9000 } },
      { OFAIR_HOST: "", OFAIR_PORT: "" },
    );
    assert.deepEqual(fallback.listen, { host: "0.0.0.0", port: 9000 });
  });

  it("OFAIR_PORT 非法 → 抛错（不放 NaN 进 listen）", () => {
    assert.throws(() => resolveServerConfig(null, { OFAIR_PORT: "abc" }), /OFAIR_PORT/);
    assert.throws(() => resolveServerConfig(null, { OFAIR_PORT: "70000" }), /OFAIR_PORT/);
    assert.throws(() => resolveServerConfig(null, { OFAIR_PORT: "1.5" }), /OFAIR_PORT/);
  });

  it("结构非法 → 抛错带字段路径", () => {
    assert.throws(() => resolveServerConfig({ listen: { port: 70000 } }, {}), /listen\.port/);
    assert.throws(() => resolveServerConfig({ hostWhitelist: "x" }, {}), /hostWhitelist/);
    assert.throws(() => resolveServerConfig({ allowKeysExposure: "yes" }, {}), /allowKeysExposure/);
    assert.throws(() => resolveServerConfig({ listen: { host: "h", bogus: 1 } }, {}), /listen/);
  });

  it("basicAuth/ssl/proxy/broadcast：接受但登记 unimplemented", () => {
    const resolved = resolveServerConfig(
      {
        basicAuth: { username: "u", password: "p" },
        ssl: { cert: "c", key: "k" },
        proxy: { url: "http://127.0.0.1:7890" },
        broadcast: true,
      },
      {},
    );
    assert.deepEqual(resolved.unimplemented, ["basicAuth", "ssl", "proxy", "broadcast"]);
    // 未配置 → 不登记
    assert.deepEqual(resolveServerConfig({ broadcast: false }, {}).unimplemented, ["broadcast"]);
    assert.deepEqual(resolveServerConfig({}, {}).unimplemented, []);
  });
});
