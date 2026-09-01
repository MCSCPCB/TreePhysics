# 树叶与藤蔓 Tint 实机测试记录与干净重建决策（2026-07-22）

## 用途

本文记录在本轮 fragment 树木渲染开发中已经得到实机结论的材质行为，以及下一次从干净
工作树重新实现时应采用和应避免的路径。它是决策记录，不是要求保留当前实验代码的说明。

在清理工作树前，应单独保留本文和 `docs/design/foliage-colormap.md`；当前的 probe、
双纹理材质和遮罩纹理均为一次性实验，不属于最终方案。

## 已实机确认的基础能力

### 1. 原版叶片纹理与单张 colormap 可正确组合

下列两 pass 是最终方案唯一需要保留的材质结构：

1. 基础 pass 使用原版方块纹理和 `alpha_block_color`。
2. tint pass 使用同一表面、`depthFunc: Equal`、`blendSrc: DestColor`、
   `blendDst: Zero`，从一张 colormap 采样并与基础叶片纹理相乘。

实机结论：

- 原叶片纹理的明暗细节保留；
- 透明孔洞不被 tint pass 填充；
- `USE_UV_ANIM` 是必要条件；缺失时会把整张色图铺到 fragment 上；
- `uv_anim` 的单像素/小区域取样可工作；
- `alpha_block_color` 的方块式视觉语义可保留。

这也是当前正式 `foliage_colormap_multiply:alpha_block_color` 的依据。

### 2. 固定色 palette 可正确表达特殊群系 tint

为 cherry grove 使用 `#B6DB61`、为 pale garden 使用 `#878D76` 的微小 palette，再复用
上述 tint pass，能够得到正确的“原叶片纹理 × 固定 tint”结果。固定色是 tint 系数，
不意味着每个最终像素都等于该纯色。

## 已测试且不进入最终方案的路径

| 路径 | 实机结论 | 不采用原因 |
| --- | --- | --- |
| `alpha_block_color` + render-controller `color` / `color.a` | 三个样本均被未染色叶片覆盖为白色。 | 该材质路径不会按所需方式消费 `color` 与 alpha，不能作为 tint 或连续混合源。 |
| `entity_alphatest_change_color` + 反色 `overlay_color` + 负 alpha | 能得到“原纹理 × 目标色”，透明细节保留。 | 依赖反色与负 alpha；负 alpha 不是应作为正式兼容契约依赖的语义。 |
| 在现有群系色后额外做 `DestColor × 固定目标色` | 色彩有朝目标色变化，但始终强烈受原群系色影响。 | 数学式是 `L × D × T`，期望是 `L × T`；该 pass 只能继续压暗，无法补亮，不能准确收敛。 |
| 为第三 pass 单独命名材质句柄 | 可见差异并非由该改动首次产生。 | 不能把独立句柄视为解决颜色准确度的结论；最终不需要第三 pass。 |
| `entity_multitexture_multiplicative_blend`（原版热带鱼双纹理路径） | 可把结果切换至目标 tint；但第二纹理 alpha 无法充当连续权重。`1/32`、`1/8`、`1/2`、`1` 四档从 B 到 E 无肉眼差异。 | 该路径对本项目表现为二值图案遮罩，而非可靠的线性插值；停止继续调参。 |
| 多权重 LUT/atlas | 理论上可预烘焙 `lerp(D,T,w)`，解决连续边界。 | 需要额外 atlas、权重采样、特殊属性打包与叶片/藤蔓双路径维护；收益仅覆盖跨群系边缘，复杂度不符合当前取舍。 |

记号：`L` 为原叶片纹理，`D` 为普通群系 colormap，`T` 为特殊群系固定 tint。
连续边界的理想式为 `L × lerp(D,T,w)`；固定第三乘法无法代替它。

## 最终取舍：接受整棵树的边界跳变

最终不追求同一棵树跨越 cherry grove / pale garden 与普通群系边界时的连续色彩渐变。

颜色在树木装配体创建时冻结：

1. 对整棵树中会 tint 的树叶与藤蔓，采样范围中心和四个 XZ 角点；重合点去重，因此最多
   `5` 次 `Dimension.getBiome()`。
2. 中心样本作为平局优先项，其余以多数决定整棵树使用普通 colormap 还是固定色 palette。
3. 选择固定色时，整棵树的相关 fragment 使用该特殊群系 palette；选择普通色时，整棵树使用
   原版 colormap 与现有的一阶 UV 拟合。
4. 结果随 fallen-tree 持久化；树倒伏、移动、休眠、重载和跨加载域恢复时不重新按当前位置取色。

结果是：

- 特殊群系内部颜色准确；
- 普通群系内部颜色准确；
- 跨边界树可能整棵选择固定色或普通色之一；
- 该误差是静态、局部、无物理和玩法影响的，不会闪烁；
- 不增加 fragment 实体数量、物理 tick 工作、持续 biome 查询或额外渲染 pass。

这是当前“性能优先、少实体优先，允许边界小误差”的明确决策。

## 干净重建的最小实现边界

重建时只实现以下内容：

1. 保留原版方块纹理路径，不生成预染色叶片或藤蔓纹理。
2. 保留一个基础 `alpha_block_color` pass 和一个 `foliage_colormap_multiply` tint pass。
3. 使用原版 `foliage`、`swamp_foliage`、`mangrove_swamp_foliage`、`birch`、`evergreen`
   colormap；使用极小自定义 palette 表达 cherry grove 与 pale garden 的固定色。
4. 每个相关 fragment 仅同步一个现有的 `physics_api:tint` 整数：四个 5-bit UV 端点和一个
   3-bit 色源编号。不要为渐变权重新增属性。
5. oak/jungle/acacia/dark oak/mangrove 和 vine 使用群系色源；spruce 与 birch 强制各自原版
   colormap；cherry、pale oak、azalea、flowering azalea 本身不进入 foliage tint pass。
6. 只在装配体创建和重载缺失旧数据时读取 biome；活动物理阶段为零额外 tint 工作。

明确不要带回：BlockMap RGB palette、逐方块 RGB、`playAnimation` 传值、反色/负 alpha
`overlay_color`、热带鱼双纹理材质、alpha mask、第三 tint pass、连续边界 LUT/atlas，以及
本轮 `tint_probe blend` 的实验资源。

## 可复用资料

- 稳定的两 pass、UV 打包、冻结与持久化设计：`docs/design/foliage-colormap.md`。
- 原版实体材质与热带鱼双纹理行为参考：
  `sample/entity-tint/vanilla.entity.material`。
- 供未来离线比对的 256×256 colormap 图：
  `sample/entity-tint/action&stuff/subpacks/SP2/textures/colormap/`。
- 群系气候与固定 foliage 规则的离线依据：
  `sample/entity-tint/Biome – Minecraft Wiki.html`。
