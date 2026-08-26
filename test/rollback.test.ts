import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CharactersStore } from "../src/truth/charactersStore.js";
import { WorldStore } from "../src/truth/worldStore.js";
import type { VarChange } from "../src/truth/varChanges.js";
import { buildManifest, buildVarsTemplate, buildWorldSysRaw } from "./builders/index.js";

const start = { y: 1, m: 12, d: 35, h: 23, min: 50 };
const DECL = buildVarsTemplate().characterVars;
const manifest = buildManifest({ id: "C1001", name: "林雾", location: { name: "灯塔", level: 1 }, timer: 10, initial_memories: ["记忆"] });

describe("结构时间与角色变更回溯", () => {
  it("world.time 跨年推进后通过 VarChange 逐字节恢复", () => {
    const world = WorldStore.initial({ time: start, hp: 10 }, buildWorldSysRaw());
    const initial = JSON.stringify(world.world); const changes: VarChange[] = [];
    changes.push(world.writeRaw("hp", 7)); changes.push(world.setClock(world.clock + 20));
    assert.deepEqual(world.world.time, { y: 2, m: 1, d: 1, h: 0, min: 10 });
    for (const change of [...changes].reverse()) world.revertChange(change);
    assert.equal(JSON.stringify(world.world), initial);
  });
  it("characters relations/timer/long_term_memory 倒序恢复", () => {
    const store = CharactersStore.fromManifests([manifest], 100, DECL); const initial = JSON.stringify(store.all());
    const changes = [...store.updateRelations("C1001", [{ target: "@C0", name: "旅人" }]), ...store.setVars("C1001", { timer: 500 }), store.appendLongTerm("C1001", "新增")];
    for (const change of [...changes].reverse()) store.revertChange(change);
    assert.equal(JSON.stringify(store.all()), initial);
  });
});
