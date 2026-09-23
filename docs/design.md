# OpenTreeLearn 设计文档

> 版本：v2.1 · Agent 时代重构版  
> 状态：P0+P1 与云端同步已实现；**Agent 化（P-A/P-B/P-C）已实现**（见 §12 分期）  
> 关联：[Agent 工具调用设计](./llm-tool-calling.md) · [T-128 复习重构](./t128-review-experience-refactor.md)  
> 原则：对话即内容、树即路径、Agent 即协作者——从「把上下文塞给模型」升级为「让 Agent 感知、规划、执行」

---

## 0. 一句话与判定

**一句话**：一个「对话即内容」的树状学习工作台——每个节点是一条可继承上下文的对话线程，节点在画布上长成一棵可回看、可分叉的学习路径树。

**本次升级的判定**：不再做「更聪明的聊天框」。下一阶段的核心是 **Agent 协作者**——它能看见你的整棵树、记得你标过的错题、主动规划复习与整理，并在你授权下直接动手改树。聊天只是 Agent 的一种交互形态，不是全部。

| 维度 | 过去（已实现） | 下一阶段（Agent） |
| --- | --- | --- |
| 模型角色 | 被动回答者，靠注入的上下文猜 | 主动协作者，可查、可做、可反思 |
| 上下文 | 祖先链压缩 + 本节点对话 | 按需检索全树 + 用户标注 + 复习状态 |
| 能力边界 | 只能说话 | 能查节点、建节点、打标签、规划复习 |
| 交互 | 用户问一句答一句 | Agent 可提议、可分步执行、可撤销 |

---

## 1. 产品定义

### 1.1 目标用户

需要系统性学习某个主题、希望保留「怎么一步步学会的」这条路径的人——研究者、学生、工程师。共性是：**学习不是刷完一篇文章，而是长出一棵可追溯的树**。

### 1.2 核心闭环

```
建项目（贴标签、设背景）→ 在节点里对话（自动沉淀标题/摘要/掌握度）
  → 从某条消息处分支/发散探索不同方向，或开子节点探索新问题
    → Agent 按需检索、整理、规划复习
      → 画布拖拽整理成学习地图
```

### 1.3 非目标（当前阶段）

多人协作、移动端原生 App。云同步已实现 P1（见 §13），P2 图片资产同步待排。

---

## 2. 概念模型

```
Project (1) ─── (1) Canvas ─── (n) Node ─── (n) Message
                                  │  └─ thread（版本：编辑重发/重新生成）
                                  └─ parentId 树边 + forkFrom 上下文边
                                  └─ mastery / review / enrollment（掌握度与复习）
                                  └─ Agent 可感知的实体（见 §6）
```

- **Project**：一个学习主题，带标签、个人背景覆盖、默认模型设置。
- **Canvas**：与 Project 1:1，承载节点树与视口；用户无感知，不单独管理。
- **Node = 对话线程 = 内容本身**。节点没有独立正文，卡片展示 `title + summary + 掌握度`。新增 `contextSeed` 承载导入时的上下文种子。
- **Message**：`parts: text | quote | image`，`meta` 含 provider/usage/error/incomplete。
- **Agent 视角**：Node / Message / Note / ReviewState 都是 Agent 的可观测与可操作对象。Agent 的「感知」就是读这些实体，「执行」就是改这些实体（受权限约束）。

---

## 3. 三种节点创建动作（不变，Agent 将复用）

| 动作 | 树落点 | 上下文继承 | 典型意图 |
| --- | --- | --- | --- |
| **发散 diverge** | 与当前节点同级（根则成新根） | 从选定消息处 fork | 换个角度重开一题 |
| **子节点 child** | 当前节点之下 | 空白（仅背景+项目上下文） | 问一个全新的子问题 |
| **分支 branch** | 当前节点之下 | 从选定消息处 fork | 顺着这条回答往下深挖 |

