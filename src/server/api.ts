import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  AGENT_KINDS,
  CONFIG_FILE,
  PROMPTS_DIR,
  RUNS_DIR,
  listWorldSets,
  resolveWorldDir,
  type AgentKind,
} from "../config.js";
import { CHARACTER_PLACEHOLDERS, CharacterManifestSchema } from "../agents/character.js";
import { GM_PLACEHOLDERS } from "../agents/gm.js";
import { PROSE_PLACEHOLDERS } from "../agents/prose.js";
import { placeholderCatalog, type PlaceholderRegistry } from "../compile/compiler.js";
import {
  PromptTemplateSchema,
  validateTemplate,
  type PromptTemplate,
} from "../compile/template.js";
import { readRecent } from "../llm/recent.js";
import { safeSegment } from "../shared/safeSegment.js";
import { LoreEntrySchema, type LoreEntry } from "../types.js";
import type { SessionManager } from "./sessionManager.js";

// ===========================================================================
// 纯逻辑（可单测）
// ===========================================================================

/** 顶层与 agents 块同规的字段类型表（json_mode 布尔、reasoning_effort 字符串原样透传） */
const CONFIG_FIELD_TYPES: Record<string, "string" | "boolean"> = {
  api_key: "string",
  base_url: "string",
  model: "string",
  json_mode: "boolean",
  reasoning_effort: "string",
};
const TYPE_LABEL = { string: "字符串", boolean: "布尔值" } as const;
const AGENT_KIND_NAMES = ["character", "gm", "prose"] as const;

/**
 * 校验 config.json 结构（PUT /api/config 前置闸）。
 * 已知字段查类型；未知顶层字段（如 "_说明" 注释）原样保留。
 * 返回通过校验的原对象，结构非法抛中文错误。
 */
export function validateConfigPayload(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("配置必须是 JSON 对象");
  }
  const obj = raw as Record<string, unknown>;
  for (const [key, type] of Object.entries(CONFIG_FIELD_TYPES)) {
    if (obj[key] !== undefined && typeof obj[key] !== type) {
      throw new Error(`${key} 必须是${TYPE_LABEL[type]}`);
    }
  }
  if (
    obj.gm_interval_cycles !== undefined &&
    (typeof obj.gm_interval_cycles !== "number" ||
      !Number.isInteger(obj.gm_interval_cycles) ||
      obj.gm_interval_cycles < 1)
  ) {
    throw new Error("gm_interval_cycles 必须是 ≥1 的整数");
  }
  if (obj.agents !== undefined) {
    const agents = obj.agents;
    if (typeof agents !== "object" || agents === null || Array.isArray(agents)) {
      throw new Error("agents 必须是对象");
    }
    for (const [kind, block] of Object.entries(agents as Record<string, unknown>)) {
      if (!(AGENT_KIND_NAMES as readonly string[]).includes(kind)) {
        throw new Error(`agents 含未知 agent：${kind}（只允许 character / gm / prose）`);
      }
      if (typeof block !== "object" || block === null || Array.isArray(block)) {
        throw new Error(`agents.${kind} 必须是对象`);
      }
      for (const [k, v] of Object.entries(block as Record<string, unknown>)) {
        const type = CONFIG_FIELD_TYPES[k];
        if (type === undefined) {
          throw new Error(`agents.${kind} 含未知字段：${k}`);
        }
        if (v !== undefined && typeof v !== type) {
          throw new Error(`agents.${kind}.${k} 必须是${TYPE_LABEL[type]}`);
        }
      }
    }
  }
  if (obj.memory !== undefined) {
    const memory = obj.memory;
    if (typeof memory !== "object" || memory === null || Array.isArray(memory)) {
      throw new Error("memory 必须是对象");
    }
    for (const [k, v] of Object.entries(memory as Record<string, unknown>)) {
      if (k !== "prose_window_turns") {
        throw new Error(`memory 含未知字段：${k}（只允许 prose_window_turns）`);
      }
      if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < 0)) {
        throw new Error("memory.prose_window_turns 必须是非负整数");
      }
    }
  }
  return obj;
}

/** 校验 lorebook 条目数组（PUT /api/world/lorebook 前置闸），ID 重复即拒。 */
export function validateLorebookPayload(raw: unknown): LoreEntry[] {
  const entries = z.array(LoreEntrySchema).parse(raw);
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.id)) throw new Error(`lorebook 条目 ID 重复: ${e.id}`);
    seen.add(e.id);
  }
  return entries;
}

/**
 * 路径安全段校验已迁至 src/shared/safeSegment.ts（供 transport / SessionManager / resources 共用）。
 */

