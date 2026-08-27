import { z } from "zod";
import type { CharacterManifest } from "../agents/character.js";
import { InitiativeSchema, LocationSchema, PLAYER_CID, type RelationUpdate } from "../types.js";
import { evalTagsPool } from "../vars/derived.js";
import type { ContainerDecl } from "../vars/template.js";
import { normalizeInstance, TagMountSchema, type InstanceNode, type TerminalInstance } from "../vars/tree.js";
import { RelationsDataSchema, normalizeCid, type RelationEntry } from "./identity.js";
import { deleteByPath, getByPath, makeVarChange, setByPath, type VarChange } from "./varChanges.js";
import { SAVE_SCHEMA_VERSION } from "./saveSchema.js";

export const CharacterStateSchema = z.object({
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
export const CharactersFileSchema = z.object({
  schema_version: z.literal(SAVE_SCHEMA_VERSION),
  characters: z.record(z.string(), CharacterStateSchema),
});
export type CharactersFile = z.infer<typeof CharactersFileSchema>;

const CHARACTER_VAR_KEYS = ["timer", "group", "initiative", "channel", "acted", "level", "location"] as const;
export type CharacterVarPatch = Partial<Pick<CharacterState, (typeof CHARACTER_VAR_KEYS)[number]>>;

/**
 * manifest → 初始角色状态：vars 按 character 模板 normalize（简写展开）后
 * 物化 tags 池末端（union_attach 初值）。
 */
function fromManifest(manifest: CharacterManifest, startMinutes: number, characterDecl: ContainerDecl): CharacterState {
  const vars = normalizeInstance(manifest.vars, characterDecl, manifest.id) as Record<string, unknown>;
  vars["tags"] = { value: evalTagsPool(vars as InstanceNode, characterDecl), tags: [] } satisfies TerminalInstance;
  return {
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
  private data: CharactersFile;

  constructor(characters: Record<string, CharacterState>) {
    this.data = {
      schema_version: SAVE_SCHEMA_VERSION,
      characters: JSON.parse(JSON.stringify(characters)) as Record<string, CharacterState>,
    };
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
    return new CharactersStore(characters);
  }

  /** 整代提交的写盘数据源（characters.json 的 characters 载荷）。 */
  saveData(): Record<string, CharacterState> {
    return this.data.characters;
  }

  get(cid: string): CharacterState {
    const state = this.data.characters[cid];
    if (!state) throw new Error(`未知角色 CID: ${cid}`);
    return state;
  }
  all(): Readonly<Record<string, CharacterState>> { return this.data.characters; }
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
    this.data = { ...this.data, characters: { ...this.data.characters, [cid]: copy as CharacterState } };
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
    this.data = { ...this.data, characters: { ...this.data.characters, [cid]: { ...state, relations } } };
    return changes;
  }

  appendLongTerm(cid: string, text: string): VarChange {
    const state = this.get(cid); const before = [...state.long_term_memory]; const after = [...before, text];
    this.data = { ...this.data, characters: { ...this.data.characters, [cid]: { ...state, long_term_memory: after } } };
    return makeVarChange(`characters.${cid}.long_term_memory`, before, after);
  }

  setVars(cid: string, patch: CharacterVarPatch): VarChange[] {
    const state = this.get(cid); const changes: VarChange[] = []; const next = { ...state } as Record<string, unknown>;
    for (const key of CHARACTER_VAR_KEYS) {
      const value = patch[key]; if (value === undefined) continue;
      next[key] = JSON.parse(JSON.stringify(value)) as unknown;
      changes.push(makeVarChange(`characters.${cid}.${key}`, state[key], value));
    }
    if (changes.length > 0) {
      this.data = { ...this.data, characters: { ...this.data.characters, [cid]: next as CharacterState } };
    }
    return changes;
  }

  ensurePlayer(manifest: CharacterManifest, startMinutes: number, characterDecl: ContainerDecl): void {
    const existing = this.data.characters[PLAYER_CID];
    if (existing !== undefined) {
      if (!existing.isPlayer) {
        this.data = { ...this.data, characters: { ...this.data.characters, [PLAYER_CID]: { ...existing, isPlayer: true } } };
      }
      return;
    }
    this.data = { ...this.data, characters: { ...this.data.characters, [PLAYER_CID]: fromManifest({ ...manifest, id: PLAYER_CID, isPlayer: true }, startMinutes, characterDecl) } };
  }

  revertChange(change: VarChange): void {
    const PREFIX = "characters.";
    if (!change.path.startsWith(PREFIX)) throw new Error(`charactersStore 无法反向的路径: ${change.path}`);
    const dotted = change.path.slice(PREFIX.length); // 剥真相根前缀后：CID.rest
    const dot = dotted.indexOf("."); if (dot <= 0) throw new Error(`charactersStore 无法反向的路径: ${change.path}`);
    const cid = dotted.slice(0, dot); const rest = dotted.slice(dot + 1); const state = this.data.characters[cid];
    if (!state) throw new Error(`charactersStore 反向时找不到角色: ${cid}`);
    const copy = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    if (change.before_exists === false) deleteByPath(copy, rest, 1); else setByPath(copy, rest, change.before);
    this.data = { ...this.data, characters: { ...this.data.characters, [cid]: copy as CharacterState } };
  }

  snapshot(): CharactersFile { return JSON.parse(JSON.stringify(this.data)) as CharactersFile; }
  restoreSnapshot(snapshot: CharactersFile): void { this.data = CharactersFileSchema.parse(JSON.parse(JSON.stringify(snapshot))); }
}
