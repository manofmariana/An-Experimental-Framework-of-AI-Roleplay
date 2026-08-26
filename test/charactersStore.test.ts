import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CharacterManifest } from "../src/agents/character.js";
import { CharactersFileSchema, CharactersStore } from "../src/truth/charactersStore.js";
import { SAVE_SCHEMA_VERSION } from "../src/truth/saveSchema.js";
import { buildManifest, buildVarsTemplate } from "./builders/index.js";

const DECL = buildVarsTemplate().characterVars;

const manifest = (id = "C1001", isPlayer = false): CharacterManifest =>
  buildManifest({
    id,
    name: "林雾",
    personality: "寡言谨慎。",
    location: { name: "灯塔", level: 1 },
    timer: 60,
    level: 2,
    isPlayer,
    initial_memories: ["记忆"],
  });
describe("CharactersStore 同构角色文件", () => {
  it("无 gm key、无 persona/voice，timer=start绝对分钟+偏移", () => {
    const store = CharactersStore.fromManifests([manifest()], 1000, DECL);
    const state = store.get("C1001"); assert.equal(state.timer, 1060); assert.equal(state.personality, "寡言谨慎。");
    assert.equal("gm" in store.all(), false); assert.equal("persona" in state, false); assert.equal("voice_anchor" in state, false);
  });
  it("ensurePlayer 使用完整 manifest 且幂等", () => {
    const store = CharactersStore.fromManifests([manifest()], 1000, DECL);
    store.ensurePlayer(manifest("C0", true), 1000, DECL); assert.equal(store.get("C0").name, "林雾"); assert.equal(store.get("C0").timer, 1060);
    store.setVars("C0", { timer: 2000 }); store.ensurePlayer(manifest("C0", true), 1000, DECL); assert.equal(store.get("C0").timer, 2000);
  });
  it("relations 与变量变更可逆", () => {
    const store = CharactersStore.fromManifests([manifest()], 1000, DECL);
    const changes = [...store.updateRelations("C1001", [{ target: "@C0", name: "旅人" }]), ...store.setVars("C1001", { timer: 1200 })];
    for (const change of [...changes].reverse()) store.revertChange(change);
    assert.deepEqual(store.get("C1001").relations, []); assert.equal(store.get("C1001").timer, 1060);
  });
  it("saveData 回环：重建后读回一致；旧 schema（无信封）parse 拒绝", () => {
    const store = CharactersStore.fromManifests([manifest()], 1000, DECL);
    store.setVars("C1001", { timer: 1200 });
    assert.equal(new CharactersStore(store.saveData()).get("C1001").timer, 1200);
    assert.throws(() => CharactersFileSchema.parse({ C1001: {} }));
    assert.equal(
      CharactersFileSchema.parse({ schema_version: SAVE_SCHEMA_VERSION, characters: store.saveData() }).characters["C1001"]!.timer,
      1200,
    );
  });
});
