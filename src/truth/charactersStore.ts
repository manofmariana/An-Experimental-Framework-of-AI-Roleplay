import { z } from "zod";
import type { CharacterManifest } from "../agents/character.js";
import { InitiativeSchema, LocationSchema, PLAYER_CID, type RelationUpdate } from "../types.js";
import { evalTagsPool } from "../vars/derived.js";
import type { ContainerDecl } from "../vars/template.js";
import { isTerminalInstance, normalizeInstance, TagMountSchema, type InstanceNode, type TerminalInstance } from "../vars/tree.js";
import { RelationsDataSchema, normalizeCid, type RelationEntry } from "./identity.js";
import { deleteByPath, getByPath, makeVarChange, setByPath, type VarChange } from "./varChanges.js";

export const CharacterStateSchema = z.object({
  /** 自身 CID（建角时物化；与 characters 记录键同值；系统只读，deltas/varWrite 拒写） */
  cid: z.string().min(1),
  name: z.string().min(1), gender: z.string(), age: z.string(), personality: z.string().min(1),
  reaction: z.number(), location: LocationSchema,
  timer: z.number().int().finite().nonnegative().nullable(),
  /** 组编号（0 = 单人组；组位置不落盘，由 simulator 按组内先攻最高者派生） */
  group: z.number(),
  /** 最近先攻结果 {value, group}；组编号变化即重置（归 0 除外，留待召回复用） */
  initiative: InitiativeSchema.nullable(),
  /** 频道变量：跨地点联系的"通话中"标识（同一邀请同一 id；null = 无） */
  channel: z.number().nullable(),
  /** 已行动位（行动顺序表：行动置位、周期完成/后台重置清零） */
  acted: z.boolean(),
  level: z.number(),
  /** 全知权重（0-6；恒定系统字段，不开放白名单写通道） */
  omniscience: z.number().int().min(0).max(6).default(0),
  isPlayer: z.boolean(), relations: RelationsDataSchema,
  /** 在场位（程序维护：组弹出前台/入组 = true，结算进后台/离组 = false；vars 源对 false 者的全部末端虚拟挂载 fappear 六级） */
  appearance: z.boolean().default(false),
  long_term_memory: z.array(z.string()),
  /** 系统末端内容侧 TAG 侧车（系统分支末端路径 → {name, level}[]；只经直编修改，装配/直编时校验） */
  systemTags: z.record(z.string(), z.array(TagMountSchema)).default({}),
  /** 变量树（按 character 模板 normalize 后的形态：末端 = {value, tags, formula?} 外壳） */
  vars: z.record(z.string(), z.unknown()),
});
export type CharacterState = z.infer<typeof CharacterStateSchema>;
/** characters.json 文件 codec（schema_version 单点化后本文件不再盖章）。 */
export const CharactersFileSchema = z.object({
  characters: z.record(z.string(), CharacterStateSchema),
});
export type CharactersFile = z.infer<typeof CharactersFileSchema>;

const CHARACTER_VAR_KEYS = ["timer", "group", "initiative", "channel", "acted", "level", "location"] as const;
export type CharacterVarPatch = Partial<Pick<CharacterState, (typeof CHARACTER_VAR_KEYS)[number]>>;

/**
 * manifest → 初始角色状态：vars 按 character 模板 normalize（简写展开）后
 * 物化 tags 池末端（union 初值，含 cid/location/channel 系统字段常驻项）。
 */
function fromManifest(manifest: CharacterManifest, startMinutes: number, characterDecl: ContainerDecl): CharacterState {
  const vars = normalizeInstance(manifest.vars, characterDecl, manifest.id, undefined, true) as Record<string, unknown>;
  vars["tags"] = {
    value: evalTagsPool(vars as InstanceNode, characterDecl, {
      cid: manifest.id,
      locationName: manifest.location.name,
      channel: manifest.channel,
    }),
    tags: [],
  } satisfies TerminalInstance;
  return {
    cid: manifest.id,
    name: manifest.name, gender: manifest.gender, age: manifest.age, personality: manifest.personality,
    reaction: manifest.reaction, location: manifest.location,
    timer: manifest.timer === null ? null : startMinutes + manifest.timer,
    group: manifest.group, initiative: manifest.initiative, channel: manifest.channel, acted: manifest.acted,
    level: manifest.level, omniscience: manifest.omniscience, isPlayer: manifest.isPlayer, relations: manifest.relations,
    appearance: false,
    long_term_memory: [...manifest.initial_memories], systemTags: {}, vars,
  };
}

