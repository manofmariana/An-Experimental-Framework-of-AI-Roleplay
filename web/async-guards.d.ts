/**
 * web/async-guards.js 的类型声明（供 TS 测试 import；权威运行时行为见 async-guards.js）。
 */
export interface EpochGuard {
  begin(): number;
  isCurrent(token: number): boolean;
}
export function createEpochGuard(): EpochGuard;

export interface RunDetail {
  events: Array<Record<string, unknown>>;
  world: Record<string, unknown>;
  pipeline: Record<string, unknown>;
  characters: Record<string, unknown>;
  archive: Array<Record<string, unknown>>;
  stats: Array<Record<string, unknown>>;
}
export function fetchRunDetail(apiFn: (path: string) => Promise<unknown>, id: string): Promise<RunDetail>;

export interface CharsIdentity {
  runId: string | null;
  worldSetId?: string;
}
export interface KnownChar {
  cid: string;
  name: string;
}
export function fetchKnownChars(
  apiFn: (path: string) => Promise<unknown>,
  identity: CharsIdentity,
): Promise<KnownChar[]>;
export function sameCharsIdentity(captured: CharsIdentity, current: CharsIdentity): boolean;

export function isModalLive(
  capturedRunId: string | null,
  currentRunId: string | null,
  isConnected: boolean,
): boolean;

export function loadSessionThenNavigate(
  deps: {
    sendCommand: (type: string, fields?: Record<string, unknown>) => Promise<unknown>;
    navigate: (page: string) => unknown;
  },
  runId: string,
): Promise<void>;
