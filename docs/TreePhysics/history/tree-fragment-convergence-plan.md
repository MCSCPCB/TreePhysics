# 树木物理与 Fragment 最终性能收敛计划

> 2026-07-18 状态更新：本文的固定 `#80A755`、`alpha_block_color_tint`、负 alpha
> `overlay_color` 以及“颜色路径清零”部分已被
> [`foliage-colormap.md`](../design/foliage-colormap.md) 取代。当前正式实现使用
> 原版 colormap、装配时稀疏 biome 采样、冻结的一阶 UV 场和每 fragment 一个 24-bit
> `client_sync` 属性；本文其余物理质量和性能边界继续有效。

## 文档状态

- 状态：待实施；本文是下一阶段的执行依据。
- 目标：在原木和树木附着物物理质量不下降、整体视觉语义几乎不变的前提下，收敛
  树叶物理成本和显示实体成本，使常规实机负载尽量稳定在 `15-20 TPS`。
- 完成判据：主要热点被消除后，没有仍能在不牺牲物理质量或玩法语义的情况下带来大幅
  收益的优化；剩余工作只属于小幅常数优化、引擎宿主成本或明确需要降低质量的取舍。
- 发布方式：开发期间用自动测试、基准、Script Profiler 和内部实机探针验证，完成后只做
  一次最终人工验收。

本文覆盖现有 fragment 渲染器的继续压缩、固定树叶/藤蔓颜色、树叶物理质量分级、生命周期
错峰和最终性能验收。它取代
[`fragment-renderer.md`](../design/fragment-renderer.md)
中所有 BlockMap、颜色调色板、精确群系 tint 和颜色属性同步计划；旧文档仍保留为已实现
fragment 架构的历史和证据记录。

## 证据等级

| 标记 | 含义 |
| --- | --- |
| `官方支持` | 微软 Creator 文档明确记录对应 API 或资源包字段 |
| `本地样例` | 工作区 sample 中存在可定位的同类用法 |
| `当前实现` | 当前项目已经生成、测试或实机运行该能力 |
| `项目实机` | 行为没有公开规范，但已经由本项目的目标基岩版本实机验证 |
| `组合验证` | 每个基础原语有依据，组合后的规模或性能仍需原型和实机门槛 |
| `技术阻塞` | 缺少决定实现语义所需的资料或已知平台能力 |

## 不可变边界

### 物理和玩法

1. 原木的逻辑方块、质量、质心、惯性、碰撞、浮力、冲量、牵引、伤害和掉落语义不得降级。
2. 蜂巢、可可豆、藤蔓、胎生苗、垂根、苍白垂苔和嘎吱之心等附着物保持现有模型、状态、
   易碎阈值、掉落和蜜蜂生成语义。
3. 世界方块仍由活动物理步中的 `getBlock()` 结果作为事实来源；不得重新引入跨 tick 世界
   方块快照，也不得为了性能漏掉脚本改块或自然方块变化。
4. 树木识别、自然根、人工树记录、跨域结算、重载、累计休眠、伤害和玩家交互不因本计划
   改变。
5. 性能降级只允许发生在树叶接触传感器、树叶补充探针、树叶断连判断和树叶批量破碎粒度。

### 渲染

1. 已注册原版树优先走 fragment；旧 `physics_api:physics_block` 一方块一实体渲染器原样保留，
   只作为含未注册方块装配体的整树兜底。
2. 结构数据继续使用 `client_sync` 实体属性；不使用 `playAnimation` 传值，也不增加周期性
   Molang 重播。
3. 不设置显示实体硬上限。排序目标依次为：视觉语义正确、服务端性能不退化、实体越少越好。
4. 原木渲染精度优先于附着物，附着物优先于树叶；不能通过降低原木或附着物模型精度换取
   更少实体。

## 唯一颜色方案

从本计划开始，树叶和藤蔓的目标颜色固定为 `#80A755`。颜色只允许存在于以下两个资源包
位置，除此之外，脚本、快照、实体属性、布局算法、持久化和测试夹具均不得保存或计算颜色。

