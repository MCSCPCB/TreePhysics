# 实体属性树木 Fragment 渲染计划与可行性证据

> 后续执行说明：本文记录当前 fragment 架构及其实现证据。下一阶段的固定色、少实体再装箱、
> 树叶物理分级和最终性能收敛以
> [`tree-fragment-convergence-plan.md`](../history/tree-fragment-convergence-plan.md)
> 为准；新计划已取代本文所有 BlockMap、精确群系 tint、颜色 palette 和颜色属性同步方案。

## 文档状态

- 状态：实现与自动门槛完成，等待唯一一次最终基岩版实机验收。
- 目标：让已注册的原版树木装配体用尽可能少的基岩实体完整渲染；当前“一方块一显示
  实体”路径永久保留，作为含未注册方块装配体的默认兼容渲染器。
- 数据通道：只使用持久化、`client_sync` 的实体属性；不使用
  `playAnimation.stopExpression` 传结构数据，也不设置周期性 Molang 数据重播。
- 纹理策略：优先直接引用原版 `textures/blocks/...` 路径，不生成固定方块 atlas。
- 变更边界：只更换视觉实体的生成、同步、隐藏和清理实现；Cannon 刚体、逻辑方块、
  碰撞体、质量、浮力、射线、交互、伤害、破碎、掉落、树木选择、生命周期和持久化
  语义全部不变。

本文把依据分为四类：

| 标记 | 含义 |
| --- | --- |
| `已直接证明` | 微软文档或现有 sample 直接展示了相同行为 |
| `组合可行` | 所需的每个基岩原语均有依据，但组合方式需要原型验收 |
| `内部算法` | 普通 TypeScript 数据处理，不依赖未公开基岩能力 |
| `阻塞资料` | 缺少能保证目标语义的资料，实现前需要补充或作出取舍 |

2026-07-16 补充审查后，原 `B1`、`B2` 已由新增资料解除，`B3` 已由项目方接受。
当前没有仍需外部资料才能开始原型的阻塞项；剩余不确定性均已收敛为必须实机验证的
原型门槛。

### 2026-07-16 实现快照

- `src/physics/assembly-visual-renderer.ts` 已实现旧/新 renderer 等价接口、整装配体择一、共享
  锚点同步、O(1) 实体反向索引、槽位清除和实体清理。
- `src/tree/fragment-layout.ts` 已实现确定性分层装箱：原木使用 `7 x 4 x 7` 的 196 个
  固定槽，树叶使用 `6 x 3 x 6` 的 108 个固定槽和 8 色精确调色板，附件每实体使用
  26 个动态槽；非精确原版 ID、非法状态或无法编码的 tile 原点会在
  生成实体前让整棵装配体回退旧渲染器。去皮原木、wood 及自定义同名方块不会误用
  普通原木纹理。
- `scripts/generators/tree-fragments.mjs` 与
  `scripts/generators/tree-attachments.mjs` 已生成 BP/RP 属性、geometry、动画和
  render controller；附件转换器直接读取 `sample/vanilla-block-model`。
- 正式颜色来源为树木捕获时原方块的 `BlockMapColorComponent`。脚本用
  `tintedColor / color` 得到该位置已经计算完成的精确 tint，量化为 24-bit RGB 并写入
  叶片/藤蔓快照；组件不可用或通道不可安全相除时才回退树种固定 tint。颜色不会在物理
  tick 重算，也不调用 `getBiome()`。
- 叶片实体用 31 个 `client_sync` 属性承载姿态、原点/树种、8 色 RGB palette 和 18 个
  4-bit 槽位字。客户端 Molang 只通过 `query.property()` 解码，不通过 `playAnimation`
  或周期性脚本重播传值。
- 新旧视觉实体使用相同的 `128 x 128` 可见边界，以覆盖共享实体锚点之外的高树冠和
  远端附件，避免客户端按实体原点错误剔除 fragment。
- 附件模型转换已覆盖 parent/texture alias、逐面 UV、UV rotation、零厚度面、element
  rotation、`rescale: true`、原版 blockstate 朝向及相同旋转组 bone 合并；单份附件
  geometry 最大 187 bones，不超过 256 门槛。
- 自动回归覆盖 15 个测试文件、218 个测试；正式构建通过。123 方块基准树
  从 123 个视觉实体降为 9 个，活动 1/10 树和休眠 10 树基准均快于旧路径。
- 使用 Blockception `1.21.73-0` JSON schema 及其 VS Code JSON language service 完成生成
  资源审计：两份 client entity、animation、render controller 和固定槽 geometry 均无
  诊断；附件 geometry 只有 schema 尚未收录逐面 `uv_rotation` 的重复警告，没有其他
  结构诊断。BP entity 只有 schema 相对当前 sample 滞后的 `minecraft:pushable` 与布尔
  `deals_damage` 警告。`uv_rotation` 由 [ET-UV-ROT] 的现有基岩实体 geometry 样例直接
  佐证，因此保留，并交由最终实机验收确认其像素结果。

## 硬约束与发布边界

### 性能优先

服务端成本优先级高于颜色精度和极限实体数。能由客户端 Molang 从已同步属性或客户端
query 计算的视觉结果，不在服务端物理 tick 重算。精确颜色只能使用树木捕获时的一次性
只读数据，并且必须通过与当前版本相同场景的性能对照；出现可重复的创建耗时或运行时
退化就删除该精确路径，按本文的颜色降级阶梯退回。

降级只减少渲染细节，不允许改变物理数据或玩法语义，也不允许把周期性查询、Molang
重播或动态负载自适应引入服务端。任何候选方案都必须满足：服务端性能不低于当前版本，
渲染准确性不低于当前逐方块实体版本。无法同时满足时，该候选不得进入最终原版树路径。

### 只有一次最终人工验收

阶段 0 至阶段 4 的原型、截图比对、属性恢复和性能检查均为开发期内部门槛，不要求玩家
分阶段验收。全部门槛通过后只提交一次最终实机验收。最终验收同时验证：

- 已注册原版树的方块类型、局部位置、轴向、可见面、透明度、附件状态和整体运动语义；
- 首次生成、方块破碎、重进、区块重载及最终结算的渲染生命周期；
- 除显示实体数量和实现外，物理与玩法行为和当前版本完全一致；
- 同场景性能没有可重复退化，且渲染实体数和每步 transform 写入数显著下降。

### 旧渲染器永久保留

