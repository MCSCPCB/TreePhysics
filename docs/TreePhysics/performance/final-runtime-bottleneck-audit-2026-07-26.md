# 巨型树最终运行时瓶颈审计

## 结论与当前阶段

关闭 Bedrock script profiler 后的两轮实机日志已经定位出最后一项值得实施的安全大块优化：巨型树
活动期约 `70%-80%` 的脚本物理耗时位于世界 collider 同步，而不是视觉同步或 Cannon 求解；其中
低 shape 巨型云杉的旋转 AABB 含有大量不可能接触装配体的非空气候选。

最新基线中的巨型云杉关键帧为：

- `sr=1497, sh=777/720, sd=3, rd=22`；
- `sr=1469, sh=764/705, sd=3, rd=23`；
- `sr=1147, sh=676/471, sd=2, rd=15`；
- `sr=1147, sh=631/516, sd=2, rd=19`。

shadow 可以排除 `41%-48%` 的候选，自身只消耗 `2-3 ms`，预计重帧净省约 `4-8 ms`。相反，巨型
丛林木只有 `19%-27%` 可排除，且 `19-23` 个 shape 的 shadow 判断本身消耗 `5-7 ms`，没有可靠净
收益。因此正式路径现已采用自适应策略：只过滤低 shape、大扫描、大候选批次；丛林木保持原完整读取。

Cannon 的实际 contacts 仅 `0-4`，`pair_upper` 只是宽松上界，仍不支持拆刚体、增加装配体、修改
solver、减少子步或减少 collider。上述结论只覆盖活动期。后续静止巨树实机反馈促使审计重新检查
`a=0/1` 的真正休眠路径，并发现休眠环境签名尚未复用批量非空气预筛选，稳定支撑检查还会无条件生成
临时 world collider。两项均已无损修正，详见 `giant-tree-runtime-optimization-2026-07-26.md` 的
“休眠巨树世界验证补充优化”。因此活动期已接近当前约束下的边界，休眠期需要新的 release A/B 后
才能收口。

## 本轮诊断实现

### 开关与内存边界

`tree_perf_debug` 会把诊断状态传递到 `PhysicsWorld`、已有和未来创建的 `PhysicsDimension`，最终传到
`CannonKernelRuntime`。关闭时：

- 高 shape 或小扫描体不创建 shadow shape；
- 低 shape、大扫描体只在批量 API 成功返回至少 256 个 coverage 内非空气候选时运行正式过滤；
- 不执行新增的阶段 `Date.now()`；
- 不保存性能样本；
- 耗时诊断字段为 `0`，正式过滤的自然计数仍可随 step 结果返回但不会被保存或输出。

开启时只保留当前 600 tick 的固定窗口。输出汇总后立即清空，不会形成无界历史或 profiler 式内存
增长。单项汇总格式统一为 `P50/P95/P99/max`。

旧路径原本无论是否输出日志都会为 kernel、世界总步、simulation 和视觉同步固定调用 `Date.now()`。
现在这些运行时 clock 读取也全部受同一开关控制；关闭时耗时字段为 `0`，查询数、body 数、事件和物理
结果不变。kernel 的 active/sleeping body 统计同时合并进原有 transform 写入遍历，删除了每 tick 额外的
完整 body 统计遍历。通常只有一个受管理维度时，世界性能汇总也直接复用该维度样本，不再为每个指标
逐项执行 `reduce`；多维度仍走原聚合逻辑并有回归覆盖。这些是本轮可以直接发布的无语义常数优化。

### 世界同步分段

新增指标将原 `ws` 拆成：

| 字段 | 含义 |
| --- | --- |
| `bounds_ms` | 动态 body 预测范围、cluster 组织及同段睡眠环境工作 |
| `batch_ms` / `bd` | `Dimension.getBlocks()`、原生 iterator 和 coverage 筛选 |
| `read_ms` / `rd` | 正式 `getBlock()`、方块状态和碰撞形状解析 |
| `reads` / `sr` | 实际执行的正式方块读取数 |
| `solids` / `ss` | 读取后解析为具有碰撞形状的实体方块数 |
| `mesh_ms` / `md` | 完整方块贪心合并与部分方块 box 输出 |
| `layout_ms` / `ld` | collider layout 排序和相等性比较 |
| `rebuild_ms` / `xd` | 删除并重建变化后的 Cannon 世界 collider |
| `buoyancy_ms` | 浮力点未覆盖液体的补充读取 |
| `eq` / `sleep_queries` | 当前 tick / 600 tick 汇总的休眠环境与支撑查询量 |
| `sa` / `shadow_apply` | 本 tick 正式应用 shadow 过滤的 cluster 数 |
| `sh=keep/drop` | shadow 保留与排除的 coverage 内非空气候选数 |
| `sd` / `shadow_ms` | shadow 判断自身耗时 |

各阶段均围绕整个批次计时，没有给每个候选增加一次时钟调用。
`PhysicsPerf.interval_ms` 是物理 step 的实际调用间隔，可用于判断 TPS/主线程停顿；它与单步执行耗时
`ms` 分开记录，避免把客户端掉帧或其他系统停顿全部误归因给物理函数。

