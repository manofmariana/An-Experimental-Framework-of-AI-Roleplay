import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorldStore } from "../src/truth/worldStore.js";
import { buildWorldSysRaw } from "./builders/index.js";

const start = { y: 3, m: 10, d: 17, h: 5, min: 30 };
describe("WorldStore 新结构", () => {
  it("saveData 仅 schema_version/world/pipeline，world 树含 time 锚与 _sys 程序分支", () => {
    const store = WorldStore.initial({ time: start, weather: "fog" }, buildWorldSysRaw());
    store.writeRaw("weather", "clear");
    const file = store.saveData();
    assert.deepEqual(Object.keys(file).sort(), ["pipeline", "schema_version", "world"]);
    assert.equal(file.world["weather"], "clear");
    assert.equal(typeof file.world._sys, "object");
    // saveData → 重建回环（纯内存，无落盘）
    assert.equal(new WorldStore(store.saveData()).world["weather"], "clear");
  });
  it("setClock 写 world.time 变更并可逆", () => {
    const store = WorldStore.initial({ time: start }, buildWorldSysRaw());
    const before = store.clock; const change = store.setClock(before + 60);
    assert.equal(change.path, "world.time"); assert.equal(store.world.time.h, 6); store.revertChange(change); assert.deepEqual(store.world.time, start);
  });
  it("writeRaw 低层写入产出逐步 before 并可倒序恢复（校验编排在 varWrite，不在本层）", () => {
    const store = WorldStore.initial({ time: start, hp: 10 }, buildWorldSysRaw());
    const changes = [store.writeRaw("hp", 8), store.writeRaw("hp", 13)];
    assert.deepEqual(changes.map((change) => [change.path, change.before, change.after]), [
      ["world.hp", 10, 8],
      ["world.hp", 8, 13],
    ]);
    for (const change of [...changes].reverse()) store.revertChange(change);
    assert.equal(store.world["hp"], 10);
  });
});
