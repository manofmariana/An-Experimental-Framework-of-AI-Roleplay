/**
 * 调度派生纯函数集。
 *
 * 时间轴与轮状态全派生、无独立存储：调度 = 扫描角色 timer 取最小；
 * 组 ← timer+location 自动并组 + 既有身份保稳（单 group 变量）；
 * 行动顺序 ← initiative 变量（{value, group}）。
 *
 * 铁律不变：纯逻辑，无 IO、无 LLM、无网络——不 import 任何 fs/net 模块；
 * test/simulator.test.ts 的元测试守护保留。
 */
import { knownByTag, type Event } from "../types.js";
import { defaultDice, rollDice, type DicePort } from "../ports.js";

/** 调度视图中的角色（单 group 分组变量；initiative 结构化 {value, group}）。 */
export interface SimChar {
  /** 到期时刻（分钟标量，绝对时刻）；null = 无计时器 */
  timer: number | null;
  /** 组编号（0 = 单人组；组位置不落盘，由 groupLocation 派生） */
  group: number;
  location: { name: string };
  isPlayer: boolean;
  /** 最近先攻结果；组编号变化即重置（归 0 除外，留待召回复用） */
  initiative: { value: number; group: number } | null;
  /** 频道变量（跨地点联系"通话中"标识；null = 无） */
  channel: number | null;
}

/** 最小非空 timer 及该时刻全部到期角色；全员无计时器 → null。cids 排序（确定性）。 */
export function nextDue(chars: Record<string, SimChar>): { due: number; cids: string[] } | null {
  let due: number | null = null;
  for (const c of Object.values(chars)) {
    if (c.timer === null) continue;
    if (due === null || c.timer < due) due = c.timer;
  }
  if (due === null) return null;
  const cids = Object.keys(chars)
    .filter((cid) => chars[cid]!.timer === due)
    .sort();
  return { due, cids };
}

/** reconcileGroups 输入：分组判据 = (location.name, timer)。 */
export interface GroupableChar {
  location: { name: string };
  timer: number | null;
}

function bucketKey(c: GroupableChar): string {
  return JSON.stringify([c.location.name, c.timer]);
}