### 1. 自定义材质

保留 [`packs/TreePhysics/RP/materials/entity.material`](../../packs/TreePhysics/RP/materials/entity.material) 中从
`alpha_block_color` 派生并启用 `USE_OVERLAY` 的 `alpha_block_color_tint`。树叶和藤蔓使用
该材质；其他附件继续使用各自的 opaque/cutout 材质。

- 材质继承和 define：`官方支持`，见 [MS-MATERIALS]。
- `alpha_block_color` 与 `USE_OVERLAY` 的组合：`项目实机`。
- 自定义材质在未来基岩版本的兼容性：微软明确提示材质能力可能变化，因此列入每次目标
  游戏版本升级的实机回归项。

### 2. Render controller 的 `overlay_color`

树叶 controller 和藤蔓 controller 固定输出语义颜色 `#80A755`。按照本项目已经验证的负
alpha 乘色机制，controller 实际写入目标 RGB 的反色以及 `a: -1`：

```json
"overlay_color": {
  "r": "1 - 128 / 255",
  "g": "1 - 167 / 255",
  "b": "1 - 85 / 255",
  "a": -1
}
```

这里的表达式值不是另一种颜色规范，而是为了让最终可见结果成为 `#80A755` 的材质输入。
`overlay_color` 字段和 Molang 表达式为 `官方支持`，见 [MS-RC]；负 alpha 的反色乘算语义
没有公开规范，证据等级为 `项目实机`。

### 必须删除的旧颜色路径

实施时一次性删除以下整条链，不能留下“以后可能重新启用”的半成品：

- `CapturedTreeBlock.tint` 和 `captureBlockTint()`；
- 对 `minecraft:map_color`、`BlockMapColorComponent.color/tintedColor` 的访问；
- `PhysicsAssemblyBlockVisual`、`PackedTreeFragment` 和持久化快照中的 `tint`；
- 叶片 `c0..c7` palette 属性、palette 分片和 4-bit 颜色索引；
- 附件的 `physics_api:tint` 属性和按 tint 拆分 fragment；
- `FOLIAGE_FALLBACK_TINT` 以及树种/群系/温度/降水/colormap 颜色表；
- 只验证 BlockMap 或动态颜色打包的测试。

生成后的 `packs/TreePhysics/BP/scripts/main.js` 只由构建流程更新，不手工修改。

## 当前基线

当前 fragment 渲染器已经投入主路径，不需要重建：

- 原木：`7 x 4 x 7 = 196` 个固定槽，3 bit/槽；
- 树叶：`6 x 3 x 6 = 108` 个固定槽，4 bit/槽，附带 8 色 palette；
- 附着物：每实体 26 个动态槽；
- 123 方块标准树的自动基准由 123 个旧显示实体降为 9 个 fragment 实体；
- 所有 fragment 共享装配体锚点，每物理步只同步实体锚点和整体姿态；
- 未注册类型或不能无损编码的状态会在生成任何 fragment 前让整树回退旧渲染器。

当前物理侧也已经做过第一轮合并：原木和树叶完整体素分别经 `meshVoxels()` 精确 greedy
合并，树叶传感器 `collisionResponse: false`，并由每棵活动树每 tick 最多 64 个补充探针
弥补 begin-contact 不重复触发的问题。因此下一轮必须以实际 shape 数和 profiler 为依据，
不能把“当前每片叶子一个 Cannon shape”当作错误前提。

## 工作包 A：固定色与少实体渲染收敛

### A1. 固定色清理

按“唯一颜色方案”删除所有服务端颜色数据。完成后应满足：

- 捕获一棵树不再读取任何颜色组件；
- 叶片和藤蔓实体不再接收颜色属性；
- 重载存档不再包含颜色字段；旧存档中的多余 `tint` 字段按普通未知字段忽略；
- 所有树叶和藤蔓最终可见颜色均为 `#80A755`；
- 其他附件绝不套用 foliage overlay。

