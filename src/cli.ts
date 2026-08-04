import readline from "node:readline";
import { SessionCoordinator } from "./application/sessionCoordinator.js";
import { loadAgentConfigs } from "./config.js";
import type { Display } from "./display.js";

const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const BRIGHT = "\x1b[97m";
const RESET = "\x1b[0m";

/**
 * CLI 显示层：角色/GM 的 JSON 原文用暗淡色流式回显（过程可见但不抢戏），
 * 思维链用暗淡+斜体（比 JSON 更弱一档，带一次性小标题"── 思考 ──"），
 * 正文用亮白色（玩家看到的最终文本，必须最醒目）。
 * 每个状态切换都显式发样式码（不依赖"上一段已复位"），杜绝 ANSI 泄漏。
 */
function makeDisplay(): Display {
  let dim = false;
  /** 当前调用是否正在/已经流过思维链（用于一次性标题与回归到内容流的切换） */
  let reasoning = false;
  const out = (s: string): void => {
    process.stdout.write(s);
  };
  const contentStyle = (): string => (dim ? DIM : BRIGHT);
  return {
    agentStart(agent, title) {
      dim = agent !== "prose";
      reasoning = false;
      out(`${RESET}\n${title}\n${contentStyle()}`);
    },
    reasoningDelta(_agent, text) {
      if (!reasoning) {
        reasoning = true;
        out(`${RESET}  ── 思考 ──\n${DIM}${ITALIC}`);
      }
      out(text);
    },
    delta(_agent, text) {
      if (reasoning) {
        // 思维链结束、正文/JSON 内容开始：复位后切回该 agent 的内容样式
        reasoning = false;
        out(`${RESET}\n${contentStyle()}`);
      }
      out(text);
    },
    agentEnd(_agent) {
      out(RESET);
      dim = false;
      reasoning = false;
      out("\n");
    },
    summary(_agent, text) {
      out(`${RESET}  ▸ ${text}\n`);
      if (dim) out(DIM);
    },
    retry(_agent, attempt, reason) {
      out(`${RESET}\n  [解析失败，重试（第 ${attempt + 1} 次）] ${reason.split("\n")[0]}\n${contentStyle()}`);
    },
  };
}

function printHelp(): void {
  console.log(
    [
      "命令：",
      "  /state          查看变量库（真相层状态）",
      "  /events         查看事件日志（唯一真相）",
      "  /stats          查看缓存命中埋点",
      "  /continue       按派生状态继续跑",
      "  /rollback <seq> 回溯到第 seq 步刚完成的位置",
      "  /reroll <seq>   重 roll：回到第 seq 步之前重跑（原子 rollback_and_continue）",
      "  /quit           退出",
      "其他输入即玩家意图（你说的话/做的事）。",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const configs = loadAgentConfigs();
  if (!configs) {
    console.error(
      [
        "未找到 LLM API Key，无法启动。",
        "任选一种方式配置：",
        "  1. 复制 config.example.json 为 config.json，填入 api_key（可在 agents 块给单个 agent 单独配置）；",
        '  2. 设置环境变量：export DEEPSEEK_API_KEY="sk-..."',
        "可选：base_url（默认 https://api.deepseek.com）、model（默认 deepseek-chat），环境变量优先于 config.json 顶层。",
      ].join("\n"),
    );
    process.exit(1);
  }

  const coordinator = new SessionCoordinator(makeDisplay);
  const runId = await coordinator.execute({ type: "new_session" });
  console.log(`Agent-AIRP P1-M2a · 运行目录 runs/${runId}/`);
  console.log(
    `模型：角色=${configs.character.model} · GM=${configs.gm.model} · 正文=${configs.prose.model}`,
  );
  printHelp();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (): Promise<string> =>
    new Promise((resolve) => rl.question("\n> ", (ans) => resolve(ans.trim())));

  for (;;) {
    const line = await ask();
    if (line === "") continue;

    if (line === "/quit") break;
    if (line === "/state") {
      console.log(JSON.stringify(coordinator.query("snapshot").state, null, 2));
      continue;
    }
    if (line === "/events") {
      for (const e of coordinator.query("snapshot").events) {
        console.log(`[${e.id}] (${e.kind}) ${e.payload}`);
      }
      continue;
    }
    if (line === "/stats") {
      const stats = coordinator.query("stats") as { turn: number; agent: string; hit: number; miss: number; output: number }[];
      if (stats.length === 0) {
        console.log("（尚无 LLM 调用）");
        continue;
      }
      for (const s of stats) {
        const total = s.hit + s.miss;
        const ratio = total > 0 ? ((s.hit / total) * 100).toFixed(1) : "0.0";
        console.log(
          `#${s.turn} ${s.agent}  hit=${s.hit} miss=${s.miss} 命中率=${ratio}% output=${s.output}`,
        );
      }
      continue;
    }

    try {
      if (line === "/continue") {
        await coordinator.execute({ type: "continue" });
      } else if (line.startsWith("/rollback ")) {
        await coordinator.execute({ type: "rollback", targetSeq: Number(line.slice("/rollback ".length)) });
      } else if (line.startsWith("/reroll ")) {
        await coordinator.execute({ type: "rollback_and_continue", targetSeq: Number(line.slice("/reroll ".length)) });
      } else {
        // 正文已由显示层流式输出，这里不再重复打印
        await coordinator.execute({ type: "player_input", text: line });
      }
    } catch (err) {
      console.error(`\n[错误] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  rl.close();
  console.log("已退出。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
