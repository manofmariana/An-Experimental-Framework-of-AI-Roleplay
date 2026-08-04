/**
 * 调度派生（纯逻辑，docs/optimization-review.md §2）：从最小调度快照派生下一命令。
 *
 * 逻辑逐行对照自原 loop.ts deriveNext/expectedGmTimerCids（语义不变），组合复用
 * simulator 基础算法（nextDue/orderGroups/initiativeBatches），不复制实现。
 * 不读 Store / archive / LLM，无任何 IO——表驱动单测只喂内存快照字面量。
 * 邀请历史解释不在此模块（见 invitations.ts）：快照只携带当前 pending invitation 视图。
 */
import { initiativeBatches, nextDue, orderGroups } from "./simulator.js";

/** 无先攻值角色的触发批哨兵（任何真实投掷都取不到：批内无他人 → 批完成判定真空成立 → 立即 GM）。 */
export const NO_INITIATIVE_BATCH = -Number.MAX_SAFE_INTEGER;

/**
 * 调度视图中的角色（SimChar + acted 行动位）。
 * timer 已归一：未结算离开者（≥ LEAVE_TIMER）与无计时器同为 null（由快照构建方完成）。
 */
export interface SchedulerCharacter {
  timer: number | null;
  group: number;
  location: { name: string };
  isPlayer: boolean;
  initiative: { value: number; group: number } | null;
  channel: number | null;
  acted: boolean;
}

/** 待答邀请视图（InvitationProjection.nextPending 的输出；应答步激活上下文：incoming_contact 注入 + 拒绝还原依据）。 */
export interface PendingInvitationView {
  /** contact 步 seq（应答落账/编辑重放的稳定锚） */
  contactSeq: number;
  inviter: string;
  channel: string;
  /** 当前应应答的受邀者（按先攻降序、同值 CID 升序选出） */
  target: string;
}

/**
 * 最小调度快照（deriveNext 的输入面，不多不少）：
 * 角色调度变量 + 时钟 + 周期计数/GM 触发变量 + 末步 kind/narrativity + 邀请 pending 视图。
 * 末步 adjudication 包缺失（interrupted 的 gm 步）时 lastGmNarrativity = null（≠ skip → 正文分支）。
 */
export interface SchedulerSnapshot {
  chars: Record<string, SchedulerCharacter>;
  clock: number;
  cycleCount: number;
  gmIntervalCycles: number;
  gmTrigger: boolean;
  gmTriggerBatch: number | null;
  lastStepKind: string | null;
  lastGmNarrativity: string | null;
  pendingInvitation: PendingInvitationView | null;
}

/**
 * 轮首步的调度落账语义数据（不生成 VarChange、不知持久化路径——
 * application/CommitPlan 层负责把 setup 转成常规变更记录）：
 * due = 时钟跳转目标（连续轮/无跳转 = undefined）；actedClears = 维护性清零 CID；
 * cycleIncrement = 周期完成 X+1。
 */
export interface ScheduleSetup {
  due?: number;
  actedClears: string[];
  cycleIncrement: boolean;
}

/** 下一命令（判别联合：每个分支携带执行所需的全部字段，调用方无非空断言）。 */
export type NextCommand =
  | { type: "player"; reason: "turn" | "deadlock"; setup: ScheduleSetup; invitation?: PendingInvitationView }
  | { type: "character"; cid: string; setup: ScheduleSetup; invitation?: PendingInvitationView }
  | { type: "gm"; setup: ScheduleSetup }
  | { type: "prose"; setup: ScheduleSetup };

export type DerivedPhase = "await_player" | "await_character" | "await_gm" | "await_prose";

/** 命令 → 流水线 phase（pipeline.phase 落盘值的唯一来源；phase 是派生缓存非权威）。 */
export function phaseOf(cmd: NextCommand): DerivedPhase {
  switch (cmd.type) {
    case "player":
      return "await_player";
    case "character":
      return "await_character";
    case "gm":
      return "await_gm";
    case "prose":
      return "await_prose";
  }
}

/** 前台组选择结果（两阶段快照构建用：先 selectFront 取 front，再交邀请投影求 pending）。 */
export interface FrontSelection {
  /** 弹出时刻（nextDue 最小非空 timer） */
  due: number;
  /** 有效时钟（max(clock, due)；timer=0 的应答/新入组成员 ≤ 当前时钟，时钟不倒退） */
  effClock: number;
  /** 前台组成员（同刻多组按 orderGroups 串行取首组；非零组扩到同组全部已成熟成员，CID 升序） */
  front: string[];
}

/**
 * 前台组选择：nextDue 弹出最近到期者 → 同刻多组按 orderGroups 串行（首组先跑，其余等待）
 * → 非零组前台 = 同组编号且 timer 已成熟（≤ effClock）的全体成员。全员无计时器 → null（死锁）。
 */