这一步本身会减少树木捕获 API 调用、序列化字段、属性写入和因颜色不同而产生的 fragment。

### A2. 叶片槽位重新编码

对同一叶片 family 的 fragment，把每槽状态从“空或 8 个 palette 索引”改为 1-bit
“空/存在”。family 仍是实体级结构属性，不是颜色属性。

优先原型是最多约 245 个槽的固定体素布局，例如 `7 x 5 x 7` 或 `9 x 3 x 9`。选择方式不是
凭感觉固定，而是用全部原版 tree feature 的最不利边界和当前树扫描可产生的异常长形布局
分别装箱，以“实体数最少”为第一排序，以 controller 数、空槽率和资源体积为后续排序。

- 1-bit 位图、`query.property()`、`math.floor/mod`：`官方支持`基础原语加`当前实现`组合。
- 固定 bone/cube 和 `part_visibility`：`官方支持`，且当前 196 槽原木 geometry 已经运行。
- 245 左右 bone 的单 geometry 没有公开硬上限：`组合验证`。原型失败时回退当前已经证明的
  196 槽布局，不影响功能，只会少获得一部分实体压缩收益。

同 family、同材质、同固定颜色的叶片不再需要每槽一个 controller。优先生成一个叶片
controller，在同一个 `part_visibility` 中控制全部槽位，并只写一次固定 `overlay_color`。

如果原版 feature 统计证明混合 family 的树冠因按 family 分实体而明显增加实体，可增加一个
混合叶片布局：每槽编码 family，牺牲一部分槽容量并使用逐槽 texture controller。它只在
“总实体数确实更少”时采用；颜色仍是固定 overlay，不允许恢复 palette。

### A3. 附着物槽位

删除附件 tint 元数据和按 tint 分组后，附件 fragment 从 26 个动态槽提高到 27 个，同时
保持总实体属性不超过 32。所有附件类型和状态仍由每槽 descriptor 编码，只有 vine
controller 使用固定 foliage overlay。

27 槽是现有 26 槽实现的直接扩展，属于 `当前实现`上的内部位图调整。若资源生成或几何
审计发现某附件模型使 bone 数超过当前安全基线，则保留 26 槽；这不是功能阻塞。

### A4. 原木和旧回退

原木 `7 x 4 x 7` 布局暂不改变。它已经同时表达 family、轴向和去皮状态，继续压位会提高
属性解码及纹理选择复杂度，而原木数量通常不是实体数主因。

旧 `createBlockVisual()`、`physics_api:physics_block` BP/RP 和一方块一实体同步路径不得删除
或改写。fragment 与旧路径仍按整装配体择一，不能混合渲染同一棵树。

## 工作包 B：装配时固定树叶物理质量

### B1. 成本预算与档位选择

正式运行时不读取、估算或输出游戏 TPS，也不把 `stepIntervalMs` 接入质量选择。游戏内实际
TPS 由项目方肉眼测试并反馈，代码侧只记录能够解释热点的 step/lifecycle duration、world
block query、world collider、shape、rebuild 和 transform write 指标。

代码级性能回归复用 `archive/cannon-es-physics-2` 的方法：

- Vitest 压力场景记录 mean/P50/P95/P99，并按 20 TPS 对应的 `50 ms/tick` 预算判断余量；
- 当前项目与归档使用相同机器、相同 Node/Vitest 版本和配对场景比较，避免跨机绝对值误判；
- `cannon-es-comparison-main.ts` 的窗口统计只作为历史实现参考，不接入正式游戏运行时。

创建树木装配体时根据可预测的静态成本选择质量档：

- 叶片数量、占据范围和精确 greedy 叶片 shape 数；
- 原木、附件和叶片规模；
- 当前活动树已经分配的叶片 shape、探针、浮力点和破碎组预算。

