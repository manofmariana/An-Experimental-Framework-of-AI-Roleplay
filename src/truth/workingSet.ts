/**
 * 工作集（当前轮未裁决言行暂存区）：条目并集 = 言行条目 | 通知条目。
 *
 * 言行条目 = {cid, input?, decision?}（decision 引用与落账/投影同形，逐字节还原）；
 * 可见域 = decision.visibility（A = 只对同频道 / B = 只对同地 / 缺省 = 组内全体），
 * 条目级 TAG 挂载不落条目——渲染时按焊死映射从当前真相派生（speechEntryTagsOf）：
 * 发言（dialogue 非空）= {aud@1, vis@1}（同级取或：听到或看到皆可）；行为（无言）= {vis@1}；
 * 字段 A 追加 频道@2 + 手段 {A@3, V@3}（同级取或，工具双向对称）；字段 B 追加 地点@2。
 *
 * 通知条目 = {id, author:"system", notice, tags}：标记（gm_request/leave/recall/contact）
 * 的程序生成注入镜像；载荷纯结构化参数、无文本（文案由投影层机械组装 + 占位符模板渲染）。
 * id 同 type 固定复用（临时内容、昙花一现——同类型后来者居上）；生命周期随工作集清算。
 * 标记机制本身（触发 GM/邀请投影）与通知条目并行，互不替代。
 */
import { z } from "zod";
import { DecisionPackageSchema, TagMountRefSchema, type Marker, type TagMountRef } from "../types.js";
import { normalizeCid } from "./identity.js";

export const WorkingSetSpeechEntrySchema = z.object({
  cid: z.string(),
  input: z.string().optional(),
  decision: DecisionPackageSchema.optional(),
});
export type WorkingSetSpeechEntry = z.infer<typeof WorkingSetSpeechEntrySchema>;

/** 通知条目 type 封闭枚举（随标记/动作种类增长；confirm 不在内——它是应答本身）。 */
export const WORKING_SET_NOTICE_TYPES = ["gm_request", "leave", "recall", "contact"] as const;
export type WorkingSetNoticeType = (typeof WORKING_SET_NOTICE_TYPES)[number];

/** 通知载荷：纯结构化参数，无文本。 */
export const WorkingSetNoticeSchema = z
  .object({
    type: z.enum(WORKING_SET_NOTICE_TYPES),
    /** 行为者 CID（标记作者） */
    actor: z.string(),
    /** 途径文本（contact；如 电话/视频） */
    means: z.string().optional(),
    /** 目标 CID 集（recall/contact；无目标 = 空数组） */
    targets: z.array(z.string()),
  })
  .strict();
export type WorkingSetNotice = z.infer<typeof WorkingSetNoticeSchema>;

export const WorkingSetNoticeEntrySchema = z
  .object({
    /** 同 type 固定复用（notice:{type}；昙花一现的临时内容不做独立分配） */
    id: z.string(),
    author: z.literal("system"),
    notice: WorkingSetNoticeSchema,
    /** 条目级 TAG 挂载（生成时按焊死映射安插；纯函数可重放，投影重建逐字节一致） */
    tags: z.array(TagMountRefSchema),
  })
  .strict();
export type WorkingSetNoticeEntry = z.infer<typeof WorkingSetNoticeEntrySchema>;

export const WorkingSetEntrySchema = z.union([WorkingSetSpeechEntrySchema, WorkingSetNoticeEntrySchema]);
export type WorkingSetEntry = z.infer<typeof WorkingSetEntrySchema>;

export function isNoticeEntry(entry: WorkingSetEntry): entry is WorkingSetNoticeEntry {
  return "notice" in entry;
}

/** 通知条目固定 ID（同 type 复用）。 */
export function noticeIdOf(type: WorkingSetNoticeType): string {
  return `notice:${type}`;
}

/** 通知条目 TAG 挂载（焊死映射）：contact = 感知 1 级 + 目标 cid 2 级 + 手段 A/V 3 级；其余 = {vis@1}。 */
export function noticeTagsOf(notice: WorkingSetNotice): TagMountRef[] {
  if (notice.type === "contact") {
    return [
      { name: "aud", level: 1 },
      { name: "vis", level: 1 },
      ...notice.targets.map((cid) => ({ name: cid, level: 2 })),
      { name: "A", level: 3 },
      { name: "V", level: 3 },
    ];
  }
  return [{ name: "vis", level: 1 }];
}

/**
 * 标记 → 通知条目（纯函数；confirm 不生成）。载荷镜像标记本身（目标归一化、不含未知目标
 * 校验——校验归标记执行层；纯函数保证规划器落账与投影重建同源同结果）。
 */