export function selectFront(chars: Record<string, SchedulerCharacter>, clock: number): FrontSelection | null {
  const nd = nextDue(chars);
  if (nd === null) return null;
  const effClock = Math.max(clock, nd.due);
  const firstUnit = orderGroups(chars, nd.cids)[0]!;
  const frontGroup = chars[firstUnit[0]!]!.group;
  const front =
    frontGroup !== 0
      ? Object.keys(chars)
          .filter((c) => {
            const t = chars[c]!.timer;
            return chars[c]!.group === frontGroup && t !== null && t <= effClock;
          })
          .sort()
      : firstUnit;
  return { due: nd.due, effClock, front };
}

/**
 * 调度派生（§5/§10.4：游标与 phase ← 角色变量 + 末步状态推断）：
 * 分支序 = 正文衔接 > 死锁防御 > 邀请应答 > GM 标记触发（批完成判定）> 行动顺序表 > 周期完成。
 */
export function deriveNext(snapshot: SchedulerSnapshot): NextCommand {
  const chars = snapshot.chars;

  // 1. GM 步刚闭合：narrativity≠skip → 正文（lastGmNarrativity=null 视为包缺失，此分支只作展示态）
  if (snapshot.lastStepKind === "gm" && snapshot.lastGmNarrativity !== "skip") {
    return { type: "prose", setup: { actedClears: [], cycleIncrement: false } };
  }

  // 2. 调度：nextDue 弹出最近到期者 → 同刻多组串行取首组；全员无计时器 → 死锁防御停等玩家
  const sel = selectFront(chars, snapshot.clock);
  if (sel === null) {
    return { type: "player", reason: "deadlock", setup: { actedClears: [], cycleIncrement: false } };
  }
  const front = sel.front;
  const due = sel.due > snapshot.clock ? sel.due : undefined;

  // 维护：组进后台 ⇒ 成员 acted 清零（前台组成员不在清除列，已行动状态随周期补完保留）
  const actedClears = Object.keys(chars)
    .filter((c) => chars[c]!.acted && !front.includes(c))
    .sort();
  const withSetup = (extra?: { actedClears?: string[]; cycleIncrement?: boolean }): ScheduleSetup => {
    const clears = [...actedClears, ...(extra?.actedClears ?? []).filter((c) => !actedClears.includes(c))];
    return {
      ...(due !== undefined ? { due } : {}),
      actedClears: clears,
      cycleIncrement: extra?.cycleIncrement ?? false,
    };
  };
  const actorCmd = (
    cid: string,
    setup: ScheduleSetup,
    invitation?: PendingInvitationView,
  ): NextCommand =>
    chars[cid]?.isPlayer === true
      ? { type: "player", reason: "turn", setup, ...(invitation !== undefined ? { invitation } : {}) }
      : { type: "character", cid, setup, ...(invitation !== undefined ? { invitation } : {}) };

  // 3. 邀请应答：contact 经 GM 立即结算后，邀请者组下次弹出时异组受邀者按原有先攻逐个应答
  const invitation = snapshot.pendingInvitation;
  if (invitation !== null) return actorCmd(invitation.target, withSetup(), invitation);

  // 4. 标记触发：gm_request/contact 立标 → 同先攻批全员行动完 → GM 立即激活
  if (snapshot.gmTrigger) {
    const batch = snapshot.gmTriggerBatch ?? NO_INITIATIVE_BATCH;
    const batchMembers = front.filter((c) => (chars[c]!.initiative?.value ?? NO_INITIATIVE_BATCH) === batch);
    if (batchMembers.every((c) => chars[c]!.acted)) return { type: "gm", setup: withSetup() };
  }

  // 5. 行动顺序表：顺序 = initiative 变量现排，下一个行动者 = 第一个 acted=false 的成员
  const order = initiativeBatches(
    front.map((c) => ({ cid: c, initiative: chars[c]!.initiative })),
  ).flatMap((b) => b.cids);
  const next = order.find((c) => !chars[c]!.acted);
  if (next !== undefined) return actorCmd(next, withSetup());

  // 6. 周期完成：X+1 达 N → 周期末 GM（X 由 GM 激活清零）；否则 X+1 + 清全员 acted 进下一周期
  if (snapshot.cycleCount + 1 >= snapshot.gmIntervalCycles) return { type: "gm", setup: withSetup() };
  return actorCmd(order[0]!, withSetup({ cycleIncrement: true, actedClears: front }));
}

/**
 * GM 裁决包 timer 必须精确覆盖的 cid 集（去重排序）：
 * 全体同步组成员（行动者所在非零组的全体成员，以组成员身份为准、无论其 timer 值——
 * 组成员 timer 本就同步；timer 为 null 者同样包含，GM 给其设 timer 无害）
 * ∪ 刚从同步组离开的成员（已由 roundCids 覆盖）。
 */
export function expectedGmTimerCids(
  chars: Record<string, SchedulerCharacter>,
  roundCids: readonly string[],
): string[] {
  const groups = new Set(roundCids.map((cid) => chars[cid]?.group ?? 0).filter((group) => group !== 0));
  const expected = new Set(roundCids);
  for (const [cid, state] of Object.entries(chars)) {
    if (state.group !== 0 && groups.has(state.group)) {
      expected.add(cid);
    }
  }
  return [...expected].sort((a, b) => a.localeCompare(b));
}
