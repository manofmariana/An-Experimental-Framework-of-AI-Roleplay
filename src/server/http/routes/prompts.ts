/**
 * prompts 域路由（提示词模板读写 + 占位符目录读写）。
 * 双模式（与结构编辑同判据）：有活跃会话 → GET/PUT 读写档内副本（prompts.json，
 * PUT 经 SessionCoordinator 直编命令入队 + CommitExecutor 落盘，保存后下一轮激活即生效）；
 * 无活跃会话 → 读写世界包基线（?set= 定位包，缺省 DEFAULT_WORLD_SET，包不存在 →
 * WORLD_SET_NOT_FOUND 404；包内文件 IO 在 resources/worldRepository，新会话生效）。
 * 结构 + 占位符校验（合法键集 = 当前模式占位符目录键集，compile/template）留在本路由层。
 * 模板键 = 封闭四值（character/gm/prose/gm-incident 突发变体）。
 * 占位符目录 = 声明式条目（全对象共享、读者无关）：GET 出平铺目录 + source 封闭枚举；
 * PUT 整份提交——parse（zod 形状 + 分支记号集规范化）+ validatePlaceholders 语义机检
 * （机检上下文按模式供给：档内 = 档内 `_sys` 模板与注册表，包基线 = 该包变量体系文件），
 * 失败 400 零落盘。
 */
import {
  parsePlaceholders,
  PLACEHOLDER_SOURCES,
  validatePlaceholders,
  type PlaceholderCatalog,
  type ValidatePlaceholdersDeps,
} from "../../../compile/placeholders.js";
import {
  PromptTemplateSchema,
  validateTemplate,
  type PromptTemplate,
} from "../../../compile/template.js";
import { DEFAULT_WORLD_SET } from "../../../config.js";
import {
  packPromptsDir,
  readPlaceholdersFile,
  readPromptFile,
  readWorldVarsFile,
  resolveWorldDir,
  writePromptFile,
  writePlaceholdersFile,
} from "../../../resources/worldRepository.js";
import { parseTagRegistry } from "../../../tags/registry.js";
import {
  isPromptTemplateId,
  PROMPT_TEMPLATE_IDS,
  type PromptTemplateId,
} from "../../../truth/promptsStore.js";
import { parseWorldSys } from "../../../truth/varWrite.js";
import { parseVarsTemplate } from "../../../vars/template.js";
import { ApiError, toApiError, validate } from "../errors.js";
import { parseJsonBody, readBody } from "../response.js";
import type { ApiDeps, Route } from "../router.js";

/** 目录只读视图（档内冻结副本与包基线解析产物同形）。 */
type CatalogView = Readonly<
  Record<string, { readonly description: string; readonly source: string; readonly segments: readonly unknown[] }>
>;

/** 占位符平铺目录（GET /api/prompts/placeholders 的 entries 段）：条目名 + description + source + 段列全文。 */
export function placeholdersCatalog(catalog: CatalogView): {
  key: string;
  description: string;
  source: string;
  segments: readonly unknown[];
}[] {
  return Object.entries(catalog).map(([key, entry]) => ({
    key,
    description: entry.description,
    source: entry.source,
    segments: entry.segments,
  }));
}

/** 读取包基线四份模板全文（GET /api/prompts 无会话模式；结构校验，内容原样返回）。 */
export function readPromptTemplates(promptsDir: string): PromptTemplate[] {
  return PROMPT_TEMPLATE_IDS.map((agent) =>
    PromptTemplateSchema.parse(JSON.parse(readPromptFile(promptsDir, agent))),
  );
}

/** 读取包基线占位符目录（无会话模式；zod 形状校验 + 分支规范化同装配口径）。 */
function readPackPlaceholders(promptsDir: string): PlaceholderCatalog {
  return parsePlaceholders(JSON.parse(readPlaceholdersFile(promptsDir)));
}

/** 包基线机检上下文：该包 tags.json 注册表 + vars-template.json 模板（缺文件 = 包损坏，同装配拒装口径）。 */
function packValidationDeps(worldDir: string): ValidatePlaceholdersDeps {
  const tagsRaw = readWorldVarsFile(worldDir, "tags");
  const templateRaw = readWorldVarsFile(worldDir, "vars-template");
  if (tagsRaw === null || templateRaw === null) {
    throw new Error(`世界设定集缺少变量体系文件（tags.json / vars-template.json）: ${worldDir}`);
  }
  return { template: parseVarsTemplate(templateRaw), registry: parseTagRegistry(tagsRaw) };
}

/**
 * 校验 PUT 模板（结构 + 占位符合法性，合法键集 = 当前模式占位符目录键集）；
 * 未知占位符抛错并列出名字（路由层经 validate() 转 400）。
 */
