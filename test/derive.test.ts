import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveNext,
  expectedGmDurationCids,
  phaseOf,
  selectFront,
  type NextCommand,
  type PendingInvitationView,
  type ScheduleSetup,
  type SchedulerCharacter,
  type SchedulerSnapshot,
} from "../src/scheduler/derive.js";

// ---------------------------------------------------------------------------
// deriveNext 表驱动单测（unit：零 Store 零 IO，快照字面量 → NextCommand 断言）
// ---------------------------------------------------------------------------

function ch(overrides?: Partial<SchedulerCharacter>): SchedulerCharacter {
  return {
    timer: 100,
    group: 0,
    location: { name: "loc" },
    isPlayer: false,
    initiative: null,
    channel: null,
    acted: false,
    ...overrides,
  };
}

function snap(
  chars: Record<string, SchedulerCharacter>,
  overrides?: Partial<SchedulerSnapshot>,
): SchedulerSnapshot {
  return {
    chars,
    clock: 0,
    cycleCount: 0,
    gmIntervalCycles: 3,
    gmTrigger: false,
    gmTriggerBatch: null,
    lastStepKind: null,
    lastGmNarrativity: null,
    pendingInvitation: null,
    ...overrides,
  };
}

const NO_SETUP: ScheduleSetup = { actedClears: [], cycleIncrement: false, foreground: [] };
const invitation = (target: string): PendingInvitationView => ({
  contactSeq: 1,
  inviter: "C1001",
  channel: "电话",
  target,
});

describe("selectFront：前台组选择", () => {
  it("全员无计时器 → null（死锁）；非零组扩到同组已成熟成员（timer > effClock 者排除）", () => {
    assert.equal(selectFront({ C0: ch({ timer: null }), C1001: ch({ timer: null }) }, 0), null);
    const sel = selectFront(
      {
        C1001: ch({ timer: 10, group: 1 }),
        C1002: ch({ timer: 50, group: 1 }), // 未成熟：不进本轮前台
        C1003: ch({ timer: 10, group: 1 }),
      },
      0,
    )!;
    assert.equal(sel.due, 10);
    assert.equal(sel.effClock, 10);
    assert.deepEqual(sel.front, ["C1001", "C1003"]);
  });

  it("effClock = max(clock, due)：timer=0 的新入组成员 ≤ 当前时钟随组行动，时钟不倒退", () => {
    const sel = selectFront(
      { C1001: ch({ timer: 0, group: 1 }), C1002: ch({ timer: 5, group: 1 }) },
      5,
    )!;
    assert.equal(sel.due, 0);
    assert.equal(sel.effClock, 5);
    assert.deepEqual(sel.front, ["C1001", "C1002"]);
  });

  it("同刻多组按 orderGroups 串行：首组 = 组内最高先攻的组", () => {
    const sel = selectFront(
      {
        C1001: ch({ timer: 10, group: 1, initiative: { value: 25, group: 1 } }),
        C1002: ch({ timer: 10, group: 1, initiative: { value: 12, group: 1 } }),
        C1003: ch({ timer: 10, group: 2, initiative: { value: 20, group: 2 } }),
      },
      0,
    )!;
    assert.deepEqual(sel.front, ["C1001", "C1002"], "组 1（先攻 25）先于组 2（20）");
  });
});

