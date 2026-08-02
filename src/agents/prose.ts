import { compilePrompt, type PlaceholderRegistry } from "../compile/compiler.js";
import { loadTemplate } from "../compile/template.js";
import type { Display } from "../display.js";
import type { LLMClient } from "../llm/client.js";
import type { CastMember } from "../truth/identity.js";
import type { AdjudicationPackage } from "../types.js";

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

export class ProseAgent {
  readonly agentName = "prose";
  constructor(private llm: LLMClient, private toneCard: string, private worldLore: string, private cast: CastMember[]) {}
  abort(): void { this.llm.abort(); }
  async render(turn: number, adjudication: AdjudicationPackage, sceneText: string, turnInput: { recentEvents: string[]; triggeredLore: string; lastProse: string }, display?: Display): Promise<string> {
    const template = loadTemplate("prose", Object.keys(PROSE_PLACEHOLDERS));
    const messages = compilePrompt(template, PROSE_PLACEHOLDERS, {
      toneCard: this.toneCard, worldLore: this.worldLore, recentEvents: turnInput.recentEvents,
      cast: this.cast, triggeredLore: turnInput.triggeredLore, lastProse: turnInput.lastProse,
      gmEvent: JSON.stringify({ events: adjudication.events, narrativity: adjudication.narrativity }), currentScene: sceneText,
    });
    const onDelta = display ? (delta: string) => display.delta(this.agentName, delta) : undefined;
    const onReasoningDelta = display ? (delta: string) => display.reasoningDelta(this.agentName, delta) : undefined;
    const { text } = await this.llm.chat(this.agentName, turn, messages, onDelta, onReasoningDelta);
    return text.trim();
  }
}