/**
 * 角色状态容器（纯内存，无 IO）：每次变异只改内存；
 * 落盘由 GenerationRepository 在步边界整代提交（存档 v6，唯一写盘出口）。
 */
export class CharactersStore {
  private data: Record<string, CharacterState>;

  /**
   * @param characterDecl 档内 character 模板根（setVars 系统字段级联重算 tags 池用；
   *   缺省 = 不重算——存档安全网在提交边界兜底比对）。
   */
  constructor(characters: Record<string, CharacterState>, readonly characterDecl?: ContainerDecl | undefined) {
    this.data = JSON.parse(JSON.stringify(characters)) as Record<string, CharacterState>;
  }

  /** 纯工厂：manifests → 初始角色表（建档校验：CID 不重复、C0 与 isPlayer 双向一致）。 */
  static fromManifests(manifests: CharacterManifest[], startMinutes: number, characterDecl: ContainerDecl): CharactersStore {
    const characters: Record<string, CharacterState> = {};
    for (const manifest of manifests) {
      if (characters[manifest.id] !== undefined) throw new Error(`重复角色 CID: ${manifest.id}`);
      if (manifest.id === PLAYER_CID && !manifest.isPlayer) throw new Error(`${PLAYER_CID} 必须标记为玩家`);
      if (manifest.id !== PLAYER_CID && manifest.isPlayer) throw new Error(`只有 ${PLAYER_CID} 可以标记为玩家: ${manifest.id}`);
      characters[manifest.id] = fromManifest(manifest, startMinutes, characterDecl);
    }
    return new CharactersStore(characters, characterDecl);
  }

  /** 整代提交的写盘数据源（characters.json 的 characters 载荷）。 */
  saveData(): Record<string, CharacterState> {
    return this.data;
  }

  get(cid: string): CharacterState {
    const state = this.data[cid];
    if (!state) throw new Error(`未知角色 CID: ${cid}`);
    return state;
  }
  all(): Readonly<Record<string, CharacterState>> { return this.data; }
  renderLongTerm(cid: string): string { return this.get(cid).long_term_memory.join("\n"); }

  /** 角色有效 TAG 名集（vars.tags 池末端 value = string[] 纯名集合；池缺失/形状异常返回 []）。 */
  tagNames(cid: string): string[] {
    const pool: unknown = this.get(cid).vars["tags"];
    if (typeof pool !== "object" || pool === null || Array.isArray(pool)) return [];
    const value: unknown = (pool as Record<string, unknown>)["value"];
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string");
  }

  /**
   * 低层写入口（varWrite 专用：调用方负责校验；rest = CID 内点路径，
   * 值 = 该路径的整体新值）。产出真相根路径 VarChange（`characters.{cid}.…`）。
   */
  writeRaw(cid: string, rest: string, value: unknown): VarChange {
    const state = this.get(cid);
    const copy = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    const before = getByPath(copy, rest);
    setByPath(copy, rest, value);
    this.data = { ...this.data, [cid]: copy as CharacterState };
    return makeVarChange(`characters.${cid}.${rest}`, before, value);
  }

  updateRelations(cid: string, updates: RelationUpdate[]): VarChange[] {
    if (updates.length === 0) return [];
    const state = this.get(cid);
    const relations: RelationEntry[] = state.relations.map((entry) => ({ ...entry }));
    const changes: VarChange[] = [];
    for (const update of updates) {
      const target = normalizeCid(update.target);
      const index = relations.findIndex((entry) => entry.cid === target);
      const previous = index >= 0 ? relations[index] : undefined;
      const next: RelationEntry = { ...(previous ?? { cid: target }) };
      if (update.name !== undefined) next.name = update.name;
      if (update.impression !== undefined) next.impression = update.impression;
      const at = index >= 0 ? index : relations.length;
      if (index >= 0) relations[index] = next;
      else relations.push(next);
      changes.push(makeVarChange(`characters.${cid}.relations.${at}`, previous, next));
    }
    this.data = { ...this.data, [cid]: { ...state, relations } };
    return changes;
  }

