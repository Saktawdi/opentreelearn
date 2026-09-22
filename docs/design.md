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
  forkFrom: ForkRef | null;         // 上下文继承源（含 fork 时冻结的版本选择）
  title: string;                    // 默认 = 用户首条消息；配置标题模型后自动生成
  summary?: string;                 // AI 对话摘要（卡片展示）
  contextSeed?: string[];           // 导入或初始化时携带的上下文种子（注入系统提示）
  position: { x: number; y: number } | null; // 手动拖拽后写入 → 锁定，不参与自动布局
  order?: number;                   // 同级排序（可选）
  thread?: NodeThread;              // 节点内「编辑重发 + 重新生成」的历史版本；缺省 = 线性
  status: 'active' | 'archived';
  createdAt: number;
  updatedAt: number;
}

interface ForkRef {
  nodeId: Id;
  messageId: Id;
  /** fork 时源节点 thread 的选择快照：源节点之后切版本不会悄悄改写这个子节点的上下文 */
  selection?: Record<Id, number>;
}

// 节点内对话版本。**全部挂在 Node 上，消息表一个字段都不加**：
// 老数据与导入的 .tree 没有 thread ⇒ 按 createdAt 线性解析，行为不变，无需 Dexie 迁移。
type ThreadEntry = Id | { slot: Id };

interface ThreadVersion {
  version: number;      // 单调递增、不压缩：淘汰旧版后编号保持原值
  entries: ThreadEntry[];
}

interface ThreadSlot {
  versions: ThreadVersion[]; // 按创建顺序，最多 3 版
}

interface NodeThread {
  entries: ThreadEntry[];              // 顶层顺序：消息 id 与版本槽标记混排
  slots: Record<Id, ThreadSlot>;       // slotId = 该槽锚点消息 id
  selection?: Record<Id, number>;      // slotId -> 选中版号；缺省 = 最新版
}

type Role = 'system' | 'user' | 'assistant';

interface MessagePart =
  | { type: 'text'; text: string }
  | { type: 'quote'; text: string }  // 框选后「引用到对话框」的原文片段
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
   - 节点自身消息取**显示路径**（`resolveThread().path`）：编辑重发/重新生成留下的历史版本不参与上下文，只有屏幕上当前显示的那一版会喂给模型；
   - 若 `forkFrom` 非空：从根到 fork 源节点的**路径**逐层拼接其消息，截断到 `forkFrom.messageId`（含）；fork 源节点按 `forkFrom.selection` 冻结的选择解析，fork 点已不在显示路径里时退化为整条显示路径（继承提示条上说明）。
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
| `/me` | 我的（账号登录/注册、个人背景） |
| `/settings` | 配置（BYOK、模型分配、上下文预算） |

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
- 消息悬浮操作（用户消息与 AI 消息一致）：**分支节点**（下）/ **发散节点**（横向）—— 以该条消息为 fork 点。用户消息 = 从这次提问重开，AI 消息 = 从这条回答接着往下走。
- **重新生成**：AI 消息的最后一条额外有「重新生成」—— 旧回答保留成历史版本，新回答另起一版（`<a/b>` 可切回）。中间的 AI 消息不给：后面还压着别的话，删掉等于悄悄丢历史，换答案应该从那里分支/发散。
- **编辑重发**（节点内部，不新建画布节点）：用户消息悬浮操作里的「编辑」（Pencil），或双击气泡进入编辑态。编辑态里气泡换成自动高度的 textarea，引用与图片以只读小卡保留（图片复用 `assetId`，不重传）；Esc 取消，Ctrl/⌘+Enter 或「发送」提交，内容没改动或为空时发送禁用。提交后**从这条提问处整段换一版**：旧的那段后半程整体落成历史版本，新提问 + 新回答是新版本（只改 text part，引用/图片沿用）。
- **版本切换 `<a/b>`**：画在「当前版本第一条消息」下方，只有总版数 > 1 时出现，hover 显示该版首条消息的摘要；点 `‹` `›` 在历史版本间切换，切换后横线滚进视野。每个版本槽最多保留 3 版，第 4 版上线时淘汰最早那版（含其嵌套版本与笔记）并 toast 提示。生成中禁止编辑与切版本。
- 版本语义是「从该条消息起的整段后半程」：后半程的对话是按旧版本生成的，只换一问一答会与下文对不上。
- 生成失败且一个字都没吐出来时不会有消息落库，错误挂在「这一轮」上：气泡里给「重新生成」入口，且这一轮不再算「正在生成」（不锁输入框）；预生成的回答 id 作为悬空占位从版本里摘掉。
- 节点摘要不自动重算（切版本后可能描述的是另一版），仍走节点菜单里的「生成学习摘要」手动刷新。
- **框选菜单（月牙盘）**：在消息正文里框选一段文字后，选区上方浮出一弯月牙——三枚圆形图标按钮沿弧线排开：**新建子分支节点**（在当前节点下方建分支节点，并把选中文字作为首条消息直接发出）、**引用到对话**（选中文字变成输入框顶部的引用胶囊，随下一条消息一起发出）、**复制**。菜单只在选区落在 `[data-message-id]` 气泡内时出现（输入框、画布不触发），滚动 / Esc / 点击他处即收起，顶部空间不足时翻到选区下方。
- 引用片段以 `quote` part 存在消息里：气泡中渲染为引用块，送模型时渲染成 Markdown 引用行（`> …`）并与其后的正文空行分隔；标题取用户自己打的字，只引用没打字时退用被引用的原文。
- 头部操作：新建**子节点** / 重命名 / 归档。
- 流式：逐块写入 store，节流渲染（约 50ms），可中断；消息落库在流结束后。