统一抽象：`parentId` 定落点（横向=同父，纵向=当前节点），`forkFrom{nodeId, messageId, selection}` 定上下文；`null` 为空白起点。Agent 的 `create_node` 工具直接复用 `applyAction`（`domain/node-ops/actions.ts`），不另起路径。

> 画布为自上而下树布局（d3-hierarchy `tree()`）：子节点向下长，发散节点向左右长。`order` 可选，用于同级微调，布局阶段按 `createdAt` 稳定排序。

---

## 4. 数据模型（稳定层）

### 4.1 实体形状

> 本节只列形状，约束与索引见 §4.2。Agent 阶段的三处演进（`MessagePart.tool`、`Note.kind→labels`、`ProviderConfig.capabilities`）见 Agent 文档，此处保持「已实现层」稳定。

```ts
type Id = string // crypto.randomUUID()

interface Project { id: Id; name: string; description?: string; tags: string[]; createdAt: number; updatedAt: number }
interface ProjectSettings {
  projectId: Id
  backgroundProfile?: string
  systemPrompt?: string
  chatModelRef?: ModelRef; titleModelRef?: ModelRef; summaryModelRef?: ModelRef
  updatedAt?: number
}
interface ModelRef { providerId: Id; modelId: string }

interface Node {
  id: Id; projectId: Id
  parentId: Id | null; forkFrom: ForkRef | null
  title: string; summary?: string; contextSeed?: string[]
  position: { x: number; y: number } | null
  thread?: NodeThread; status: 'active' | 'archived'
  kind?: 'topic' | 'review'
  mastery?: MasterySnapshot; review?: NodeReview
  reviewEnrollment?: 'enabled' | 'disabled'
  assessmentMeta?: AssessmentMeta; lastStudiedAt?: number
  createdAt: number; updatedAt: number
}
interface ForkRef { nodeId: Id; messageId: Id; selection?: Record<Id, number> }
type ThreadEntry = Id | { slot: Id }
interface ThreadVersion { version: number; entries: ThreadEntry[] }
interface ThreadSlot { versions: ThreadVersion[] }
interface NodeThread { entries: ThreadEntry[]; slots: Record<Id, ThreadSlot>; selection?: Record<Id, number> }

type Role = 'system' | 'user' | 'assistant'
type MessagePart = { type: 'text'; text: string } | { type: 'quote'; text: string } | { type: 'image'; assetId: Id }
interface Message {
  id: Id; nodeId: Id; projectId: Id; role: Role
  parts: MessagePart[]; createdAt: number; updatedAt?: number
  meta?: { providerId?: Id; modelId?: string; usage?: { promptTokens?: number; completionTokens?: number }; error?: string; errorHint?: string; incomplete?: boolean }
}
interface Note {
  id: Id; projectId: Id; nodeId: Id; messageId: Id
  kind: 'highlight' | 'annotation' // 演进见 Agent 文档 §4：kind → labels
  quote: string; start: number; end: number; body?: string
  createdAt: number; updatedAt: number
}
interface Asset { id: Id; projectId: Id; kind: 'image'; mime: string; name?: string; width?: number; height?: number; blob: Blob; createdAt: number }
type ProviderKind = 'openai' | 'anthropic' | 'google' | 'openai-compatible'
interface ProviderConfig { id: Id; label: string; kind: ProviderKind; apiKey: string; baseURL?: string; models: string[] }
interface GlobalSettings {
  backgroundProfile: string
  defaultChatModelRef: ModelRef | null; titleModelRef: ModelRef | null; summaryModelRef: ModelRef | null
  contextBudget: number; providers: ProviderConfig[]; updatedAt: number
}
```

### 4.2 存储与索引（Dexie，`data/dexie/db.ts`）

