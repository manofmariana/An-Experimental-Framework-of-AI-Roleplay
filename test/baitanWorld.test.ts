import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CharacterManifestSchema } from "../src/agents/character.js";
import { resolveWorldDir } from "../src/config.js";
import { defaultWorldTimeInstance, readWorldTime, renderTimeHeader } from "../src/vars/systemWorld.js";

describe("白滩镇统一角色数据", () => {
  it("C0 与 C1001-3 manifest 同构、relations 空、无 voice/persona", () => {
    const dir = resolveWorldDir("baitan");
    const files = [path.join(dir, "player.json"), ...fs.readdirSync(path.join(dir, "characters")).filter((file) => file.endsWith(".json")).sort().map((file) => path.join(dir, "characters", file))];
    const manifests = files.map((file) => CharacterManifestSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))));
    assert.deepEqual(manifests.map((item) => item.timer), [0, 0, 10, 60]);
    for (const item of manifests) { assert.deepEqual(item.relations, []); assert.equal("persona" in item, false); assert.equal("voice_anchor" in item, false); }
  });
  it("初始时间 = world.time 系统分支实例（time.json 已删除；新档 = 代码缺省，世界作者经状态直编调整）", () => {
    assert.equal(fs.existsSync(path.join(resolveWorldDir("baitan"), "time.json")), false, "世界包不再携带 time.json");
    const { anchor, periods } = readWorldTime({ time: defaultWorldTimeInstance() });
    assert.equal(renderTimeHeader(anchor, periods), "0年1月1日·夜晚");
  });
  it("lores.json 已删除 npc_laozhou（条目 = 全末端外壳，tags 落在 content 末端）", () => {
    const entries = JSON.parse(fs.readFileSync(path.join(resolveWorldDir("baitan"), "lores.json"), "utf8")) as { id: { value: string } }[];
    assert.equal(entries.some((entry) => entry.id.value === "npc_laozhou"), false);
  });
});
