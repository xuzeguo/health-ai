# 一期执行决策

日期：2026-11-15。用户已授权开始实现，按评估文档中的最小修订推进；以下不改变公共接口、SSE 事件名、数据库字段或技术栈。

## 1. 冲突处理

| 项目 | 执行口径 |
| --- | --- |
| SDK 扩展参数 | Node 请求体顶层 `thinking: { type: "disabled" }`；不使用 Python 风格 extra_body；局部扩展类型，不使用全局 any |
| 模型与重试 | 默认 deepseek-flash；备用模型仅注释预留；SDK 显式 maxRetries: 0；不重试 POST，不实现 fallback |
| 断开监听 | 响应流 close 加完成标志；不把 request body 读取完当作 SSE 客户端断开 |
| 数据保留 | 增量批次先落库后发送；完成先提交再发 complete；保证不主动清空已生成内容，不承诺磁盘失效时绝对不丢数据 |
| 批次与输出上限 | 初始批次 75ms 或 1024 字节；max_tokens=4096；长度截断标为 failed 并提示已有上游错误码，不伪装完整回答 |
| 超时 | 从上游调用前开始计 60s；每次 content 增量重置；心跳/reasoning 不重置；超时为 failed + UPSTREAM_TIMEOUT |
| 乐观消息 | 请求前插入临时消息；400/404/409 等前置失败回滚；start 绑定 assistant ID；终态用原 GET 详情校准 |
| Repository | 允许增加内部 getMessages、createTurn 等必要方法；所有 SQL 留在 Repository；不新增公共接口或 DB 字段 |
| 历史窗口 | 排除本轮 user ID，取最近 20 条 completed，再恢复正序；毫秒同值按内部 rowid 排序；当前 user 最后恰一次 |
| 状态恢复 | user 创建为 completed；assistant streaming→completed/failed/cancelled；启动将遗留 streaming 改 failed，保留正文 |
| 并发与删除 | 同会话在首次 await 前占位；未收尾返回 409；生成中删除返回现有 CONVERSATION_BUSY，停止后重试 |
| 前端竞态 | composable 私有保存任务 Promise/序号与 AbortController；不增 Store 公共字段；旧任务不能写入新会话 |
| SSE 解析 | TextDecoder.decode(chunk, {stream:true})；跨 chunk 缓冲；忽略心跳；无终止帧 EOF 为失败；支持中文/emoji 和 CRLF |
| 阶段验收冲突 | P1 只验空 ChatView 和独立启动；会话 GET 移至 P3；不实现临时非流式 API 或假业务接口 |
| 编码顺序 | 按 WORK_PLAN.md 串行，基础取消随 P4 生命周期实现，P6 进行完整故障验证 |

## 2. 工程与依赖

- Node：22.x；pnpm：10.26.0（packageManager 固定）。其余主版本遵循 v2。
- 运行依赖：Vue 3、Pinia 3、vue-router 4、Element Plus 2、Fastify 5、openai 7、Zod 4、better-sqlite3 12、markdown-it 14、highlight.js 11；统一在 P1 完成依赖安装，业务仍按阶段实现。原因：自动化环境无外网，需要减少用户重复安装次数。
- 构建/运行工具：TypeScript 5、Vite 7、匹配 Vite 7 的 plugin-vue 6、tsx 4、vue-tsc 3、必要 @types 包。
- 自动导入两工具首次解析后已固定：unplugin-auto-import 21.1.0、unplugin-vue-components 32.1.0；不保留浮动 latest。
- shared 源码直接引用，通过 workspace 依赖与 exports 解析；没有单独 build，不用 tsconfig paths 假装运行时模块解析。
- server 本期以 tsx 执行源码；不承诺 tsc 输出可独立部署。类型检查执行 tsc --noEmit，web 由 vue-tsc 和 Vite 检查构建。
- 数据、.env、构建产物、node_modules 不提交；不复制其他项目的 lockfile，不手工伪造锁文件。

## 3. 环境、测试与交付

- 所有数据相对项目根路径解析；根目录由服务器 env.ts 的 import.meta.url 定位，启动工作目录不影响 DB/.env 路径。
- 使用 Node 内置 process.loadEnvFile，不增 dotenv；已存在进程环境变量优先，本地 .env 不覆盖它们。
- 后端默认仅监听 127.0.0.1:3000；Vite 仅监听本机，proxy /api；不新增 CORS 依赖。
- 环境校验允许有效格式的占位 Key 启动骨架，但独立真实调用脚本必须拒绝占位值。应用启动绝不自动调用模型。
- 日志只打印脱敏错误码与必要 ID，不输出 .env 值、上游 header、用户健康正文和模型全文。
- 测试使用 node:test、assert、Fastify inject、临时 SQLite、本地 mock HTTP；真实 HTTP/进程验证断连与崩溃恢复；浏览器交互单独验收。
- 配置/依赖/构建验证不通过时停在当前阶段，允许完成同阶段内不依赖外部状态的任务；不提前写下一阶段业务。
- 2026-11-15 npm registry DNS ENOTFOUND：依赖元数据未核对，记入 P1-07；尚未证明目标依赖已可安装。

## 4. 变更记录

| 日期 | 内容 |
| --- | --- |
| 2026-11-15 | 冻结一期最小执行口径；下一步 P1 骨架；依赖在线核验受 DNS 阻塞 |
| 2026-11-15 | 用户完成首轮安装；固定自动导入工具实装版本；测试改为 node --import tsx，避免 CLI 不必要的 IPC 端口；将已选定依赖统一纳入 P1 安装，不提前实现业务 |
| 2026-11-15 | P1 本机报告通过且来源核验一致；仅验收脚本禁用 optimizeDeps 与 WebSocket，成功报告在清理结束后输出；正式 Vite 配置不改 |
| 2026-11-15 | P2 在不能监听端口的环境采用 SDK 官方可注入 fetch + 实际 Response/SSE 进行协议验证，不新增依赖；真实 DeepSeek 测试仍为独立必过关卡 |
