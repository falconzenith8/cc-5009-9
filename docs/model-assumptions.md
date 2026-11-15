# 蜡质散射 · 模型假设与参数契约

本文件是蜡艺散射内核的**模型假设契约**：每个参数的单位、默认值、取值范围与近似适用区
以表格登记，并由工具自动核对——

- `npm run contract`：静态核对本文件 ↔ `src/state.js`（PARAM_SCHEMA）↔ `src/renderer.js`
  （内核常量与 uniform 初值）↔ `index.html`（控件挂载点）。**代码中参数改名、改默认值、
  改近似区间而不同步本表，校验即失败并指出不一致处。**
- `npm run assumptions`：动态实测（厚度响应、参数单位的执行证据）并重新生成本文引用的
  全部截面图与示例图（需要先启动界面，见下节）。
- `npm run verify`：既有完整回归流程（参考对比、门控、尺度/分辨率不变性、存档）。

## 界面启动

```bash
npm install                 # 安装依赖
npm run dev                 # 启动开发服务器（端口 4173）
# 浏览器打开 http://localhost:4173/ —— 左侧画布即材质预览窗口，
# 拖动旋转蜡件、滚轮缩放，右侧「散射工作台」实时调节散射参数。

npm run build && npm run preview   # 生产构建后以同样端口预览
```

维护脚本（contract/assumptions/verify）需要无头浏览器：

```bash
npx playwright install chromium   # 首次运行前执行一次
npm run dev                       # 脚本假定界面已在 http://localhost:4173/ 运行
```

新环境复现顺序：`npm install` → `npx playwright install chromium` → `npm run dev`
→ 另一终端 `npm run contract && npm run assumptions && npm run verify`。

## 参数契约表

单位约定：散射距离与厚度一律以**毫米（mm）**登记；内核按 `WORLD_PER_MM` 换算到世界单位，
再按像素/世界单位投影到屏幕。颜色（蜡材反照率）为 sRGB 十六进制，入内核前转线性。
「范围」列为 `最小..最大`；布尔为 `true/false`；枚举列出全部取值。

| 参数 | 单位 | 默认 | 范围 | 近似适用区 / 说明 |
| --- | --- | --- | --- | --- |
| scatterOn | — | true | true/false | 总开关；关闭时合成严格退化为表面直接光照，A/B 对照诚实 |
| distanceMm | mm | 3.4 | 0.5..20 | 平均自由程。光学厚度 = 厚度mm ÷ distanceMm；屏幕核半径随其线性增长 |
| strength | 无量纲 | 0.85 | 0..1 | 直接漫反射被扩散传输替换的权重；总能量近似守恒 |
| thicknessResponse | 无量纲 | 0.72 | 0..1 | 厚度响应强度。0 = 不响应（等效均匀介质）；1 = 满响应：薄处增亮转暖、厚处乳浊 |
| maxThicknessMm | mm | 30 | 4..80 | 视线厚度估计的钳制上限；超过的厚核按上限参与光学厚度 |
| thinBoost | 无量纲 | 0.55 | 0..1.5 | 薄壳区域核半径增益；仅作用于光学厚度过渡带（见 THIN_BAND_OPTICAL） |
| quality | — | med | low/med/high | 每轴单向 tap 数 8/16/32，对应 17/33/65 采样/轴 |
| objectGate | — | true | true/false | 物体身份硬门控；关闭可观察跨物体渗色（诊断用） |
| depthTol | 无量纲 | 0.42 | 0..1.5 | 深度断层容差系数：世界容差 = σ × (0.3 + 1.9 × depthTol) |
| normalTol | 无量纲 | 0.82 | 0.4..0.99 | 法线一致性门限；曲面内部刻意宽松，轮廓由身份+深度门控处理 |
| modelScale | × | 1 | 0.45..2.2 | 整体缩放；缩放 1 时 1 世界单位 = 10 mm，物理观感不随缩放改变 |
| exposure | × | 1 | 0.3..2.4 | 曝光，ACES 前乘子 |
| resolutionScale | × | 1 | 0.5..1.75 | 渲染分辨率比例；核在世界空间定义，改分辨率不改变表观厚度 |
| channel | — | final | final/surface/diffuse/specular/scatter/normalShade/albedo/normal/depth/thickness/mask/objectid | 调试通道 |
| preset | — | pale | pale/amber/rose/ivory | 蜡材样本（反照率 sRGB + 粗糙度） |

## 内核常量

