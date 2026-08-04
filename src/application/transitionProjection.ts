/**
 * 提交 → 增量同步投影（优化阶段 D2，docs/optimization-review.md §5
 * 「Snapshot 与增量 Transition」「一致快照 query」「消息身份」）：纯函数，零 IO。
 *
 * GameSession 每次提交（commitGeneration/commitTruth）产出一个 CommitNotice
 * （prev/next 根引用——恒冻结策略下存引用即零拷贝快照）；buildTransition 用
 * 引用比较求差（引用不同再落 JSON 值比较兜底——draft 路径经 cloneTruth/adoptTruth
 * 深拷贝，引用必变，值比较把"假变化"过滤掉）：
 * - world 根变 → 携带完整 world 变量树（当前规模全量可接受）；
 * - characters 逐 CID 对比 → 只带变化 CID 的完整当前视图，消失 → null；
 * - events 前缀比对 → 变长 appendedEvents 尾切片 / 变短或中段分歧
 *   truncateEventsAfterSeq（按 seq 截断）+ appendedEvents 尾部重放；
 * - historyPatch v1 恒为 {type:"replace", history}（正确性优先，增量 patch 留待后续）；
 * - edit_result 的提交附 editedResult（前端原地重渲该卡）。
 *
 * rollback_and_continue 只发一条合并 Transition（Coordinator 抑制中间回调，
 * fromRevision = 命令开始前 revision，见 sessionCoordinator.ts）。
 */
import type { DerivedPhase } from "../scheduler/derive.js";
import type { CharacterState } from "../truth/charactersStore.js";
import type { CommitReason } from "../truth/commitExecutor.js";
import type { DeepReadonly } from "../truth/snapshot.js";
import type { StateTree } from "../truth/worldStore.js";
import type { Event } from "../types.js";
import type { HistoryPayload } from "./historyProjection.js";

// ---------------------------------------------------------------------------
// 视图与载荷类型（下行协议的数据部分；WS 信封在 server/ws-protocol.ts 加 type 字段）
// ---------------------------------------------------------------------------

/** 流水线视图（phase 收窄为 phaseOf 的派生枚举，不再裸 string）。 */
export interface PipelineView {
  seq: number;
  phase: DerivedPhase;
  interrupted: boolean;
  /** 当前步 kind（"player" | "gm" | "prose" | `character:<cid>`），无当前步为 null */
  kind: string | null;
}

/** 变量库状态视图（旧 state 下行消息的 data 同形）。 */
export interface StateView {
  world: DeepReadonly<StateTree>;
  characters: DeepReadonly<Record<string, CharacterState>>;
}

/**
 * 一致快照（重连单播 / 会话切换广播 / 跳号恢复应答共用同一形状）：
 * runId + revision + 同一 revision 根派生的 state/events/history/pipeline。
 */
export interface SessionSnapshotData {
  runId: string;
  revision: number;
  state: StateView;
  events: DeepReadonly<Event[]>;
  history: HistoryPayload;
  pipeline: PipelineView;
}

/** 历史 patch：v1 恒 replace（整段历史回显替换，前端先清流区再重渲）。 */
export interface HistoryPatch {
  type: "replace";
  history: HistoryPayload;
}

/** 一次提交（fromRevision → revision）的可见变化（SessionTransition.changed）。 */
export interface TransitionChanges {
  /** world 变量树有变 → 完整当前 world 视图 */
  world?: DeepReadonly<StateTree>;
  /** 逐 CID 增量：完整当前视图；null = 该角色已消失 */
  characters?: Record<string, DeepReadonly<CharacterState> | null>;
  /** 事件尾切片（append；与 truncateEventsAfterSeq 可同现：先截后补） */
  appendedEvents?: DeepReadonly<Event[]>;
  /** 事件按 seq 截断（0 = 清空；与 appendedEvents 同现表示中段分歧后的重放） */
  truncateEventsAfterSeq?: number;
  /** 历史 patch（v1 恒 replace） */
  historyPatch?: HistoryPatch;
  /** edit_result 提交附带：被编辑步的解析后结果（前端按 seq+kind 原地重渲） */
  editedResult?: { seq: number; kind: string; result: unknown };
}

