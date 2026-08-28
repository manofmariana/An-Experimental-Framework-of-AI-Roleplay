/**
 * 调度效应（application 层）：
 * 把 scheduler 派生语义翻成对 TruthStores 的常规 VarChange 写入——
 * 轮首 setup 落账（applyScheduleSetup）、组派生 + 先攻补投（rederiveGroups）、
 * 频道清理 pass（cleanupChannels），以及规划器共用的调度视图小工具。
 *
 * 只变异传入的 truth 视图（live 或 draft）并返回 VarChange[]；永不持久化。
 * session 内核（轮首步）与两个效果规划器（actorEffects/gmEffects）共用本模块。
 */
import type { DicePort } from "../ports.js";
import type { ScheduleSetup } from "../scheduler/derive.js";
import { groupLocation, reconcileGroups, rerollInitiative, type SimChar } from "../scheduler/simulator.js";
import type { CharacterState } from "../truth/charactersStore.js";
import type { TruthStores } from "../truth/stores.js";
import type { VarChange } from "../truth/varChanges.js";
import { PLAYER_CID } from "../types.js";

/** 全部角色同构条目（characters.json 不再存 GM 伪角色）。 */
export function playableCharacters(truth: TruthStores): Record<string, CharacterState> {
  return { ...truth.characters.all() };
}

/** 玩家操控角色 cid（await_player 一律按 isPlayer 判定，不硬编码 C0；缺省回落 C0）。 */
export function playerCidOf(truth: TruthStores): string {
  for (const [cid, s] of Object.entries(playableCharacters(truth))) {
    if (s.isPlayer) return cid;
  }
  return PLAYER_CID;
}

/** 调度视图（SimChar）：timer 直传存储原值（未结算离开者 timer 本就是 null = 无计时器，永不弹出）。 */
export function simCharsOf(truth: TruthStores): Record<string, SimChar> {
  return Object.fromEntries(
    Object.entries(playableCharacters(truth)).map(([cid, s]) => [
      cid,
      {
        timer: s.timer,
        group: s.group,
        location: s.location,
        isPlayer: s.isPlayer,
        initiative: s.initiative,
        channel: s.channel,
      },
    ]),
  );
}

/** 周期计数 X（sys 根程序计数键 cycles_since_gm）。 */
export function cycleCountOf(truth: TruthStores): number {
  return truth.sys.counters.cycles_since_gm;
}

/**
 * 轮首步的调度落账：时钟跳转到弹出时刻 + 维护性变更（周期计数 X+1、后台/周期完成
 * acted 清零、前台组成员在场位置位）——产出 StepChanges.setup 段，回溯天然可逆。
 */
export function applyScheduleSetup(truth: TruthStores, setup: ScheduleSetup): VarChange[] {
  const changes: VarChange[] = [];
  if (setup.due !== undefined) {
    const to = Math.max(setup.due, truth.world.clock); // 防御：时钟不倒退
    if (to > truth.world.clock) changes.push(truth.world.setClock(to));
  }
  if (setup.cycleIncrement) {
    changes.push(truth.sys.writeRaw("cycles_since_gm", cycleCountOf(truth) + 1));
  }
  for (const cid of setup.actedClears) changes.push(...truth.characters.setVars(cid, { acted: false }));
  for (const cid of setup.foreground) changes.push(...setAppearance(truth, cid, true));
  return changes;
}

/**
 * 在场位置位唯一写口（writeRaw 白名单通道，随 changes 落账，回溯可逆）：
 * appearance = 角色是否在场（组弹出前台/入组 = true；结算进后台/离组 = false），
 * vars 源对不在场角色的全部末端虚拟挂载 fappear 六级。未知角色/值已到位 = 空。
 */
export function setAppearance(truth: TruthStores, cid: string, value: boolean): VarChange[] {
  const state = truth.characters.all()[cid];
  if (state === undefined || state.appearance === value) return [];
  return [truth.characters.writeRaw(cid, "appearance", value)];
}

/**
 * 组派生 + 先攻补投回写（GM 步/开局/召回共用）：reconcileGroups 保稳指派 group
 * （VarChange 通道），rerollInitiative 只为 initiative 为空或组编号不符的成员
 * 单独补投插入既有顺序（已存值对上即复用，不重投）——行动顺序由此派生还原。
 * 入组位置 ≠ 组位置的新成员先攻 -1。
 * 频道不在此清理：组 id 随 GM 结算 churn（拆散/重并）是常态，频道生命周期归
 * leave 标记（退组清除）/ 拒绝 / 同地清理 pass 管。
 * record=false 时丢弃 VarChange（仅开局初始分组用：seq 1 之前，回溯不越过）。
 */
export function rederiveGroups(truth: TruthStores, rollDice: DicePort, record = true): VarChange[] {
  const chars = playableCharacters(truth);
  const prev = Object.fromEntries(Object.entries(chars).map(([cid, s]) => [cid, s.group]));
  const { group } = reconcileGroups(chars, prev);
  const changes: VarChange[] = [];
  for (const cid of Object.keys(group)) {
    if (group[cid]! !== (prev[cid] ?? 0)) {
      changes.push(...truth.characters.setVars(cid, { group: group[cid]! }));
    }
  }
  const groups = new Map<number, string[]>();
  for (const [cid, g] of Object.entries(group)) {
    if (g === 0) continue;
    const bucket = groups.get(g);
    if (bucket === undefined) groups.set(g, [cid]);
    else bucket.push(cid);
  }
  for (const [id, cids] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const rolled = rerollInitiative(
      cids.map((c) => ({
        cid: c,
        reaction: truth.characters.get(c).reaction,
        initiative: truth.characters.get(c).initiative,
      })),
      id,
      rollDice,
    );
    if (rolled.length === 0) continue;
    for (const r of rolled) changes.push(...truth.characters.setVars(r.cid, { initiative: r.initiative }));
    // 入组位置 ≠ 组位置 → 先攻 -1（按补投后的原始值先定组位置）
    const gl = groupLocation(simCharsOf(truth), id);
    for (const r of rolled) {
      if (gl !== null && truth.characters.get(r.cid).location.name !== gl) {
        changes.push(
          ...truth.characters.setVars(r.cid, {
            initiative: { value: r.initiative.value - 1, group: id },
          }),
        );
      }
    }
  }
  return record ? changes : [];
}

/**
 * 频道清理 pass（生命周期）：全部持有者 location 相同 → 频道变量全清，
 * 仍非组位置的持有者按 leave 处理（组归 0 + timer 置 null，等待下一次 GM 结算）。
 */
export function cleanupChannels(truth: TruthStores): VarChange[] {
  const all = truth.characters.all();
  const holders = Object.keys(all).filter((cid) => all[cid]!.channel !== null).sort();
  if (holders.length === 0) return [];
  const locations = new Set(holders.map((cid) => all[cid]!.location.name));
  if (locations.size > 1) return [];
  const changes: VarChange[] = [];
  for (const cid of holders) changes.push(...truth.characters.setVars(cid, { channel: null }));
  const sim = simCharsOf(truth);
  for (const cid of holders) {
    const g = truth.characters.get(cid).group;
    if (g === 0) continue;
    const gl = groupLocation(sim, g);
    if (gl !== null && truth.characters.get(cid).location.name !== gl) {
      changes.push(...truth.characters.setVars(cid, { group: 0, timer: null }));
      changes.push(...setAppearance(truth, cid, false));
    }
  }
  return changes;
}