/** 组锚定 timer：成员中出现次数最多的 timer；并列取较小值（null 视作 +∞ 排后）。 */
function anchorTimer(members: string[], chars: Record<string, GroupableChar>): number | null {
  const counts = new Map<number | null, number>();
  for (const cid of members) {
    const t = chars[cid]!.timer;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = -1;
  for (const [t, n] of counts) {
    if (n > bestCount || (n === bestCount && t !== null && (best === null || t < best))) {
      best = t;
      bestCount = n;
    }
  }
  return best;
}

/**
 * 组调和（保稳指派）：
 * - **自动并组**：timer 一致 + location 一致 → 同组（≥2 人）；
 * - **身份保留**：既有组成员 timer 仍匹配组锚定 timer → 保留成员身份
 *   （远程成员 location 不同不拆组）；timer 被独立修改即离组；
 * - **id 继承优先级**：精确匹配 > 增员（superset）> 减员（subset：最大子集，
 *   并列取含最小 CID 者）> 人少并入人多（增员并列时取成员多的 prev 组）> 新 id；
 * - 单人 → 归 0；id 不得由 hash(location+timer) 派生——连续轮每圈重设 timer
 *   都会换 id，连续场景判定即垮。
 * changed = 指派结果与 prev 有差异（调用方决定是否落盘）。
 */
export function reconcileGroups(
  chars: Record<string, GroupableChar>,
  prev: Record<string, number>,
): { group: Record<string, number>; changed: boolean } {
  const cids = Object.keys(chars).sort();

  // prev 组 id → 成员集（0 = 单人组，不参与保稳匹配；只计仍在 chars 中的成员）
  const prevSets = new Map<number, Set<string>>();
  for (const cid of cids) {
    const g = prev[cid] ?? 0;
    if (g === 0) continue;
    const set = prevSets.get(g);
    if (set === undefined) prevSets.set(g, new Set([cid]));
    else set.add(cid);
  }

  // 分桶（(location.name, timer)；cid 排序保证确定性）
  const buckets = new Map<string, string[]>();
  for (const cid of cids) {
    const key = bucketKey(chars[cid]!);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [cid]);
    else bucket.push(cid);
  }

  // 1. 身份保留：timer 匹配组锚定 timer 的既有成员留在原组（不看 location）
  const retained = new Map<number, Set<string>>(); // g → 保留成员
  const isRetained = new Set<string>();
  for (const [g, members] of [...prevSets.entries()].sort((a, b) => a[0] - b[0])) {
    const anchor = anchorTimer([...members], chars);
    const keep = new Set([...members].filter((cid) => chars[cid]!.timer === anchor));
    if (keep.size > 0) retained.set(g, keep);
    for (const cid of keep) isRetained.add(cid);
  }

  // 2. 增员吸收：未保留角色与某保留成员同桶（同地同刻）→ 并入该组
  //    （同桶有多个 prev 组的保留成员 = 合组，先并入 id 最小者，下一步并集合并）
  const seeds = new Map<number, Set<string>>();
  for (const [g, keep] of retained) seeds.set(g, new Set(keep));
  const bucketOf = new Map<string, string>();
  for (const [key, bucket] of buckets) for (const cid of bucket) bucketOf.set(cid, key);
  const retainedGroupsByBucket = new Map<string, number[]>();
  for (const [g, keep] of retained) {
    for (const cid of keep) {
      const key = bucketOf.get(cid)!;
      const list = retainedGroupsByBucket.get(key);
      if (list === undefined) retainedGroupsByBucket.set(key, [g]);
      else if (!list.includes(g)) list.push(g);
    }
  }
  for (const cid of cids) {
    if (isRetained.has(cid)) continue;
    const groups = retainedGroupsByBucket.get(bucketOf.get(cid)!);
    if (groups === undefined) continue;
    seeds.get(Math.min(...groups))!.add(cid);
    isRetained.add(cid);
  }

  // 3. 合组：共享同一桶的种子集合并（timer 对齐 + 同地 → 自动并组）
  //    并查集按桶连接，合并后成员 = 并集，候选 id 取成员多的种子（并列取含最小 CID 者）
  const parent = new Map<number, number>();
  const find = (g: number): number => {
    let root = g;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(g, root);
    return root;
  };
  for (const g of seeds.keys()) parent.set(g, g);
  for (const groups of retainedGroupsByBucket.values()) {
    for (let i = 1; i < groups.length; i++) {
      parent.set(find(groups[i]!), find(groups[0]!));
    }
  }
  const merged = new Map<number, Set<string>>(); // 并查集根 → 成员集
  for (const [g, set] of seeds) {
    const root = find(g);
    const acc = merged.get(root);
    if (acc === undefined) merged.set(root, new Set(set));
    else for (const cid of set) acc.add(cid);
  }

  // 4. 剩余未归属角色：按桶自动并组（≥2 人成组，单人归 0）
  const result: Set<string>[] = [...merged.values()].filter((set) => set.size >= 2);
  const assigned = new Set<string>(result.flatMap((set) => [...set]));
  for (const bucket of buckets.values()) {
    const rest = bucket.filter((cid) => !isRetained.has(cid) && !assigned.has(cid));
    if (rest.length >= 2) result.push(new Set(rest));
  }

  // 5. id 继承：精确 > 增员 > 减员（最大子集，并列含最小 CID）> 人少并入人多 > 新 id
  //    按集合内最小 CID 字典序排序，保证指派顺序确定
  const sets = result
    .map((members) => ({ members, id: 0 }))
    .sort((a, b) => [...a.members].sort()[0]!.localeCompare([...b.members].sort()[0]!));

  const unclaimedPrev = new Map(prevSets); // g → members（尚未被继承）
  const isSubset = (a: Set<string>, b: Set<string>): boolean => [...a].every((c) => b.has(c));
  const eqSet = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && isSubset(a, b);
  const minCid = (s: Set<string>): string => [...s].sort()[0]!;

  // 5a. 精确匹配
  for (const s of sets) {
    for (const [g, members] of unclaimedPrev) {
      if (eqSet(s.members, members)) {
        s.id = g;
        unclaimedPrev.delete(g);
        break;
      }
    }
  }
  // 5b. 增员（prev ⊂ 新集；含合组：并列取成员多的 prev 组 = 人少并入人多，再并列取含最小 CID 者）
  for (const s of sets) {
    if (s.id !== 0) continue;
    const candidates = [...unclaimedPrev.entries()].filter(([, members]) => isSubset(members, s.members));
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => b[1].size - a[1].size || minCid(a[1]).localeCompare(minCid(b[1])));
    s.id = candidates[0]![0];
    unclaimedPrev.delete(s.id);
  }
  // 5c. 减员（新集 ⊂ prev；同一 prev 分裂出的多个子集中最大者继承，并列取含最小 CID 者）
  for (const [g, members] of [...unclaimedPrev.entries()].sort((a, b) => a[0] - b[0])) {
    const heirs = sets.filter((s) => s.id === 0 && isSubset(s.members, members));
    if (heirs.length === 0) continue;
    heirs.sort((a, b) => b.members.size - a.members.size || minCid(a.members).localeCompare(minCid(b.members)));
    heirs[0]!.id = g;
    unclaimedPrev.delete(g);
  }
  // 5d. 全新组合：从未用过的新 id（max(prev ∪ 已指派)+1 起，按集合顺序递增）
  let nextId = Math.max(0, ...Object.values(prev), ...sets.map((s) => s.id)) + 1;
  for (const s of sets) {
    if (s.id === 0) s.id = nextId++;
  }

  const group: Record<string, number> = {};
  for (const cid of cids) group[cid] = 0;
  for (const s of sets) for (const cid of s.members) group[cid] = s.id;

  const keys = new Set([...Object.keys(group), ...Object.keys(prev)]);
  const changed = [...keys].some((cid) => (group[cid] ?? 0) !== (prev[cid] ?? 0));
  return { group, changed };
}

