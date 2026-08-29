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

describe("setVars 系统字段级联 tags 池", () => {
  it("建角物化池 = attachtags ∪ cid/location/channel 常驻项（channel null = 空集）", () => {
    const store = CharactersStore.fromManifests([manifest()], 1000, DECL);
    assert.deepEqual(store.tagNames("C1001"), ["C1001", "灯塔"]);
  });

  it("location 变化 → 池重算并追加 VarChange；回溯恢复池旧值", () => {
    const store = CharactersStore.fromManifests([manifest()], 1000, DECL);
    const changes = store.setVars("C1001", { location: { name: "集市", level: 1 } });
    assert.deepEqual(store.tagNames("C1001"), ["C1001", "集市"]);
    const poolChange = changes.find((c) => c.path === "characters.C1001.vars.tags");
    assert.ok(poolChange, "池变更追加 VarChange");
    assert.deepEqual(poolChange.before, { value: ["C1001", "灯塔"], tags: [] });
    assert.deepEqual(poolChange.after, { value: ["C1001", "集市"], tags: [] });
    for (const change of [...changes].reverse()) store.revertChange(change);
    assert.deepEqual(store.tagNames("C1001"), ["C1001", "灯塔"], "回溯恢复池旧值");
    assert.deepEqual(store.get("C1001").location, { name: "灯塔", level: 1 });
  });

  it("channel 建立/挂断 → 池增减频道号；location 同名（仅 level 变）→ 池不变不追加", () => {
    const store = CharactersStore.fromManifests([manifest()], 1000, DECL);
    const up = store.setVars("C1001", { channel: 7 });
    assert.deepEqual(store.tagNames("C1001"), ["C1001", "灯塔", "7"]);
    assert.ok(up.some((c) => c.path === "characters.C1001.vars.tags"), "频道建立 → 池追加 VarChange");
    const noop = store.setVars("C1001", { location: { name: "灯塔", level: 2 } });
    assert.deepEqual(store.tagNames("C1001"), ["C1001", "灯塔", "7"]);
    assert.ok(!noop.some((c) => c.path === "characters.C1001.vars.tags"), "池值不变不追加 VarChange");
    store.setVars("C1001", { channel: null });
    assert.deepEqual(store.tagNames("C1001"), ["C1001", "灯塔"]);
  });

  it("只动 timer → 池不重算无 VarChange", () => {
    const store = CharactersStore.fromManifests([manifest()], 1000, DECL);
    const changes = store.setVars("C1001", { timer: 1200 });
    assert.deepEqual(changes.map((c) => c.path), ["characters.C1001.timer"]);
    assert.deepEqual(store.tagNames("C1001"), ["C1001", "灯塔"]);
  });

  it("未持有模板（characterDecl 缺省）→ setVars 不重算池（提交边界由存档安全网兜底）", () => {
    const store = new CharactersStore({ C1001: CharactersStore.fromManifests([manifest()], 1000, DECL).get("C1001") });
    const changes = store.setVars("C1001", { location: { name: "集市", level: 1 } });
    assert.ok(!changes.some((c) => c.path.endsWith("vars.tags")));
  });
});