| 表 | 主键 | 索引 | 演进 |
| --- | --- | --- | --- |
| `projects` | `id` | `updatedAt`, `*tags` | v1 |
| `projectSettings` | `projectId` | — | v1 |
| `nodes` | `id` | `projectId`, `parentId`, `[projectId+parentId]` | v1，`thread` 不建索引 |
| `messages` | `id` | `nodeId`, `[nodeId+createdAt]`, `projectId` | v1，`parts` 不建索引 |
| `notes` | `id` | `projectId`, `nodeId`, `messageId` | v2，`nodeId`/`messageId` 用于级联清理 |
| `assets` | `id` | `projectId` | v1，P2 前不同步 |
| `settings` | KV `key` | — | v1，`key='global'` |
| `outbox` | `++seq` | `entity`, `localId`, `[entity+localId]` | v3，变更台账，push 顺序即 `seq` |
| `syncState` | `key` | — | v3，游标与首次登录决策 |
| `reviewSessions` | `id` | `projectId`, `[projectId+open]`, `updatedAt` | v4，每项目至多一条未完成会话 |

---

## 5. 上下文与记忆策略（从注入到按需）

### 5.1 当前策略（已实现，纯函数 `domain/context`）

发送时 `assembleContext()` 构造 `system + messages`：

1. **System**：全局背景 → 项目背景覆盖 → 项目 systemPrompt → 节点定位（祖先标题链）→ `contextSeed` → 前置脉络压缩段 → 复习导师规则（仅复习会话）。
2. **History**：
   - 本节点取**显示路径** `resolveThread().path`（历史版本不进上下文）；
   - 若 `forkFrom` 非空：从根到 fork 源逐层拼接，截断到 `forkFrom.messageId`，按 `forkFrom.selection` 冻结解析；fork 点已不在显示路径时退化为整条显示路径（继承提示条上说明，见 `assemble.ts:cutAt`）。
3. **超预算四级降级**（`budget=24000 tokens`，`estimateTokens` 见 `domain/context/tokens.ts`：`ceil(CJK×1.05 + other/3.6)`，不是简单的 `chars/4`）：
   1) 远→近把前置节点压成「脉络摘要」
   2) 远→近丢弃脉络
   3) 旧消息逐条截断（`TRUNCATE_CHARS=480`，仅截文本，图片与结构不动）
   4) 仅保留本节点最近 `MIN_KEEP_OWN_MESSAGES=2` 条并截断（`DEFAULT_RECENT_MESSAGES=8` 仅用于正常态的尾部保留）

> 该逻辑为纯函数（`src/domain/context/assemble.ts`），必须有单测。复习上下文 `buildReviewMaterial` 与自由问答 `assembleFreeAskContext` 各自独立，见 §14。

### 5.2 Agent 时代的演进

**问题**：当前策略是「一次性把能给的都塞进 system」。Agent 需要的是「按需取」——全树检索、用户标注、复习状态不应常驻上下文，而应由工具在需要时拉取。

**方向**（详见 Agent 文档）：

- 保留 `assembleContext` 作为**基线上下文**（定位 + 祖先脉络 + 本节点对话）；
- 新增工具层：`search_nodes` / `get_node` / `get_tree_outline` / `search_notes` 按需补全；
- 对超长历史，用 `pruneMessages({ toolCalls: 'before-last-${N}-messages' })`（SDK 支持的模板形态，实参如 `before-last-2-messages`）安全丢弃旧工具记录，不撕裂配对；
- 自由问答是第一个按需上下文场景：快照与清单已在每次发送时重算，天然适合工具化。

---

## 6. Agent 定位（新增）

### 6.1 Agent 是什么、不是什么

- **是**：在浏览器内执行的、能读改本项目数据的协作者。感知（读树/读标注/读复习状态）→ 规划（是否需要工具、分几步）→ 执行（调工具）→ 反思（把关键信息复述进正文，保证导出/摘要/跨端可自包含）。
- **不是**：独立的服务端机器人、也不替代对话。Agent 复用现有 `streamText` 循环与 Dexie/Zustand，不新增后端。

### 6.2 能力分层

| 层 | 能力 | 示例 | 风险 |
| --- | --- | --- | --- |
| **L0 感知** | 只读工具 | `search_nodes`、`get_node`、`search_notes`、`get_tree_outline` | 低，纯查询 |
| **L1 整理** | 可逆写入 | `create_node`、`rename_node`、`tag_span` | 中，可撤销 |
| **L2 重构** | 破坏性写入 | `archive_node`、`delete_note` | 高，需确认 |

