/**
 * prompts 域路由（提示词模板读写 + 占位符目录）。
 * 模板文件 IO 在 resources/worldRepository（readPromptFile/writePromptFile）；
 * 结构 + 占位符校验（依赖 agents 占位符注册表与 compile/template）留在本路由层。
 * 提示词热加载（每轮激活前重读），保存后下一轮对话即生效，无需 markStale。
 */
import { CHARACTER_PLACEHOLDERS } from "../../../agents/character.js";
import { GM_PLACEHOLDERS } from "../../../agents/gm.js";
import { PROSE_PLACEHOLDERS } from "../../../agents/prose.js";
import { placeholderCatalog, type PlaceholderRegistry } from "../../../compile/compiler.js";
import {
  PromptTemplateSchema,
  validateTemplate,
  type PromptTemplate,
} from "../../../compile/template.js";
import { AGENT_KINDS, type AgentKind } from "../../../config.js";
import { readPromptFile, writePromptFile } from "../../../resources/worldRepository.js";
import { ApiError, validate } from "../errors.js";
import { parseJsonBody, readBody } from "../response.js";
import type { ApiDeps, Route } from "../router.js";

const PROMPT_REGISTRIES: Record<AgentKind, PlaceholderRegistry<never>> = {
  character: CHARACTER_PLACEHOLDERS,
  gm: GM_PLACEHOLDERS,
  prose: PROSE_PLACEHOLDERS,
};

/** 每个 agent 的可用占位符目录（GET /api/prompts/placeholders）。 */
export function placeholdersCatalog(): {
  agent: AgentKind;
  placeholders: { key: string; description: string }[];
}[] {
  return AGENT_KINDS.map((agent) => ({
    agent,
    placeholders: placeholderCatalog(PROMPT_REGISTRIES[agent]),
  }));
}

/** 读取三个模板全文（GET /api/prompts；结构校验，内容原样返回）。 */
export function readPromptTemplates(promptsDir: string): PromptTemplate[] {
  return AGENT_KINDS.map((agent) =>
    PromptTemplateSchema.parse(JSON.parse(readPromptFile(promptsDir, agent))),
  );
}

/**
 * 校验 PUT 模板（结构 + 占位符合法性，对应该 agent 注册表）；
 * 未知占位符抛错并列出名字（路由层经 validate() 转 400）。
 */
export function validatePromptPayload(agent: AgentKind, raw: unknown): PromptTemplate {
  const template = validateTemplate(raw, Object.keys(PROMPT_REGISTRIES[agent]));
  if (template.id !== agent) {
    throw new Error(`模板 id（${template.id}）与路径（${agent}）不一致`);
  }
  return template;
}

export function promptRoutes(deps: ApiDeps): Route[] {
  const promptsDir = deps.dirs.promptsDir;
  return [
    {
      method: "GET",
      pattern: "/api/prompts/placeholders",
      handler: () => placeholdersCatalog(),
    },
    {
      method: "GET",
      pattern: "/api/prompts",
      handler: () => readPromptTemplates(promptsDir),
    },
    {
      method: "PUT",
      pattern: "/api/prompts/:agent",
      handler: async ({ req, params }) => {
        const agent = params.agent!;
        if (!(AGENT_KINDS as readonly string[]).includes(agent)) {
          throw new ApiError(400, "VALIDATION_ERROR", `未知模板: ${agent}（只允许 ${AGENT_KINDS.join(" / ")}）`);
        }
        const body = parseJsonBody(await readBody(req));
        const template = validate(() => validatePromptPayload(agent as AgentKind, body));
        writePromptFile(promptsDir, agent, JSON.stringify(template, null, 2) + "\n");
        // 提示词热加载（每轮激活前重读），无需 markStale——下一轮对话即生效
        return { note: "已保存，下一轮对话生效" };
      },
    },
  ];
}