### 配置页

- Provider 管理：增删改（kind / apiKey / baseURL / 模型列表），连通性测试。
- 模型分配：默认对话模型、标题模型、摘要模型。
- 上下文预算：`contextBudget`，超出后压缩更早的父链对话。
- 个人背景在「我的」页维护。

### 我的页

- 账号：登录 / 注册（邮箱验证码，注册成功后自动登录）；已登录时展示头像、昵称、登录账号与邮箱，可退出登录。
- 个人背景：全局文本框（说明"每次新开空白节点都会注入"），由配置页迁来。
- 账号是同步功能的身份基础设施（见第 13 节）：云端同步本身尚未接入。

## 7. 架构分层

```
src/
  domain/      纯逻辑，不依赖 React / 存储 / 网络
    models/    实体类型定义
    tree/      树构建、路径、子树、d3 布局
    thread/    节点内版本：显示路径解析（resolve）+ 建版/切版/追加/淘汰（mutations，纯函数）
    context/   上下文组装 + token 预算
    node-ops/  三种节点动作 → 节点对象（纯函数）
  data/        Repository 接口 + Dexie 实现（未来可加 Supabase 实现）
  services/    LLM provider 适配（Vercel AI SDK）、标题/摘要、图片、账号系统客户端
  stores/      Zustand + Immer（只做状态编排，不写业务规则）
  features/    projects / canvas / chat / settings / me（UI）
  components/  通用 UI 组件
  lib/         markdown 渲染（含 shiki 高亮）、工具函数
server/        同步 BFF（NestJS + Prisma + SQLite）：账号映射 + 增量 pull/push，独立部署
```

**约束**：`domain` 不得 import `data`/`services`/`react`；`data` 只依赖 `domain` 类型；UI 通过 stores 调用 data/services。`server/` 是独立包（自己的 `package.json` / tsconfig / 测试），只通过 HTTP 契约与前端耦合，前端不 import 它的任何代码。

