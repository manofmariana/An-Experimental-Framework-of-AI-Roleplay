import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { WorldStore, applyDeltas } from "../src/truth/worldStore.js";

const start = { y: 3, m: 10, d: 17, h: 5, min: 30 };
describe("WorldStore 新结构", () => {
  it("落盘仅 schema_version/world/pipeline，无 vars/clock", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airp-world-")); const store = new WorldStore("t", { world: { time: start, weather: "fog" } }, dir);
    store.apply([{ path: "weather", op: "=", value: "clear" }]);
    const file = JSON.parse(fs.readFileSync(path.join(dir, "world.json"), "utf8"));
    assert.deepEqual(Object.keys(file).sort(), ["pipeline", "schema_version", "world"]); assert.equal(file.world.weather, "clear");
  });
  it("setClock 写 world.time 变更并可逆", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airp-world-")); const store = new WorldStore("t", { world: { time: start } }, dir);
    const before = store.clock; const change = store.setClock(before + 60);
    assert.equal(change.path, "world.time"); assert.equal(store.world.time.h, 6); store.revertChange(change); assert.deepEqual(store.world.time, start);
  });
  it("GM delta 禁止 time，普通 delta 纯函数", () => {
    assert.deepEqual(applyDeltas({ hp: 10 }, [{ path: "hp", op: "-=", value: 3 }]), { hp: 7 });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airp-world-")); const store = new WorldStore("t", { world: { time: start } }, dir);
    assert.throws(() => store.apply([{ path: "time.h", op: "=", value: 1 }]));
  });
});