> 分期：L0 先行（不碰持久化亦可验证），L1/L2 需持久化工具记录与审批流，见 Agent 文档 §11（分期与验收）与 §7.6（持久化决策）。

### 6.3 自主度与权限

- **默认只读**：新项目不自动开写入，需在项目设置显式开启（按项目开关，见 Agent 文档 §13 待拍板 #3）。
- **可逆操作自动执行 + 撤销入口**；破坏性操作走 `toolApproval` 需用户点确认。执行前需在描述中说明「将要做什么、影响哪几个节点」。
- **静默降级**：`openai-compatible` 等自建中转可能不支持工具，需探测 `capabilities.tools` 并在 UI 明确标示「无工具模式」，避免用户误判为模型笨。
- **不主动打扰**：Agent 不在用户未提问时自行发起工具调用与写入；规划型建议（如“检测到 3 个错题，建议复习”）以可忽略的轻提示呈现，不抢焦点。

### 6.4 触发与显隐

| 场景 | 触发 | 说明 |
| --- | --- | --- |
| 学习对话 | 用户发消息时 | 模型按需举手，工具在该轮流式期内执行 |
| 自由问答 | 同上（复习工作区概览的覆盖面板） | 首个按需场景，不落库，适合先验证 |
| 画布/复习练习 | 不触发 | 避免在用户“做题中”时弹工具卡干扰；三期再议 |

> 若未来引入主动建议（非用户提问触发），需单独设计触发器、频控与可关闭开关，不在本阶段展开。

---

## 7. 交互设计

### 7.1 路由

| 路径 | 页面 |
| --- | --- |
| `/` | 项目列表（标签筛选、新建） |
| `/p/:projectId` | 画布工作台（主视图） |
| `/p/:projectId?view=review` | 复习工作模式（概览→练习→反馈→小结，见 §14） |
| `/me` | 我的（账号、背景、同步） |
| `/settings` | 配置（BYOK、模型分配、预算） |

### 7.2 画布工作台

- React Flow + d3-hierarchy 自上而下树；`position` 写入即锁定，「重新布局」清除。
- 节点卡片：标题、摘要/末条回答预览、掌握度徽标、分支数；连线分实线（`parentId`）与虚线（`forkFrom`）。
- 点击节点滑出对话面板（可调宽），画布居中该节点。

### 7.3 对话面板

- 渲染：Markdown + KaTeX + Shiki（`core` + 按需语言），流式节流 ~50ms，可中断，节流与定稿逻辑见 `features/chat/MessageList.tsx`。
- 输入：粘贴图片存 Asset，转 data URL 发送；不支持 vision 时提示但保留（`chat.ts:mediaTypeOfDataUrl`）。
- 悬浮操作：**分支/发散**（以该条消息为 fork 点）、**重新生成**（仅显示路径末条 AI 消息）、**编辑重发**（整段换版，详见 §11）。
- 版本：`<a/b>` 切版，悬浮显示摘要；每槽至多 3 版，第 4 版淘汰最早版并级联清理消息与笔记；生成中禁止编辑与切版。
- 框选月牙：框选正文浮出三按钮——**新建子分支**（选中文字作首条消息发出）、**引用到对话**（`quote` part）、**复制**。仅 `[data-message-id]` 内触发；引用以 `quote` part 存消息，气泡渲染为引用块，送模型时转为 `> …` Markdown 行。
- 头部操作：新建**子节点** / 重命名 / 归档。
- 流式：可中断，落库在流结束后；`StreamingState` 见 `stores/workspace-store.ts:57`（`{ nodeId, messageId, text }`，Agent 阶段扩展为步骤数组）。
- **Agent 工具卡**（新增）：气泡内按 `parts` 顺序内联展示「🔍 查询节点… ▸ 已返回」，流式期显示 spinner 与 `第 n/4 步`，已完成步骤留屏；**必须渲染在 `data-message-body` 之外**（见 `features/chat/note-anchor.ts:27`，否则按正文文本节点计数的 `start/end` 锚点整体错位，虽有 `locateQuote` 自愈但会退化为“就近找”）。中断的工具卡灰色“未完成”并丢弃，不落库。

