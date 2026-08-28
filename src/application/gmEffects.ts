/**
 * 统一效果规划器——GM 裁决。
 *
 * GM 正常裁决与 GM 编辑统一进入 planGmAdjudication；agent 通知段（GM 全文观察 +
 * 各角色按 TAG 过滤的感知通知）不在此——留在 session 内核，commit 成功后执行（两段式）。
 *
 * 真相段：deltas 落库 + durations（时长 → 到期时刻 timer 变量）/location 应用 + 周期计数/
 * 触发复位 + 结算成员 acted 清零 + reconcileGroups 回写 group 与先攻补投 + 频道清理
 * pass + 事件逐条 commit（ID 经注入分配器，调用方只在 commit 成功后推进水位）+
 * 无 timer 校验 + **工作集清算**（GM 转写后言行已入事件库；narrativity=skip 无正文步，
 * 工作集不能挂账）。
 *
 * 规划器只变异传入的 draft（或 live）视图并返回常规 VarChange[] 与本步提交的事件，
 * 永不持久化；提交由调用方负责。
 */
import type { DicePort } from "../ports.js";
import type { TruthStores } from "../truth/stores.js";
import type { VarChange } from "../truth/varChanges.js";
import { parseSys } from "../truth/sysStore.js";
import { applyVarDeltas, varWriteDepsOf } from "../truth/varWrite.js";
import { spanToMinutes, type AdjudicationPackage, type Event } from "../types.js";
import { cleanupChannels, playableCharacters, rederiveGroups, setAppearance } from "./scheduleEffects.js";

export interface GmAdjudicationContext {
  /** 本步 seq（事件落账用）。 */
  seq: number;
  pkg: AdjudicationPackage;
  /** 本轮行动者（工作集去重；事件 tags 缺省 = 全员可见）。 */
  roundCids: string[];
  /** 事件 ID 分配器（draft 安全：只在调用方局部计数器上推进）。 */
  allocateEventId: () => string;
  rollDice: DicePort;
}

export interface GmStepEffects {
  /** StepChanges.effects 段（setup 段由调度落账产生，见 scheduleEffects.applyScheduleSetup）。 */
  changes: VarChange[];
  /** 本步提交的事件（供 commit 后的 agent 通知段使用）。 */
  committed: Event[];
}

export function planGmAdjudication(draft: TruthStores, ctx: GmAdjudicationContext): GmStepEffects {
  const { seq, pkg, roundCids } = ctx;
  const known = draft.characters.all();
  const changes = applyVarDeltas(
    draft,
    pkg.deltas,
    varWriteDepsOf(parseSys(draft.sys.saveData()), new Set(Object.keys(known))),
  );
  // durations：时长 → 到期时刻（timer = 世界时钟 + spanToMinutes(span)，契约保证非 0）
  for (const t of pkg.durations) {
    if (!(t.cid in known)) {
      console.warn(`GM 裁决包 durations 指向未知角色 ${t.cid}，已跳过`);
      continue;
    }
    changes.push(...draft.characters.setVars(t.cid, { timer: draft.world.clock + spanToMinutes(t.span) }));
  }
  // location：GM 只设变量，分组（group）由程序派生
  for (const l of pkg.location) {
    if (!(l.cid in known)) {
      console.warn(`GM 裁决包 location 指向未知角色 ${l.cid}，已跳过`);
      continue;
    }
    changes.push(...draft.characters.setVars(l.cid, { location: l.location }));
  }
  // 任何 GM 激活后：周期计数 X 清零 + 立即触发标记复位
  changes.push(
    draft.sys.writeRaw("cycles_since_gm", 0),
    draft.sys.writeRaw("gm_trigger", false),
  );
  // 本轮被结算的成员转入后台：acted 清零（先攻值不重投，回前台时行动状态已重置）+ 在场位复位
  for (const t of pkg.durations) {
    if (t.cid in known) changes.push(...draft.characters.setVars(t.cid, { acted: false }));
    changes.push(...setAppearance(draft, t.cid, false));
  }
  // 组派生 + 先攻补投（location/timer 是分组判据；组 id 保稳，缺投者单独补投）
  changes.push(...rederiveGroups(draft, ctx.rollDice));
  // 频道清理 pass：全部持有者同地 → 全清 + 非组位置持有者按 leave 处理
  changes.push(...cleanupChannels(draft));
  // 事件逐条 commit（事件数 = GM 计划的新组划分；元素 = 全字段末端外壳——
  // GM text → content.value、tags → content.tags（空数组程序补全本轮行动者 cid 类 TAG 一级），
  // t/kind/location 等字段的 tags 留空（挂哪些字段是 GM 输出契约的事，结构先立）
  const committed: Event[] = [];
  for (const ev of pkg.events) {
    const shell = <T extends string | number>(value: T): { value: T; tags: { name: string; level: number }[] } => ({
      value,
      tags: [],
    });
    const event: Event = {
      id: shell(ctx.allocateEventId()),
      t: shell(draft.world.clock),
      seq: shell(seq),
      kind: shell("world" as const),
      ...(ev.location !== undefined ? { location: shell(ev.location) } : {}),
      content: {
        value: ev.text,
        tags: ev.tags.length > 0 ? ev.tags : roundCids.map((cid) => ({ name: cid, level: 1 })),
      },
    };
    draft.events.append(event);
    committed.push(event);
  }
  // 校验：组内角色无 timer → 警告（防 GM 漏设沉底）；group=0 + timer=null 是合法离场态
  //（leave 标记 / 频道清理 pass 的产出，等待下一次 GM 结算），不报
  for (const [cid, s] of Object.entries(playableCharacters(draft))) {
    if (s.timer === null && s.group !== 0) {
      console.warn(`GM 裁决后 ${cid} 无计时器（durations 须覆盖本轮全部行动者）`);
    }
  }
  // 工作集清算（改到 GM 步，不再等正文步）
  draft.sys.setPipeline({ working_set: [] });
  return { changes, committed };
}
