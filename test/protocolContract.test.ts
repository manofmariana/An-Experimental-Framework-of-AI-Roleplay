/**
 * WS 入站协议契约测试（contract 层，优化阶段 D1「协议单一来源」）：
 * ① fixture 驱动：test/fixtures/protocol/inbound/ 下每命令 ≥1 合法 + ≥1 非法 JSON，
 *    逐个经 parseClientCommand 断言通过 / ProtocolError；
 * ② 双向对拍：web/protocol.js 的 buildCommand 产物 × 命令清单，全部被服务端
 *    ClientCommandSchema 接受（无代码生成，两侧独立维护、测试保证兼容）；
 * ③ buildCommand 字段白名单：未知命令/未知字段前端侧即抛错。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ClientCommandSchema,
  parseClientCommand,
  ProtocolError,
} from "../src/contracts/protocol.js";
import { buildCommand, serialize } from "../web/protocol.js";

const FIXTURE_DIR = path.join(process.cwd(), "test/fixtures/protocol/inbound");

/** schema 权威命令清单（从 discriminated union 选项导出，新增命令自动纳入覆盖断言）。 */
const COMMAND_TYPES = ClientCommandSchema.options.map((o) => o.shape.type.value as string);

function fixtures(suffix: ".valid.json" | ".invalid.json"): string[] {
  return fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(suffix)).sort();
}

/** fixture 文件名前缀 → 命令类型（player_input.empty-text.invalid.json → player_input）。 */
function fixtureType(file: string): string {
  return file.split(".")[0] ?? "";
}

describe("parseClientCommand fixture 驱动（合法/非法逐条断言）", () => {
  it("合法 fixture 全部解析通过且与文件 JSON 一致", () => {
    const files = fixtures(".valid.json");
    assert.ok(files.length >= COMMAND_TYPES.length, "合法 fixture 不足");
    for (const file of files) {
      const raw = fs.readFileSync(path.join(FIXTURE_DIR, file), "utf8").trim();
      assert.deepEqual(parseClientCommand(raw), JSON.parse(raw), `合法 fixture 应通过: ${file}`);
    }
  });

  it("非法 fixture 全部抛 ProtocolError（稳定 message 前缀，无原生异常泄漏）", () => {
    const files = fixtures(".invalid.json");
    assert.ok(files.length >= COMMAND_TYPES.length, "非法 fixture 不足");
    for (const file of files) {
      const raw = fs.readFileSync(path.join(FIXTURE_DIR, file), "utf8").trim();
      assert.throws(
        () => parseClientCommand(raw),
        (err: unknown) => err instanceof ProtocolError && /^协议错误: .+/.test(err.message),
        `非法 fixture 应抛 ProtocolError: ${file}`,
      );
    }
  });

  it("覆盖矩阵：每个命令类型 ≥1 合法 + ≥1 非法 fixture", () => {
    const valid = new Set(fixtures(".valid.json").map(fixtureType));
    const invalid = new Set(fixtures(".invalid.json").map(fixtureType));
    for (const type of COMMAND_TYPES) {
      assert.ok(valid.has(type), `${type} 缺合法 fixture`);
      assert.ok(invalid.has(type), `${type} 缺非法 fixture`);
    }
  });
});

describe("web/protocol.js buildCommand × 服务端 schema 对拍", () => {
  /** 每命令一组合法字段（与服务端 schema 同步演进；漂移时此处红）。 */
  const VALID_FIELDS: Record<string, Record<string, unknown>> = {
    player_input: { text: "我推开门。" },
    continue: {},
    rollback: { targetSeq: 3 },
    rollback_and_continue: { targetSeq: 4 },
    edit_result: { text: "{\"inner\":\"再观察一下\"}" },
    new_session: { worldSetId: "baitan" },
    load_session: { runId: "000001" },
    pause_options: { options: { everyStep: true, beforeGm: false, afterGm: true, afterProse: false } },
    stop: {},
    query: { query: "snapshot" },
  };

  it("buildCommand 产物全部被服务端 schema 接受（序列化往返一致）", () => {
    assert.deepEqual(
      Object.keys(VALID_FIELDS).sort(),
      [...COMMAND_TYPES].sort(),
      "对拍清单与 schema 命令集必须一致",
    );
    for (const type of COMMAND_TYPES) {
      const cmd = buildCommand(type, VALID_FIELDS[type]);
      const parsed = parseClientCommand(serialize(cmd));
      assert.deepEqual(parsed, JSON.parse(serialize(cmd)), `${type} 应被服务端接受`);
    }
  });

  it("new_session 省略 worldSetId 同样合法（缺省世界设定集）", () => {
    assert.deepEqual(parseClientCommand(serialize(buildCommand("new_session"))), { type: "new_session" });
  });

  it("buildCommand 白名单：未知命令类型 / 白名单外字段即抛错", () => {
    assert.throws(() => buildCommand("reroll", { seq: 4 }), /未知命令类型/);
    assert.throws(() => buildCommand("continue", { seq: 2 }), /不支持字段/);
    assert.throws(() => buildCommand("pause_options", { every_step: true }), /不支持字段/);
  });

  it("protocol.js 纯 ESM 零 DOM（node 环境直接 import 即证明；源码再防回归）", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "web/protocol.js"), "utf8");
    assert.doesNotMatch(source, /\b(document|window|localStorage|WebSocket)\b/);
  });
});
