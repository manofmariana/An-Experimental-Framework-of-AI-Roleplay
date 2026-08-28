import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventsStore, truncateEvents } from "../src/truth/events.js";
import type { Event } from "../src/types.js";

function evt(partial: { id: string; seq: number; t?: number; location?: string; tags?: { name: string; level: number }[] }): Event {
  const shell = <T extends string | number>(value: T, tags: { name: string; level: number }[] = []): { value: T; tags: { name: string; level: number }[] } => ({ value, tags });
  return {
    id: shell(partial.id),
    t: shell(partial.t ?? 0),
    seq: shell(partial.seq),
    kind: shell("world" as const),
    ...(partial.location !== undefined ? { location: shell(partial.location) } : {}),
    content: shell(`payload-${partial.id}`, partial.tags ?? [
      { name: "C0", level: 1 },
      { name: "C1001", level: 1 },
    ]),
  };
}

describe("EventsStore（纯内存容器；落盘归 GenerationRepository）", () => {
  it("append 入内存；readAll 按 (t, id) 排序；saveData 回环可读", () => {
    const store = new EventsStore();
    store.append(evt({ id: "evt_0002", seq: 3, t: 5 }));
    store.append(evt({ id: "evt_0001", seq: 3, t: 3 }));
    store.append(evt({ id: "evt_0003", seq: 4, t: 5 }));

    assert.equal(store.saveData().length, 3);

    const ids = store.readAll().map((e) => e.id.value);
    assert.deepEqual(ids, ["evt_0001", "evt_0002", "evt_0003"]);
    assert.deepEqual(new EventsStore(store.saveData()).readAll().map((e) => e.id.value), ids);
  });

  it("readWindow = 正文滑窗取数范围截取（供给窗口，不是过滤）", () => {
    const store = new EventsStore();
    store.append(evt({ id: "evt_0001", seq: 1, t: 1, location: "loc_lighthouse" }));
    store.append(evt({ id: "evt_0002", seq: 2, t: 2, tags: [{ name: "C0", level: 1 }] }));
    store.append(evt({ id: "evt_0003", seq: 3, t: 9, location: "loc_baitan" }));
    store.append(evt({ id: "evt_0004", seq: 4, t: 4, location: "loc_baitan" }));

    assert.deepEqual(store.readWindow(2).map((e) => e.id.value), ["evt_0004", "evt_0003"]);
    // 可见性/时间过滤已移交引擎（Store 只留存储语义）：readAll 全量供给
    assert.equal(store.readAll().length, 4);
  });

  it("truncateEvents 纯函数 + truncateToSeq 后 saveData 回环（回溯丢弃不留底）", () => {
    const events = [evt({ id: "e1", seq: 3 }), evt({ id: "e2", seq: 7 }), evt({ id: "e3", seq: 12 })];
    assert.deepEqual(
      truncateEvents(events, 7).map((e) => e.id.value),
      ["e1", "e2"],
    );
    assert.equal(events.length, 3); // 纯函数不改入参

    const store = new EventsStore(events);
    store.truncateToSeq(7);
    assert.deepEqual(new EventsStore(store.saveData()).readAll().map((e) => e.id.value), ["e1", "e2"]);
  });
});