describe("deriveNext：分支序全谱（快照字面量 → NextCommand）", () => {
  it("死锁：全员无计时器 → player reason=deadlock", () => {
    const cmd = deriveNext(snap({ C0: ch({ timer: null, isPlayer: true }), C1001: ch({ timer: null }) }));
    assert.deepEqual(cmd, { type: "player", reason: "deadlock", setup: NO_SETUP } satisfies NextCommand);
  });

  it("prose 衔接：末步 gm 且 narrativity≠skip → prose；包缺失（null）同；skip 不落 prose", () => {
    const chars = { C1001: ch({ timer: 10 }) };
    assert.deepEqual(
      deriveNext(snap(chars, { lastStepKind: "gm", lastGmNarrativity: "full" })),
      { type: "prose", setup: NO_SETUP } satisfies NextCommand,
    );
    assert.deepEqual(
      deriveNext(snap(chars, { lastStepKind: "gm", lastGmNarrativity: null })),
      { type: "prose", setup: NO_SETUP } satisfies NextCommand,
      "interrupted 的 gm 步无解析包（null）→ 展示态仍推导 prose",
    );
    assert.notEqual(
      deriveNext(snap(chars, { lastStepKind: "gm", lastGmNarrativity: "skip" })).type,
      "prose",
    );
  });

  it("prose 优先于一切调度分支（gm 步刚闭合 + GM trigger 悬挂仍是 prose）", () => {
    const cmd = deriveNext(
      snap(
        { C1001: ch({ timer: 5, group: 1, initiative: { value: 25, group: 1 }, acted: true }) },
        { lastStepKind: "gm", lastGmNarrativity: "full", gmTrigger: true, gmTriggerBatch: 25 },
      ),
    );
    assert.equal(cmd.type, "prose");
  });

  it("行动顺序表：先攻降序取第一个未行动者；due 仅在弹出时刻 > 当前时钟时携带", () => {
    const chars = {
      C1001: ch({ timer: 10, group: 1, initiative: { value: 25, group: 1 } }),
      C1002: ch({ timer: 10, group: 1, initiative: { value: 12, group: 1 } }),
    };
    assert.deepEqual(deriveNext(snap(chars)), {
      type: "character",
      cid: "C1001",
      setup: { due: 10, actedClears: [], cycleIncrement: false, foreground: ["C1001", "C1002"] },
    } satisfies NextCommand);
    // C1001 已行动 → C1002
    assert.deepEqual(deriveNext(snap({ ...chars, C1001: ch({ ...chars.C1001, acted: true }) })), {
      type: "character",
      cid: "C1002",
      setup: { due: 10, actedClears: [], cycleIncrement: false, foreground: ["C1001", "C1002"] },
    } satisfies NextCommand);
    // 弹出时刻 ≤ 当前时钟（连续轮）→ setup 不带 due
    const atClock = deriveNext(snap(chars, { clock: 10 }));
    assert.deepEqual(atClock, {
      type: "character",
      cid: "C1001",
      setup: { actedClears: [], cycleIncrement: false, foreground: ["C1001", "C1002"] },
    } satisfies NextCommand);
  });

  it("玩家回合：下一行动者是玩家 → player reason=turn（无 cid 断言）", () => {
    const cmd = deriveNext(
      snap({
        C0: ch({ timer: 10, group: 1, isPlayer: true, initiative: { value: 25, group: 1 } }),
        C1001: ch({ timer: 10, group: 1, initiative: { value: 12, group: 1 } }),
      }),
    );
    assert.deepEqual(cmd, {
      type: "player",
      reason: "turn",
      setup: { due: 10, actedClears: [], cycleIncrement: false, foreground: ["C0", "C1001"] },
    } satisfies NextCommand);
  });

  it("同刻多组串行：前台 = 首组；后台已行动成员进 actedClears", () => {
    const cmd = deriveNext(
      snap({
        C1001: ch({ timer: 10, group: 1, initiative: { value: 25, group: 1 } }),
        C1002: ch({ timer: 10, group: 1, initiative: { value: 12, group: 1 } }),
        C1003: ch({ timer: 10, group: 2, initiative: { value: 20, group: 2 } }),
        C1004: ch({ timer: 10, group: 2, initiative: { value: 8, group: 2 }, acted: true }),
      }),
    );
    assert.deepEqual(cmd, {
      type: "character",
      cid: "C1001",
      setup: { due: 10, actedClears: ["C1004"], cycleIncrement: false, foreground: ["C1001", "C1002"] },
    } satisfies NextCommand);
  });

  it("GM trigger：触发批全员行动完 → 立即 GM；批未完成 → 批外下一行动者", () => {
    const chars = {
      C1001: ch({ timer: 5, group: 1, initiative: { value: 25, group: 1 }, acted: true }),
      C1002: ch({ timer: 5, group: 1, initiative: { value: 12, group: 1 } }),
    };
    // 批（先攻 25）= 仅 C1001，已行动 → GM（C1002 未行动也不挡）
    assert.deepEqual(deriveNext(snap(chars, { gmTrigger: true, gmTriggerBatch: 25 })), {
      type: "gm",
      setup: { due: 5, actedClears: [], cycleIncrement: false, foreground: ["C1001", "C1002"] },
    } satisfies NextCommand);
    // 批未完成（C1001 未行动）→ 正常顺序 C1001
    assert.deepEqual(
      deriveNext(snap({ ...chars, C1001: ch({ ...chars.C1001, acted: false }) }, { gmTrigger: true, gmTriggerBatch: 25 })),
      {
        type: "character",
        cid: "C1001",
        setup: { due: 5, actedClears: [], cycleIncrement: false, foreground: ["C1001", "C1002"] },
      } satisfies NextCommand,
    );
    // gmTriggerBatch 缺失（null）→ 哨兵批 = 无先攻值者
    const noInit = deriveNext(
      snap(
        { C1001: ch({ timer: 5, initiative: null, acted: true }) },
        { gmTrigger: true, gmTriggerBatch: null },
      ),
    );
    assert.equal(noInit.type, "gm", "无先攻值角色触发：批完成判定真空成立 → 立即 GM");
  });

  it("邀请应答优先于 GM trigger：pending 邀请在，先应答再谈触发", () => {
    const chars = {
      C1001: ch({ timer: 5, group: 1, initiative: { value: 25, group: 1 }, acted: true }),
      C1002: ch({ timer: 5, group: 2, initiative: { value: 20, group: 2 } }),
    };
    const cmd = deriveNext(
      snap(chars, { gmTrigger: true, gmTriggerBatch: 25, pendingInvitation: invitation("C1002") }),
    );
    assert.deepEqual(cmd, {
      type: "character",
      cid: "C1002",
      setup: { due: 5, actedClears: [], cycleIncrement: false, foreground: ["C1001"] },
      invitation: invitation("C1002"),
    } satisfies NextCommand);
  });

  it("邀请目标是玩家 → player 命令携带 invitation", () => {
    const cmd = deriveNext(
      snap(
        {
          C0: ch({ timer: 10, isPlayer: true }),
          C1001: ch({ timer: 5, group: 1, initiative: { value: 25, group: 1 }, acted: true }),
        },
        { pendingInvitation: invitation("C0") },
      ),
    );
    assert.deepEqual(cmd, {
      type: "player",
      reason: "turn",
      setup: { due: 5, actedClears: [], cycleIncrement: false, foreground: ["C1001"] },
      invitation: invitation("C0"),
    } satisfies NextCommand);
  });

  it("周期完成：X+1 达 N → 周期末 GM；否则 X+1 + 清全员 acted 进下一周期", () => {
    const chars = {
      C1001: ch({ timer: 10, group: 1, initiative: { value: 25, group: 1 }, acted: true }),
      C1002: ch({ timer: 10, group: 1, initiative: { value: 12, group: 1 }, acted: true }),
    };
    // 周期末硬保险（cycleCount+1 >= gmIntervalCycles）→ GM
    assert.deepEqual(deriveNext(snap(chars, { cycleCount: 2, gmIntervalCycles: 3 })), {
      type: "gm",
      setup: { due: 10, actedClears: [], cycleIncrement: false, foreground: ["C1001", "C1002"] },
    } satisfies NextCommand);
    // 未达 N → 下一周期首行动者（先攻最高者），cycleIncrement + 清前台全员 acted
    assert.deepEqual(deriveNext(snap(chars, { cycleCount: 0, gmIntervalCycles: 3 })), {
      type: "character",
      cid: "C1001",
      setup: { due: 10, actedClears: ["C1001", "C1002"], cycleIncrement: true, foreground: ["C1001", "C1002"] },
    } satisfies NextCommand);
  });

  it("前台仅 1 人时 GM 硬保险阈值恒为 1：每行动一次周期末即 GM（多人组残余单人同算）", () => {
    // 单人前台（group=0）：cycleCount+1 >= 1 恒真 → 周期末 GM
    const solo = { C1001: ch({ timer: 10, initiative: { value: 25, group: 0 }, acted: true }) };
    assert.deepEqual(deriveNext(snap(solo, { cycleCount: 0, gmIntervalCycles: 3 })), {
      type: "gm",
      setup: { due: 10, actedClears: [], cycleIncrement: false, foreground: ["C1001"] },
    } satisfies NextCommand);
    // 多人组的最后一名在场成员（组员 timer=null 已离场）同样按单人计
    const remnant = {
      C1001: ch({ timer: 10, group: 1, initiative: { value: 25, group: 1 }, acted: true }),
      C1002: ch({ timer: null, group: 1, initiative: { value: 12, group: 1 }, acted: true }),
    };
    assert.deepEqual(deriveNext(snap(remnant, { cycleCount: 0, gmIntervalCycles: 3 })), {
      type: "gm",
      setup: { due: 10, actedClears: ["C1002"], cycleIncrement: false, foreground: ["C1001"] },
    } satisfies NextCommand);
    // 多人前台：阈值不变（未达 N → 下一周期）
    const multi = {
      C1001: ch({ timer: 10, group: 1, initiative: { value: 25, group: 1 }, acted: true }),
      C1002: ch({ timer: 10, group: 1, initiative: { value: 12, group: 1 }, acted: true }),
    };
    assert.equal(
      deriveNext(snap(multi, { cycleCount: 0, gmIntervalCycles: 3 })).type,
      "character",
    );
  });

  it("actedClears 合并：后台已行动（排序）+ 周期完成追加前台全员（既有口径，不全局重排）", () => {
    const cmd = deriveNext(
      snap({
        C1001: ch({ timer: 10, group: 1, initiative: { value: 25, group: 1 }, acted: true }),
        C1002: ch({ timer: 10, group: 1, initiative: { value: 12, group: 1 }, acted: true }),
        C1004: ch({ timer: 20, group: 2, acted: true }),
      }),
    );
    assert.deepEqual(cmd, {
      type: "character",
      cid: "C1001",
      setup: { due: 10, actedClears: ["C1004", "C1001", "C1002"], cycleIncrement: true, foreground: ["C1001", "C1002"] },
    } satisfies NextCommand);
  });
});