当前 `createBlockVisual()`、`physics_api:physics_block` 行为实体及其 RP geometry、动画
保持原样，不删除、不改写，也不让 fragment 与其共同渲染同一装配体。创建视觉前先对
整棵装配体做一次纯表查找：

1. 所有方块类型和所需视觉状态均存在于封闭的原版 fragment 注册表时，整棵树只使用
   fragment；最终发布覆盖表中的原版树不得再使用逐方块实体。
2. 只要有一个方块未注册或其状态无法无损编码，整棵装配体只使用旧渲染器。
3. 不实现逐方块混合回退，避免两套锚点、索引、破碎和恢复路径同时作用于一棵树。

这条回退仅服务于未来未注册/自定义方块兼容；本计划不扩展自定义树注册能力。旧路径的
现状基线是：每个逻辑方块生成一个 `physics_api:physics_block`，通过主手物品模型显示
`itemTypeId/typeId`，并同步该方块的局部坐标、局部旋转和装配体整体姿态。fragment 的
最终画面对照以这条真实路径为下限，而不是以理论上的方块完整状态为下限。

## 最终技术路线

### 1. 属性是唯一结构同步来源

行为包显示实体声明不超过 32 个实体属性。所有结构字使用 `int`、
`client_sync: true`、默认值 `0`，并由脚本调用 `Entity.setProperty()` 写入。

这条路线有直接依据：

- [MS-EP] 明确说明实体属性按实体实例保存，随世界保存/加载持久化，并可通过
  `client_sync` 发给客户端。
- [MS-EP] 明确规定每种实体最多 32 个实体属性。
- [MS-EP] 明确说明 Molang 以浮点值处理大整数，超过约 1670 万会出现精度问题。
- [MS-ENTITY] 记录 `Entity.setProperty()`，并说明属性值必须匹配声明类型和范围，
  变更在下一 tick 应用。
- [SC-BP] 和 [SC-SCRIPT] 已在实际附加包中用四个同步属性传递方块局部偏移与方向。

结论：属性持久化、客户端同步和脚本写入为 `已直接证明`。渲染系统不需要定时
查询实体或重播结构数据。

### 2. 用 24 bit 属性字承载多个固定槽位

每个属性字限制为 `[0, 16777215]`，即 `2^24 - 1`。这避免进入 [MS-EP]
指出的不精确整数区间。槽位状态按下式读取：

```text
state(word, slot, bits) = floor(word / 2^(slot * bits)) mod 2^bits
```

计划使用三种编码：

| 编码 | 单槽状态 | 每属性槽数 | 用途 |
| --- | --- | --- | --- |
| 1 bit | 空 / 存在 | 24 | 同材质、无轴向树叶 |
| 2 bit | 空 / Y / X / Z | 12 | 同树种原木 |
| 3 bit | 空 / 叶 / Y 原木 / X 原木 / Z 原木 / 特殊类型 | 8 | 混合模板 |

依据如下：

- [MS-QP] 明确说明 `query.property()` 返回实体属性值。
- [MS-FLOOR] 和 [MS-MOD] 分别定义 `math.floor` 与 `math.mod`。
- [VT-RC] 已在实体渲染控制器中使用 `Math.floor` 和 `Math.mod` 解码数值并驱动
  每个槽位的渲染参数。

微软没有“实体属性位图渲染 24 个槽位”的完整官方例子。因此位图方案标记为
`组合可行`，必须先通过第 0 阶段原型门槛。其数值范围和运算原语均有明确依据，
不存在依赖未文档化位运算的问题。

### 3. 固定空间槽位，不用 Molang 注入坐标

Fragment 实体的每个普通槽位在资源包几何中拥有固定局部坐标。槽位对应的
render controller 从属性字中取状态：状态为 0 时不渲染，非 0 时选择对应几何、
纹理与轴向。

实现采用三层共享骨架：树叶、原木侧面、原木端面各一个 geometry 和一个 render
controller。每层包含 196 个固定槽 bone，`part_visibility` 从 25 个属性字解码；同一个
动画按状态把原木槽旋转到 Y/X/Z 轴。每个 geometry 共 201 个 bone，低于 VanillaTrain
已展示的 256 槽规模，也避免生成数百个重复 controller。

[VT-SIMPLE] 直接展示一个实体的 256 个简单槽位；[VT-CLIENT]、[VT-GEO] 和
[VT-RC] 展示客户端实体、逐槽 geometry 和逐槽 render controller 的完整接线；
[MS-RC] 则明确记录 `part_visibility`。把 256 个独立 geometry 收敛为三份多 bone
geometry、并把数据来源改为 `query.property()` 位段，是 `组合可行`。

### 4. 固定槽位与动态细节槽混合

原木和树叶使用固定体素位图；附件使用 tile 内动态槽。每个附件描述字实际只用 17 bit：

| 字段 | bit | 范围 |
| --- | ---: | --- |
| present | 1 | 空 / 存在 |
| local X | 3 | `[0, 6]` |
| local Y | 2 | `[0, 3]` |
| local Z | 3 | `[0, 6]` |
| render kind | 4 | 当前 9 类原版树木附件，最多 16 类 |
| state | 4 | 轴向、朝向、年龄或蜜量视觉状态，共 16 种状态 |

tile 原点另用两个属性编码：X/Z 各 11 bit 合并为一个 22-bit 字，Y 使用一个 11-bit
属性。所有显示实体仍生成在相同的装配体局部 `+Y` 锚点；客户端先施加 tile 原点，
再施加槽位位置。因此整体角度插值时不会在 fragment 之间产生分离。

动态槽几何的局部位置和旋转由动画读取属性后计算：

- [SC-ANIM] 已直接用同步属性驱动方块骨骼 `position`。
- [VT-ANIM] 已同时用数值驱动逐槽 `position`、`rotation` 和 `scale`。
- [MS-ADD-ENTITY] 明确说明动画可修改每个 bone 的位置、旋转和缩放。

把多个字段压进一个属性再解码，仍属于 `组合可行`；局部偏移和骨骼变换本身为
`已直接证明`。

## 属性预算和布局

### 通用元数据

固定原木/树叶 fragment 使用以下属性：

| 属性 | 用途 |
| --- | --- |
| `pitch` / `yaw` / `roll` | 装配体整体姿态，沿用当前插值路径 |
| `family` | 原木/树叶纹理数组下标 |
| `tint` | 树叶颜色索引；非树叶 fragment 可复用 |
| `origin_xz` / `origin_y` | 共享实体锚点下的 tile 局部原点 |