### 自适应 Shadow 正式过滤

原生 `getBlocks()` 必须查询旋转 shape 的世界 AABB，因此会返回几何上不可能接触树木的 AABB 角落
方块。shadow 对 coverage 内的非空气候选执行以下保守判断：

1. 把候选单位方块的世界 AABB变换到刚体当前局部坐标；
2. 与每个 collider shape 的局部 bounds 比较；
3. shape bounds 额外加入原扫描边距、一 tick 线位移上界和角位移上界；
4. 多 shape 或多 body 的重叠 cluster 取保守并集。

正式过滤必须同时满足：

- 当前 body 不超过 4 个实际 Cannon shape；
- body 预测扫描体积至少 256 方块；
- 原生批量 API 完整成功；
- coverage 内非空气候选至少 256 个；
- cluster 合并的每个成员都满足资格，不能混入睡眠 support 或高 shape body。

满足时，候选数组原地压缩为 shadow 保留位置，再进入原有 `getBlock()`、液体、sensor、材质、完整/
部分碰撞解析和贪心合并；`sq` 与扫描包围盒完全不变。`sa`/`shadow_apply` 是正式应用的 cluster 数，
`sh=keep/drop` 是判断结果。诊断开启时 `ws` 包含 `sd`/`shadow_ms`；关闭时不调用运行时 clock。

浮力点可能来自不参与 Cannon collider 的树叶，不能把 shadow 排除区域误认为已完整读取。每 tick 会
区分完整 coverage 与正式 shadow coverage：保留位置直接复用批量扫描结果；真正被 shadow 排除的
浮力位置只补充一次 `getBlock()`。因此水、岩浆和入液事件保持准确，额外查询仅受既有浮力点预算约束。
批量 API 调用或 iterator 中途失败时会丢弃半批结果，`sa=0` 并完整回退原逐坐标扫描。

### Cannon 规模

新增 `contacts`、`friction`、`world_bodies`、`world_colliders`、`dynamic_shapes` 和 `pair_upper`。
接触和摩擦数取三个 Cannon 子步中的最大值；`pair_upper` 是动态 shape 与世界 collider box 数量乘积，
用于判断 broadphase/narrowphase 的潜在上限，不代表实际执行了这么多窄相检测。

### 客户端附件控制器

`[TP:A] ac` 继续表示附件裁剪决策使用的最坏情况可避免控制器数，不能直接当作当前客户端活动数。
新增 `af` 表示最终保留在装配体中的附件 fragment 数，`arc` 表示这些 fragment 按当前 foliage tint
实际可能激活的控制器数。藤蔓在无 colormap、统一 colormap、渐变 colormap 下分别按每 fragment
`1`、`2`、`27` 计算；其他附件按生成资源中受 family mask 激活的真实控制器组计算。该统计只在
创建装配体且诊断已开启时计算，不增加正常砍树成本。

### 生命周期分段

`lifecycle_perf` 的 600 tick 汇总增加以下阶段：初始化、视觉对账、恢复、跨域、岩浆、装配体易碎探针、
世界易碎探针、衰减、方块 flush、结算、实体伤害、持久化、job 调度和树循环未归因开销。此前丛林木
出现的 `duration max=96 ms` 现在可以直接定位，不再只能猜测。

## 实机测试矩阵

测试必须使用 release 构建并关闭 script profiler。profiler 已明确会在该设备上积累内存并最终 OOM，
不能用于本轮长窗口诊断。

每个场景进入世界后先执行：

```text
/scriptevent tree_physics:tree_perf_debug on
/scriptevent tree_physics:lifecycle_perf on
```

分别记录以下场景，每个场景至少保持 600 tick，以取得完整汇总：

1. 单棵巨型丛林木完整倒伏到休眠；
2. 单棵巨型云杉木完整倒伏到休眠；
3. 两棵同类巨树同时活动；
4. 一棵巨树静止、另一棵巨树活动；
5. 同规模树在水边或部分浸水活动，用于确认浮力补充读取；
6. 巨树最终结算一次，用于捕获 lifecycle 的持久化和 job 峰值。

收集 `[TP:A]`、连续 `[TP:P]`、`[TreePhysics:PhysicsPerf]`、
`[TreePhysics:WorldSyncPerf]`、`[TreePhysics:CannonPerf]`、三条 lifecycle 汇总，以及同一设备的平均/P1
FPS 和平均/最低 TPS。完成后执行：

```text
/scriptevent tree_physics:tree_perf_debug off
/scriptevent tree_physics:lifecycle_perf off
```

## 决策结果与后续门槛

### 真实候选过滤

原门槛要求活动峰值由 `ws/read_ms` 主导、排除率稳定达到约 `40%`、shadow 自身远低于预计读取节省，
并保持液体、partial block、sensor 和 fallback 一致。云杉全部满足，丛林木不满足，因此没有使用全局
开关，而是落实为上述 `4 shape / 256 scan volume / 256 batch locations` 的保守自适应门槛。

