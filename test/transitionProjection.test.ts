/**
 * transitionProjection 单测（unit 层，零 IO；优化阶段 D2「Snapshot 与增量 Transition」）：
 * buildTransition 的引用差分——world 根变/characters 逐 CID 增删改/events append·truncate·
 * 中段分歧重放；historyPatch 恒 replace；editedResult 透传；六类 reason（含合并）透传。
 * draft 路径（cloneTruth/adoptTruth 深拷贝）引用必变 → 值比较兜底过滤"假变化"。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildHistory } from "../src/application/historyProjection.js";
import {
  buildTransition,
  type CommitNotice,
  type TransitionExtra,
  type TruthRoots,
} from "../src/application/transitionProjection.js";
import type { CommitReason } from "../src/truth/commitExecutor.js";
import { buildCharacterState, buildEvent } from "./builders/index.js";

const EXTRA: TransitionExtra = {
  history: buildHistory([], [], null),
  pipeline: { seq: 1, phase: "await_player", interrupted: false, kind: null },
};

function roots(over?: Partial<TruthRoots>): TruthRoots {
  return {
    world: { time: { y: 1, m: 1, d: 1, h: 0, min: 0 } },
    characters: {},
    events: [],
    ...over,
  };
}

function notice(reason: CommitReason, prev: TruthRoots, next: TruthRoots, fromRevision = 1, revision = 2): CommitNotice {
  return { reason, fromRevision, revision, prev, next };
}

describe("buildTransition 引用差分", () => {
  it("world 根引用相同 → 不带 world；值不同（draft 深拷贝）→ 完整 world 视图", () => {
    const world = roots().world;
    const same = buildTransition(notice("step", roots({ world }), roots({ world })), "run-x", EXTRA);
    assert.equal(same.changed.world, undefined);

    const cloned = structuredClone(world);
    const fakeChange = buildTransition(notice("step", roots({ world }), roots({ world: cloned })), "run-x", EXTRA);
    assert.equal(fakeChange.changed.world, undefined); // 引用变但值等 → 过滤

    const changed = buildTransition(
      notice("step", roots({ world }), roots({ world: { ...structuredClone(world), hp: 1 } })),
      "run-x",
      EXTRA,
    );
    assert.deepEqual(changed.changed.world, { ...world, hp: 1 });
  });

  it("characters 逐 CID：改 → 当前视图；增 → 视图；删 → null；未变 → 不带", () => {
    const c1 = buildCharacterState({ name: "甲" });
    const c2 = buildCharacterState({ name: "乙" });
    const c2changed = { ...c2, acted: true };
    const c3 = buildCharacterState({ name: "丙" });
    const t = buildTransition(
      notice(
        "step",
        roots({ characters: { C1: c1, C2: c2, C4: buildCharacterState({ name: "丁" }) } }),
        roots({ characters: { C1: c1, C2: c2changed, C3: c3 } }),
      ),
      "run-x",
      EXTRA,
    );
    assert.deepEqual(Object.keys(t.changed.characters ?? {}).sort(), ["C2", "C3", "C4"]);
    assert.equal((t.changed.characters ?? {}).C2, c2changed);
    assert.equal((t.changed.characters ?? {}).C3, c3);
    assert.equal((t.changed.characters ?? {}).C4, null); // 消失 → null
  });

  it("events 变长 → appendedEvents 尾切片；引用相等前缀不重放", () => {
    const e1 = buildEvent({ id: "evt_0001", seq: 1 });
    const e2 = buildEvent({ id: "evt_0002", seq: 2 });
    const e3 = buildEvent({ id: "evt_0003", seq: 2 });
    const t = buildTransition(
      notice("gm", roots({ events: [e1, e2] }), roots({ events: [e1, e2, e3] })),
      "run-x",
      EXTRA,
    );
    assert.deepEqual(t.changed.appendedEvents, [e3]);
    assert.equal(t.changed.truncateEventsAfterSeq, undefined);
  });

  it("events 变短 → truncateEventsAfterSeq（按公共前缀末尾 seq）", () => {
    const e1 = buildEvent({ id: "evt_0001", seq: 1 });
    const e2 = buildEvent({ id: "evt_0002", seq: 2 });
    const e3 = buildEvent({ id: "evt_0003", seq: 3 });
    const t = buildTransition(
      notice("rollback", roots({ events: [e1, e2, e3] }), roots({ events: [e1] })),
      "run-x",
      EXTRA,
    );
    assert.equal(t.changed.truncateEventsAfterSeq, 1);
    assert.equal(t.changed.appendedEvents, undefined);
  });

  it("events 中段分歧（编辑重裁决替换事件）→ 截断 + 尾部重放；draft 克隆值等 → 不带 events", () => {
    const e1 = buildEvent({ id: "evt_0001", seq: 1 });
    const e2 = buildEvent({ id: "evt_0002", seq: 2 });
    const e2new = buildEvent({ id: "evt_0004", seq: 2, payload: "重写" });
    const t = buildTransition(
      notice("admin_edit", roots({ events: [e1, e2] }), roots({ events: [e1, e2new] })),
      "run-x",
      EXTRA,
    );
    assert.equal(t.changed.truncateEventsAfterSeq, 1);
    assert.deepEqual(t.changed.appendedEvents, [e2new]);

    // draft 深拷贝（引用全变、id/seq/内容值等）→ 视为未变
    const cloned = structuredClone([e1, e2]);
    const same = buildTransition(
      notice("rollback", roots({ events: [e1, e2] }), roots({ events: cloned })),
      "run-x",
      EXTRA,
    );
    assert.equal(same.changed.appendedEvents, undefined);
    assert.equal(same.changed.truncateEventsAfterSeq, undefined);
  });

  it("historyPatch 恒 replace；editedResult 透传；pipeline 透传", () => {
    const t = buildTransition(notice("step", roots(), roots()), "run-x", {
      ...EXTRA,
      editedResult: { seq: 3, kind: "gm", result: { raw: "{}" } },
    });
    assert.equal(t.changed.historyPatch?.type, "replace");
    assert.deepEqual(t.changed.editedResult, { seq: 3, kind: "gm", result: { raw: "{}" } });
    assert.deepEqual(t.pipeline, EXTRA.pipeline);
  });

  it("六类 reason 透传（init/step/gm/rollback/admin_edit + 合并的 fromRevision→终 revision）", () => {
    for (const reason of ["init", "step", "gm", "rollback", "admin_edit"] as const) {
      const t = buildTransition(notice(reason, roots(), roots()), "run-x", EXTRA);
      assert.equal(t.reason, reason);
      assert.equal(t.type, "transition");
      assert.equal(t.runId, "run-x");
    }
    // 合并 Transition（rollback_and_continue）：fromRevision = 命令开始前，revision = 终值（跨多提交）
    const merged = buildTransition(notice("rollback", roots(), roots(), 3, 5), "run-x", EXTRA);
    assert.equal(merged.fromRevision, 3);
    assert.equal(merged.revision, 5);
  });
});
