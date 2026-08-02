# 架构优化审查意见

本文记录逐项审查后已经确认的优化意见。仅记录已完成讨论并达成一致的事项；后续事项在确认后追加。

## 1. 真相层原子提交

### 现状

当前一次逻辑步骤会依次修改并立即持久化多个 Store，例如：

- world deltas、时钟和 pipeline；
- 一个或多个 character 的 timer、location、group、relations 等字段；
- events、archive、lore 和 working set。

完整 `var_changes` 通常在这些修改完成后才写入 pipeline。任一中间写盘失败或进程退出，都可能留下部分文件已更新、部分文件未更新的混合状态；此时回滚记录也可能不完整。已完成 GM 步的编辑还存在先反转旧变化、再校验新裁决包的顺序，校验失败时会留下旧变化已被反转的状态。

### 决定

采用：

> 增量 `CommitPlan` + 完整 Generation + `CURRENT` 原子切换 + 保留当前及上一 Generation。

`CommitPlan` 只记录本次新增或修改的条目，不保存完整存档。事务层把 plan 应用到当前内存状态，完成全部校验后生成一个完整、自足的新 Generation。只有新 Generation 完整写入并通过校验后，才原子替换 `CURRENT` 指针。

外部只能观察到提交前或提交后的完整状态，不得观察到中间状态。

### CommitPlan 形式

暂不引入按领域划分的判别联合 `TruthOperation`。当前预期膨胀主要发生在 world 和 characters 内部，例如一次增加或修改多个 character 条目；现有通用 `VarChange` 模型已经可以表达路径级新增、修改和删除，引入多种 operation 类型会增加 schema、执行器、回滚和版本维护成本，目前收益不足。

建议采用常规变更记录：

```ts
interface CommitPlan {
  transactionId: string;
  baseRevision: number;
  reason: "step" | "gm" | "rollback" | "admin_edit";
  changes: VarChange[];
}

interface VarChange {
  path: string;
  before: unknown;
  after: unknown;
  before_exists?: boolean;
  after_exists?: boolean;
}
```

路径应从真相根开始，能够覆盖不同数据域，例如：

```text
world.region.harbor.fog
characters.C1001.timer
characters.C1002.relations.C1001
characters.C1003.inventory.2
pipeline.working_set
```

一次 plan 可以包含任意数量的 world 或 character 变化，因此可以适应角色数量、角色字段和世界状态在一局存档中动态增长。

### 常规变更记录的边界

通用 `VarChange` 只负责描述最终状态差异，不负责表达业务命令。GM、角色、玩家和用户编辑仍须先经过各自的 schema、权限和领域规则校验，再统一产生 `VarChange[]`。

以下行为不应依赖模糊的数组下标操作：

- event/archive 的追加和按 seq 截断；
- character 的新增或删除；
- 大型数组中间插入或重排。

对这些结构，plan 生成器应先计算变更后的完整字段值，再记录该字段的 before/after；或者使用稳定 ID 的对象映射。只有在此方式出现明确的性能或歧义问题后，才考虑为少数结构增加专用 operation，不预先建立全套领域操作联合。

### 提交流程

1. 读取当前 revision 和真相状态。
2. 解析输入并完成 schema、权限和领域语义校验。
3. 生成完整 `CommitPlan`，确认 `baseRevision` 等于当前 revision。
4. 在 copy-on-write 的下一状态上应用全部 `changes`。
5. 校验修改后的完整 schema 和跨文件不变量。
6. 将完整状态写入新的临时 Generation 目录。
7. 对临时 Generation 重新读取并校验。
8. 将临时目录确认为正式 Generation。
9. 原子替换 `CURRENT`，此后才切换 Store 的内存根引用。
10. 保留当前和上一 Generation；更旧版本由独立的 best-effort 清理删除。

清理失败只记录告警，不得把已经成功切换的事务报告为失败。启动时清理未完成的临时 Generation。

### Generation 与逻辑回滚

Generation revision 与游戏 seq 是两个独立概念：

- Generation revision 是物理存储提交版本，只能递增；
- pipeline seq 是游戏逻辑步骤，回滚时可以下降。

用户回滚时，仍使用当前 Generation 内的 archive、events、lore changelog 和 `var_changes` 计算目标状态，然后把回滚结果作为一个新的 `CommitPlan` 提交到新的 Generation。删除更旧 Generation 不影响现有逻辑回滚，因为最新 Generation 必须包含允许回滚所需的完整历史数据。

保留上一 Generation 的用途是存储灾备，而不是游戏回滚。

### 用户主动编辑

用户编辑存档也必须经过同一事务入口：

1. 编辑请求携带打开编辑页面时的 `baseRevision`；
2. 服务端校验完整输入并计算与当前状态的 diff；
3. 若当前 revision 已变化，则拒绝旧编辑，避免覆盖新产生的游戏状态；
4. 将 diff 记录为 `reason: "admin_edit"` 的 CommitPlan；
5. 通过相同 Generation 流程提交。

任何字段校验失败时，内存、正式文件和 `CURRENT` 都必须保持不变。

### 资源约束

当前不采用不可变 events/archive 分段。项目存档通常不超过百兆，接受每次提交完整写入新 Generation 所产生的磁盘写入放大。

内存中只保留当前状态、增量 plan 和 copy-on-write 的下一状态；不缓存历史 Generation。完整 JSON 序列化仍会产生短时内存峰值，但在当前存档规模约束下可以接受。如果未来实测出现明显内存或磁盘瓶颈，再评估流式序列化或不可变分段，不提前增加复杂度。

### 验收条件

- 任一写入、校验或切换点故障后，重新加载只能得到完整旧状态或完整新状态。
- 非法 GM 编辑和非法用户编辑失败前后，内存及当前 Generation 保持不变。
- archive、pipeline、events 的 seq 关系通过跨文件校验。
- 当前 Generation 损坏时可回退到上一 Generation，并明确报告恢复行为。
- rollback 提交后 Generation revision 递增，而游戏 seq 正确回到目标步骤。
- `npm run typecheck` 与 `npm test` 通过，并新增覆盖写盘故障、revision 冲突和恢复流程的测试。
