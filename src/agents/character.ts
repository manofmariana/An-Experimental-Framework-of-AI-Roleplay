import { z } from "zod";
import { compilePrompt, type PlaceholderRegistry } from "../compile/compiler.js";
import { loadTemplate } from "../compile/template.js";
import type { Display } from "../display.js";
import { LLMAbortedError, type ChatPort } from "../llm/chatPort.js";
import { CharactersStore, type CharacterState } from "../truth/charactersStore.js";
import { renderForReader, type CastMember } from "../truth/identity.js";
import { snapshotCharacterState } from "../truth/snapshot.js";
import { DecisionPackageSchema, InitiativeSchema, LocationSchema, type DecisionPackage, type Event, type Location } from "../types.js";
import { extractJson } from "./json.js";

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

/** 离开标记的"冻结"timer（与 loop.ts 的 LEAVE_TIMER 同值；此处独立定义以避免 character→loop 循环依赖） */
const LEAVE_TIMER = Number.MAX_SAFE_INTEGER;

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

export class CharacterAgent {
  readonly agentName: string;
  private recentEvents: string[] = []; private proseWindow: string[] = []; private currentScene = ""; private timeHeader = ""; private worldSnapshot = "{}"; private clock = 0;
  private incomingContact: { inviter: string; channel: string } | null = null;
  constructor(private manifest: CharacterManifest, private llm: ChatPort, private characters: CharactersStore, private cast: CastMember[], private activatedLore: string) {
    this.agentName = `character:${manifest.id}`;
  }
  get id(): string { return this.manifest.id; }
  get location(): Location { return this.characters.get(this.id).location; }
  perceive(events: Event[]): void { const relations = this.characters.get(this.id).relations; for (const event of events) this.recentEvents.push(renderForReader(event.payload, this.id, relations)); }
  updateWindow(blocks: string[]): void { this.proseWindow = blocks; }
  updateScene(sceneText: string): void { this.currentScene = sceneText; }
  updateSituation(header: string, world: Record<string, unknown>, clock: number): void { this.timeHeader = header; this.worldSnapshot = JSON.stringify(world); this.clock = clock; }
  updateIncomingContact(contact: { inviter: string; channel: string } | null): void { this.incomingContact = contact; }

  async decide(turn: number, signal: AbortSignal, display?: Display): Promise<{ raw: string; pkg: DecisionPackage }> {
    const template = loadTemplate("character", Object.keys(CHARACTER_PLACEHOLDERS));
    const messages = compilePrompt(template, CHARACTER_PLACEHOLDERS, {
      selfCid: this.id, states: this.characters.all(), cast: this.cast, worldSnapshot: this.worldSnapshot,
      activatedLore: this.activatedLore, recentEvents: this.recentEvents, proseWindow: this.proseWindow,
      currentScene: this.currentScene, timeHeader: this.timeHeader, clock: this.clock,
      incomingContact: this.incomingContact,
    });
    const onDelta = display ? (delta: string) => display.delta(this.agentName, delta) : undefined;
    const onReasoningDelta = display ? (delta: string) => display.reasoningDelta(this.agentName, delta) : undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { text } = await this.llm.chat(
        {
          agent: this.agentName, seq: turn, messages,
          ...(onDelta !== undefined ? { onDelta } : {}),
          ...(onReasoningDelta !== undefined ? { onReasoningDelta } : {}),
        },
        signal,
      );
      try { return { raw: text, pkg: DecisionPackageSchema.parse(extractJson(text)) }; }
      catch (error) {
        if (error instanceof LLMAbortedError) throw error;
        if (attempt === 1) throw new Error(`角色 ${this.manifest.name} 决策包解析失败（重试后仍失败）。原文：\n${text}`, { cause: error });
        display?.retry(this.agentName, attempt + 1, (error as Error).message);
      }
    }
    throw new Error("unreachable");
  }
  restore(events: Event[]): void { this.recentEvents = []; this.perceive(events); }
}
