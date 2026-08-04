/**
 * 邀请历史解释（纯逻辑）：InvitationProjection。
 *
 * 应答判据显式化：
 * contact 步登记邀请及全部目标（armed=false）→ GM 步把未生效邀请标 armed →
 * 应答步按稳定 contactSeq 把对应目标标为已应答（accepted 由 application 适配层
 * 从 decision.markers 有无 confirm 显式给出）。
 *
 * 投影是派生缓存：不进 Generation、不进 CommitPlan。正常推进每个提交步增量
 * applyStep 一次；读档/回滚/编辑/直编/灾备恢复后从 archive + current 全量 rebuild。
 */
import type { PendingInvitationView, SchedulerCharacter } from "./derive.js";

/**
 * 提交步的邀请投影视图（适配层从刚提交步构造：kind/seq/decision.markers/invitation.accepted）。
 * kind 约定：actor 步必须是 "character:<cid>" 形——适配层把 player 步转写为
 * character:<playerCid>（投影无 player 概念，与原 actorOf 同语义）；gm/prose 无 actor。
 */
export interface InvitationStepView {
  seq: number;
  kind: string;
  decisionMarkers?: readonly { type: string; channel?: string; targets?: string[] }[];
  invitation?: { contactSeq: number; accepted: boolean };
}

interface InvitationRecord {
  /** contact 步 seq（应答锚） */
  seq: number;
  inviter: string;
  channel: string;
  /** 目标 CID（适配层已归一化，去 @ 前缀） */
  targets: string[];
  /** contact 触发 GM 立即结算 → 其后邀请生效待激活 */
  armed: boolean;
  /** 已应答目标（应答步按 contactSeq 落账；接受/拒绝均只应答一次） */
  answered: Set<string>;
}

export class InvitationProjection {
  private invitations: InvitationRecord[] = [];

  /** 从 archive + current 全量重建（读档/回滚/编辑/直编后；成本低，不判断是否影响邀请语义）。 */
  static rebuild(steps: readonly InvitationStepView[]): InvitationProjection {
    const projection = new InvitationProjection();
    for (const step of steps) projection.applyStep(step);
    return projection;
  }

  /** 深拷贝（试投/预览用；正式增量在真相 commit 成功后落到原实例，见 GameSession.finishStep）。 */
  clone(): InvitationProjection {
    const projection = new InvitationProjection();
    projection.invitations = this.invitations.map((inv) => ({
      ...inv,
      targets: [...inv.targets],
      answered: new Set(inv.answered),
    }));
    return projection;
  }

  /** 增量处理一个新提交步（只在真相事务成功后调用；无关步不改变投影）。 */
  applyStep(step: InvitationStepView): void {
    if (step.kind === "gm") {
      for (const inv of this.invitations) inv.armed = true;
      return;
    }
    if (!step.kind.startsWith("character:")) return;
    const actor = step.kind.slice("character:".length);
    for (const marker of step.decisionMarkers ?? []) {
      if (marker.type === "contact" && marker.channel !== undefined && marker.targets !== undefined) {
        this.invitations.push({
          seq: step.seq,
          inviter: actor,
          channel: marker.channel,
          targets: [...marker.targets],
          armed: false,
          answered: new Set(),
        });
      }
    }
    if (step.invitation !== undefined) {
      const inv = this.invitations.find((i) => i.seq === step.invitation!.contactSeq);
      inv?.answered.add(actor);
    }
  }

  /**
   * 当前应应答的受邀者（过滤规则与原 derivePendingInvitee 一致）：
   * 邀请已生效（armed）、邀请者在前台组、目标未删除且未与邀请者同组、未应答；
   * 多目标按先攻降序、同值 CID 升序取下一 pending 目标。
   */
  nextPending(
    front: readonly string[],
    chars: Record<string, SchedulerCharacter>,
  ): PendingInvitationView | null {
    for (const inv of this.invitations) {
      if (!inv.armed) continue;
      const inviter = chars[inv.inviter];
      if (inviter === undefined || !front.includes(inv.inviter)) continue;
      const pending = inv.targets
        .filter((t) => t !== inv.inviter && chars[t] !== undefined && !inv.answered.has(t))
        .filter((t) => inviter.group === 0 || chars[t]!.group !== inviter.group);
      if (pending.length === 0) continue;
      pending.sort(
        (a, b) =>
          (chars[b]!.initiative?.value ?? Number.NEGATIVE_INFINITY) -
            (chars[a]!.initiative?.value ?? Number.NEGATIVE_INFINITY) || a.localeCompare(b),
      );
      return { contactSeq: inv.seq, inviter: inv.inviter, channel: inv.channel, target: pending[0]! };
    }
    return null;
  }
}
