# Feature 01 验收证据 A01–A21

更新日期：2026-11-15。对应原可行性评估的编号；原规划文件不修改。P0–P6 及 A01–A21 全部通过，Feature 01 本地桌面 Web MVP 已实现并验收。

本地全量结果：105/105 测试、类型/生产构建、结构、冻结锁文件一致性通过。真实 DeepSeek 与基础 UI 的证据来自已核验的 P2/P4/P5 用户本机报告及人工确认。最终 P6 报告时间 2026-11-15T09:54:54.464Z、Node 22.21.1、passed:true、stage:complete，11 项检查通过，59 个来源哈希与当前源码全部一致。此前浏览器阶段失败及脚本修订保留于 VALIDATION 历史记录。

| 编号 | 验收点 | 状态 | 执行证据与范围 |
| --- | --- | --- | --- |
| A01 | 工程与依赖 | 通过（当前环境） | P1 用户完成真实安装，Node 22.21.1/pnpm 10.26.0；P6 冻结锁文件一致性、105 项测试、类型、生产构建通过。未宣称在另一台全新机器执行安装 |
| A02 | 真实模型与 thinking | 通过 | server `provider.test.ts` 请求体序列化；P2 `provider-smoke-result.json` 与 P4/P5 真实调用：deepseek-flash、thinking disabled、reasoningLength=0、正常 done |
| A03 | 会话 CRUD | 通过 | server `conversations.test.ts`、`repository.test.ts`：精确契约、404、级联、更新排序；P5 真实 HTTP 隔离/删除通过 |
| A04 | 连续五轮 | 通过 | server `context.test.ts`；P5 报告真实 5 轮/8 项，实际 Provider 上下文 2/4/6/8/10、本轮 user 恰一次，第二/四/五轮回忆代号 |
| A05 | 超过历史窗口 | 通过 | server `context.test.ts`、`repository.test.ts`：排除本轮后限制最近 20 条 completed、同毫秒稳定顺序 |
| A06 | SSE 任意分片 | 通过 | web `chat.test.ts`：CRLF 每种切分、UTF-8 中文/emoji 单字节、多帧/多 data/注释；不丢不重 |
| A07 | 正常完成 | 通过 | server `chat-stream.test.ts`、`faults.test.ts`：提交后才 delta/complete，提交失败无假成功；P4/P5 真实 GET 一致/刷新人工确认 |
| A08 | 用户停止 | 通过 | server `chat-stream.test.ts`、web `chat.test.ts`；P4 真实取消保留内容，P4/P5 浏览器停止/切换人工确认 |
| A09 | 浏览器断开 | 通过 | P4 真实 TCP/fetch 断开与 provider abort、本地锁/计时/监听回归通过；P6 独立子进程的真实 TCP 断开及慢读后的取消/锁释放通过 |
| A10 | 上游中断/无终止 | 通过 | server `provider.test.ts`、`chat-stream.test.ts`；web `chat.test.ts`：截断/EOF failed、片段保留、前端拒绝假成功、不重发 POST |
| A11 | 建连/内容超时 | 通过 | server `provider.test.ts` SDK 建连 timeout；`faults.test.ts` 首内容前与部分输出后 timeout；`chat-stream.test.ts` reasoning 不续期、content 续期、静默 iterator 可取消 |
| A12 | 配置/限流错误 | 通过 | server `provider.test.ts`、`faults.test.ts`：真实 SDK 注入 transport 401/403→CONFIG_ERROR，429→RATE_LIMITED，每例仅一次调用、SSE 安全错误与 failed |
| A13 | 非法入参 | 通过 | server `chat-stream.test.ts`、`conversations.test.ts`：trim 后空、8000 限制、ID/不存在/未知字段、非法 JSON/类型；SSE header/原子插入前拒绝 |
| A14 | 同/跨会话并发 | 通过 | server `chat-stream.test.ts`；P4/P6 真实连接同会话 POST/DELETE JSON 409、跨会话独立生成通过 |
| A15 | 切换与删除 | 通过 | web `conversations.test.ts`：延迟 GET/旧流隔离、取消等待、409；P5 用户确认新建/切换/删除取消与确认/末项删除全部通过 |
| A16 | DB 写失败 | 通过 | server `faults.test.ts`、`repository.test.ts`、web `chat.test.ts`：真实 SQLite trigger 故障、无虚假 complete、保留已提交/已显示前缀、上游先 abort、错误脱敏 |
| A17 | 崩溃恢复 | 通过 | server `lifecycle.test.ts` 实际独立 SQLite 进程 SIGKILL/重启；用户本机 P6 第 7 项“收到 HTTP 增量后 SIGKILL”通过，中文/emoji 已提交片段保留并 streaming→failed |
| A18 | Markdown 安全 | 通过 | web `rendering.test.ts` 恶意样本与 highlighter 抛错转义通过；P6 Chrome 使用真实渲染器的 DOM/执行检查：XSS=false、活动危险元素 0、安全链接通过 |
| A19 | Key 隔离 | 通过 | 随机合成 Key 环境下 4 个生产/浏览器产物、全部捕获进程输出扫描通过；真实 Chrome 5 次 API 请求无 Key/Authorization，stream 仅含 conversationId/message |
| A20 | 收尾竞态和资源 | 通过 | server `lifecycle.test.ts` 40 次 complete/close、50 次监听清理、同步 return/header 异常、shutdown 后拒绝新生成通过；用户本机 P6 实际 TCP 背压与活动生成 SIGTERM 退出通过（最大缓冲 65877 字节、退出 7ms） |
| A21 | 基础 UI | 通过 | P4 用户确认输入法/发送换行/刷新/停止；P5 用户确认侧栏/Markdown/高亮/上滚暂停/回到底部/状态等新增交互；策略另见 web `rendering.test.ts` |

上表 server 测试路径均相对 `apps/server/test/`；web 测试相对 `apps/web/test/`。历史验收报告保存于 `docs/`，忽略入库；接受报告时均已核对来源哈希（P2 8 个、P4 33 个、P5 36 个）。报告正文/Key 不进入本证据表。P6 的合法修订不要求历史哈希永久相同。

## 最终关卡（已通过）

```sh
pnpm verify:p6
```

在本机项目根执行。所有模型为受控本地 fixture，真实模型请求 0 次，临时 SQLite/随机回环端口/新 Chrome 配置，不修改日常库或现有浏览器配置。细节及 Chrome 路径设置见 README 的 P6 一节。

最终报告已回读核验：passed:true/stage:complete、11 项检查完整、59 个来源哈希一致、进程清理成功；WORK_PLAN 的 P6-04 已勾选，A18/A19 已更新为通过。browserDiagnostics 全部符合预期（completedRequests=5、step=7），最大写缓冲 65877 字节、SIGTERM 退出 7ms，真实模型请求 0。无需重复验收。该脚本不重新验证真实模型质量或人工 UI 体验，使用已接受的 P2/P4/P5 证据。
