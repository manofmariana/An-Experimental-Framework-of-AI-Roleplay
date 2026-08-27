import { renderPrompt, type RenderHost } from "../compile/render.js";
import { validateTemplate } from "../compile/template.js";
import type { Display } from "../display.js";
import type { ChatPort } from "../llm/chatPort.js";
import type { PromptsStore } from "../truth/promptsStore.js";

/**
 * 无状态正文 activation：构造只持 ChatPort +
 * 档内 PromptsStore（每轮激活读档内模板副本与占位符目录），
 * 静态文本/cast 与逐轮素材全部由 application 投影层现算为 RenderHost 逐调用传入。
 */
export class ProseActivation {
  readonly agentName = "prose";
  constructor(private llm: ChatPort, private prompts: PromptsStore) {}
  async render(host: RenderHost, turn: number, signal: AbortSignal, display?: Display): Promise<string> {
    const catalog = this.prompts.placeholders();
    const template = validateTemplate(this.prompts.template("prose"), Object.keys(catalog));
    const messages = renderPrompt(template, catalog, host);
    const onDelta = display ? (delta: string) => display.delta(this.agentName, delta) : undefined;
    const onReasoningDelta = display ? (delta: string) => display.reasoningDelta(this.agentName, delta) : undefined;
    const { text } = await this.llm.chat(
      {
        agent: this.agentName, seq: turn, messages,
        ...(onDelta !== undefined ? { onDelta } : {}),
        ...(onReasoningDelta !== undefined ? { onReasoningDelta } : {}),
      },
      signal,
    );
    return text.trim();
  }
}
