# PhysicsAPI TPS 性能独立审计与旧版性能恢复计划

审计日期：2026-07-29

## 1. 范围、方法与结论边界

本审计只讨论服务端 TPS，不讨论 FPS。对比对象为当前 `src` 和旧实现
`sample/old-physics/test_packs`。审计重新从源码、行为包实体定义、测试和可运行基准建立证据，
没有使用项目历史文档、README、变更记录或历史性能结论。

本地环境不能启动真实 Bedrock Dedicated Server，因此本报告包含三种不同强度的结论：

- **已证实事实**：可以直接由源码、静态计数或本地 Cannon/mock 基准证明。
- **高置信归因**：调用频次和算法结构已证实，但单次 Bedrock SAPI 调用的真实耗时需要服内 A/B 才能量化。
- **待验证风险**：源码只能证明它存在，不能证明它在目标 Bedrock 版本中的成本排名。

任何把 mock benchmark 的毫秒数直接当作 Bedrock tick 耗时的做法都是错误的。mock 中的
`getBlock`、`getEntities`、`teleport` 和 `setProperty` 只是普通 JavaScript 函数，不包含原生服务端、
区块访问、实体 tick、属性同步和网络序列化成本。

## 2. 最终判定

### 2.1 直接回答四个问题

| 问题 | 判定 |
| --- | --- |
| 物理解算性能是否变差 | **是。** 当前每游戏 tick 固定执行 3 次 `1/60 s` 求解，旧版执行 1 次 `1/20 s`。相同 40 Box 隔离对照中，当前步进方式平均慢 **3.24 倍**。 |
| 多刚体装配体是否天生更差 | **不是本问题的准确描述。** 当前每棵树是 **1 个 Cannon body + compound shapes**，不是多刚体链。compound shape、较大 AABB 和更多接触会增加成本，但生产叶片代理已经把 408 方块树压到 13 shapes；它们不是十几棵树即严重掉 TPS 的充分解释。 |
| 额外玩法是否牺牲性能 | **是，而且是持续 TPS 退化的主要组成。** 世界脆弱块探针、装配体叶片探针、流体采样、伤害实体查询、加载边界检测、活动树状态持久化和多 fragment 实体同步都不存在于旧版单方块热路径。 |
| 是否砍掉旧版优化 | **是。** 最关键的是稳定世界区域的 `8x8x8` mesh/snapshot 缓存及重建预算；其次是低运动 transform 写回节流、较宽写入阈值、每 40 tick 重选 SAP 轴和更积极的近静止睡眠辅助。 |

### 2.2 一句话根因

新版本不是被某一个“更慢的 Cannon 算法”拖垮，而是把旧版的“缓存世界 + 每 tick 一次物理 +
一个刚体一个视觉实体”变成了“活动体周围每 tick 重查世界 + 三次物理 + 每棵树数十至数百个
玩法探针 + 多个原生 fragment 实体同步”。这些成本同时按活动树数量和树的空间尺寸放大。

### 2.3 根因排序

| 等级 | 成本 | 对持续 TPS 的判断 | 证据强度 |
| --- | --- | --- | --- |
| S | 活动刚体周围每 tick 世界碰撞扫描、重新 mesh 和流体收集 | 最可能的第一主因之一；大 AABB、相邻树 cluster 和无跨 tick collider snapshot 会放大 | 结构已证实，真实 SAPI 权重需 A/B |
| S | 每棵树独立的叶片/附件/世界脆弱块探针，以及扫描外浮力点 `getBlock` | 最可能的第一主因之一；是按树持续发生的 SAPI 点查询 | 调用上限已证实，真实 SAPI 权重需 A/B |
| A | `3 x 1/60` 物理子步 | 物理核约 3 倍退化，接触密集时更明显 | 已隔离实测 |
| A | fragment 实体每 tick transform/属性写回 | 15 棵 408 方块基准树约有 165 个 fragment，最多形成约 660 次实体 SAPI 写调用/tick | 数量与调用路径已证实，单次成本需 A/B |
| B | 加载边界检测、伤害 AABB 查询、动态属性持久化 | 持续放大项；持久化还产生周期尖峰 | 调用路径已证实 |
| B | 旧版近静止写回/睡眠辅助和 SAP 轴刷新缺失 | 延长昂贵的活动阶段，密集排列时可能扩大 broadphase 候选 | 源码差异已证实，权重需 A/B |
| C | 碰撞粒子、声音 | 接触风暴时可形成尖峰；正常持续运动不是首要根因 | 上限与冷却已证实 |
| C | loot table、掉落物、蜜蜂和结算粒子 | 破碎/结算瞬时尖峰和后续掉落实体 tick 风险，不能解释未破碎树的持续低 TPS | 调用路径已证实 |
| 待验证 | fragment 使用 `minecraft:arrow` runtime identifier | 可能带来额外原生实体行为或同步成本，但不能仅靠 JSON 判定 | 必须 Bedrock A/B |

## 3. “相同物理体数量”为什么不是相同工作量

旧版 40 个物理方块通常意味着：

- 40 个 Cannon body；
- 每 body 1 个 Box shape；
- 每 body 1 个视觉实体；
- 每 tick 1 次物理求解；
- 世界碰撞来自可复用的静态 chunk mesh；
- 没有树叶破碎、压碎世界方块、树伤害、逐树流体采样、加载边界检测和逐树状态持久化。

当前 1 棵树意味着：

- 仍然只有 1 个 Cannon body；
- 若干 compound shapes，以及一个用于睡眠环境检查的完整 logical collider；
- 数十到上千逻辑方块；
- 多个浮力点、叶片接触探针和世界脆弱块探针；
- 多个 fragment 视觉实体；
- 每 tick 3 次求解；
- 每 tick 世界碰撞扫描、流体采样、加载边界检查、伤害检查、破碎/衰减/结算状态机；
- 每 20 tick 一次运动状态持久化切片。

