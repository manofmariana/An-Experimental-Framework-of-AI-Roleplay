/**
 * 统一效果规划器——角色决策。
 *
 * 玩家与 NPC 同一入口：两者只在取得 DecisionPackage 的方式上不同（玩家输入解析 /
 * NPC LLM + schema 校验），随后统一进入 planActorDecision；编辑重放 = 在 draft 上
 * 反转旧 effects 后用同一规划器生成新 effects（见 gameSession.ts editResult）。
 *
 * 统一处理：working set 追加、relations、普通行动 acted、邀请接受/拒绝（confirm/
 * 还原 timer + 清频道）、markers（gm_request/leave/recall/contact；游离 confirm 忽略）。
 *
 * 规划器只变异传入的 draft（或 live）视图并返回常规 VarChange[]（StepChanges.effects
 * 段），永不持久化；提交由调用方负责。
 */
import type { DicePort } from "../ports.js";
import { NO_INITIATIVE_BATCH } from "../scheduler/derive.js";
import { groupLocation } from "../scheduler/simulator.js";
import { normalizeCid } from "../truth/identity.js";
import type { TruthStores } from "../truth/stores.js";
import type { VarChange } from "../truth/varChanges.js";
import type { DecisionPackage, Marker } from "../types.js";
import {
  cleanupChannels,
  cycleCountOf,
  playableCharacters,
  playerCidOf,
  rederiveGroups,
  simCharsOf,
} from "./scheduleEffects.js";

/** 邀请应答上下文（重放输入：正常步来自调度派生，编辑重放来自 result 里保留的 invitation 记录）。 */
export interface ActorInvitationContext {
  contactSeq: number;
  inviter: string;
  channel: string;
  preInviteTimer: number | null;
}

export interface ActorDecisionContext {
  cid: string;
  pkg: DecisionPackage;
  /** 邀请应答步携带；普通行动步省略。 */
  invitation?: ActorInvitationContext;
  rollDice: DicePort;
}

export interface StepEffects {
  /** StepChanges.effects 段（setup 段由调度落账产生，见 scheduleEffects.applyScheduleSetup）。 */
  changes: VarChange[];
}

/** 立 GM 立即激活触发（gm_request/contact 共用）：记录触发批（角色先攻值；批完成判定见 deriveNext）。 */
function setGmTrigger(truth: TruthStores, cid: string): VarChange[] {
  const batch = truth.characters.get(cid).initiative?.value ?? NO_INITIATIVE_BATCH;
  return [
    truth.world.writeRaw("_sys.gm_trigger", true),
    truth.world.writeRaw("_sys.gm_trigger_batch", batch),
  ];
}

/**
 * 标记执行（程序即时作用，全部走 VarChange；标记不进工作集、不进任何注入）。
 * confirm 不在此处理——它只在邀请应答步生效（applyInvitationAnswer），游离 confirm 忽略。
 */
function applyMarkers(truth: TruthStores, cid: string, markers: Marker[], rollDice: DicePort): VarChange[] {
  const changes: VarChange[] = [];
  for (const marker of markers) {
    switch (marker.type) {
      case "gm_request":
        changes.push(...setGmTrigger(truth, cid));
        break;
      case "leave": {
        // 离开标记对所有角色（含玩家）统一程序化：组归 0 + timer 置 null（无计时器，待 GM 结算）+ 清频道，绝不触发 GM
        const oldGroup = truth.characters.get(cid).group;
        changes.push(...truth.characters.setVars(cid, { group: 0, timer: null, channel: null }));
        // 减员至单人 = 新的独奏节奏起点：幸存者 acted 重置（本周期已行动也重来）+ 周期计数 X 归 0，
        // 独奏周期（前台仅 1 人阈值恒为 1）从下一次单人行动起计
        if (oldGroup !== 0) {
          const survivors = Object.keys(truth.characters.all()).filter(
            (c) => truth.characters.get(c).group === oldGroup,
          );
          if (survivors.length === 1) {
            const survivor = survivors[0]!;
            if (truth.characters.get(survivor).acted) {
              changes.push(...truth.characters.setVars(survivor, { acted: false }));
            }
            if (cycleCountOf(truth) !== 0) {
              changes.push(truth.world.writeRaw("_sys.cycles_since_gm", 0));
            }
          }
        }
        break;
      }
      case "recall": {
        const target = normalizeCid(marker.target);
        const state = truth.characters.all()[target];
        if (state === undefined) {
          console.warn(`召回标记指向未知角色 ${target}，已忽略`);
          break;
        }
        // 未结算离开集合：group=0 且 timer=null；timer 归当前 clock（组原到期时刻）、按进组规则归组
        if (state.group === 0 && state.timer === null) {
          changes.push(...truth.characters.setVars(target, { timer: truth.world.clock }));
          changes.push(...rederiveGroups(truth, rollDice));
        } else {
          console.warn(`召回标记目标 ${target} 不在未结算离开集合，已忽略`);
        }
        break;
      }
      case "contact": {
        // 邀请者与各目标分配同一频道 id（现有最大 channel+1，无则 1）；触发 GM 立即激活
        const id = Math.max(0, ...Object.values(truth.characters.all()).map((s) => s.channel ?? 0)) + 1;
        changes.push(...truth.characters.setVars(cid, { channel: id }));
        for (const raw of marker.targets) {
          const target = normalizeCid(raw);
          if (target === cid) continue;
          if (truth.characters.all()[target] === undefined) {
            console.warn(`联系标记指向未知角色 ${target}，已忽略`);
            continue;
          }
          changes.push(...truth.characters.setVars(target, { channel: id }));
        }
        changes.push(...setGmTrigger(truth, cid));
        break;
      }
      case "confirm":
        break; // 仅在邀请应答步生效（applyInvitationAnswer）
    }
  }
  return changes;
}

