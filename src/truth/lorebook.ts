import fs from "node:fs";
import { z } from "zod";
import { evaluateTagFilter, type ReaderScope } from "../tags/evaluate.js";
import type { TagRegistry } from "../tags/registry.js";
import { LoreEntrySchema, type LoreEntry } from "../types.js";

const LorebookFileSchema = z.array(LoreEntrySchema);

/**
 * Lorebook（静态条目库）。
 * 激活制：GM 裁决包以 ID 引用，正文按 ID 取内容注入。
 */
export class Lorebook {
  private byId: Map<string, LoreEntry>;

  constructor(entries: LoreEntry[]) {
    this.byId = new Map();
    for (const entry of entries) {
      if (this.byId.has(entry.id)) {
        throw new Error(`lorebook 条目 ID 重复: ${entry.id}`);
      }
      this.byId.set(entry.id, entry);
    }
  }

  static load(filePath: string): Lorebook {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return new Lorebook(LorebookFileSchema.parse(raw));
  }

  /**
   * 按 ID 取条目。铁律：返回顺序按 ID 字典序排序（不按传入顺序/分数），
   * 保证注入正文的内容是缓存稳定的确定性序列。
   */
  getByIds(ids: string[]): LoreEntry[] {
    const sorted = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    const out: LoreEntry[] = [];
    for (const id of sorted) {
      const entry = this.byId.get(id);
      if (!entry) throw new Error(`lorebook 条目不存在: ${id}`);
      out.push(entry);
    }
    return out;
  }

  /**
   * 按读者求值取条目（TAG 过滤）：逐条目 evaluateTagFilter，放行即收录；
   * 无挂载条目 = 恒通过（广播语义）。返回按 ID 排序（铁律：列表按稳定 ID 排序）。
   */
  getByTags(reader: ReaderScope, registry: TagRegistry): LoreEntry[] {
    return this.all().filter(
      (entry) => evaluateTagFilter({ content: entry, tags: entry.tags }, reader, registry).status === "pass",
    );
  }

  /** 全部条目（按 ID 排序），供 GM 提示词列出可选 ID。 */
  all(): LoreEntry[] {
    return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** 渲染一组条目为注入文本（确定性）。 */
  static render(entries: LoreEntry[]): string {
    return entries.map((e) => `[${e.id}] ${e.content}`).join("\n");
  }
}
