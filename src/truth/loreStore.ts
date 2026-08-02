/**
 * 档内 lore 副本（存档 v2 文件 2）：runs/{runId}/lore.json = {entries, changelog}。
 * 新会话创建时把世界 lorebook 拷入存档，档内增删改只动副本（防污染原始 data/）。
 * changelog 逐条记录严格可逆变更（add/delete/update 带 before/after + seq 锚）；
 * rollbackLore 按 changelog 从当前逐轮反向回滚到指定 seq。
 * GM/角色/正文的 lore 注入全部读档内副本。
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { runDir } from "../config.js";
import { LoreEntrySchema, type LoreEntry } from "../types.js";
import { Lorebook } from "./lorebook.js";
import { SAVE_SCHEMA_VERSION, incompatibleSave } from "./saveSchema.js";

export const LoreChangeSchema = z.object({
  /** 变更发生的 seq 锚 */
  seq: z.number(),
  op: z.enum(["add", "delete", "update"]),
  /** 变更前条目（add 时为 null） */
  before: LoreEntrySchema.nullable(),
  /** 变更后条目（delete 时为 null） */
  after: LoreEntrySchema.nullable(),
  /** update/delete 前的数组位置；可选以兼容既有 v3 changelog。 */
  before_index: z.number().int().nonnegative().optional(),
});
export type LoreChange = z.infer<typeof LoreChangeSchema>;

export const LoreFileSchema = z.object({
  schema_version: z.literal(SAVE_SCHEMA_VERSION),
  entries: z.array(LoreEntrySchema),
  changelog: z.array(LoreChangeSchema),
});
export type LoreFile = z.infer<typeof LoreFileSchema>;

/** 对条目集应用一次变更（纯函数），update 保留原位置、add 追加。 */
function apply(entries: LoreEntry[], change: LoreChange): LoreEntry[] {
  const id = (change.after ?? change.before)!.id;
  const index = entries.findIndex((entry) => entry.id === id);
  if (change.after === null) return entries.filter((entry) => entry.id !== id);
  if (index < 0) return [...entries, change.after];
  const next = [...entries];
  next[index] = change.after;
  return next;
}

/** 反向撤销一次变更（纯函数）：优先按 before_index 恢复原位置。 */
function revert(entries: LoreEntry[], change: LoreChange): LoreEntry[] {
  const id = (change.before ?? change.after)!.id;
  const rest = entries.filter((entry) => entry.id !== id);
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
export function rollbackLore(file: LoreFile, targetSeq: number): LoreFile {
  let entries = [...file.entries];
  const remaining: LoreChange[] = [];
  const toRevert: LoreChange[] = [];
  for (const c of file.changelog) {
    if (c.seq > targetSeq) toRevert.push(c);
    else remaining.push(c);
  }
  for (const c of [...toRevert].reverse()) entries = revert(entries, c);
  return { schema_version: SAVE_SCHEMA_VERSION, entries, changelog: remaining };
}

export class LoreStore {
  private file: string;
  private data: LoreFile;

  private constructor(file: string, data: LoreFile) {
    this.file = file;
    this.data = data;
  }

  /** 新会话：把世界 lorebook 拷入存档（此后只动副本）。 */
  static initFrom(runId: string, entries: LoreEntry[], baseDir?: string): LoreStore {
    const store = new LoreStore(path.join(baseDir ?? runDir(runId), "lore.json"), {
      schema_version: SAVE_SCHEMA_VERSION,
      entries,
      changelog: [],
    });
    store.persist();
    return store;
  }

  static load(runId: string, baseDir?: string): LoreStore {
    const file = path.join(baseDir ?? runDir(runId), "lore.json");
    try {
      const data = LoreFileSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
      return new LoreStore(file, data);
    } catch (error) {
      throw incompatibleSave(error);
    }
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
      : this.data.entries.findIndex((entry) => entry.id === parsed.before!.id);
    const recorded: LoreChange = beforeIndex === undefined || beforeIndex < 0
      ? parsed
      : { ...parsed, before_index: beforeIndex };
    this.data = {
      schema_version: SAVE_SCHEMA_VERSION,
      entries: apply(this.data.entries, recorded),
      changelog: [...this.data.changelog, recorded],
    };
    this.persist();
  }

  /** 回溯到指定 seq 并落盘（B 步接 UI）。 */
  rollbackToSeq(targetSeq: number): void {
    this.data = rollbackLore(this.data, targetSeq);
    this.persist();
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2) + "\n", "utf8");
  }
}
