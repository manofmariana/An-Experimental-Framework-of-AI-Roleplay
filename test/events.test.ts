import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventsStore, truncateEvents } from "../src/truth/events.js";
import type { Event } from "../src/types.js";

function evt(partial: Partial<Event> & { id: string; seq: number }): Event {
  return {
    t: 0,
    kind: "world",
    tags: ["known_by:C0", "known_by:C1001"],
    payload: `payload-${partial.id}`,
    ...partial,
  };
}

describe("EventsStore（纯内存容器；落盘归 GenerationRepository）", () => {
  it("append 入内存；readAll 按 (t, id) 排序；saveData 回环可读", () => {
    const store = new EventsStore();
    store.append(evt({ id: "evt_0002", seq: 3, t: 5 }));
    store.append(evt({ id: "evt_0001", seq: 3, t: 3 }));
    store.append(evt({ id: "evt_0003", seq: 4, t: 5 }));

    assert.equal(store.saveData().length, 3);

    const ids = store.readAll().map((e) => e.id);
    assert.deepEqual(ids, ["evt_0001", "evt_0002", "evt_0003"]);
    assert.deepEqual(new EventsStore(store.saveData()).readAll().map((e) => e.id), ids);
  });

  it("readWindow / readVisibleTo（known_by 标签 ∧ time，无地点成分，ADR 0002）", () => {
    const store = new EventsStore();
    store.append(evt({ id: "evt_0001", seq: 1, t: 1, location: "loc_lighthouse" }));
    store.append(evt({ id: "evt_0002", seq: 2, t: 2, tags: ["known_by:C0"] })); // C1001 不可见
    store.append(evt({ id: "evt_0003", seq: 3, t: 9, location: "loc_baitan" })); // t > at
    store.append(evt({ id: "evt_0004", seq: 4, t: 4, location: "loc_baitan" })); // 异地仍可见

    assert.deepEqual(store.readWindow(2).map((e) => e.id), ["evt_0004", "evt_0003"]);
    const visible = store.readVisibleTo("C1001", 5);
    assert.deepEqual(visible.map((e) => e.id), ["evt_0001", "evt_0004"]);
  });

  it("truncateEvents 纯函数 + truncateToSeq 后 saveData 回环（回溯丢弃不留底）", () => {
    const events = [evt({ id: "e1", seq: 3 }), evt({ id: "e2", seq: 7 }), evt({ id: "e3", seq: 12 })];
    assert.deepEqual(
      truncateEvents(events, 7).map((e) => e.id),
      ["e1", "e2"],
    );
    assert.equal(events.length, 3); // 纯函数不改入参

    const store = new EventsStore(events);
    store.truncateToSeq(7);
    assert.deepEqual(new EventsStore(store.saveData()).readAll().map((e) => e.id), ["e1", "e2"]);
  });
});
