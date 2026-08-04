import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorldStore, applyDeltas } from "../src/truth/worldStore.js";

const start = { y: 3, m: 10, d: 17, h: 5, min: 30 };
describe("WorldStore 新结构", () => {
  it("saveData 仅 schema_version/world/pipeline，无 vars/clock", () => {
    const store = WorldStore.initial({ time: start, weather: "fog" });
    store.apply([{ path: "weather", op: "=", value: "clear" }]);
    const file = store.saveData();
    assert.deepEqual(Object.keys(file).sort(), ["pipeline", "schema_version", "world"]);
    assert.equal(file.world["weather"], "clear");
    // saveData → 重建回环（纯内存，无落盘）
    assert.equal(new WorldStore(store.saveData()).world["weather"], "clear");
  });
  it("setClock 写 world.time 变更并可逆", () => {
    const store = WorldStore.initial({ time: start });
    const before = store.clock; const change = store.setClock(before + 60);
    assert.equal(change.path, "world.time"); assert.equal(store.world.time.h, 6); store.revertChange(change); assert.deepEqual(store.world.time, start);
  });
  it("GM delta 禁止 time，普通 delta 纯函数", () => {
    assert.deepEqual(applyDeltas({ hp: 10 }, [{ path: "hp", op: "-=", value: 3 }]), { hp: 7 });
    const store = WorldStore.initial({ time: start });
    assert.throws(() => store.apply([{ path: "time.h", op: "=", value: 1 }]));
  });
});
