/**
 * 密钥契约：schema 与掩码工具。原始 secret 值只允许出现在服务端 SecretManager/Resolver 内，
 * 不得进入公共配置响应、WS 消息或日志。
 * contracts/ 不依赖 truth / agents / server / llm / loop（依赖审计守护）。
 */
import { z } from "zod";

/** 密钥种类命名空间（如 "openai" / "deepseek"）；开放字符串但须为安全段。 */
export const SecretKindSchema = z.string().regex(/^[\w-]+$/, "secretKind 必须是安全段");
export type SecretKind = z.infer<typeof SecretKindSchema>;

/** 服务端存储形状：同一种类可存多把 key，至多一把 active（由 SecretsFileSchema 校验）。 */
export const SecretRecordSchema = z.object({
  id: z.string().min(1),
  value: z.string().min(1),
  label: z.string().min(1),
  active: z.boolean(),
});
export type SecretRecord = z.infer<typeof SecretRecordSchema>;

/** data/<username>/secrets.json 的文件形状：kind → 记录数组，每个 kind 至多一条 active。 */
export const SecretsFileSchema = z
  .record(SecretKindSchema, z.array(SecretRecordSchema))
  .superRefine((file, ctx) => {
    for (const [kind, records] of Object.entries(file)) {
      if (records.filter((r) => r.active).length > 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${kind} 存在多条 active 记录` });
      }
      const ids = new Set<string>();
      for (const r of records) {
        if (ids.has(r.id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${kind} 存在重复 secret id: ${r.id}` });
        }
        ids.add(r.id);
      }
    }
  });
export type SecretsFile = z.infer<typeof SecretsFileSchema>;

/** 掩码视图中的密钥值：星号 + 至多末 4 位（"****3456"；短值整体掩码为 "****"；末 4 位不限字符集——真实 key 可能含 \w 外字符）。 */
export const MaskedSecretSchema = z
  .string()
  .regex(/^\*{4}.{0,4}$/, "掩码值必须是 **** 加至多末 4 位");
export type MaskedSecret = z.infer<typeof MaskedSecretSchema>;

/** 明文 → 掩码（仅留末 4 位；≤4 字符整体掩码）。纯函数。 */
export function maskSecret(value: string): string {
  if (value.length <= 4) return "****";
  return `****${value.slice(-4)}`;
}

/** 前端可见的密钥状态：ID/标签/active/掩码值，绝不含明文。 */
export const SecretStateRecordSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  active: z.boolean(),
  maskedValue: MaskedSecretSchema,
});
export const SecretStateSchema = z.record(SecretKindSchema, z.array(SecretStateRecordSchema));
export type SecretState = z.infer<typeof SecretStateSchema>;

/** 密钥变更命令（write/delete/activate/rotate/rename 判别联合；阶段 E 由 SecretManager 消费）。 */
export const SecretMutationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("write"),
    kind: SecretKindSchema,
    value: z.string().min(1),
    label: z.string().min(1),
  }),
  z.object({ type: z.literal("delete"), kind: SecretKindSchema, id: z.string().min(1) }),
  z.object({ type: z.literal("activate"), kind: SecretKindSchema, id: z.string().min(1) }),
  z.object({ type: z.literal("rotate"), kind: SecretKindSchema, id: z.string().min(1) }),
  z.object({
    type: z.literal("rename"),
    kind: SecretKindSchema,
    id: z.string().min(1),
    label: z.string().min(1),
  }),
]);
export type SecretMutation = z.infer<typeof SecretMutationSchema>;
