import { compilePrompt, type PlaceholderRegistry } from "../compile/compiler.js";
import { loadTemplate } from "../compile/template.js";
import type { Display } from "../display.js";
import type { ChatPort } from "../llm/chatPort.js";
import type { CharacterState } from "../truth/charactersStore.js";
import { buildCastLines, type CastMember } from "../truth/identity.js";
import { snapshotCharacterStates } from "../truth/snapshot.js";
import { AdjudicationPackageSchema, minutesToText, spanToMinutes, type AdjudicationPackage } from "../types.js";
import { extractJson } from "./json.js";
import { runStructuredActivation } from "./structuredActivation.js";

/** 普通在场轮的上下文级裁决契约：timer 精确覆盖"同步组全体成员（含刚离组者）"
 *  （以组成员身份为准、无论 timer 值——周期序列是组状态、与 timer 无关，覆盖未行动成员是为
 *  span 一致保住周期补完；期望集合由 loop.expectedGmTimerCids 派生），
 *  location 不得越出该集合。事件内容（@CID 写作、known_by 标记纪律）靠提示词协议约束，不做程序强校验。 */
export function validateAdjudicationRound(pkg: AdjudicationPackage, expectedTimerCids: readonly string[]): void {
  const expected = new Set(expectedTimerCids); const timerCids = pkg.timer.map((item) => item.cid); const timerSet = new Set(timerCids);
  const duplicates = timerCids.filter((cid, index) => timerCids.indexOf(cid) !== index);
  const missing = expectedTimerCids.filter((cid) => !timerSet.has(cid)); const extra = [...timerSet].filter((cid) => !expected.has(cid));
  if (duplicates.length || missing.length || extra.length) throw new Error(`timer cid 必须精确覆盖同步组全体成员（含刚离组者）且不重复（缺少: ${missing.join(",") || "无"}；越界: ${extra.join(",") || "无"}；重复: ${[...new Set(duplicates)].join(",") || "无"}）`);
  const locations = pkg.location.map((item) => item.cid); const invalid = locations.filter((cid) => !expected.has(cid));
  const duplicateLocations = locations.filter((cid, index) => locations.indexOf(cid) !== index);
  if (invalid.length || duplicateLocations.length) throw new Error(`location cid 只能是不重复的上述集合子集（越界: ${[...new Set(invalid)].join(",") || "无"}；重复: ${[...new Set(duplicateLocations)].join(",") || "无"}）`);
  // M2-b：GM 契约必输出非 0 timer（成员推入未来后本组自然让位，同刻下一组开跑）
  const zeroTimers = pkg.timer.filter((item) => spanToMinutes(item.span) <= 0).map((item) => item.cid);
  if (zeroTimers.length > 0) throw new Error(`timer 必须为非 0 相对偏移（span 至少一个字段 > 0）：${zeroTimers.join(",")}`);
}

export interface GmContext {
  setting: string; cast: CastMember[]; loreFull: string; events: string[]; proseWindow: string[];
  currentScene: string; worldSnapshot: string; states: Readonly<Record<string, CharacterState>>;
  clock: number; timeHeader: string;
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
  timers: { description: "各角色 timer 剩余时间", provide: (context) => playable(context.states).map(([cid, state]) => state.timer === null ? `- @${cid}：无计时器` : state.timer <= context.clock ? `- @${cid}：已到期（${state.acted ? "已行动" : "未行动"}）` : `- @${cid}：${minutesToText(state.timer - context.clock)}后到期`).join("\n") },
  /** 联系人列表（M2-b §5.3）：后台（timer 未到期/无计时器）且未持有频道的角色——频道持有者防重入 */
  contacts: { description: "可联系对象列表（后台且未持有频道）", provide: (context) => playable(context.states).filter(([, state]) => state.channel === null && (state.timer === null || state.timer > context.clock)).map(([cid, state]) => `- @${cid}（${state.name}）：${state.location.name}`).join("\n") },
};

/**
 * 无状态 GM activation（docs/optimization-review.md §4）：构造只持 ChatPort，
 * 全量上下文（含 loreFull——lore 运行期可编辑，必须逐调用读档内副本渲染）由
 * application context builder 现算传入；无任何跨调用缓存。
 */
export class GmActivation {
  readonly agentName = "gm";
  constructor(private llm: ChatPort) {}
  /** expectedTimerCids = timer 必须精确覆盖的 cid 集（同步组全体成员 ∪ 刚离组者，由 loop.expectedGmTimerCids 派生） */
  async adjudicate(context: GmContext, turn: number, expectedTimerCids: readonly string[], signal: AbortSignal, display?: Display): Promise<{ raw: string; pkg: AdjudicationPackage }> {
    const template = loadTemplate("gm", Object.keys(GM_PLACEHOLDERS));
    const messages = compilePrompt(template, GM_PLACEHOLDERS, context);
    return runStructuredActivation<AdjudicationPackage>({
      port: this.llm, agentName: this.agentName, seq: turn, messages, signal,
      ...(display !== undefined ? { display } : {}),
      parse: (text) => {
        const pkg = AdjudicationPackageSchema.parse(extractJson(text));
        validateAdjudicationRound(pkg, expectedTimerCids);
        return pkg;
      },
      failureLabel: "GM 裁决包解析失败",
    });
  }
}
