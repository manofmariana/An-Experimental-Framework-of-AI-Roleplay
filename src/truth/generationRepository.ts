/**
 * Generation 布局与单一写盘屏障（五根同构存档）。
 *
 * 布局：
 *   save/{runId}/
 *     CURRENT                     文本文件，内容 = 6 位零填充 revision（如 "000007"）
 *     generations/{revision}/     world.json characters.json events.json lores.json archive.json sys.json prompts.json
 *     meta.json / cache-stats.jsonl / llm-recent/ / save-meta.json   旁路产物，留 run 根，不进 Generation
 *
 * 五根 = 四大内容根（events/lores/characters/world，末端外壳同构）+ sys 第五根
 * （结构三件套/程序计数键/pipeline）。schema_version 只在 sys.json 盖章——版本闸单点化，
 * 其余文件 codec 不携版本字面量。
 *
 * 磁盘写入从"每次变异立即写单文件"收敛为"步边界一次写整 Generation"：
 * 各 Store 是纯内存容器（saveData() 供收集），本类是唯一写盘出口。
 *
 * 原子提交流程：
 *   ① baseRevision 闸：≠ 当前 revision → RevisionConflictError（乐观并发）；
 *   ② 七文件信封序列化写入 generations/.tmp-{next}/；
 *   ③ 重读临时目录七文件并过 codec + validateSaveSet（跨文件不变量；可构造注入替换）；
 *   ④ renameSync(.tmp-{next} → {next}) 确认正式 Generation；
 *   ⑤ 写 CURRENT.tmp → renameSync 覆盖 CURRENT（Node Windows rename 有替换语义）——
 *      外部只能观察到提交前或提交后的完整状态；
 *   ⑥ 清理：保留 current+previous，更旧 best-effort 删除，失败只 console.warn——
 *      清理失败不得把已成功切换的事务报告为失败。构造函数清理上次崩溃留下的 .tmp-* 残留。
 *
 * 灾备：loadCurrent 对 CURRENT 指向代的 corrupt/incomplete/invariant 回退上一代（recoveredFrom 标记 +
 * console.warn 报告）；上一代也坏则抛原始错误。loadPrevious() 公开为显式灾备读取。
 *
 * 错误一律为类型化 SaveLoadError（validation/errors.ts，分类口径见其文档）。
 * 旧平铺档拒载：run 根存在平铺真相文件之一但无 CURRENT → version（不迁移，请新建会话）。
 * runDir 由调用方注入（禁 import src/config.ts，truth 层依赖纪律）；
 * io 端口可注入 fake（故障注入测试用），默认 node fs。
 */
import fs from "node:fs";
import path from "node:path";
import type { Event } from "../types.js";
import { ArchiveFileSchema, type ArchiveEntry } from "./archive.js";
import { CharactersFileSchema, type CharacterState } from "./charactersStore.js";
import { EventsFileSchema } from "./events.js";
import { LoresFileSchema, type LoresFile } from "./loreStore.js";
import { PromptsFileSchema, type PromptsFile } from "./promptsStore.js";
import { INCOMPATIBLE_SAVE_MESSAGE, SAVE_SCHEMA_VERSION } from "./saveSchema.js";
import { deepFreeze } from "./snapshot.js";
import { SysFileSchema, type SysFile } from "./sysStore.js";
import { RevisionConflictError, SaveLoadError } from "./validation/errors.js";
import { validateSaveSet } from "./validation/saveSet.js";
import { WorldFileSchema, type StateTree } from "./worldStore.js";

/** 七真相文件名（Generation 目录内）：四大内容根 + sys 第五根 + 独立的 archive/prompts。 */
export const TRUTH_FILES = ["world.json", "characters.json", "events.json", "lores.json", "archive.json", "sys.json", "prompts.json"] as const;

const CURRENT_FILE = "CURRENT";
const GENERATIONS_DIR = "generations";
const REVISION_DIGITS = 6;
const TMP_PREFIX = ".tmp-";

/** 零填充 6 位十进制 revision（字典序 = 数值序）。 */
export function formatRevision(revision: number): string {
  return String(revision).padStart(REVISION_DIGITS, "0");
}

