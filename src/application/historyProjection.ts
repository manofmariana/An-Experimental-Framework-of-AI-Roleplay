/**
 * 历史回显与正文素材投影（纯展示函数群，零 IO，可单测）。
 * 数据源 = archive.json + world.json 流水线 current（进行中的最后一步），由调用方传入。
 */
import type { ArchiveEntry } from "../truth/archive.js";
import type { DeepReadonly } from "../truth/snapshot.js";
import type { PipelineCurrent } from "../truth/worldStore.js";
import type { AdjudicationPackage, DecisionPackage, Event } from "../types.js";

// ---------------------------------------------------------------------------
// 历史回显（载入存档后广播给前端；纯函数，可单测）
// ---------------------------------------------------------------------------

/** 一轮的一张角色卡（一轮可有多张，NPC 独立轮没有玩家步）。 */
export interface HistoryCharacterCard {
  cid: string;
  /** 该角色步的 seq（卡片级回滚/重 roll/llm-recent 查询用） */
  seq: number;
  /** interrupted 步尚无合法决策包，仅保留 raw 供安全展示与编辑。 */
  decision?: DecisionPackage;
  interrupted?: boolean;
  /** 原始返回（历史卡"原始返回"视图数据源） */
  raw?: string;
}

/** 一轮内命中的突发事件（incident 步产出；raw 供历史卡原始返回/编辑入口）。 */
export interface HistoryIncident {
  seq: number;
  text: string;
  location: string;
  malignant: boolean;
  severity: number;
  /** 原始返回（历史卡"原始返回"视图与编辑种子数据源） */
  raw?: string;
}

export interface HistoryTurn {
  /** 本轮首步 seq */
  turn: number;
  /** 本轮玩家输入（NPC 独立轮无此字段） */
  playerInput?: string;
  /** 本轮各角色卡（按行动序） */
  characters: HistoryCharacterCard[];
  /** 各步 seq（卡片级回滚/重 roll 用） */
  seqs: { player?: number; gm?: number; prose?: number };
  /** gm/prose 步原始返回 */
  raws?: { gm?: string; prose?: string };
  adjudication?: AdjudicationPackage;
  prose?: string;
  /** 本轮突发事件（incident 步，一轮可多条） */
  incidents?: HistoryIncident[];
}

export interface HistorySimpleEvent {
  kind: string;
  payload: string;
}

export type HistoryPayload =
  | { mode: "full"; turns: HistoryTurn[] }
  | { mode: "simple"; events: HistorySimpleEvent[] };

/** 步骤条目的最小形状（archive 条目与流水线 current 共用；gameSession 各切片也用）。 */
export interface StepLike {
  seq: number;
  kind: string;
  result?: unknown;
}

/**
 * 组装历史（存档 v2）：archive.json + world.json 流水线 current（进行中的最后一步）。
 * 按"轮"分组：一轮 = 若干 player/character 步 + 一个 gm 步（+ 可选 prose 步），
 * 可无 player 步（NPC 独立轮）；gm 步闭合一轮；一轮内多个玩家步（无判定轮跨周期）
 * 各自成组——玩家卡按 seq 归位，不被同组后者覆盖。无归档（空档）→ 从事件集构建简化历史。
 * incident（突发，调度透明步）总发生在某轮 gm/prose 之后：归属同 actor 步规则
 * （前一轮 gm 已闭合 → 开启新一轮）；interrupted 突发步无 incident 产出，跳过不渲染。
 */