export function validatePromptPayload(
  agent: PromptTemplateId,
  raw: unknown,
  catalog: Readonly<Record<string, unknown>>,
): PromptTemplate {
  const template = validateTemplate(raw, Object.keys(catalog));
  if (template.id !== agent) {
    throw new Error(`模板 id（${template.id}）与路径（${agent}）不一致`);
  }
  return template;
}

export function promptRoutes(deps: ApiDeps): Route[] {
  // ?set= 定位包内 prompts/（缺省 DEFAULT_WORLD_SET；包不存在 → WORLD_SET_NOT_FOUND 404）
  const promptsDirOf = (url: URL): string =>
    packPromptsDir(
      resolveWorldDir(deps.dirs.assetsDir, url.searchParams.get("set") ?? undefined, DEFAULT_WORLD_SET),
    );
  // 当前模式的占位符目录：有活跃会话 = 档内副本；无会话 = 包基线（null = 档内模式）
  const catalogOf = (url: URL): { catalog: CatalogView; active: boolean } => {
    const active = deps.coordinator.activePrompts();
    if (active !== null) return { catalog: active.placeholders, active: true };
    return { catalog: readPackPlaceholders(promptsDirOf(url)), active: false };
  };
  return [
    {
      method: "GET",
      pattern: "/api/prompts/placeholders",
      handler: ({ url }) => ({
        entries: placeholdersCatalog(catalogOf(url).catalog),
        // source 封闭枚举清单（前端编辑器下拉候选）
        sources: [...PLACEHOLDER_SOURCES],
      }),
    },
    {
      method: "PUT",
      pattern: "/api/prompts/placeholders",
      handler: async ({ req, url }) => {
        const body = parseJsonBody(await readBody(req));
        const catalog = validate(() => parsePlaceholders(body));
        if (deps.coordinator.activePrompts() !== null) {
          // 档内模式：机检上下文 = 档内 `_sys`（模板 + 注册表）
          const world = deps.coordinator.activeWorld();
          if (world === null) throw new ApiError(500, "INTERNAL_ERROR", "会话状态不可用");
          const sys = parseWorldSys(world._sys);
          validate(() => validatePlaceholders(catalog, { template: sys.template, registry: sys.tagRegistry }));
          // 走直编命令（串行队列 + CommitExecutor；域校验失败 → 400）
          try {
            await deps.coordinator.applyDirectEdit({ placeholders: catalog });
          } catch (err) {
            const apiErr = toApiError(err);
            throw apiErr.status === 500 ? new ApiError(400, "VALIDATION_ERROR", apiErr.message) : apiErr;
          }
          // 档内副本每轮激活现读，保存后下一轮对话即生效
          return { note: "已保存，下一轮对话生效", revision: deps.coordinator.currentRevision };
        }
        // 包基线模式：机检上下文 = 该包变量体系文件；写包基线，新会话生效
        const worldDir = resolveWorldDir(
          deps.dirs.assetsDir,
          url.searchParams.get("set") ?? undefined,
          DEFAULT_WORLD_SET,
        );
        validate(() => validatePlaceholders(catalog, packValidationDeps(worldDir)));
        writePlaceholdersFile(packPromptsDir(worldDir), JSON.stringify(catalog, null, 2) + "\n");
        deps.coordinator.markStale();
        return { note: "已保存，新会话生效" };
      },
    },
    {
      method: "GET",
      pattern: "/api/prompts",
      handler: ({ url }) => {
        const active = deps.coordinator.activePrompts();
        if (active !== null) return PROMPT_TEMPLATE_IDS.map((id) => active.templates[id]);
        return readPromptTemplates(promptsDirOf(url));
      },
    },
    {
      method: "PUT",
      pattern: "/api/prompts/:agent",
      handler: async ({ req, url, params }) => {
        const agent = params.agent!;
        if (!isPromptTemplateId(agent)) {
          throw new ApiError(400, "VALIDATION_ERROR", `未知模板: ${agent}（只允许 ${PROMPT_TEMPLATE_IDS.join(" / ")}）`);
        }
        const body = parseJsonBody(await readBody(req));
        const { catalog, active } = catalogOf(url);
        const template = validate(() => validatePromptPayload(agent, body, catalog));
        if (active) {
          // 档内模式：走直编命令（串行队列 + CommitExecutor；域校验失败 → 400）
          try {
            await deps.coordinator.applyDirectEdit({ prompts: template });
          } catch (err) {
            const apiErr = toApiError(err);
            throw apiErr.status === 500 ? new ApiError(400, "VALIDATION_ERROR", apiErr.message) : apiErr;
          }
          // 档内副本每轮激活现读，保存后下一轮对话即生效
          return { note: "已保存，下一轮对话生效", revision: deps.coordinator.currentRevision };
        }
        writePromptFile(promptsDirOf(url), agent, JSON.stringify(template, null, 2) + "\n");
        return { note: "已保存，新会话生效" };
      },
    },
  ];
}
