/**
 * GameSession 级测试 harness：收敛各 application 测试反复手写的装配——
 * 临时根（save/ + assets/，随套件结束自动清理）+ FakeChatScript + 确定性骰子队列
 * + 临时世界包构造（含包内 prompts/，从真实默认包拷贝三份模板）。
 * GameSession 的注入点（SessionOptions.baseDir/assetsDir/chatPorts/rollDice）
 * 为既有生产端口，harness 只做组装，不改生产行为。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AGENT_KINDS, resolveWorldDir, type AgentKind, type LLMConfig } from "../../src/config.js";
import type { GameSession } from "../../src/application/gameSession.js";
import { createGameSession, resumeGameSession, type SessionOptions } from "../../src/application/sessionFactory.js";
import { packPromptsDir } from "../../src/resources/worldRepository.js";
import type { CharacterState } from "../../src/truth/charactersStore.js";
import { buildManifest } from "../builders/index.js";
import { FakeChatScript, type RecordedCall } from "../fakes/chatPort.js";
import { tempDir } from "./tempDir.js";

/** 世界构图单元：一个角色。isPlayer 的进 player.json（恰一个），其余入 characters/。 */
export interface CharSpec {
  id: string;
  name: string;
  location?: string;
  timer?: number | null;
  isPlayer?: boolean;
}

const DUMMY_CFG: LLMConfig = { apiKey: "dummy", baseURL: "http://127.0.0.1:9", model: "m", jsonMode: false };

export class SessionHarness {
  readonly root: string;
  readonly saveDir: string;
  readonly assetsDir: string;
  readonly llm = new FakeChatScript();
  readonly configs: Record<AgentKind, LLMConfig> = { character: DUMMY_CFG, gm: DUMMY_CFG, prose: DUMMY_CFG };
  /** 先攻骰子队列（rollDice 依序消费；耗尽抛错——暴露预期外的先攻投掷）。 */
  diceQueue: number[] = [];

  constructor(prefix = "airp-session-") {
    this.root = tempDir(prefix);
    this.saveDir = path.join(this.root, "save");
    this.assetsDir = path.join(this.root, "assets");
  }

  /** 全部已记录 LLM 调用（含被 abort 的）。 */
  get calls(): readonly RecordedCall[] {
    return this.llm.port.calls;
  }

  /** 每测试独立世界包：写 setting/tone-card/lorebook/time + 各角色 manifest + 包内 prompts/。 */
  setupWorld(worldId: string, specs: CharSpec[]): void {
    const dir = path.join(this.assetsDir, worldId);
    fs.mkdirSync(path.join(dir, "characters"), { recursive: true });
    fs.writeFileSync(path.join(dir, "setting.md"), "测试世界设定\n");
    fs.writeFileSync(path.join(dir, "tone-card.md"), "测试基调\n");
    fs.writeFileSync(path.join(dir, "lorebook.json"), "[]\n");
    // 包内提示词三副本：从真实默认包拷贝（activation 热加载与装配启动校验都读包内 prompts/）
    const from = packPromptsDir(resolveWorldDir());
    const to = packPromptsDir(dir);
    fs.mkdirSync(to, { recursive: true });
    for (const agent of AGENT_KINDS) {
      fs.copyFileSync(path.join(from, `${agent}.prompt.json`), path.join(to, `${agent}.prompt.json`));
    }
    fs.writeFileSync(
      path.join(dir, "time.json"),
      JSON.stringify({ start: { y: 0, m: 1, d: 1, h: 0, min: 0 }, periods: [{ key: "白天", from: 0, to: 24 }] }),
    );
    for (const spec of specs) {
      const file = spec.isPlayer === true
        ? path.join(dir, "player.json")
        : path.join(dir, "characters", `${spec.id}.json`);
      fs.writeFileSync(file, JSON.stringify(buildManifest({
        id: spec.id,
        name: spec.name,
        personality: `${spec.name}谨慎。`,
        initial_memories: [`${spec.name}的记忆`],
        location: { name: spec.location ?? "loc_A", level: 1 },
        timer: spec.timer === undefined ? 0 : spec.timer,
        isPlayer: spec.isPlayer === true,
      })));
    }
  }

