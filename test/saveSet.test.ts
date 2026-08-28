import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SaveSet } from "../src/truth/generationRepository.js";
import { SaveLoadError } from "../src/truth/validation/errors.js";
import { validateSaveSet } from "../src/truth/validation/saveSet.js";
import { buildCharacterState, buildEvent, buildLoreEntry, buildSaveSet, buildSysFile } from "./builders/index.js";

// ---------------------------------------------------------------------------
// validateSaveSet（两级校验第二级：整档跨文件不变量）。
// unit 层：纯函数零 IO。基线 = buildSaveSet（空档可提交态）/ runningSave（进行中档），
// 每个用例用 overrides 精准打破一条不变量。
// ---------------------------------------------------------------------------

/** 进行中档基线：seq=2、GM 步在途、archive 一条角色步、事件 seq=2。 */
function runningSave(overrides?: Partial<SaveSet>): SaveSet {
  return buildSaveSet({
    sys: buildSysFile({
      pipeline: {
        seq: 2,
        working_set: [{ cid: "C0" }, { cid: "C1001" }],
        current: { seq: 2, kind: "gm", result: null },
      },
    }),
    characters: { C0: buildCharacterState({ isPlayer: true }), C1001: buildCharacterState() },
    archive: [{ seq: 1, kind: "character:C1001", result: null, changes: { setup: [], effects: [] } }],
    events: [buildEvent({ id: "evt_1", seq: 2 })],
    ...overrides,
  });
}

/** 断言抛 SaveLoadError("invariant") 且消息命中违规项。 */
function expectInvariant(save: SaveSet, pattern: RegExp): void {
  assert.throws(
    () => validateSaveSet(save),
    (error: unknown) => {
      assert.ok(error instanceof SaveLoadError, `应为 SaveLoadError，实为 ${String(error)}`);
      assert.equal(error.kind, "invariant", `kind 应为 invariant：${error.message}`);
      assert.match(error.message, pattern);
      return true;
    },
  );
}

describe("validateSaveSet（可提交态基线）", () => {
  it("空档基线通过（seq=0、current=null、archive 空）", () => {
    assert.doesNotThrow(() => validateSaveSet(buildSaveSet()));
  });

  it("进行中档基线通过（current.seq === pipeline.seq，archive 严格递增且不越界）", () => {
    assert.doesNotThrow(() => validateSaveSet(runningSave()));
  });

  it("多个 isPlayer:true 合法（玩家集合不写死 C0）", () => {
    const save = buildSaveSet({
      characters: {
        C0: buildCharacterState({ isPlayer: true }),
        C1001: buildCharacterState({ isPlayer: true }),
      },
    });
    assert.doesNotThrow(() => validateSaveSet(save));
  });
});

describe("validateSaveSet（pipeline / archive 边界）", () => {
  it("pipeline.seq 非整数 → invariant", () => {
    expectInvariant(buildSaveSet({ sys: buildSysFile({ pipeline: { seq: 1.5, working_set: [], current: null } }) }), /pipeline\.seq 必须为非负整数/);
  });

  it("current.seq ≠ pipeline.seq → invariant", () => {
    const save = runningSave();
    save.sys.pipeline.current = { seq: 3, kind: "gm", result: null };
    expectInvariant(save, /进行中步骤 seq（3）≠ pipeline\.seq（2）/);
  });

  it("current=null 但 pipeline.seq ≠ 0 → invariant", () => {
    expectInvariant(buildSaveSet({ sys: buildSysFile({ pipeline: { seq: 1, working_set: [], current: null } }) }), /current=null.*pipeline\.seq 必须为 0/);
  });

  it("current=null 但 archive 非空 → invariant", () => {
    const save = buildSaveSet({ archive: [{ seq: 1, kind: "gm", result: null, changes: { setup: [], effects: [] } }] });
    expectInvariant(save, /current=null.*archive 必须为空/);
  });

  it("archive 乱序 → invariant", () => {
    const save = runningSave({
      archive: [
        { seq: 2, kind: "gm", result: null, changes: { setup: [], effects: [] } },
        { seq: 1, kind: "gm", result: null, changes: { setup: [], effects: [] } },
      ],
    });
    save.sys.pipeline = { seq: 3, working_set: [], current: { seq: 3, kind: "gm", result: null } };
    expectInvariant(save, /严格递增/);
  });

  it("archive 重复 seq → invariant", () => {
    const save = runningSave({
      archive: [
        { seq: 1, kind: "gm", result: null, changes: { setup: [], effects: [] } },
        { seq: 1, kind: "gm", result: null, changes: { setup: [], effects: [] } },
      ],
    });
    expectInvariant(save, /严格递增/);
  });

  it("archive 越界（seq ≥ 进行中步骤 seq）→ invariant", () => {
    const save = runningSave({
      archive: [
        { seq: 1, kind: "gm", result: null, changes: { setup: [], effects: [] } },
        { seq: 2, kind: "gm", result: null, changes: { setup: [], effects: [] } },
      ],
    });
    expectInvariant(save, /archive 条目 seq（2）越界/);
  });

  it("archive seq 非 ≥1 整数 → invariant", () => {
    const save = runningSave({ archive: [{ seq: 0, kind: "gm", result: null, changes: { setup: [], effects: [] } }] });
    expectInvariant(save, /archive 条目 seq 必须为 ≥1 整数/);
  });
});

