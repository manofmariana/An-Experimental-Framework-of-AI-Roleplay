import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SchedulerCharacter } from "../src/scheduler/derive.js";
import { InvitationProjection, type InvitationStepView } from "../src/scheduler/invitations.js";

// ---------------------------------------------------------------------------
// InvitationProjection 单测（unit：零 Store 零 IO）
// contact 登记 → GM 步生效（armed）→ 应答步按 contactSeq 显式落账（accepted 由适配层给出）
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

const contact = (seq: number, inviter: string, targets: string[], channel = "电话"): InvitationStepView => ({
  seq,
  kind: `character:${inviter}`,
  decisionMarkers: [{ type: "contact", channel, targets }],
});
const gm = (seq: number): InvitationStepView => ({ seq, kind: "gm" });
const prose = (seq: number): InvitationStepView => ({ seq, kind: "prose" });
const plain = (seq: number, actor: string): InvitationStepView => ({ seq, kind: `character:${actor}` });
const answer = (seq: number, actor: string, contactSeq: number, accepted: boolean): InvitationStepView => ({
  seq,
  kind: `character:${actor}`,
  invitation: { contactSeq, accepted },
});

/** 标准在场表：邀请者 C2001（组 9）+ 受邀者若干（异组单人）。 */
function charsOf(targets: Record<string, Partial<SchedulerCharacter>>): Record<string, SchedulerCharacter> {
  return {
    C2001: ch({ group: 9 }),
    ...Object.fromEntries(Object.entries(targets).map(([cid, o]) => [cid, ch(o)])),
  };
}

describe("InvitationProjection：生效与过滤", () => {
  it("contact 未经 GM 不生效（armed=false）；GM 步后生效待激活", () => {
    const p = InvitationProjection.rebuild([contact(1, "C2001", ["C1001"])]);
    const chars = charsOf({ C1001: {} });
    assert.equal(p.nextPending(["C2001"], chars), null, "未 armed 不应答");
    p.applyStep(gm(2));
    assert.deepEqual(p.nextPending(["C2001"], chars), {
      contactSeq: 1,
      inviter: "C2001",
      channel: "电话",
      target: "C1001",
    });
  });

  it("邀请者不在前台 / 已删除 → 无 pending；目标已删除 → 跳过", () => {
    const p = InvitationProjection.rebuild([contact(1, "C2001", ["C1001", "C1002"]), gm(2)]);
    const chars = charsOf({ C1001: {} });
    assert.equal(p.nextPending(["C1001"], chars), null, "邀请者不在前台");
    assert.deepEqual(p.nextPending(["C2001"], chars)?.target, "C1001", "已删除目标 C1002 跳过");
    const noInviter = { ...chars };
    delete noInviter.C2001;
    assert.equal(p.nextPending(["C2001"], noInviter), null, "邀请者已删除");
  });

  it("已与邀请者同组的目标跳过；邀请者单人组（group=0）不按同组过滤", () => {
    const sameGroup = InvitationProjection.rebuild([contact(1, "C2001", ["C1001"]), gm(2)]);
    assert.equal(
      sameGroup.nextPending(["C2001"], charsOf({ C1001: { group: 9 } })),
      null,
      "目标已并入邀请者组（group=9）→ 不再是 pending",
    );
    const soloInviter = InvitationProjection.rebuild([contact(1, "C2001", ["C1001"]), gm(2)]);
    const chars = charsOf({ C1001: { group: 5 } });
    chars.C2001 = ch({ group: 0 });
    assert.equal(soloInviter.nextPending(["C2001"], chars)?.target, "C1001");
  });

  it("无关步（prose/无标记 actor 步）不改变投影", () => {
    const steps = [contact(1, "C2001", ["C1001"]), gm(2)];
    const a = InvitationProjection.rebuild(steps);
    const b = InvitationProjection.rebuild([steps[0]!, prose(9), plain(10, "C1001"), steps[1]!]);
    const chars = charsOf({ C1001: {} });
    assert.deepEqual(b.nextPending(["C2001"], chars), a.nextPending(["C2001"], chars));
  });

  it("应答步指向未知 contactSeq → 忽略不抛", () => {
    const p = new InvitationProjection();
    p.applyStep(answer(1, "C1001", 999, true));
    assert.equal(p.nextPending(["C2001"], charsOf({ C1001: {} })), null);
  });
});

