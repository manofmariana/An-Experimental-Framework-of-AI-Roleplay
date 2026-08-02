import type { CharacterState } from "./charactersStore.js";
import { minutesToWorldTime, type TimeAnchor } from "./timeStore.js";

/**
 * 快照注入/展示层的 timer 渲染：程序内部状态始终是"分钟标量"（或 null / LEAVE_TIMER 冻结值），
 * 这里只在注入 LLM 快照时把 timer 渲染成与世界时钟一致的结构化时间。
 * 返回值与 CharacterState 同形、可 JSON 化，除 timer 外所有字段原样透传。
 */
export type SnapshotCharacterState = Omit<CharacterState, "timer"> & {
  timer: TimeAnchor | "已离开待结算" | null;
};

export function snapshotCharacterState(state: CharacterState): SnapshotCharacterState {
  const { timer, ...rest } = state;
  if (timer === null) return { ...rest, timer: null };
  // LEAVE_TIMER（Number.MAX_SAFE_INTEGER）：离开标记的冻结值，渲染为语义文本而非天文数字
  if (timer >= Number.MAX_SAFE_INTEGER) return { ...rest, timer: "已离开待结算" };
  return { ...rest, timer: minutesToWorldTime(timer) };
}

export function snapshotCharacterStates(
  states: Readonly<Record<string, CharacterState>>,
): Record<string, SnapshotCharacterState> {
  return Object.fromEntries(Object.entries(states).map(([cid, state]) => [cid, snapshotCharacterState(state)]));
}
