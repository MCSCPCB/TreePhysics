# 树叶与藤蔓 Colormap Fragment 渲染

## 状态

- 状态：已实现，待最终游戏内群系边界验收。
- 范围：只改变已注册原版树的 fragment 渲染数据；物理、树木识别、破碎、掉落、交互和
  旧逐方块兜底渲染器不变。
- 冻结语义：树木创建时确定颜色场，倒伏、移动和休眠时不更新；跨加载域恢复继续使用保存
  的颜色场。

本文取代 `tree-performance-fragment-convergence-plan.md` 中固定 `#80A755`、
`alpha_block_color_tint` 和负 alpha `overlay_color` 方案，也取代更早的 BlockMap RGB palette
方案。正式实现不读取 `minecraft:map_color`，不保存逐方块 RGB，不使用 `playAnimation`。

## 渲染结构

树叶与藤蔓使用两个顺序固定的 render pass：

1. 基础 pass 使用原方块纹理和原版 `alpha_block_color`，负责纹理图案、透明测试、深度和
   原版实体方块材质特性。
2. colormap pass 使用相同表面、`depthFunc: Equal`、`blendSrc: DestColor`、
   `blendDst: Zero`。它只在基础 pass 已写入深度的叶片像素上绘制，并把 colormap 颜色与
   基础纹理相乘。

自定义材质 `foliage_colormap_multiply:alpha_block_color` 直接继承 `alpha_block_color`。
组合行为已通过项目内最小原型实机验证：色图渐变可见、底纹保留、透明孔洞不被填充。

使用的原版 colormap 纹理与一个固定色 palette：

| 编号 | 路径 | 用途 |
| --- | --- | --- |
| 1 | `textures/colormap/foliage` | 普通 oak/jungle/acacia/dark oak/mangrove 和 vine |
| 2 | `textures/colormap/swamp_foliage` | swamp override |
| 3 | `textures/colormap/mangrove_swamp_foliage` | mangrove swamp override |
| 4 | `textures/colormap/birch` | birch leaves |
| 5 | `textures/colormap/evergreen` | spruce leaves |
| 6 | `textures/colormap/foliage_fixed` | cherry grove `#B6DB61`、pale garden `#878D76` |

Cherry、pale oak、azalea 和 flowering azalea 纹理不使用 foliage tint，因此其 colormap pass
保持不可见。

编号 6 是本包生成的 `8 x 2` TGA palette，而非对原版 foliage colormap 的修改。它只用于
会被原版 foliage tint 的树叶与藤蔓在固定色群系中的颜色；cherry 与 pale oak 树叶自身仍不
进入该 pass。

## 权威数据

`scripts/generators/biome-foliage.mjs` 使用 Cheerio 解析用户提供的离线
`sample/entity-tint/Biome - Minecraft Wiki.html` 中
`Climates of biomes in Overworld` 表格。生成器：

- 正确展开 HTML `rowspan/colspan`；
- 同一单元格同时包含 Java/Bedrock 数值时明确选择 `BE only`；
- 将 `@minecraft/vanilla-data` 中的 Bedrock biome ID 映射到现代 Wiki 名称；
- 构建时若目标版本新增未映射的主世界 biome，直接失败而不是静默使用错误数值；
- 输出 `src/data/generated/biome-foliage.generated.ts`，运行时不包含 HTML 解析器。

温度/降水到 colormap UV 的转换为：

```text
temperature = clamp(baseTemperature, 0, 1)
rainfall = clamp(downfall, 0, 1) * temperature
u = 1 - temperature
v = 1 - rainfall
```

高度温度修正不参与 foliage colormap。未知 biome 或旧存档原始区块不可读时回退 plains
气候点；该回退仍从原版 colormap 取色，不保存自定义 RGB 常量。

原版 `minecraft:foliage_appearance.color` 规则中，cherry grove 与 pale garden 分别使用固定
色 `#B6DB61` 与 `#878D76`，不应套用温度/降水 UV。两者映射到 palette 内彼此隔离的色带。

## 稀疏采样与冻结

`captureTreeFoliageTint()` 只处理会被 tint 的树叶和藤蔓：

1. 取整棵树叶/藤蔓范围的中心与四个 XZ 角点；重合点去重，因此调用
   `Dimension.getBiome()` 的次数为 `1-5`。