| 常量 | 值 | 含义 |
| --- | --- | --- |
| WORLD_PER_MM | 0.1 | 模型缩放 1 时 1 世界单位 = 10 mm；毫米参数与渲染之间的桥 |
| RADIUS_SCALE | 1.8 | 核半径 = 1.8 × σ（实时与参考路径一致） |
| TAPS_PER_AXIS | 8/16/32 | low/med/high 每轴单向 tap 数 |
| SAMPLES_PER_AXIS | 17/33/65 | 每轴总采样数 = 2 × tap + 1（与界面质量选项文案一致） |
| THIN_BAND_OPTICAL | 0.25..2.5 | 薄壳过渡带（光学厚度）：带内 thin 从 1 平滑过渡到 0 |
| PROFILE_1D | 0.72/0.28@3.2 | 实时可分离剖面：0.72·e^(−r/σ) + 0.28·e^(−r/(3.2σ)) |
| PROFILE_2D | 0.7/0.3@3.4 | 参考二维剖面：(0.7·e^(−r/σ) + 0.3·e^(−r/(3.4σ))) / (1 + r/σ) |

## 模型假设（近似边界）

1. **可见表面近似**：只采集相机可见表面的辐照度。背向表面的入射光、经体内多次
   散射后从前表面出射的传输、被遮挡区域间的互散射均不表达。薄片背光视角下不会
   出现真实透光辉光（见失效样例 05）。
2. **厚度估计**：厚度 = 同一物体最近背面深度 − 前表面深度（视线方向），物体 id
   随背面深度一同记录，不可跨物体借用。凹壳/重叠壳会低估真实路径长度；估计值
   钳制于 `maxThicknessMm`（失效样例 06）。
3. **薄壳响应**：光学厚度（厚度mm ÷ distanceMm）落入 0.25..2.5 过渡带时，发射
   能量增亮转暖、核半径获得 thinBoost 增益；带外（厚核）能量压暗至 0.74 呈乳浊。
   响应对照样例见 01–04（薄边 vs 厚块）。
4. **可分离核近似**：实时路径用两个 1D 轴向内积逼近参考的 2D 径向核（剖面见
   PROFILE_1D / PROFILE_2D）。两者共享源、门控与厚度响应；差异以 MAE/PSNR 在
   界面「生成高质量参考」中量化。
5. **轮廓能量衰减**：归一化只除以被接受的权重——平坦区域能量严格守恒，轮廓/
   断层处能量自然衰减而非重新归一到满强度（失效样例 07）。
6. **参考路径仍为可见表面方法**：高质量参考不引入背向表面传输，只是更密的
   二维采样；它是近似的度量基准，不是物理真值。

## 近似失效样例（由 `npm run assumptions` 再生成）

| 文件 | 内容 |
| --- | --- |
| ../shots/assumptions/01-contrast-final.png | 默认视角最终合成：薄边（耳片）与厚块（圆柱）对照 |
| ../shots/assumptions/02-contrast-thickness.png | 厚度通道（mm）：薄边 ≈1–3 mm，厚块核心 ≈8–10 mm |
| ../shots/assumptions/03-contrast-scatter.png | 扩散光照通道：薄边暖亮、厚块乳浊 |
| ../shots/assumptions/04-section.svg | 截面图：沿扫描线的厚度(mm)与发射亮度，标注过渡带与钳制线 |
| ../shots/assumptions/05-backlit-failure.png | 失效·背光视角：可见表面近似不含透射，薄片背光不发光 |
| ../shots/assumptions/06-clamp-failure.png | 失效·厚度钳制：maxThicknessMm=8 时厚核厚度被截为平台 |
| ../shots/assumptions/07-silhouette-fade.png | 失效·轮廓衰减：剪影边缘扩散能量自然变暗 |

## 维护入口与样例一致性

| 命令 | 作用 | 产出 |
| --- | --- | --- |
| `npm run contract` | 静态契约核对（本表 ↔ 代码 ↔ 界面挂载点） | 终端报告，非零退出即失败 |
| `npm run assumptions` | 动态实测 + 再生上表全部样例图 | shots/contract/evidence.json、shots/assumptions/* |
| `npm run verify` | 既有完整回归流程 | shots/verify/report.json 与截图 |

`npm run assumptions` 生成的证据文件把每条契约声明映射到实测数值（厚度响应曲线、
毫米单位与像素半径的线性比、厚度通道的中位毫米数），全部探针使用**非默认值**驱动，
默认值伪装（内核忽略参数仍输出合理画面）无法通过校验。
