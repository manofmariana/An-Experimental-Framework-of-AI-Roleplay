import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  LLM_RECENT_WINDOW,
  agentSlug,
  readRecent,
  recordRecent,
} from "../src/llm/recent.js";

describe("llm-recent（存档 v2 文件 6：每 agent 最近 5 轮滚动窗）", () => {
  it("agentSlug：非法字符转连字符", () => {
    assert.equal(agentSlug("character:C1001"), "character-C1001");
    assert.equal(agentSlug("gm"), "gm");
  });

  it("recordRecent 滚动窗口：只保留最近 5 条；readRecent 读回", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airp-recent-"));
    for (let seq = 1; seq <= 7; seq++) {
      recordRecent("t1", "character:C1001", {
        seq,
        messages: [{ role: "system", content: `第${seq}轮` }],
        reasoning: seq % 2 === 0 ? `思维${seq}` : "",
      }, dir);
    }
    assert.ok(fs.existsSync(path.join(dir, "llm-recent", "character-C1001.json")));

    const entries = readRecent("t1", "character:C1001", dir);
    assert.equal(entries.length, LLM_RECENT_WINDOW);
    assert.deepEqual(
      entries.map((e) => e.seq),
      [3, 4, 5, 6, 7], // 1、2 已轮换出窗
    );
    assert.equal(entries[1]!.reasoning, "思维4");
    // 不同 agent 各自一文件
    assert.deepEqual(readRecent("t1", "gm", dir), []);
  });
});