**Store 划分（实现）**：`settings-store`（全局配置）、`projects-store`（项目列表）、`account-store`（账号登录态）、`workspace-store`（当前打开项目的节点 / 消息 / 流式对话 / 选中态）。打开项目的全部状态放在同一个 store，避免「画布要读消息、对话要读节点」造成的跨 store 环形依赖。

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
| 重新生成边界 | 只有显示路径末条 AI 消息可重新生成（含中断/停止留下的半截回复）；用户消息与中间的回答不给，避免悄悄丢后续对话。旧回答不删，落进版本槽的 v1，笔记跟着消息一起隐藏/恢复 |
| 版本结构的落点 | 全部挂在 `Node.thread`，消息表零改动：老数据与导入的 .tree 没有 `thread` 就是线性，不需要 Dexie 迁移，`nodes` 索引不动 |
| 惰性建 thread | 首次编辑才把现存消息按 `createdAt` 排成顶层 entries；正常发送只在已有 thread 上追加，不给存量节点凭空写结构 |
| 在版本开头再次编辑 | 并进同一版本槽（追加新版本），不再嵌套：否则内外两层槽会抢同一条版本横线，外层历史将无法切回 |
| 3 版上限 | 淘汰「除新版本外最早的一版」，递归展开它的 entries（含嵌套槽全部版本）收集消息并级联删消息与笔记；被淘汰版正好是选中版时改选最新版 |
| 版本选择冻结 | fork 时把源节点 `thread.selection` 快照写进 `ForkRef.selection`；冻结版号已被淘汰 ⇒ 取该槽最新版，fork 点已不在显示路径 ⇒ 用整条显示路径，两种情况都在继承提示条上说明 |
| 显示路径的消费面 | 上下文组装、卡片摘录/消息数、`.tree` 导出、摘要 transcript、fork 默认落点、首条用户消息判断、焦点视图渲染都改走 `resolveThread().path`；`.tree` 无版本概念，属有损导出 |
| 标题随编辑更新 | 只在「编辑的是首条提问」且「标题仍等于旧消息的自动标题」时更新并触发精修；手动改名或 AI 精修过就不动 |
| 「正在生成」的判定 | 带 `error` 的流式状态表示这一轮已经收场，不算「正在生成」——输入框解锁、重新生成可用（`isStreamingIn`） |
| 删除语义 | 删除/归档均级联整棵子树；删除同时清理消息与资产引用 |
| 账号接入 | 浏览器直连账号系统（其 CORS 允许 `token` 自定义头），因此不复用 LLM 的 `/api-proxy`；token 存 `localStorage`；会话恢复 401 时先 refresh 再取用户 |
| 页面小节 | `Section` 提到 `components/ui/section.tsx`，配置页与我的页共用同一份标题/说明/间距 |

## 12. 后续（P2 候选）

- 账号：已接入若依账号系统（登录 / 注册 / 退出，见第 13 节）。
- 云同步：服务端 P1 已就绪（`server/`），客户端接入见 13.3。
- 项目导出（Markdown / JSON）、全局检索、节点合并与引用
- 首屏进一步瘦身：Markdown 渲染栈按需加载、KaTeX 字体子集化

## 13. 账号与同步

### 13.1 账号（已接入）

- 服务：若依账号系统 `https://api.sakta.top`，前端**浏览器直连**——该服务对预检已返回 `Access-Control-Allow-Origin` 与 `Access-Control-Allow-Headers: token, content-type`，受保护接口的自定义 `token` 头能通过预检，所以不需要像 LLM 那样走 `/api-proxy`。
- 已接接口：`POST /v1/user/pub/login`（form-urlencoded）、`POST /v1/user/pub/sendCode`、`POST /v1/user/pub/register?emailCode=…`（JSON 体 + 查询参数）、`GET /v1/user/pri/getInfo`、`POST /v1/user/pri/refreshToken`、`POST /v1/user/pri/logout`。文档里的 `updateInfo` / `updatePassword` / `updateAvatar` 尚未接。
- 会话：token 存 `localStorage['sakta-token']`，登录账号名存 `localStorage['sakta-account']`；**启动阶段**就用这两项把本地库绑对（纯本地读取，不联网）再载入数据 —— 登录用户刷新首页看到的就是账号库，期间的写入也落在账号库。token 是否还有效在首屏就绪后后台校验（401 先 `refreshToken` 换新 token 再取，仍失败才清掉本地 token）；网络类失败保留 token 并给「重试」，此时库仍按账号名绑着，网络恢复后自动同步照样有凭据可用。只有「本机有 token 却没记住账号名」（旧版本升上来）才需要联网确认一次，且有 1.5s 上限，离线不会卡在载入页。
- 当前只读展示昵称 / 登录账号 / 邮箱 / 头像；头像相对路径用账号服务地址补全。

