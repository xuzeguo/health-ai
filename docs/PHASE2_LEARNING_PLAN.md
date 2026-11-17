# Feature 02 AI 技术学习开发计划

版本：2.0  
日期：2026-11-17  
状态：当前唯一有效的二期方向

## 1. 目标

二期的目标是通过一个小型本地 Web 演示项目，跑通并理解以下 AI 应用技术：

1. Prompt Engineering
2. JSON mode + Zod 结构化输出
3. Function Calling
4. RAG（文档切分、Embedding、检索、引用）
5. SSE 流式响应
6. Human-in-the-loop
7. LangChain 组件组合

重点是可观察、可测试、可解释的学习过程。项目不追求完整健康产品，不实现 OCR、复杂报告上传、通用 Agent 平台或生产部署。

## 2. 当前基线

- Feature 01 本机聊天 MVP 已完成并验收；其聊天 API、SSE、SQLite、取消、恢复和安全 Markdown 契约必须保持兼容。
- Feature 02 P0 技术实验已完成：DeepSeek JSON mode + Zod、Function Calling、LangChain、macOS 本地 Embedding、SQLite 向量检索和证据判定均有工程样本。
- P0 的图片/OCR实验只作为历史能力验证，不进入当前产品路线。
- 现有 P1 workflow、`workflow_runs` 和 v2 envelope 是早期基础设施实验；不继续扩展成通用 workflow 引擎，后续只保留能服务学习目标的最小代码。

## 3. 非目标

- OCR、PDF、批量报告和任意设备模板；
- 医疗诊断、处方、自动确认或自动修改正式健康记录；
- 多用户、账号、权限、公网部署和分布式任务；
- LangGraph、开放式 Agent、多 Agent、通用编排平台；
- 为未来可能的功能提前增加实体、事件表或复杂恢复系统；
- 真实模型调用自动加入离线测试。

## 4. 最小数据实体

一期已有 `conversations/messages`，继续复用。二期只在实验确实需要时增加：

| 实体 | 触发条件 | 用途 |
| --- | --- | --- |
| `documents/chunks` | 开始 RAG 阶段 | 保存知识来源、切片和索引状态 |
| `drafts` | 开始 HITL 阶段 | 保存待用户确认的结构化草稿 |
| `measurements` | 明确需要展示确认结果时 | 保存用户确认后的演示数据 |

`workflow_runs`、`workflow_events`、通用任务状态表不是当前必需实体。组合实验优先使用内存对象和已有消息/SSE；只有测试证明持久化确实必要时才提出变更。

## 5. 开发阶段

### L0：学习入口与实验约定

交付：本计划、实验目录约定、每个实验的输入/预期/失败案例模板。  
验收：用户能从一期导读理解一次聊天和 SSE 生命周期。

### L1：Prompt 与结构化输出

交付：版本化 prompt、固定 JSON 输出、Zod 校验、非法 JSON/缺字段/类型错误测试。  
实现：JSON mode + Zod；不采用当前实测返回 400 的原生 JSON Schema 请求。  
实体：无需新增数据库实体。

### L2：Function Calling

交付：一个只读工具，例如 `get_latest_measurement`；模型请求工具，服务端校验参数并执行，结果回传模型。  
验收：未知工具、非法参数、越权写操作和工具结果注入全部拒绝；至少一轮工具调用后得到流式回答。  
实体：可先使用固定合成数据或内存数据，不为工具提前增加复杂表。

### L3：RAG

交付：Markdown/TXT 导入、切分、Embedding、Top-K 检索、来源引用和无证据回答。  
验收：有答案、无答案、相似但不支持问题均有固定评测；删除文档不会出现在新检索结果。  
实体：仅增加 `documents/chunks` 或等价的最小本地存储。

### L4：Human-in-the-loop

交付：模型生成结构化草稿，用户查看、修改、确认或拒绝；确认前不产生正式结果。  
验收：刷新可找回草稿、重复确认幂等、版本冲突拒绝、拒绝不写正式数据。  
实体：仅在需要跨刷新时增加 `drafts`；不实现 OCR 报告。

### L5：LangChain 对比实验

交付：用 LangChain 重写一条已经用原生 SDK 跑通的链，比较 Prompt、结构化输出、工具、检索和取消语义。  
验收：项目 AI port 与 LangChain 行为一致；框架不接管数据库、权限或生命周期。  
实体：无需新增。

### L6：最小组合演示

交付：一个薄的 `AnalysisService`，按需组合 RAG、Function Calling、结构化输出、SSE 和 HITL。  
流程：问题 → 可选工具 → 可选检索 → 结构化草稿/回答 → SSE → 用户确认。  
验收：每一步可观察，失败可解释，引用真实存在，用户确认是唯一正式写入入口。

## 6. 测试门槛

每阶段都遵循：先写测试条件和固定 fixtures，再写失败测试，再实现，再运行：

```sh
pnpm test
pnpm typecheck
pnpm build
```

真实模型请求只用于明确的抽样实验，记录调用次数和 usage，不加入 `pnpm test`。每阶段必须测试成功、非法输入、边界、取消/超时、资源清理和敏感信息泄漏。阶段状态记录在对应文档中；未执行或环境阻塞不得标为通过。

## 7. 当前下一步

暂停继续扩展旧 workflow 基础设施。下一项工作是 L1：先写 Prompt/JSON/Zod 实验规格和离线合同测试，再实现最小结构化输出实验。L1 完成并验收后才进入 L2。