/**
 * 组位置派生（不落盘，CONTEXT「Sync Group」）：组内先攻最高者（同值取最小 CID）的
 * location.name；全员无先攻值时取最小 CID 成员。组不存在/无成员 → null。
 */
export function groupLocation(chars: Record<string, SimChar>, groupId: number): string | null {
  const leader = groupLeader(chars, groupId);
  return leader === null ? null : chars[leader]!.location.name;
}

/** 组内先攻最高者 cid（同值取最小 CID；initiative 为 null 视作 -∞）。组无成员 → null。 */
function groupLeader(chars: Record<string, SimChar>, groupId: number): string | null {
  const members = Object.keys(chars)
    .filter((cid) => chars[cid]!.group === groupId)
    .sort();
  if (members.length === 0) return null;
  const value = (cid: string): number => chars[cid]!.initiative?.value ?? Number.NEGATIVE_INFINITY;
  let leader = members[0]!;
  for (const cid of members) {
    if (value(cid) > value(leader)) leader = cid;
  }
  return leader;
}

/**
 * 同刻多组串行排序（单活跃组不变量）：输入同刻到期的 cids，输出按行动先后
 * 排序的调度单元列表（组 ≠ 0 → 整组一个单元；单人组 → 各自独立单元）。
 * 单元排序键 = 组内最高先攻（同值取该成员 CID）：先攻降序，同值比 CID 升序；
 * 无先攻值（null）排最后。单元内 cids 升序。
 */
export function orderGroups(chars: Record<string, SimChar>, cids: readonly string[]): string[][] {
  const byGroup = new Map<string, string[]>();
  for (const cid of [...cids].sort()) {
    const g = chars[cid]!.group;
    const key = g !== 0 ? `g${g}` : `s${cid}`; // 单人各自独立单元
    const bucket = byGroup.get(key);
    if (bucket === undefined) byGroup.set(key, [cid]);
    else bucket.push(cid);
  }
  const units = [...byGroup.values()];
  const keyOf = (unit: string[]): { value: number; cid: string } => {
    const sorted = [...unit].sort();
    let best = sorted[0]!;
    const value = (cid: string): number => chars[cid]!.initiative?.value ?? Number.NEGATIVE_INFINITY;
    for (const cid of sorted) {
      if (value(cid) > value(best)) best = cid;
    }
    return { value: value(best), cid: best };
  };
  units.sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka.value !== kb.value) return kb.value - ka.value;
    if (ka.cid !== kb.cid) return ka.cid.localeCompare(kb.cid);
    return a[0]!.localeCompare(b[0]!);
  });
  return units;
}

