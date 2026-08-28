import fs from "node:fs";
import { z } from "zod";
import { LoreEntrySchema, type LoreEntry } from "../types.js";

const LorebookFileSchema = z.array(LoreEntrySchema);

/**
 * Lorebook（静态条目库容器）：ID 唯一性校验 + 确定性排序。
 * TAG 过滤已移交引擎（投影全量供给 {lores[*].content} 路由 + 逐末端求值），本类不做事前求值。
 */
export class Lorebook {
  private byId: Map<string, LoreEntry>;

  constructor(entries: LoreEntry[]) {
    this.byId = new Map();
    for (const entry of entries) {
      if (this.byId.has(entry.id.value)) {
        throw new Error(`lorebook 条目 ID 重复: ${entry.id.value}`);
      }
      this.byId.set(entry.id.value, entry);
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

  /** 全部条目（按 ID 排序），供 GM 提示词列出可选 ID。 */
  all(): LoreEntry[] {
    return [...this.byId.values()].sort((a, b) => a.id.value.localeCompare(b.id.value));
  }
}