因此合理的比较单位至少包含：`body count`、`shape count`、活动 AABB/扫描体积、SAPI 查询数、
视觉实体数和每 tick 实体写入数。只按 body 数比较，会把一棵数百方块树误当成一个旧方块。

## 4. 物理解算审计

### 4.1 已证实的 3 倍步数差异

当前内核默认 `fixedTimeStep = 1/60`、`tickSteps = 3`，每个子步重复执行回调、重力缩放、
浮力和 `world.step`：

- `src/physics/cannon-kernel.ts:41-45`
- `src/physics/cannon-kernel.ts:1201-1211`
- `src/physics.ts:702-721`

旧版固定为 `1/20`，每游戏 tick 只推进一次：

- `sample/old-physics/test_packs/BP/scripts/main.js:8972`

在相同 SAP broadphase、8 solver iterations、40 个接触中的 Box body、关闭 sleep 的隔离测试中，
5 次重复结果如下：

| 方式 | 平均耗时 |
| --- | ---: |
| `1 x 1/20` | `0.8301 ms/tick` |
| `3 x 1/60` | `2.6918 ms/tick` |
| 倍率 | `3.243x` |

单次倍率分布为 `3.085x` 到 `3.367x`。三子步主要换取旋转刚体稳定性、减少穿透和更细的接触响应；
若严格恢复旧版物理预算，就必须接受这些质量回退，或者只在高速/高风险时临时增加子步。

### 4.2 solver/broadphase 不是主要配置退化

新旧两版都使用 SAP broadphase、AABB 模式和 8 次 GSSolver iteration。当前 tolerance 为 `0.0001`，
旧版为 `1e-6`；当前 tolerance 反而更宽松。因此不能把退化归咎于 solver iteration 增加。

旧版每 40 tick 执行一次 `autoDetectAxis()`，当前只在 world 创建时执行一次。大量树从竖直变为水平、
分布轴发生变化后，当前 SAP 轴可能不再合适。这是次级风险，不足以解释全部退化，但应恢复。

### 4.3 compound 装配体的真实成本

`PhysicsDimension.createAssembly()` 为整棵树创建一个 body，并将方块 mesh 为 compound collider：

- `src/physics.ts:471-496`
- `src/physics.ts:835-850`

生产树叶 runtime representation 会把树叶从 Cannon collider 移除，只保留非叶方块 collider，并把
叶片浮力聚合：

- `src/tree/leaf-physics-runtime.ts:12-53`

有效 benchmark 结果：

| 场景 | 平均脚本耗时 |
| --- | ---: |
| 10 个活动普通刚体，13 shapes | `0.7458 ms/tick` |
| 32 个同点活动刚体，44 shapes | `2.6071 ms/tick` |
| 408 方块树，生产 high 方案，13 shapes | `0.0831 ms/tick` |
| 408 方块树，exact 叶传感器候选，76 shapes | `0.5219 ms/tick` |
| 408 方块树，13 shapes + 聚合叶浮力 | `0.0730 ms/tick` |

聚合叶浮力场景比 76-shape exact 叶传感器约快 `7.15x`。这证明生产 collider 压缩是有效优化，
也证明复杂 compound 确实有成本，但生产 Cannon 解算本身并未达到“十几棵即必然超 50 ms”的程度。

## 5. 世界碰撞与 Bedrock SAPI 审计

### 5.1 旧版：跨 tick 的 `8x8x8` 世界 mesh 缓存

旧版把世界划为 `8x8x8` 区块，保留 snapshot、mesh 结果和静态 Cannon body。只有首次进入或被标脏
时才重建；每 tick 高优先级最多 4 块、普通优先级最多 2 块：

- `sample/old-physics/test_packs/BP/scripts/main.js:8973-8983`
- `sample/old-physics/test_packs/BP/scripts/main.js:9734-9808`
- `sample/old-physics/test_packs/BP/scripts/main.js:9952-10005`
- `sample/old-physics/test_packs/BP/scripts/main.js:10954-11021`

一个 mesh chunk 是 512 方块；即便队列满载，重建工作也被限制在每 tick 6 个 chunk。更关键的是，
稳定世界、稳定运动区域不会每 tick 重新读取和 mesh。

### 5.2 当前：活动体存在时每 tick 重扫

当前 `step()` 在需要同步世界 collider 时调用 `syncWorldBlockColliders()`。每个 awake dynamic body 都会：

1. 根据速度、旋转和 collider shape 生成预测扫描范围；
2. 合并重叠或仅相邻的 cluster；
3. 调用 `dimension.getBlocks(BlockVolume)`；
4. 对返回的每个非空气位置再次 `getBlock`，解析碰撞形状和材质；
5. 每 tick 重新 greedy mesh、排序并与上一帧 collider layout 比较；
6. 收集流体表面，并对扫描覆盖外的浮力点补做 `getBlock`。

关键位置：

- `src/physics/cannon-kernel.ts:1201-1241`
- `src/physics/cannon-kernel.ts:1628-1806`
- `src/physics/cannon-kernel.ts:2669-2733`
- `src/physics/cannon-kernel.ts:2926-3052`
- `src/physics/cannon-kernel.ts:3087-3106`

layout 相同只避免重建 Cannon 静态 body，并不会避免当 tick 的 SAPI 查询、形状解析、流体收集、
greedy mesh 和排序。

### 5.3 cluster 合并的放大效应

扫描范围只要 overlap 或在三轴上相邻 1 格就会合并。稀疏 coverage 会在 JavaScript 侧过滤结果，
但 `getBlocks` 接收的仍是合并 cluster 的完整外接长方体：

- 合并：`src/physics/cannon-kernel.ts:2770-2809`
- sparse coverage：`src/physics/cannon-kernel.ts:3126-3164`
- 完整 BlockVolume 查询后再过滤：`src/physics/cannon-kernel.ts:3087-3102`