### 13.2 同步服务端（已实现，P1）

后端在 `server/`：NestJS 10 + Prisma + SQLite，与 Blog 的 `sakta-bff` 同一范式（账号系统只管身份，数据落在这里）。运行与部署细节见 `server/README.md`，接口文档在 `/api/docs`。

- **鉴权**：守卫从 `token` 或 `Authorization: Bearer` 取 token，转发账号系统 `getInfo` 校验（**不共享 JWT 密钥**），结果按 token 缓存 60s；`accounts` 表用 `loginName` 做映射键。
- **存储**：单表多态 `records(accountId, entity, localId, rev, clientUpdatedAt, deletedAt, data JSON)`；`accounts.revCounter` 是账号内单调递增的修订号，pull 用它当游标——**不信任客户端时钟**（会回拨）。JSON 载荷让协议与实体解耦，客户端加字段不必动服务端迁移。
- **接口**：
  - `GET /api/health` → 存活 + 数据库连通（**无鉴权**，容器探活用；只 ping 一次库，不做业务校验）
  - `GET /api/sync/pull?cursor&limit` → `{ cursor, hasMore, changes[] }`（含 tombstone，`data` 为 `{}`）
  - `POST /api/sync/push` → 逐条 last-write-wins；判旧的回 `stale` 并带回服务端版本（`updatedAt` 相等也判旧，所以重推幂等）
  - `GET /api/sync/status` → 当前账号、有效记录数、最新游标
- **协议上限**：单条 JSON ≤ 256KB，单批 ≤ 200 条，pull 单页 ≤ 1000 条（超出即 400，不静默截断）。
- **开发联调**：`ALLOW_DEV_TOKEN=true`（仅非生产环境）时 `POST /api/auth/dev-token` 签发 `dev-<账号名>` token，可绕过账号系统在本机跑通全链路。
- **前端接入**：开发由 Vite 把 `/lern-api` 反代到 `localhost:3901`（生产同样反代即可，不必依赖 CORS）。

两个坑记在这里，避免重复踩：

- `cors` 包把**函数**形式的 `origin` 当异步回调 `(origin, callback)` 用。同步返回布尔的函数永远不调用 callback，结果是**所有请求挂死**（连接建立、零字节响应）。`createCorsOrigin()` 因此返回字符串/正则数组，并有单测锁住「不能是函数」。
- 守卫对外统一回「Token 无效或已过期」，但服务端会 `warn` 记录真实原因——否则 `RUIYI_API_URL` 配错、账号系统不可用都会被误读成用户 token 过期。

### 13.3 客户端接入（已实现，P1）

范围：**全部设置 + 学习项目数据**（`GlobalSettings` / `Project` / `ProjectSettings` / `Node` / `Message` / `Note`）；`providers[].apiKey` 不上云，图片资产走 P2。

| 部件 | 位置 | 作用 |
| --- | --- | --- |
| 变更台账 | `data/dexie/db.ts` 的 `outbox` 表（v3） | 所有写操作经仓储层记账：同一条记录反复改合并成一条、删除是终点、级联删逐条记账。push 时按 `entity + localId` 读**当前**记录内容，中间态不上传 |
| 本地同步层 | `data/sync-local.ts` | 载荷映射（设置抹掉 apiKey）、`applyRemote`（不记账，避免回环）、游标与状态、首次登录搬运游客数据 |
| 协议类型 | `domain/sync.ts` | 与服务端 `server/src/entities.ts` 对齐的实体名与线上形状（放 domain 是因为 data 层也要用，而 data 只能依赖 domain） |
| 网络层 | `services/sync/client.ts` | `/lern-api` 下的 pull/push/status；信封解析与账号客户端共用 `services/api/envelope.ts` |
| 编排 | `stores/sync-store.ts` | 推增量 → 拉增量 → 落游标；token 过期先刷新再重试一次；首次登录策略；`autoSync` 自动同步（四道闸门 + 节流） |
| 运行期接线 | `stores/sync-runtime.ts` | 挂一次：登录态变化驱动同步初始化 / 清理；窗口聚焦补一次；待推变更巡检（默认 60s，只在有变更时发请求） |
| 分库 | `stores/data-session.ts` | 登录/退出/恢复会话时切库并重载 store（`opentreelearn:<loginName>`，游客用默认库）；`bindStoredAccountDatabase()` 供启动阶段纯本地绑库；换库时丢弃内存里的复习会话 |
| 界面 | `features/me/SyncPanel.tsx`、`FirstLoginDialog.tsx` | 状态（待同步 N 项 / 上次同步 / 失败原因）+ 立即同步；首次登录三选一（挂在 `AppShell` 上，哪一页登录都能看到） |

