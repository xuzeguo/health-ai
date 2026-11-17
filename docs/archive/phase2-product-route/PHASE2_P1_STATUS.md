# F02-P1 状态

> 历史基础设施状态。当前二期开发以 [`PHASE2_LEARNING_PLAN.md`](../../PHASE2_LEARNING_PLAN.md) 为准；不继续扩展本文件中的通用 workflow 目标。

日期：2026-11-17。P1 基础契约与最小 workflow 验证路径已完成，尚未进入 P2。

| 条件 | 状态 | 证据 |
| --- | --- | --- |
| P1-01/P1-02 | 已完成基础实现 | `schema_migrations`、schema SHA-256 重复校验；一期表保留 |
| P1-03/P1-04 | 已完成 | `ConversationTaskRegistry` owner-only release 与关闭拒绝新任务；契约测试 |
| P1-05 | 已完成骨架 | `AiProvider` 端口区分 text/tool 终态；契约测试 |
| P1-06 | 已完成骨架 | v2 workflow envelope 校验 version、identity、sequence；契约测试 |
| P1-07 | 已完成基础实现 | `WorkflowRepository.createOrGet` 按 requestId 与 digest 幂等对账；`POST /api/workflows` 与 `GET /api/workflows/by-request/:requestId` 提供最小创建/查询入口；不同摘要拒绝 |
| P1-08 | 已完成最小路径 | workflow run 创建、终态单向更新、启动时 `running -> interrupted` 恢复；最小 SSE 生命周期写入 completed，尚未覆盖完整业务增量流 |
| P1-09 | 基础边界已验证，异步场景未实现 | ChatService 关闭后 registry 拒绝新任务；workflow finally 释放占位；既有错误日志测试确认不泄漏正文、SQL、headers。当前 workflow 是同步无模型 smoke path，因此真实异步上游取消与迟到回调保护留到业务 workflow 接入时验证 |

已执行：`pnpm test`（126/126）、`pnpm typecheck`、`pnpm build`，全部通过。新增路由测试覆盖标准 SSE 帧、v2 envelope、completed 持久化、非法输入和 digest 冲突；既有错误测试覆盖敏感日志边界。当前 SSE 仍是无模型的最小验证路径。

P1 的基础契约可作为后续实现入口，但在真实异步 workflow 的取消、迟到回调和敏感标记全链路审计补齐前，不进入 P2；报告上传、工具、RAG 和组合界面不在本阶段。