选择表由代码基准建立，再根据项目方反馈的游戏内 TPS 在版本之间校准。质量一经选择不再
运行时切换；小树默认最高质量，大树和高并发场景按累计预算选择更低叶片档。最低叶片档仍
无法达到目标时，按本计划定义为基岩宿主或硬件性能边界，不再牺牲原木和附件质量。

### B2. 质量档语义

质量档不使用“低/中/高”硬编码盒数，而由基准校准出目标叶片组数。约束如下：

| 档位 | 叶片语义 |
| --- | --- |
| 精确档 | 保留当前精确 greedy 传感器和逐叶破碎语义 |
| 聚合档 | 将叶片确定性划成较少破碎组；一组内任意叶片触发时整组破碎 |
| 极限档 | 必要时允许全部叶片成为一个破碎组；一次触发可破碎整棵树冠 |

例如代码基准和实机反馈表明某一规模档只需约 5 个叶片组即可恢复到目标，就把该结果写入
下一版静态选择表；不能在实现前凭感觉写死。目标是优先保持 `15-20 TPS`，而不是机械追求
最少盒。

### B3. 叶片组结构

每个逻辑叶片仍保留原有方块位置、类型、质量、浮力体积、视觉槽位、叶距和掉落快照。
聚合只替换以下运行时表示：

- 无响应叶片接触传感器；
- 每 tick 补充世界接触探针；
- 叶片浮力采样点；
- 断连支持图和衰减批次；
- 命中后进入同一次删除事务的叶片集合。

原木和附件 collider 不进入叶片聚合。树叶传感器仍是 `collisionResponse: false`，因此较粗
代理不会给装配体增加阻挡、摩擦或回弹；可见代价主要是更早或更大批量的叶片破碎，以及
随破碎提前移除相应叶片质量和浮力。

破碎组数、传感器盒预算和浮力采样点预算是三个独立参数。一个破碎组可以由多个高填充率
传感器盒覆盖；即使极限档只有一个破碎组，也不能无条件用包围整个稀疏树冠的单个巨大
AABB。装箱代价函数同时考虑 shape 数、盒内空白率、预计 world block query 数和 collider
同步耗时，防止“shape 更少但扫描体积更大”的反优化。

聚合浮力点保存组内总浮力体积和体积加权中心；精确档仍逐叶采样。这样会降低树冠不同部位
浸水时的力矩精度，但只发生在允许降级的叶片部分。原木和附件浮力点始终逐块保持。

传感器代理不能参与改变刚体质量属性。创建和每次破碎后，都必须根据逻辑方块质量重新设置
既定质量、质心和惯性，避免巨大 sensor 盒的几何 AABB 让 Cannon 自动惯性发生非预期变化。
这一项需要增加旋转、牵引和倒伏速度回归。

空间划分必须确定性生成，并优先保持相邻树冠区域在同一组。实现使用数值索引和复用数组，
不重新引入先前已经证明有反作用的逐体素字符串坐标并集或碰撞盒字符串签名。质量档和必要
的确定性参数随树保存，重载后重建相同分组。

### B4. 触发和批量删除

同一物理 tick 中的碰撞事件、补充探针、衰减和断连结果先合并为组 ID 集合，再执行一次
`removeBlocksAtLocalLocations()`：

1. 一个叶片触发即标记其整个组；
2. 计算失去原木/剩余叶组支持的叶组和植物附着物；
3. 合并所有待删逻辑方块；
4. 一次更新视觉槽位、collider、质量、质心和浮力点；
5. 掉落和音效进入后续非实时队列。

精确档的每个组可以是一片叶子，因此保持当前语义。聚合档只改变叶片批量粒度，不改变
原木、附件、世界方块或实体伤害。

## 工作包 C：无损生命周期优化

这些优化不需要降低物理质量，应在叶片降级之前完成并通过基准决定是否保留：

1. 在注册时按 leaf distance 建立桶；逐层衰减只访问当前距离桶，不再每 2 tick 过滤全部
   剩余叶片。
