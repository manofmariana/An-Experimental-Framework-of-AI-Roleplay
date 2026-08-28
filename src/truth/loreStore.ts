/**
 * 档内 lore 副本（Generation 内 lores.json = {entries, changelog}）。
 * 新会话创建时把世界包 lores.json 拷入存档，档内增删改只动副本（防污染原始 data/）。
 * 条目 = {id, content, enabled?} 全末端外壳（TAG 挂载全部落在 content 末端）。
 * changelog 逐条记录严格可逆变更（add/delete/update 带 before/after + seq 锚）；
 * rollbackLore 按 changelog 从当前逐轮反向回滚到指定 seq。
 * 纯内存容器（无 IO）：落盘由 GenerationRepository 在步边界整代提交。
 */
import { z } from "zod";
import { LoreEntrySchema, type LoreEntry } from "../types.js";
import { Lorebook } from "./lorebook.js";

export const LoreChangeSchema = z.object({
  /** 变更发生的 seq 锚 */
  seq: z.number(),
  op: z.enum(["add", "delete", "update"]),
  /** 变更前条目（add 时为 null） */
  before: LoreEntrySchema.nullable(),
  /** 变更后条目（delete 时为 null） */
  after: LoreEntrySchema.nullable(),
  /** update/delete 前的数组位置；可选以兼容既有 changelog。 */
  before_index: z.number().int().nonnegative().optional(),
});
export type LoreChange = z.infer<typeof LoreChangeSchema>;

/** lores.json 文件 codec（schema_version 单点化后本文件不再盖章）。 */
export const LoresFileSchema = z.object({
  entries: z.array(LoreEntrySchema),
  changelog: z.array(LoreChangeSchema),
});
export type LoresFile = z.infer<typeof LoresFileSchema>;

/** 对条目集应用一次变更（纯函数），update 保留原位置、add 追加。 */
function apply(entries: LoreEntry[], change: LoreChange): LoreEntry[] {
  const id = (change.after ?? change.before)!.id.value;
  const index = entries.findIndex((entry) => entry.id.value === id);
  if (change.after === null) return entries.filter((entry) => entry.id.value !== id);
  if (index < 0) return [...entries, change.after];
  const next = [...entries];
  next[index] = change.after;
  return next;
}

/** 反向撤销一次变更（纯函数）：优先按 before_index 恢复原位置。 */
function revert(entries: LoreEntry[], change: LoreChange): LoreEntry[] {
  const id = (change.before ?? change.after)!.id.value;
  const rest = entries.filter((entry) => entry.id.value !== id);
  if (change.before === null) return rest;
  const index = change.before_index ?? rest.length;
  const next = [...rest];
  next.splice(Math.min(index, next.length), 0, change.before);
  return next;
}

/**
 * 回溯（纯函数）：按 changelog 从当前逐轮反向回滚到 targetSeq
 * （撤销所有 seq > target 的变更，changelog 同步截断）。
 */
export function rollbackLore(file: LoresFile, targetSeq: number): LoresFile {
  let entries = [...file.entries];
  const remaining: LoreChange[] = [];
  const toRevert: LoreChange[] = [];
  for (const c of file.changelog) {
    if (c.seq > targetSeq) toRevert.push(c);
    else remaining.push(c);
  }
  for (const c of [...toRevert].reverse()) entries = revert(entries, c);
  return { entries, changelog: remaining };
}

export class LoreStore {
  private data: LoresFile;

  constructor(data: LoresFile) {
    this.data = JSON.parse(JSON.stringify(data)) as LoresFile;
  }

  /** 新会话：把世界包条目拷入存档（此后只动副本）。 */
  static initFrom(entries: LoreEntry[]): LoreStore {
    return new LoreStore({ entries, changelog: [] });
  }

  /** 整代提交的写盘数据源（lores.json 信封）。 */
  saveData(): LoresFile {
    return this.data;
  }

  /** 数据整体替换（错误再同步用：对象身份保持，内容回到指定 Generation）。 */
  restoreData(data: LoresFile): void {
    this.data = JSON.parse(JSON.stringify(data)) as LoresFile;
  }

  /** 当前条目集（内存视图，查询沿用 Lorebook 的确定性规则）。 */
  book(): Lorebook {
    return new Lorebook(this.data.entries);
  }

  /** 档内增删改（严格可逆：记录 before/after、原位置与 seq 锚）。 */
  applyChange(change: LoreChange): void {
    const parsed = LoreChangeSchema.parse(change);
    const beforeIndex = parsed.before === null
      ? undefined
      : this.data.entries.findIndex((entry) => entry.id.value === parsed.before!.id.value);
    const recorded: LoreChange = beforeIndex === undefined || beforeIndex < 0
      ? parsed
      : { ...parsed, before_index: beforeIndex };
    this.data = {
      entries: apply(this.data.entries, recorded),
      changelog: [...this.data.changelog, recorded],
    };
  }

  /** 回溯到指定 seq。 */
  rollbackToSeq(targetSeq: number): void {
    this.data = rollbackLore(this.data, targetSeq);
  }
}