/** 邀请应答分派：有 confirm 标记 → 接受入组；否则拒绝（timer 还原 + 清频道）。 */
function applyInvitationAnswer(
  truth: TruthStores,
  cid: string,
  pkg: DecisionPackage,
  invitation: ActorInvitationContext,
  rollDice: DicePort,
): VarChange[] {
  const accepted = (pkg.markers ?? []).some((m) => m.type === "confirm");
  return accepted
    ? applyConfirm(truth, cid, invitation.contactSeq, rollDice)
    : applyReject(truth, cid, invitation.preInviteTimer);
}

/** 拒绝：timer 自动还原为邀请前值（应答步 setup 的 before）+ 失去频道；全体持有者因此同地 → 频道自动清除。 */
function applyReject(truth: TruthStores, cid: string, preTimer: number | null): VarChange[] {
  const changes = truth.characters.setVars(cid, { timer: preTimer, channel: null });
  changes.push(...cleanupChannels(truth));
  return changes;
}

/**
 * 接受（confirm + 首轮回复）：并入邀请者组（邀请者单人则配对成新组并补投），
 * 先攻 = 已存值组编号对上则复用、否则单独补投；位置 ≠ 组位置 → 先攻 -1；
 * timer 归当前时钟（立即到期）待 GM 重设；首轮回复计入已行动（acted=true）。
 */
function applyConfirm(truth: TruthStores, cid: string, contactSeq: number, rollDice: DicePort): VarChange[] {
  const current = truth.world.pipeline.current;
  const steps = [...truth.archive.readAll(), ...(current !== null ? [current] : [])];
  const contactStep = steps.find((s) => s.seq === contactSeq);
  if (contactStep === undefined) {
    console.warn(`confirm 找不到对应 contact 步（seq ${contactSeq}），已忽略`);
    return [];
  }
  const inviter =
    contactStep.kind === "player" ? playerCidOf(truth) : contactStep.kind.slice("character:".length);
  const changes: VarChange[] = [];
  let g = truth.characters.get(inviter).group;
  if (g === 0) {
    // 邀请者单人：配对成新组（全新组合 → 未用过的新 id；邀请者补投先攻）
    g = Math.max(0, ...Object.values(playableCharacters(truth)).map((s) => s.group)) + 1;
    changes.push(...truth.characters.setVars(inviter, { group: g }));
    const inviterInit = truth.characters.get(inviter).initiative;
    if (inviterInit === null || inviterInit.group !== g) {
      changes.push(
        ...truth.characters.setVars(inviter, {
          initiative: { value: rollDice(20) + truth.characters.get(inviter).reaction, group: g },
        }),
      );
    }
  }
  changes.push(...truth.characters.setVars(cid, { group: g }));
  const existing = truth.characters.get(cid).initiative;
  let value =
    existing !== null && existing.group === g ? existing.value : rollDice(20) + truth.characters.get(cid).reaction;
  // 入组位置 ≠ 组位置 → 先攻 -1（远程参与的劣后）
  const gl = groupLocation(simCharsOf(truth), g);
  if (gl !== null && truth.characters.get(cid).location.name !== gl) value -= 1;
  changes.push(...truth.characters.setVars(cid, { initiative: { value, group: g }, timer: truth.world.clock, acted: true }));
  return changes;
}

/**
 * 角色决策完成效应（玩家/NPC/编辑重放统一入口）：relations 落账 → 决策入工作集 →
 * acted 置位（行动顺序表；邀请应答步不置位——接受由 confirm 效应置位、拒绝不计入已行动）
 * 或邀请应答效应 → 标记执行。返回 StepChanges.effects 段。
 */
export function planActorDecision(draft: TruthStores, ctx: ActorDecisionContext): StepEffects {
  const changes: VarChange[] = [];
  if (ctx.pkg.relations?.length) changes.push(...draft.characters.updateRelations(ctx.cid, ctx.pkg.relations));
  draft.world.setPipeline({
    working_set: [...draft.world.pipeline.working_set, { cid: ctx.cid, decision: ctx.pkg }],
  });
  if (ctx.invitation === undefined) changes.push(...draft.characters.setVars(ctx.cid, { acted: true }));
  else changes.push(...applyInvitationAnswer(draft, ctx.cid, ctx.pkg, ctx.invitation, ctx.rollDice));
  changes.push(...applyMarkers(draft, ctx.cid, ctx.pkg.markers ?? [], ctx.rollDice));
  return { changes };
}