/**
 * 角色可见事件（known_by 唯一通道）：
 * tags 含 `known_by:{cid}` 即可见——GM 标记时已推理过可视性，无地点成分、无其他限制。
 * 保持输入顺序（调用方先按 (t, id) 排序）。
 */
export function visibleEvents(events: Event[], cid: string): Event[] {
  const tag = knownByTag(cid);
  return events.filter((e) => e.tags.includes(tag));
}

export interface InitiativeMember {
  cid: string;
  /** 先攻修正值（角色变量，可成长） */
  reaction: number;
}

/**
 * 先攻投掷（确定性排序，代码侧执行不经 LLM）：d20（1-20）+ reaction，降序分批；
 * 同值 = 同时行动批次（批内互不见对方言行，注入隔离由主循环做）。
 * roll 可注入骰子端口（默认 defaultDice），测试用其达成确定性。
 * 返回值为裸先攻值批次；写入角色变量时由调用方盖上组编号（{value, group}）。
 */
export function rollInitiative(
  members: InitiativeMember[],
  roll: DicePort = defaultDice,
): { batches: { initiative: number; cids: string[] }[] } {
  const rolled = members.map((m) => ({ cid: m.cid, initiative: rollDice(roll, 20) + m.reaction }));
  rolled.sort((a, b) => b.initiative - a.initiative || a.cid.localeCompare(b.cid));
  const batches: { initiative: number; cids: string[] }[] = [];
  for (const r of rolled) {
    const last = batches[batches.length - 1];
    if (last !== undefined && last.initiative === r.initiative) last.cids.push(r.cid);
    else batches.push({ initiative: r.initiative, cids: [r.cid] });
  }
  return { batches };
}

export interface RerollMember extends InitiativeMember {
  /** 已存先攻（{value, group}；null = 尚未投掷） */
  initiative: { value: number; group: number } | null;
}

/**
 * 补投（新成员单独补投插入既有顺序，不波及全组）：
 * 只为 initiative 为 null 或组编号与当前组不符的成员投掷，结果盖当前组编号；
 * 已存值且组编号对上的成员原样保留（不出现在返回中）。顺序 = 输入顺序（确定性）。
 */
export function rerollInitiative(
  members: RerollMember[],
  group: number,
  roll: DicePort = defaultDice,
): { cid: string; initiative: { value: number; group: number } }[] {
  return members
    .filter((m) => m.initiative === null || m.initiative.group !== group)
    .map((m) => ({ cid: m.cid, initiative: { value: rollDice(roll, 20) + m.reaction, group } }));
}

export interface OrderedMember {
  cid: string;
  /** 最近先攻结果（角色变量；null = 尚未投掷，防御性排最后） */
  initiative: { value: number; group: number } | null;
}

/**
 * 行动顺序派生还原（顺序 ← initiative 变量现排）：按已存先攻值
 * 降序分批，同值 = 同时批（批内 cid 升序）；null（未投掷）排最后。不掷骰，纯派生。
 * 调用方负责只传入当前前台组成员（组编号匹配由调用方过滤）。
 */
export function initiativeBatches(
  members: OrderedMember[],
): { initiative: number | null; cids: string[] }[] {
  const value = (m: OrderedMember): number | null => m.initiative?.value ?? null;
  const sorted = [...members].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null && vb === null) return a.cid.localeCompare(b.cid);
    if (va === null) return 1;
    if (vb === null) return -1;
    return vb - va || a.cid.localeCompare(b.cid);
  });
  const batches: { initiative: number | null; cids: string[] }[] = [];
  for (const m of sorted) {
    const v = value(m);
    const last = batches[batches.length - 1];
    if (last !== undefined && last.initiative === v) last.cids.push(m.cid);
    else batches.push({ initiative: v, cids: [m.cid] });
  }
  return batches;
}