describe("phaseOf / expectedGmDurationCids", () => {
  it("phaseOf 四分支映射", () => {
    assert.equal(phaseOf({ type: "player", reason: "turn", setup: NO_SETUP }), "await_player");
    assert.equal(phaseOf({ type: "player", reason: "deadlock", setup: NO_SETUP }), "await_player");
    assert.equal(phaseOf({ type: "character", cid: "C1", setup: NO_SETUP }), "await_character");
    assert.equal(phaseOf({ type: "gm", setup: NO_SETUP }), "await_gm");
    assert.equal(phaseOf({ type: "prose", setup: NO_SETUP }), "await_prose");
  });

  it("expectedGmDurationCids：同步组全体成员（含 timer=null 者）∪ 行动者；后台他组不进", () => {
    const chars = {
      C0: ch({ group: 1 }),
      C1001: ch({ group: 1, timer: null }),
      C1002: ch({ group: 2 }),
      C1003: ch({ group: 0 }),
    };
    assert.deepEqual(expectedGmDurationCids(chars, ["C0"]), ["C0", "C1001"]);
    assert.deepEqual(expectedGmDurationCids(chars, ["C0", "C1002"]), ["C0", "C1001", "C1002"]);
    assert.deepEqual(expectedGmDurationCids(chars, ["C1003"]), ["C1003"], "单人组行动者：期望集 = 自身");
  });
});
