import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CharacterManifestSchema } from "../src/agents/character.js";
import { resolveWorldDir } from "../src/config.js";
import { loadWorldTime, renderTimeHeader } from "../src/truth/timeStore.js";

describe("白滩镇统一角色数据", () => {
  it("C0 与 C1001-3 manifest 同构、relations 空、无 voice/persona", () => {
    const dir = resolveWorldDir("baitan");
    const files = [path.join(dir, "player.json"), ...fs.readdirSync(path.join(dir, "characters")).filter((file) => file.endsWith(".json")).sort().map((file) => path.join(dir, "characters", file))];
    const manifests = files.map((file) => CharacterManifestSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))));
    assert.deepEqual(manifests.map((item) => item.timer), [0, 0, 10, 60]);
    for (const item of manifests) { assert.deepEqual(item.relations, []); assert.equal("persona" in item, false); assert.equal("voice_anchor" in item, false); }
  });
  it("time.json start 是结构世界初始时间，支持年月日时段", () => {
    const config = loadWorldTime(resolveWorldDir("baitan")); assert.equal(renderTimeHeader(config.start, config), "0年1月1日·深夜");
  });
  it("lorebook 已删除 npc_laozhou", () => {
    const entries = JSON.parse(fs.readFileSync(path.join(resolveWorldDir("baitan"), "lorebook.json"), "utf8")) as { id: string }[];
    assert.equal(entries.some((entry) => entry.id === "npc_laozhou"), false);
  });
});