实现继续允许 false positive、禁止 false negative。回归覆盖旋转、极端角速度、低候选批次、高 shape、
cluster 合并、批量调用失败、iterator 中途失败、shadow 外浮力点、partial block 和 sensor。任何后续
放宽阈值都必须重新提交 Bedrock 净收益证据，不能仅凭 Node benchmark 或 `pair_upper` 推断。

### 其他归因

- `batch_ms` 主导而 `read_ms` 很低：成本在 Bedrock 原生体积扫描，shadow 无法获得大收益；更可能接近
  SAPI 技术边界。
- `mesh_ms` 主导：再评估稀疏 mesher 或可复用数值缓冲，不能缓存跨 tick 方块内容。
- `layout_ms` 或 `rebuild_ms` 主导：研究稳定 collider body 的增量复用，但必须保持材质、sensor 和部分
  方块 layout 完全一致。
- `cs`、`contacts`、`friction` 和 `pair_upper` 同时主导：才有理由进一步检查 Cannon broadphase/
  Narrowphase；shape 数低而 contact 数也低时不 fork Cannon。
- 脚本 `ms` 很低但 FPS 仍明显下降：剩余问题位于 Bedrock 客户端 fragment geometry、render
  controller、Molang 或透明植被渲染。当前实体打包和控制器门控已经完成，未证明收益前不增加实体或
  改变可见模型。
- lifecycle 的某个阶段 max 单独升高：只优化该阶段；不得以运行时碰撞改动掩盖一次性持久化或结算
  峰值。

## 当前安全结论

本地最终验证为 23 个测试文件、366 项通过，类型检查、完整 benchmark、debug/release 构建均通过。
release 产物保留在 `packs/TreePhysics`，且包内没有 `physics_api` 标识。benchmark 中生产 high 树、
单棵 980 方块 auto 树和 10 棵 980 方块生命周期本轮均完整运行；这些 Node mock 数据用于防止算法级
退化，不模拟 Bedrock `Dimension.getBlocks/getBlock` 的宿主边界成本，因此不能替代本次实机日志，也
不把不同运行间的数值波动当作正式收益。

当前提交让低 shape、大候选活动扫描少执行几百次原有 `getBlock()` 与方块形状解析；大型休眠环境
签名改为批量非空气预筛选，稳定支撑不再生成临时 collider。它不改变玩法、物理步长、solver、扫描
coverage、碰撞 shape、环境签名内容、检查频率、视觉、实体数量、音效、粒子、掉落、恢复或持久化
语义。高 shape 丛林木在常态发布路径不创建 shadow 数据；诊断关闭时不运行时钟或保存样本。活动期
与休眠期的 release A/B 均通过后，才可认为现有架构已经没有值得继续实施的安全大块 TPS 优化；不应
再基于猜测拆分刚体或降级质量。

## 目标完成度审计

| 目标要求 | 权威证据 | 状态 |
| --- | --- | --- |
| 全面覆盖物理、SAPI、渲染实体、粒子、音效、掉落、构建、生命周期和持久化 | `audit-and-optimization-2026-07-24.md`、巨树专项和本文件的分系统代码审计 | 已完成静态与 Node 侧审计 |
| 默认关闭且有界的最终诊断 | clock 零调用回归、600 tick 清空、shadow/阶段字段测试、release 构建 | 已完成 |
| 不改变物理、玩法、视觉和实体数量 | 诊断开关状态逐值一致、`sq` 不变、极端运动/液体/partial/sensor/fallback 回归、现有全量测试 | 代码侧已证明；Bedrock 视觉/FPS A/B 待实机 |
| 实施所有无需额外证据即可判断安全的优化 | 非空气批量筛选、自适应 shape 并集、客户端控制器/fragment 优化、最终掉落单批事务、休眠快路、clock/body/单维度汇总常数优化 | 已完成 |
| 判断并实施所有仍值得做的安全大块优化 | 活动云杉 `41%-48%` 排除率；休眠批量签名；稳定支撑零临时 collider；contacts `0-4` | 已完成自适应 shadow 与休眠补充快路 |
| 平均/最低 TPS、平均/P1 FPS 与玩法视觉验收 | 本文件“实机测试矩阵”的游戏日志和设备测量 | 证据缺失 |
| 测试、benchmark、debug/release 构建及最终包命名 | 23 文件 367 项测试、完整 benchmark、双构建校验、包内命名搜索 | 已完成 |

剩余工作不是继续扩大代码改动，而是用新的 release 包复测一棵巨型云杉和一棵巨型丛林木。活动期
云杉应出现 `sa>0` 且 `sr=shadow_keep`，丛林木应保持 `sa=0`；真正休眠后应为 `a=0/1`，600 tick
汇总中的 `sleep_queries` 用于捕获错峰检查，稳定支撑 tick 不应再出现临时 `boxes/rebuild`。玩法、碰撞、
浮力无差异且活动与休眠 TPS 均改善后，才可确认到达当前“不降低质量、不增加实体”约束下的 TPS
技术边界。