因此相邻、交叉或横倒的多棵树可能把多个局部扫描合成一个很大的原生 BlockVolume 查询。即使最终
只保留稀疏位置，Bedrock 仍需处理外部体积查询。此项真实复杂度依赖 `Dimension.getBlocks` 的原生实现，
必须在目标版本 A/B；源码可以确定的是当前没有跨 tick snapshot，也没有每 tick 扫描体积硬预算。

### 5.4 睡眠不是完全无效，但昂贵阶段可能过长

当前所有 body 睡眠时会跳过 Cannon 子步；睡眠环境签名每 20 tick 检查，支撑每 10 tick 检查。
这是一项现存优化。问题是树在长时间翻滚、互相支撑或极小抖动时，昂贵的 awake 路径会持续。

旧版除 Cannon sleep 外，还有近静止 8 tick、支撑链和低运动写回辅助。当前未保留同等级的强制
收敛策略。恢复旧版 TPS 时，应优先缩短“几乎静止但仍 awake”的尾部。

## 6. 树生命周期与点查询预算

### 6.1 每棵活动树的固定工作

`FallenTreeLifecycle.tick()` 每 tick 遍历所有树并依次执行加载边界保护、熔岩、装配体脆弱块探针、
世界可压碎块探针、衰减、log/leaf 破碎、伤害、结算和持久化：

- `src/gameplay/fallen-tree-lifecycle.ts:762-835`

探针预算为：

- attachment/其他装配体脆弱块：最多 64/树/tick；
- 叶片接触：exact/high/medium/low 分别最多 64/32/12/4；
- 世界非叶脆弱块：最多 64/树/tick；
- 世界叶片：与叶片接触探针相同；
- 世界探针检查当前位置和一个 tick 后的预测位置，最多 2 次 `getBlock`。

代码位置：

- 常量：`src/gameplay/fallen-tree-lifecycle.ts:78-80`
- 装配体探针：`src/gameplay/fallen-tree-lifecycle.ts:2293-2340`
- 世界探针：`src/gameplay/fallen-tree-lifecycle.ts:2343-2397`
- profile：`src/tree/leaf-physics-quality.ts:72-125`

叶片 `fragileImpactSpeed` 为 0，因此装配体叶探针不会因低速门槛而跳过 `getBlock`。

理论最坏值为：`64 + 32 + 2 x (64 + 32) = 288 getBlock/树/tick`（high profile，且附件/
非叶探针池均足够大）。这是每树预算，不是全局预算。

更贴近现有 benchmark 树的估算：

- 408 方块树含 24 logs、384 leaves；单棵 high profile 最多约
  `32 + 2 x (24 + 32) = 144` 次生命周期 `getBlock/tick`。
- 新建 15 棵同类树会因 active profile 预算降级，典型分布约为 2 high、8 medium、5 low；
  仅生命周期探针仍最多约 **1260 次点查询/tick**。
- 若树带有足够多的脆弱 attachments，15 棵上限可进一步接近 3420；恢复的 high profile 或其他
  组合还可能更高。

这些数值尚未包含内核的 world collider BlockVolume 查询、流体补查和加载边界检测。

### 6.2 流体采样即使在干燥世界也有查询成本

每个 awake body 的每个浮力点会检查当前方块及下方半格对应方块。若不在 collider scan coverage 内，
即使世界没有水，也必须先 `getBlock` 才能得出“不是液体”：

- `src/physics/cannon-kernel.ts:1744-1803`

默认非叶方块是一方块一个浮力点；叶片由 profile 聚合。408 方块 high 树有约 24 个原木点 +
32 个叶片点，理论最多补 112 次点查询。原木通常已被 collider scan 覆盖，树冠叶片点通常没有；
因此干燥世界仍可能为叶片产生最多约 64 次额外查询。

小树不一定更便宜。exact profile 的 `buoyancyPointBudget` 无上限、contact probe 为 64；一棵
9 logs + 114 leaves 的 123 方块树可能保留 123 个浮力点。第一批 exact 小树因此会产生很高的
流体补查和叶片探针密度。

### 6.3 生命周期 mock 基准说明了什么

| mock 场景 | 平均耗时 |
| --- | ---: |
| 10 棵 408 方块活动树 | `0.2106 ms/tick` |
| 10 棵 980 方块活动树 | `0.5079 ms/tick` |
| 10 棵 980 方块树的持久化体积 | 约 `3.23 MB` |

该结果说明纯 JavaScript 数组/Map 循环不是主要瓶颈；它不能说明真实 `getBlock` 很便宜。结合实际
服内现象，更符合证据的解释是 SAPI/原生实体边界成本，而不是生命周期算法的本地算术成本。

## 7. 视觉实体与同步成本

### 7.1 fragment 是相对优化，但仍比旧 body 数多

当前没有按方块创建实体，而是使用下列容量的 fragment：

- log：`7x4x7 = 196` slots；
- tall log：`5x10x4 = 200` slots；
- leaf：`7x5x7 = 245` slots；
- compact leaf：`6x5x6 = 180` slots；
- attachment：每实体 26 个 attachment。

代码：`src/tree/fragment-layout.ts:8-52`。

按同一打包算法对现有 benchmark 几何静态计数：

| 树 | 方块 | fragment 实体 |
| --- | ---: | ---: |
| fancy 树 | 408 | 11 |
| giant 树 | 980 | 15 |

因此 15 棵 fancy 树约为 165 个视觉实体，而旧版 40 个方块刚体为 40 个视觉实体。新版本虽然 body
更少，原生实体数和同步目标数反而可能更多。fragment 相比“一方块一实体”已经是巨大优化，不能把它
描述成退化来源；退化来自“复杂树仍需多个 fragment”与旧单方块 workload 的差异。

### 7.2 活动时的每 tick 写回

所有 assembly 每 tick 调用 `syncVisuals()`。每个有效 fragment 在超过阈值时最多执行：

- 1 次 `teleport`；
- pitch、yaw、roll 各 1 次 `setProperty`。

当前阈值为位置 `1/1024`、旋转 `0.05` 度；仅在连续两次都 sleeping 时完整跳过：