/** 增量 Transition（每次提交一条；广播）。 */
export interface SessionTransition {
  type: "transition";
  runId: string;
  fromRevision: number;
  revision: number;
  reason: CommitReason;
  pipeline: PipelineView;
  changed: TransitionChanges;
}

// ---------------------------------------------------------------------------
// CommitNotice（GameSession.onCommit 钩子的通知载荷）
// ---------------------------------------------------------------------------

/** 三域根引用（恒冻结 → 存引用即零拷贝快照；events = EventsStore 内部数组）。 */
export interface TruthRoots {
  world: DeepReadonly<StateTree>;
  characters: DeepReadonly<Record<string, CharacterState>>;
  events: DeepReadonly<Event[]>;
}

/** GameSession 提交完成通知（adopt/freeze 之后同步触发；prev = 上一提交的根）。 */
export interface CommitNotice {
  reason: CommitReason;
  fromRevision: number;
  revision: number;
  prev: TruthRoots;
  next: TruthRoots;
}

/** buildTransition 的外部输入（调用方在提交点现算：历史回显 / 流水线视图 / 编辑结果）。 */
export interface TransitionExtra {
  history: HistoryPayload;
  pipeline: PipelineView;
  editedResult?: { seq: number; kind: string; result: unknown };
}

// ---------------------------------------------------------------------------
// 引用差分（引用相同 → 未变；引用不同 → JSON 值比较过滤 draft 深拷贝造成的假变化）
// ---------------------------------------------------------------------------

function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** 事件前缀逐条一致（引用相等或 id+seq+内容值相等）的最长前缀长度。 */
function commonEventPrefix(prev: DeepReadonly<Event[]>, next: DeepReadonly<Event[]>): number {
  let k = 0;
  while (k < prev.length && k < next.length) {
    const a = prev[k]!;
    const b = next[k]!;
    if (a === b || (a.id === b.id && a.seq === b.seq && sameJson(a, b))) k += 1;
    else break;
  }
  return k;
}

/**
 * 提交通知 → 增量 Transition（纯函数）。
 * changed 只带有变化的域；historyPatch 恒 replace（extra.history 由调用方现算）。
 */
export function buildTransition(
  notice: CommitNotice,
  runId: string,
  extra: TransitionExtra,
): SessionTransition {
  const changed: TransitionChanges = {};

  // world：根引用变且值不同 → 完整 world 视图（setPipeline 不换 world 根，pipeline 变化不触发）
  if (!sameJson(notice.prev.world, notice.next.world)) {
    changed.world = notice.next.world;
  }

  // characters：逐 CID 对比（并集键；消失 → null）
  const characters: Record<string, DeepReadonly<CharacterState> | null> = {};
  const cids = new Set([...Object.keys(notice.prev.characters), ...Object.keys(notice.next.characters)]);
  for (const cid of [...cids].sort((a, b) => a.localeCompare(b))) {
    const before = notice.prev.characters[cid];
    const after = notice.next.characters[cid];
    if (after === undefined) {
      characters[cid] = null;
    } else if (!sameJson(before, after)) {
      characters[cid] = after;
    }
  }
  if (Object.keys(characters).length > 0) changed.characters = characters;

  // events：前缀比对 → append / truncate+append（中段分歧 = 编辑重裁决替换事件）
  if (notice.prev.events !== notice.next.events) {
    const k = commonEventPrefix(notice.prev.events, notice.next.events);
    if (k < notice.prev.events.length) {
      changed.truncateEventsAfterSeq = k === 0 ? 0 : notice.prev.events[k - 1]!.seq;
    }
    if (k < notice.next.events.length) {
      changed.appendedEvents = notice.next.events.slice(k);
    }
  }

  changed.historyPatch = { type: "replace", history: extra.history };
  if (extra.editedResult !== undefined) changed.editedResult = extra.editedResult;

  return {
    type: "transition",
    runId,
    fromRevision: notice.fromRevision,
    revision: notice.revision,
    reason: notice.reason,
    pipeline: extra.pipeline,
    changed,
  };
}
