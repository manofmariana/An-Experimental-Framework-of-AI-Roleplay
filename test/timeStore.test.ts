import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TimeAnchorSchema, TimeFileSchema, TimeStore, minutesToWorldTime, renderTimeHeader, worldTimeToMinutes, type WorldTimeConfig } from "../src/truth/timeStore.js";
import { SAVE_SCHEMA_VERSION } from "../src/truth/saveSchema.js";

const CONFIG: WorldTimeConfig = { start: { y: 3, m: 10, d: 17, h: 23, min: 30 }, periods: [{ key: "白天", from: 6, to: 18 }, { key: "深夜", from: 18, to: 6 }] };
describe("结构化年月日时间", () => {
  it("绝对分钟可逆并跨日/月/年", () => {
    for (const time of [{ y: 1, m: 1, d: 1, h: 0, min: 0 }, { y: 2, m: 12, d: 35, h: 23, min: 59 }]) assert.deepEqual(minutesToWorldTime(worldTimeToMinutes(time)), time);
    assert.deepEqual(minutesToWorldTime(worldTimeToMinutes({ y: 1, m: 12, d: 35, h: 23, min: 59 }) + 1), { y: 2, m: 1, d: 1, h: 0, min: 0 });
    assert.deepEqual(minutesToWorldTime(worldTimeToMinutes({ y: 1, m: 1, d: 30, h: 23, min: 59 }) + 1), { y: 1, m: 2, d: 1, h: 0, min: 0 });
  });
  it("renderTimeHeader 支持年月日与时段", () => assert.equal(renderTimeHeader(CONFIG.start, CONFIG), "3年10月17日·深夜"));
  it("y 0 基：允许 0 年开局，0 年为原点、年末跨入 1 年", () => {
    // 0 年元旦 = 绝对分钟原点
    assert.equal(worldTimeToMinutes({ y: 0, m: 1, d: 1, h: 0, min: 0 }), 0);
    for (const time of [{ y: 0, m: 1, d: 1, h: 0, min: 0 }, { y: 0, m: 6, d: 15, h: 12, min: 30 }]) assert.deepEqual(minutesToWorldTime(worldTimeToMinutes(time)), time);
    // 0 年年末最后一分钟 +1 → 1 年元旦
    assert.deepEqual(minutesToWorldTime(worldTimeToMinutes({ y: 0, m: 12, d: 35, h: 23, min: 59 }) + 1), { y: 1, m: 1, d: 1, h: 0, min: 0 });
    // 契约口径：y 下界 0，m/d 保持 1 基
    assert.doesNotThrow(() => TimeAnchorSchema.parse({ y: 0, m: 1, d: 1, h: 0, min: 0 }));
    assert.throws(() => TimeAnchorSchema.parse({ y: -1, m: 1, d: 1, h: 0, min: 0 }));
    assert.throws(() => TimeAnchorSchema.parse({ y: 0, m: 0, d: 1, h: 0, min: 0 }));
  });
  it("存档版本字面量锚定（换算口径变更须随版本闸递增）", () => assert.equal(SAVE_SCHEMA_VERSION, 10));
  it("TimeStore 信封带版本；旧结构（无信封）parse 拒绝", () => {
    const store = new TimeStore({ schema_version: SAVE_SCHEMA_VERSION, ...CONFIG });
    assert.equal(store.get().schema_version, SAVE_SCHEMA_VERSION);
    // saveData 回环
    assert.equal(new TimeStore(store.saveData()).render(store.get().start), "3年10月17日·深夜");
    assert.throws(() => TimeFileSchema.parse(JSON.parse(JSON.stringify(CONFIG))));
  });
});