- `src/physics/assembly-visual-renderer.ts:26-27`
- `src/physics/assembly-visual-renderer.ts:382-428`
- `src/physics.ts:635-638`

15 棵 408 方块树在持续运动且四项都变化时，约为每 tick 165 次 teleport + 495 次属性写，合计
**660 次实体 SAPI 写调用**。这不含实体自身原生 tick 和网络 client sync。

旧版位置阈值为 `0.0025`、旋转阈值 `0.35` 度；低运动 body 每 3 tick 才写一次，并允许位置
`0.02`、旋转 `1.5` 度的 deferred 误差：

- `sample/old-physics/test_packs/BP/scripts/main.js:8990-8996`
- `sample/old-physics/test_packs/BP/scripts/main.js:10291-10339`
- `sample/old-physics/test_packs/BP/scripts/main.js:11079-11089`

当前位置阈值约严格 2.56 倍、旋转阈值严格 7 倍，而且丢失了低运动三 tick 节流。

### 7.3 entity JSON 风险

五种 fragment 实体均使用 `runtime_identifier: "minecraft:arrow"`，并带 15 至 32 个 client-sync
属性；稳定运动时主要变化的是三个旋转属性，其他属性主要在创建和局部破碎时写入。实体碰撞盒为 0、
无重力、不可推动，并启用了 persistent 和 bandwidth optimization。

箭头 runtime 是否比旧版普通自定义实体产生更多服务端原生 tick，不能从 JSON 单独证明。必须做：

1. 同模型、同属性、同实体数；
2. 唯一变量为有/无 arrow runtime；
3. 禁用脚本 transform 写，测 idle TPS；
4. 再启用固定频率 transform 写，测 active TPS。

在该 A/B 完成前，不应把箭头 runtime 写成已确认主因。

## 8. 伤害、加载边界与持久化

### 8.1 伤害查询

能够达到伤害速度的活动树会按重叠 AABB 合并 cluster，每个 cluster 调用一次
`dimension.getEntities(volume)`，再对候选实体逐树做局部 log 接触、伤害和击退计算：

- `src/gameplay/fallen-tree-lifecycle.ts:838-943`

合并减少了 SAPI 查询次数，但密集树会共享更大的候选集合，随后形成 `tree x candidates` 的脚本过滤。
这是额外玩法成本，不是 Cannon 必需成本。

### 8.2 加载边界结算保护

当前主程序明确启用 `crossDomain: true`。每 tick 调用 `world.getAllPlayers()`，每棵树检查当前、预测、
向外 guard 和必要时 last-safe bounds 涉及的 chunk 是否可读。每个未缓存 chunk 通过中心点
`dimension.getBlock` 探测：

- `src/main.ts:71-75`
- `src/gameplay/fallen-tree-lifecycle.ts:762-780`
- `src/gameplay/fallen-tree-lifecycle.ts:1102-1156`
- `src/gameplay/fallen-tree-lifecycle.ts:3112-3145`

同 tick 有 cache，可复用相同 chunk 结果，但大树跨越多个 chunk、树分散或 y 不同时仍会增加点查询。
这里的 `crossDomain` 只是内部命名，不表示树会跨过加载区后恢复物理运动。边界威胁连续成立后，树会
在当前或最后可读姿态直接碎掉/结算；仅当最后安全区域也不可读时，才保存一个 `pendingSettlement`
事务，等区块可读后完成碎裂、粒子和掉落。该功能换取的是卸载边界安全和结算完整性。

### 8.3 持久化

每棵活动树按 `(assembly.id + currentTick) % 20` 分散刷新状态。结构不变时只更新 state；发生结构
变化会重新序列化大结构。JSON store 使用 generation + chunks + manifest 的原子写法，每次变化会写
所有新 state chunks 和 manifest，再删除上一代 chunks：

- `src/gameplay/fallen-tree-lifecycle.ts:1641-1717`
- `src/persistence/dynamic-property-json-store.ts:54-74`

40 棵树平均约 2 棵/tick 进入状态刷新。分散策略避免了全部同 tick 写，但运动中的位置、旋转、速度
不断变化，state 通常不会命中 unchanged。该功能换取活动树在服务器崩溃/脚本重载后的恢复，以及
破碎事务正确性；它不是“跨区持久化”。如果产品明确不要求重启后恢复仍在运动的树，可以移除周期
运动 state 保存，只保留创建提交和待结算事务所需的最小持久化。

## 9. 粒子、声音、掉落与事件尖峰

### 9.1 声音

普通撞击声满足 `impactSpeed >= 1.5` 才播放，并按 body 有 8 tick 冷却。因此稳定运动阶段最多约
每 body 每 8 tick 一次，不是持续 TPS 首要根因：`src/main.ts:140-154`。

水/熔岩声音只在 entry 事件或终止事件播放；破碎批次通常只播放一个主导方块声音。

### 9.2 粒子

碰撞粒子按 body、树内 block、世界 block 和 `1/16` 坐标在当前 tick 去重，但没有全局每 tick 上限。
一次干燥撞击可调用 dust + typed particle 两次 `spawnParticle`：

- `src/gameplay/fallen-tree-lifecycle.ts:2101-2137`
- `src/gameplay/fallen-tree-lifecycle.ts:4189-4229`

接触 manifold 风暴仍可能形成尖峰。水/熔岩 entry 粒子是事件型；熔岩虽然配置最多 400 个 sparks，
源码只调用一次粒子 emitter，并通过 Molang 传 count，不是 400 次 SAPI 调用。

破碎/结算路径的常见粒子采样上限为 32；这是已存在的有效保护。

### 9.3 loot 与掉落物

树结算和大规模 log break 仍会对每个被处理方块调用 loot table。掉落总量大于 16 时会尝试合并同类
stack，但最终仍按合并后的 stack 逐个 `spawnItem`。最终集中结算对大树可以在一个 tick 内遍历所有
operation、生成所有 loot 并生成合并后 item entities：

- `src/gameplay/fallen-tree-lifecycle.ts:3497-3517`
- `src/gameplay/fallen-tree-lifecycle.ts:3743-3798`

