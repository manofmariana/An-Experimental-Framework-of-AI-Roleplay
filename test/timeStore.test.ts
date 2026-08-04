import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TimeFileSchema, TimeStore, minutesToWorldTime, renderTimeHeader, worldTimeToMinutes, type WorldTimeConfig } from "../src/truth/timeStore.js";
import { SAVE_SCHEMA_VERSION } from "../src/truth/saveSchema.js";

const CONFIG: WorldTimeConfig = { start: { y: 3, m: 10, d: 17, h: 23, min: 30 }, periods: [{ key: "白天", from: 6, to: 18 }, { key: "深夜", from: 18, to: 6 }] };
describe("结构化年月日时间", () => {
  it("绝对分钟可逆并跨日/月/年", () => {
    for (const time of [{ y: 1, m: 1, d: 1, h: 0, min: 0 }, { y: 2, m: 12, d: 35, h: 23, min: 59 }]) assert.deepEqual(minutesToWorldTime(worldTimeToMinutes(time)), time);
    assert.deepEqual(minutesToWorldTime(worldTimeToMinutes({ y: 1, m: 12, d: 35, h: 23, min: 59 }) + 1), { y: 2, m: 1, d: 1, h: 0, min: 0 });
    assert.deepEqual(minutesToWorldTime(worldTimeToMinutes({ y: 1, m: 1, d: 30, h: 23, min: 59 }) + 1), { y: 1, m: 2, d: 1, h: 0, min: 0 });
  });
  it("renderTimeHeader 支持年月日与时段", () => assert.equal(renderTimeHeader(CONFIG.start, CONFIG), "3年10月17日·深夜"));
  it("TimeStore 信封带版本；旧结构（无信封）parse 拒绝", () => {
    const store = new TimeStore({ schema_version: SAVE_SCHEMA_VERSION, ...CONFIG });
    assert.equal(store.get().schema_version, SAVE_SCHEMA_VERSION);
    // saveData 回环
    assert.equal(new TimeStore(store.saveData()).render(store.get().start), "3年10月17日·深夜");
    assert.throws(() => TimeFileSchema.parse(JSON.parse(JSON.stringify(CONFIG))));
  });
});
