/**
 * 身份替换：事件库只存 @ID 占位文本，渲染给读者时按身份替换。
 *  - 自己 → "我"；
 *  - 人际关系库有 name → 真名；
 *  - 只有 impression → 印象称谓（"鞋上有青苔的男人"）；
 *  - 都不认识 → "陌生人"。
 * GM / 正文视角持演员表（@CID ↔ 真名），L4 保持 @ID 原文、由 L1 演员表解析；
 * renderForGm 供需要成文名字的场景（如回放展示）使用。
 * 纯函数，可单测。
 */
import { z } from "zod";

/** 人际关系库单条：对方 CID + 认识的名字 / 印象称谓。 */
export const RelationEntrySchema = z.object({
  cid: z.string().min(1),
  name: z.string().optional(),
  impression: z.string().optional(),
});
export type RelationEntry = z.infer<typeof RelationEntrySchema>;

/** 人际关系库文件形状：条目数组（消费侧按元素 cid 字段匹配）。 */
export const RelationsDataSchema = z.array(RelationEntrySchema);
export type RelationsData = z.infer<typeof RelationsDataSchema>;

/** 演员表成员（@CID ↔ 真名/称谓）。 */
export interface CastMember {
  cid: string;
  name: string;
}

/** @CID 占位符（@C0、@C1001……）。 */
const TOKEN = /@(C\d+)/g;

/** "@C0" / "C0" → "C0"（relations 落库与查找的归一化）。 */
export function normalizeCid(raw: string): string {
  return raw.startsWith("@") ? raw.slice(1) : raw;
}

/** 按 cid 字段查人际关系条目。 */
function findRelation(relations: RelationsData, cid: string): RelationEntry | undefined {
  return relations.find((rel) => rel.cid === cid);
}

/** 读者视角渲染：@CID 按读者的身份与认知替换。 */
export function renderForReader(
  payload: string,
  readerCid: string,
  relations: RelationsData,
): string {
  return payload.replace(TOKEN, (_match: string, cid: string) => {
    if (cid === readerCid) return "我";
    const rel = findRelation(relations, cid);
    if (rel?.name !== undefined && rel.name !== "") return rel.name;
    if (rel?.impression !== undefined && rel.impression !== "") return rel.impression;
    return "陌生人";
  });
}

/** GM/正文视角渲染：@CID → 演员表真名（表外 CID 保留原文）。 */
export function renderForGm(payload: string, cast: CastMember[]): string {
  const byCid = new Map(cast.map((c) => [c.cid, c.name]));
  return payload.replace(TOKEN, (match: string, cid: string) => byCid.get(cid) ?? match);
}

/**
 * 正文指称占位符（[[称呼|@CID]]）：正文 agent 产出正文时对演员表角色的指称，
 * archive 存带占位符原文，三个视图按读者渲染（容忍缺 @；不匹配即原样保留）。
 */
const REF = /\[\[([^\]|]+)\|@?(C\d+)\]\]/g;

/** 玩家显示视图：[[称呼|@CID]] → 称呼。 */
export function renderRefsDisplay(text: string): string {
  return text.replace(REF, (_match: string, label: string) => label);
}

/**
 * NPC 注入视图：该读者 relations 有 target CID 且 name 非空 → name；
 * 否则 impression 非空 → impression；都不认识 → 保留 @CID 原样。
 */
export function renderRefsForReader(text: string, relations: RelationsData): string {
  return text.replace(REF, (_match: string, _label: string, cid: string) => {
    const rel = findRelation(relations, cid);
    if (rel?.name !== undefined && rel.name !== "") return rel.name;
    if (rel?.impression !== undefined && rel.impression !== "") return rel.impression;
    return `@${cid}`;
  });
}

/** GM 注入视图：[[称呼|@CID]] → 称呼（@CID）。 */
export function renderRefsForGm(text: string): string {
  return text.replace(REF, (_match: string, label: string, cid: string) => `${label}（@${cid}）`);
}

/**
 * 演员表注入行（各 agent L1）：`- @C0 = 林凡`（显示名来自 characters 档内副本的 name）；
 * selfCid 标 "- @C1001 = 我（林雾）"。按 cast 传入顺序输出（调用方保证稳定）。
 */
export function buildCastLines(cast: CastMember[], selfCid?: string): string[] {
  return cast.map((c) => `- @${c.cid} = ${c.cid === selfCid ? `我（${c.name}）` : c.name}`);
}
