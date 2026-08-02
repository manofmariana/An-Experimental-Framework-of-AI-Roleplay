import { compilePrompt, type PlaceholderRegistry } from "../compile/compiler.js";
import { loadTemplate } from "../compile/template.js";
import type { Display } from "../display.js";
import { LLMAbortedError, type LLMClient } from "../llm/client.js";
import type { CharacterState, CharactersStore } from "../truth/charactersStore.js";
import { buildCastLines, type CastMember } from "../truth/identity.js";
import type { Lorebook } from "../truth/lorebook.js";
import { snapshotCharacterStates } from "../truth/snapshot.js";
import type { StateTree } from "../truth/worldStore.js";
import { AdjudicationPackageSchema, minutesToText, spanToMinutes, type AdjudicationPackage, type Event } from "../types.js";
import { extractJson } from "./json.js";

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

export class GMAgent {
  readonly agentName = "gm"; private loreFull: string; private events: string[] = []; private proseWindow: string[] = []; private clock = 0; private timeHeader = "";
  constructor(private llm: LLMClient, private setting: string, lorebook: Lorebook, private cast: CastMember[], private characters: CharactersStore) {
    this.loreFull = lorebook.all().map((entry) => `[${entry.id}]（标签：${entry.tags.join("、")}）\n${entry.content}`).join("\n\n");
  }
  observe(events: Event[]): void { for (const event of events) this.events.push(event.payload); }
  restore(events: Event[]): void { this.events = events.map((event) => event.payload); }
  abort(): void { this.llm.abort(); }
  updateWindow(blocks: string[]): void { this.proseWindow = blocks; }
  updateSituation(clock: number, timeHeader: string): void { this.clock = clock; this.timeHeader = timeHeader; }
  /** expectedTimerCids = timer 必须精确覆盖的 cid 集（同步组全体成员 ∪ 刚离组者，由 loop.expectedGmTimerCids 派生） */
  async adjudicate(turn: number, sceneText: string, world: StateTree, expectedTimerCids: readonly string[], display?: Display): Promise<{ raw: string; pkg: AdjudicationPackage }> {
    const template = loadTemplate("gm", Object.keys(GM_PLACEHOLDERS));
    const messages = compilePrompt(template, GM_PLACEHOLDERS, {
      setting: this.setting, cast: this.cast, loreFull: this.loreFull, events: this.events,
      proseWindow: this.proseWindow, currentScene: sceneText, worldSnapshot: JSON.stringify(world),
      states: this.characters.all(), clock: this.clock, timeHeader: this.timeHeader,
    });
    const onDelta = display ? (delta: string) => display.delta(this.agentName, delta) : undefined;
    const onReasoningDelta = display ? (delta: string) => display.reasoningDelta(this.agentName, delta) : undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { text } = await this.llm.chat(this.agentName, turn, messages, onDelta, onReasoningDelta);
      try { const pkg = AdjudicationPackageSchema.parse(extractJson(text)); validateAdjudicationRound(pkg, expectedTimerCids); return { raw: text, pkg }; }
      catch (error) {
        if (error instanceof LLMAbortedError) throw error;
        if (attempt === 1) throw new Error(`GM 裁决包解析失败（重试后仍失败）。原文：\n${text}`, { cause: error });
        display?.retry(this.agentName, attempt + 1, (error as Error).message);
      }
    }
    throw new Error("unreachable");
  }
}