**合并的语义**：登录后活动库就是账号库（空的），所以「上传本机数据（合并）」会先把**游客库**的记录搬进账号库（`importRecordsInto`），再记账上传；同一条记录云端更新时仍以云端为准。游客库原样保留，退出登录后还是那份内容。设置行只在账号库还没有设置时导入，图片资产没有同步通道但会一起搬（本机要能继续看图）。

**复习会话不在同步范围内**（T-128）：它是本机、按账号的数据（Dexie v4 的 `reviewSessions` 表），不新增同步实体，也不承诺跨设备接着做；随节点同步的是掌握度、排期与计划开关。四条路径都要正确处理这张表：首次登录合并时一起搬（同项目出现两份未完成会话则只留最近的一份 open，其余转 `ended` 但内容保留）、项目删除（本地与远端 tombstone）级联清理、「以云端为准」清空。会话只在换库 / 清库时从内存丢弃，普通同步刷新不 reset 正在做的那一批。

**首次登录策略**（每台设备问一次，决策记在账号库的 `syncState.initialized`）：
- 上传本机数据（合并）：搬 + 推 + 拉，推荐
- 以云端为准：清空本机实体、台账与会话（**保留设置行**，否则本机 BYOK 密钥再也回不来），游标归零后整库重拉
- 暂不同步：只落决策，变更仍留在 outbox，之后手动同步照样推

**自动同步的触发时机**（`useSyncRuntime`，挂在 `AppShell` 上）：启动完成且已决策过 → 静默同步一次；窗口重新聚焦 / 切回标签页 → 补一次；每 60s 巡检本机待推变更，有才推。两次自动同步之间有 120s 最小间隔（失败也进窗口，避免聚焦一次就重试一次），手动「立即同步」不受此限制；未决策首次登录策略时不自动动手，等用户选。以前同步只在进「我的」页时触发，首页放一天也不会拉一次云端变更。

**测试**：`data/sync-local.test.ts`（记账/合并/载荷/级联/密钥保留/复习会话的合并去重与清理）、`stores/sync-store.test.ts`（用服务端替身跑推送、增量拉取、判旧覆盖、tombstone、401 重试、三种首登策略、自动同步的闸门与节流）、`stores/review-session-store.test.ts`（切账号丢弃内存会话、普通重载保留）、`stores/data-session.test.ts`（冷启动绑库的三种情形）。

**待办**：
- P2：图片资产 —— `Asset.blob` 走对象存储，同步体只传引用，`asset` 记录现在会被 `applyRemote` 跳过。
- P3：冲突可见提示、以及「把游客库数据导入当前账号」（在账号库已初始化时目前没有再导入的入口 —— 冷启动绑库修好之前，被误写进游客库的数据只能靠它救回来）。

### 13.4 Docker 部署（已实现）

根目录 `docker-compose.yml` 起两个容器：`web`（nginx 托管前端 `dist`，把 `/lern-api` 同源反代到 `api`）与 `api`（同步服务 + SQLite 命名卷）。api 不发布宿主端口，浏览器走同源路径、不依赖 CORS；容器入口先 `prisma migrate deploy` 再起服务，迁移失败即退出。`GET /api/health`（无鉴权）供 healthcheck 探活，顺带 ping 数据库。`prisma` CLI 因此进了 `dependencies` —— `--prod` 安装也要带上迁移能力；安装用的 pnpm store/cache 在同一构建层里删掉，否则镜像会多出约 350MB。命令、备份与镜像体积见 `server/README.md`。

