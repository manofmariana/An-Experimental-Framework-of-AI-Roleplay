import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { CharacterManifest } from "../src/agents/character.js";
import { CharactersStore } from "../src/truth/charactersStore.js";
import { tempDir } from "./harness/tempDir.js";

const manifest = (id = "C1001", isPlayer = false): CharacterManifest => ({
  id, name: "林雾", gender: "女", age: "26", personality: "寡言谨慎。", tags: [], reaction: 5,
  location: { name: "灯塔", level: 1 }, timer: 60, group: 0, initiative: null, channel: null, acted: false,
  level: 2, isPlayer, relations: {}, initial_memories: ["记忆"], vars: {},
});
describe("CharactersStore 同构角色文件", () => {
  it("无 gm key、无 persona/voice，timer=start绝对分钟+偏移", () => {
    const dir = tempDir("airp-chars-"); const store = CharactersStore.initFrom("t", [manifest()], 1000, dir);
    const state = store.get("C1001"); assert.equal(state.timer, 1060); assert.equal(state.personality, "寡言谨慎。");
    assert.equal("gm" in store.all(), false); assert.equal("persona" in state, false); assert.equal("voice_anchor" in state, false);
  });
  it("ensurePlayer 使用完整 manifest 且幂等", () => {
    const dir = tempDir("airp-chars-"); const store = CharactersStore.initFrom("t", [manifest()], 1000, dir);
    store.ensurePlayer(manifest("C0", true), 1000); assert.equal(store.get("C0").name, "林雾"); assert.equal(store.get("C0").timer, 1060);
    store.setVars("C0", { timer: 2000 }); store.ensurePlayer(manifest("C0", true), 1000); assert.equal(store.get("C0").timer, 2000);
  });
  it("relations 与变量变更可逆", () => {
    const dir = tempDir("airp-chars-"); const store = CharactersStore.initFrom("t", [manifest()], 1000, dir);
    const changes = [...store.updateRelations("C1001", [{ target: "@C0", name: "旅人" }]), ...store.setVars("C1001", { timer: 1200 })];
    for (const change of [...changes].reverse()) store.revertChange(change);
    assert.deepEqual(store.get("C1001").relations, {}); assert.equal(store.get("C1001").timer, 1060);
  });
  it("旧 schema 拒绝并给新建会话提示", () => {
    const dir = tempDir("airp-chars-"); fs.writeFileSync(path.join(dir, "characters.json"), JSON.stringify({ C1001: {} }));
    assert.throws(() => CharactersStore.load("t", dir), /请新建会话\/重启服务/);
  });
});
