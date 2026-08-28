import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorldStore } from "../src/truth/worldStore.js";
import { buildWorldTree } from "./builders/index.js";

describe("WorldStore（纯变量树容器）", () => {
  it("saveData = 纯变量树（含 time 系统分支实例）；程序分支在 sys 根不在本树", () => {
    const store = new WorldStore({ ...buildWorldTree(), weather: "fog" });
    store.writeRaw("weather", "clear");
    const tree = store.saveData();
    assert.deepEqual(Object.keys(tree).sort(), ["time", "weather"]);
    assert.equal(tree["weather"], "clear");
    // saveData → 重建回环（纯内存，无落盘）
    assert.equal(new WorldStore(store.saveData()).world["weather"], "clear");
  });
  it("setClock 写 world.time 锚末端（tags 保留）并可逆", () => {
    const store = new WorldStore(buildWorldTree());
    const before = store.clock;
    const change = store.setClock(before + 60);
    assert.equal(change.path, "world.time");
    const time = store.world["time"] as Record<string, { value: number }>;
    assert.equal(time["h"]!.value, 1); // 缺省锚 00:00 + 60min
    store.revertChange(change);
    assert.equal(store.clock, before);
  });
  it("writeRaw 低层写入产出逐步 before 并可倒序恢复（校验编排在 varWrite，不在本层）", () => {
    const store = new WorldStore({ ...buildWorldTree(), hp: 10 });
    const changes = [store.writeRaw("hp", 8), store.writeRaw("hp", 13)];
    assert.deepEqual(changes.map((change) => [change.path, change.before, change.after]), [
      ["world.hp", 10, 8],
      ["world.hp", 8, 13],
    ]);
    for (const change of [...changes].reverse()) store.revertChange(change);
    assert.equal(store.world["hp"], 10);
  });
  it("replaceWorld：time 系统分支缺失/畸形 = 拒写", () => {
    const store = new WorldStore(buildWorldTree());
    assert.throws(() => store.replaceWorld({ weather: "fog" }));
    assert.equal(store.world["weather"], undefined);
  });
});