  /**
   * SessionOptions 基座：临时 baseDir/assetsDir + fake ChatPort + 队列骰子。
   * 需要真实 OpenAI adapter 的测试（reloadConfig）可经 overrides 显式去掉 chatPorts。
   */
  sessionOptions(runId: string, overrides?: Partial<SessionOptions>): SessionOptions {
    const base: SessionOptions = {
      baseDir: path.join(this.saveDir, runId),
      assetsDir: this.assetsDir,
      proseWindowTurns: 5,
      chatPorts: this.llm.ports,
      rollDice: () => {
        const v = this.diceQueue.shift();
        if (v === undefined) throw new Error("骰子队列耗尽（出现预期外的先攻投掷）");
        return v;
      },
    };
    return { ...base, ...overrides };
  }

  /** 重置 fake LLM（calls/gm 队列/abort/character 队列）与骰子队列后建会话。 */
  makeSession(
    runId: string,
    worldId: string,
    opts?: {
      dice?: number[];
      gm?: Record<string, unknown>[];
      gmIntervalCycles?: number;
      options?: Partial<SessionOptions>;
    },
  ): GameSession {
    this.diceQueue = [...(opts?.dice ?? [])];
    this.llm.port.calls.length = 0;
    this.llm.gmQueue = [...(opts?.gm ?? [])];
    this.llm.abortAt = null;
    this.llm.characterQueues = {};
    return createGameSession(
      this.configs,
      runId,
      undefined,
      worldId,
      this.sessionOptions(runId, { gmIntervalCycles: opts?.gmIntervalCycles ?? 3, ...opts?.options }),
    );
  }

  /** 纯数据续档（不重置 fake LLM——续档测试通常在步间调用）。 */
  resumeSession(
    runId: string,
    opts?: { gmIntervalCycles?: number; options?: Partial<SessionOptions> },
  ): GameSession {
    return resumeGameSession(
      this.configs,
      runId,
      undefined,
      this.sessionOptions(runId, { gmIntervalCycles: opts?.gmIntervalCycles ?? 3, ...opts?.options }),
    );
  }

  /** 读存档真相文件原文（存档 v6：经 CURRENT 解析到当前 Generation；逐字节断言用）。 */
  runFile(runId: string, file: string): string {
    return this.readGenerationFile(runId, "current", file);
  }

  /** 写一代 Generation（generations/{rev}/ 六文件 JSON + CURRENT 指向；fixture 迁移一次性收口）。 */
  writeGeneration(dir: string, rev: number, files: Record<string, unknown>): void {
    const name = String(rev).padStart(6, "0");
    const genDir = path.join(dir, "generations", name);
    fs.mkdirSync(genDir, { recursive: true });
    for (const [file, data] of Object.entries(files)) {
      fs.writeFileSync(path.join(genDir, file), JSON.stringify(data, null, 2) + "\n", "utf8");
    }
    fs.writeFileSync(path.join(dir, "CURRENT"), name, "utf8");
  }

  /** 读某代（rev 数字）或 CURRENT 指向代（"current"）的真相文件原文。 */
  readGenerationFile(runId: string, rev: number | "current", file: string): string {
    const dir = path.join(this.saveDir, runId);
    const name =
      rev === "current"
        ? fs.readFileSync(path.join(dir, "CURRENT"), "utf8").trim()
        : String(rev).padStart(6, "0");
    return fs.readFileSync(path.join(dir, "generations", name, file), "utf8");
  }

  /** 某 agent 第 seq 次激活的全部消息文本（注入内容断言用）。 */
  callsText(agent: string, seq: number): string {
    const call = this.calls.find((c) => c.agent === agent && c.seq === seq);
    assert.ok(call, `缺少调用 ${agent}#${seq}`);
    return call.messages.map((m) => m.content).join("\n");
  }

  charState(session: GameSession, cid: string): CharacterState {
    const state = (session.getState().characters as Record<string, CharacterState>)[cid];
    assert.ok(state, `缺少角色 ${cid}`);
    return state;
  }

  worldVars(session: GameSession): Record<string, unknown> {
    return session.getState().world as Record<string, unknown>;
  }
}