实际预算为 7 个元数据属性加 25 个三位状态字，正好 32 个属性，可表示 196 个固定槽。
附件 fragment 使用 3 个姿态、1 个 tint、2 个 tile 原点和 26 个动态描述字，同样正好
32 个属性。

### 实现布局

| 布局 | 目标 | Feature 依据 | 状态 |
| --- | --- | --- | --- |
| 标准树 | 普通橡树、白桦、普通云杉、丛林小树 | [VF-OAK]、[VF-BIRCH]、[VF-JUNGLE] | `内部算法` |
| 宽树冠 | 樱花、深色橡树、苍白橡树、华丽橡树 | [VF-CHERRY] 半径 4/高 5；[VF-FANCY] 半径 3/高 4 | `内部算法` |
| 2x2 高树干 | 巨型云杉、巨型松树、巨型丛林树 | [VF-MEGA-SPRUCE] 最大约 31 高；[VF-MEGA-JUNGLE] 最大约 33 高 | `内部算法` |
| 高针叶树冠 | 巨型云杉/松树 | [VF-MEGA-SPRUCE] 树冠高最大 18 | `内部算法` |
| 水平长形 | 原版倒木和长分支 | `sample/vanilla-feature/features/fallen_*` | `内部算法` |
| 通用分片 | 邻树叶片、异常树形、未来原版变化 | 当前 `PhysicsAssemblyBlock.localLocation` | `内部算法` |

布局装箱器只读取已经选中的装配体方块，不推断或识别具体 Feature。原木/树叶先按纹理
family 分组，再分别尝试 X/Z 的 7 种、Y 的 4 种 tile 对齐，选择该轴占用 bucket 最少的
原点，最后装入 `7 x 4 x 7` 固定槽。附件使用同样 tile 对齐，每 26 个附件形成一个动态
fragment。华丽橡树、巨型云杉、倒木和异常邻树叶片只是自然产生更多 tile，不设置实体
数或树形正确性上限，也不会反向影响选树算法。

所有布局选择、槽位分配、属性打包和回收均为普通 TypeScript 算法，应由穷举单元测试
证明，不需要基岩平台的额外能力。

## 纹理、材质与状态

### 原版路径直引

客户端实体直接声明 `textures/blocks/...` 路径：

- [SC-CLIENT] 已直接引用橡树、白桦、云杉、丛林、金合欢、深色橡树、樱花、
  红树和苍白橡树的原木端面/侧面路径。
- [SC-RC] 已按 `query.variant` 从端面、侧面和树叶纹理数组中选择纹理。
- [TT] 提供当前原版 `terrain_texture.json`，包含藤蔓、三阶段可可豆、蜂巢四面、
  垂根、杜鹃树叶、红树树叶与胎生苗、苍白橡树和嘎吱之心的实际路径。
- [MS-RC] 明确支持客户端实体在 render controller 中选择 geometry、material、
  texture 数组和 part visibility。

因此不需要复制或生成固定方块 atlas。第三方资源包是否覆盖同一路径仍由玩家的
资源包优先级决定；本项目不会内置一份纹理快照去阻止覆盖。

### 原木端面、侧面和轴向

一个原木槽使用两个 controller/geometry 层：侧面层与端面层。整个槽位 geometry
按 Y/X/Z 状态旋转。

- [SC-GEO] 提供独立 `log_top` 和 `log_side` geometry。
- [SC-CLIENT] 在同一实体上同时声明端面与侧面 controller。
- [SC-RC] 为两层分别选择原版端面和侧面纹理。
- [VT-ANIM] 证明逐槽 90 度旋转可由动画数值驱动。

“196 槽共享两层原木 geometry/controller”是上述能力的组合，标记为 `组合可行`。

### 树叶透明与染色

- 树叶与藤蔓使用派生自 `alpha_block_color`、补有 `USE_OVERLAY` 的
  `alpha_block_color_tint` 材质，并由 render controller 的 `overlay_color` 字段着色。
- 实测的材质语义要求 controller 写入反色 RGB 与 `a: -1`，才能在保留
  `alpha_block_color` 透明/双面特性的同时得到不抹平原纹理明暗的乘色结果。
- 每组 `part_visibility` 先以 `{"*": false}` 关闭全部骨骼，再以相同槽位条件显式
  开启槽位根骨骼及其全部后代骨骼。
- [MS-RC] 证明 render controller 颜色字段可使用 Molang 表达式；本项目的最终
  `overlay_color`、反色 RGB 与负 alpha 组合来自基岩版实机材料测试。
- [MS-DIM] 证明脚本可以通过 `Dimension.getBiome()` 取得方块位置的生物群系类型。
- [BW-BLOCK-TINT] 列出 `default_foliage`、`birch_foliage`、`evergreen_foliage` 等
  原版 tint 方法，以及 foliage、birch、evergreen、swamp 和 mangrove colormap 的关系。
- [MOJANG-CLIMATE] 在官方 Bedrock sample 中提供全部原版 biome 的
  `minecraft:climate.temperature/downfall`；官方 schema 明确说明 downfall 会影响颜色。
- [MOJANG-CLIENT-BIOMES] 证明 client biome 可以选择特定 RGB 或 foliage colormap；
  swamp、mangrove swamp 使用专用 map，pale garden 等使用显式颜色。
- [MOJANG-COLORMAPS] 提供官方 256 x 256 foliage、birch、evergreen、swamp 和
  mangrove colormap；[MOJANG-FOLIAGE-SCHEMA] 明确列出这些合法 map 名称。
- [ET-BIOMES] 与 [ET-COLORMAPS] 提供另一份完整 Bedrock 资源包实例，但其 colormap
  与 Mojang sample 哈希不同，因此只用于验证资源包可覆盖颜色，不作为原版像素来源。

因此原 `B1` 已解除。正式实现不在客户端重新推导 climate/colormap，而是直接保存
BlockMap 已在原方块位置计算完成的权威结果。

#### 已实施的性能优先颜色路径

实现只在已有树木捕获遍历中增加一次只读组件访问：