2. 在装配时建立叶组和附着物支持邻接；已有破碎批次只遍历受影响组，不常驻全树扫描。
3. 同 tick 所有破碎来源只重建一次 compound collider、质量、质心和浮力点。
4. 继续复用探针、候选和删除数组，避免活动树每 tick 创建大 Map/Set 或字符串签名。
5. 继续合并同维度实体伤害查询、错峰持久化，并只写 dirty 树。
6. fragment 全空才删除实体；非空 fragment 只更新对应结构字。实体姿态同步次数继续等于
   fragment 实体数，而不是逻辑方块数。
7. 世界碰撞扫描仍逐步查询真实方块；只保留同一步内去重、数值范围并集和布局未变时的
   Cannon collider 复用。

## 工作包 D：`system.runJob` 非实时队列

`system.runJob()` 只用于不要求在当前物理 tick 完成的高并发工作：

- 叶片或整树最终掉落物的分批生成；
- 蜜蜂等结算副作用的错峰执行；
- 大批量持久化序列化/写入前的数据准备；
- 已经完成物理移除后的声音、粒子等非关键表现。

不得把 Cannon step、世界 collider 扫描、碰撞回调、玩家牵引、伤害判断或跨域安全判定放进
job。微软 [MS-RUNJOB] 和 [MS-RUN-GUIDE] 明确说明 job generator 会在每 tick 的时间预算内
运行并在后续 tick 继续，适合长任务，但不适合实时游戏循环。

掉落 job 必须满足恰好一次语义：先生成不可变任务快照并记录 pending 状态，再从物理世界
移除装配体；每个 job item 生成成功后推进游标。重载恢复 pending 队列，不能因为世界关闭
造成整树无掉落，也不能重复结算蜂巢蜜蜂。若持久化 pending 队列的成本高于实测收益，
则保留同步结算，不能用可能丢物品的简化实现换性能。

从结算触发到最后一个掉落物或蜜蜂生成的延迟不得超过 20 tick。若 job 在第 20 tick 前无法
完成，必须在边界 tick 完成剩余任务或回退同步结算。可靠性必须不低于当前同步路径；任何
无法证明在脚本重载、区块重载和正常停服恢复中不丢失、不重复的 job 实现都不得发布。

## 实施顺序

### 阶段 0：冻结基线

- 保存当前 `npm test`、debug/release 构建和 `npm run bench:physics` 结果；
- 复用 `cannon-es-physics-2` 的 50 ms tick 预算、配对 benchmark 结构和统计口径；
- 记录 1/5/10 棵标准树和最不利原版大树的实体数、shape 数、P50/P95/P99；
- 使用 `/script profiler start` / `stop` 记录真实基岩 API 和脚本热点；
- 使用现有 `/scriptevent physics_api:lifecycle_perf on` 记录生命周期耗时；
- 增加但默认关闭的物理/fragment 统计，输出 step/lifecycle duration、query、shape、
  rebuild 和实体数的 P50/P95/P99；不计算或输出游戏 TPS，避免诊断本身影响正式性能。

### 阶段 1：颜色路径清零

- 删除 BlockMap 和全部颜色字段；
- 生成固定 `#80A755` 的 leaf/vine overlay；
- 验证资源中颜色只剩材质与两个 controller 使用点；
- 更新旧存档兼容与自动测试。

### 阶段 2：fragment 再装箱

- 先落地同 family 1-bit 叶片布局和单 controller；
- 用 feature 边界搜索决定 196 槽还是更大的已实机通过布局；
- 删除附件 tint 分组并尝试 27 槽；
- 输出每棵树按 log/leaf/attachment 分类的实体数和槽位利用率；
- 保证任意未注册状态仍在生成实体前整树回退旧渲染器。

### 阶段 3：无损物理优化

- 先修复当前 `fallen-tree-lifecycle.bench.ts` 产生无效 `NaN` 样本的问题；
- 叶距桶、破碎批处理、邻接缓存和缓冲区复用；
- 每项单独跑基准，没有稳定收益或出现语义复杂度的候选不保留；
- 不改变叶片 shape 或破碎粒度，建立新的精确档基线。

