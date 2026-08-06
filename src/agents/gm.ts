import { compilePrompt, type PlaceholderRegistry } from "../compile/compiler.js";
import { loadTemplate } from "../compile/template.js";
import type { Display } from "../display.js";
import type { ChatPort } from "../llm/chatPort.js";
import type { CharacterState } from "../truth/charactersStore.js";
import { buildCastLines, type CastMember } from "../truth/identity.js";
import { snapshotCharacterStates } from "../truth/snapshot.js";
import { AdjudicationPackageSchema, IncidentPackageSchema, minutesToText, spanToMinutes, type AdjudicationPackage, type IncidentPackage } from "../types.js";
import { extractJson } from "./json.js";
import { runStructuredActivation } from "./structuredActivation.js";

/** 普通在场轮的上下文级裁决契约：durations 精确覆盖"同步组全体成员（含刚离组者）"
 *  （以组成员身份为准、无论 timer 值——周期序列是组状态、与 timer 无关，覆盖未行动成员是为
 *  span 一致保住周期补完；期望集合由 loop.expectedGmDurationCids 派生），
 *  location 不得越出该集合。事件内容（@CID 写作、known_by 标记纪律）靠提示词协议约束，不做程序强校验。 */
export function validateAdjudicationRound(pkg: AdjudicationPackage, expectedDurationCids: readonly string[]): void {
  const expected = new Set(expectedDurationCids); const durationCids = pkg.durations.map((item) => item.cid); const durationSet = new Set(durationCids);
  const duplicates = durationCids.filter((cid, index) => durationCids.indexOf(cid) !== index);
  const missing = expectedDurationCids.filter((cid) => !durationSet.has(cid)); const extra = [...durationSet].filter((cid) => !expected.has(cid));
  if (duplicates.length || missing.length || extra.length) throw new Error(`durations cid 必须精确覆盖同步组全体成员（含刚离组者）且不重复（缺少: ${missing.join(",") || "无"}；越界: ${extra.join(",") || "无"}；重复: ${[...new Set(duplicates)].join(",") || "无"}）`);
  const locations = pkg.location.map((item) => item.cid); const invalid = locations.filter((cid) => !expected.has(cid));
  const duplicateLocations = locations.filter((cid, index) => locations.indexOf(cid) !== index);
  if (invalid.length || duplicateLocations.length) throw new Error(`location cid 只能是不重复的上述集合子集（越界: ${[...new Set(invalid)].join(",") || "无"}；重复: ${[...new Set(duplicateLocations)].join(",") || "无"}）`);
  // GM 契约必输出非 0 时长（成员推入未来后本组自然让位，同刻下一组开跑）
  const zeroDurations = pkg.durations.filter((item) => spanToMinutes(item.span) <= 0).map((item) => item.cid);
  if (zeroDurations.length > 0) throw new Error(`durations 必须为非 0 相对偏移（span 至少一个字段 > 0）：${zeroDurations.join(",")}`);
}

export interface GmContext {
  setting: string; cast: CastMember[]; loreFull: string; events: string[]; proseWindow: string[];
  currentScene: string; worldSnapshot: string; states: Readonly<Record<string, CharacterState>>;
  clock: number; timeHeader: string;
  /** 良恶/程度判定（机械渲染；所有 GM 激活前的固定判定，现投现注入，重跑自然重投） */
  fortune: string;
}
const playable = (states: Readonly<Record<string, CharacterState>>) => Object.entries(states).sort(([a], [b]) => a.localeCompare(b));
export const GM_PLACEHOLDERS: PlaceholderRegistry<GmContext> = {
  setting: { description: "世界设定全文", provide: (context) => context.setting },
  cast: { description: "演员表", provide: (context) => buildCastLines(context.cast).join("\n") },
  lore_full: { description: "Lorebook 全文", provide: (context) => context.loreFull },
  events: { description: "已裁决事件", provide: (context) => context.events.join("\n") },
  prose_window: { description: "连续场景正文滑窗", provide: (context) => context.proseWindow.join("\n\n") },
  current_scene: { description: "本轮待裁决言行", provide: (context) => context.currentScene },
  world_snapshot: { description: "世界内容快照（纯 JSON，不含 pipeline）", provide: (context) => context.worldSnapshot },
  characters_snapshot: { description: "全部角色完整快照（纯 JSON）", provide: (context) => JSON.stringify(snapshotCharacterStates(context.states)) },
  time: { description: "结构时间机械渲染文本", provide: (context) => context.timeHeader },
  fortune: { description: "良恶/程度判定（机械渲染）", provide: (context) => context.fortune },
  timers: { description: "各角色 timer 剩余时间", provide: (context) => playable(context.states).map(([cid, state]) => state.timer === null ? `- @${cid}：无计时器` : state.timer <= context.clock ? `- @${cid}：已到期（${state.acted ? "已行动" : "未行动"}）` : `- @${cid}：${minutesToText(state.timer - context.clock)}后到期`).join("\n") },
  /** 联系人列表：后台（timer 未到期/无计时器）且未持有频道的角色——频道持有者防重入 */
  contacts: { description: "可联系对象列表（后台且未持有频道）", provide: (context) => playable(context.states).filter(([, state]) => state.channel === null && (state.timer === null || state.timer > context.clock)).map(([cid, state]) => `- @${cid}（${state.name}）：${state.location.name}`).join("\n") },
};