detached attachments 使用 `system.runJob` 分摊，属于已有保护。掉落系统主要解释破碎/结算尖峰和
之后的 item entity tick，不解释一批尚未破碎的活动树持续低 TPS。

## 10. 当前仍然存在的有效优化

为了避免错误结论，以下优化没有丢失：

- SAP broadphase、AABB 模式、8 solver iterations 和 Cannon sleep；
- 所有 body 睡眠时跳过物理子步；
- 生产 runtime collider 排除叶片，非叶方块用 greedy box mesh；
- 叶片浮力、接触探针和 break group 会随全局 active budget 降级；
- fragment packing 大幅减少了渲染实体，而不是一方块一实体；
- world collider layout 相同时不重复增删 Cannon 静态 body；
- 伤害和世界扫描会合并重叠 cluster；
- 碰撞查询和粒子有 tick 内去重，声音有冷却；
- 大量同类掉落会合并，attachments 使用 `runJob`；
- 持久化刷新按树 ID 分散到 20 tick。

这些优化使现版比“所有树方块精确物理 + 一方块一实体”的朴素实现快很多，但不足以抵消新热路径
和旧 world mesh cache 的缺失。

## 11. 严格恢复旧版性能必须牺牲什么

“完全回到旧版性能”应定义为：相同机器、相同 Bedrock 版本、相同世界和玩家数下，40 个处于活动
状态的 legacy-profile 物理体，p95 server tick time 不高于旧包基线的 110%，且 p95 小于 50 ms。
不建立这个同机基线，就不能声称已经“完全恢复”。

严格 legacy TPS profile 需要以下取舍：

| 必须改变 | 性能收益 | 必须接受的玩法/质量损失 |
| --- | --- | --- |
| 恢复 `1 x 1/20` 求解 | 直接收回约 2/3 Cannon 步进预算 | 高速防穿透、旋转/堆叠稳定性和细粒度接触变差 |
| 恢复 `8x8x8` snapshot/mesh cache 和 4+2 重建预算 | 消除稳定区域每 tick 世界重扫 | 方块变化到 collider 生效可能延迟；漏掉无事件变化时需周期校验 |
| 禁用活动树装配体叶/附件接触探针 | 消除一层逐树 `getBlock` | 树叶和附件不再在运动中撞碎，只能结算时处理 |
| 禁用“树压碎世界脆弱块”扫描 | 消除第二层逐树预测 `getBlock` | 运动树不能主动扫碎世界树叶、作物、冰等 |
| 禁用逐点叶片流体和完整浮力 | 消除扫描外浮力点查询和三子步浮力循环 | 树不再按树冠真实体积漂浮；严格档建议完全关闭水/熔岩物理 |
| 禁用活动树伤害/击退 | 去除 `getEntities(volume)` 和候选过滤 | 倒树不再伤害生物/玩家 |
| 简化加载边界保护，删除预测、guard、last-safe 和延迟结算 | 去除或缩减每 tick 玩家和 chunk 可读性检查 | 树仍会在加载边界碎掉，但触发位置可能更早，极端情况下结算效果或掉落可能不完整 |
| 仅在创建、睡眠和终止时持久化 | 去除每 20 tick 运动 state 动态属性写 | 崩溃时可能回到上个稳定点；不能保证逐 tick 恢复 |
| 每 assembly 最多 1-2 个视觉实体 | 接近旧版“一 body 一 entity”服务端成本 | 需要粗化整树模型；失去任意方块级 fragment 表达和局部视觉破碎 |
| 恢复旧 transform 阈值和低运动每 3 tick 写回 | 大幅减少实体 SAPI/同步调用 | 客户端位置/旋转有轻微阶梯和最多数 tick 延迟 |
| 禁用运动中 log fracture、动态 decay 和 attachment 脱落 | 避免结构重建、loot/粒子/实体尖峰 | 树保持整体，直到最终统一结算 |
| 最终只生成合并后的代表掉落，关闭逐方块 loot | 限制结算尖峰和 item entities | Fortune/工具/方块状态对应的精确逐块掉落语义丢失 |
| 粒子/声音改为 body 级低上限 | 消除接触风暴的效果调用 | 反馈密度降低，不再每个接触点匹配方块材质 |

### 11.1 玩家肉眼会看到哪些退化

严格 legacy TPS 档最直观的变化，不是 FPS 下降，而是**树与世界互动的细节减少、碰撞更粗、反馈更少，
并且运动更早结束**。可以把最终观感概括为：树仍会整体倒下，但会更像一个带粗略碰撞盒的“大型
掉落方块”，而不是一棵每片树叶、每段树干、每个附件都继续参与玩法的活动结构。

需要特别说明：当前三子步也只在一个游戏 tick 结束后同步一次视觉。因此改为单子步不会简单地把
画面从 60 FPS 变成 20 FPS；自由飞行阶段的视觉更新频率基本不变。肉眼差异主要出现在高速撞击、
沿地面滚动和即将静止的最后阶段。