1. 只对叶片和藤蔓读取 `block.getComponent("minecraft:map_color")`。
2. 对三个非零基础通道计算 `clamp(tintedColor / color, 0, 1)`，量化为 24-bit RGB。
3. tint 随 `CapturedTreeBlock` 快照保存，倒伏、休眠、重载和最终结算均不重新查询世界。
4. 组件缺失、抛错、数据非有限或任一基础通道不大于零时，使用已有树种常量回退。
5. 同一空间 bucket 最多保存 8 种精确颜色；第 9 种颜色开始确定性拆分新叶片 fragment，
   不量化合并不同颜色，也不让装配失败。

客户端 Molang 只承担属性解码和 palette 选择。它不计算温度/降水，不查询 foliage
colormap，也不需要根据倒伏后实体所在 biome 修正颜色。

#### 首选：读取位置 tint 的只读探针

`@minecraft/server 2.8.0` 已提供 [MS-MAP-COLOR]：

- `BlockMapColorComponent.color` 是方块基础地图色；
- `tintedColor` 是基础色乘以“给定位置计算出的 tint”；
- `tintMethod` 可确认 `DefaultFoliage`、`BirchFoliage`、`EvergreenFoliage` 等方法。

自然树变成装配体前，叶片仍是带世界坐标的 `Block`，所以可以无世界修改地读取
`block.getComponent("minecraft:map_color")`：

1. 若基础 RGB 三通道非零，计算 `evaluatedTint = tintedColor / color`；
2. 将结果写入方块快照，并由 fragment palette 原样传至客户端；
3. 基础色存在零通道或结果非法时只回退树种常量，不启动额外世界扫描。

该路径把 BlockMap 当作原版方块位置 tint 的权威来源；第三方客户端资源包自行覆盖
colormap 后的结果不在本项目保证范围内。

#### 未进入运行时的备选路线

曾评估由构建脚本读取 Mojang climate、client-biome override 和 colormap，再按
[JAVA-OPTIFINE] 的公式自行取色：

```text
t = clamp(temperature, 0, 1)
h = clamp(downfall, 0, 1) * t
u = floor((1 - t) * 255)
v = floor((1 - h) * 255)
base = colormap[u, v]
```

这条路线需要自行复刻未公开的 Bedrock 边界滤波，并可能增加 `getBiome()` 查询。由于
BlockMap 已直接提供位置结果，它没有进入生成器或运行时代码；Java 高度修正与坐标噪声
同样没有移植。

#### biome 边界渐变

二维邻域采样方案也只保留为被否决的设计记录：

1. 先检查叶片自身 biome 与树冠包围盒外的 guard ring；全部相同时跳过邻域混合；若
   阶段 0 同时排除了高度修正，则进一步走单色快路径；
2. 只有 guard ring 发现不同 biome 时，才在同一 Y 层按候选半径 `R = 0..7` 查询
   正方形内的 `Dimension.getBiome()`；
3. 将每个 biome ID 转成上述基础色或显式 override 色；
4. 分别对 R/G/B 通道做等权整数平均，得到该叶片的最终 tint；
5. 同一次树扫描内缓存 `(x,y,z) -> biome ID` 与 `biome ID -> base RGB`，相邻叶片共享
   查询结果；颜色只在捕获时计算，倒伏运动时保持原色。

Script API 和官方资料没有公开 Bedrock 客户端确切的 foliage 混合半径与滤波核，因此
这条路线既不能保证更准确，又会扩大服务端世界查询范围。当前实现没有任何 biome 邻域
扫描。

#### 渐变颜色的属性布局

所有已注册原版叶片都使用专用 leaf fragment：

- 最多 8 个 24-bit RGB palette 属性；
- 每个固定叶片槽 4 bit，`0` 为空，`1..8` 选择 palette；
- 5 个姿态/布局元数据 + 8 个 palette + 18 个状态字，共 31 个属性；
- 18 个状态字容纳 108 个叶片槽，超出空间 bucket 或颜色超过 8 种时继续分 fragment，不量化
  颜色，也不拒绝方块；树干和动态附件由独立 fragment 承载。

每个槽拥有独立 render controller，因此可用生成的 Molang 分支选择 palette 属性，再用
`floor/mod` 解码 RGB。树干、叶片和附件分别装箱，以保持各自属性预算和渲染语义。

下列资料没有被误作“实体自动读取 foliage colormap”的证明：

- [BW-ATLAS] 的 `tint_color` / `overlay_color` 是 terrain atlas 的静态乘色参数；
- [BW-MATERIALS]、[MS-MATERIALS] 与 [MC163-MATERIALS] 证明实体材质可配置 shader
  define，但没有说明实体会自动取得所在 biome 的 foliage color；
- [ET-MATERIAL] 的 `MULTIPLICATIVE_TINT` / `MULTIPLICATIVE_TINT_COLOR` 实际用于
  热带鱼双纹理染色；
- [ET-PARTICLE] 证明粒子可以使用 `atlas.terrain`、显式 UV 和显式 RGBA tint，
  但 `ground_particle_color` 是方块粒子事件输入，不是实体 Molang 查询；
- [JAVA-OPTIFINE] 与 [JAVA-POLYTONE] 只作为 colormap 原理背景，它们属于 Java 版，
  不是基岩实现依据。

兼容性边界：精确路线可以近似复现本项目随附的原版 Bedrock 颜色数据，但服务端脚本无法
读取玩家客户端上更高优先级资源包替换后的 colormap。第三方资源包仍可覆盖直接引用的
叶片纹理，却不会自动改写本项目生成的 RGB 表。这不是当前“原版树覆盖”目标的阻塞项。
`moving_block_*_seasons` 材质和粒子的 `ground_particle_color` 都没有普通自定义实体可
读取最终 tint 的文档或 sample，因此不作为正式路线；它们只保留为可独立尝试的实验。

### 附着物状态

蜂巢、可可豆、藤蔓、胎生苗、垂根、苍白垂苔和嘎吱之心使用动态细节槽：

- 纹理路径由 [TT] 提供；
- [VBM-ATTACHMENTS] 提供各状态的原版方块模型，[VBM-PARENTS] 提供它们引用的
  `cross`、`cube`、`cube_column`、`cube_column_horizontal` 和
  `orientable_with_bottom` 父模型；
- 几何和 UV 由构建脚本解析上述模型后生成；
- 朝向、年龄、蜜量或活动状态写入 descriptor 的 `state`；
- render controller 用 geometry/texture 数组选择实际外观，能力由 [MS-RC] 与
  [VT-RC] 证明。

原 `B2` 已解除。转换器执行以下确定性步骤：