describe("validateSaveSet（events）", () => {
  it("事件 id 重复 → invariant", () => {
    const save = runningSave({
      events: [buildEvent({ id: "evt_1", seq: 1 }), buildEvent({ id: "evt_1", seq: 2 })],
    });
    expectInvariant(save, /事件 id 重复: evt_1/);
  });

  it("事件 id 为空 → invariant", () => {
    const save = runningSave({ events: [buildEvent({ id: "", seq: 1 })] });
    expectInvariant(save, /事件 id 不能为空/);
  });

  it("事件 seq 超过 pipeline.seq 合法（直编整体替换事件表可注入任意 seq，误杀排查裁决）", () => {
    const save = runningSave({ events: [buildEvent({ id: "evt_9", seq: 3 })] });
    assert.doesNotThrow(() => validateSaveSet(save));
    // 空档（seq=0）注入 seq=1 事件同样合法（directEdit 既有用例）
    const fresh = buildSaveSet({ events: [buildEvent({ id: "evt_e1", seq: 1 })] });
    assert.doesNotThrow(() => validateSaveSet(fresh));
  });

  it("事件 seq 非 ≥1 整数 → invariant", () => {
    const save = runningSave({ events: [buildEvent({ id: "evt_1", seq: 0 })] });
    expectInvariant(save, /事件 evt_1 的 seq 必须为 ≥1 整数/);
  });
});

describe("validateSaveSet（引用闭包与角色表）", () => {
  it("working_set 引用未知 cid → invariant", () => {
    const save = runningSave();
    save.sys.pipeline.working_set = [{ cid: "C0" }, { cid: "C9999" }];
    expectInvariant(save, /working_set 引用未知角色: C9999/);
  });

  it("working_set 通知条目引用未知 actor → invariant", () => {
    const save = runningSave();
    save.sys.pipeline.working_set = [
      { cid: "C0" },
      {
        id: "notice:leave",
        author: "system",
        notice: { type: "leave", actor: "C9999", targets: [] },
        tags: [{ name: "vis", level: 1 }],
      },
    ];
    expectInvariant(save, /working_set 通知条目引用未知角色: C9999/);
  });

  it("archive 角色步引用未知 cid → invariant", () => {
    const save = runningSave({
      archive: [{ seq: 1, kind: "character:C9999", result: null, changes: { setup: [], effects: [] } }],
    });
    expectInvariant(save, /archive 角色步引用未知角色: C9999/);
  });

  it("非法角色 CID 键 → invariant", () => {
    const save = buildSaveSet({
      characters: { C0: buildCharacterState({ isPlayer: true }), npc_1: buildCharacterState() },
    });
    expectInvariant(save, /非法角色 CID 键: "npc_1"/);
  });
});

describe("validateSaveSet（lore）", () => {
  it("lore 条目 id 重复 → invariant", () => {
    const save = buildSaveSet();
    save.lores.entries = [buildLoreEntry("lore_a", "甲"), buildLoreEntry("lore_a", "乙")];
    expectInvariant(save, /lore 条目 id 重复: lore_a/);
  });

  it("lore changelog seq 非整数 → invariant", () => {
    const save = buildSaveSet();
    save.lores.changelog = [
      { seq: 1.5, op: "add", before: null, after: buildLoreEntry("lore_a", "甲") },
    ];
    expectInvariant(save, /lore changelog seq 必须为整数/);
  });
});
