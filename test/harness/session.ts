/**
 * GameSession 级测试 harness：收敛各 application 测试反复手写的装配——
 * 临时根（save/ + assets/，随套件结束自动清理）+ FakeChatScript + 确定性骰子队列
 * + 临时世界包构造（含包内 prompts/ 四份模板 + incident.json，从真实默认包拷贝模板）。
 * GameSession 的注入点（SessionOptions.baseDir/assetsDir/chatPorts/rollDice）
 * 为既有生产端口，harness 只做组装，不改生产行为。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AGENT_KINDS, resolveWorldDir, type AgentKind, type LLMConfig } from "../../src/config.js";
import type { GameSession } from "../../src/application/gameSession.js";
import {
  createGameSession,
  loadPackPlaceholders,
  loadPackPrompts,
  resumeGameSession,
  type SessionOptions,
} from "../../src/application/sessionFactory.js";
import { packPromptsDir } from "../../src/resources/worldRepository.js";
import type { CharacterState } from "../../src/truth/charactersStore.js";
import { PromptsStore } from "../../src/truth/promptsStore.js";
import { buildManifest, buildTagRegistryRaw, TEST_VARS_TEMPLATE_RAW } from "../builders/index.js";
import { FakeChatScript, type RecordedCall } from "../fakes/chatPort.js";
import { tempDir } from "./tempDir.js";

/** 出厂四份模板 + 占位符目录 → PromptsStore（activation 直构造测试注入用；读真实默认包）。 */
export function factoryPromptsStore(): PromptsStore {
  const worldDir = resolveWorldDir();
  const catalog = loadPackPlaceholders(worldDir);
  return PromptsStore.initFrom(loadPackPrompts(worldDir, catalog), catalog);
}

/** 世界构图单元：一个角色。isPlayer 的进 player.json（恰一个），其余入 characters/。 */
export interface CharSpec {
  id: string;
  name: string;
  location?: string;
  /** 地点 level（突发错位度输入；缺省 1） */
  locationLevel?: number;
  /** 角色 level（缺省 1） */
  level?: number;
  timer?: number | null;
  isPlayer?: boolean;
  /** manifest 初始变量树（原始形状，装配时按 character 模板 normalize） */
  vars?: Record<string, unknown>;
}

/** 突发公式默认配置（与 baitan 标定 v1 同形状同值；测试世界包的 incident.json）。 */
const DEFAULT_INCIDENT_CONFIG = {
  d: {
    method: "log_ratio",
    log_ratio: { expr: "kappa * ln((L_loc + c) / (L_geo + c))", consts: { kappa: 33, c: 10 } },
    absolute_diff: { expr: "L_loc - L_avg" },
  },
  f: {
    expr: "(base + amp * tanh((D - shift) / densityScale) ^ 2) * (floor + (1 - floor) * sigmoid((D - shift) / compressScale))",
    consts: { base: 0.3, amp: 0.7, shift: 3, densityScale: 24, floor: 0.4, compressScale: 8 },
  },
  g: { expr: "sigmoid(a * ln(T) - b)", consts: { a: 0.4205, b: 4.1531 } },
  p_hit: { expr: "f * g" },
  p_malign: { expr: "clamp(D + offset, 0, 100)", consts: { offset: 50 } },
  severity: { expr: "f * scale + offset + (2d20 - 2) - (d20 - 1)", consts: { scale: 50, offset: 10 } },
};

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
  setupWorld(worldId: string, specs: CharSpec[], opts?: { varsTemplate?: unknown }): void {
    const dir = path.join(this.assetsDir, worldId);
    fs.mkdirSync(path.join(dir, "characters"), { recursive: true });
    fs.writeFileSync(path.join(dir, "setting.md"), "测试世界设定\n");
    fs.writeFileSync(path.join(dir, "tone-card.md"), "测试基调\n");
    fs.writeFileSync(path.join(dir, "lorebook.json"), "[]\n");
    // 包内提示词四副本（三 activation + gm-incident 突发变体）+ 占位符目录：从真实默认包拷贝
    // （新档装配读取校验后拷入档内 prompts.json）
    const from = packPromptsDir(resolveWorldDir());
    const to = packPromptsDir(dir);
    fs.mkdirSync(to, { recursive: true });
    for (const agent of [...AGENT_KINDS, "gm-incident"]) {
      fs.copyFileSync(path.join(from, `${agent}.prompt.json`), path.join(to, `${agent}.prompt.json`));
    }
    fs.copyFileSync(path.join(from, "placeholders.json"), path.join(to, "placeholders.json"));
    // 突发公式配置（装配启动校验必需）
    fs.writeFileSync(path.join(dir, "incident.json"), JSON.stringify(DEFAULT_INCIDENT_CONFIG, null, 2) + "\n");
    // 变量体系三文件（装配启动校验必需）：tags.json = system 条目（含 cid/channel/location
    // 三类别条目，builders 唯一出处）；vars-template = 测试变量模板（builders 唯一出处，
    // 可经 opts.varsTemplate 覆盖）；vars-tags = 空结构
    fs.writeFileSync(path.join(dir, "tags.json"), JSON.stringify(buildTagRegistryRaw(), null, 2) + "\n");
    fs.writeFileSync(path.join(dir, "vars-template.json"), JSON.stringify(opts?.varsTemplate ?? TEST_VARS_TEMPLATE_RAW, null, 2) + "\n");
    fs.writeFileSync(path.join(dir, "vars-tags.json"), JSON.stringify({ world: {}, character: {} }, null, 2) + "\n");
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
        location: { name: spec.location ?? "loc_A", level: spec.locationLevel ?? 1 },
        level: spec.level ?? 1,
        timer: spec.timer === undefined ? 0 : spec.timer,
        isPlayer: spec.isPlayer === true,
        vars: spec.vars ?? { attachtags: ["aud", "vis"] }, // 测试世界角色默认可听可视（感知 TAG = 内容侧持有）
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

  /** 写一代 Generation（generations/{rev}/ 七文件 JSON + CURRENT 指向；fixture 迁移一次性收口）。 */
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

  /** world 树的 `_sys` 程序分支（程序计数键读取口）。 */
  worldSys(session: GameSession): Record<string, unknown> {
    return this.worldVars(session)["_sys"] as Record<string, unknown>;
  }
}