1. 递归解析 `parent` 与 `#texture` 别名；
2. 把 `elements.from/to` 转换为 Bedrock entity cube 的 `origin/size`；
3. 保留逐面 UV、翻转、90/180/270 度 `uv_rotation` 和未声明面；
4. 把目标模型的 `rotation.origin/axis/angle` 转换为独立 bone 的 `pivot/rotation`，并
   按旋转轴与角度把 Java `rescale: true` 预缩放烘焙到 cube 尺寸；`cross.json` 的 45 度
   rescale 已由生成测试校验；
5. 应用蜂巢、可可豆、藤蔓和嘎吱之心的原版 blockstate 朝向；相同旋转的 element 共用
   bone，无旋转 element 直接合并到槽骨骼，使所有 geometry 保持在 256 bones 内；
6. 按最终纹理路径拆分 geometry 层，每层由一个 render controller 直接引用对应的
   原版 `textures/blocks/...`，沿用 [SC-GEO] 的原木端面/侧面分层方法。

[MS-GEO] 记录 cube、bone、pivot、rotation 和逐面 UV；[ET-ZERO-GEO] 展示实体 geometry
中的零厚度 cube，[ET-UV-ROT] 展示逐面 `uv_rotation`。因此藤蔓、cross 植物面和胎生苗
模型不需要生成替代贴图。转换算法为 `组合可行`，必须经过附件模型像素对照原型，
但不再缺少输入资料或渲染原语。

当前 `CapturedTreeBlock.states` 已由 [CURRENT-TREE-BLOCKS] 调用
`BlockPermutation.getAllStates()` 完整捕获；`createTreeAssemblyVisual()` 在创建装配体
块时生成一个 0-15 的 renderer-owned `visualState`：蜂巢
编码朝向和是否满蜜，可可豆编码朝向和年龄，藤蔓编码四面 mask，胎生苗编码生长阶段，
垂苔编码 tip，嘎吱之心编码轴向与活动状态。当前各类型组合均不超过 16；它只进入
渲染描述符和 fragment 的 4-bit `state`，不参与逻辑方块判定、质量、碰撞、破碎或
掉落。若恢复所需的当前存档数据不足以重建某一视觉状态，该状态不得注册为 fragment，
而不是修改玩法存档语义来迁就渲染器。

## 运行时接入

### 创建

1. `PhysicsDimension.createAssembly()` 继续先创建一个无视觉 Cannon body。
2. 只读的 `AssemblyVisualRegistry` 在生成任何实体前检查整棵装配体。
3. 注册完整的原版树交给 `AssemblyFragmentRenderer` 装箱；否则把相同输入原样交给
   未修改的旧逐方块渲染器。
4. 每个 fragment 生成一个零碰撞、无重力显示实体，并设置
   family/layout/tint、结构字和整体姿态属性。
5. 建立 renderer-owned 的 `local block key -> fragment/slot` 与
   `entity id -> assembly` 索引；现有逻辑方块 Map 保持不变。

[VT-BP] 直接提供零碰撞、无重力、不可推动、持久化 fragment 实体定义；
[MS-DIM] 记录 `Dimension.spawnEntity()`，[MS-ENTITY] 记录传送和设置属性，当前
[CURRENT-PHYSICS] 则提供三者在本项目中的既有接线。

### 每物理步同步

每个 fragment 只同步一个实体锚点以及整体 `pitch/yaw/roll`。锚点仍沿装配体局部
`+Y` 抬升一格，fragment 内局部坐标抵消这一格，保持当前光照采样修复语义。

- [MS-ENTITY] 记录 `Entity.teleport()` 与 `Entity.setRotation()`。
- [CURRENT-PHYSICS] 已用 `body.localPointToWorld()`、`Entity.teleport()` 和三个
  同步属性驱动当前显示实体。
- [CURRENT-RP-ANIM] 已用三个姿态属性驱动 root/yaw/roll/pitch 骨骼链。

这一项是已注册原版树路径的实体数量收敛，不引入新的平台能力，状态为 `已直接证明`。
旧渲染路径继续执行当前逐实体同步代码，不作修改。

### 方块破碎

`removeBlocksAtLocalLocations()` 仍先更新逻辑方块、质量、质心、浮力点和 collider。
渲染层随后定位槽位并修改对应属性字；fragment 全空时才删除实体。

- [MS-ENTITY] 明确说明 `setProperty()` 可在脚本更新属性。
- [MS-EP] 保证更新后的同步属性可由客户端 `query.property()` 读取。
- [CURRENT-REMOVE] 已在批量移除后重建质量属性和 collider。

由于 `setProperty()` 官方规定属性变更到下一 tick 才应用，破碎槽位的视觉隐藏可能比
逻辑破碎晚最多一 tick。该行为已由项目方接受，不再是阻塞项。

### 射线、左键与右键

显示实体 ID 只用于 O(1) 定位装配体，不用于判断具体方块。具体命中继续调用
`PhysicsAssembly.raycast()` 对旋转后的逻辑单位块求最近交点。因此一个 fragment
代表多个方块不会损失命中精度。

[CURRENT-RAYCAST] 和 [CURRENT-INTERACTION] 是已经通过测试与肉眼验收的直接依据，
状态为 `已直接证明`。

### 伤害、掉落与断连破碎

这些系统继续只处理逻辑方块，不增加 fragment 专用玩法分支：

- 实体伤害按动态原木位置和点速度计算；
- 叶片/附着物断连算法返回局部方块坐标批次；
- 最终掉落使用保存的方块快照；
- 新 fragment 和旧显示实体统一通过渲染器索引/既有显示实体标识排除。

[CURRENT-LIFECYCLE] 已证明这些功能不依赖“一方块一实体”。渲染适配器只提供等价的
实体集合、索引和清理接口，玩法算法本身不改。状态为 `内部重构`，不需要新的基岩能力。

### 重载和跨域

装配体存档继续保存逻辑方块、姿态和速度。恢复时由逻辑方块重新运行确定性的布局
装箱并生成 fragment；旧 `visualEntityIds` 只用于清理遗留实体，不作为结构真相。

- [MS-EP] 证明属性本身持久化且可同步给重新加载实体的客户端。
- [CURRENT-LIFECYCLE] 已实现旧显示实体清理和按逻辑方块重建装配体。

即使选择总是重建 fragment 而不复用旧实体，属性可靠性也不会低于当前恢复路径。

## 实施阶段与内部门槛

