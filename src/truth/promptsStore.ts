/**
 * 档内提示词副本（存档 Generation 内 prompts.json = {templates, placeholders}）。
 * 新会话把世界包 prompts/ 四份模板 + placeholders.json 占位符目录拷入存档，此后只动档内
 * 副本（防污染原始 data/）；templates 四键（character/gm/prose/gm-incident）必须齐备且无
 * 多键，模板 id 与键名一致；placeholders = 全对象共享的声明式占位符目录（缺键拒装，
 * 分支记号集随 codec 规范化）。activation 每轮激活从本 Store 取当轮模板与目录——编辑通道
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

/** 四份模板的封闭键集（三 activation + gm-incident 突发变体）。 */
export const PROMPT_TEMPLATE_IDS = ["character", "gm", "prose", "gm-incident"] as const;
export type PromptTemplateId = (typeof PROMPT_TEMPLATE_IDS)[number];

export function isPromptTemplateId(id: string): id is PromptTemplateId {
  return (PROMPT_TEMPLATE_IDS as readonly string[]).includes(id);
}

export const PromptsFileSchema = z
  .object({
    templates: z
      .object({
        character: PromptTemplateSchema,
        gm: PromptTemplateSchema,
        prose: PromptTemplateSchema,
        "gm-incident": PromptTemplateSchema,
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

  /** 新会话：把世界包四份模板 + 占位符目录拷入存档（此后只动副本）。 */
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

  /** 整体替换某一份模板（编辑通道写接口；id 必须命中四键之一）。 */
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
