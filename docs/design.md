# OpenTreeLearn 设计文档

> 学习工作流：从节点树脑图出发，一步一步问答，沉淀知识，快速收获。

## 1. 产品定义

**一句话**：一个「对话即内容」的树状学习工作台 —— 每个节点是一个可继承上下文的 LLM 对话线程，节点在画布上长成一棵树，子树的形状就是学习的路径。

**目标用户**：需要系统性学习某个主题、希望保留「怎么一步步学会的」这条路径的人（研究者、学生、工程师）。

**核心闭环**：
1. 建项目（贴标签）→ 得到一个画布，放一个由用户输入的起始节点
2. 在节点里和 LLM 对话（每轮自动沉淀为标题/摘要）
3. 从某条消息处**分支/发散**，探索不同方向；或开**子节点**探索无上下文的新问题
4. 画布上自由拖拽整理这棵树 → 形成可回看的学习地图

**非目标（当前阶段）**：协作/多人、导出分享、移动端原生 App、云同步（辅助需求，后续迭代）。

## 2. 概念模型

```
Project (1) ──── (1) Canvas ──── (n) Node ──── (n) Message
                                    │
                                    └─ 父/子关系构成树；画布可挂多棵树（多根）
```

- **Project**：一个学习主题，带标签、个人背景覆盖、默认模型设置。
- **Canvas**：与 Project 1:1，承载节点树与视口状态，用户无感知（不单独做管理）。
- **Node**：= 一个对话线程。**对话即内容**，节点没有独立正文；卡片正面展示 `title + summary`。
- **Message**：对话中的一条消息，可携带图片附件。

## 3. 三种节点创建动作

| 动作 | 树落点 | 上下文继承 |
| --- | --- | --- |
| **发散节点** diverge | 当前节点**横向**（与当前节点同级；若当前为根则成为新根） | 从选定消息处 fork（ChatGPT 式） |
| **子节点** child | 当前节点**之下** | 空白（仅注入个人背景 + 项目上下文） |
| **分支节点** branch | 当前节点**之下** | 从选定消息处 fork（ChatGPT 式） |

统一抽象：

- **落点**由 `parentId` 决定（横向 = 与源节点同父；纵向 = 源节点本身）。
- **上下文**由 `forkFrom{nodeId, messageId}` 决定；`null` 表示空白起点。

> 画布使用**自上而下**的树布局：`子节点`往下长，`发散节点`往左右长，与用户心智一致。

## 4. 数据模型

```ts
type Id = string; // crypto.randomUUID()

interface Project {
  id: Id;
  name: string;
  description?: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

interface ProjectSettings {
  projectId: Id;
  backgroundProfile?: string; // 覆盖全局「个人背景」
  systemPrompt?: string;      // 追加的项目级系统提示
  chatModelRef?: ModelRef;    // 默认对话模型
  titleModelRef?: ModelRef;   // 标题生成模型（缺省则用首条消息做标题）
  summaryModelRef?: ModelRef; // 摘要生成模型（缺省则不自动摘要）
}

interface ModelRef {
  providerId: Id;
  modelId: string;
}

interface Node {
  id: Id;
  projectId: Id;
  parentId: Id | null;              // 树位置；null = 根
  forkFrom: { nodeId: Id; messageId: Id } | null; // 上下文继承源
  title: string;                    // 默认 = 用户首条消息；配置标题模型后自动生成
  summary?: string;                 // AI 对话摘要（卡片展示）
  contextSeed?: string[];           // 导入或初始化时携带的上下文种子（注入系统提示）
  position: { x: number; y: number } | null; // 手动拖拽后写入 → 锁定，不参与自动布局
  order?: number;                   // 同级排序（可选）
  status: 'active' | 'archived';
  createdAt: number;
  updatedAt: number;
}

type Role = 'system' | 'user' | 'assistant';

interface MessagePart =
  | { type: 'text'; text: string }
  | { type: 'image'; assetId: Id };

interface Message {
  id: Id;
  nodeId: Id;
  projectId: Id;      // 冗余，便于按项目批量查询
  role: Role;
  parts: MessagePart[];
  createdAt: number;
  meta?: {
    providerId?: Id;
    modelId?: string;
    usage?: { promptTokens?: number; completionTokens?: number };
    error?: string;
    incomplete?: boolean; // 流式中断标记
  };
}

interface Asset {
  id: Id;
  projectId: Id;
  kind: 'image';
  mime: string;
  name?: string;
  width?: number;
  height?: number;
  blob: Blob;
  createdAt: number;
}

interface ProviderConfig {
  id: Id;
  label: string;
  kind: 'openai' | 'anthropic' | 'google' | 'openai-compatible';
  apiKey: string;
  baseURL?: string;
  models: string[]; // 用户手动维护的可用模型 ID 列表
}

interface GlobalSettings {
  backgroundProfile: string; // 每次新开空白节点都注入的上下文
  defaultChatModelRef?: ModelRef;
  titleModelRef?: ModelRef;
  summaryModelRef?: ModelRef;
  providers: ProviderConfig[];
}
```

