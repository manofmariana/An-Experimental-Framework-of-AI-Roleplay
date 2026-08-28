import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  groupLocation,
  initiativeBatches,
  nextDue,
  orderGroups,
  reconcileGroups,
  rerollInitiative,
  rollInitiative,
  type SimChar,
} from "../src/scheduler/simulator.js";

function simChar(partial: Partial<SimChar>): SimChar {
  return {
    timer: null,
    group: 0,
    location: { name: "loc" },
    isPlayer: false,
    initiative: null,
    channel: null,
    ...partial,
  };
}

describe("nextDue（调度 = 扫描角色 timer 取最小）", () => {
  it("最小非空 timer 及该时刻全部到期角色（同刻同弹，cids 排序）", () => {
    const chars: Record<string, SimChar> = {
      C1002: simChar({ timer: 90 }),
      C0: simChar({ timer: 30, isPlayer: true }),
      C1001: simChar({ timer: 30 }),
      C1003: simChar({ timer: null }), // 无计时器不参与
    };
    assert.deepEqual(nextDue(chars), { due: 30, cids: ["C0", "C1001"] });
  });

  it("全员无计时器 → null；空表 → null", () => {
    assert.equal(nextDue({ C0: simChar({}), C1001: simChar({}) }), null);
    assert.equal(nextDue({}), null);
  });
});

