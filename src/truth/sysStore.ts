/**
 * sys 第五根：sys.json 档内容器（纯内存，无 IO）+ 严格解析唯一出口。
 *
 * sys.json = {schema_version, tagRegistry, varsTemplate, varsTags, cycles_since_gm,
 * gm_trigger, gm_trigger_batch, pipeline}——schema_version 是全档唯一盖章点（其余真相
 * 文件不再逐文件盖章）；变量体系三件套与程序计数键（原 world._sys 程序分支）与 pipeline
 * （步边界状态）同归本根。codec 层只验形状（schema_version literal + 键存在），
 * tagRegistry/varsTemplate/varsTags 的严格解析唯一出口 = 本模块 parseSys（装配/续档/
 * 直编/占位符机检上下文共用），并在此做一次从动依赖成环闸（模板双根各建一次计划）。
 *
 * 写入口分工：程序计数键经 writeRaw（产出 `sys.…` VarChange，回溯可逆）；pipeline 经
 * setPipeline（不落 VarChange，步状态由归档/回溯专门管理）；结构三件套经 replaceStructs
 * （结构编辑档内通道，调用方先 parseSys 校验）。
 */
import { z } from "zod";
import { parseTagRegistry, type TagRegistry } from "../tags/registry.js";
import { buildDerivedPlan } from "../vars/derived.js";
import {
  parseVarsTags,
  parseVarsTemplate,
  type VarsTagsNode,
  type VarsTemplate,
} from "../vars/template.js";
import { SAVE_SCHEMA_VERSION } from "./saveSchema.js";
import { deleteByPath, getByPath, makeVarChange, setByPath, type VarChange } from "./varChanges.js";
import { StepChangesSchema, type StepChanges } from "./worldStore.js";
import { WorkingSetEntrySchema } from "./workingSet.js";

// ---------------------------------------------------------------------------
// pipeline 契约（步边界状态；phase 不落盘，派生量由消费方 phaseOf(deriveNext(...)) 现算）
// ---------------------------------------------------------------------------

export const PipelineCurrentSchema = z.object({
  seq: z.number(), kind: z.string(), result: z.unknown(),
  changes: StepChangesSchema.optional(), interrupted: z.boolean().optional(), edited: z.boolean().optional(),
});
export type PipelineCurrent = z.infer<typeof PipelineCurrentSchema>;
export const PipelineSchema = z.object({
  seq: z.number(), working_set: z.array(WorkingSetEntrySchema), current: PipelineCurrentSchema.nullable(),
});
export type Pipeline = z.infer<typeof PipelineSchema>;

/** 空 pipeline（每次调用新建，防共享数组被改写）。 */
export function emptyPipeline(): Pipeline {
  return { seq: 0, working_set: [], current: null };
}

// ---------------------------------------------------------------------------
// sys.json codec 与严格解析
// ---------------------------------------------------------------------------

/** sys.json 文件 codec（形状闸；schema_version = 全档唯一盖章点）。 */
export const SysFileSchema = z.object({
  schema_version: z.literal(SAVE_SCHEMA_VERSION),
  tagRegistry: z.unknown(),
  varsTemplate: z.unknown(),
  varsTags: z.object({ world: z.unknown(), character: z.unknown() }).strict(),
  cycles_since_gm: z.number(),
  gm_trigger: z.boolean(),
  gm_trigger_batch: z.number().nullable(),
  pipeline: PipelineSchema,
});
export type SysFile = z.infer<typeof SysFileSchema>;

/** 解析后的 sys 根（结构三件套严格解析产物 + 程序计数键）。 */
export interface ParsedSys {
  tagRegistry: TagRegistry;
  template: VarsTemplate;
  varsTags: { world: VarsTagsNode; character: VarsTagsNode };
  cycles_since_gm: number;
  gm_trigger: boolean;
  gm_trigger_batch: number | null;
}

/** parseSys 输入形状：计数键可缺省（装配期世界包三件套不带计数键），缺省 = 归零初值。 */
const SysParseSchema = z.object({
  tagRegistry: z.unknown(),
  varsTemplate: z.unknown(),
  varsTags: z.object({ world: z.unknown(), character: z.unknown() }).strict(),
  cycles_since_gm: z.number().default(0),
  gm_trigger: z.boolean().default(false),
  gm_trigger_batch: z.number().nullable().default(null),
});

