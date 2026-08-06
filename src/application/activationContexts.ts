/**
 * activation 上下文构建器：
 * 三个无状态 activation 的全部注入上下文在这里从**最新真相 + 派生投影现算**——
 * 每次调用读 live stores 的只读数据（恒冻结保证不被误写），无任何跨调用缓存：
 * - cast 每次现建（动态改名/增角色后下一次调用直接读到最新）；
 * - lore 逐调用从 loreStore 档内副本渲染（运行期可编辑，必须读到最新）；
 * - setting/toneCard 是世界设定集静态文本（运行期不变），由装配层注入并持有。
 * 取数与渲染函数同源。
 *
 * 旧 run 在途 activation 完成结果的丢弃（消息身份 runId/activationId/epoch）
 * 不在本文件范围，由 SessionCoordinator 会话隔离负责（见 sessionCoordinator.ts 注释）。
 */
import type { CharacterContext } from "../agents/character.js";
import type { GmContext, GmIncidentContext } from "../agents/gm.js";
import type { ProseContext } from "../agents/prose.js";
import type { IncidentHit } from "../scheduler/incident.js";
import { groupLocation } from "../scheduler/simulator.js";
import {
  renderForGm,
  renderForReader,
  renderRefsForGm,
  renderRefsForReader,
  type CastMember,
} from "../truth/identity.js";
import { Lorebook } from "../truth/lorebook.js";
import type { TruthStores } from "../truth/stores.js";
import { renderScene } from "../truth/workingSet.js";
import { minutesToText, type AdjudicationPackage } from "../types.js";
import {
  lastProse,
  participantTags,
  proseWindowFor,
  proseWindowForRound,
} from "./historyProjection.js";
import { playableCharacters, simCharsOf } from "./scheduleEffects.js";

/** 世界设定集静态文本（运行期不变；装配层加载后注入，builder 允许持有）。 */
export interface ActivationStatics {
  /** 世界设定全文（GM setting 注入 + 正文 worldLore 注入，同源） */
  setting: string;
  /** 世界基调卡全文（正文 toneCard 注入） */
  toneCard: string;
}

/**
 * 演员表现建：唯一真相 = characters 档内副本的 name（C0 与 NPC 同规），按 CID 排序（确定性）。
 * 不维护任何长期 cast 状态——改名/增角色后下一次调用直接反映。
 */
export function buildCast(truth: TruthStores): CastMember[] {
  return Object.entries(truth.characters.all())
    .map(([cid, state]) => ({ cid, name: state.name }))
    .sort((a, b) => a.cid.localeCompare(b.cid));
}

/** 远程成员集：位置 ≠ 组位置（组位置 = 组内先攻最高者的 location，派生不落盘）。 */
export function remoteCidsOf(truth: TruthStores): Set<string> {
  const sim = simCharsOf(truth);
  const out = new Set<string>();
  for (const [cid, s] of Object.entries(playableCharacters(truth))) {
    if (s.group === 0) continue;
    const gl = groupLocation(sim, s.group);
    if (gl !== null && s.location.name !== gl) out.add(cid);
  }
  return out;
}

/**
 * 本轮 #当前场景（角色视角）：同值批次注入隔离——
 * 与行动者同组且先攻同值的他人本轮条目不可见（同时性的迷雾；从角色变量派生，续档安全）。
 * 自己的条目恒可见；未结算离开者（group=0 + timer=null）的条目产生时仍在组内，
 * 对原组成员保持可见；位置 ≠ 组位置的成员标注"远程"。
 */
export function sceneForCid(truth: TruthStores, cid: string): string {
  const initiative = truth.characters.get(cid).initiative;
  const entries = truth.world.pipeline.working_set.filter((e) => {
    if (e.cid === cid) return true; // 自己的过往言行可见（同值批隔离只对他人条目生效）
    const otherState = truth.characters.get(e.cid);
    // 未结算离开者：同值批隔离不适用（其条目是在组内时产生的，继续对原组成员可见）
    if (otherState.group === 0 && otherState.timer === null) return true;
    if (initiative === null) return true;
    const other = otherState.initiative;
    return other === null || other.group !== initiative.group || other.value !== initiative.value;
  });
  return renderScene(entries, cid, remoteCidsOf(truth));
}