2. 每个样本先归类为 default/swamp/mangrove 或某个具体 fixed palette。中心样本在最高票数
   的平局中优先；否则按样本顺序选取最高票来源。
3. 选中 fixed palette 时直接保存其常量 UV；选中普通色源时，只用同一色源的样本对 `u` 沿
   本地 X、`v` 沿本地 Z 分别做最小二乘线性拟合。固定色绝不会混入普通 colormap 拟合。
4. 拟合结果随 `SerializedFallenTree.foliageTint` 保存。重载不根据倒伏后的实体位置取色。

这是一阶矩形近似。它不能精确表达一个 fragment 内弯曲的 biome 边界，也不能在同一 pass
内混合两张特殊 colormap；这是此前明确接受的少实体、低服务端开销取舍。

## 实体属性编码

每个相关 fragment 只同步一个 `physics_api:tint` 整数：

| 位 | 内容 |
| --- | --- |
| `0..4` | `u0`，5-bit |
| `5..9` | `v0`，5-bit |
| `10..14` | `u1`，5-bit |
| `15..19` | `v1`，5-bit |
| `20..22` | 色源编号，`0` 表示不绘制，`6` 表示固定色 palette |

端点量化为 `0..31`；render controller 解码后除以 `31`，写入 `uv_anim.offset/scale`。
总值不超过 24-bit 实体属性安全范围。

colormap 材质必须启用 `USE_UV_ANIM`。仅在 render controller 中提供 `uv_anim` 不会自动
启用实体 shader 的 UV 变换；缺少该 define 时会直接使用 geometry 原始 UV，从而把整张
colormap 铺到整个 fragment。该约束由原版 `charged_creeper`、`conduit_wind`、
`player_animated` 等材质定义交叉确认。

- Leaf fragment：`7 x 5 x 7` 的 colormap geometry 把每个槽的 XZ 位置编码进共享 UV，整个
  fragment 只需要一个 colormap controller。
- Attachment fragment：槽内位置来自动态 descriptor，无法预写入 geometry。Vine 使用
  26 槽逐槽 controller 在客户端解码 X/Z 并计算 UV；仍只使用一个附件实体。
- Attachment 属性预算：3 个角度 + 2 个 fragment 原点 + 1 个 tint + 26 个 descriptor，
  恰好 32 个属性。

初始化后 tint 不再写入。物理 tick、姿态同步、破碎和休眠路径只处理原有数据。

## 技术依据

- [Microsoft Dimension.getBiome](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/dimension?view=minecraft-bedrock-stable#getbiome)：服务端按位置读取 biome。
- [Microsoft Entity Properties](https://learn.microsoft.com/en-us/minecraft/creator/documents/introductiontoentityproperties?view=minecraft-bedrock-stable)：持久化、`client_sync` 属性及每实体 32 属性边界。
- [Microsoft Render Controllers](https://learn.microsoft.com/en-us/minecraft/creator/documents/rendercontrollers?view=minecraft-bedrock-stable)：纹理数组、Molang、`part_visibility` 和 `uv_anim`。
- [Microsoft Material Files](https://learn.microsoft.com/en-us/minecraft/creator/documents/material-files?view=minecraft-bedrock-stable)：材质继承、深度状态和 blend factor。
- [Minecraft Wiki Biome Tint](https://minecraft.wiki/w/Biome#Tint)：colormap、基础温度/降水和特殊 foliage map。
- `sample/VanillaTrain/src/TrainRP/render_controllers/simple_fragment.render_controllers.json`：
  同一实体大量逐槽 controller 与 `uv_anim` 的本地可运行参考。
- 本项目 2026-07-18 最小实机原型：`Equal + DestColor/Zero + colormap` 组合验证。

## 验收边界

- 基础纹理、透明区域、模型朝向和所有非 tint 附着物必须与改动前一致。
- 树叶/藤蔓应在普通、swamp、mangrove swamp、cherry grove、pale garden 和群系边界显示
  可辨认的冻结颜色变化。
- Birch/spruce 使用各自 colormap；无 tint 家族不得被染绿。
- 倒伏后跨越 biome 不改变颜色；跨加载域恢复后颜色保持。
- 创建阶段最多 5 次 biome 查询；活动物理阶段为 0 次。
- 原木、树叶、附件 fragment 实体数量只受既有装箱影响，不能因颜色不同拆分。