export function buildHistory(
  events: readonly DeepReadonly<Event>[],
  archive: readonly DeepReadonly<ArchiveEntry>[],
  current: DeepReadonly<PipelineCurrent> | null,
): HistoryPayload {
  const steps: StepLike[] = [...archive, ...(current !== null ? [current] : [])];
  if (steps.length === 0) {
    return {
      mode: "simple",
      events: events.map((e) => ({ kind: e.kind, payload: e.payload })),
    };
  }
  const turns: HistoryTurn[] = [];
  const openTurn = (seq: number): HistoryTurn => {
    const t: HistoryTurn = { turn: seq, characters: [], seqs: {} };
    turns.push(t);
    return t;
  };
  let cur: HistoryTurn | null = null;
  for (const step of steps) {
    if (step.kind === "player") {
      // gm 步闭合一轮：其后的 actor 步开启新一轮；
      // 一轮内多个玩家步（无判定轮跨周期）各自成组——玩家输入不被覆盖吞并
      if (cur === null || cur.seqs.gm !== undefined || cur.playerInput !== undefined) cur = openTurn(step.seq);
      const t: HistoryTurn = cur;
      t.seqs.player = step.seq;
      t.playerInput = (step.result as { input: string }).input;
    } else if (step.kind.startsWith("character:")) {
      if (cur === null || cur.seqs.gm !== undefined) cur = openTurn(step.seq);
      const t: HistoryTurn = cur;
      const result = step.result as { raw?: string; decision?: DecisionPackage };
      const card: HistoryCharacterCard = {
        cid: step.kind.slice("character:".length),
        seq: step.seq,
      };
      if (result.decision !== undefined) card.decision = result.decision;
      if ((step as PipelineCurrent).interrupted === true) card.interrupted = true;
      if (result.raw !== undefined) card.raw = result.raw;
      t.characters.push(card);
    } else if (step.kind === "gm") {
      if (cur === null || cur.seqs.gm !== undefined) cur = openTurn(step.seq);
      const t: HistoryTurn = cur;
      t.seqs.gm = step.seq;
      const result = step.result as { raw?: string; adjudication: AdjudicationPackage };
      t.adjudication = result.adjudication;
      if (result.raw !== undefined) (t.raws ??= {}).gm = result.raw;
    } else if (step.kind === "prose") {
      // prose 归属前一个 gm 闭合的那一轮（skip 无 prose；防御：无 gm 的 prose 自成一轮）
      if (cur === null || cur.seqs.gm === undefined || cur.seqs.prose !== undefined) {
        cur = openTurn(step.seq);
      }
      const t: HistoryTurn = cur;
      t.seqs.prose = step.seq;
      const result = step.result as { raw?: string; prose: string };
      t.prose = result.prose;
      if (result.raw !== undefined) (t.raws ??= {}).prose = result.raw;
    } else if (step.kind === "incident") {
      // 突发步（调度透明）：incident 总在某轮 gm/prose 之后，前一轮 gm 已闭合 → 开启新一轮
      const result = step.result as {
        raw?: string;
        incident?: { text: string; deltas: unknown[] };
        target: { cids: string[]; location: string };
        roll: { D: number; T: number; p: number; malignant: boolean; severity: number };
      };
      if (result.incident !== undefined) {
        if (cur === null || cur.seqs.gm !== undefined) cur = openTurn(step.seq);
        const t: HistoryTurn = cur;
        const inc: HistoryIncident = {
          seq: step.seq,
          text: result.incident.text,
          location: result.target.location,
          malignant: result.roll.malignant,
          severity: result.roll.severity,
        };
        if (result.raw !== undefined) inc.raw = result.raw;
        (t.incidents ??= []).push(inc);
      }
    }
  }
  return { mode: "full", turns };
}

// ---------------------------------------------------------------------------
// 正文素材（从 archive.json 现取）
// ---------------------------------------------------------------------------

/** 正文归档结果：正文块携带该轮参与者及其行动时的连续场景 id。 */
export interface ArchivedProseResult {
  raw: string;
  prose: string;
  participants: string[];
  scenes: Record<string, number>;
}

/** 最近 n 轮已发布正文（原文块，无包装；仅供正文 agent 的全量连续文风输入）。 */
export function proseWindow(archive: ArchiveEntry[], n: number): string[] {
  if (n <= 0) return [];
  return archive
    .filter((e) => e.kind === "prose")
    .slice(-n)
    .map((e) => (e.result as ArchivedProseResult).prose);
}

/**
 * 角色正文滑窗：只取该 cid 亲身参与、且其当时所在组（连续场景 = 同一组编号存续期间）
 * 与当前值一致的最近 n 块。存档不做旧格式兼容；participants/scenes 是连续场景过滤的必要归档契约。
 */
export function proseWindowFor(
  archive: ArchiveEntry[],
  cid: string,
  currentGroup: number,
  n: number,
): string[] {
  if (n <= 0) return [];
  return archive
    .filter((e) => {
      if (e.kind !== "prose") return false;
      const result = e.result as ArchivedProseResult;
      return result.participants.includes(cid) && result.scenes[cid] === currentGroup;
    })
    .slice(-n)
    .map((e) => (e.result as ArchivedProseResult).prose);
}

/** GM 正文滑窗：仅取本轮行动者仍处于同一连续场景的正文，禁止跨组注入。 */
export function proseWindowForRound(
  archive: ArchiveEntry[],
  scenes: Readonly<Record<string, number>>,
  n: number,
): string[] {
  if (n <= 0) return [];
  const cids = Object.keys(scenes);
  return archive
    .filter((e) => {
      if (e.kind !== "prose") return false;
      const result = e.result as ArchivedProseResult;
      return cids.some(
        (cid) => result.participants.includes(cid) && result.scenes[cid] === scenes[cid],
      );
    })
    .slice(-n)
    .map((e) => (e.result as ArchivedProseResult).prose);
}

/** 上一轮已发布正文（无则空串 → prose 模板模块丢弃）。 */
export function lastProse(archive: ArchiveEntry[]): string {
  return proseWindow(archive, 1)[0] ?? "";
}

/** 参与角色的固定标签并集（去重；正文 lore 触发制的输入）。 */
export function participantTags(list: readonly { tags: string[] }[]): string[] {
  return [...new Set(list.flatMap((m) => m.tags))];
}