describe("reconcileGroups（组调和：自动并组 + 身份保稳 + id 继承）", () => {
  const at = (name: string, timer: number | null) => ({ location: { name }, timer });

  it("同 (location.name, timer) 自动并组；≥2 人才成组，单人归 0", () => {
    const { group, changed } = reconcileGroups(
      { C0: at("灯塔", 0), C1001: at("灯塔", 0), C1002: at("酒馆", 0), C1003: at("酒馆", 60) },
      { C0: 0, C1001: 0, C1002: 0, C1003: 0 },
    );
    assert.equal(group.C0, 1);
    assert.equal(group.C1001, 1); // C0+C1001 同组
    assert.equal(group.C1002, 0); // 同地不同刻 → 单人组
    assert.equal(group.C1003, 0);
    assert.equal(changed, true);
  });

  it("精确匹配：成员集不变的组保留原 id（timer 整体推进不换 id）", () => {
    const prev = { C0: 3, C1001: 3, C1002: 0 };
    // 连续轮：组内 timer 同步 0 → 10，location 不变，成员不变 → 必须保住 id 3
    const { group, changed } = reconcileGroups(
      { C0: at("灯塔", 10), C1001: at("灯塔", 10), C1002: at("酒馆", 10) },
      prev,
    );
    assert.equal(group.C0, 3);
    assert.equal(group.C1001, 3);
    assert.equal(group.C1002, 0);
    assert.equal(changed, false); // 指派结果与 prev 一致
  });

  it("身份保留：远程成员 location 不同但 timer 匹配 → 不拆组", () => {
    const prev = { C0: 1, C1001: 1 };
    const { group, changed } = reconcileGroups(
      { C0: at("灯塔", 0), C1001: at("酒馆", 0) }, // 异地同时（远程参与）
      prev,
    );
    assert.equal(group.C0, 1);
    assert.equal(group.C1001, 1);
    assert.equal(changed, false);
  });

  it("增员（superset）：新成员同地同刻并入 → 整组继承原 id", () => {
    const prev = { C0: 2, C1001: 2, C1002: 0 };
    const { group } = reconcileGroups(
      { C0: at("灯塔", 0), C1001: at("灯塔", 0), C1002: at("灯塔", 0) },
      prev,
    );
    assert.equal(group.C0, 2);
    assert.equal(group.C1001, 2);
    assert.equal(group.C1002, 2); // 并入既有组，不是新 id
  });

  it("增员可跨桶：远程成员两侧的同地同刻者都并入同一组", () => {
    const prev = { C0: 2, C1001: 2, C1002: 0, C1003: 0 };
    const { group } = reconcileGroups(
      { C0: at("灯塔", 5), C1002: at("灯塔", 5), C1001: at("酒馆", 5), C1003: at("酒馆", 5) },
      prev,
    );
    for (const cid of ["C0", "C1001", "C1002", "C1003"]) assert.equal(group[cid], 2);
  });

  it("减员（subset）：timer 被独立修改者离组，剩余成员继承原 id", () => {
    const prev = { C0: 1, C1001: 1, C1002: 1 };
    const { group } = reconcileGroups(
      { C0: at("灯塔", 0), C1001: at("灯塔", 0), C1002: at("酒馆", 10) },
      prev,
    );
    assert.equal(group.C0, 1);
    assert.equal(group.C1001, 1);
    assert.equal(group.C1002, 0); // timer 不匹配 → 离组归 0
  });

  it("分裂：最大子集继承原 id，并列取含最小 CID 者，另一侧取新 id", () => {
    const prev = { C0: 3, C1001: 3, C1002: 3, C1003: 3 };
    // 锚定 timer 并列（0 vs 10 各两人）→ 取较小值 0；C0+C1001 保留，C1002+C1003 自动成新组
    const { group } = reconcileGroups(
      { C0: at("灯塔", 0), C1001: at("灯塔", 0), C1002: at("酒馆", 10), C1003: at("酒馆", 10) },
      prev,
    );
    assert.equal(group.C0, 3); // 含最小 CID 的子集继承
    assert.equal(group.C1001, 3);
    assert.equal(group.C1002, 4); // 新 id = max(prev)+1
    assert.equal(group.C1003, 4);
  });

  it("合组 = 人少并入人多：两组 timer/location 对齐后并为大组的 id", () => {
    const prev = { C0: 1, C1001: 1, C1002: 2, C1003: 2, C1004: 2 };
    const { group } = reconcileGroups(
      {
        C0: at("灯塔", 0),
        C1001: at("灯塔", 0),
        C1002: at("灯塔", 0),
        C1003: at("灯塔", 0),
        C1004: at("灯塔", 0),
        C1005: at("酒馆", 30),
      },
      prev,
    );
    for (const cid of ["C0", "C1001", "C1002", "C1003", "C1004"]) {
      assert.equal(group[cid], 2, `${cid} 应并入人多的组 2`);
    }
    assert.equal(group.C1005, 0);
  });

  it("合组成员数并列：取含最小 CID 的 prev 组 id", () => {
    const prev = { C0: 1, C1001: 1, C1002: 2, C1003: 2 };
    const { group } = reconcileGroups(
      { C0: at("灯塔", 0), C1001: at("灯塔", 0), C1002: at("灯塔", 0), C1003: at("灯塔", 0) },
      prev,
    );
    for (const cid of ["C0", "C1001", "C1002", "C1003"]) {
      assert.equal(group[cid], 1, `${cid} 应并入含最小 CID 的组 1`);
    }
  });

  it("全新组合指派从未用过的新 id（max(prev)+1 起），不由 hash 派生", () => {
    const prev = { C0: 2, C1001: 2 };
    // C1001 timer 被改 → 离组；C0 与新角色 C1002 同地同刻 → 全新组合
    const { group } = reconcileGroups(
      { C0: at("灯塔", 0), C1002: at("灯塔", 0), C1001: at("酒馆", 5) },
      prev,
    );
    assert.equal(group.C0, 3);
    assert.equal(group.C1002, 3);
    assert.equal(group.C1001, 0);
  });

  it("空变化 → changed=false（含全部单人 0 态）", () => {
    const prev = { C0: 0, C1001: 0 };
    const { changed } = reconcileGroups({ C0: at("灯塔", 0), C1001: at("酒馆", 5) }, prev);
    assert.equal(changed, false);
  });

  it("location 与 timer 拼接碰撞不合并分桶", () => {
    const { group } = reconcileGroups(
      { C1001: at("a1", 2), C1002: at("a", 12) },
      { C1001: 0, C1002: 0 },
    );
    assert.deepEqual(group, { C1001: 0, C1002: 0 });
  });
});