/** 严格解析 sys 根（形状闸 + 三套 parse + 从动依赖成环闸；任何违规 = 抛错）。输入含 pipeline 键亦可（忽略）。 */
export function parseSys(raw: unknown): ParsedSys {
  const parsed = SysParseSchema.parse(raw);
  const tagRegistry = parseTagRegistry(parsed.tagRegistry);
  const template = parseVarsTemplate(parsed.varsTemplate);
  // 成环闸：双根各建一次从动计划，成环即拒（装配/续档/直编共用本出口）
  buildDerivedPlan(template.world);
  buildDerivedPlan(template.character);
  return {
    tagRegistry,
    template,
    varsTags: {
      world: parseVarsTags(parsed.varsTags.world, template.world),
      character: parseVarsTags(parsed.varsTags.character, template.character),
    },
    cycles_since_gm: parsed.cycles_since_gm,
    gm_trigger: parsed.gm_trigger,
    gm_trigger_batch: parsed.gm_trigger_batch,
  };
}

/** 结构三件套（结构编辑档内通道的读写面）。 */
export interface SysStructs {
  tagRegistry: unknown;
  varsTemplate: unknown;
  varsTags: { world?: unknown; character?: unknown };
}

// ---------------------------------------------------------------------------
// 容器
// ---------------------------------------------------------------------------

/** sys 根容器（纯内存）：每次变异只改内存；落盘由 GenerationRepository 步边界整代提交。 */
export class SysStore {
  private data: SysFile;

  constructor(data: SysFile) {
    this.data = JSON.parse(JSON.stringify(data)) as SysFile;
  }

  /** 新档初始根：结构三件套 + 计数键归零 + 空 pipeline。 */
  static initial(structs: SysStructs): SysStore {
    return new SysStore({
      schema_version: SAVE_SCHEMA_VERSION,
      ...structs,
      cycles_since_gm: 0,
      gm_trigger: false,
      gm_trigger_batch: null,
      pipeline: emptyPipeline(),
    });
  }

  /** 整代提交的写盘数据源（sys.json 信封）。 */
  saveData(): SysFile {
    return this.data;
  }

  /** 数据整体替换（错误再同步用：对象身份保持，内容回到指定 Generation）。 */
  restoreData(data: SysFile): void {
    this.data = JSON.parse(JSON.stringify(data)) as SysFile;
  }

  get pipeline(): Pipeline {
    return this.data.pipeline;
  }

  setPipeline(patch: Partial<Pipeline>): void {
    this.data = { ...this.data, pipeline: { ...this.data.pipeline, ...patch } };
  }

  /** 程序计数键读取口。 */
  get counters(): { cycles_since_gm: number; gm_trigger: boolean; gm_trigger_batch: number | null } {
    return {
      cycles_since_gm: this.data.cycles_since_gm,
      gm_trigger: this.data.gm_trigger,
      gm_trigger_batch: this.data.gm_trigger_batch,
    };
  }

  /** 结构三件套读取口（GET sys 端点/占位符机检上下文）。 */
  get structs(): SysStructs {
    return {
      tagRegistry: this.data.tagRegistry,
      varsTemplate: this.data.varsTemplate,
      varsTags: this.data.varsTags,
    };
  }

  /** 结构三件套替换（结构编辑档内通道，部分键；解析校验在调用方 parseSys，本口不重复）。 */
  replaceStructs(patch: { tagRegistry?: unknown; varsTemplate?: unknown; varsTags?: unknown }): void {
    const next: Record<string, unknown> = { ...this.data };
    if (patch.tagRegistry !== undefined) next["tagRegistry"] = patch.tagRegistry;
    if (patch.varsTemplate !== undefined) next["varsTemplate"] = patch.varsTemplate;
    if (patch.varsTags !== undefined) next["varsTags"] = patch.varsTags;
    this.data = next as unknown as SysFile;
  }

  /**
   * 程序计数键低层写入口（调用方负责校验；path = sys 根内点路径，值 = 该路径整体新值；
   * pipeline 与结构三件套各有专口，不经此）。产出真相根路径 VarChange（`sys.…`）。
   */
  writeRaw(path: string, value: unknown): VarChange {
    if (path === "pipeline" || path.startsWith("pipeline.")) {
      throw new Error(`pipeline 经 setPipeline 专口写入: ${path}`);
    }
    const data = JSON.parse(JSON.stringify(this.data)) as Record<string, unknown>;
    const before = getByPath(data, path);
    setByPath(data, path, value);
    this.data = data as unknown as SysFile;
    return makeVarChange(`sys.${path}`, before, value);
  }

  revertChange(change: VarChange): void {
    if (!change.path.startsWith("sys.")) throw new Error(`sysStore 无法反向的路径: ${change.path}`);
    const data = JSON.parse(JSON.stringify(this.data)) as Record<string, unknown>;
    const dotted = change.path.slice("sys.".length);
    if (change.before_exists === false) deleteByPath(data, dotted);
    else setByPath(data, dotted, change.before);
    this.data = data as unknown as SysFile;
  }
}