## 14. 掌握度与复习调度（T-128 重构）

> 掌握度与复习体验经 T-128 重构方案（详见 `docs/t128-review-experience-refactor.md`）
> 进行全面升级：从原先的「聊天节点内挂载浮条」改为主工作区内独立、可中断恢复的
> **复习工作模式（`/p/:projectId?view=review`）**。
>
> 核心改进：
> 1. **独立复习工作区**：概览候选、自动出题与补学、反馈与四档预览、确认与小结；
> 2. **计划与评估解耦**：生成摘要不偷偷加入计划，新建节点显式 `reviewEnrollment: 'disabled'`；
> 3. **本地原子评分与撤销**：Dexie v4 新增 `reviewSessions` 表，评分操作事务性写入节点、台账与会话，支持在未产生下一题交互前撤销；
> 4. **旧中心兼容投影**：旧 `kind: 'review'` 节点在常规学习树中隐藏，其普通学习后代自动重定向至最近可见祖先，历史记录提供只读查阅入口；
> 5. **弱化提醒与按需热力**：移除聊天流内频繁插话的 ReviewNudge，取消首页重复 toast，热力图支持在画布按需开启。

### 14.1 数据模型与存储

`Node` 结构扩展：

```ts
interface Node {
  kind?: 'topic' | 'review'   // 缺省 = 普通学习节点；review = 历史复习中心
  mastery?: {
    score: number             // 0-100，用于展示与排序
    weakPoints?: string[]     // ≤3 条，只做出题材料
    updatedAt: number         // AI 评估快照时间（过期判定的基准）
    gradedAt?: number         // 最近一次复习评分的时间
  }
  review?: {
    card: ReviewCard          // FSRS 卡片
    lastGrade?: ReviewGrade   // 最近一次评分档位
  }
  reviewEnrollment?: 'enabled' | 'disabled' // 显式复习计划开关
  assessmentMeta?: {
    assessedAt?: number       // 最近一次 AI 评估时间
    basedOnStudiedAt?: number // 评估依据的学习时间
    basedOnPath?: string      // 评估依据的对话路径指纹
    source: 'ai' | 'review' | 'historical'
  }
  lastStudiedAt?: number      // 显示路径末条消息的 createdAt
}
```

Dexie v4 新增 `reviewSessions` 表，用于存放本机会话、草稿、阶段状态与确认结果，保障刷新恢复与事务一致。

### 14.2 掌握度与计划管理

- **生成摘要与加入计划分离**：点击「生成学习评估」只更新摘要、掌握度分数与薄弱点；用户在详情中明确点击「加入复习计划」才以当前时间初始化 FSRS 卡片；
- **掌握度查看不调模型**：点击节点头部的状态徽标只打开详情弹窗，展示依据与薄弱点，绝不隐式触发消耗 token 的模型调用；
- **旧数据与导入兼容**：导入的 `.tree` 默认标记 `reviewEnrollment: 'disabled'`，防止导入历史树堆积虚假逾期；旧本地节点缺开关但有掌握度时兼容为已加入。

### 14.3 复习工作模式（/p/:projectId?view=review）

- **概览（Overview）**：默认推荐 3 个到期主题，支持勾选调整（单批最多 20 个），支持次级展开提前复习主题；
- **练习（Practice）**：自动出题或进入关键点补学；支持提示、换问法、暂时想不起来与跳过；
- **反馈与评分（Feedback）**：AI 建议可覆盖，四档真实排期预览，明确点击「确认并继续」后原子落库；
- **恢复与撤销（Resume & Undo）**：浏览器刷新、稍后继续离开后可无损恢复同一题；在下一题未作答前支持撤销评分；
- **小结（Summary）**：如实列出已完成数、跳过数与未完成数，展示真实下次到期排期。

### 14.4 旧复习中心兼容

- 常规树上不再呈现 `kind: 'review'` 节点，不创建新的中心节点；
- 挂在旧中心下方的普通学习子树通过 `projectVisibleNodes` 投影接回可见祖先，内容与学习关系完整保留；
- 复习概览提供次级「查看旧复习中心历史记录」弹窗，只读回溯过去的复习消息。