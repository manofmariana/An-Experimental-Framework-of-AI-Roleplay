import { compilePrompt, type PlaceholderRegistry } from "../compile/compiler.js";
import { loadTemplate } from "../compile/template.js";
import type { Display } from "../display.js";
import type { ChatPort } from "../llm/chatPort.js";
import type { CastMember } from "../truth/identity.js";

export interface ProseContext {
  toneCard: string; worldLore: string; recentEvents: string[]; cast: CastMember[];
  triggeredLore: string; lastProse: string; gmEvent: string; currentScene: string;
}
export const PROSE_PLACEHOLDERS: PlaceholderRegistry<ProseContext> = {
  tone_card: { description: "世界基调卡全文", provide: (context) => context.toneCard },
  world_lore: { description: "世界设定全文", provide: (context) => context.worldLore },
  recent_events: { description: "近期事件", provide: (context) => context.recentEvents.join("\n") },
  cast: { description: "演员表", provide: (context) => context.cast.map((member) => `- @${member.cid} = ${member.name}`).join("\n") },
  triggered_lore: { description: "本轮触发 lore", provide: (context) => context.triggeredLore },
  last_prose: { description: "上一轮正文", provide: (context) => context.lastProse },
  gm_event: { description: "本轮 GM 事件包", provide: (context) => context.gmEvent },
  current_scene: { description: "本轮各角色台词与内心", provide: (context) => context.currentScene },
};

/**
 * 无状态正文 activation：构造只持 ChatPort +
 * 包内 promptsDir（会话级静态配置，非跨调用缓存），toneCard/worldLore/cast 与
 * 逐轮素材全部由 builder 现算进 ProseContext 逐调用传入。
 */
export class ProseActivation {
  readonly agentName = "prose";
  constructor(private llm: ChatPort, private promptsDir: string) {}
  async render(context: ProseContext, turn: number, signal: AbortSignal, display?: Display): Promise<string> {
    const template = loadTemplate("prose", Object.keys(PROSE_PLACEHOLDERS), this.promptsDir);
    const messages = compilePrompt(template, PROSE_PLACEHOLDERS, context);
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
