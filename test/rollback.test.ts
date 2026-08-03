import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CharacterManifest } from "../src/agents/character.js";
import { CharactersStore } from "../src/truth/charactersStore.js";
import { WorldStore, type VarChange } from "../src/truth/worldStore.js";
import { tempDir } from "./harness/tempDir.js";

const start = { y: 1, m: 12, d: 35, h: 23, min: 50 };
const manifest: CharacterManifest = { id: "C1001", name: "林雾", gender: "女", age: "26", personality: "谨慎。", tags: [], reaction: 5, location: { name: "灯塔", level: 1 }, timer: 10, group: 0, initiative: null, channel: null, acted: false, level: 1, isPlayer: false, relations: {}, initial_memories: ["记忆"], vars: {} };

describe("结构时间与角色变更回溯", () => {
  it("world.time 跨年推进后通过 VarChange 逐字节恢复", () => {
    const dir = tempDir("airp-rb-"); const world = new WorldStore("t", { world: { time: start, hp: 10 } }, dir);
    const initial = JSON.stringify(world.world); const changes: VarChange[] = [];
    changes.push(...world.apply([{ path: "hp", op: "-=", value: 3 }])); changes.push(world.setClock(world.clock + 20));
    assert.deepEqual(world.world.time, { y: 2, m: 1, d: 1, h: 0, min: 10 });
    for (const change of [...changes].reverse()) world.revertChange(change);
    assert.equal(JSON.stringify(world.world), initial);
  });
  it("characters relations/timer/long_term_memory 倒序恢复", () => {
    const dir = tempDir("airp-rb-"); const store = CharactersStore.initFrom("t", [manifest], 100, dir); const initial = JSON.stringify(store.all());
    const changes = [...store.updateRelations("C1001", [{ target: "C0", name: "旅人" }]), ...store.setVars("C1001", { timer: 500 }), store.appendLongTerm("C1001", "新增")];
    for (const change of [...changes].reverse()) store.revertChange(change);
    assert.equal(JSON.stringify(store.all()), initial);
  });
});
