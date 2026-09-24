# 复习中心 Agent 升级（已落地）

2026-09 完成复习工作区从「静态上下文 + 6 种 purpose 散文规则」到「窄 agent + 交付工具」的升级。四个阶段对应四个提交（62b618d 基线之后）。

## 动机

跨轮一致性（补学结尾不出题、提示锚定当前题、反馈以当前题为准）原本靠 purpose 规则文案互相引用维持，交互种类是 N、契约是 O(N²)，漏一处就出「两道题打架」类缺陷。`[[rating:...]]` 标记解析协议是散文模式的补丁。升级后契约搬进**工具 schema 与代码守卫**，产物从散文变成结构化事件。

## 交付工具（4 个）

| 工具 | 守卫（domain/review/delivery.ts） | 落库 |
|---|---|---|
| `teach_key_points` | 补学起点，或反馈轮内已有回答（`afterFeedback`） | `relearn` 消息（含 keyPoints）；起点 → relearning，反馈轮补讲 → feedback |
| `pose_question` | 无开放题；`rephraseOf` 必须指向当前开放题；重问需先点评 + 档位 again/hard + 至多 2 次 | `question` 消息；answering |
| `give_hint` | 存在开放题 | `hint` 消息；阶段不变 |
| `submit_feedback` | 最后一条用户消息是回答/追问 | `answer`/`followup` 消息 + `selectedGrade` 预选（**不碰排期**）；feedback |

核心不变量：**当前题 = 转录里最后一道未被回答的 question 消息**（`currentOpenQuestion`）。守卫、题目卡渲染、评分锚定三处共用这一个推导。

## 检索工具（6 个，全只读）

`search_notes` / `search_nodes` / `get_node` / `get_review_history` / `get_tree_outline` / `list_note_labels`。前四个走**作用域绑定**：

- 复习运行时传 `retrievalScope = 框选主题 ∪ 祖先路径`（每次请求现算）；对话 / 自由答不传，行为与升级前逐字节一致。
- 默认拿不到作用域外的数据；跨出必须显式 `widen`，命中带 `scope: 'other'` 来源标注 + "仅可作为参照" 声明。**考与判只发生在框选节点上** —— 默认看不到就考不了，这是结构性保证；语义层残余靠 widen 的 schema 纪律与活动行透明度兜底。
- `get_tree_outline`（仅标题）与 `list_note_labels`（仅统计）无内容泄漏，保持全项目。
- `get_review_history` 数据源是历史会话文档（`domain/review/history.ts` 纯函数），确认/跳过如实成行，进行中的项不产生行。

## 状态与持久化

- **落库同构**：工具产物以与升级前相同的消息形态（role/purpose）写进会话文档，文档 schema 不破坏性变更；旧会话（含 `[[rating:...]]` 散文）零迁移，`stripReviewRating` / `suggestionFromMessages` 仅保留兼容读取。
- **phase 从转录推导**（`phaseFromTranscript`）：合并轮次后一轮可有多条交付，阶段是整条转录的函数，每条交付落库后重算。
- **交付即落库**：中断时已交付的卡片保留，只重试未完成部分。
- **判分边界不变**：排期写入仍是确认按钮 → `gradeReview`（operationId 幂等）→ 撤销从 base 快照重算；agent 只建议档位。

## 能力门控与回退

- `capabilities.tools === false` 的 provider 直接走**回退散文路径**（`PURPOSE_RULES`，已冻结不再演进）；未探测的先试工具、失败降级重试一次（与学习对话同一模式）。
- 回退路径是否最终删除，由实际命中占比数据决定，暂不拍板。

## UI

用户可见交互链路不变（补学卡 → 确认 → 题目卡 → 提示卡 → 回答 → 反馈卡 → 确认）。新增：检索活动行（"查了标注 · 看了复习记录"）、旁白直播（`delivered` 后让位给正式卡片且不落库）、反馈轮补讲卡标「补学」。

## 残余风险（诚实清单）

- "题目文本实际考了什么"是语义层，代码验不了；防线是默认作用域 + widen 纪律。
- 反馈轮合并引入行为方差（不该补讲时补讲）—— 档位约束 + 重问上限 + maxSteps=4 收敛。
- 双模式（agent + 回退）并存是阶段 1~4 的既定成本。