阶段 0 至阶段 4 的结构、编码、恢复、回归和性能门槛均已自动完成；阶段 5 保留唯一一次
最终基岩版人工验收，用于验证客户端属性同步和实际像素表现。

### 阶段 0：属性位图最小原型

只创建独立测试实体，不接入树木玩法：

1. 声明一个 `client_sync` int 属性字，范围 `[0, 16777215]`。
2. 用 24 个固定槽位分别读取这个字的一位。
3. 脚本依次写入单 bit、交错 bit、全 bit 和清零。
4. 验证首次生成、属性变更、退出重进、后来进入视距和区块卸载/加载。
5. 再用二位状态验证原木空/Y/X/Z 和端面/侧面纹理。
6. 用客户端 Molang 完成 24-bit palette RGB 与 4-bit 逐槽索引解码。
7. 从 `BlockMapColorComponent.color/tintedColor` 计算位置 tint，并验证缺失/非法数据回退。
8. 验证 8 色 palette、108 个槽位及第 9 种颜色后的确定性分片。
9. 验证结构、颜色和姿态均只依赖 `client_sync` 实体属性，不依赖 `playAnimation` 传值。

通过条件：没有脚本重播时，客户端始终从同步属性恢复正确槽位。失败则停止后续实现，
记录平台行为并重新评估传输方案。

### 阶段 1：资源生成器

构建脚本已经从结构化目录生成：

- BP fragment 实体及 32 个属性定义；
- RP client entity；
- 固定槽位和动态细节 geometry；
- animation 与 render controller；
- 原版纹理路径目录；
- BlockMap 位置 tint 的 8 色 RGB palette、4-bit 槽位索引与客户端属性解码；
- `vanilla-block-model` 到分层 entity geometry 的附件模型转换器；
- TypeScript 属性布局常量。

生成输出必须能被 JSON 解析，并由测试校验属性数量、范围、槽位不重复、纹理索引和
TypeScript/RP 常量一致。手写数百个重复 controller 不属于计划。

### 阶段 2：装箱器

已实现原版注册表、整装配体旧渲染回退和通用确定性 tile 装箱。它不识别具体 Feature，
对普通、宽树冠、高树干、高针叶树冠和水平倒木使用相同算法。离线测试输出：

- 总方块数；
- fragment 数；
- 每个 fragment 槽位使用率；
- 未覆盖方块数，必须恒为 0。
- 任意未注册类型/状态必须选择整个旧渲染器，fragment 数必须为 0。

布局优化不得进入 `tree-selection.ts`，也不得成为树木识别条件。

### 阶段 3：渲染适配层接入

在 `PhysicsAssembly` 外观边界后接入两种 renderer，实现相同的创建、同步、方块隐藏、
实体反向索引和清理接口。逻辑方块 Map、raycast、collider 及所有玩法调用
顺序保持原样。旧渲染器永久保留且不改；最终发布时，注册原版树选择 fragment，含任意
未注册方块的装配体选择旧渲染器，同一装配体永不同时运行两套渲染器。

### 阶段 4：渲染生命周期适配

依次验证：批量破碎后的槽位隐藏、附件外观、最终结算时的实体清理、重载后的视觉重建、
跨域结算时的实体清理。伤害、断连叶片、掉落和结算算法只
作为不变性回归测试，不为 fragment 增加新逻辑。

### 阶段 5：唯一最终验收

至少覆盖：普通/华丽橡树、白桦/高白桦、普通/巨型云杉、松树、丛林/巨型丛林、
金合欢、深色橡树、沼泽树、红树/高红树、樱花、杜鹃、苍白橡树和五种倒木。

先在相同设备、相同世界快照和相同脚本配置下记录改动前基线，再记录 fragment 版本
1/5/10 棵树下的：

- fragment 实体数与旧实体数；
- 每物理步 teleport/transform/property 写入数；
- 装配体创建时间、属性写入数和批量叶片破碎渲染更新时间；
- 生命周期实体查询候选数；
- 脚本总步进和物理 P50/P95/P99；
- 旧回退路径的输出与性能，必须与改动前一致。

2026-07-16 基准中，123 方块标准树由 123 个实体降为 9 个。fragment/旧路径的活动
1 棵为 `0.2816/0.2894 ms`，活动 10 棵为 `3.3016/3.4618 ms`，休眠 10 棵为
`0.1524/0.1560 ms`，持续物理阶段分别约快 `2.7%`、`4.6%`、`2.3%`。纯 JS 创建微基准为
`1.2861/1.1967 ms`；该基准把 `spawnEntity()` 与 `setProperty()` 实现为空函数，故只计
fragment 装箱成本而完全忽略少生成 114 个真实基岩实体的主要收益，不能单独代表实机
创建性能。发布门槛仍为：注册原版树实体数与 transform
写入数不高于基线，且目标场景应显著下降；
装配体创建、脚本总步进和物理 P50/P95/P99 不得出现可重复的回归；物理结果和玩法事件
序列必须一致。测量噪声不能用于掩盖明确退化。全部自动门槛通过后，再进行一次最终肉眼
验收；未通过则继续在开发阶段修正，不把中间版本交付验收。

## 资料审查结论与原型门槛

| ID | 结论 | 实施约束 |
| --- | --- | --- |
| `B1 已解除` | `BlockMapColorComponent` 直接提供原方块位置的基础色和 tintedColor，属性 RGB 与 render-controller overlay_color 已接通 | BlockMap 是原版目标的权威来源；不承诺读取第三方客户端资源包覆盖后的 colormap |
| `B2 已解除` | 已有完整附件模型、父模型、逐面 UV/旋转及零厚度实体 geometry sample | 转换器输出必须通过模型逐状态像素对照 |
| `B3 已接受` | 项目方接受 `setProperty()` 导致破碎视觉最多晚一 tick | 不新增即时隐藏的备用实体或 Molang 重播路径 |
| `P1` | 24-bit 属性位段是多个已证明原语的组合 | 阶段 0 必须实机验证首次显示、更新、重进和区块重载 |
| `P2` | Java 风格原版方块模型到 Bedrock entity geometry 的转换是内部算法 | 必须覆盖父模型、贴图分层、零厚度面、element rotation/rescale 与 UV rotation |
| `P3 已收敛` | BlockMap tint 在捕获时读取一次并持久化；客户端 Molang 只解码同步属性 | 不实现 climate/colormap 复刻、邻域 `getBiome()` 或物理 tick 取色；非法数据回退树种常量 |
| `P4` | 旧逐方块渲染器是未注册装配体的永久兼容路径 | 旧函数与 BP/RP 资源保持原样；整装配体择一，不实现混合回退；已注册原版树最终只走 fragment |

