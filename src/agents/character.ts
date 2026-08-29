import { z } from "zod";
import { renderPrompt, type RenderHost } from "../compile/render.js";
import { validateTemplate } from "../compile/template.js";
import type { Display } from "../display.js";
import type { ChatPort } from "../llm/chatPort.js";
import { PROMPT_MATRIX, type PromptsStore } from "../truth/promptsStore.js";
import { DecisionPackageSchema, InitiativeSchema, LocationSchema, type DecisionPackage } from "../types.js";
import { extractJson } from "./json.js";
import { runStructuredActivation } from "./structuredActivation.js";

export const CharacterManifestSchema = z.object({
  id: z.string(), name: z.string().min(1), gender: z.string(), age: z.string(), personality: z.string().min(1),
  reaction: z.number(), location: LocationSchema,
  timer: z.number().int().finite().nonnegative().nullable(),
  group: z.number().default(0), initiative: InitiativeSchema.nullable().default(null),
  channel: z.number().nullable().default(null), acted: z.boolean().default(false),
  level: z.number(),
  /** 全知权重（0-6；恒定系统字段，不开放写通道） */
  omniscience: z.number().int().min(0).max(6).default(0),
  isPlayer: z.boolean(),
  relations: z.array(z.object({ cid: z.string().min(1), name: z.string().optional(), impression: z.string().optional() })),
  initial_memories: z.array(z.string()),
  /** 变量树初值（允许末端简写；形状校验在装配层按 character 模板 normalize 时做） */
  vars: z.record(z.string(), z.unknown()).default({}),
});
export type CharacterManifest = z.infer<typeof CharacterManifestSchema>;

/**
 * 无状态角色 activation：构造只持 ChatPort +
 * 档内 PromptsStore（每轮激活读档内模板副本与占位符目录，编辑通道更新后下一轮即生效），
 * 注入内容由 application 投影层（src/application/activationContexts.ts）逐调用从最新真相
 * 现算为 RenderHost 传入——实例不缓存任何跨调用状态；一个实例服务全部 NPC，角色差异
 * 全在本次读者（host.reader）。
 */
export class CharacterActivation {
  constructor(private llm: ChatPort, private prompts: PromptsStore) {}

  async decide(host: RenderHost, turn: number, signal: AbortSignal, display?: Display): Promise<{ raw: string; pkg: DecisionPackage }> {
    if (host.reader.kind !== "character") throw new Error("角色 activation 需要 character 读者投影");
    const catalog = this.prompts.placeholders();
    const template = validateTemplate(this.prompts.template(PROMPT_MATRIX.character.decision), Object.keys(catalog));
    const messages = renderPrompt(template, catalog, host);
    const agentName = `character:${host.reader.cid}`;
    return runStructuredActivation<DecisionPackage>({
      port: this.llm, agentName, seq: turn, messages, signal,
      ...(display !== undefined ? { display } : {}),
      parse: (text) => DecisionPackageSchema.parse(extractJson(text)),
      failureLabel: `角色 ${host.readerLabel} 决策包解析失败`,
    });
  }
}
