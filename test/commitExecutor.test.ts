import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { GameSession } from "../src/application/gameSession.js";
import { CommitExecutor, type CommitPlan } from "../src/truth/commitExecutor.js";
import { TRUTH_FILES } from "../src/truth/generationRepository.js";
import { buildAdjudication as gmPkg } from "./builders/index.js";
import { SessionHarness } from "./harness/session.js";

// ---------------------------------------------------------------------------
// CommitExecutor 统一入口 + draft 编辑/回溯/直编收敛：
// - 非法 GM 编辑（durations 覆盖不全）/非法角色编辑/非法直编失败 → 内存/CURRENT/磁盘 Generation 三不变
//   （GM 步在 draft 上先校验后反转、不留已反转残态的回归测试）；
// - rollback → revision 递增 + seq 回退 + 新 Generation 逐字节 = 回滚目标态；
// - 五条写盘路径的 CommitPlan.reason（init/step/gm/rollback/admin_edit）；
// - 恒冻结：getState()/snapshot() 深改抛 TypeError。
// ---------------------------------------------------------------------------

const h = new SessionHarness("airp-commit-executor-");

const WORLD_ID = `w-ce-${process.pid}`;
h.setupWorld(WORLD_ID, [
  { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
  { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
]);

const NO_PAUSE = { everyStep: false, beforeGm: false, afterGm: false, afterProse: false };

/** durations 覆盖 C0+C1001 的合法裁决包。 */
function gmFull(): Record<string, unknown> {
  return gmPkg({
    narrativity: "skip",
    durations: [
      { cid: "C0", span: { min: 5 } },
      { cid: "C1001", span: { min: 5 } },
    ],
  });
}

function makeSession(
  tag: string,
  options?: { pause?: typeof NO_PAUSE; gm?: Record<string, unknown>[] },
): { session: GameSession; dir: string } {
  const runId = `run-ce-${tag}-${process.pid}`;
  const session = h.makeSession(runId, WORLD_ID, {
    // 2 颗开局先攻 + 1 个 GM 步的 fortune 4 骰（良恶/程度判定，值只进提示词）；
    // 各测试至多跑 1 个 GM 步，且 gmFull() durations 覆盖全部角色 → 突发评估整组跳过、不消费骰子。
    dice: [5, 20, 50, 50, 50, 50],
    gmIntervalCycles: 1,
    gm: options?.gm ?? [gmFull()],
  });
  session.setPauseOptions(options?.pause ?? NO_PAUSE);
  return { session, dir: path.join(h.saveDir, runId) };
}

/** 三不变快照：内存（state/events/pipeline current）+ CURRENT + 当前 Generation 六文件原文。 */
function captureTruth(session: GameSession, dir: string) {
  const revision = fs.readFileSync(path.join(dir, "CURRENT"), "utf8").trim();
  const genDir = path.join(dir, "generations", revision);
  return {
    state: JSON.stringify(session.getState()),
    events: JSON.stringify(session.getEvents()),
    current: JSON.stringify(session.getPipelineCurrent()),
    revision,
    files: TRUTH_FILES.map((f) => fs.readFileSync(path.join(genDir, f), "utf8")),
  };
}

function assertTruthUnchanged(session: GameSession, dir: string, snap: ReturnType<typeof captureTruth>): void {
  assert.equal(JSON.stringify(session.getState()), snap.state, "内存 state 不得变化");
  assert.equal(JSON.stringify(session.getEvents()), snap.events, "内存 events 不得变化");
  assert.equal(JSON.stringify(session.getPipelineCurrent()), snap.current, "内存 pipeline current 不得变化");
  const revision = fs.readFileSync(path.join(dir, "CURRENT"), "utf8").trim();
  assert.equal(revision, snap.revision, "CURRENT 不得前移（不得产生新 Generation）");
  const genDir = path.join(dir, "generations", revision);
  TRUTH_FILES.forEach((f, i) => {
    assert.equal(fs.readFileSync(path.join(genDir, f), "utf8"), snap.files[i], `${f} 不得被写入`);
  });
}

describe("编辑失败零副作用（draft 机制：内存/CURRENT/磁盘 Generation 三不变）", () => {
  it("非法 GM 编辑（durations 覆盖不全）：已完成 GM 步先反转后校验失败，三不变且后续合法编辑照常", async () => {
    const { session, dir } = makeSession("gm-edit-invalid", {
      pause: { ...NO_PAUSE, afterGm: true },
    });
    await session.continuePipeline(); // seq1 C1001 → 停等玩家
    await session.handlePlayerInput("玩家行动"); // seq2 玩家 → seq3 GM → GM 后停
    assert.equal(session.getPipelineCurrent()?.kind, "gm");

    const snap = captureTruth(session, dir);
    // timer 只覆盖 C0、漏 C1001 → 契约校验失败（校验先于反转，不留已反转残态）
    const invalid = gmPkg({ narrativity: "skip", durations: [{ cid: "C0", span: { min: 9 } }] });
    assert.throws(() => session.editResult(JSON.stringify(invalid)), /durations cid 必须精确覆盖/);
    assertTruthUnchanged(session, dir, snap);

    // 无残态的直接证据：同一 GM 步的合法编辑照常成功（旧缺陷下旧效应已被反转、状态错乱）
    const valid = gmPkg({
      narrativity: "skip",
      durations: [
        { cid: "C0", span: { min: 10 } },
        { cid: "C1001", span: { min: 10 } },
      ],
    });
    session.editResult(JSON.stringify(valid));
    assert.equal(h.charState(session, "C0").timer, 10);
    assert.equal(h.charState(session, "C1001").timer, 10);
    assert.equal(session.getPipelineCurrent()?.edited, true);
  });

  it("非法角色编辑（决策包 schema 不符）：三不变，后续合法编辑照常", async () => {
    const { session, dir } = makeSession("char-edit-invalid");
    await session.continuePipeline(); // seq1 C1001 → 停等玩家（current = 角色步）
    assert.equal(session.getPipelineCurrent()?.kind, "character:C1001");

    const snap = captureTruth(session, dir);
    assert.throws(() => session.editResult(JSON.stringify({ foo: "bar" })), /决策包解析失败/);
    assertTruthUnchanged(session, dir, snap);

    session.editResult(JSON.stringify({ action: "改后行动", inner: "改后内心" }));
    assert.equal(session.getPipelineCurrent()?.edited, true);
  });

  it("非法直编（world 缺 time 锚）：三不变", () => {
    const { session, dir } = makeSession("direct-edit-invalid");
    const snap = captureTruth(session, dir);
    assert.throws(() => session.applyDirectEdit({ world: { hp: 1 } }), /time/);
    assertTruthUnchanged(session, dir, snap);
  });
});

describe("rollback 提交语义", () => {
  it("rollback → revision 递增 + seq 回退 + 新 Generation 逐字节 = 回滚目标态", async () => {
    const { session, dir } = makeSession("rollback", {
      pause: { ...NO_PAUSE, beforeGm: true },
      gm: [gmFull()],
    });
    await session.continuePipeline(); // seq1 C1001 → 停等玩家
    await session.handlePlayerInput("玩家行动"); // seq2 玩家 → GM 前停
    assert.equal(session.turnCount, 2);
    // 回滚目标态 = 当前 Generation（seq2 刚完成）六文件原文
    const targetRev = fs.readFileSync(path.join(dir, "CURRENT"), "utf8").trim();
    const targetDir = path.join(dir, "generations", targetRev);
    const targetFiles = TRUTH_FILES.map((f) => fs.readFileSync(path.join(targetDir, f), "utf8"));

    session.setPauseOptions({ ...NO_PAUSE, afterGm: true });
    h.llm.gmQueue.push(gmFull());
    await session.continuePipeline(); // seq3 GM → GM 后停
    assert.equal(session.turnCount, 3);
    const preRollbackRev = Number(fs.readFileSync(path.join(dir, "CURRENT"), "utf8").trim());

    session.rollbackTo(2);

    const postRev = Number(fs.readFileSync(path.join(dir, "CURRENT"), "utf8").trim());
    assert.equal(postRev, preRollbackRev + 1, "回滚产生新 Generation（revision 递增）");
    assert.equal(session.turnCount, 2, "游戏 seq 回退到目标步");
    const postDir = path.join(dir, "generations", String(postRev).padStart(6, "0"));
    TRUTH_FILES.forEach((f, i) => {
      assert.equal(fs.readFileSync(path.join(postDir, f), "utf8"), targetFiles[i], `回滚后 ${f} 逐字节 = 目标态`);
    });
  });
});

describe("CommitPlan.reason 五路径（spy CommitExecutor）", () => {
  it("init / step / gm / rollback / admin_edit", async () => {
    const plans: CommitPlan[] = [];
    const orig = CommitExecutor.prototype.commit;
    CommitExecutor.prototype.commit = function (plan, next) {
      plans.push(plan);
      return orig.call(this, plan, next);
    };
    try {
      const { session } = makeSession("reasons", {
        pause: { ...NO_PAUSE, beforeGm: true },
        gm: [gmFull()],
      }); // init
      await session.continuePipeline(); // step（character）
      await session.handlePlayerInput("玩家行动"); // step（player）→ GM 前停
      session.setPauseOptions({ ...NO_PAUSE, afterGm: true });
      h.llm.gmQueue.push(gmFull());
      await session.continuePipeline(); // gm
      session.rollbackTo(2); // rollback
      session.applyDirectEdit({ world: JSON.parse(JSON.stringify(session.getState().world)) as Record<string, unknown> }); // admin_edit

      assert.deepEqual(
        plans.map((p) => p.reason),
        ["init", "step", "step", "gm", "rollback", "admin_edit"],
      );
      // transactionId 确定性约定：tx-{baseRevision+1}，单调递增
      plans.forEach((p, i) => {
        assert.equal(p.transactionId, `tx-${p.baseRevision + 1}`);
        if (i > 0) assert.equal(p.baseRevision, plans[i - 1]!.baseRevision + 1, "baseRevision 链式递增");
      });
      // rollback 不携带 changes（回滚依据 = archive.var_changes，plan 不落盘）
      assert.deepEqual(plans[4]!.changes, []);
    } finally {
      CommitExecutor.prototype.commit = orig;
    }
  });
});

describe("恒冻结（Snapshot 只读化）", () => {
  it("getState()/snapshot() 深改抛 TypeError", () => {
    const { session } = makeSession("freeze");
    const state = session.getState();
    assert.throws(() => {
      (state.world as Record<string, unknown>)["hack"] = 1;
    }, TypeError);
    assert.throws(() => {
      (state.characters["C1001"] as { timer: number }).timer = 999;
    }, TypeError);
    assert.throws(() => {
      (state.characters["C1001"]!.location as { name: string }).name = "越界";
    }, TypeError);
    assert.throws(() => {
      (session.snapshot().events as unknown as unknown[]).push({});
    }, TypeError);
    // 冻结不影响正常读取
    assert.equal(h.charState(session, "C1001").name, "甲");
  });
});