当前没有需要继续补充资料的技术阻塞。阶段 0/1 原型失败时，应记录失败的具体平台原语，
不得退回周期性 Molang 数据注入作为默认方案，也不得通过改变物理或玩法语义绕过失败。

## 资料索引

### 微软文档

- **[MS-EP]** [Introduction to Entity Properties](https://learn.microsoft.com/en-us/minecraft/creator/documents/introductiontoentityproperties?view=minecraft-bedrock-stable)：持久化、`client_sync`、`query.property`、32 属性限制和大整数精度。
- **[MS-ENTITY]** [minecraft/server.Entity Class](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/entity?view=minecraft-bedrock-stable)：`setProperty`、`setRotation`、`teleport`、`remove`。
- **[MS-QP]** [Molang query.property](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/molangreference/examples/molangconcepts/queryfunctions/query_property?view=minecraft-bedrock-stable)。
- **[MS-FLOOR]** [Molang math.floor](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/molangreference/examples/molangconcepts/mathfunctions/math_floor?view=minecraft-bedrock-stable)。
- **[MS-MOD]** [Molang math.mod](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/molangreference/examples/molangconcepts/mathfunctions/math_mod?view=minecraft-bedrock-stable)。
- **[MS-RC]** [Animation Documentation - Render Controllers](https://learn.microsoft.com/en-us/minecraft/creator/documents/animations/animationrendercontroller?view=minecraft-bedrock-stable)：geometry/material/texture 数组、part visibility 和 color。
- **[MS-GEO]** [Geometry v1.14.0](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/visualreference/geometry.v1.14.0?view=minecraft-bedrock-stable)：bone、cube、origin、pivot、parent、rotation 和 UV 结构。
- **[MS-ADD-ENTITY]** [Creating New Entity Types](https://learn.microsoft.com/en-us/minecraft/creator/documents/introductiontoaddentity?view=minecraft-bedrock-stable)：客户端实体、动画和 render controller 接线。
- **[MS-MODEL]** [Entity Modeling and Animation](https://learn.microsoft.com/en-us/minecraft/creator/documents/entitymodelingandanimation?view=minecraft-bedrock-stable)：bone 层级、cube、纹理与动画。
- **[MS-CLIENT]** [Client Entity JSON and Introduction](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/entityreference/examples/cliententitydocumentation/cliententitydocumentationintroduction?view=minecraft-bedrock-stable)。
- **[MS-DIM]** [minecraft/server.Dimension Class](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/dimension?view=minecraft-bedrock-stable)：`spawnEntity` 与 `getBiome`。
- **[MS-BIOME-Q]** [Molang query.entity_biome_has_any_identifier](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/molangreference/examples/molangconcepts/queryfunctions/query_entity_biome_has_any_identifier?view=minecraft-bedrock-stable)：客户端实体按当前位置判断 biome ID 的备选验证手段。
- **[MS-MATERIALS]** [Introduction to Materials](https://learn.microsoft.com/en-us/minecraft/creator/documents/material-files?view=minecraft-bedrock-stable)：材质继承、shader define 与优先复用原版实体材质。
- **[MS-MAP-COLOR]** [BlockMapColorComponent Class](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/blockmapcolorcomponent?view=minecraft-bedrock-stable)：基础地图色、给定位置计算后的 `tintedColor` 与 `tintMethod`。

### 外部开发资料

- **[BW-ATLAS]** [Bedrock Wiki - Texture Atlases / Tint Color](https://wiki.bedrock.dev/concepts/texture-atlases#tint-color)：`tint_color` 与 `overlay_color` 的 terrain-atlas 乘色规则。
- **[BW-BLOCK-TINT]** [Bedrock Wiki - Block Tinting](https://wiki.bedrock.dev/blocks/block-tinting#texture-tinting)：方块 `tint_method`、原版 tint 类型和 client-biome/colormap 修改入口。
- **[BW-MATERIALS]** [Bedrock Wiki - Materials](https://wiki.bedrock.dev/documentation/materials.html#entity-alphatest-multicolor-tint)：原版实体材质目录；该页将部分 multicolor 材质行为标为未知，因此只作边界证据。
- **[MC163-MATERIALS]** [网易基岩开发手册 - 材质配置说明](https://mc.163.com/dev/mcmanual/mc-dev/mcguide/16-%E7%BE%8E%E6%9C%AF/7-%E6%9D%90%E8%B4%A8%E4%B8%8E%E7%9D%80%E8%89%B2%E5%99%A8/3-%E6%9D%90%E8%B4%A8%E9%85%8D%E7%BD%AE%E8%AF%B4%E6%98%8E.html)：材质继承、states、defines 与 shader 宏说明。
- **[JAVA-OPTIFINE]** [OptiDocs - Colormaps](https://optifine.readthedocs.io/colormaps.html)：温度、湿度、高度与 colormap 的 Java 版原理背景，不作为基岩 API 证据。
- **[JAVA-POLYTONE]** [Polytone](https://modrinth.com/mod/polytone)：Java 版自定义 biome/block/particle colormap 背景，不作为基岩 API 证据。
- **[MC-WIKI-TEMP]** [Minecraft Wiki - Biome / Temperature](https://minecraft.wiki/w/Biome#Temperature)：Java 温度、高度与坐标噪声背景；只用于生成待实机排除或确认的候选公式。
- **[MOJANG-CLIMATE]** [Mojang bedrock-samples / behavior_pack/biomes](https://github.com/Mojang/bedrock-samples/tree/main/behavior_pack/biomes)：原版 biome 的 `minecraft:climate.temperature/downfall`。
- **[MOJANG-CLIENT-BIOMES]** [Mojang bedrock-samples / resource_pack/biomes](https://github.com/Mojang/bedrock-samples/tree/main/resource_pack/biomes)：显式 foliage RGB 与 swamp/mangrove 等 colormap override。
- **[MOJANG-COLORMAPS]** [Mojang bedrock-samples / textures/colormap](https://github.com/Mojang/bedrock-samples/tree/main/resource_pack/textures/colormap)：官方 foliage、birch、evergreen、swamp 和 mangrove PNG。
- **[MOJANG-FOLIAGE-SCHEMA]** [Foliage Appearance Client Biome Component](https://github.com/Mojang/bedrock-samples/blob/main/metadata/json_schemas/client/biome/1.21.70/Foliage%20Appearance%20Client%20Biome%20Component.json)：`color` 和六种合法 foliage colormap 的官方 schema。

### 本地 sample

- **[SC-BP]** `sample/平滑工艺附加包/BP/entities/log_anim.json`：同步 offset/rotation 属性和零碰撞实体。
- **[SC-SCRIPT]** `sample/平滑工艺附加包/BP/scripts/main.js` 第 179-197 行：生成实体、写属性和选择方块类型。
- **[SC-CLIENT]** `sample/平滑工艺附加包/RP/entity/log_anim.json`：直接原版纹理路径、多个 geometry/controller 和树叶材质。
- **[SC-RC]** `sample/平滑工艺附加包/RP/render_controllers/log.json`：原木端面/侧面、纹理数组和 color。
- **[SC-GEO]** `sample/平滑工艺附加包/RP/models/entity/treelog.geo.json`：分离的端面、侧面与树叶 cube geometry。
- **[SC-ANIM]** `sample/平滑工艺附加包/RP/animations/treelog.animation.json`：`query.property` 驱动局部位置。
- **[VT-SIMPLE]** `sample/VanillaTrain/src/TrainBP/scripts/lib/TrainSimpleFragments.js`：256 槽实体数据模型。
- **[VT-BP]** `sample/VanillaTrain/src/TrainBP/entities/simple_fragment.json`：零碰撞、无重力、不可推动、持久化 fragment。
- **[VT-CLIENT]** `sample/VanillaTrain/src/TrainRP/entity/simple_fragment.entity.json`：大量 geometry、animation 和 render controller 接线。
- **[VT-GEO]** `sample/VanillaTrain/src/TrainRP/models/entity/simple_fragment.geo.json`：逐槽 geometry。
- **[VT-ANIM]** `sample/VanillaTrain/tools/template/build/RP/animations/train_fragment.animation.json`：逐槽 position/rotation/scale。
- **[VT-RC]** `sample/VanillaTrain/tools/template/build/RP/render_controllers/train_simple_fragment.render_controllers.json`：geometry/material 数组与 `Math.floor`/`Math.mod`。
- **[ET-MATERIAL]** `sample/entity-tint/action&stuff/materials/entity.material`：热带鱼实体材质中的 `MULTIPLICATIVE_TINT`、`MULTIPLICATIVE_TINT_COLOR`、双 sampler 和 overlay define。
- **[ET-TROPICAL]** `sample/entity-tint/action&stuff/entity/dvb.json` 与 `sample/entity-tint/action&stuff/render_controllers/93ce0b36.json` 中的 `controller.render.oreville_ans.toxsfh`：双纹理 `entity_multitexture_multiplicative_cull` 实际接线。
- **[ET-PARTICLE]** `sample/entity-tint/action&stuff/particles/ego.json` 与 `emp.json`：`atlas.terrain`、显式 UV、`particle_appearance_tinting` 和显式 RGBA 输入。
- **[ET-BIOMES]** `sample/entity-tint/action&stuff/subpacks/SP2/biomes/*.json`：87 个 `minecraft:client_biome` 与明确的 `minecraft:foliage_appearance.color`。
- **[ET-COLORMAPS]** `sample/entity-tint/action&stuff/subpacks/SP2/textures/colormap/`：foliage、birch、evergreen、swamp 与 mangrove 的 256 x 256 colormap。
- **[ET-ZERO-GEO]** `sample/entity-tint/action&stuff/models/entity/imv.json` 与 `imt.json`：某一轴 `size` 为 0 的实体 cube/平面。
- **[ET-UV-ROT]** `sample/entity-tint/action&stuff/models/entity/iko.json`：逐面 `uv_rotation: 90` 和带正负 `uv_size` 的实体 geometry。
- **[VBM-PARENTS]** `sample/vanilla-block-model/cross.json`、`cube.json`、`cube_column.json`、`cube_column_horizontal.json` 与 `orientable_with_bottom.json`：附件模型父链。
- **[VBM-ATTACHMENTS]** `sample/vanilla-block-model/bee_nest_*.json`、`beehive_*.json`、`cocoa_stage*.json`、`vine.json`、`mangrove_propagule_hanging_*.json`、`hanging_roots.json`、`pale_hanging_moss*.json` 与 `creaking_heart*.json`：全部目标附件状态模型。
- **[TT]** `sample/custom-block-sample/RP/textures/terrain_texture.json`：当前原版方块纹理路径表。
- **[VF-OAK]** `sample/vanilla-feature/features/oak_tree_feature.json`。
- **[VF-BIRCH]** `sample/vanilla-feature/features/birch_tree_feature.json`。
- **[VF-JUNGLE]** `sample/vanilla-feature/features/jungle_tree_feature.json`。
- **[VF-FANCY]** `sample/vanilla-feature/features/fancy_oak_tree_feature.json`。
- **[VF-CHERRY]** `sample/vanilla-feature/features/cherry_tree_feature.json`。
- **[VF-MEGA-SPRUCE]** `sample/vanilla-feature/features/mega_spruce_tree_feature.json`。
- **[VF-MEGA-JUNGLE]** `sample/vanilla-feature/features/mega_jungle_tree_feature.json`。

### 当前项目

- **[CURRENT-PHYSICS]** `src/physics.ts`：当前装配体、逐块视觉、反向索引、同步和精确射线。
- **[CURRENT-REMOVE]** `src/physics.ts` 的 `removeBlocksAtLocalLocations()`：批量逻辑移除和质量/collider 重建。
- **[CURRENT-RAYCAST]** `src/physics.ts` 的 `PhysicsAssembly.raycast()`。
- **[CURRENT-INTERACTION]** `src/gameplay/tree-player-interaction.ts`：逻辑装配体射线、左键和牵引。
- **[CURRENT-LIFECYCLE]** `src/gameplay/fallen-tree-lifecycle.ts`：破碎、伤害、掉落、持久化和恢复。
- **[CURRENT-RP-ANIM]** `packs/TreePhysics/RP/animations/physics_block.animation.json`：当前整体及局部旋转链。
- **[CURRENT-TREE-BLOCKS]** `src/tree/blocks.ts` 的 `capturePermutation()`：通过 `BlockPermutation.getAllStates()` 保存树木方块状态。