### 7.4 配置与我的

- Provider 管理（增删改 + 连通性测试）、模型分配、预算、个人背景。
- 账号：邮箱验证码登录/注册，token 存 `localStorage`，启动即绑库（见 §13）。

---

## 8. 架构分层

```
src/
  domain/       纯逻辑，不依赖 React/存储/网络
    models/     实体类型
    tree/       树构建、路径、布局
    thread/     版本解析与变更（纯函数）
    context/    上下文组装与预算（纯函数）
    node-ops/   节点动作 → 节点对象（纯函数）
    review/     掌握度、FSRS、复习协议
  data/         Repository + Dexie（+ outbox 同步台账）
  services/
    llm/        provider 适配（AI SDK）、chat/derive/review/free-ask、tools/（新增）
    images/     Asset URL
    sync/       同步客户端
  stores/       Zustand + Immer（编排，不写业务规则）
    workspace-store  当前项目的节点/消息/流式/选中态
    settings-store / projects-store / account-store / sync-store / review-session-store / free-ask-store
  features/     projects / canvas / chat / settings / me / review
  components/   通用 UI
  lib/          markdown、text、id 等
server/         同步 BFF（NestJS + Prisma + SQLite），独立包，仅 HTTP 契约耦合
```

**约束**：`domain` 不得 import `data/services/react`；`data` 只依赖 `domain` 类型；UI 经 stores 调 data/services。`server/` 独立部署。

**关键实现约束**：

- `services/llm/catalog.ts` 纯元数据，不引厂商 SDK；`providers.ts` 动态 import 适配包，首屏不含 SDK。
- `services/llm/proxy.ts` 定义 `/api-proxy` 契约（头 `x-llm-proxy-target` 传目标，变量 `proxy_pass` + `resolver 127.0.0.11` 现场解析，`proxy_buffering off` 保 SSE，拒环回/私网目标防 SSRF）。浏览器直连仅保留给 `localhost`/私网推理服务。
- Store 单一真相：打开项目的全部状态在 `workspace-store`，避免跨 store 环形依赖。

---

## 9. 技术选型

| 关注点 | 选择 | 备注 |
| --- | --- | --- |
| 构建/语言 | Vite + React 19 + TypeScript + pnpm |  |
| 路由/画布 | react-router · @xyflow/react · d3-hierarchy |  |
| 状态/存储 | Zustand + Immer · Dexie |  |
| 样式/动效 | Tailwind v4 + Radix · motion |  |
| LLM | Vercel AI SDK 7（openai/anthropic/google/openai-compatible） | 工具调用与多步循环开箱 |
| Markdown | react-markdown + remark-gfm/math + rehype-katex + shiki | KaTeX 严格模式，shiki 按需加载 |
| 校验/测试 | Zod · Vitest |  |

---

## 10. 已知约束与风险（精简）

- **CORS 与代理**：已统一走同源 `/api-proxy`（字节级透传，见 §8）。升级需前后端同发，否则旧产物打不到代理。
- **数学公式渲染质量**：以 KaTeX 严格模式渲染，`$...$` 与 `$$...$$` 均支持；学术场景下不接受降级为正文字符。
- **流式中断与未捕获 AbortError**：`chat.ts: streamText` 的 `result.usage` 在浏览器会留下无人处理的 promise，中断时以 `AbortError` 拒绝；已通过 `telemetry: { isEnabled: false }` 关闭遥测规避，见 `chat.ts:74` 注释。
- **自动布局与手动拖拽冲突**：`position` 一旦写入即锁定，须显式「重新布局」才归位。
- **代码高亮包体积**：shiki 采用 `core` + 按需语言 chunk，只有用到的语言会被下载。
- **外部 .tree 项目导入**：外部格式的 `context[]` 快照会转为节点的 `contextSeed`，由上下文组装器作为「本节点建立时的上下文」注入系统提示；时间取「卡片自带 > 首条消息 > 数组顺位」以还原画布排布。
- **Provider 兼容坑**：自建中转（new-api/one-api/LM Studio）的 `tools` 与结构化输出支持参差，失败常静默（见 `services/llm/derive.ts` 中 `generateSummary` 上方的注释），Agent 侧需探测并明示「无工具模式」。

