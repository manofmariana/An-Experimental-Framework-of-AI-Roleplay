/**
 * 提示词模板（世界包内 prompts/{agent}.prompt.json，每包一份完整副本）：
 * 模板 = 有序模块列表，模块 = {key, role, content}，content 内 {{placeholder}} 占位。
 * 占位符由 agent 代码侧的注册表（key → provider(context) → string）提供——
 * 注册表是唯一出口：新占位符 = 注册新 provider，禁止在组装代码里散落硬编码拼接。
 * 未知占位符在加载/保存校验时报错（列出模块 key 与占位符名）。
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const PromptModuleSchema = z.object({
  key: z.string().min(1),
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});
export type PromptModule = z.infer<typeof PromptModuleSchema>;

export const PromptTemplateSchema = z.object({
  id: z.string().min(1),
  modules: z.array(PromptModuleSchema),
});
export type PromptTemplate = z.infer<typeof PromptTemplateSchema>;

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** 提取一段文本里的全部占位符名（去重，按出现顺序）。 */
export function extractPlaceholders(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(PLACEHOLDER)) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

/**
 * 校验模板：结构（zod）+ 占位符合法性（必须全部在注册表 keys 内）。
 * 未知占位符抛错，列出模块 key 与占位符名。
 */
export function validateTemplate(raw: unknown, registryKeys: readonly string[]): PromptTemplate {
  const template = PromptTemplateSchema.parse(raw);
  const known = new Set(registryKeys);
  const problems: string[] = [];
  for (const mod of template.modules) {
    for (const name of extractPlaceholders(mod.content)) {
      if (!known.has(name)) problems.push(`模块 "${mod.key}" 的 {{${name}}}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`模板 ${template.id} 含未知占位符：${problems.join("、")}`);
  }
  return template;
}

/** 加载模板（dir = 世界包内 prompts/ 目录，无全局默认——调用方必传），按注册表校验占位符。 */
export function loadTemplate(
  agent: string,
  registryKeys: readonly string[],
  dir: string,
): PromptTemplate {
  const file = path.join(dir, `${agent}.prompt.json`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  const template = validateTemplate(raw, registryKeys);
  if (template.id !== agent) {
    throw new Error(`模板 id（${template.id}）与文件名（${agent}）不一致`);
  }
  return template;
}