describe("groupLocation（组位置 = 组内先攻最高者的 location，不落盘）", () => {
  it("先攻最高者的 location.name；同值取最小 CID", () => {
    const chars: Record<string, SimChar> = {
      C0: simChar({ group: 1, location: { name: "灯塔" }, initiative: { value: 15, group: 1 } }),
      C1001: simChar({ group: 1, location: { name: "酒馆" }, initiative: { value: 20, group: 1 } }),
      C1002: simChar({ group: 1, location: { name: "码头" }, initiative: { value: 20, group: 1 } }),
    };
    assert.equal(groupLocation(chars, 1), "酒馆"); // C1001 < C1002（同值最小 CID）
  });

  it("全员无先攻值 → 最小 CID 成员的 location；组不存在 → null", () => {
    const chars: Record<string, SimChar> = {
      C1002: simChar({ group: 1, location: { name: "酒馆" } }),
      C1001: simChar({ group: 1, location: { name: "灯塔" } }),
    };
    assert.equal(groupLocation(chars, 1), "灯塔");
    assert.equal(groupLocation(chars, 9), null);
  });
});

describe("orderGroups（同刻多组串行：组内最高先攻降序，同值比 CID）", () => {
  it("多组 + 单人混合：按组内最高先攻排序，无先攻值排最后", () => {
    const chars: Record<string, SimChar> = {
      C0: simChar({ group: 1, initiative: { value: 10, group: 1 } }),
      C1001: simChar({ group: 1, initiative: { value: 15, group: 1 } }),
      C1002: simChar({ group: 2, initiative: { value: 20, group: 2 } }),
      C1003: simChar({ group: 0, initiative: { value: 5, group: 3 } }),
      C1004: simChar({ group: 0, initiative: null }),
    };
    const units = orderGroups(chars, ["C0", "C1001", "C1002", "C1003", "C1004"]);
    assert.deepEqual(units, [["C1002"], ["C0", "C1001"], ["C1003"], ["C1004"]]);
  });

  it("最高先攻同值 → 比该成员 CID 升序", () => {
    const chars: Record<string, SimChar> = {
      C1005: simChar({ group: 1, initiative: { value: 18, group: 1 } }),
      C1006: simChar({ group: 1, initiative: { value: 3, group: 1 } }),
      C1002: simChar({ group: 2, initiative: { value: 18, group: 2 } }),
    };
    const units = orderGroups(chars, ["C1005", "C1006", "C1002"]);
    assert.deepEqual(units, [["C1002"], ["C1005", "C1006"]]); // 18 同值，C1002 < C1005
  });

  it("单人组各自独立单元", () => {
    const chars: Record<string, SimChar> = {
      C0: simChar({ group: 0, initiative: { value: 7, group: 1 } }),
      C1001: simChar({ group: 0, initiative: { value: 12, group: 2 } }),
    };
    assert.deepEqual(orderGroups(chars, ["C0", "C1001"]), [["C1001"], ["C0"]]);
  });
});

// 事件可见性 TAG 过滤由引擎承接（{events[*].content} 路由逐末端求值）——
// 用例口径见 placeholderEngine 四根契约测试。

