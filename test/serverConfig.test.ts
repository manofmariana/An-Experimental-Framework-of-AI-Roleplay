/**
 * server.json 加载契约测试（contract 层：文件 codec + 模板资产）。
 * - loadServerConfig：缺文件 = 全默认 loopback；合法文件生效；JSON 损坏抛错；
 *   未实现块逐块 console.warn「已配置但未实现，忽略」；env 参数优先；
 * - server.json.example 模板资产：可被 schema 解析且四个未实现块全部登记。
 * 纯函数判定矩阵在 unit 层（test/accessControl.test.ts）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, mock } from "node:test";
import { PROJECT_ROOT } from "../src/config.js";
import { loadServerConfig, resolveServerConfig } from "../src/serverConfig.js";
import { tempDir } from "./harness/tempDir.js";

describe("loadServerConfig（文件 IO 壳）", () => {
  it("缺文件 → 全默认 loopback 放开", (t) => {
    const dir = tempDir("airp-servercfg-", t);
    const resolved = loadServerConfig(path.join(dir, "server.json"), {});
    assert.deepEqual(resolved.listen, { host: "127.0.0.1", port: 8787 });
    assert.equal(resolved.allowKeysExposure, false);
    assert.deepEqual(resolved.unimplemented, []);
  });

  it("合法文件 → 生效；env（OFAIR_HOST/OFAIR_PORT）优先于 listen 块", (t) => {
    const dir = tempDir("airp-servercfg-", t);
    const file = path.join(dir, "server.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        listen: { host: "0.0.0.0", port: 9000 },
        hostWhitelist: ["ofair.lan"],
        allowKeysExposure: true,
      }),
      "utf8",
    );
    const fromFile = loadServerConfig(file, {});
    assert.deepEqual(fromFile.listen, { host: "0.0.0.0", port: 9000 });
    assert.deepEqual(fromFile.hostWhitelist, ["ofair.lan"]);
    assert.equal(fromFile.allowKeysExposure, true);
    const fromEnv = loadServerConfig(file, { OFAIR_HOST: "127.0.0.2", OFAIR_PORT: "9999" });
    assert.deepEqual(fromEnv.listen, { host: "127.0.0.2", port: 9999 });
  });

  it("JSON 损坏 / 结构非法 → 抛错（启动失败优于带病运行）", (t) => {
    const dir = tempDir("airp-servercfg-", t);
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{bad json", "utf8");
    assert.throws(() => loadServerConfig(bad, {}), /不是合法 JSON/);
    const invalid = path.join(dir, "invalid.json");
    fs.writeFileSync(invalid, JSON.stringify({ allowKeysExposure: "yes" }), "utf8");
    assert.throws(() => loadServerConfig(invalid, {}), /allowKeysExposure/);
  });

  it("已配置但未实现的块 → 逐块 console.warn「已配置但未实现，忽略」", (t) => {
    const dir = tempDir("airp-servercfg-", t);
    const file = path.join(dir, "server.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        basicAuth: { username: "u", password: "p" },
        ssl: { cert: "c", key: "k", passphrase: "x" },
      }),
      "utf8",
    );
    const warn = mock.method(console, "warn", () => {});
    t.after(() => warn.mock.restore());
    const resolved = loadServerConfig(file, {});
    assert.deepEqual(resolved.unimplemented, ["basicAuth", "ssl"]);
    assert.equal(warn.mock.callCount(), 2);
    for (const call of warn.mock.calls) {
      assert.match(String(call.arguments[0]), /已配置但未实现，忽略/);
    }
  });
});

describe("server.json.example 模板资产", () => {
  it("schema 可解析；listen 默认；四个未实现块全部登记", () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, "server.json.example"), "utf8"),
    ) as unknown;
    const resolved = resolveServerConfig(raw, {});
    assert.deepEqual(resolved.listen, { host: "127.0.0.1", port: 8787 });
    assert.equal(resolved.allowKeysExposure, false);
    assert.deepEqual(resolved.unimplemented, ["basicAuth", "ssl", "proxy", "broadcast"]);
  });
});