### 存储与索引（Dexie）

| 表 | 主键 | 索引 |
| --- | --- | --- |
| `projects` | `id` | `updatedAt`, `*tags` |
| `projectSettings` | `projectId` | — |
| `nodes` | `id` | `projectId`, `parentId`, `[projectId+parentId]` |
| `messages` | `id` | `nodeId`, `[nodeId+createdAt]`, `projectId` |
| `assets` | `id` | `projectId` |
| `settings` | KV（`key`） | — |

## 5. 上下文组装策略

发送消息时，`assembleContext()` 构造发给 LLM 的消息数组，规则：

1. **系统消息**：全局个人背景 → 项目背景覆盖 → 项目 systemPrompt → 节点定位（这是学习树中的第 N 层，父节点主题列表）。
2. **对话历史**：
   - 节点自身消息按时间顺序；
   - 若 `forkFrom` 非空：从根到 fork 源节点的**路径**逐层拼接其消息，截断到 `forkFrom.messageId`（含）。
3. **超预算降级（从远到近）**：
   - 先对路径上每一层的消息做「首条用户消息 + 该节点 summary」的压缩；
   - 仍超预算则对最近 K 轮之前的历史做逐条截断；
   - 保留最近 `K = 6` 轮原文不动。
4. 预算用 `estimateTokens()`（字符/4 近似）计算，默认 `contextBudget = 24000` tokens，可配置。

> 该逻辑为**纯函数**，位于 `src/domain/context/`，必须有单测覆盖。

## 6. 交互设计

### 路由

| 路径 | 页面 |
| --- | --- |
| `/` | 项目列表（卡片、标签筛选、新建项目） |
| `/p/:projectId` | 画布工作台（主视图） |
| `/settings` | 配置（BYOK、个人背景、模型分配） |

### 画布工作台

- 布局：React Flow，自上而下的树（d3-hierarchy `tree()`）。
- 节点卡片：标题、摘要（缺省显示最后一条 AI 回复前几行）、状态点、分支数。
- 连线：`parentId` 实线（树边）；`forkFrom` 虚线（上下文继承边，表达"上下文来自哪"）。
- 拖拽：拖动后写 `position` 并锁定；「重新布局」按钮清除所有 `position` 回到自动布局。
- 点击节点：右侧滑出对话面板（可调宽），画布自动居中该节点。
- 动效：节点入场/连线生长用 `motion`，布局切换用 FLIP 过渡。

### 对话面板

- 消息流：用户右、AI 左；Markdown 渲染 + KaTeX 公式 + Shiki 代码高亮。
- 输入区：支持粘贴图片（存为 Asset，转 data URL 发送，模型不支持 vision 时提示但保留）。
- 消息悬浮操作：**分支节点**（下）/ **发散节点**（横向）—— 以该条消息为 fork 点。
- 头部操作：新建**子节点** / 重命名 / 归档。
- 流式：逐块写入 store，节流渲染（约 50ms），可中断；消息落库在流结束后。

### 配置页

- Provider 管理：增删改（kind / apiKey / baseURL / 模型列表），连通性测试。
- 模型分配：默认对话模型、标题模型、摘要模型。
- 个人背景：全局文本框（说明"每次新开空白节点都会注入"）。

## 7. 架构分层

```
src/
  domain/      纯逻辑，不依赖 React / 存储 / 网络
    models/    实体类型定义
    tree/      树构建、路径、子树、d3 布局
    context/   上下文组装 + token 预算
    node-ops/  三种节点动作 → 节点对象（纯函数）
  data/        Repository 接口 + Dexie 实现（未来可加 Supabase 实现）
  services/    LLM provider 适配（Vercel AI SDK）、标题/摘要、图片
  stores/      Zustand + Immer（只做状态编排，不写业务规则）
  features/    projects / canvas / chat / settings（UI）
  components/  通用 UI 组件
  lib/         markdown 渲染（含 shiki 高亮）、工具函数
```

