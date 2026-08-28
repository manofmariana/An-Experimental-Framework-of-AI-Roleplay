import type { CharacterState } from "./charactersStore.js";
import { minutesToWorldTime, type TimeAnchor } from "../vars/systemWorld.js";

/**
 * 快照注入/展示层的 timer 渲染：程序内部状态始终是"分钟标量"（或 null = 无计时器），
 * 这里只在注入 LLM 快照时把 timer 渲染成与世界时钟一致的结构化时间。
 * 返回值与 CharacterState 同形、可 JSON 化，除 timer 外所有字段原样透传。
 */
export type SnapshotCharacterState = Omit<CharacterState, "timer"> & {
  timer: TimeAnchor | null;
};

export function snapshotCharacterState(state: CharacterState): SnapshotCharacterState {
  const { timer, ...rest } = state;
  if (timer === null) return { ...rest, timer: null };
  return { ...rest, timer: minutesToWorldTime(timer) };
}

export function snapshotCharacterStates(
  states: Readonly<Record<string, CharacterState>>,
): Record<string, SnapshotCharacterState> {
  return Object.fromEntries(Object.entries(states).map(([cid, state]) => [cid, snapshotCharacterState(state)]));
}

// ---------------------------------------------------------------------------
// 只读快照
// ---------------------------------------------------------------------------

/** 递归 readonly 映射：查询出口（getState/getEvents/snapshot 等）的返回类型，编译期挡写入。 */
export type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends (...args: never[]) => unknown
    ? T
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/**
 * 递归 Object.freeze（恒冻结策略：本地私有应用，无生产模式分叉）。
 * 接线点：GenerationRepository.loadGeneration 返回前 + GameSession 每次 commit/adopt 后——
 * 让绕过 VarChange/校验的越界写入在测试中立刻抛 TypeError，而不是静默污染真相。
 * 幂等（重复冻结同一对象安全）；Store 内部变异全部是容器级替换式，不受冻结影响。
 */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
