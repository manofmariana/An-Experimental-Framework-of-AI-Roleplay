/**
 * 密钥仓储。
 *
 * data/<username>/secrets.json 的原子读写与全部纯逻辑：
 * - readSecretsFile / writeSecretsFile：缺文件 = 空 SecretsFile；写入 = .tmp → rename
 *   原子替换（参照 truth/generationRepository 手法）；读回经 SecretsFileSchema 校验，
 *   损坏抛 SecretsRepositoryError（稳定 code，HTTP 层负责映射，本模块不知道 HTTP 存在）。
 * - applySecretMutation：SecretMutation 判别联合全分支的纯变换（不修改入参）；
 *   delete active 后的继任规则 = 该 kind 剩余首条转 active，空则无 active；
 *   write 生成的 id 经注入的 generateId（默认 crypto.randomUUID）；
 *   rotate(kind, id) = 激活给定 id 的下一条（循环），与 activate（直接激活给定 id）区分。
 *   返回前过 SecretsFileSchema——「同 kind 至多一条 active / id 不重复」不变量机械保持。
 * - toSecretState：掩码投影（maskSecret：仅留末 4 位），绝不含明文。
 *
 * 全部函数显式接收路径参数（组成根经 UserDirectories 注入），本模块不 import config。
 * 依赖方向：resources → shared / contracts（依赖审计守护）。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  maskSecret,
  SecretsFileSchema,
  SecretStateSchema,
  type SecretMutation,
  type SecretRecord,
  type SecretsFile,
  type SecretState,
} from "../contracts/secrets.js";

/** 仓储错误码（HTTP 映射：SECRET_NOT_FOUND→404，SECRETS_CORRUPT→500）。 */
export type SecretsErrorCode = "SECRETS_CORRUPT" | "SECRET_NOT_FOUND";

export class SecretsRepositoryError extends Error {
  constructor(
    public readonly code: SecretsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SecretsRepositoryError";
  }
}

/** 读 secrets.json；缺文件 = 空 SecretsFile；JSON 损坏/契约不符 → SECRETS_CORRUPT。 */
export function readSecretsFile(secretsFile: string): SecretsFile {
  if (!fs.existsSync(secretsFile)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(secretsFile, "utf8"));
  } catch {
    throw new SecretsRepositoryError("SECRETS_CORRUPT", `secrets.json 不是合法 JSON: ${secretsFile}`);
  }
  const result = SecretsFileSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(顶层)"}: ${issue.message}`)
      .join("；");
    throw new SecretsRepositoryError("SECRETS_CORRUPT", `secrets.json 契约校验失败：${issues}`);
  }
  return result.data;
}

/** 原子写 secrets.json（先过契约校验，非法形状不落盘；.tmp → rename 替换）。 */
export function writeSecretsFile(secretsFile: string, file: SecretsFile): void {
  const data = SecretsFileSchema.parse(file);
  fs.mkdirSync(path.dirname(secretsFile), { recursive: true });
  const tmp = `${secretsFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, secretsFile);
}

function requireRecord(records: SecretRecord[], mutation: { kind: string; id: string }): number {
  const index = records.findIndex((r) => r.id === mutation.id);
  if (index < 0) {
    throw new SecretsRepositoryError(
      "SECRET_NOT_FOUND",
      `secret 不存在: ${mutation.kind}/${mutation.id}`,
    );
  }
  return index;
}

/**
 * 应用一次密钥变更（纯函数，返回新 SecretsFile，不修改入参）。
 * - write：追加新记录；该 kind 原本为空时新记录即为 active，否则 inactive；
 * - delete：移除指定记录；删的是 active 时剩余首条继任 active，空 kind 整个移除；
 * - activate：直接激活指定记录；
 * - rotate：激活指定记录的下一条（循环；单条时 = 激活自身）；
 * - rename：改标签。
 * activate/rotate/delete/rename 对不存在的 id 抛 SECRET_NOT_FOUND。
 */
export function applySecretMutation(
  file: SecretsFile,
  mutation: SecretMutation,
  generateId: () => string = randomUUID,
): SecretsFile {
  // 深拷贝一层记录（纯函数不修改入参）
  const next: SecretsFile = Object.fromEntries(
    Object.entries(file).map(([kind, records]) => [kind, records.map((r) => ({ ...r }))]),
  );
  const records = (next[mutation.kind] ??= []);
  switch (mutation.type) {
    case "write": {
      records.push({
        id: generateId(),
        value: mutation.value,
        label: mutation.label,
        active: records.length === 0,
      });
      break;
    }
    case "delete": {
      const index = requireRecord(records, mutation);
      const [removed] = records.splice(index, 1);
      if (removed!.active && records.length > 0) records[0]!.active = true;
      if (records.length === 0) delete next[mutation.kind];
      break;
    }
    case "activate":
    case "rotate": {
      const index = requireRecord(records, mutation);
      const target = mutation.type === "activate" ? index : (index + 1) % records.length;
      records.forEach((r, i) => {
        r.active = i === target;
      });
      break;
    }
    case "rename": {
      records[requireRecord(records, mutation)]!.label = mutation.label;
      break;
    }
  }
  // 不变量机械校验（同 kind 至多一条 active / id 不重复）；apply 后必须保持
  return SecretsFileSchema.parse(next);
}

/** SecretsFile → 前端掩码状态（id/label/active/掩码值，绝不含明文）。 */
export function toSecretState(file: SecretsFile): SecretState {
  const state: SecretState = {};
  for (const [kind, records] of Object.entries(file)) {
    state[kind] = records.map((r) => ({
      id: r.id,
      label: r.label,
      active: r.active,
      maskedValue: maskSecret(r.value),
    }));
  }
  return SecretStateSchema.parse(state);
}