| 玩家观察的场景 | 当前完整效果 | 严格恢复旧版性能后的直观效果 | 可见程度 |
| --- | --- | --- | --- |
| 树高速撞地、撞墙或相互碰撞 | 三子步减少穿透，旋转和接触修正更细 | 枝干更可能短暂插入地面/墙面、穿过薄结构，随后弹开或突然校正；多棵树堆叠更容易抖动或卡入 | 高 |
| 树缓慢滚动并停稳 | 很小的位移和 `0.05` 度旋转也会继续同步 | 最后几次小幅滚动可能呈阶梯状；树会更早突然停止，不再表现细小余震 | 中高 |
| 树冠和树叶撞击地面 | 叶片可按探针和 break group 脱落，树冠会逐步出现缺口 | 大部分树叶保持粘在整树上，可能直接穿进地面/墙面；通常等最终结算时才统一消失或处理 | 很高 |
| 蜂巢、藤蔓、可可豆、悬挂根等附件撞击 | 附件可以独立脱落、播放效果并产生对应结果 | 附件继续跟随整树，或在结算时一次性消失；看不到撞击时逐个掉落 | 高 |
| 倒树扫过世界树叶、竹子、作物、冰等脆弱方块 | 树会检测并压碎满足规则的世界方块 | 树与这些方块互相穿插，世界植被不会被树冠清出一条路径 | 很高 |
| 树干承受强撞击 | 可累计撞击损伤并发生动态断裂，不同部分随后继续处理 | 树干基本保持一个整体，不会在倒下途中折断；最终以整棵树统一结算 | 很高 |
| 倒树长时间留在世界中 | 可以逐步衰减、掉叶并处理失去支撑的部分 | 不再看到渐进掉叶和结构变化；整树保持原样，直到某个时刻整体转换或消失 | 高 |
| 树落入河流或海中 | 多个树干/树冠浮力点共同决定漂浮、翻转和吃水姿态 | 严格档关闭流体物理时，树会像在空气中一样落下并沉底；若保留单点粗略浮力，则只会整体漂浮，树冠入水深度和姿态明显不真实 | 很高 |
| 树进入熔岩 | 有入岩反馈、暴露累计和终止效果 | 只保留一次简化反馈或直接统一结算，不再表现完整的逐步受热/销毁过程 | 高 |
| 树砸到玩家或生物 | 按树干接触、速度计算伤害并击退 | 玩家和生物可以站在或穿过倒树的伤害区域而不受伤、不被击飞 | 很高，直接影响玩法 |
| 树运动到加载区/区块边界 | 预测边界并在当前或最后可读姿态碎掉；极端不可读时延迟完成结算 | 使用更简单的边界判定后仍会碎掉，但可能更早触发或在略有差异的位置结算 | 低到中 |
| 玩家刚放置或破坏附近方块 | 当前每 tick 重扫后几乎立即反映到物理世界 | cached mesh 尚未重建时，树可能短暂撞到已经挖掉的“幽灵方块”，或在新方块生效前穿过去 | 低频但明显 |
| 树的外观轮廓 | 11-15 个 fragment 可表达树干、树冠、附件和局部缺口 | 压到 1-2 个实体后必须使用更粗的组合模型；小枝、局部树叶和附件可能被省略，局部破碎可能表现为整段突然切换 | 很高 |
| 撞击反馈 | 不同接触点可产生对应材质的 dust、typed particle 和声音 | 同一棵树同一 tick 只保留少量代表粒子/声音；大型撞击看起来更安静、更“轻” | 中高 |
| 最终破碎和掉落 | 可按方块状态、工具和 loot table 生成并散落多个物品 | 只出现少量合并后的物品堆，位置更集中；看不到整棵树沿长度散落掉落物，精确 Fortune/工具差异可能消失 | 高，直接影响收益 |
| 世界保存后崩溃或重启 | 运动状态定期保存，尽量从最近姿态恢复 | 树可能回到上一个稳定位置、直接进入结算，或丢失最后几秒的运动和破碎结果 | 平时不可见，故障时明显 |

用一个完整场景描述：玩家砍倒一棵树后，legacy TPS 档中的树仍会向一侧倒下，但树冠扫过灌木时
不会再清除灌木，叶子和蜂巢不会在撞击过程中逐个脱落，树干不会从中间折断；砸中生物没有伤害，
落水后不会按树冠体积分布漂浮。撞地时只有少量代表性尘土和声音，枝条可能穿入地形，最后几次滚动
会较早停止。结算时整棵树一次性切换，并在较集中位置生成少量合并掉落。如果树滚到加载区边缘，
还可能突然冻结或被直接结算。

其中最难隐藏、也是玩家最容易察觉的牺牲依次是：**逐叶/附件破碎、压碎世界方块、树干动态断裂、
水中真实浮力、树伤害和精细整树外观**。加载边界检查简化、世界 mesh 缓存、持久化降频、较低效果上限
在大多数正常场景中可以做得不明显，但在刚修改地形、服务器重启和大规模碰撞时仍会暴露差异。

### 11.2 在尽量保留现有玩法时的最小牺牲组合

如果目标是“尽量挽救已经完成的玩法和视觉”，不应先关闭叶片破碎、附件、流体、伤害或 fragment。
最小损失方案应按以下顺序处理：

1. **牺牲绝对零幽灵碰撞保证，恢复混合 world mesh cache。**
   - 恢复旧版 `8x8x8` snapshot/mesh，稳定区域不再每 tick 重扫；这是最可能收回最大整体预算的单项。
   - 方块放置、破坏、爆炸、活塞和树自身改动立即标脏；已知变化不应产生幽灵碰撞。
   - 活动树附近保留一个小的 exact verification shell，远处使用 cache；对未被事件捕获的变化做低频
     paranoid rescan。真正被牺牲的是“任何未通知 world mutation 都永远不可能有一 tick stale collider”
     的绝对保证，而不是树木玩法本身。
   - 这是最值得承担的风险：偶发、短暂、可定位的幽灵碰撞，换取保留当前所有树木功能和视觉。

2. **牺牲物理时间分辨率，默认改为 `1x1/20`。**
   - 40 Box 隔离测试已经证明 Cannon 步进可减少约 69%。
   - 代价集中在高速撞击、薄结构穿透和堆叠稳定性；叶片破碎、附件、流体、伤害、掉落和 fragment
     仍可保留。
   - 后续可以只在超过速度/角速度阈值时临时升到 2 子步，但第一版应先用固定单子步确认收益。

3. **只牺牲副玩法的即时性，不删除副玩法。**
   - 叶片/附件探针、世界压碎探针、浮力采样和伤害检测改成按 active-tree load 在每 2-4 tick
     轮转；使用 tree id 错峰和 swept interval，避免集中查询和漏掉长距离运动。
   - 低负载时仍保持每 tick；只有接近 TPS 预算时才降频。
   - 玩家看到的是叶片晚几十到几百毫秒脱落、伤害或水面反馈稍迟，而不是功能消失。

