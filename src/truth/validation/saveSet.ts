/**
 * validateSaveSet：两级校验的第二级。
 *
 * 第一级 = 各 File codec（单文件 JSON/版本/字段类型，readSaveSet 内逐文件过 schema）；
 * 本级 = 完整加载一个 Generation 后的跨文件不变量，失败抛 SaveLoadError("invariant")。
 *
 * 只校验"可提交态"（步边界的完整状态），不校验步中临时态：
 * GenerationRepository 在 commit 重读临时目录后与 loadCurrent/loadPrevious 加载时调用，
 * 与文件 codec 同一入口，保证任何外部可观察到的 Generation 都过同一套校验。
 *
 * v1 检查项全部提取自现状不变量；动作/规则/UI/schema 引用闭包校验待对应实体存在后再补。
 * 玩家模型不写死 C0：多个 isPlayer:true 合法（建档期恰一玩家检查是创建规则，
 * 留在 charactersStore.fromManifests，不是存档不变量）。
 *
 * 纯函数零 IO；依赖方向 = truth 内部（SaveSet 类型经 type-import，无运行时环）。
 */
import type { SaveSet } from "../generationRepository.js";
import { SaveLoadError } from "./errors.js";

/** 角色表键：C0 或 C+非零编号（去 @ 归一化后的落盘形态）。 */
const CID_KEY_PATTERN = /^C(?:0|[1-9]\d*)$/;
/** pipeline/archive 步 kind 的角色步前缀（character:{cid}）。 */
const CHARACTER_KIND_PREFIX = "character:";

function invariant(message: string): never {
  throw new SaveLoadError("invariant", `存档不变量不满足：${message}`);
}

/** ① pipeline：seq 非负整数；current 与 seq/archive 的对应关系。 */
function checkPipeline(save: SaveSet): void {
  const { pipeline, archive } = save;
  if (!Number.isInteger(pipeline.seq) || pipeline.seq < 0) {
    invariant(`pipeline.seq 必须为非负整数，实为 ${String(pipeline.seq)}`);
  }
  if (pipeline.current === null) {
    if (pipeline.seq !== 0) {
      invariant(`无进行中步骤（current=null）时 pipeline.seq 必须为 0，实为 ${pipeline.seq}`);
    }
    if (archive.length > 0) {
      invariant(`无进行中步骤（current=null）时 archive 必须为空，实有 ${archive.length} 条`);
    }
  } else if (pipeline.current.seq !== pipeline.seq) {
    invariant(`进行中步骤 seq（${pipeline.current.seq}）≠ pipeline.seq（${pipeline.seq}）`);
  }
}

/** ② archive：seq ≥1 整数、严格递增；current 非空时不得触及进行中步骤 seq。 */
function checkArchive(save: SaveSet): void {
  const { archive, pipeline } = save;
  let previous = 0;
  for (const entry of archive) {
    if (!Number.isInteger(entry.seq) || entry.seq < 1) {
      invariant(`archive 条目 seq 必须为 ≥1 整数，实为 ${String(entry.seq)}`);
    }
    if (entry.seq <= previous) {
      invariant(`archive 条目 seq 必须严格递增：${entry.seq} 出现在 ${previous} 之后`);
    }
    if (pipeline.current !== null && entry.seq > pipeline.seq - 1) {
      invariant(`archive 条目 seq（${entry.seq}）越界：不得 ≥ 进行中步骤 seq（${pipeline.seq}）`);
    }
    previous = entry.seq;
  }
}

/** ③ events：id 非空且全局唯一；seq ≥1 整数（回溯截断锚）。
 *  不设 ≤ pipeline.seq 上界：状态直编允许用户整体替换事件表（loop.ts applyDirectEdit），
 *  注入事件的 seq 由用户给定，可超过当前 pipeline.seq——这是合法可提交态，
 *  回溯按"seq ≤ target 保留"口径截断，不依赖该上界。 */
function checkEvents(save: SaveSet): void {
  const seen = new Set<string>();
  for (const event of save.events) {
    if (event.id === "") invariant("事件 id 不能为空");
    if (seen.has(event.id)) invariant(`事件 id 重复: ${event.id}`);
    seen.add(event.id);
    if (!Number.isInteger(event.seq) || event.seq < 1) {
      invariant(`事件 ${event.id} 的 seq 必须为 ≥1 整数，实为 ${String(event.seq)}`);
    }
  }
}

/** ④ 引用闭包：working_set 每条 cid 与 archive 角色步 cid 都必须存在于角色表。 */
function checkReferences(save: SaveSet): void {
  const known = new Set(Object.keys(save.characters));
  for (const entry of save.pipeline.working_set) {
    if (!known.has(entry.cid)) invariant(`working_set 引用未知角色: ${entry.cid}`);
  }
  for (const entry of save.archive) {
    if (!entry.kind.startsWith(CHARACTER_KIND_PREFIX)) continue;
    const cid = entry.kind.slice(CHARACTER_KIND_PREFIX.length);
    if (!known.has(cid)) invariant(`archive 角色步引用未知角色: ${cid}（${entry.kind}）`);
  }
}

/** ⑤ 角色表键形：C0 或 C+非零编号。多个 isPlayer:true 合法（玩家集合不写死 C0）。 */
function checkCharacters(save: SaveSet): void {
  for (const cid of Object.keys(save.characters)) {
    if (!CID_KEY_PATTERN.test(cid)) {
      invariant(`非法角色 CID 键: ${JSON.stringify(cid)}（必须匹配 C0 或 C+非零编号）`);
    }
  }
}

/** ⑥ lore：entries id 唯一；changelog seq 为整数（回滚锚）。 */
function checkLore(save: SaveSet): void {
  const seen = new Set<string>();
  for (const entry of save.lore.entries) {
    if (seen.has(entry.id)) invariant(`lore 条目 id 重复: ${entry.id}`);
    seen.add(entry.id);
  }
  for (const change of save.lore.changelog) {
    if (!Number.isInteger(change.seq)) {
      invariant(`lore changelog seq 必须为整数，实为 ${String(change.seq)}`);
    }
  }
}

/**
 * 整档语义校验（可提交态）。任一违规即抛 SaveLoadError("invariant")，消息带具体违规项；
 * 通过则返回 void。检查顺序 = 上列编号顺序（pipeline → archive → events → 引用 → 角色表 → lore）。
 */
export function validateSaveSet(save: SaveSet): void {
  checkPipeline(save);
  checkArchive(save);
  checkEvents(save);
  checkReferences(save);
  checkCharacters(save);
  checkLore(save);
}