describe("InvitationProjection：多目标应答顺序与一次性", () => {
  it("先攻降序、同值 CID 升序；接受/拒绝混合每人只应答一次", () => {
    const p = InvitationProjection.rebuild([
      contact(1, "C2001", ["C1001", "C1002", "C1003"]),
      gm(2),
    ]);
    const chars = charsOf({
      C1001: { initiative: { value: 10, group: 2 } },
      C1002: { initiative: { value: 20, group: 3 } },
      C1003: { initiative: { value: 20, group: 4 } },
    });
    const front = ["C2001"];
    // C1002 与 C1003 同值 20 → CID 升序：C1002 先
    assert.equal(p.nextPending(front, chars)?.target, "C1002");
    p.applyStep(answer(3, "C1002", 1, true)); // 接受
    assert.equal(p.nextPending(front, chars)?.target, "C1003");
    p.applyStep(answer(4, "C1003", 1, false)); // 拒绝同样视为已应答
    assert.equal(p.nextPending(front, chars)?.target, "C1001");
    p.applyStep(answer(5, "C1001", 1, false));
    assert.equal(p.nextPending(front, chars), null, "全员应答完毕 → 无 pending");
    // 重复应答不改变结果（幂等）
    p.applyStep(answer(6, "C1001", 1, true));
    assert.equal(p.nextPending(front, chars), null);
  });

  it("目标含玩家：视图如实返回玩家 CID（命令分支映射归 deriveNext）", () => {
    const p = InvitationProjection.rebuild([contact(1, "C2001", ["C0"]), gm(2)]);
    const chars = charsOf({ C0: { isPlayer: true } });
    assert.equal(p.nextPending(["C2001"], chars)?.target, "C0");
  });

  it("多个并存 contact 确定性：按登记序取第一个有 pending 的邀请", () => {
    const steps = [
      contact(1, "C2001", ["C1001"]),
      contact(2, "C2002", ["C1002"]),
      gm(3),
    ];
    const a = InvitationProjection.rebuild(steps);
    const b = new InvitationProjection();
    for (const s of steps) b.applyStep(s);
    const chars = { ...charsOf({ C1001: {} }), C2002: ch({ group: 8 }), C1002: ch({}) };
    const front = ["C2001", "C2002"];
    assert.deepEqual(a.nextPending(front, chars), b.nextPending(front, chars));
    assert.equal(a.nextPending(front, chars)?.contactSeq, 1, "先登记的邀请先应答");
    // 第一个邀请应答完后 → 第二个邀请
    a.applyStep(answer(4, "C1001", 1, true));
    assert.equal(a.nextPending(front, chars)?.contactSeq, 2);
  });
});

describe("InvitationProjection：增量 applyStep 与全量 rebuild 对拍", () => {
  const steps: InvitationStepView[] = [
    contact(1, "C2001", ["C1001", "C1002"]),
    plain(2, "C2001"),
    gm(3),
    answer(4, "C1002", 1, true),
    contact(5, "C2001", ["C1003"]),
    prose(6),
    gm(7),
  ];
  const chars = charsOf({
    C1001: { initiative: { value: 10, group: 2 } },
    C1002: { initiative: { value: 20, group: 3 } },
    C1003: { initiative: { value: 15, group: 4 } },
  });
  const front = ["C2001"];

  it("混合步序列：逐步增量 == 全量重建（含后续增量仍一致）", () => {
    const incremental = new InvitationProjection();
    for (const s of steps) incremental.applyStep(s);
    const rebuilt = InvitationProjection.rebuild(steps);
    // C1002 已应答 → C1003（15）先于 C1001（10）：第二邀请先登记在第二？——按登记序：
    // 邀请 1 仍有 pending（C1001）→ 先答邀请 1 的 C1001
    assert.deepEqual(incremental.nextPending(front, chars), rebuilt.nextPending(front, chars));
    assert.equal(rebuilt.nextPending(front, chars)?.target, "C1001");
    // 后续增量两边同步推进仍一致
    for (const p of [incremental, rebuilt]) p.applyStep(answer(8, "C1001", 1, false));
    assert.deepEqual(incremental.nextPending(front, chars), rebuilt.nextPending(front, chars));
    assert.equal(rebuilt.nextPending(front, chars)?.target, "C1003");
    for (const p of [incremental, rebuilt]) p.applyStep(answer(9, "C1003", 5, true));
    assert.deepEqual(incremental.nextPending(front, chars), rebuilt.nextPending(front, chars));
    assert.equal(rebuilt.nextPending(front, chars), null);
  });

  it("clone 独立：克隆试投不回污原实例（finishStep 预推语义）", () => {
    const base = InvitationProjection.rebuild(steps);
    const preview = base.clone();
    preview.applyStep(answer(8, "C1001", 1, false));
    assert.equal(preview.nextPending(front, chars)?.target, "C1003", "克隆看到试投后的状态");
    assert.equal(base.nextPending(front, chars)?.target, "C1001", "原实例不受试投影响");
  });
});