/** 一代存档的完整数据（七文件载荷；sys 信封含全档唯一的 schema_version 盖章）。 */
export interface SaveSet {
  /** world 变量树（纯内容根，含 time 系统分支实例） */
  world: StateTree;
  /** sys 第五根（结构三件套 + 程序计数键 + pipeline；schema_version 盖章在本信封） */
  sys: SysFile;
  characters: Record<string, CharacterState>;
  events: Event[];
  archive: ArchiveEntry[];
  lores: LoresFile;
  prompts: PromptsFile;
}

export interface LoadedGeneration {
  revision: number;
  save: SaveSet;
  /** 灾备回退标记：CURRENT 指向的 revision 已坏，本对象实为上一代（仅 loadCurrent 回退时出现）。 */
  recoveredFrom?: number;
}

/** 文件系统端口（故障注入测试用；默认 node fs）。方法集合 = 本类实际用到的子集。 */
export type RepoIo = Pick<
  typeof fs,
  "writeFileSync" | "renameSync" | "mkdirSync" | "rmSync" | "readFileSync" | "existsSync" | "readdirSync"
>;

/** validateSaveSet 钩子（跨文件不变量校验；抛错即否决提交，默认 = validation/saveSet.ts 的 validateSaveSet）。 */
export type SaveSetValidator = (save: SaveSet) => void;

export interface RepoOptions {
  io?: RepoIo;
  validateSaveSet?: SaveSetValidator;
}

/** Node 系统错误的 code（ENOENT/EACCES/EPERM/ENOSPC/EBUSY …）。 */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** 系统错误的可读详情（带 code 前缀，io 类错误消息用）。 */
function sysDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = codeOf(error);
  return code === undefined ? message : `${code}: ${message}`;
}

export class GenerationRepository {
  private readonly io: RepoIo;
  private readonly validateSaveSet: SaveSetValidator;

  constructor(private readonly runDir: string, options: RepoOptions = {}) {
    this.io = options.io ?? fs;
    this.validateSaveSet = options.validateSaveSet ?? validateSaveSet;
    this.cleanupResidue();
  }

  private currentFile(): string {
    return path.join(this.runDir, CURRENT_FILE);
  }

  private generationDir(revision: number): string {
    return path.join(this.runDir, GENERATIONS_DIR, formatRevision(revision));
  }

