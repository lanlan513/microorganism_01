# 培养皿活体模拟（Petri Dish）

把静态馆藏变成可接种、可演替、可干预、可复现的活体生态。访问前端 `/petri`。

## 权威边界（最重要）

- **模拟权威只存在于服务端**：`api/src/petri/engine.ts` 是纯确定性 TypeScript 内核，
  不引用任何 DOM / `Math.random` / `Date`，只在服务端通过 `PetriRunManager` 推进。
- **浏览器只做两件事**：发送控制指令（暂停/加速/给药）、接收 SSE 快照并绘制。
  前端没有任何模拟计算，**改前端代码无法改变任何结果**。
- **每一步都在存档留痕**：`api/archives/<runId>/run.jsonl` 依次记录
  建舱（含种子、接种清单、接种哈希）→ 每次控制 → 每次给药 → 周期快照 → 终态生态指纹。
- 档案可一键重放复核：`GET /api/petri/archives/:runId/verify` 会从建舱记录重新确定性跑完，
  返回的 `replayedDigest` 与当时实时封存的指纹必须完全一致。

## 生物学模型（1 tick = 模拟 1 分钟，全程 1800 tick = 30 小时）

- 24 份标本各有一张生理参数表 `api/src/petri/traits.ts`：
  Monod 最大比生长速率 μ、半饱和常数 Ks、维持能耗、得率、run-and-tumble 运动性、三种抗菌素抗性谱。
  数值按真实倍增时间标定（大肠杆菌 ~20min、结核 ~20h、酵母 ~80min、古菌慢而寡营养亲和）。
- **碳源场**：64×64 网格显式扩散，严格碳守恒（摄取→生物量、呼吸矿化、裂解释碳回场、培养基缓释）。
  空间上抢碳，自然产生优势种更替。
- **抗菌素**：青霉素（细胞壁，革兰阳性敏感）、环丙沙星（广谱）、两性霉素B（真菌）；
  各自扩散 + 半衰期衰减，既抑菌（降低合成）又按 `1-exp(-k·C·(1-抗性))` 概率裂解。
- **病毒**：游离粒子布朗扩散并指数失活，接触易感宿主后潜伏（T4→大肠杆菌，25min），
  到点裂解释放子代；无宿主的病毒（流感、TMV 等）只会衰减灭绝。

## 可复现性（核心验收点）

- 随机：种子经 FNV-1a → mulberry32；迭代顺序固定（id 序）、分裂子细胞追加队尾当 tick 不参与、
  新增/删除不改变既有 RNG 轨迹；仅用 IEEE754 四则与 `sqrt`。
- **同一份接种清单 + 同一颗种子 ⇒ 任意一次运行都产生逐 tick 完全相同的每种标本计数序列。**
  见 `scripts/calibrate.ts` 的 A 项（两次独立运行轨迹 SHA-256 相同）。
- **生态指纹**（终态封存）包含：
  - 第 0..15 代（每代 120min）的总细胞数、细菌/真菌/古菌/病毒四类计数与占比；
  - 最终优势种；灭绝顺序（含灭绝 tick）；
  - 对**全部 1800 个 tick 的全标本计数序列**的 SHA-256（`countsDigest`）；
  - 整条规范记录再做一次 SHA-256（`digest`）。
  任意两份不同接种（哪怕只差 1 个细胞）或不同种子，指纹必不同（calibrate D 项）。
- 指纹的 SHA-256 是纯 TS 实现（`rng.ts`），与 Node `crypto` 交叉校验一致，便于脱离 Node 复核。

## 前端渲染（`src/petri/`）

- **纯手写 Canvas 2D，无任何图形库**：杆/球/弧/酵母出芽/菌丝/二十面体/包膜病毒/古菌，
  鞭毛为手画贝塞尔正弦波；菌落边缘用低密度层 + 高斯模糊 + 边缘高光。
- **按 devicePixelRatio 设置 backing store**（上限 2.5），高分屏不发虚。
- 精灵离屏预烘焙（标本×状态），每帧只 `drawImage` 批绘，1000 细胞同屏稳 60fps。
- **鼠标悬停出现圆形显微镜视野**：圆形裁剪、3.4× 放大、十字分划板、微米标尺，
  并在右侧读出视野中心单个细胞的质量、朝向、形态、受胁迫/感染/即将分裂状态。
- **自适应降级**：实测帧时超阈值自动在高/中/低画质间切换（关菌落边缘、关鞭毛）。
- **时间片**：`timeSlice.ts` 用 `MessageChannel` 在重活块间让出主线程，不阻塞绘制。

## 控制

暂停 / 继续；速度 1×、2×、5×、10×、25×、50×、100×；
三种抗菌素 × 四档浓度即时施加（操作者给药同样进入确定性指纹，可重放）。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/petri/runs` | 建舱 `{inocula, seed, regimen?}` |
| GET  | `/api/petri/runs/:id/stream` | SSE 权威快照流 |
| POST | `/api/petri/runs/:id/control` | pause/resume/setSpeed/dose/restart |
| GET  | `/api/petri/archives` | 档案列表 |
| GET  | `/api/petri/archives/:id` | 逐条留痕记录 |
| GET  | `/api/petri/archives/:id/verify` | 确定性重放并复核指纹 |

## 验收脚本

- `npm run calib`（tsx scripts/calibrate.ts）：复现性、指纹唯一性、抗菌素压制、演替动态、耗时。
- `node scripts/render-benchmark.mjs`：离屏软件渲染热路径吞吐（需 `@napi-rs/canvas`）。
- `node scripts/browser-acceptance.mjs`：真实 Chromium 端到端（60fps / DPR / SSE / 暂停 / 悬停镜头，需 playwright-core + chromium）。
- `/petri/stress`：页面内 1000/1500/2000 细胞帧率自检。
