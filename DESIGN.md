# DESIGN.md — OpenTreeLearn 视觉系统

> 来源：提炼自 `src/styles/index.css`（唯一 token 权威）与 `docs/design.md`。Google Stitch 风格格式，供设计工具链使用。改样式前先读本文件与 index.css，两者冲突时以代码为准。

## 氛围（Atmosphere)

暗色专注型工作台。低饱和冷灰底 + 唯一暖琥珀 accent，形成「冷静界面、温暖重点」的对比。层级靠表面色阶（canvas→surface→elevated）与阴影表达，不靠描边堆叠。信息密度中高，动效克制、快而缓出。

## 色彩（Colors）

仅使用下列 token，禁止组件内写死色值或叠透明度灰阶：

| Token | 值 | 用途 |
| --- | --- | --- |
| `--color-canvas` | `#0a0c0f` | 页面最底色 |
| `--color-surface` | `#101317` | 面板/侧栏 |
| `--color-elevated` | `#171b21` | 浮层/卡片 |
| `--color-line` | `#232830` | 常规描边 |
| `--color-line-strong` | `#313842` | 强调描边/hover 边 |
| `--color-ink` | `#e8ebef` | 主文本 |
| `--color-ink-soft` | `#b6bdc7` | 次级文本 |
| `--color-muted` | `#868f9d` | 三级灰：辅助说明 |
| `--color-faint` | `#7a8492` | 四级灰：占位符、禁用态（实测 elevated 底 4.56:1，达 WCAG AA） |
| `--color-grid` | `#181c23` | 画布点阵网格专用（介于 canvas 与 line 之间） |
| `--color-accent` | `#e0a768` | 唯一强调色（选中、进行中、品牌感） |
| `--color-accent-soft` | `#33281a` | accent 淡底 |
| `--color-accent-ink` | `#17100a` | accent 底上的文字 |
| `--color-danger` / `-soft` | `#e0705a` / `#3a1f1a` | 破坏性操作 |
| `--color-success` | `#63bf93` | 成功/已掌握 |
| `--color-info` | `#6f9fd8` | 信息提示 |

深色唯一（`color-scheme: dark`），无浅色主题。

## 字体（Typography）

- 正文：`--font-sans`（system-ui 栈，中文回退 Noto Sans SC / PingFang SC / 微软雅黑）
- 代码：`--font-mono`（ui-monospace 栈）
- 字号阶梯固定 6 级，新尺寸先加 token 再用，组件内禁止任意值：
  - `--text-2xs` 11px（徽标、计数）
  - `--text-xs` 12px（辅助说明、元信息）
  - `--text-sm` 13px（正文、控件）
  - `--text-base` 14px（主要文本、卡片标题）
  - `--text-lg` 16px（区块/对话框标题，line-height 1.4）
  - `--text-xl` 20px（页面标题，line-height 1.3）
- 页面主标题 `letter-spacing: -0.01em`。

## 形状与阴影（Shape & Depth）

- 控件圆角 5–6px；胶囊元素 999px。
- `--shadow-panel`：面板用（0 1px 0 白 3% + 0 12px 30px -14px 黑 60%）。
- `--shadow-node`：画布节点用（0 1px 0 白 4% + 0 8px 20px -12px 黑 55%）。

## 动效（Motion）

- 标准缓动：`--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1)`；motion 里对应 `EASE_OUT_EXPO`（`src/lib/motion.ts`，缓动与时长只在常量处定义，组件不写魔法数字）。
- 动效库为 `motion`（`motion/react`）：负责 React 挂载/卸载的进出场（AnimatePresence）与中断，悬停、颜色等声明式状态仍走 CSS transition。全局挂 `MotionConfig reducedMotion="user"`——系统减弱动态时自动砍位移、保留透明度；CSS 侧另有 `prefers-reduced-motion` 全局降级。
- 只动 transform 与 opacity；时长阶梯 120ms 退场 / 150–200ms 反馈 / 250–350ms 布局与浮层。动画只解释「刚发生的事」：新落库的消息、新生的节点、流式→落库交棒、胶囊与提示条的进出——切节点、首屏、历史内容一律不播。
- 克制、快速、缓出；不做装饰性长动画。`prefers-reduced-motion` 必须降级。

## 组件语汇（Components）

- 画布节点卡片：elevated 底 + `--shadow-node` + 1px line 描边；展示 title + summary + 掌握度。
- 面板/侧栏：surface 底 + `--shadow-panel`。
- 对话流：消息是内容本体；引用块（quote）、代码高亮（shiki）、公式（KaTeX）。
- 控件：Radix 行为 + shadcn 风格封装（cva 管理变体），lucide 图标。
- Toast：sonner。状态色仅 danger/success/info 三种语义。

## 反模式（Do NOT）

- **文字与图标的灰阶只用四级（ink / ink-soft / muted / faint）**，禁止用透明度变体凑新灰；边框与表面的半透明（配合 backdrop-blur 做层级）是允许的分层手法，不算发明新灰。
- 组件内写死十六进制色值（网格色用 `--color-grid`）。
- 绕过字号阶梯写任意 px。
- 装饰性渐变、大面积发光、玻璃拟态堆叠——与本产品「书房」气质冲突。
- 长入场动画、视差；打断输入心流。
- 在 accent 之外引入新的强调色。