export function noticesOfMarkers(actor: string, markers: readonly Marker[]): WorkingSetNoticeEntry[] {
  const out: WorkingSetNoticeEntry[] = [];
  for (const marker of markers) {
    switch (marker.type) {
      case "gm_request":
      case "leave": {
        const notice: WorkingSetNotice = { type: marker.type, actor, targets: [] };
        out.push({ id: noticeIdOf(marker.type), author: "system", notice, tags: noticeTagsOf(notice) });
        break;
      }
      case "recall": {
        const target = normalizeCid(marker.target);
        const notice: WorkingSetNotice = { type: "recall", actor, targets: [target] };
        out.push({ id: noticeIdOf("recall"), author: "system", notice, tags: noticeTagsOf(notice) });
        break;
      }
      case "contact": {
        const targets = marker.targets.map(normalizeCid).filter((t) => t !== actor);
        const notice: WorkingSetNotice = { type: "contact", actor, means: marker.channel, targets };
        out.push({ id: noticeIdOf("contact"), author: "system", notice, tags: noticeTagsOf(notice) });
        break;
      }
      case "confirm":
        break; // 应答本身，不生成通知
    }
  }
  return out;
}

/** 通知条目并入工作集（同 ID 复用：先摘后附，后来者居上；返回新数组）。 */
export function appendNotices(
  entries: readonly WorkingSetEntry[],
  notices: readonly WorkingSetNoticeEntry[],
): WorkingSetEntry[] {
  if (notices.length === 0) return [...entries];
  const ids = new Set(notices.map((n) => n.id));
  return [...entries.filter((e) => !isNoticeEntry(e) || !ids.has(e.id)), ...notices];
}

/**
 * 言行条目 TAG 挂载派生（焊死映射；渲染时按当前真相现算，不落条目）：
 * 默认 = 发言 {aud@1, vis@1} / 行为 {vis@1}；字段 A 追加 频道@2（持频道时）+ {A@3, V@3}；
 * 字段 B 追加 地点@2。extraMounts = 世界性安插预留入口（结构就位，现无世界包内容）。
 */
export function speechEntryTagsOf(
  entry: WorkingSetSpeechEntry,
  actor: { channel: number | null; location: { name: string } },
  extraMounts?: readonly TagMountRef[],
): TagMountRef[] {
  const speech = entry.decision?.dialogue !== undefined || (entry.decision === undefined && entry.input !== undefined);
  const tags: TagMountRef[] = speech
    ? [
        { name: "aud", level: 1 },
        { name: "vis", level: 1 },
      ]
    : [{ name: "vis", level: 1 }];
  const visibility = entry.decision?.visibility;
  if (visibility === "A") {
    if (actor.channel !== null) tags.push({ name: String(actor.channel), level: 2 });
    tags.push({ name: "A", level: 3 }, { name: "V", level: 3 });
  } else if (visibility === "B") {
    tags.push({ name: actor.location.name, level: 2 });
  }
  return extraMounts === undefined ? tags : [...tags, ...extraMounts];
}

/** 通知条目机械文案（系统通知；@CID 原文，身份替换走组装后处理同一出口）。 */
export function renderNoticeText(notice: WorkingSetNotice): string {
  switch (notice.type) {
    case "gm_request":
      return `【系统通知】@${notice.actor} 请求 GM 裁决`;
    case "leave":
      return `【系统通知】@${notice.actor} 离开了当前场景`;
    case "recall":
      return `【系统通知】@${notice.actor} 召回了 ${notice.targets.map((t) => `@${t}`).join("、")}`;
    case "contact":
      return `【系统通知】@${notice.actor} 通过「${notice.means ?? ""}」联系 ${notice.targets.map((t) => `@${t}`).join("、")}`;
  }
}

/** 单条目的场景行（renderScene 的逐条目因子；投影层逐条目扁平文本同形复用）。 */
export function renderEntryLines(
  entry: WorkingSetEntry,
  viewerCid?: string,
  remoteCids?: ReadonlySet<string>,
): string[] {
  if (isNoticeEntry(entry)) return [renderNoticeText(entry.notice)];
  const lines: string[] = [`##@${entry.cid}${remoteCids?.has(entry.cid) === true ? "（远程）" : ""}`];
  if (entry.input !== undefined) lines.push(`  言行：${entry.input}`);
  if (entry.decision !== undefined) {
    if (entry.decision.action !== undefined) lines.push(`  行动：${entry.decision.action}`);
    // 私域字段：视角过滤——他人条目对角色观察者只暴露可观测的行动与发言
    if (viewerCid === undefined || entry.cid === viewerCid) {
      lines.push(`  内心：${entry.decision.inner}`);
    }
    if (entry.decision.dialogue !== undefined) lines.push(`  发言：${entry.decision.dialogue}`);
  }
  return lines;
}

export function renderScene(
  entries: readonly WorkingSetEntry[],
  viewerCid?: string,
  /** 远程成员（位置 ≠ 组位置）：标题行加注入标注 */
  remoteCids?: ReadonlySet<string>,
): string {
  return entries.flatMap((entry) => renderEntryLines(entry, viewerCid, remoteCids)).join("\n");
}

/** 正文取材（台词+内心）：通知条目不是叙事素材，跳过。 */
export function renderSpeech(entries: readonly WorkingSetEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (isNoticeEntry(entry)) continue;
    lines.push(`##@${entry.cid}`);
    if (entry.input !== undefined) lines.push(`  言行：${entry.input}`);
    if (entry.decision !== undefined) {
      if (entry.decision.dialogue !== undefined) lines.push(`  发言：${entry.decision.dialogue}`);
      lines.push(`  内心：${entry.decision.inner}`);
    }
  }
  return lines.join("\n");
}