---

## 11. 实现备注（与初稿差异，保留为决策日志）

| 项 | 决策 |
| --- | --- |
| 代码高亮 | `shiki/core` + 40 语言动态 import，避免 346 chunk |
| 路由加载 | `CanvasPage`/`SettingsPage` 懒加载分包 |
| 上下文预算 | 四级降级：脉络压缩 → 丢弃 → 截断旧消息（`TRUNCATE_CHARS=480`）→ 仅留最近 `MIN_KEEP_OWN_MESSAGES=2` 条（正常尾部保留 `DEFAULT_RECENT_MESSAGES=8`） |
| 重新生成 | 仅末条 AI 消息可重生成；旧回答进版本槽 v1，笔记随消息隐藏/恢复 |
| 版本落点 | 全挂 `Node.thread`，消息表零改动，老数据线性兼容无需迁移 |
| 3 版上限 | 淘汰除新版外最早一版，递归收集消息级联删笔记；选中版被淘汰则切最新版 |
| fork 冻结 | `ForkRef.selection` 快照；版号已淘汰→取最新版，fork 点不在显示路径→退化为整条路径，继承条提示 |
| 标题更新 | 仅首条提问且标题仍为自动标题时跟随编辑更新并精修 |
| 正在生成判定 | 带 `error` 的流式状态不算生成中，输入解锁、重生成可用 |
| 删除语义 | 删/归档级联整棵子树，清消息与资产引用 |
| 账号 | 浏览器直连账号系统，token 存 `localStorage`，会话 401 先 refresh |

---

## 12. 分期（Agent 视角重排）

- **P0+P1 已交付**：项目/画布/对话/分支/图片/背景/动效/标题摘要
- **P1 同步已交付**：`server/` + 客户端 `outbox` + 自动同步（见 §13）；`Asset.blob` 不同步（P2 待排），`reviewSessions` 不进同步（本机按账号，见 §13.3）。
- **Agent P-A 已交付（只读工具）**：`search_nodes` / `get_node` / `get_tree_outline` + `list_note_labels` / `search_notes`；`fullStream` 分流；能力探测与降级；学习对话与自由问答都已接线
- **Agent P-B 已交付（标注修复，独立轨）**：`Note.kind→labels`、老数据归一化、打标签交互、修好 `buildReviewMaterial` 死代码、自由问答注入「用户标注」段、导入导出双向兼容
- **Agent P-C 已交付（写入与持久化）**：工具记录随消息落库、`toModelMessages` 一对多展开（配对不变量有单测）、压缩按完整轮次、工具卡、三个可逆写工具 + 撤销入口（按项目默认关闭）
- **未做（刻意收窄，见 Agent 文档「实现记录」）**：破坏性写工具（归档/删除）、复习流程开工具、标注清单静态注入学习对话

---

## 13. 账号与同步

### 13.1 账号（已接入）

- 服务：若依 `https://api.sakta.top`，浏览器直连（CORS 已放 `token` 头）。
- 接口：`login`/`sendCode`/`register`/`getInfo`/`refreshToken`/`logout`。
- 会话：`localStorage['sakta-token']` + `['sakta-account']` 启动即绑库（`opentreelearn:<loginName>`），首屏后台校验 401→refresh→仍败才清 token；离线保留凭据，网络恢复自动同步。

### 13.2 同步服务端（已实现，P1）