### 阶段 4：固定质量档和叶片聚合

- 实现基于树规模和当前已分配物理预算的装配时质量选择；
- 实现精确档、若干聚合档和极限一组档；
- 持久化质量档并验证重载确定性；
- 以代码基准和项目方实机 TPS 反馈逐档校准“树规模/累计预算 -> 目标组数”；
- 验证原木和附件的 shape、质量及行为在所有档位完全一致。

### 阶段 5：可选 job 错峰

- 只在 profiler 证明掉落/结算突发仍是主要峰值时启用；
- 先实现可恢复 pending 队列，再接入 `runJob()`；
- 所有结算任务必须在 20 tick 内完成；
- 验证重载、区块卸载和蜂巢副作用的恰好一次语义。

### 阶段 6：最终收敛审计

- 对照阶段 0 的相同设备、世界快照和配置；
- 删除无收益的复杂优化和全部过期诊断；
- 只有自动门槛全部通过后才提交唯一一次最终人工验收。

## 自动验证和实机验收

### 颜色与资源

- 源码和生成资源中不得出现 `minecraft:map_color`、`tintedColor`、`physics_api:c0..c7`、
  `physics_api:tint` 或 fragment palette；
- `alpha_block_color_tint` 只能用于树叶和藤蔓；
- 叶片与藤蔓 controller 的 overlay 目标色必须等价于 `#80A755` 且 `a = -1`；
- 其他 attachment controller 不得含 foliage overlay；
- 资源 schema、debug/release 构建均通过。

### 物理不变量

- 相同树木在所有质量档的原木/附件 collider、总原木质量、玩家冲量、牵引、伤害和掉落一致；
- 精确档的叶片 collider、接触和破碎结果与当前版本一致；
- 聚合档只允许叶片按组提前破碎，不允许树冠阻挡、卡顿或回弹；
- 叶组破碎后不能留下不可见 sensor，断连植物附件不能悬空；
- 浮力、休眠累计、重载、跨域和蜂巢蜜蜂不重复、不丢失。

### 性能与实体数

测试矩阵至少包含：

- 123 方块标准树；
- 华丽橡树、巨型云杉、巨型丛林树、红树及带藤蔓/可可豆/蜂巢的组合；
- 1/5/10 棵同时活动、同时碰撞、同时破碎和同时结算；
- 水中、世界复杂方块碰撞、休眠、重载和加载边界场景；
- fragment 与旧逐方块回退的相同逻辑方块对照。

记录指标包括实体总数及分类、transform 写入、Cannon shape/contact、world `getBlock()`、
collider 重建、step/lifecycle 耗时和 P50/P95/P99。实体数量没有硬预算，但正常
原版树必须显著低于当前 fragment 基线，大型树也按可证明的最少布局生成。

最终性能结论满足以下条件才可称为“本轮大块优化已经到头”：

1. 实际基岩场景尽量长期保持约 `15-20 TPS`；
2. 精确档相对当前版本没有可重复退化；
3. 低负载时物理视觉几乎不变，高负载时可见代价主要且仅是树叶批量破碎粒度；
4. profiler 中不再存在一个可在不改变上述语义的情况下显著削减的单一热点；
5. 剩余主要成本属于 Cannon 必要求解、真实世界方块查询或基岩宿主调用。

不能在实现前保证第五项成立；它是最终测量结论，不是设计假设。

## 技术风险与阻塞

### `MAT-1`：负 alpha 材质语义

微软文档证明 `overlay_color` 和材质继承存在，但没有定义 `a = -1` 的反色乘算。当前依据是
项目方已经完成的目标版本实机验证，因此不阻塞实施，但必须列入资源包版本回归。若目标
版本表现改变，需要新的材质样例；不能在脚本层恢复颜色系统规避。

### `GEO-1`：单 geometry 安全槽位上限