**约束**：`domain` 不得 import `data`/`services`/`react`；`data` 只依赖 `domain` 类型；UI 通过 stores 调用 data/services。

**Store 划分（实现）**：`settings-store`（全局配置）、`projects-store`（项目列表）、`workspace-store`（当前打开项目的节点 / 消息 / 流式对话 / 选中态）。打开项目的全部状态放在同一个 store，避免「画布要读消息、对话要读节点」造成的跨 store 环形依赖。

**LLM 服务拆分（实现）**：`services/llm/catalog.ts` 只放纯元数据（协议标签、默认地址、模型描述、`hasModel`），不引用任何厂商 SDK；`services/llm/providers.ts` 负责创建 `LanguageModel`，内部**动态 import** 四个厂商适配包。效果：设置页与模型选择器不会把厂商 SDK 打进首屏，只有真正发消息时才按需下载对应适配包。

## 8. 技术选型

| 关注点 | 选择 |
| --- | --- |
| 构建 | Vite + React 19 + TypeScript（pnpm） |
| 路由 | react-router |
| 画布 | @xyflow/react |
| 树布局 | d3-hierarchy（tidy tree） |
| 状态 | Zustand + Immer |
| 本地存储 | Dexie（IndexedDB） |
| 样式 | Tailwind CSS v4 + Radix primitives（shadcn 风格） |
| 动效 | motion |
| LLM | Vercel AI SDK（openai / anthropic / google / openai-compatible 四类 provider） |
| Markdown | react-markdown + remark-gfm + remark-math + rehype-katex + katex |
| 代码高亮 | shiki |
| 校验/测试 | Zod / Vitest |

## 9. 分期

- **P0**：项目页 + 画布 + 节点对话 + md/公式渲染 + BYOK + 本地存储
- **P1**：标题/摘要 AI 总结、三种分支动作、图片粘贴、个人背景注入、动效打磨
- **P2（待排）**：账号 + 云端存储 + 多端同步；导出分享；检索

本期实现 P0 + P1。

## 10. 已知约束与风险

- **浏览器直连 provider 的 CORS**：部分厂商/自建中转（如 new-api / one-api）未返回 `Access-Control-Allow-Origin`，浏览器会拦截。对策：
  - 生产环境由部署侧反向代理统一域名，同源访问不产生跨域；
  - 本地开发需自建站自身返回 CORS 头，或由开发者的反向代理处理；
  - 错误分类器（`describeLlmError`）递归解析错误链，命中 CORS 时给出明确操作指引。
- **数学公式渲染质量**：以 KaTeX 严格模式渲染，`$...$` 与 `$$...$$` 均支持；学术场景下不接受降级为正文字符。
- **流式渲染性能**：Markdown 全量重解析成本高 → 节流（60ms）+ 流结束后定稿。
- **自动布局与手动拖拽冲突**：`position` 一旦写入即锁定，须显式「重新布局」才归位。
- **代码高亮包体积**：shiki 采用 `core` + 按需语言 chunk，只有用到的语言会被下载。
- **外部 .tree 项目导入**：外部格式的 `context[]` 快照会转为节点的 `contextSeed`，由上下文组装器作为「本节点建立时的上下文」注入系统提示，确保导入后的后续追问仍拥有最初的问题背景。

## 11. 实现备注（与初稿的差异）

| 项 | 决策 |
| --- | --- |
| 代码高亮 | 由「shiki 全量 bundle」改为 `shiki/core` + 40 个语言的动态 import（避免产出 346 个语言 chunk） |
| 路由加载 | `CanvasPage` / `SettingsPage` 走 `React.lazy`，项目列表首屏与画布工作台分包 |
| 表单重置 | 弹窗组件通过 `key` 重挂载重置，不在 effect 里同步 props → state（符合 React 19 与 `react-hooks` 新规则） |
| 上下文预算 | 降级顺序：远→近压缩为「脉络」→ 远→近丢弃 → 截断旧消息 → 仅保留最近两条并截断 |
| 节点动作边界 | 发散/分支在没有可用消息（空节点）时降级为空白节点，不报错 |
| 删除语义 | 删除/归档均级联整棵子树；删除同时清理消息与资产引用 |

## 12. 后续（P2 候选）

- 账号 + 云同步：新增 `data/supabase` 实现即可接入（Repository 接口已就位）
- 项目导出（Markdown / JSON）、全局检索、节点合并与引用
- 首屏进一步瘦身：Markdown 渲染栈按需加载、KaTeX 字体子集化