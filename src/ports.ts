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

/** d20 骰子（先攻投掷用；测试注入确定性序列，回滚不重投）。 */
export type DicePort = () => number;

export const defaultDice: DicePort = () => 1 + Math.floor(Math.random() * 20);
