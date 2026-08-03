/**
 * 编译器（M1 重构后）= **纯渲染器**：模板 + 占位符注册表 + 注入上下文 → ChatMessage[]。
 *
 * 收窄决定（覆盖早期缓存等级设计）：
 *  - 不做 stable/append/free 通道等级，compiler 不做任何逐字节/append-only 断言；
 *  - 缓存友好是**模板编辑约定**（动态内容放尾部模块），由改模板的人自控，不再强制；
 *  - 时间戳/轮次禁令一并取消——时间、地点等信息本身就经占位符注入。
 *
 * 渲染规则：按模块顺序每模块渲染为一条消息（带模块的 role）；
 * 渲染后 content 为空的模块整条丢弃。未知占位符在模板加载时已拦截（见 template.ts）。
 */
import type { ChatMessage } from "../llm/chatPort.js";
import type { PromptTemplate } from "./template.js";

/** 占位符 provider：从注入上下文（事件、工作集、正文、状态快照等）产出文本。 */
export interface PlaceholderProvider<C> {
  /** 给模板编写者的说明（Web 编辑器占位符目录用） */
  description: string;
  provide(ctx: C): string;
}

/**
 * 占位符注册表（每 agent 一份）：key → provider。
 * 唯一出口——新占位符 = 在此注册新 provider（未来接快照类占位符同此路径）。
 */
export type PlaceholderRegistry<C> = Record<string, PlaceholderProvider<C>>;

/** 导出注册表的占位符目录（API /api/prompts/placeholders 用）。 */
export function placeholderCatalog(registry: PlaceholderRegistry<unknown>): {
  key: string;
  description: string;
}[] {
  return Object.entries(registry).map(([key, p]) => ({ key, description: p.description }));
}

/** 渲染模板为消息数组（每模块一条；空模块丢弃）。 */
export function compilePrompt<C>(
  template: PromptTemplate,
  registry: PlaceholderRegistry<C>,
  ctx: C,
): ChatMessage[] {
  // 只求模板实际引用的值；未引用 provider 不应产生计算或副作用。
  const referenced = new Set<string>();
  for (const mod of template.modules) {
    for (const match of mod.content.matchAll(/\{\{(\w+)\}\}/g)) referenced.add(match[1]!);
  }
  const values: Record<string, string> = {};
  for (const key of referenced) {
    const provider = registry[key];
    if (provider !== undefined) values[key] = provider.provide(ctx);
  }

  const messages: ChatMessage[] = [];
  for (const mod of template.modules) {
    const content = mod.content.replace(
      /\{\{(\w+)\}\}/g,
      (match: string, name: string) => values[name] ?? match,
    );
    if (content.trim().length === 0) continue; // 空模块整条丢弃
    messages.push({ role: mod.role, content });
  }
  return messages;
}