/** 角色 activation 上下文输入（truth 之外的全部变量逐调用传入）。 */
export interface CharacterContextInput {
  truth: TruthStores;
  cid: string;
  proseWindowTurns: number;
  /** 邀请应答激活的待答邀请（incoming_contact 注入）；常规激活省略 */
  invitation?: { inviter: string; channel: string };
}

/** GM activation 上下文输入。 */
export interface GmContextInput {
  truth: TruthStores;
  proseWindowTurns: number;
  /** 本轮待裁决言行（GM 视角 renderScene，无读者过滤） */
  sceneText: string;
  /** 本轮行动者 → 行动时所在组（连续场景滑窗过滤输入） */
  roundScenes: Record<string, number>;
  /** 良恶/程度判定（机械渲染；现投现算，由 session 内核注入） */
  fortune: string;
}

/** 突发 GM activation 上下文输入。 */
export interface GmIncidentContextInput {
  truth: TruthStores;
  /** 命中结果（目标组渲染的输入） */
  hit: IncidentHit;
  /** 良恶/程度判定（机械渲染；突发 GM 用命中组的 D 现投） */
  fortune: string;
}

/** 正文 activation 上下文输入。 */
export interface ProseContextInput {
  truth: TruthStores;
  proseWindowTurns: number;
  /** 本轮 GM 裁决包（gm_event 注入 = events + narrativity） */
  adjudication: AdjudicationPackage;
  /** 本轮各角色台词+内心（renderSpeech 产出） */
  currentScene: string;
  /** 本轮参与者 cid（triggered lore 标签并集输入） */
  participantCids: string[];
}

/**
 * 未裁决突发派生：末个 gm 步（结算边界）之后的 incident 步中、目标涉及 cids 的突发文本。
 * 突发内容不落 Event（未裁决素材，地位同工作集）；GM 结算覆盖该组时由 GM 转写为真正
 * Event，本派生随边界前移自动消解。注入位置 = 目标组角色的 #当前场景 开头与
 * 常规 GM 的 ##当前场景 开头（同一派生，两侧复用）。
 */
export function pendingIncidentText(truth: TruthStores, cids: readonly string[]): string {
  const current = truth.world.pipeline.current;
  const steps = [...truth.archive.readAll(), ...(current !== null ? [current] : [])];
  let boundary = -1;
  steps.forEach((s, i) => {
    if (s.kind === "gm") boundary = i;
  });
  const texts: string[] = [];
  for (const s of steps.slice(boundary + 1)) {
    if (s.kind !== "incident") continue;
    const result = s.result as { target?: { cids?: string[] }; incident?: { text?: string } } | null;
    const text = result?.incident?.text;
    if (typeof text === "string" && (result?.target?.cids ?? []).some((cid) => cids.includes(cid))) {
      texts.push(text);
    }
  }
  return texts.map((t) => `【突发事件】${t}`).join("\n");
}

/** 当前场景加突发前缀（无未裁决突发 = 原文）。 */
function withIncidentPrefix(truth: TruthStores, cids: readonly string[], scene: string): string {
  const prefix = pendingIncidentText(truth, cids);
  if (prefix === "") return scene;
  return scene === "" ? prefix : `${prefix}\n\n${scene}`;
}

/** 突发 GM 的目标组机械渲染（成员/地点/level/剩余休眠时长/错位度）。 */
function renderIncidentTarget(truth: TruthStores, hit: IncidentHit): string {
  const members = hit.group.cids
    .map((cid) => {
      const state = truth.characters.get(cid);
      return `- @${cid}（${state.name}，level ${state.level}）`;
    })
    .join("\n");
  return [
    `地点：${hit.group.locationName}（level ${hit.group.locationLevel}）；错位度 D=${hit.D.toFixed(1)}；已休眠 ${minutesToText(hit.group.remainingMinutes)}`,
    `成员：`,
    members,
  ].join("\n");
}
/**
 * activation 上下文构建器：持有世界集静态文本，其余全部逐调用现算。
 * 方法均为纯读取组装（不写真相、不做 IO）。
 */