NestJS 10 + Prisma + SQLite。`records(accountId, entity, localId, rev, clientUpdatedAt, deletedAt, data JSON)` 单表多态，`accounts.revCounter` 单调游标，不信任客户端时钟。

- **鉴权**：守卫从 `token` 或 `Authorization: Bearer` 取 token，转发账号系统 `getInfo` 校验（**不共享 JWT 密钥**），结果按 token 缓存 60s；`accounts` 以 `loginName` 映射。
- `GET /api/health` 无鉴权探活
- `GET /api/sync/pull?cursor&limit` → `{cursor, hasMore, changes[]}`（含 tombstone）
- `POST /api/sync/push` last-write-wins，`stale` 回服务端版本
- `GET /api/sync/status` 账号/记录数/游标
- 上限：单条 ≤256KB，单批 ≤200 条，pull ≤1000 条（超出即 400，不静默截断）
- **开发联调**：`ALLOW_DEV_TOKEN=true`（仅非生产）时 `POST /api/auth/dev-token` 签发 `dev-<账号名>`，可绕过账号系统本地跑通全链路；开发由 Vite 把 `/lern-api` 反代到 `localhost:3901`。

坑位：`cors` 的函数式 `origin` 需回调而非同步返回，否则请求挂死（有单测锁）；守卫对外统一「Token 无效」但服务端 warn 真因。

### 13.3 客户端接入（已实现，P1）

范围：`GlobalSettings`/`Project`/`ProjectSettings`/`Node`/`Message`/`Note`（`apiKey` 不上云，`Asset.blob` 待 P2）。

| 部件 | 位置 | 作用 |
| --- | --- | --- |
| outbox | `data/dexie/db.ts` v3 | 写操作记账，合并同一记录、删除为终点、级联逐条记账 |
| 本地层 | `data/sync-local.ts` | 载荷映射、`applyRemote`（不记账防回环）、游标、首次登录搬运 |
| 协议 | `domain/sync.ts` | 与 `server/src/entities.ts` 对齐 |
| 网络 | `services/sync/client.ts` | `/lern-api` pull/push/status |
| 编排 | `stores/sync-store.ts` | 推→拉→落游标，401 刷新重试，首次登录策略，`autoSync` 节流 |
| 运行时 | `stores/sync-runtime.ts` | 登录态驱动初始化/清理，聚焦补拉，60s 巡检 |
| 分库 | `stores/data-session.ts` | 切库重载，`bindStoredAccountDatabase` 启动绑库 |
| 界面 | `features/me/SyncPanel`/`FirstLoginDialog` | 状态与首次登录三选一 |

首次登录三选一（每设备一次，记 `syncState.initialized`）：上传合并 / 以云端为准（保留本地设置行）/ 暂不同步。自动同步：已决策后静默一次，聚焦补一次，60s 巡检有变更才推，间隔 ≥120s，手动不受限。

**合并的语义**：登录后活动库就是账号库（空的），所以「上传本机数据（合并）」会先把**游客库**记录搬进账号库（`importRecordsInto`）再记账上传；同一条记录云端更新时仍以云端为准。游客库原样保留，退出登录还是那份内容；设置行只在账号库还没有设置时导入（否则本机 BYOK 密钥回不来）；图片资产没有同步通道但会一起搬（本机要能继续看图）。

复习会话不在同步范围（本机 `reviewSessions` 表），随节点同步的是掌握度/排期/开关；四条路径均需清理会话：首次登录合并（同项目两份未完成会话只留最近的一份 open，其余转 `ended` 但内容保留）、项目删除与远端 tombstone、「以云端为准」清空、换库/清库时丢弃内存会话（普通同步刷新不 reset 正在做的那一批）。

**测试**：`data/sync-local.test.ts`（记账/合并/载荷/级联/密钥保留/会话合并去重与清理）、`stores/sync-store.test.ts`（推送、增量拉取、判旧覆盖、tombstone、401 重试、三种首登策略、自动同步闸门与节流）、`stores/review-session-store.test.ts`（切账号丢弃内存会话、普通重载保留）、`stores/data-session.test.ts`（冷启动绑库三情形）。

