/**
 * 档内提示词副本（存档 Generation 内 prompts.json = {templates, placeholders}）。
 * 新会话把世界包 prompts/ 四份模板 + placeholders.json 占位符目录拷入存档，此后只动档内
 * 副本（防污染原始 data/）；templates 键 = 对象×功能矩阵扁平键（{object}.{function}，
 * 封闭集由 PROMPT_MATRIX 派生）必须齐备且无多键，模板 id 与键名一致；placeholders =
 * 全对象共享的声明式占位符目录（缺键拒装，分支记号集随 codec 规范化）。
 * activation 每轮激活从本 Store 取当轮模板与目录——编辑通道
 * 更新后下一轮激活自然读到新值。纯内存容器（无 IO）：落盘由 GenerationRepository 在步
 * 边界整代提交。
 */
import { z } from "zod";
import {
  normalizeBranches,
  parsePlaceholders,
  PlaceholderCatalogSchema,
  type PlaceholderCatalog,
} from "../compile/placeholders.js";
import { PromptTemplateSchema, type PromptTemplate } from "../compile/template.js";

/**
 * 对象×功能提示词矩阵（唯一出处）：对象轴 = activation 种类；功能轴 = 每对象封闭功能集。
 * 值 = 模板键（{object}.{function}），同名亦为世界包模板文件名主体（{object}.{function}.prompt.json）。
 */
export const PROMPT_MATRIX = {
  character: { decision: "character.decision" },
  gm: { adjudication: "gm.adjudication", incident: "gm.incident" },
  prose: { render: "prose.render" },
} as const;

/** 矩阵派生的模板键封闭集（顺序稳定：character.decision / gm.adjudication / gm.incident / prose.render）。 */
export const PROMPT_TEMPLATE_IDS = [
  PROMPT_MATRIX.character.decision,
  PROMPT_MATRIX.gm.adjudication,
  PROMPT_MATRIX.gm.incident,
  PROMPT_MATRIX.prose.render,
] as const;
export type PromptTemplateId = (typeof PROMPT_TEMPLATE_IDS)[number];

export function isPromptTemplateId(id: string): id is PromptTemplateId {
  return (PROMPT_TEMPLATE_IDS as readonly string[]).includes(id);
}

/** 矩阵只读视图（GET /api/prompts 应答用：对象 → 功能名列表；结构由 PROMPT_MATRIX 派生，服务端单一出处）。 */
export const PROMPT_MATRIX_VIEW: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(PROMPT_MATRIX).map(([object, fns]) => [object, Object.keys(fns)]),
);

export const PromptsFileSchema = z
  .object({
    templates: z
      .object({
        "character.decision": PromptTemplateSchema,
        "gm.adjudication": PromptTemplateSchema,
        "gm.incident": PromptTemplateSchema,
        "prose.render": PromptTemplateSchema,
      })
      .strict()
      .superRefine((templates, ctx) => {
        for (const id of PROMPT_TEMPLATE_IDS) {
          if (templates[id].id !== id) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `模板 id（${templates[id].id}）与键名（${id}）不一致`,
            });
          }
        }
      }),
    placeholders: PlaceholderCatalogSchema.transform((catalog) => normalizeBranches(catalog)),
  })
  .strict();
export type PromptsFile = z.infer<typeof PromptsFileSchema>;

export class PromptsStore {
  private data: PromptsFile;

  constructor(data: PromptsFile) {
    this.data = JSON.parse(JSON.stringify(data)) as PromptsFile;
  }

  /** 新会话：把世界包矩阵全量模板 + 占位符目录拷入存档（此后只动副本）。 */
  static initFrom(templates: readonly PromptTemplate[], placeholders: unknown): PromptsStore {
    const record = Object.fromEntries(templates.map((template) => [template.id, template]));
    return new PromptsStore(
      PromptsFileSchema.parse({ templates: record, placeholders }),
    );
  }

  /** 整代提交的写盘数据源（prompts.json 信封）。 */
  saveData(): PromptsFile {
    return this.data;
  }

  /** 数据整体替换（错误再同步用：对象身份保持，内容回到指定 Generation）。 */
  restoreData(data: PromptsFile): void {
    this.data = JSON.parse(JSON.stringify(data)) as PromptsFile;
  }

  /** 按 id 取当轮模板（activation 每轮激活读取点）。 */
  template(id: PromptTemplateId): PromptTemplate {
    return this.data.templates[id];
  }

  /** 占位符目录（activation 渲染与模板校验键集的读取点）。 */
  placeholders(): PlaceholderCatalog {
    return this.data.placeholders;
  }

  /** 整体替换某一份模板（编辑通道写接口；id 必须命中矩阵封闭键集）。 */
  replaceTemplate(raw: unknown): void {
    const template = PromptTemplateSchema.parse(raw);
    if (!isPromptTemplateId(template.id)) {
      throw new Error(`未知模板 id: ${template.id}（只允许 ${PROMPT_TEMPLATE_IDS.join(" / ")}）`);
    }
    this.data = {
      templates: { ...this.data.templates, [template.id]: template },
      placeholders: this.data.placeholders,
    };
  }

  /** 整体替换占位符目录（编辑通道写接口；zod 形状 + 分支规范化同装配口径）。 */
  replacePlaceholders(raw: unknown): void {
    this.data = {
      templates: this.data.templates,
      placeholders: parsePlaceholders(raw),
    };
  }
}
