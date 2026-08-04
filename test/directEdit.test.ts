import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { GameSession } from "../src/application/gameSession.js";
import { GenerationRepository } from "../src/truth/generationRepository.js";
import { buildAdjudication as gmPkg } from "./builders/index.js";
import { SessionHarness } from "./harness/session.js";

// ---------------------------------------------------------------------------
// 状态栏直接编辑（GameSession.applyDirectEdit）：整体替换 world/characters/events，
// 不经过裁决；world/characters 变量差异净额并入当前步 changes.effects（回溯随该步还原），
// events 域不进变更记录（回溯按 seq 截断事件）；LLM 在途拒绝；校验失败整体还原。
// 集成基建 = SessionHarness（临时世界设定集 + fake LLM + 确定性骰子）。
// ---------------------------------------------------------------------------

const h = new SessionHarness("airp-direct-edit-");

const WORLD_ID = `w-edit-${process.pid}`;
h.setupWorld(WORLD_ID, [
  { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
  { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
]);

/** narrativity=full 的 GM 包（触发正文步；timer 覆盖本轮行动者；可带 world deltas）。 */
function gmFull(deltas: Record<string, unknown>[] = []): Record<string, unknown> {
  return gmPkg({
    narrativity: "full",
    deltas,
    timer: [
      { cid: "C0", span: { min: 5 } },
      { cid: "C1001", span: { min: 5 } },
    ],
  });
}

const NO_PAUSE = { everyStep: false, beforeGm: false, afterGm: false, afterProse: false };

function makeSession(
  tag: string,
  options?: { pause?: typeof NO_PAUSE; gm?: Record<string, unknown>; gmIntervalCycles?: number },
): { session: GameSession; dir: string } {
  const runId = `run-edit-${tag}-${process.pid}`;
  const session = h.makeSession(runId, WORLD_ID, {
    dice: [5, 20],
    gmIntervalCycles: options?.gmIntervalCycles ?? 1,
    gm: [options?.gm ?? gmFull()],
  });
  session.setPauseOptions(options?.pause ?? NO_PAUSE);
  return { session, dir: path.join(h.runsDir, runId) };
}

/** 深拷贝当前 {world, characters} 作为编辑底本（保持角色集合一致）。 */
function stateClone(session: GameSession): { world: Record<string, unknown>; characters: Record<string, Record<string, unknown>> } {
  return JSON.parse(JSON.stringify(session.getState())) as never;
}

describe("applyDirectEdit（状态栏直接编辑）", () => {
  it("整体替换 world/characters：立即生效且持久化（重开 store 读回）", () => {
    const { session, dir } = makeSession("vars");
    const { world, characters } = stateClone(session);
    world["hp"] = 42;
    (characters["C1001"] as { name: string; timer: number }).name = "新名字";
    (characters["C1001"] as { name: string; timer: number }).timer = 12345;

    session.applyDirectEdit({ world, characters });

    const after = session.getState() as {
      world: Record<string, unknown>;
      characters: Record<string, { name: string; timer: number }>;
    };
    assert.equal(after.world["hp"], 42);
    assert.equal(after.characters["C1001"]!.name, "新名字");
    assert.equal(after.characters["C1001"]!.timer, 12345);

    // 持久化：从磁盘 loadCurrent 读回（存档 v6：唯一读盘口径）
    const loaded = new GenerationRepository(dir).loadCurrent();
    assert.equal(loaded.save.world["hp"], 42);
    assert.equal(loaded.save.characters["C1001"]!.name, "新名字");
    assert.equal(loaded.save.characters["C1001"]!.timer, 12345);
  });

  it("整体替换 events：事件表生效，下一次激活注入即读新事件集（无状态 activation，无缓存可重建）", async () => {
    const { session, dir } = makeSession("events");
    const events = [
      { id: "evt_e1", t: 0, seq: 1, kind: "world", tags: ["known_by:C1001"], payload: "替换后的事件" },
    ];

    session.applyDirectEdit({ events });

    assert.deepEqual(session.getEvents().map((e) => e.id), ["evt_e1"]);
    // §4：agent 侧无事件缓存——直编后下一次角色激活的 prompt 直接读到新事件
    await session.continuePipeline(); // seq1 C1001 行动 → 停等玩家
    assert.ok(h.callsText("character:C1001", 1).includes("替换后的事件"));
    // 持久化：从磁盘 loadCurrent 读回
    const loaded = new GenerationRepository(dir).loadCurrent();
    assert.deepEqual(loaded.save.events.map((e) => e.payload), ["替换后的事件"]);
  });

  it("直编删中段事件后：GM 步新事件 ID 按水位分配，不与现存冲突", async () => {
    const { session } = makeSession("watermark", { pause: { ...NO_PAUSE, afterGm: true } });
    // 三次 GM 步各需一个裁决包（makeSession 的 gm 选项是单包，追加经 fake 队列）
    h.llm.gmQueue.push(gmFull(), gmFull());
    // 两次 GM 步 → evt_0001 / evt_0002
    await session.continuePipeline(); // seq1 C1001 → 停等玩家
    await session.handlePlayerInput("玩家行动"); // seq2 玩家 → seq3 GM（evt_0001）→ GM 后停
    await session.continuePipeline(); // seq4 正文 → seq5 C1001 → 停等玩家
    await session.handlePlayerInput("玩家行动"); // seq6 玩家 → seq7 GM（evt_0002）→ GM 后停
    const e1 = session.getEvents().find((e) => e.id === "evt_0001");
    assert.ok(e1, "前置：evt_0001 已提交");

    // 直编：删中段语义——事件表变为 evt_0001 + evt_0003（evt_0002 缺口）。
    // 长度推导会分配 evt_0003（与现存冲突）；水位推导应分配 evt_0004。
    session.applyDirectEdit({
      events: [e1, { id: "evt_0003", t: e1.t, seq: e1.seq, kind: "world", tags: e1.tags, payload: "手工事件" }],
    });

    await session.continuePipeline(); // seq8 正文 → seq9 C1001 → 停等玩家
    await session.handlePlayerInput("玩家行动"); // seq10 玩家 → seq11 GM → GM 后停

    const ids = session.getEvents().map((e) => e.id);
    assert.ok(ids.includes("evt_0004"), `新事件应取水位后的 evt_0004，实为 ${ids.join(",")}`);
    assert.equal(new Set(ids).size, ids.length, `事件 ID 不得冲突：${ids.join(",")}`);
  });

  it("非法 schema 拒绝且不落盘（world 缺 time / characters 缺字段 / events 形状非法 / 增删角色）", () => {
    const { session, dir } = makeSession("invalid");
    const genDir = path.join(dir, "generations", fs.readFileSync(path.join(dir, "CURRENT"), "utf8").trim());
    const before = Object.fromEntries(
      ["world.json", "characters.json", "events.json"].map((f) => [f, fs.readFileSync(path.join(genDir, f), "utf8")]),
    );
    const { world, characters } = stateClone(session);

    assert.throws(() => session.applyDirectEdit({ world: { hp: 1 } }), /time/);
    const brokenChars = JSON.parse(JSON.stringify(characters)) as Record<string, Record<string, unknown>>;
    delete brokenChars["C1001"]!["name"];
    assert.throws(() => session.applyDirectEdit({ characters: brokenChars }));
    assert.throws(() => session.applyDirectEdit({ events: [{ bad: 1 }] }));
    const extraChars = JSON.parse(JSON.stringify(characters)) as Record<string, unknown>;
    extraChars["C9999"] = extraChars["C1001"];
    assert.throws(() => session.applyDirectEdit({ characters: extraChars }), /不增删角色/);

    // 未落盘：三个核心文件逐字节不变（无新 Generation）；运行态也不变
    assert.equal(fs.readFileSync(path.join(dir, "CURRENT"), "utf8").trim(), path.basename(genDir));
    for (const [f, content] of Object.entries(before)) {
      assert.equal(fs.readFileSync(path.join(genDir, f), "utf8"), content, `${f} 不应被写入`);
    }
    assert.deepEqual(session.getState(), { world, characters });
  });

  it("LLM 在途（busy）拒绝，空闲后放行", () => {
    const { session } = makeSession("busy");
    const { world } = stateClone(session);
    session.setBusy(true);
    assert.throws(() => session.applyDirectEdit({ world }), /运行中/);
    session.setBusy(false);
    session.applyDirectEdit({ world }); // 不再抛错
  });

  it("phase 由 deriveNext 重推落盘（timer 编辑直接影响调度派生）", () => {
    const { session } = makeSession("phase");
    const { characters } = stateClone(session);
    // 玩家 timer 最大 → 下一个行动者是 C1001
    (characters["C0"] as { timer: number }).timer = 99999;
    (characters["C1001"] as { timer: number }).timer = 0;
    session.applyDirectEdit({ characters });
    assert.equal(session.pipelineInfo.phase, "await_character");
    // 反之 C1001 更晚 → 停等玩家
    const again = stateClone(session);
    (again.characters["C0"] as { timer: number }).timer = 0;
    (again.characters["C1001"] as { timer: number }).timer = 99999;
    session.applyDirectEdit({ characters: again.characters });
    assert.equal(session.pipelineInfo.phase, "await_player");
  });
});

describe("直编调度变量：下一段派生立即使用新值（acted / initiative）", () => {
  it("用户场景：NPC 发言完停等玩家 → 直编 C0.acted=true → 下一步立即是 C1001（输入立即拒并指明在等谁）", async () => {
    const { session } = makeSession("acted-fwd", { gmIntervalCycles: 5 });
    await session.continuePipeline(); // seq1 C1001 发言 → 停等玩家
    assert.equal(session.pipelineInfo.phase, "await_player");
    assert.equal(session.pipelineInfo.kind, "character:C1001");

    const edit = stateClone(session);
    (edit.characters["C0"] as { acted: boolean }).acted = true;
    session.applyDirectEdit({ characters: edit.characters });

    // 立即生效：全员已行动 → 周期完成 → 下一周期首棒 = C1001（先攻高）
    assert.equal(session.pipelineInfo.phase, "await_character");
    // 输入校验以最新派生为准：立即拒绝并指明当前在等 C1001
    await assert.rejects(() => session.handlePlayerInput("抢跑"), /不是玩家回合.*C1001/);
    // 继续：C1001 在新周期再次行动（X+1=1 < 5，无 GM），随后停等玩家
    await session.continuePipeline();
    assert.equal(session.pipelineInfo.phase, "await_player");
    assert.equal(session.pipelineInfo.kind, "character:C1001");
  });

  it("反向：开局 await_character → 直编 C1001.acted=true → 立即 await_player（输入立即可用）", async () => {
    const { session } = makeSession("acted-rev", { gmIntervalCycles: 5 });
    assert.equal(session.pipelineInfo.phase, "await_character"); // C1001 先攻 25 先行动

    const edit = stateClone(session);
    (edit.characters["C1001"] as { acted: boolean }).acted = true;
    session.applyDirectEdit({ characters: edit.characters });
    assert.equal(session.pipelineInfo.phase, "await_player");

    // 输入立即被接受：玩家步 → 周期完成（X+1=1 < 5）→ C1001 新周期行动 → 停等玩家
    await session.handlePlayerInput("玩家行动");
    assert.equal(session.turnCount, 2);
    assert.equal(session.pipelineInfo.phase, "await_player");
    assert.equal(session.pipelineInfo.kind, "character:C1001");
  });

  it("直编 initiative.value 换序：行动顺序立即改变", () => {
    const { session } = makeSession("init-swap", { gmIntervalCycles: 5 });
    assert.equal(session.pipelineInfo.phase, "await_character"); // C0=10 / C1001=25 → C1001 先

    const edit = stateClone(session);
    const c0 = edit.characters["C0"] as { initiative: { value: number; group: number } };
    const c1 = edit.characters["C1001"] as { initiative: { value: number; group: number } };
    const v = c0.initiative.value;
    c0.initiative.value = c1.initiative.value;
    c1.initiative.value = v;
    session.applyDirectEdit({ characters: edit.characters });

    assert.equal(session.pipelineInfo.phase, "await_player"); // 换序后 C0=25 先行动
  });

  it("docs §3 验收：await_player 中直编把 NPC 先攻改到玩家之前 → 下一次玩家输入被拒 + 派生给出该 NPC", async () => {
    // dice [20, 5] → C0=25 / C1001=10：开局玩家先行，旧 await_player 成立
    const runId = `run-edit-init-perm-${process.pid}`;
    const session = h.makeSession(runId, WORLD_ID, { dice: [20, 5], gmIntervalCycles: 5, gm: [gmFull()] });
    session.setPauseOptions(NO_PAUSE);
    assert.equal(session.pipelineInfo.phase, "await_player");

    // 直编换序：C1001=25 排到玩家之前
    const edit = stateClone(session);
    const c0 = edit.characters["C0"] as { initiative: { value: number; group: number } };
    const c1 = edit.characters["C1001"] as { initiative: { value: number; group: number } };
    const v = c0.initiative.value;
    c0.initiative.value = c1.initiative.value;
    c1.initiative.value = v;
    session.applyDirectEdit({ characters: edit.characters });

    // 编辑提交完成后的下一次权限检查必须立即得到新顺序：旧 await_player 不得放行
    assert.equal(session.pipelineInfo.phase, "await_character");
    await assert.rejects(() => session.handlePlayerInput("抢跑"), /不是玩家回合.*C1001/);
    // 继续：C1001 先行动，随后才轮到玩家
    await session.continuePipeline();
    assert.equal(session.pipelineInfo.kind, "character:C1001");
    assert.equal(session.pipelineInfo.phase, "await_player");
  });
});

describe("直编差异并入当前步 changes.effects（净额合并，回溯随该步还原）", () => {
  /** 取 current 或归档条目 StepChanges（扁平 = 先 setup 后 effects，与旧扁平口径同序）中某路径的全部记录。 */
  function recordsOf(
    source: { changes?: { setup: readonly { path: string }[]; effects: readonly { path: string }[] } | undefined } | null,
    path: string,
  ) {
    return [...(source?.changes?.setup ?? []), ...(source?.changes?.effects ?? [])].filter((c) => c.path === path);
  }

  it("用户例子逐步复现：步内 0→100 后直编 50 → 归档净记录 0→50；回溯到该步 = 50、到上一步 = 0", async () => {
    const { session } = makeSession("net", {
      pause: { ...NO_PAUSE, afterGm: true },
      gm: gmFull([{ path: "A", op: "=", value: 100 }]),
    });
    // SEQ=0 基线：首步之前（current=null）直编 A=0 —— 不并入，编辑即初始基线
    const base = stateClone(session);
    base.world["A"] = 0;
    session.applyDirectEdit({ world: base.world });
    assert.equal(session.getPipelineCurrent(), null, "首步之前不建步");

    await session.continuePipeline(); // seq1 C1001 → 停等玩家
    await session.handlePlayerInput("玩家行动"); // seq2 玩家 → seq3 GM（A: 0→100）→ GM 后停

    // SEQ=1 窗口内的手动编辑：A 调成 50（current = seq3 GM 步）
    const edit = stateClone(session);
    edit.world["A"] = 50;
    session.applyDirectEdit({ world: edit.world });

    // 净额合并：同路径改写末条 after，不产生追加流水（无 100→50 独立条目）
    const current = session.getPipelineCurrent();
    assert.equal(current?.seq, 3);
    const liveRecords = recordsOf(current, "world.A");
    assert.equal(liveRecords.length, 1, "world.A 只有一条净记录");
    assert.deepEqual(liveRecords[0], { path: "world.A", before: 0, after: 50 });

    // 驱动下一步启动 → seq3 归档：归档条目同样是净记录 0→50
    await session.continuePipeline(); // seq4 正文（归档 seq3）→ seq5 C1001 → 停等玩家
    const archived = session.getArchive().find((e) => e.seq === 3);
    assert.ok(archived, "seq3 已归档");
    const archivedRecords = recordsOf(archived, "world.A");
    assert.equal(archivedRecords.length, 1, "归档 world.A 只有一条净记录");
    assert.deepEqual(archivedRecords[0], { path: "world.A", before: 0, after: 50 });

    // 回溯到第 3 步结束 → A=50（含手动编辑）；回溯到第 2 步结束 → A=0
    session.rollbackTo(3);
    assert.equal((session.getState().world as Record<string, unknown>)["A"], 50);
    session.rollbackTo(2);
    assert.equal((session.getState().world as Record<string, unknown>)["A"], 0);
  });

  it("直编新增路径：并入条目 before_exists=false 且落在末尾；回滚后路径删除并 prune", async () => {
    const { session } = makeSession("add", { pause: { ...NO_PAUSE, beforeGm: true } });
    await session.continuePipeline(); // seq1 C1001 → 停等玩家
    await session.handlePlayerInput("玩家行动"); // seq2 玩家步 → GM 前停（current=seq2）

    const edit = stateClone(session);
    edit.world["region"] = { harbor: { fog: true } };
    session.applyDirectEdit({ world: edit.world });

    const current = session.getPipelineCurrent();
    const changes = current?.changes?.effects ?? [];
    const rec = recordsOf(current, "world.region");
    assert.equal(rec.length, 1);
    assert.deepEqual(rec[0], {
      path: "world.region",
      before: null,
      after: { harbor: { fog: true } },
      before_exists: false,
    });
    assert.equal(changes[changes.length - 1], rec[0], "新增记录尾部追加（effects 段）");

    session.rollbackTo(1);
    const world = session.getState().world as Record<string, unknown>;
    assert.ok(!("region" in world), "回滚后新增子树删除并 prune 空父层");
  });

  it("直编删除既有路径：after_exists=false 尾部追加；回滚后恢复原值", async () => {
    const { session } = makeSession("del", { pause: { ...NO_PAUSE, beforeGm: true } });
    // 基线 A=0（current=null，不并入）
    const base = stateClone(session);
    base.world["A"] = 0;
    session.applyDirectEdit({ world: base.world });
    await session.continuePipeline(); // seq1
    await session.handlePlayerInput("玩家行动"); // seq2 → GM 前停

    const edit = stateClone(session);
    delete edit.world["A"];
    session.applyDirectEdit({ world: edit.world });

    const current = session.getPipelineCurrent();
    const changes = current?.changes?.effects ?? [];
    const rec = recordsOf(current, "world.A");
    assert.equal(rec.length, 1);
    assert.deepEqual(rec[0], { path: "world.A", before: 0, after: null, after_exists: false });
    assert.equal(changes[changes.length - 1], rec[0], "删除记录尾部追加（effects 段）");

    session.rollbackTo(1);
    assert.equal((session.getState().world as Record<string, unknown>)["A"], 0, "回滚后恢复原值");
  });

  it("分段安全：setup 段不受影响；effects 段已有条目不删不动，同路径只改写末条 after + 尾部追加", async () => {
    const { session } = makeSession("idx");
    await session.continuePipeline(); // seq1 C1001 → 停等玩家（current=seq1 角色步）
    const before = JSON.parse(JSON.stringify(session.getPipelineCurrent())) as {
      changes?: { setup: { path: string; before: unknown; after: unknown }[]; effects: { path: string; before: unknown; after: unknown }[] };
      result: Record<string, unknown>;
    };
    const beforeEffects = before.changes?.effects ?? [];
    assert.ok(
      beforeEffects.some((c) => c.path === "characters.C1001.acted"),
      "前置：该步 effects 段已有 C1001.acted 记录（false→true）",
    );

    const edit = stateClone(session);
    (edit.characters["C1001"] as { acted: boolean }).acted = false; // 同路径：改写末条 after
    edit.world["fresh"] = 1; // 无记录：尾部追加
    session.applyDirectEdit({ world: edit.world, characters: edit.characters });

    const after = session.getPipelineCurrent();
    assert.deepEqual(after?.changes?.setup ?? [], before.changes?.setup ?? [], "setup 段原样不动");
    const afterEffects = after?.changes?.effects ?? [];
    assert.equal(afterEffects.length, beforeEffects.length + 1, "只改写末条 + 尾部追加，条目不删不动");
    // 前 N 条原位：除被改写的 C1001.acted 外逐字节一致
    for (let i = 0; i < beforeEffects.length; i++) {
      if (beforeEffects[i]!.path === "characters.C1001.acted") continue;
      assert.deepEqual(afterEffects[i], beforeEffects[i], `第 ${i} 条不变`);
    }
    const acted = recordsOf(after, "characters.C1001.acted");
    assert.equal(acted.length, 1, "acted 净记录只有一条（链条 0→1 被改写为 0→0）");
    assert.deepEqual(acted[0], { path: "characters.C1001.acted", before: false, after: false });
    assert.deepEqual(afterEffects[afterEffects.length - 1], {
      path: "world.fresh",
      before: null,
      after: 1,
      before_exists: false,
    });
    // v7：数组下标定位（effects_from/markers_from）已删除，分段安全由 setup/effects 结构本身保证
    const afterResult = after?.result as Record<string, unknown>;
    assert.ok(!("effects_from" in afterResult) && !("markers_from" in afterResult));
  });

  it("current=null（首步之前）：直编不崩溃、不并入，编辑即初始基线", () => {
    const { session } = makeSession("null");
    const { world } = stateClone(session);
    world["hp"] = 1;
    session.applyDirectEdit({ world });
    assert.equal(session.getPipelineCurrent(), null, "不建步不并入");
    assert.equal((session.getState().world as Record<string, unknown>)["hp"], 1);
  });
});
