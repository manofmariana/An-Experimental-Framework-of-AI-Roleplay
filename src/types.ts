import { z } from "zod";

// ---------------------------------------------------------------------------
// 真相层：事件日志的唯一事实单元（append-only）
// ---------------------------------------------------------------------------

/** 事件类型。random 为突发事件预留。 */
export const EventKindSchema = z.enum([
  "action", // 已裁决的行动落地
  "speech", // 台词/对话
  "world", // 世界反应/环境变化
  "random", // 预留：突发事件（引信制）
]);
export type EventKind = z.infer<typeof EventKindSchema>;

/** 内容侧单条 TAG 挂载：{TAG 名, 等级 1-7}；等级范围由 schema 机检，名称合法性由写入层对档内注册表校验。 */
export const TagMountRefSchema = z
  .object({ name: z.string().min(1), level: z.number().int().min(1).max(7) })
  .strict();
export type TagMountRef = z.infer<typeof TagMountRefSchema>;

/**
 * 末端外壳（四内容根同构的唯一叶子形态）：{value, tags, formula?}——
 * 与变量树末端同一形状；formula 为占位（写入侧一律不产，结构预留）。
 */
export const FieldShellSchema = <T extends z.ZodTypeAny>(value: T) =>
  z
    .object({
      value,
      /** 内容侧 TAG 挂载（{name, level}[]）：引擎逐末端过滤的输入 */
      tags: z.array(TagMountRefSchema),
      formula: z.unknown().optional(),
    })
    .strict();

/** 事件元素 = 系统固定结构（引擎机检登记同形声明）：全字段末端外壳；时间/地点同为可挂 tags 的调取对象。 */
export const EventSchema = z.object({
  /** 稳定 ID（排序、引用用，如 evt_0001） */
  id: FieldShellSchema(z.string()),
  /** 世界时间 T（连续时间，真相层才有绝对时间，提示词永不出现） */
  t: FieldShellSchema(z.number()),
  /** 产生本事件的 GM 步骤 seq（回溯截断锚） */
  seq: FieldShellSchema(z.number()),
  kind: FieldShellSchema(EventKindSchema),
  /** 事件发生地点名（叙事记录用；感知过滤不含地点成分） */
  location: FieldShellSchema(z.string()).optional(),
  /** 事件内容（@ID 占位的第三人称真相描述，写入时定型，读取侧只过身份替换后处理） */
  content: FieldShellSchema(z.string()),
});
export type Event = z.infer<typeof EventSchema>;

/** 玩家固定 CID；角色为 C+编号（C1001 起，由工具 Agent 顺序分配）。 */
export const PLAYER_CID = "C0";

/** CID 字面量（@ 前缀可选，落库时归一化为去 @ 形式）。 */
export const CID_PATTERN = /^@?C(?:0|[1-9]\d*)$/;

// ---------------------------------------------------------------------------
// 调度层：模拟调度器与运行时编排器的唯一接口
// ---------------------------------------------------------------------------

/** 感知包：唤醒角色时喂给它的事件窗口（编译器负责转写为第一人称）。 */
export const PerceptionBriefSchema = z.object({
  /** 该角色可见的事件（已按 time ≤ 唤醒时刻 ∧ TAG 过滤、按 id 排序） */
  events: z.array(EventSchema),
  /** 唤醒原因（叙事性说明，如 "player_spoke_to_you"） */
  reason: z.string(),
});
export type PerceptionBrief = z.infer<typeof PerceptionBriefSchema>;

export const ActivationModeSchema = z.enum(["normal", "timeskip"]);
export type ActivationMode = z.infer<typeof ActivationModeSchema>;

export const ActivationSchema = z.object({
  /** 被唤醒对象：角色 ID / "player" / "gm" */
  target: z.string(),
  brief: PerceptionBriefSchema,
  /** 域内先攻排序键（并行激活预留，当前恒为空） */
  orderKey: z.number().optional(),
  mode: ActivationModeSchema,
});
export type Activation = z.infer<typeof ActivationSchema>;

// ---------------------------------------------------------------------------
// 地点与计时器
// ---------------------------------------------------------------------------

/** 角色地点（结构化）：name 是 GM 自由文本（同地判定按 name），level 供突发鉴定用。 */
export const LocationSchema = z.object({
  name: z.string(),
  level: z.number(),
});
export type Location = z.infer<typeof LocationSchema>;

/** 相对时间偏移（仅 GM 裁决包 durations；程序 到期时刻 = 世界时钟 + spanToMinutes(span)）。 */
export const SpanSchema = z.object({
  y: z.number().int().finite().optional(),
  m: z.number().int().finite().optional(),
  d: z.number().int().finite().optional(),
  h: z.number().int().finite().optional(),
  min: z.number().int().finite().optional(),
});
export type Span = z.infer<typeof SpanSchema>;