  /** CURRENT 存在且可解析（空目录 = false；旧平铺布局判据见 assertNoLegacyFlat）。 */
  exists(): boolean {
    if (!this.io.existsSync(this.currentFile())) return false;
    try {
      this.currentRevision();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 当前 revision。run 目录不存在 → not_found；CURRENT 缺失/不可解析 → incomplete
   * （commit 同样走本方法读当前 revision：CURRENT 坏了不会被静默覆盖，而是明确报错）。
   */
  currentRevision(): number {
    let raw: string;
    try {
      raw = this.io.readFileSync(this.currentFile(), "utf8").trim();
    } catch (error) {
      if (codeOf(error) === "ENOENT") {
        if (!this.io.existsSync(this.runDir)) {
          throw new SaveLoadError("not_found", `存档不存在：${this.runDir}`, { cause: error });
        }
        throw new SaveLoadError("incomplete", `存档不完整：缺 CURRENT 指针文件（${this.currentFile()}）`, { cause: error });
      }
      throw new SaveLoadError("io", `读取 CURRENT 失败（${this.currentFile()}）：${sysDetail(error)}`, { cause: error });
    }
    if (!/^\d+$/.test(raw)) {
      throw new SaveLoadError("incomplete", `存档不完整：CURRENT 内容不可解析: ${JSON.stringify(raw)}`);
    }
    return Number(raw);
  }

  /** 旧平铺档判据：run 根存在平铺真相文件之一但无 CURRENT → version（不迁移）。 */
  assertNoLegacyFlat(): void {
    if (this.io.existsSync(this.currentFile())) return;
    for (const file of TRUTH_FILES) {
      if (this.io.existsSync(path.join(this.runDir, file))) {
        throw new SaveLoadError("version", INCOMPATIBLE_SAVE_MESSAGE);
      }
    }
  }

  /**
   * 读 CURRENT 指向的 Generation。灾备回退：该代 corrupt/incomplete/invariant 时尝试上一代，
   * 成功则返回带 recoveredFrom（坏掉的 revision 号）并 console.warn 报告；
   * 上一代也不可用则抛原始错误。version/not_found/io 不回退（回退无意义或掩盖系统问题）。
   */
  loadCurrent(): LoadedGeneration {
    const revision = this.currentRevision();
    try {
      return this.loadGeneration(revision);
    } catch (error) {
      if (
        error instanceof SaveLoadError &&
        (error.kind === "corrupt" || error.kind === "incomplete" || error.kind === "invariant")
      ) {
        try {
          const previous = this.loadGeneration(revision - 1);
          const label = error.kind === "corrupt" ? "已损坏" : error.kind === "incomplete" ? "不完整" : "不变量破损";
          console.warn(
            `[存档灾备] Generation ${formatRevision(revision)} ${label}，` +
              `已回退上一代 ${formatRevision(previous.revision)} 继续（坏代保留待查）`,
          );
          return { ...previous, recoveredFrom: revision };
        } catch {
          // 上一代也不可用：抛原始错误
        }
      }
      throw error;
    }
  }

  /** 显式灾备读取：读 CURRENT 前一代 Generation（没有上一代 → not_found）。 */
  loadPrevious(): LoadedGeneration {
    return this.loadGeneration(this.currentRevision() - 1);
  }

  /** 读指定 Generation：codec（第一级）+ validateSaveSet（第二级），加载与提交同一校验口径。 */
  private loadGeneration(revision: number): LoadedGeneration {
    const dir = this.generationDir(revision);
    if (!this.io.existsSync(dir)) {
      throw new SaveLoadError("not_found", `Generation 不存在：${dir}`);
    }
    const save = this.readSaveSet(dir);
    this.validateSaveSet(save);
    // 恒冻结（不可变 Snapshot）：调用方（GameSession 各 Store 构造）深拷贝后使用，
    // 此处冻结让"直接改 loadCurrent 结果"的越界写入立刻抛 TypeError
    deepFreeze(save);
    return { revision, save };
  }

  /**
   * 原子提交（流程见文件头注释）：临时目录写七文件 → 重读校验 → rename 确认 →
   * CURRENT.tmp → rename 切换 → best-effort 清理更旧代。返回新 revision。
   */
  commit(baseRevision: number, save: SaveSet): number {
    // ① 乐观并发闸（CURRENT 存在但不可解析时 currentRevision 抛 incomplete——不静默覆盖）
    const current = this.io.existsSync(this.currentFile()) ? this.currentRevision() : 0;
    if (baseRevision !== current) throw new RevisionConflictError(baseRevision, current);
    const next = current + 1;
    const tmpDir = path.join(this.runDir, GENERATIONS_DIR, `${TMP_PREFIX}${formatRevision(next)}`);
    try {
      // ② 七文件信封序列化写入临时目录（目标 Generation 此刻对外不可见）
      this.io.mkdirSync(tmpDir, { recursive: true });
      this.writeEnvelope(tmpDir, save);
      // ③ 重读临时目录七文件 + codec 校验 + validateSaveSet（两级校验同一口径）
      this.validateSaveSet(this.readSaveSet(tmpDir));
      // ④ 临时目录确认为正式 Generation
      this.io.renameSync(tmpDir, this.generationDir(next));
      // ⑤ 原子替换 CURRENT（先写旁文件再 rename 覆盖；此后外部才观察到新状态）
      const currentTmp = `${this.currentFile()}.tmp`;
      this.io.writeFileSync(currentTmp, formatRevision(next), "utf8");
      this.io.renameSync(currentTmp, this.currentFile());
    } catch (error) {
      if (error instanceof SaveLoadError || error instanceof RevisionConflictError) throw error;
      throw new SaveLoadError("io", `提交 Generation ${formatRevision(next)} 失败：${sysDetail(error)}`, { cause: error });
    }
    // ⑥ 清理：保留 current+previous，更旧 best-effort——失败只告警，已切换的事务仍算成功
    this.pruneGenerations(next);
    return next;
  }

  /** 保留 keepFrom 与 keepFrom-1，更旧 Generation best-effort 删除（失败只 console.warn）。 */
  private pruneGenerations(keepFrom: number): void {
    const root = path.join(this.runDir, GENERATIONS_DIR);
    let entries: string[];
    try {
      entries = this.io.readdirSync(root);
    } catch (error) {
      console.warn(`[存档清理] 无法枚举 ${root}：${sysDetail(error)}`);
      return;
    }
    for (const entry of entries) {
      if (!/^\d{6}$/.test(entry) || Number(entry) >= keepFrom - 1) continue;
      try {
        this.io.rmSync(path.join(root, entry), { recursive: true, force: true });
      } catch (error) {
        console.warn(`[存档清理] 删除旧 Generation ${entry} 失败（不影响已完成的提交）：${sysDetail(error)}`);
      }
    }
  }

  /** 上次进程崩溃的提交残留：临时 Generation 目录与未切换的 CURRENT.tmp（构造时清理）。 */
  private cleanupResidue(): void {
    const root = path.join(this.runDir, GENERATIONS_DIR);
    try {
      if (this.io.existsSync(root)) {
        for (const entry of this.io.readdirSync(root)) {
          if (!entry.startsWith(TMP_PREFIX)) continue;
          try {
            this.io.rmSync(path.join(root, entry), { recursive: true, force: true });
          } catch (error) {
            console.warn(`[存档清理] 临时 Generation 残留 ${entry} 删除失败：${sysDetail(error)}`);
          }
        }
      }
      const currentTmp = `${this.currentFile()}.tmp`;
      if (this.io.existsSync(currentTmp)) {
        try {
          this.io.rmSync(currentTmp, { force: true });
        } catch (error) {
          console.warn(`[存档清理] CURRENT.tmp 残留删除失败：${sysDetail(error)}`);
        }
      }
    } catch (error) {
      console.warn(`[存档清理] 枚举提交残留失败：${sysDetail(error)}`);
    }
  }

  private writeEnvelope(dir: string, save: SaveSet): void {
    const write = (file: string, data: unknown): void => {
      this.io.writeFileSync(path.join(dir, file), JSON.stringify(data, null, 2) + "\n", "utf8");
    };
    write("world.json", { world: save.world });
    write("characters.json", { characters: save.characters });
    write("events.json", { events: save.events });
    write("lores.json", save.lores);
    write("archive.json", { entries: save.archive });
    write("sys.json", save.sys);
    write("prompts.json", save.prompts);
  }

  /**
   * 逐文件读 + codec：缺文件 → incomplete；JSON 截断/结构校验失败 → corrupt。
   * 版本闸单点化：schema_version 只读 sys.json 一处（先于其余文件判定，literal 不符即
   * version；Generation 缺 sys.json = 旧版布局，同样报 version 而非 incomplete）。
   */
  private readSaveSet(dir: string): SaveSet {
    const read = <T>(file: string, parse: (raw: unknown) => T): T => {
      const filePath = path.join(dir, file);
      let text: string;
      try {
        text = this.io.readFileSync(filePath, "utf8");
      } catch (error) {
        if (codeOf(error) === "ENOENT") {
          throw new SaveLoadError("incomplete", `存档不完整：Generation 缺核心文件 ${file}（${filePath}）`, { cause: error });
        }
        throw new SaveLoadError("io", `读取存档文件失败（${filePath}）：${sysDetail(error)}`, { cause: error });
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (error) {
        throw new SaveLoadError("corrupt", `存档文件损坏：${file} JSON 不可解析（${filePath}）`, { cause: error });
      }
      try {
        return parse(raw);
      } catch (error) {
        if (error instanceof SaveLoadError) throw error;
        throw new SaveLoadError("corrupt", `存档文件损坏：${file} 结构校验失败（${filePath}）`, { cause: error });
      }
    };
    // 版本闸：sys.json 是全档唯一盖章点
    if (!this.io.existsSync(path.join(dir, "sys.json"))) {
      throw new SaveLoadError("version", INCOMPATIBLE_SAVE_MESSAGE);
    }
    const sys = read("sys.json", (raw) => {
      if (typeof raw !== "object" || raw === null || (raw as { schema_version?: unknown }).schema_version !== SAVE_SCHEMA_VERSION) {
        throw new SaveLoadError("version", INCOMPATIBLE_SAVE_MESSAGE);
      }
      return SysFileSchema.parse(raw);
    });
    const world = read("world.json", (raw) => WorldFileSchema.parse(raw));
    const characters = read("characters.json", (raw) => CharactersFileSchema.parse(raw));
    const events = read("events.json", (raw) => EventsFileSchema.parse(raw));
    const lores = read("lores.json", (raw) => LoresFileSchema.parse(raw));
    const archive = read("archive.json", (raw) => ArchiveFileSchema.parse(raw));
    const prompts = read("prompts.json", (raw) => PromptsFileSchema.parse(raw));
    return {
      world: world.world,
      sys,
      characters: characters.characters,
      events: events.events,
      archive: archive.entries,
      lores,
      prompts,
    };
  }
}
