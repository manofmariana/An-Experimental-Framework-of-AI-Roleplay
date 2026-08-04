/**
 * 运行时端口（无 DI 容器，构造参数注入）：
 * 墙钟 / ID 生成 / 骰子。Clock.now() 仅现实时间（run ID、日志用），与 Truth 的 world.time 无关。
 */

/** 现实时钟（仅 run ID 等运维用途；游戏内时间走 world.time，勿混用）。 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** ID 生成端口（run ID 空间；事件 ID 另有计数器，见 loop.ts nextEventId）。 */
export interface IdPorts {
  newRunId(): string;
}

/** 默认 run ID 生成器：run-{ISO 时间戳}（冒号/点转连字符）。 */
export function createRunIdGenerator(clock: Clock = systemClock): IdPorts {
  return { newRunId: () => `run-${clock.now().toISOString().replace(/[:.]/g, "-")}` };
}

export const systemIds: IdPorts = createRunIdGenerator();

/** 单骰端口：投一个 face 面骰，返回 1..face（测试注入确定性序列，回滚不重投）。 */
export type DicePort = (face: number) => number;

export const defaultDice: DicePort = (face) => 1 + Math.floor(Math.random() * face);

export type DiceKeep = "high" | "low";

/**
 * 统一投掷（骰子随机源唯一出口）：每次投掷 = dice 个 face 面骰全部投出求和；
 * 共投 times 次，从 times 个总和中取最高（keep="high"）或最低（keep="low"）的一次。
 * face/dice/times 须为正整数，否则抛错。
 */
export function rollDice(port: DicePort, face: number, dice = 1, times = 1, keep: DiceKeep = "high"): number {
  for (const [name, v] of [["face", face], ["dice", dice], ["times", times]] as const) {
    if (!Number.isInteger(v) || v <= 0) throw new Error(`rollDice: ${name} 须为正整数，收到 ${v}`);
  }
  let best: number | undefined;
  for (let t = 0; t < times; t++) {
    let sum = 0;
    for (let d = 0; d < dice; d++) sum += port(face);
    if (best === undefined || (keep === "high" ? sum > best : sum < best)) best = sum;
  }
  return best!;
}