/** span → 分钟（y=365d、m=30d、d=24h、h=60min；全部缺省 0；负值钳制为 0）。 */
export function spanToMinutes(span: Span): number {
  const days = (span.y ?? 0) * 365 + (span.m ?? 0) * 30 + (span.d ?? 0);
  const minutes = days * 1440 + (span.h ?? 0) * 60 + (span.min ?? 0);
  return Math.max(0, minutes);
}

/** 分钟数 → 中文时长文本（如 "3天2小时5分钟"；≤0 → "0分钟"）。
 *  快照注入用（各角色 timer 剩余时间）——程序机械渲染，LLM 不自由算时间。 */
export function minutesToText(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const r = m % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}天`);
  if (h > 0) parts.push(`${h}小时`);
  if (r > 0 || parts.length === 0) parts.push(`${r}分钟`);
  return parts.join("");
}

// ---------------------------------------------------------------------------
// 标记（Marker）与结构化先攻
// ---------------------------------------------------------------------------

/** 最近先攻结果（角色变量）：{先攻值, 组编号}；组编号变化即重置（归 0 除外，留待召回复用）。 */
export const InitiativeSchema = z.object({
  value: z.number(),
  group: z.number(),
});
export type Initiative = z.infer<typeof InitiativeSchema>;

/**
 * 标记：角色/玩家输出中的结构化指令位（DecisionPackage 可选 markers 数组）。
 * 标记本身即抛、不直入工作集；程序在消费点为 gm_request/leave/recall/contact
 * 生成系统通知条目入工作集（注入镜像，confirm 是应答本身不生成）。
 */
export const MarkerSchema = z.discriminatedUnion("type", [
  /** GM 请求：同先攻批全员行动完后 GM 立即激活（与 leave 互斥） */
  z.object({ type: z.literal("gm_request") }).strict(),
  /** 离开：组归 0 + timer 置 null（无计时器），下次 GM 统一结算（对玩家与 NPC 统一程序化，不触发 GM） */
  z.object({ type: z.literal("leave") }).strict(),
  /** 召回：把未结算离开者拉回（timer 归当前 clock、按进组规则归组、先攻复用） */
  z.object({ type: z.literal("recall"), target: z.string().regex(CID_PATTERN) }).strict(),
  /** 联系：发起跨地点邀请（channel = 途径文本，如 电话/视频；targets = 对象列表） */
  z
    .object({
      type: z.literal("contact"),
      channel: z.string().min(1),
      targets: z.array(z.string().regex(CID_PATTERN)).min(1),
    })
    .strict(),
  /** 确认：被邀请者接受邀请（+ 首轮回复）；拒绝则不立此标记 */
  z.object({ type: z.literal("confirm") }).strict(),
]);
export type Marker = z.infer<typeof MarkerSchema>;

/** 人际关系库更新条目（角色全权维护，GM 不参与）。 */
export const RelationUpdateSchema = z.object({
  /** 对方 CID（@C0 / C0 均可，落库时归一化为去 @ 形式） */
  target: z.string().regex(CID_PATTERN),
  /** 得知对方真名时登记 */
  name: z.string().min(1).optional(),
  /** 印象称谓（"鞋上有青苔的男人"） */
  impression: z.string().min(1).optional(),
}).refine((relation) => relation.name !== undefined || relation.impression !== undefined, {
  message: "relation 至少需要 name 或 impression",
});
export type RelationUpdate = z.infer<typeof RelationUpdateSchema>;

/**
 * 角色决策包 = inner 必填 + action/dialogue 至少其一 + 按需扩展字段。
 * 当前扩展仅落实 relations/markers；未来装备、消耗品等角色自写变量将新增明确的
 * 可选字段，并经确定性的 CharactersStore/var_changes 通道落账，不引入 generic changes。
 */
export const DecisionPackageSchema = z.object({
  /** 行动（角色明确做什么；交给 GM 裁决，不直接成为真相；纯台词轮可省略） */
  action: z.string().min(1).optional(),
  /** 内心活动与意图（角色为何这样想/做）：给角色连续性与正文情绪参考，不作为旁人可知事实 */
  inner: z.string().min(1),
  /** 台词原文（正文 agent 无权改写）；没有说话时必须省略 */
  dialogue: z.string().min(1).optional(),
  /** 人际关系库更新：本轮真实得知名字或印象实际变化时登记 */
  relations: z.array(RelationUpdateSchema).min(1).optional(),
  /** 标记：结构化指令位；解析后只有即时程序作用（通知条目镜像由程序生成，见工作集） */
  markers: z.array(MarkerSchema).min(1).optional(),
  /**
   * 可见域（缺省 = 组内全体）：A = 只对同频道（经频道工具）；B = 只对同地。
   * 条目级 TAG 挂载由程序按焊死映射安插（渲染时派生），本字段只是 LLM 的域声明。
   */
  visibility: z.enum(["A", "B"]).optional(),
}).strict().refine((pkg) => pkg.action !== undefined || pkg.dialogue !== undefined, {
  message: "dialogue 与 action 至少其一",
}).refine((pkg) => {
  const types = new Set((pkg.markers ?? []).map((m) => m.type));
  return !(types.has("gm_request") && types.has("leave"));
}, { message: "gm_request 与 leave 标记互斥（二选一）" });
export type DecisionPackage = z.infer<typeof DecisionPackageSchema>;

// ---------------------------------------------------------------------------
// GM 输出：裁决包——真相层的唯一写入形式
// ---------------------------------------------------------------------------

export const StateDeltaSchema = z.object({
  /** 变量路径（双根语法：`world.…` 或 `characters.{cid}.…`；语义校验在写入层按模板判定） */
  path: z.string().refine((p) => p.startsWith("world.") || p.startsWith("characters."), {
    message:
      '变量路径必须使用双根语法：以 "world." 开头（如 world.region.fog）或 "characters.{cid}." 开头（如 characters.C1001.vars.attachtags）',
  }),
  /** 赋值/加法/减法 */
  op: z.enum(["=", "+=", "-="]),
  /** 写入值（形状不限；写入层按模板 valueType 校验） */
  value: z.custom<unknown>((v) => v !== undefined, "value 为必填字段"),
});
export type StateDelta = z.infer<typeof StateDeltaSchema>;

/** 叙事权重：full = 全文渲染，brief = 一笔带过，skip = 不进正文 */
export const NarrativityLevelSchema = z.enum(["full", "brief", "skip"]);
export type NarrativityLevel = z.infer<typeof NarrativityLevelSchema>;

/** 裁决包内单条事件（事件数 = GM 计划的新组划分；@ID 占位的中性事实陈述）。 */
export const AdjudicationEventSchema = z.object({
  /** 事件正文（@ID 占位，台词逐字引用原文） */
  text: z.string(),
  /**
   * 内容侧 TAG 挂载（{name, level}[]；感知过滤按读者有效 TAG 集求值）；
   * 空数组 = 程序补全本轮全部行动者的 cid 类 TAG（level 1）。
   */
  tags: z.array(TagMountRefSchema),
  /** 叙事记录用地点名（跨场景对话事件置空；不参与感知过滤） */
  location: z.string().optional(),
});
export type AdjudicationEvent = z.infer<typeof AdjudicationEventSchema>;

/**
 * 裁决包：先写事件、后定 durations/location。
 */
export const AdjudicationPackageSchema = z.object({
  /** 本轮落地事件集（事件数跟随 GM 的新组划分；每事件逐条 commit） */
  events: z.array(AdjudicationEventSchema),
  /** 本轮事件的叙事权重（包级单值） */
  narrativity: NarrativityLevelSchema,
  /** 变量变更，由确定性应用器落库 */
  deltas: z.array(StateDeltaSchema),
  /** 各角色时长（相对偏移；程序 到期时刻 = 世界时钟 + spanToMinutes(span)；须覆盖本轮全部行动者） */
  durations: z.array(z.object({ cid: z.string(), span: SpanSchema })),
  /** 各角色地点更新（location/timer 是分组判据，GM 只设变量，分组由程序派生） */
  location: z.array(z.object({ cid: z.string(), location: LocationSchema })),
});
export type AdjudicationPackage = z.infer<typeof AdjudicationPackageSchema>;

// ---------------------------------------------------------------------------
// 突发 GM 输出：突发包（slim 契约，独立轻校验，不复用裁决包的 durations 覆盖校验）
// ---------------------------------------------------------------------------

/** 突发包：突发 GM 的唯一输出——事件文本 + 可选世界变量变更。 */
export const IncidentPackageSchema = z.object({
  /** 突发事件正文（@ID 占位的中性事实陈述；未裁决素材，由后续常规 GM 结算转写为真正 Event） */
  text: z.string().min(1),
  /** 世界变量变更（口径同裁决包 deltas；无变更输出 []） */
  deltas: z.array(StateDeltaSchema),
});
export type IncidentPackage = z.infer<typeof IncidentPackageSchema>;

// ---------------------------------------------------------------------------
// 缓存埋点
// ---------------------------------------------------------------------------

export const CacheStatSchema = z.object({
  /** agent 名：character:<id> / gm / prose */
  agent: z.string(),
  /** 主循环轮次 */
  turn: z.number(),
  /** usage.prompt_cache_hit_tokens */
  hit: z.number(),
  /** usage.prompt_cache_miss_tokens */
  miss: z.number(),
  /** usage.completion_tokens */
  output: z.number(),
});
export type CacheStat = z.infer<typeof CacheStatSchema>;

// ---------------------------------------------------------------------------
// Lorebook（静态 JSON 条目库）
// ---------------------------------------------------------------------------

export const LoreEntrySchema = z.object({
  id: FieldShellSchema(z.string()),
  /** 条目正文（TAG 挂载全部落在本末端：激活与可见性按读者有效 TAG 集逐末端求值） */
  content: FieldShellSchema(z.string()),
  /** 管理界面用开关（元数据，不参与过滤/激活逻辑——投影全量供给，引擎只按 content.tags 过滤） */
  enabled: FieldShellSchema(z.boolean()).optional(),
});
export type LoreEntry = z.infer<typeof LoreEntrySchema>;
