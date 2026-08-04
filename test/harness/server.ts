/**
 * 服务端集成测试 harness（优化阶段 D2）：tempDir + fake SessionFactory（真实
 * GameSession + DeferredChatPort）+ 随机端口真实 http/ws 服务 + 真实 ws 客户端 helper。
 * 与 SessionHarness 组合（复用其世界设定集构造与 SessionOptions 基座），
 * LLM 端口换成 DeferredChatPort（挂起/手动完成/abort 语义由测试控制）。
 */
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { TestContext } from "node:test";
import WebSocket from "ws";
import { SessionCoordinator } from "../../src/application/sessionCoordinator.js";
import {
  createGameSession,
  resumeGameSession,
  type SessionFactory,
} from "../../src/application/sessionFactory.js";
import type { ChatPort } from "../../src/llm/chatPort.js";
import type { AgentKind } from "../../src/config.js";
import { resolveUserDirectories, type UserDirectories } from "../../src/resources/userDirectories.js";
import { startServer } from "../../src/server/index.js";
import { DeferredChatPort } from "../fakes/deferredChatPort.js";
import { SessionHarness, type CharSpec } from "./session.js";

/** 真实 ws 测试客户端：消息全录 + 谓词等待（先查积压再等新到）。 */
export interface WsClient {
  readonly messages: Record<string, unknown>[];
  send(cmd: Record<string, unknown>): void;
  /** 等待满足谓词的消息（先扫已收积压）；超时 reject。 */
  waitFor(pred: (msg: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): void;
}

export interface ServerHarness {
  /** 会话装配基座（临时 runs/worlds、世界设定集构造、骰子队列）。 */
  readonly sessions: SessionHarness;
  readonly coordinator: SessionCoordinator;
  readonly deferred: DeferredChatPort;
  readonly server: Server;
  readonly port: number;
  /** 注入给 HTTP 层的用户资源目录（临时 runs/worlds/prompts，不触碰真实用户数据）。 */
  readonly dirs: UserDirectories;
  /** 注入的临时 config.json 路径（HTTP config 域读写目标）。 */
  readonly configFile: string;
  /** 新建真实 ws 客户端（connect 时若已有会话会先收一条 snapshot 单播）。 */
  connect(): Promise<WsClient>;
}

let runCounter = 0;

/**
 * 搭一个真实服务端：注入 coordinator（fake factory + 确定性 runId）+ port 0 随机端口。
 * worldId 缺省 "w"；dice 缺省给 64 颗确定性骰子（先攻投掷用，耗尽会抛错暴露预期外投掷）。
 */
export async function serverHarness(
  t: TestContext,
  opts?: { worldId?: string; chars?: CharSpec[]; dice?: number[] },
): Promise<ServerHarness> {
  const sessions = new SessionHarness("airp-server-");
  const worldId = opts?.worldId ?? "w";
  sessions.setupWorld(
    worldId,
    opts?.chars ?? [
      { id: "C0", name: "玩家", isPlayer: true, timer: 0 },
      { id: "C1", name: "同伴", timer: 0 },
    ],
  );
  sessions.diceQueue = [...(opts?.dice ?? Array.from({ length: 64 }, (_, i) => (i * 7) % 20 + 1))];

  const deferred = new DeferredChatPort();
  const ports: Record<AgentKind, ChatPort> = { character: deferred, gm: deferred, prose: deferred };
  const factory: SessionFactory = {
    create: (runId, worldSetId, display) =>
      createGameSession(
        sessions.configs,
        runId,
        display,
        worldSetId ?? worldId,
        sessions.sessionOptions(runId, { chatPorts: ports }),
      ),
    resume: (runId, display) =>
      resumeGameSession(sessions.configs, runId, display, sessions.sessionOptions(runId, { chatPorts: ports })),
  };
  const coordinator = new SessionCoordinator(
    () => ({}) as never, // displayFactory 由 startServer 重绑到本服 WebDisplay 广播
    { newRunId: () => `run-${String(++runCounter).padStart(4, "0")}` },
    factory,
  );

  // HTTP 层资源目录全部指向临时根（D3：startServer 注入 UserDirectories/configFile，测试不触碰真实用户数据）
  const dirs: UserDirectories = {
    ...resolveUserDirectories(),
    runsDir: sessions.runsDir,
    worldsDir: sessions.worldsDir,
    promptsDir: path.join(sessions.root, "prompts"),
  };
  const configFile = path.join(sessions.root, "config.json");

  const server = startServer({ host: "127.0.0.1", port: 0, coordinator, dirs, configFile });
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;

  const clients: WebSocket[] = [];
  t.after(
    () =>
      new Promise<void>((resolve) => {
        for (const ws of clients) ws.close();
        server.close(() => resolve());
      }),
  );

  return {
    sessions,
    coordinator,
    deferred,
    server,
    port,
    dirs,
    configFile,
    connect: () =>
      new Promise<WsClient>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        clients.push(ws);
        const messages: Record<string, unknown>[] = [];
        const waiters: {
          pred: (msg: Record<string, unknown>) => boolean;
          resolve: (msg: Record<string, unknown>) => void;
          reject: (err: Error) => void;
          timer: NodeJS.Timeout;
        }[] = [];
        ws.on("message", (data) => {
          const msg = JSON.parse(String(data)) as Record<string, unknown>;
          messages.push(msg);
          for (let i = waiters.length - 1; i >= 0; i--) {
            const w = waiters[i]!;
            if (w.pred(msg)) {
              clearTimeout(w.timer);
              waiters.splice(i, 1);
              w.resolve(msg);
            }
          }
        });
        ws.on("error", reject);
        ws.on("open", () =>
          resolve({
            messages,
            send: (cmd) => ws.send(JSON.stringify(cmd)),
            waitFor: (pred, timeoutMs = 5000) => {
              const backlog = messages.find(pred);
              if (backlog !== undefined) return Promise.resolve(backlog);
              return new Promise((resolveWait, rejectWait) => {
                const timer = setTimeout(() => rejectWait(new Error("waitFor 超时")), timeoutMs);
                waiters.push({ pred, resolve: resolveWait, reject: rejectWait, timer });
              });
            },
            close: () => ws.close(),
          }),
        );
      }),
  };
}