export class ActivationContextBuilder {
  constructor(private readonly statics: ActivationStatics) {}

  /** 角色上下文：私域快照 + 可见事件（身份替换渲染）+ 同场景正文滑窗 + 当前场景 + 标签激活 lore。 */
  character(input: CharacterContextInput): CharacterContext {
    const { truth, cid } = input;
    const state = truth.characters.get(cid);
    const relations = state.relations;
    return {
      selfCid: cid,
      states: truth.characters.all(),
      cast: buildCast(truth),
      worldSnapshot: JSON.stringify(truth.world.world),
      activatedLore: Lorebook.render(truth.loreStore.book().getByTags(state.tags)),
      recentEvents: truth.events
        .readVisibleTo(cid, truth.world.clock)
        .map((event) => renderForReader(event.payload, cid, relations)),
      proseWindow: proseWindowFor(truth.archive.readAll(), cid, state.group, input.proseWindowTurns).map((block) =>
        renderRefsForReader(block, relations),
      ),
      currentScene: withIncidentPrefix(truth, [cid], sceneForCid(truth, cid)),
      timeHeader: truth.timeStore.render(truth.world.world.time),
      clock: truth.world.clock,
      incomingContact: input.invitation ?? null,
    };
  }

  /** GM 上下文：全部已 commit 事件（@ID 原文）+ lore 全文（逐调用渲染档内副本）+ 连续场景滑窗。 */
  gm(input: GmContextInput): GmContext {
    const { truth } = input;
    return {
      setting: this.statics.setting,
      cast: buildCast(truth),
      loreFull: truth.loreStore
        .book()
        .all()
        .map((entry) => `[${entry.id}]（标签：${entry.tags.join("、")}）\n${entry.content}`)
        .join("\n\n"),
      events: truth.events.readAll().map((event) => event.payload),
      proseWindow: proseWindowForRound(truth.archive.readAll(), input.roundScenes, input.proseWindowTurns).map((block) =>
        renderRefsForGm(block),
      ),
      currentScene: withIncidentPrefix(truth, Object.keys(input.roundScenes), input.sceneText),
      worldSnapshot: JSON.stringify(truth.world.world),
      states: truth.characters.all(),
      clock: truth.world.clock,
      timeHeader: truth.timeStore.render(truth.world.world.time),
      fortune: input.fortune,
    };
  }

  /** 突发 GM 上下文：与常规 GM 同一全知视野（无滑窗/当前场景），另带目标组与良恶/程度判定。 */
  gmIncident(input: GmIncidentContextInput): GmIncidentContext {
    const { truth } = input;
    return {
      setting: this.statics.setting,
      cast: buildCast(truth),
      loreFull: truth.loreStore
        .book()
        .all()
        .map((entry) => `[${entry.id}]（标签：${entry.tags.join("、")}）\n${entry.content}`)
        .join("\n\n"),
      events: truth.events.readAll().map((event) => event.payload),
      worldSnapshot: JSON.stringify(truth.world.world),
      states: truth.characters.all(),
      clock: truth.world.clock,
      timeHeader: truth.timeStore.render(truth.world.world.time),
      targetGroup: renderIncidentTarget(truth, input.hit),
      fortune: input.fortune,
    };
  }

  /** 正文上下文：静态文本 + 现建 cast + 近期事件（演员表渲染）+ 触发 lore + 上轮正文。 */
  prose(input: ProseContextInput): ProseContext {
    const { truth } = input;
    const cast = buildCast(truth);
    return {
      toneCard: this.statics.toneCard,
      worldLore: this.statics.setting,
      recentEvents: truth.events
        .readWindow(input.proseWindowTurns)
        .map((event) => renderForGm(event.payload, cast)),
      cast,
      triggeredLore: Lorebook.render(
        truth.loreStore.book().getByTags(participantTags(input.participantCids.map((cid) => truth.characters.get(cid)))),
      ),
      lastProse: lastProse(truth.archive.readAll()),
      gmEvent: JSON.stringify({ events: input.adjudication.events, narrativity: input.adjudication.narrativity }),
      currentScene: input.currentScene,
    };
  }
}