**待办**：P2 图片资产（`Asset.blob` 走对象存储，同步体只传引用；`asset` 记录现被 `applyRemote` 跳过）；P3 冲突可见提示，以及「把游客库数据导入当前账号」（账号库已初始化时目前没有再导入入口 —— 冷启动绑库修好之前，被误写进游客库的数据只能靠它救回来）。

### 13.4 Docker 部署（已实现）

`docker-compose.yml` 起 `web`（nginx 托管 `dist`，反代 `/lern-api`→`api`，`/api-proxy`→上游）与 `api`（SQLite 卷）。`api` 不暴露宿主端口；`GET /api/health` 供 healthcheck。`prisma` 在 `dependencies` 以支持 `migrate deploy`。

`/api-proxy` 细节：目标走请求头（`$arg_*` 不解码），`resolver 127.0.0.11` 现场解析，`proxy_ssl_verify on` 默认校验，日志以 `x-llm-proxy-target` 区分上游。

---

## 14. 掌握度与复习调度（T-128）

> 详见 `docs/t128-review-experience-refactor.md`。核心：从「节点内浮条」改为独立可中断的**复习工作模式**。

### 14.1 数据模型

```ts
interface Node {
  kind?: 'topic' | 'review'
  mastery?: { score: number; weakPoints?: string[]; updatedAt: number; gradedAt?: number }
  review?: { card: ReviewCard; lastGrade?: ReviewGrade }
  reviewEnrollment?: 'enabled' | 'disabled'
  assessmentMeta?: { assessedAt?: number; basedOnStudiedAt?: number; basedOnPath?: string; source: 'ai'|'review'|'historical' }
  lastStudiedAt?: number
}
```

Dexie v4 新增 `reviewSessions` 表保障刷新恢复与事务一致。

### 14.2 掌握度与计划

- 生成摘要≠加入计划：摘要只更新摘要/掌握度/薄弱点，`reviewEnrollment: 'disabled'` 为新建默认；显式「加入复习计划」才 `seedReviewCard(now)`。
- 掌握度查看不调模型；旧数据与导入 `.tree` 兼容（有掌握度视为已加入，v2 携带事实性复习数据但不含排期与会话）。

### 14.3 复习工作模式 `?view=review`

概览（推荐 3 个到期，可选至 20，支持提前复习）→ 练习（出题/补学/提示/换问法/跳过）→ 反馈（AI 建议可覆盖，四档排期预览，确认原子落库）→ 小结（已完成/跳过/未完成与真实排期）。支持刷新恢复与撤销（下一题作答前）。

### 14.4 旧中心兼容

常规树隐藏 `kind:'review'` 节点，其后代经 `projectVisibleNodes` 投影接回可见祖先；概览提供只读历史入口。

### 14.5 自由问答（进度回顾）

复习工作区点击式流程之外，「睡前问一句今天学了什么」不该走练习。自由问答（`domain/context/free-ask.ts` 等）接回该能力但不复活节点类型：

- 入口仅概览标题行「自由问答」覆盖面板；
- 上下文 = `REVIEW_CENTER_SYSTEM` + 每次重算的学习快照 + 主题清单（标题/摘要/掌握度/创建与最后编辑时间，缩进表层级），口径写进 `DATA_LEGEND`；
- 预算不足先砍摘要再砍条数，历史超预算丢最旧但保留本轮提问；
- 三纪律：不写入节点、不影响排期、不产生评分标记；仅内存，不落库不同步。

---

## 15. 附录：术语

- **显示路径**：`resolveThread().path`，屏幕上当前版本的一条线性对话。
- **前置脉络**：`collectHistorySegments` 收集的祖先链对话，按预算压缩或丢弃。
- **版本槽**：`Node.thread.slots[slotId]`，同一提问/回答位置的至多 3 个历史版本。
- **学习快照**：`buildStudyDigest` 产出的到期/保持率/档位/薄弱点清单。