4. **恢复旧版低运动 transform 节流。**
   - 位置/旋转阈值恢复到旧版，near-static body 每 3 tick 写回；高速倒下阶段保持当前同步。
   - 不减少 fragment、不改变模型，只牺牲停止前的微小位移精度，换回实体 SAPI 写调用。

如果只能选两项，优先选 **混合 world mesh cache + 单子步**；如果要在真实 Bedrock 上稳定接近旧版，
通常还需要第三项“副玩法降频”，因为单纯修复 Cannon 和世界扫描无法消除每树数百次 SAPI 探针。

在这套最小组合之后仍然超预算时，第一项真正应该删除的玩法才是“压碎世界脆弱方块”，而不是叶片
破碎、流体、伤害或 fragment。它能去掉最大的逐树查询层，同时不会改变树自身的外观和树自身破碎。

如果保留完整树模型、逐叶破碎、世界压碎、真实浮力、加载边界完整结算保护、活动树崩溃恢复、伤害
和 11-15 个 fragment，同时要求“40 棵树等同旧版 40 个单方块”，这个目标在工作量定义上自相矛盾，
不能作出工程承诺。可以承诺的是
通过全局预算保持 20 TPS，但效果会延迟或降级。

## 12. 可执行恢复方案

### 12.1 Phase 0：先建立真实 Bedrock 归因仪表

在任何大重构前，增加每 tick、每 dimension 的计数和耗时分桶：

- Cannon：body、awake body、shape、candidate pair、contact、substep 数和物理耗时；
- 世界：`getBlocks` 次数、外接体积、coverage 体积、返回非空气数、fallback `getBlock` 数；
- 生命周期：assembly/world/leaf/attachment/浮力/chunk-readability 点查询数；
- 实体：`getEntities`、候选数、teleport、setProperty、spawn/remove；
- 事件：particle、sound、loot permutation、spawnItem；
- 持久化：序列化字节、dynamic property 写次数；
- server tick：median、p95、p99，持续段和破碎段分开。

固定 A/B 场景：

1. 40 个旧版单 Box；
2. 40 个现版单 Box assembly；
3. 15/40 棵 123 方块树；
4. 15/40 棵 408 方块树；
5. 树分散与 AABB 相接两种布局；
6. 全部 awake、near-static、sleeping 三个阶段；
7. 干地、水中、破碎结算三个阶段。

逐项开关：`substeps=1/3`、world scan/cache、lifecycle probes、visual sync、加载边界保护（代码内名
`crossDomain`）、damage、
persistence、particles、arrow runtime。每次只改一个变量，至少采样 30 秒稳定段。

### 12.2 Phase 1：恢复旧版结构性优化，不先砍核心玩法

1. **移植 world snapshot/mesh cache**
   - 以 dimension + `8x8x8` origin 为 key；
   - collider、流体和传感器结果均缓存；
   - 方块破坏/放置/爆炸/活塞事件标脏；
   - 高优先级 4、普通 2 chunk/tick 起步；
   - 低频抽样校验未捕获变化；
   - 当前 body shape scan 只负责声明需要哪些 cached chunks，不再扫描方块。

2. **禁止跨树外接体积膨胀**
   - `getBlocks` 按 cache chunk 或受限小 volume 查询；
   - cluster 合并前比较“合并外接体积 / coverage 体积”，超过 1.5 即不合并；
   - 每 tick设置原生 volume 总量硬预算。

3. **把 per-tree probe budget 改为 per-dimension global budget**
   - 点查询初始预算 256/tick/dimension；
   - assembly、world fragile、fluid、chunk guard 共用预算；
   - round-robin，不能让前几棵树长期独占；
   - 复用 world snapshot/当 tick block cache，禁止同坐标多层重复查询。

4. **恢复同步与睡眠节流**
   - 位置 `0.0025`、旋转 `0.35` 度；
   - 低运动每 3 tick 写，defer 阈值位置 `0.02`、旋转 `1.5` 度；
   - fragment 共用 body dirty flag；
   - near-static 8 tick 和支撑链强制 sleep；
   - 每 40 tick 重选 SAP axis。

5. **预算化周期工作**
   - persistence 最多 1 个 state tree/tick，结构写另设低频队列；
   - damage 查询降为每 2 tick，按 dimension 轮转；
   - 最终 loot/结算按最多 64 operations/tick 的 `runJob` 分片；
   - particle 16、sound 4、spawnItem 16 次/tick/dimension 起步。

验收：保留现有核心树玩法时，15 棵 408 方块树稳定段 p95 < 50 ms；世界缓存命中后的世界方块读取
应接近 0，点查询不得随树数无界增长。

### 12.3 Phase 2：接近旧版性能的平衡档

当 Phase 1 仍不能达到旧版基线时，启用 balanced profile：

- 默认 `1 x 1/20`，仅高速且预测位移超过阈值的 body 使用 2 子步；
- 叶片 profile 不再使用 exact；每树叶浮力最多 4 点、接触探针最多 4；
- 世界压碎探针最多 4/树且受全局预算，允许 5-20 tick 延迟；
- 伤害每 2-4 tick；
- visual 最多 4 entities/tree，超出时合并或隐藏低优先级 attachment；
- 加载边界改为更便宜的单次检查并直接结算；当前实现本来就不会越界后继续物理运动；
- 运动状态每 5 秒保存，睡眠/破碎时强制保存；
- 精确 loot 延迟分片，不允许单 tick 整树处理。

该档保留“整树倒下、粗略碰撞、有限叶片破碎、有限浮力、伤害、最终掉落”的核心体验，代价是效果
延迟、较粗碰撞/视觉和较弱恢复精度。目标为 40 棵中等树不低于 20 TPS，但是否达到旧版 40 Box
的完全同耗时，仍以 Phase 0 同机数据为准。

### 12.4 Phase 3：严格 legacy TPS 档