// ---------------------------------------------------------------------------
// 突发变体：gm-incident 提示词组（"同一身份 × 不同功能 = 不同提示词组"首个实例）
// ---------------------------------------------------------------------------

/** 突发 GM 上下文：与常规 GM 同一全知视野，另带目标组机械渲染与良恶/程度判定。 */
export interface GmIncidentContext {
  setting: string; cast: CastMember[]; loreFull: string; events: string[];
  worldSnapshot: string; states: Readonly<Record<string, CharacterState>>;
  clock: number; timeHeader: string;
  /** 目标组机械渲染（成员/地点/level/剩余休眠时长/错位度） */
  targetGroup: string;
  /** 良恶/程度判定（机械渲染，现投现注入；突发 GM 用命中组的 D） */
  fortune: string;
}

export const GM_INCIDENT_PLACEHOLDERS: PlaceholderRegistry<GmIncidentContext> = {
  setting: { description: "世界设定全文", provide: (context) => context.setting },
  cast: { description: "演员表", provide: (context) => buildCastLines(context.cast).join("\n") },
  lore_full: { description: "Lorebook 全文", provide: (context) => context.loreFull },
  events: { description: "已裁决事件", provide: (context) => context.events.join("\n") },
  world_snapshot: { description: "世界内容快照（纯 JSON，不含 pipeline）", provide: (context) => context.worldSnapshot },
  characters_snapshot: { description: "全部角色完整快照（纯 JSON）", provide: (context) => JSON.stringify(snapshotCharacterStates(context.states)) },
  time: { description: "结构时间机械渲染文本", provide: (context) => context.timeHeader },
  target_group: { description: "突发目标组（成员/地点/level/剩余休眠时长/错位度）", provide: (context) => context.targetGroup },
  fortune: { description: "良恶/程度判定（机械渲染）", provide: (context) => context.fortune },
};
/**
 * 无状态 GM activation：构造只持 ChatPort +
 * 包内 promptsDir（会话级静态配置，非跨调用缓存），全量上下文（含 loreFull——
 * lore 运行期可编辑，必须逐调用读档内副本渲染）由 application context builder
 * 现算传入；无任何跨调用缓存。
 */
export class GmActivation {
  readonly agentName = "gm";
  constructor(private llm: ChatPort, private promptsDir: string) {}
  /** expectedDurationCids = durations 必须精确覆盖的 cid 集（同步组全体成员 ∪ 刚离组者，由 loop.expectedGmDurationCids 派生） */
  async adjudicate(context: GmContext, turn: number, expectedDurationCids: readonly string[], signal: AbortSignal, display?: Display): Promise<{ raw: string; pkg: AdjudicationPackage }> {
    const template = loadTemplate("gm", Object.keys(GM_PLACEHOLDERS), this.promptsDir);
    const messages = compilePrompt(template, GM_PLACEHOLDERS, context);
    return runStructuredActivation<AdjudicationPackage>({
      port: this.llm, agentName: this.agentName, seq: turn, messages, signal,
      ...(display !== undefined ? { display } : {}),
      parse: (text) => {
        const pkg = AdjudicationPackageSchema.parse(extractJson(text));
        validateAdjudicationRound(pkg, expectedDurationCids);
        return pkg;
      },
      failureLabel: "GM 裁决包解析失败",
    });
  }

  /**
   * 突发 GM：slim 契约（事件文本 + 可选 deltas），独立轻校验，不复用 durations 覆盖校验。
   * 同一身份（同一 ChatPort/预设/全知视野），只是换用 gm-incident 提示词组。
   */
  async adjudicateIncident(context: GmIncidentContext, turn: number, signal: AbortSignal, display?: Display): Promise<{ raw: string; pkg: IncidentPackage }> {
    const template = loadTemplate("gm-incident", Object.keys(GM_INCIDENT_PLACEHOLDERS), this.promptsDir);
    const messages = compilePrompt(template, GM_INCIDENT_PLACEHOLDERS, context);
    return runStructuredActivation<IncidentPackage>({
      port: this.llm, agentName: this.agentName, seq: turn, messages, signal,
      ...(display !== undefined ? { display } : {}),
      parse: (text) => IncidentPackageSchema.parse(extractJson(text)),
      failureLabel: "突发 GM 突发包解析失败",
    });
  }
}