export interface RunInfo {
  id: string;
  mtimeMs: number;
  /** 存档别名（save-meta.json；无则前端回退显示 id） */
  alias?: string;
}

const SaveMetaSchema = z.object({ alias: z.string() });

function readAlias(dir: string): string | undefined {
  const file = path.join(dir, "save-meta.json");
  if (!fs.existsSync(file)) return undefined;
  try {
    return SaveMetaSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))).alias;
  } catch {
    return undefined;
  }
}

/** 列出 runs/ 下的会话目录（按修改时间倒序；只认目录；附别名）。 */
export function listRuns(runsDir: string): RunInfo[] {
  if (!fs.existsSync(runsDir)) return [];
  return fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(runsDir, d.name);
      const alias = readAlias(dir);
      const info: RunInfo = { id: d.name, mtimeMs: fs.statSync(dir).mtimeMs };
      if (alias !== undefined) info.alias = alias;
      return info;
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 校验存档别名：去空白后 1-50 字符，拒绝路径字符与控制字符。 */
export function validateAlias(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("alias 必须是字符串");
  const alias = raw.trim();
  if (alias.length === 0 || alias.length > 50) {
    throw new Error("alias 长度须为 1-50 字符");
  }
  if (/[/\\<>:"|?*\x00-\x1f]|\.\./.test(alias)) {
    throw new Error("alias 含非法字符");
  }
  return alias;
}

/** 写存档别名（runs/{id}/save-meta.json）。 */
export function writeAlias(runsDir: string, id: string, alias: string): void {
  const dir = path.join(runsDir, safeSegment(id));
  if (!fs.existsSync(dir)) throw new Error(`存档不存在: ${id}`);
  fs.writeFileSync(
    path.join(dir, "save-meta.json"),
    JSON.stringify({ alias: validateAlias(alias) }, null, 2) + "\n",
    "utf8",
  );
}

/** 删除存档目录（拒绝删除当前活跃会话）。 */
export function deleteRun(runsDir: string, id: string, activeRunId: string | null): void {
  const safe = safeSegment(id);
  if (safe === activeRunId) throw new Error("不能删除进行中的会话");
  const dir = path.join(runsDir, safe);
  if (!fs.existsSync(dir)) throw new Error(`存档不存在: ${safe}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

export type RunArtifactKind = "events" | "world" | "characters" | "archive" | "lore" | "stats";

function readJsonl(file: string): unknown[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function readJson(file: string, fallback: unknown): unknown {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

/** 读历史会话产物（回放用，存档 v2 五文件 + stats）。id 先过 safeSegment。 */
export function readRunArtifact(runsDir: string, id: string, kind: RunArtifactKind): unknown {
  const dir = path.join(runsDir, safeSegment(id));
  switch (kind) {
    case "events":
      return readJson(path.join(dir, "events.json"), { schema_version: null, events: [] });
    case "world":
      return readJson(path.join(dir, "world.json"), {});
    case "characters":
      return readJson(path.join(dir, "characters.json"), { schema_version: null, characters: {} });
    case "archive":
      return readJson(path.join(dir, "archive.json"), { schema_version: null, entries: [] });
    case "lore":
      return readJson(path.join(dir, "lore.json"), { schema_version: null, entries: [], changelog: [] });
    case "stats":
      return readJsonl(path.join(dir, "cache-stats.jsonl"));
  }
}

export function validateCharacterManifestForPath(id: string, raw: unknown) {
  const manifest = CharacterManifestSchema.parse(raw);
  if (manifest.id !== id) throw new Error(`manifest.id（${manifest.id}）与路径 id（${id}）不一致`);
  if (id === "C0" && !manifest.isPlayer) throw new Error("C0 必须标记 isPlayer=true");
  if (id !== "C0" && manifest.isPlayer) throw new Error(`只有 C0 可以标记 isPlayer=true: ${id}`);
  return manifest;
}

export function characterManifestFile(worldDir: string, id: string): string {
  const safe = safeSegment(id);
  return safe === "C0" ? path.join(worldDir, "player.json") : path.join(worldDir, "characters", `${safe}.json`);
}

export function listCharacterManifests(worldDir: string): { id: string; manifest: unknown }[] {
  const dir = path.join(worldDir, "characters");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((file) => file.endsWith(".json")) : [];
  const all = ["C0", ...files.map((file) => file.slice(0, -".json".length))];
  return all.map((id) => ({
    id,
    manifest: JSON.parse(fs.readFileSync(characterManifestFile(worldDir, id), "utf8")) as unknown,
  }));
}

const WORLD_FILES = {
  setting: "setting.md",
  "tone-card": "tone-card.md",
  lorebook: "lorebook.json",
} as const;
type WorldName = keyof typeof WORLD_FILES;

/** 世界文件路径（?set= 指定世界设定集，缺省默认集）。 */
function worldPath(name: WorldName, setId?: string): string {
  return path.join(resolveWorldDir(setId), WORLD_FILES[name]);
}

// ---------------------------------------------------------------------------
// 提示词模板（data/prompts/{agent}.prompt.json；占位符目录从注册表自动导出）
// ---------------------------------------------------------------------------

const PROMPT_REGISTRIES: Record<AgentKind, PlaceholderRegistry<never>> = {
  character: CHARACTER_PLACEHOLDERS,
  gm: GM_PLACEHOLDERS,
  prose: PROSE_PLACEHOLDERS,
};

/** 每个 agent 的可用占位符目录（GET /api/prompts/placeholders）。 */
export function placeholdersCatalog(): {
  agent: AgentKind;
  placeholders: { key: string; description: string }[];
}[] {
  return AGENT_KINDS.map((agent) => ({
    agent,
    placeholders: placeholderCatalog(PROMPT_REGISTRIES[agent]),
  }));
}

/** 读取三个模板全文（GET /api/prompts；结构校验，内容原样返回）。 */
export function readPromptTemplates(): PromptTemplate[] {
  return AGENT_KINDS.map((agent) =>
    PromptTemplateSchema.parse(
      JSON.parse(fs.readFileSync(path.join(PROMPTS_DIR, `${agent}.prompt.json`), "utf8")),
    ),
  );
}

/**
 * 校验 PUT 模板（结构 + 占位符合法性，对应该 agent 注册表）；
 * 未知占位符抛错并列出名字（API 层转 400）。
 */
export function validatePromptPayload(agent: AgentKind, raw: unknown): PromptTemplate {
  const template = validateTemplate(raw, Object.keys(PROMPT_REGISTRIES[agent]));
  if (template.id !== agent) {
    throw new Error(`模板 id（${template.id}）与路径（${agent}）不一致`);
  }
  return template;
}

// ===========================================================================
// HTTP 路由（impure，薄壳）
// ===========================================================================

function sendJson(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}

function requireStringField(obj: unknown, field: string): string {
  const value = (obj as Record<string, unknown>)?.[field];
  if (typeof value !== "string") throw new Error(`请求体缺少字符串字段: ${field}`);
  return value;
}

/**
 * 管理 API 路由。返回 true = 已处理（/api/*），false = 非 API 路径。
 * 写操作（PUT）生效规则：config 域热重载立即生效；world/character 域 markStale 后下次 new_session 生效；prompts 域热加载下一轮生效。
 */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  manager: SessionManager,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/")) return false;

  try {
    const segments = pathname.slice("/api/".length).split("/").filter(Boolean);
    const domain = segments[0];

    // ---- config ----
    if (domain === "config" && segments.length === 1) {
      if (req.method === "GET") {
        const data = fs.existsSync(CONFIG_FILE)
          ? (JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as unknown)
          : {};
        sendJson(res, 200, data);
        return true;
      }
      if (req.method === "PUT") {
        const config = validateConfigPayload(parseJsonBody(await readBody(req)));
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf8");
        // config 域专属：热重载到运行中会话（立即生效），不走 markStale/新会话生效
        manager.reloadConfig();
        sendJson(res, 200, { ok: true, note: "已保存，立即生效" });
        return true;
      }
    }

    // ---- world ----
    if (domain === "world") {
      const set = url.searchParams.get("set") ?? undefined;
      if (segments.length === 1 && req.method === "GET") {
        sendJson(res, 200, {
          setting: fs.readFileSync(worldPath("setting", set), "utf8"),
          toneCard: fs.readFileSync(worldPath("tone-card", set), "utf8"),
          lorebook: JSON.parse(fs.readFileSync(worldPath("lorebook", set), "utf8")) as unknown,
        });
        return true;
      }
      const name = segments[1] as WorldName | undefined;
      if (segments.length === 2 && req.method === "PUT" && name && name in WORLD_FILES) {
        if (name === "lorebook") {
          const entries = validateLorebookPayload(parseJsonBody(await readBody(req)));
          fs.writeFileSync(worldPath(name, set), JSON.stringify(entries, null, 2) + "\n", "utf8");
        } else {
          const content = requireStringField(parseJsonBody(await readBody(req)), "content");
          fs.writeFileSync(worldPath(name, set), content, "utf8");
        }
        manager.markStale();
        sendJson(res, 200, { ok: true, note: "已保存，修改在新会话生效" });
        return true;
      }
    }

    // ---- worlds（世界设定集列表）----
    if (domain === "worlds" && segments.length === 1 && req.method === "GET") {
      sendJson(res, 200, { sets: listWorldSets() });
      return true;
    }

    // ---- characters ----
    if (domain === "characters") {
      const worldDir = resolveWorldDir(url.searchParams.get("set") ?? undefined);
      if (segments.length === 1 && req.method === "GET") {
        sendJson(res, 200, listCharacterManifests(worldDir));
        return true;
      }
      if (segments.length === 2) {
        const id = safeSegment(segments[1]!);
        const file = characterManifestFile(worldDir, id);
        if (req.method === "GET") {
          if (!fs.existsSync(file)) {
            sendJson(res, 404, { error: `角色不存在: ${id}` });
            return true;
          }
          sendJson(res, 200, JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
          return true;
        }
        if (req.method === "PUT") {
          const manifest = validateCharacterManifestForPath(id, parseJsonBody(await readBody(req)));
          fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n", "utf8");
          manager.markStale();
          sendJson(res, 200, { ok: true, note: "已保存，修改在新会话生效" });
          return true;
        }
      }
    }

    // ---- prompts（提示词模板）----
    if (domain === "prompts") {
      if (segments.length === 2 && segments[1] === "placeholders" && req.method === "GET") {
        sendJson(res, 200, placeholdersCatalog());
        return true;
      }
      if (segments.length === 1 && req.method === "GET") {
        sendJson(res, 200, readPromptTemplates());
        return true;
      }
      if (segments.length === 2 && req.method === "PUT") {
        const agent = segments[1]!;
        if (!(AGENT_KINDS as readonly string[]).includes(agent)) {
          sendJson(res, 400, { error: `未知模板: ${agent}（只允许 ${AGENT_KINDS.join(" / ")}）` });
          return true;
        }
        const template = validatePromptPayload(agent as AgentKind, parseJsonBody(await readBody(req)));
        fs.writeFileSync(
          path.join(PROMPTS_DIR, `${agent}.prompt.json`),
          JSON.stringify(template, null, 2) + "\n",
          "utf8",
        );
        // 提示词热加载（每轮激活前重读），无需 markStale——下一轮对话即生效
        sendJson(res, 200, { ok: true, note: "已保存，下一轮对话生效" });
        return true;
      }
    }

    // ---- sessions ----
    if (domain === "sessions") {
      if (segments.length === 1 && req.method === "GET") {
        sendJson(res, 200, { active: manager.currentRunId, runs: listRuns(RUNS_DIR) });
        return true;
      }
      if (segments.length === 3 && req.method === "GET") {
        const kind = segments[2] as RunArtifactKind;
        if (!["events", "world", "characters", "archive", "lore", "stats"].includes(kind)) {
          sendJson(res, 400, { error: `未知会话产物: ${kind}` });
          return true;
        }
        sendJson(res, 200, readRunArtifact(RUNS_DIR, segments[1]!, kind));
        return true;
      }
      // GET /api/sessions/{id}/llm-recent/{agentSlug}（最近 5 轮滚动窗；超出 = 已轮换出窗）
      if (segments.length === 4 && req.method === "GET" && segments[2] === "llm-recent") {
        const id = safeSegment(segments[1]!);
        const slug = safeSegment(segments[3]!);
        sendJson(res, 200, readRecent(id, slug, path.join(RUNS_DIR, id)));
        return true;
      }
      // POST /api/sessions/{id}/rename {alias}
      if (segments.length === 3 && req.method === "POST" && segments[2] === "rename") {
        const alias = requireStringField(parseJsonBody(await readBody(req)), "alias");
        writeAlias(RUNS_DIR, segments[1]!, alias);
        sendJson(res, 200, { ok: true });
        return true;
      }
      // DELETE /api/sessions/{id}（拒删活跃会话）
      if (segments.length === 2 && req.method === "DELETE") {
        deleteRun(RUNS_DIR, segments[1]!, manager.currentRunId);
        sendJson(res, 200, { ok: true });
        return true;
      }
    }

    // ---- session（活跃会话真相层直接编辑；busy/校验失败由 GameSession 抛错 → 400）----
    if (domain === "session" && segments.length === 2 && segments[1] === "state" && req.method === "PUT") {
      const body = parseJsonBody(await readBody(req)) as {
        world?: unknown;
        characters?: unknown;
        events?: unknown;
      };
      manager.applyDirectEdit(body); // 成功后会话管理器经 onStateRefresh 广播 state/events 刷新
      sendJson(res, 200, { ok: true, note: "已保存，立即生效" });
      return true;
    }

    sendJson(res, 404, { error: `未知端点: ${req.method} ${pathname}` });
    return true;
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}
