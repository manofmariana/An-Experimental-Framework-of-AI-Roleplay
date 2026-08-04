/**
 * 测试套件运行器：读 scripts/test-suites.json，spawn
 * `node --import tsx --test <files...>` 并透传退出码。
 * 用法：tsx scripts/run-suite.ts <unit|contract|application|integration>
 *
 * 四层分层判据（JSON 不支持注释，判据记在这里）：
 * - unit：严格零 IO 纯逻辑（不读盘、不触网、不依赖 data/ 资产）。
 * - contract：外部格式/文件 codec——读 data/assets（世界包与包内提示词）等资产、
 *   truth Store 文件系统语义、前端文件与存档格式的读写回环（临时目录，不起服务）。
 * - application：GameSession/agent 级行为——fake ChatPort + 临时世界设定集，不起 HTTP/WS。
 * - integration：真实 HTTP/WS 端到端（起 server/socket）。
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const suite = process.argv[2];
const suites = JSON.parse(
  readFileSync(path.join(here, "test-suites.json"), "utf8"),
) as Record<string, string[]>;

if (!suite || !(suite in suites)) {
  console.error(`用法: tsx scripts/run-suite.ts <${Object.keys(suites).join("|")}>`);
  process.exit(2);
}

const files = suites[suite]!;
console.log(`[suite] ${suite}: ${files.length} 个测试文件`);
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) {
  console.error(`[suite] 启动失败: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