实现独立且可测试的 `legacy_tps` 配置，不与 balanced 参数隐式混用：

- 固定 1 子步；
- cached world mesh；
- collider 每 assembly 最多 1-4 boxes；
- 关闭 leaf/attachment/world fragile probes；
- 关闭流体、伤害、动态 fracture/decay；
- 边界直接结算；
- 仅稳定点持久化；
- 每 assembly 最多 1-2 visuals，并采用旧写回节流；
- 关闭逐接触粒子，声音 body 级冷却；
- 最终统一代表掉落。

验收条件：40 个 legacy-profile 活动 assembly 的 median/p95/p99 与旧包 40 个 body 同机结果对比；
p95 差异不超过 10%，连续 5 分钟无低于 20 TPS 的稳定段。若仍超标，按 Phase 0 计数继续减少视觉
实体或 active body 上限，而不是重新开启无预算探针。

### 12.5 保留全部玩法档的现实边界

完整档可以保留所有功能，但必须接受以下调度规则：

- 全局 SAPI、实体写、效果、loot 和持久化预算；
- 超预算时延迟玩法效果，而不是拖慢当前 tick；
- active tree 上限按 shape、AABB 体积、fragment 和 probe 权重计算，不能只按 body count；
- 逼近 50 ms 时自动把远处树 sleep/freeze/settle，把 leaf profile 降到 low；
- UI/调试输出显示当前预算和降级原因。

这能承诺“服务器维持 TPS 并渐进降级”，不能承诺“40 棵完整复杂树与旧版 40 个方块刚体成本相同”。

## 13. 建议实施顺序与退出条件

| 顺序 | 工作 | 退出条件 |
| ---: | --- | --- |
| 1 | Phase 0 计数器和固定服内场景 | 能解释每 tick 50 ms 去向，A/B 可复现 |
| 2 | world snapshot/mesh cache | 稳定活动树区域不再持续读取世界方块 |
| 3 | 全局探针/流体预算与查询复用 | 查询数由全局上限决定，不再线性乘树数 |
| 4 | transform、sleep、SAP 节流 | near-static 阶段实体写和 awake body 快速下降 |
| 5 | persistence/loot/effect 分片 | p99 破碎尖峰进入预算 |
| 6 | balanced profile 验收 | 15 棵 408 树稳定 20 TPS，再测试 40 棵 |
| 7 | legacy_tps profile | 40 legacy assemblies 达到旧包 p95 的 110% 内 |
| 8 | arrow runtime A/B | 有数据再决定是否替换 runtime identifier |

## 14. 本次审计的最终结论

1. **物理性能确实变差了**：固定三子步在相同 40 Box 下约慢 3.24 倍。
2. **装配体不是天生的决定性问题**：当前树是一体 compound body，生产 408 方块树只有 13 shapes；
   真正不等价的是逻辑方块、扫描体积、探针和视觉实体数量。
3. **额外玩法显著牺牲了 TPS**：尤其是两层脆弱块探针、扫描外浮力点、伤害、加载边界检查和活动树状态持久化。
4. **旧版关键优化确实被移除或弱化**：最大项是持久 world mesh cache，其次是低运动写回/睡眠节流。
5. **声音、粒子和掉落不是持续掉 TPS 的首要解释**：它们主要产生接触、破碎和结算尖峰。
6. **要完全回到旧版性能，必须提供真正的 legacy profile**：恢复 20 Hz 单步和 cached world，关闭逐叶/
   逐世界块玩法、精确流体/伤害，简化加载边界结算并把视觉压到每 body 1-2 实体，接受粗化和延迟。

## 15. 已实现的最小牺牲性能档位

DDUI 现提供两档“物理性能”下拉选项，动态属性为 `tree_physics:physics_performance`：

- `0`（低）：`1 x 1/20`、启用 `8x8x8` world mesh snapshot cache、关闭树对世界脆弱方块的
  主动探针和碰撞破坏，并在装配前把巨型丛林树与华丽橡树的分支安全结算为掉落物；
- `1`（高，默认）：保持原有 `3 x 1/60`、逐 tick exact world scan 和世界脆弱方块破坏行为。

低档没有关闭树自身叶片/附件破碎、树干断裂、fragment 视觉、流体、伤害、声音、粒子、掉落、加载
边界结算保护或既有活动树/结算事务持久化。运行时切换设置后，已有 dimension 会在下一个 physics tick
重新配置，无需重新进入世界。

预装配分支裁剪只影响设置切换后新创建的符合结构资格的装配体。它复用既有巨型丛林树和华丽橡树
分支分组，并把分支与失去支撑的树叶/附件加入持久化 `runJob` 掉落链路；高档、普通树和巨型云杉
不进入该路径。典型华丽橡树剩余主干可合并为 1 个动态 Box，基底缺一格的 `2x2` 丛林主干通常为
3 个动态 Box。

world cache 按 dimension 和 `8x8x8` 网格保存已经解析的固体、sensor、局部碰撞形状、材质和流体表面。
活动体仍每 tick 计算预测扫描范围和 sparse coverage，但稳定网格命中时不再调用 SAPI 读取方块。玩家放置/
破坏、`blockExplode`、活塞移动、砍树源方块移除和自然根方块恢复会立即失效相关网格。首次缺失网格
每 tick 最多建立 4 个，未完成预热的 cluster 暂时继续 exact scan，避免首 tick 扫描尖峰或缺失碰撞；
未捕获的脚本写入由每 100 runtime tick 最多重查 2 个活动网格的 paranoid refresh 兜底，400 tick 未使用
的网格会回收。

自动化验证覆盖了高低档运行时 `3 -> 1 -> 3` 子步切换、稳定网格零重复查询、事件失效后重建、低档
compound body 不穿过 cached world collider，以及低档两条世界脆弱方块破坏路径均关闭。它证明实现边界
和查询削减成立，但不能替代真实 Bedrock server tick 测量；“接近旧版性能”仍必须按第 12.1 节固定场景
完成同机 p95/p99 A/B 后才能正式验收。