微软没有公布单实体最大 bone/cube/controller 数及跨平台性能上限。VanillaTrain 证明一个
fragment 体系可管理 256 个固定客户端槽，当前项目证明单 geometry 的 196 槽可运行，但
这不能严格推出 245 bone geometry 必然安全。

处理：先生成 245 左右槽位原型，做 schema、载入、全槽显示、旋转、破碎和移动实测；失败
即回退 196 槽。该风险影响实体压缩幅度，不影响功能交付，暂不需要外部资料。

### `TPS-1 已解除`：不实现游戏内 TPS 读取

代码级验证复用 `cannon-es-physics-2` 的配对 benchmark 和 50 ms tick 预算；游戏内 TPS 由
项目方肉眼测试反馈。正式代码不新增 TPS 采样、输出或基于 TPS 的运行时分支。

### `JOB-1`：跨 tick 掉落的恰好一次语义

`runJob()` 的时间片行为有官方依据，但世界关闭可能中断 generator。只有可恢复 pending
队列能保持当前掉落可靠性。项目方已确认最大延迟为 20 tick，可靠性语义保持严格不变。
若无法同时满足 20 tick 和当前可靠性，job 优化不进入发布版并保留同步结算。

## 可靠技术来源

### 微软 Creator 文档

- **[MS-EP]** [Introduction to Entity Properties](https://learn.microsoft.com/en-us/minecraft/creator/documents/introductiontoentityproperties?view=minecraft-bedrock-stable)：属性持久化、`client_sync`、32 属性限制和 Molang 数值精度。
- **[MS-ENTITY]** [Entity Class / setProperty](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/entity?view=minecraft-bedrock-stable#setproperty)：脚本写实体属性。
- **[MS-QP]** [Molang query.property](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/molangreference/examples/molangconcepts/queryfunctions/query_property?view=minecraft-bedrock-stable)：客户端读取同步属性。
- **[MS-RC]** [Render Controllers](https://learn.microsoft.com/en-us/minecraft/creator/documents/animations/animationrendercontroller?view=minecraft-bedrock-stable)：geometry/material/texture 数组、`part_visibility`、`color` 与 `overlay_color`。
- **[MS-GEO]** [Geometry v1.14.0](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/visualreference/geometry.v1.14.0?view=minecraft-bedrock-stable)：bone、cube、parent、pivot、rotation 和逐面 UV。
- **[MS-CLIENT]** [Client Entity JSON](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/entityreference/examples/cliententitydocumentation/cliententitydocumentationintroduction?view=minecraft-bedrock-stable)：客户端实体 material/texture/geometry/animation/controller 接线与 Molang 求值。
- **[MS-ADD-ENTITY]** [Creating New Entity Types](https://learn.microsoft.com/en-us/minecraft/creator/documents/introductiontoaddentity?view=minecraft-bedrock-stable)：客户端实体和原版资源引用。
- **[MS-MATERIALS]** [Introduction to Materials](https://learn.microsoft.com/en-us/minecraft/creator/documents/material-files?view=minecraft-bedrock-stable)：材质继承、defines/states 及兼容性警告。
- **[MS-SYSTEM]** [System Class](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/system?view=minecraft-bedrock-stable)：`currentTick`、`runInterval` 和 `runJob`。
- **[MS-RUNJOB]** [System.runJob](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/system?view=minecraft-bedrock-stable#runjob)：generator job API。
- **[MS-RUN-GUIDE]** [System Run Guide](https://learn.microsoft.com/en-us/minecraft/creator/documents/scripting/system-run-guide?view=minecraft-bedrock-stable)：每 tick 时间片、暂停/继续和适用边界。
- **[MS-PROFILER]** [Scripting Developer Tools](https://learn.microsoft.com/en-us/minecraft/creator/documents/scripting/developer-tools?view=minecraft-bedrock-stable)：`/script profiler start|stop` 与 CPU profile。
- **[MS-PERF]** [Improving Performance and Resource Usage](https://learn.microsoft.com/en-us/minecraft/creator/documents/practices/improvingperformanceandresourceusage?view=minecraft-bedrock-stable)：减少实体、避免大量逐 tick 工作、错峰和按保真度控制成本。

### 本地样例与当前项目

- **[SC-BP]** [`sample/平滑工艺附加包/BP/entities/log_anim.json`](../../sample/平滑工艺附加包/BP/entities/log_anim.json)：`client_sync` 实体属性。
- **[SC-SCRIPT]** [`sample/平滑工艺附加包/BP/scripts/main.js`](../../sample/平滑工艺附加包/BP/scripts/main.js)：`Entity.setProperty()`。
- **[SC-ANIM]** [`sample/平滑工艺附加包/RP/animations/treelog.animation.json`](../../sample/平滑工艺附加包/RP/animations/treelog.animation.json)：`query.property()` 驱动局部骨骼位置。
- **[VT-CLIENT]** [`sample/VanillaTrain/src/TrainRP/entity/simple_fragment.entity.json`](../../sample/VanillaTrain/src/TrainRP/entity/simple_fragment.entity.json)：大规模固定 fragment client entity 接线。
- **[VT-GEO]** [`sample/VanillaTrain/src/TrainRP/models/entity/simple_fragment.geo.json`](../../sample/VanillaTrain/src/TrainRP/models/entity/simple_fragment.geo.json)：256 槽的生成资源集合。
- **[CURRENT-LOG]** [`packs/TreePhysics/RP/models/entity/tree_log_fragment.geo.json`](../../packs/TreePhysics/RP/models/entity/tree_log_fragment.geo.json)：当前项目 196 固定原木槽 geometry。
- **[CURRENT-RC]** [`packs/TreePhysics/RP/render_controllers/tree_log_fragment.render_controllers.json`](../../packs/TreePhysics/RP/render_controllers/tree_log_fragment.render_controllers.json)：属性位图、`part_visibility` 和共享 controller。
- **[CURRENT-MATERIAL]** [`packs/TreePhysics/RP/materials/entity.material`](../../packs/TreePhysics/RP/materials/entity.material)：已接入的 `alpha_block_color_tint`。
- **[CURRENT-PHYSICS]** [`src/physics.ts`](../../src/physics.ts) 与 [`src/physics/assembly-mesher.ts`](../../src/physics/assembly-mesher.ts)：compound、无响应 child collider、精确 greedy 体素合并和批量 collider 重建。
- **[CURRENT-LIFECYCLE]** [`src/gameplay/fallen-tree-lifecycle.ts`](../../src/gameplay/fallen-tree-lifecycle.ts)：补充探针、断连清理、掉落、持久化和生命周期性能统计。
- **[CANNON2-BENCH]** [`archive/cannon-es-physics-2/tests/primitive-collider.bench.ts`](../../archive/cannon-es-physics-2/tests/primitive-collider.bench.ts)：1/10/32 active body 的 Vitest 压力基准结构。
- **[CANNON2-BUDGET]** [`archive/cannon-es-physics-2/docs/feature-development/feature-development-13.md`](../../archive/cannon-es-physics-2/docs/feature-development/feature-development-13.md)：用 P99 占 50 ms tick 预算比例判断 20 TPS 余量的已验收案例。
- **[CANNON2-WINDOW]** [`archive/cannon-es-physics-2/scripts/cannon-es-comparison-main.ts`](../../archive/cannon-es-physics-2/scripts/cannon-es-comparison-main.ts)：窗口化 interval/step average/max 统计的历史实现；本计划只参考统计方法，不接入正式游戏运行时。

VanillaTrain 的脚本侧结构传值使用 `playAnimation`，因此它只证明固定客户端槽位规模，不用来
证明本项目的实体属性通道；实体属性通道由 [MS-EP]、[MS-ENTITY]、[MS-QP]、平滑工艺样例
和当前项目共同证明。
