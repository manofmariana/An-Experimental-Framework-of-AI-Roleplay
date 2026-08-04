import { z } from "zod";
import { compilePrompt, type PlaceholderRegistry } from "../compile/compiler.js";
import { loadTemplate } from "../compile/template.js";
import type { Display } from "../display.js";
import type { ChatPort } from "../llm/chatPort.js";
import type { CharacterState } from "../truth/charactersStore.js";
import type { CastMember } from "../truth/identity.js";
import { snapshotCharacterState } from "../truth/snapshot.js";
import { LEAVE_TIMER } from "../scheduler/simulator.js";
import { DecisionPackageSchema, InitiativeSchema, LocationSchema, type DecisionPackage } from "../types.js";
import { extractJson } from "./json.js";
import { runStructuredActivation } from "./structuredActivation.js";

export const CharacterManifestSchema = z.object({
  id: z.string(), name: z.string().min(1), gender: z.string(), age: z.string(), personality: z.string().min(1),
  tags: z.array(z.string()), reaction: z.number(), location: LocationSchema,
  timer: z.number().int().finite().nonnegative().nullable(),
  group: z.number().default(0), initiative: InitiativeSchema.nullable().default(null),
  channel: z.number().nullable().default(null), acted: z.boolean().default(false),
  level: z.number(), isPlayer: z.boolean(),
  relations: z.record(z.string(), z.object({ name: z.string().optional(), impression: z.string().optional() })),
  initial_memories: z.array(z.string()), vars: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
});
export type CharacterManifest = z.infer<typeof CharacterManifestSchema>;

export interface CharacterContext {
  selfCid: string; states: Readonly<Record<string, CharacterState>>; cast: CastMember[];
  worldSnapshot: string; activatedLore: string; recentEvents: string[]; proseWindow: string[];
  currentScene: string; timeHeader: string; clock: number;
  /** 本角色被激活以应答的待答邀请（邀请者 cid + 途径）；无待答邀请 = null */
  incomingContact?: { inviter: string; channel: string } | null;
}
function self(context: CharacterContext): CharacterState {
  const state = context.states[context.selfCid]; if (!state) throw new Error(`未知角色 CID: ${context.selfCid}`); return state;
}

export const CHARACTER_PLACEHOLDERS: PlaceholderRegistry<CharacterContext> = {
  name: { description: "角色名", provide: (context) => self(context).name },
  cid: { description: "角色 CID", provide: (context) => context.selfCid },
  world_snapshot: { description: "世界内容快照（纯 JSON，不含 pipeline）", provide: (context) => context.worldSnapshot },
  character_snapshot: { description: "本角色完整状态快照（纯 JSON）", provide: (context) => JSON.stringify(snapshotCharacterState(self(context))) },
  group_members: {
    description: "同组角色表（CID/名字/地点）；基于 relations 的认知隔离是后续工作",
    provide: (context) => {
      const me = self(context);
      if (me.group === 0) return "";
      return Object.entries(context.states)
        .filter(([, state]) => state.group === me.group)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([cid, state]) => `- @${cid} ${state.name}（${state.location.name}）${cid === context.selfCid ? "（你）" : ""}`)
        .join("\n");
    },
  },
  long_term_memory: { description: "本角色长期记忆", provide: (context) => self(context).long_term_memory.map((item) => `- ${item}`).join("\n") },
  activated_lore: { description: "本角色标签激活 lore", provide: (context) => context.activatedLore },
  recent_events: { description: "本角色可见近期事件", provide: (context) => context.recentEvents.join("\n") },
  prose_window: { description: "同角色同场景正文滑窗", provide: (context) => context.proseWindow.join("\n\n") },
  current_scene: { description: "本轮未裁决言行", provide: (context) => context.currentScene },
  time: { description: "结构时间机械渲染文本", provide: (context) => context.timeHeader },
  location: { description: "当前地点名", provide: (context) => self(context).location.name },
  /**
   * 联系人列表（M2-b §5.3），两层规则：
   * 1. 整体可见性：本角色持有频道（channel !== null，邀请者/被邀请者在 contact 生效时即被分配频道）
   *    或正在应答邀请（incomingContact != null）时，整个名单不可见 → 直接返回空串；
   * 2. 条目过滤（防重入）：只列出后台（timer 未到期/无计时器）且未持有频道的其他角色——频道持有者已在通话中，不可被重复邀请。
   */
  contacts: {
    description: "可联系对象列表（后台且未持有频道；自身持频道或待答邀请时整体不可见）",
    provide: (context) => {
      if (self(context).channel !== null || context.incomingContact != null) return "";
      return Object.entries(context.states).filter(([cid, state]) => cid !== context.selfCid && state.channel === null && (state.timer === null || state.timer > context.clock)).sort(([a], [b]) => a.localeCompare(b)).map(([cid, state]) => `- @${cid}`).join("\n");
    },
  },
  /** 离场通知（M2-b §5.2）：本组中已离开且未结算的成员（timer=LEAVE_TIMER 且 initiative.group 仍指向本组） */
  departure_notices: {
    description: "本组未结算离场成员列表（可用 recall 标记召回）",
    provide: (context) => {
      const group = self(context).group;
      if (group === 0) return "";
      return Object.entries(context.states)
        .filter(([cid, state]) =>
          cid !== context.selfCid &&
          state.timer !== null && state.timer >= LEAVE_TIMER &&
          state.initiative?.group === group)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([cid]) => `@${cid} 离开了当前场景，如果不希望他离开，你可以使用 {"type":"recall","target":"${cid}"} 标记召回`)
        .join("\n");
    },
  },
  /** 被联系通知（M2-b §5.3）：本角色被激活以应答一次邀请时注入；无待答邀请 = 空串 */
  incoming_contact: {
    description: "待答邀请通知（邀请者 + 途径 + 接受/拒绝方式）",
    provide: (context) => context.incomingContact == null
      ? ""
      : `@${context.incomingContact.inviter} 正在通过「${context.incomingContact.channel}」联系你。接受：输出 {"type":"confirm"} 标记（本轮输出即你的首轮回复）；拒绝：不立标记，在 dialogue 或 action 中说明理由`,
  },
};

/**
 * 无状态角色 activation（docs/optimization-review.md §4）：构造只持 ChatPort，
 * 全量上下文由 application context builder（src/application/activationContexts.ts）
 * 逐调用从最新真相现算传入——实例不缓存 recentEvents/proseWindow/scene/clock/cast/
 * Store 引用等任何跨调用状态；一个实例服务全部 NPC，角色差异全在本次 Context。
 */
export class CharacterActivation {
  constructor(private llm: ChatPort) {}

  async decide(context: CharacterContext, turn: number, signal: AbortSignal, display?: Display): Promise<{ raw: string; pkg: DecisionPackage }> {
    const template = loadTemplate("character", Object.keys(CHARACTER_PLACEHOLDERS));
    const messages = compilePrompt(template, CHARACTER_PLACEHOLDERS, context);
    const agentName = `character:${context.selfCid}`;
    return runStructuredActivation<DecisionPackage>({
      port: this.llm, agentName, seq: turn, messages, signal,
      ...(display !== undefined ? { display } : {}),
      parse: (text) => DecisionPackageSchema.parse(extractJson(text)),
      failureLabel: `角色 ${self(context).name} 决策包解析失败`,
    });
  }
}
