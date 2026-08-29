import { renderPrompt, type RenderHost } from "../compile/render.js";
import { validateTemplate } from "../compile/template.js";
import type { Display } from "../display.js";
import type { ChatPort } from "../llm/chatPort.js";
import { PROMPT_MATRIX, type PromptsStore } from "../truth/promptsStore.js";
import { AdjudicationPackageSchema, IncidentPackageSchema, spanToMinutes, type AdjudicationPackage, type IncidentPackage } from "../types.js";
import { validateTagListWrite, type TagWriteScope } from "../vars/tree.js";
import { extractJson } from "./json.js";
import { runStructuredActivation } from "./structuredActivation.js";

/** 普通在场轮的上下文级裁决契约：durations 精确覆盖"同步组全体成员（含刚离组者）"
 *  （以组成员身份为准、无论 timer 值——周期序列是组状态、与 timer 无关，覆盖未行动成员是为
 *  span 一致保住周期补完；期望集合由 loop.expectedGmDurationCids 派生），
 *  location 不得越出该集合。事件内容（@CID 写作、等级选择）靠提示词协议约束，不做程序强校验。 */
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

/**
 * 无状态 GM activation：构造只持 ChatPort +
 * 档内 PromptsStore（每轮激活读档内模板副本与占位符目录），
 * 全知视野的注入内容（含 lore 全文——
 * lore 运行期可编辑，必须逐调用读档内副本渲染）由 application 投影层
 * 现算为 RenderHost 传入；无任何跨调用缓存。
 */
export class GmActivation {
  readonly agentName = "gm";
  constructor(private llm: ChatPort, private prompts: PromptsStore) {}

  private messagesFor(templateId: (typeof PROMPT_MATRIX.gm)[keyof typeof PROMPT_MATRIX.gm], host: RenderHost) {
    const catalog = this.prompts.placeholders();
    const template = validateTemplate(this.prompts.template(templateId), Object.keys(catalog));
    return renderPrompt(template, catalog, host);
  }

  /** expectedDurationCids = durations 必须精确覆盖的 cid 集（同步组全体成员 ∪ 刚离组者，由 loop.expectedGmDurationCids 派生）；
   *  eventTagScope = 事件 tags 名称校验上下文（档内注册表类别化口径：注册名 ∪ cid 现存实例 ∪ channel/location 声明；
   *  等级范围由 schema 机检；不合法走解析失败重试通道） */
  async adjudicate(host: RenderHost, turn: number, expectedDurationCids: readonly string[], eventTagScope: TagWriteScope, signal: AbortSignal, display?: Display): Promise<{ raw: string; pkg: AdjudicationPackage }> {
    const messages = this.messagesFor(PROMPT_MATRIX.gm.adjudication, host);
    return runStructuredActivation<AdjudicationPackage>({
      port: this.llm, agentName: this.agentName, seq: turn, messages, signal,
      ...(display !== undefined ? { display } : {}),
      parse: (text) => {
        const pkg = AdjudicationPackageSchema.parse(extractJson(text));
        validateAdjudicationRound(pkg, expectedDurationCids);
        for (const ev of pkg.events) validateTagListWrite(ev.tags, eventTagScope);
        return pkg;
      },
      failureLabel: "GM 裁决包解析失败",
    });
  }

  /**
   * 突发 GM：slim 契约（事件文本 + 可选 deltas），独立轻校验，不复用 durations 覆盖校验。
   * 同一身份（同一 ChatPort/预设/全知视野），只是换用矩阵 gm.incident 功能组。
   */
  async adjudicateIncident(host: RenderHost, turn: number, signal: AbortSignal, display?: Display): Promise<{ raw: string; pkg: IncidentPackage }> {
    const messages = this.messagesFor(PROMPT_MATRIX.gm.incident, host);
    return runStructuredActivation<IncidentPackage>({
      port: this.llm, agentName: this.agentName, seq: turn, messages, signal,
      ...(display !== undefined ? { display } : {}),
      parse: (text) => IncidentPackageSchema.parse(extractJson(text)),
      failureLabel: "突发 GM 突发包解析失败",
    });
  }
}