  appendLongTerm(cid: string, text: string): VarChange {
    const state = this.get(cid); const before = [...state.long_term_memory]; const after = [...before, text];
    this.data = { ...this.data, [cid]: { ...state, long_term_memory: after } };
    return makeVarChange(`characters.${cid}.long_term_memory`, before, after);
  }

  /**
   * 系统字段白名单写通道（timer/group/initiative/channel/acted/level/location）。
   * location/channel 变更后重算该角色 tags 池（池经 union sys 项常驻这两项；cid 不可变，
   * 其余键不影响池）：值变才经 writeRaw 写回并追加池的 VarChange（回溯随批覆盖），
   * 不变不追加；未持有模板（characterDecl 缺省）时跳过重算，存档安全网在提交边界兜底。
   */
  setVars(cid: string, patch: CharacterVarPatch): VarChange[] {
    const state = this.get(cid); const changes: VarChange[] = []; const next = { ...state } as Record<string, unknown>;
    for (const key of CHARACTER_VAR_KEYS) {
      const value = patch[key]; if (value === undefined) continue;
      next[key] = JSON.parse(JSON.stringify(value)) as unknown;
      changes.push(makeVarChange(`characters.${cid}.${key}`, state[key], value));
    }
    if (changes.length > 0) {
      this.data = { ...this.data, [cid]: next as CharacterState };
      const poolChange = this.refreshTagsPool(cid, patch);
      if (poolChange !== undefined) changes.push(poolChange);
    }
    return changes;
  }

  /** location/channel 变化后重算 tags 池；值变才写回并产出 VarChange，否则 undefined。 */
  private refreshTagsPool(cid: string, patch: CharacterVarPatch): VarChange | undefined {
    if (this.characterDecl === undefined) return undefined;
    if (patch.location === undefined && patch.channel === undefined) return undefined;
    const state = this.get(cid);
    const nextPool = evalTagsPool(state.vars as InstanceNode, this.characterDecl, {
      cid: state.cid,
      locationName: state.location.name,
      channel: state.channel,
    });
    const shell: unknown = state.vars["tags"];
    const current = isTerminalInstance(shell) ? shell.value : undefined;
    if (JSON.stringify(current) === JSON.stringify(nextPool)) return undefined;
    const next: TerminalInstance = { value: nextPool, tags: isTerminalInstance(shell) ? shell.tags : [] };
    return this.writeRaw(cid, "vars.tags", next);
  }

  ensurePlayer(manifest: CharacterManifest, startMinutes: number, characterDecl: ContainerDecl): void {
    const existing = this.data[PLAYER_CID];
    if (existing !== undefined) {
      if (!existing.isPlayer) {
        this.data = { ...this.data, [PLAYER_CID]: { ...existing, isPlayer: true } };
      }
      return;
    }
    this.data = { ...this.data, [PLAYER_CID]: fromManifest({ ...manifest, id: PLAYER_CID, isPlayer: true }, startMinutes, characterDecl) };
  }

  revertChange(change: VarChange): void {
    const PREFIX = "characters.";
    if (!change.path.startsWith(PREFIX)) throw new Error(`charactersStore 无法反向的路径: ${change.path}`);
    const dotted = change.path.slice(PREFIX.length); // 剥真相根前缀后：CID.rest
    const dot = dotted.indexOf("."); if (dot <= 0) throw new Error(`charactersStore 无法反向的路径: ${change.path}`);
    const cid = dotted.slice(0, dot); const rest = dotted.slice(dot + 1); const state = this.data[cid];
    if (!state) throw new Error(`charactersStore 反向时找不到角色: ${cid}`);
    const copy = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    if (change.before_exists === false) deleteByPath(copy, rest, 1); else setByPath(copy, rest, change.before);
    this.data = { ...this.data, [cid]: copy as CharacterState };
  }

  /** 数据整体替换（错误再同步/直编用：先校验，对象身份保持）。 */
  restoreSnapshot(characters: Record<string, CharacterState>): void {
    this.data = z.record(z.string(), CharacterStateSchema).parse(JSON.parse(JSON.stringify(characters)));
  }
}