describe("rollInitiative（d20 + reaction，同值 = 同时批次）", () => {
  it("降序分批；同值同批（批内 cid 排序）", () => {
    // 注入确定性骰子：C0→5，C1001→20，C1002→5（与 C0 同值）
    const rolls = [5, 20, 5];
    let i = 0;
    const { batches } = rollInitiative(
      [
        { cid: "C0", reaction: 0 },
        { cid: "C1001", reaction: 0 },
        { cid: "C1002", reaction: 0 },
      ],
      () => rolls[i++]!,
    );
    assert.deepEqual(batches, [
      { initiative: 20, cids: ["C1001"] },
      { initiative: 5, cids: ["C0", "C1002"] }, // 同值 = 同时行动
    ]);
  });

  it("reaction 修正计入总值；默认骰子落在 [1+reaction, 20+reaction]", () => {
    const { batches } = rollInitiative([{ cid: "C0", reaction: 3 }]);
    assert.equal(batches.length, 1);
    assert.ok(batches[0]!.initiative >= 4 && batches[0]!.initiative <= 23);
    // 确定性注入：reaction 拉开差距
    const rolls = [10, 10];
    let i = 0;
    const det = rollInitiative(
      [
        { cid: "C0", reaction: 5 },
        { cid: "C1001", reaction: 1 },
      ],
      () => rolls[i++]!,
    );
    assert.deepEqual(
      det.batches.map((b) => b.cids),
      [["C0"], ["C1001"]],
    );
    assert.equal(det.batches[0]!.initiative, 15);
  });
});

describe("rerollInitiative（补投：组编号不符者单独投，不波及全组）", () => {
  it("只投 initiative 为 null 或组编号不符者，结果盖当前组编号", () => {
    const rolls = [7, 9];
    let i = 0;
    const assignments = rerollInitiative(
      [
        { cid: "C0", reaction: 5, initiative: { value: 12, group: 1 } }, // 组编号对上 → 保留
        { cid: "C1001", reaction: 5, initiative: null }, // 未投掷 → 补投
        { cid: "C1002", reaction: 0, initiative: { value: 8, group: 2 } }, // 组编号不符 → 重投
      ],
      1,
      () => rolls[i++]!,
    );
    assert.deepEqual(assignments, [
      { cid: "C1001", initiative: { value: 12, group: 1 } },
      { cid: "C1002", initiative: { value: 9, group: 1 } },
    ]);
  });

  it("全员组编号对上 → 空结果（连续轮不重投）；归 0 保留的旧值进新组才重投", () => {
    const settled = rerollInitiative(
      [
        { cid: "C0", reaction: 0, initiative: { value: 12, group: 1 } },
        { cid: "C1001", reaction: 0, initiative: { value: 8, group: 1 } },
      ],
      1,
      () => {
        throw new Error("不应触发投掷");
      },
    );
    assert.deepEqual(settled, []);
    // 归 0 除外规则：group=0 时保留旧值（{value, group:1}），被召回原组 1 时组编号对上 → 复用不重投
    const recalled = rerollInitiative(
      [{ cid: "C0", reaction: 0, initiative: { value: 12, group: 1 } }],
      1,
      () => {
        throw new Error("召回原组应复用先攻");
      },
    );
    assert.deepEqual(recalled, []);
    // 若被拉进别的组（组 2）→ 组编号不符 → 重投
    const regrouped = rerollInitiative(
      [{ cid: "C0", reaction: 0, initiative: { value: 12, group: 1 } }],
      2,
      () => 6,
    );
    assert.deepEqual(regrouped, [{ cid: "C0", initiative: { value: 6, group: 2 } }]);
  });
});

describe("initiativeBatches（行动顺序派生还原：initiative 变量现排）", () => {
  it("按 {value, group} 的 value 降序分批；同值同批；null 排最后", () => {
    const batches = initiativeBatches([
      { cid: "C0", initiative: { value: 5, group: 1 } },
      { cid: "C1001", initiative: { value: 20, group: 1 } },
      { cid: "C1002", initiative: { value: 5, group: 1 } },
      { cid: "C1003", initiative: null },
    ]);
    assert.deepEqual(batches, [
      { initiative: 20, cids: ["C1001"] },
      { initiative: 5, cids: ["C0", "C1002"] },
      { initiative: null, cids: ["C1003"] },
    ]);
  });
});
