# 验证记录

日期：2026-11-15。以下只记录实际执行结果；未运行的测试不标为通过。

最新结论：P0–P6 全部通过，Feature 01 本地桌面 Web MVP 已完成验收。最终 P6 报告 2026-11-15T09:54:54.464Z、passed:true/stage:complete、11 项检查、59 个来源哈希一致；105/105 测试、类型/构建/冻结锁文件通过。下方按阶段保留历史限制、失败与解决记录，最终证据见文末及 ACCEPTANCE.md。

## P0 / P1 已执行

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| 实施计划与规格记录 | 已创建并回读 | `WORK_PLAN.md`、`docs/reference/DECISIONS.md` |
| 独立 Git 仓库 | 通过 | `git init -b main`；未提交，也未修改全局 Git 配置 |
| 工程结构检查 | 通过 | `node scripts/check-scaffold.mjs`；workspace 引用、shared 零依赖、必要路径和忽略规则 |
| shared 类型检查 | 通过（临时已有工具） | 用相邻项目已存在的 TypeScript 5.9.3 执行 `tsc --noEmit -p packages/shared/tsconfig.json`；没有复制或修改该项目；完整项目安装后须以本项目编译器重验 |
| TS / Vue script 语法检查 | 通过 | 临时 TypeScript 5.9.3 transpileModule 检查 12 个语法单元，0 个语法错误；不等于模板检查、模块解析或完整类型检查 |
| .env/data/node_modules/dist 忽略 | 通过 | `git check-ignore`；`.env` 未进入 git status |
| 本地 .env 创建与权限 | 通过 | 从 example 独占创建，不覆盖已有文件；权限 0600；没有输出密钥内容 |
| 原规划文件保持不变 | 通过 | 两份输入文档 SHA-256 与评估时一致 |

## 首轮安装前的阻塞（历史记录）

| 项目 | 状态 | 具体证据 / 后续步骤 |
| --- | --- | --- |
| Node 运行时选择 | 已识别差异，使用已有 Node 22 | 父目录执行环境为 Node 22.21.1；直接以新项目为 workdir 的 shell 曾使用系统 Node 24.12.0，触发 engines 保护；随后在父目录用 pnpm --dir health-ai 调用，进入依赖解析阶段。项目包含 .nvmrc/.node-version，未更改系统 Node |
| npm 版本元数据 | 阻塞 | `pnpm view openai@7.0.0 ...` → `ENOTFOUND registry.npmjs.org` |
| pnpm install | 阻塞 | 使用 Node 22 执行 `pnpm --dir health-ai install --fetch-retries=0 --fetch-timeout=10000 --reporter=append-only`，多包均 `ERR_PNPM_META_FETCH_FAIL / ENOTFOUND` |
| pnpm-lock.yaml | 未生成 | 依赖尚未解析成功，不手工伪造 |
| 固定自动导入工具解析版本 | 待安装成功 | 首次解析后将 latest 替换为实际版本，并保留 lockfile |
| peer / engine / native 完整兼容性 | 未验证 | 需成功安装依赖 |
| 环境变量自动化测试 | 已编写，未运行 | `apps/server/test/env.test.ts`；需安装 tsx 与 Zod |
| 完整 typecheck / build | 未运行 | 需安装 Vue、Fastify、Zod、vue-tsc 与构建依赖 |
| web/server 独立启动 | 未验证 | 不能从“源文件已创建”推断运行成功 |
| 浏览器空 ChatView | 未验证 | 需启动 Vite 后检查 |

## 用户完成首轮安装后的验证

| 项目 | 最新状态 | 证据 |
| --- | --- | --- |
| 首轮依赖 / lockfile | 通过 | 实际读取 node_modules 与 pnpm-lock.yaml，不再是仅声明依赖 |
| 工具版本固定 | 通过 | auto-import 21.1.0、vue-components 32.1.0，离线 lockfile-only 成功更新对应 specifier |
| 完整类型检查 | 通过 | 实际 `pnpm typecheck`，shared/server/web 全部成功 |
| 前端构建 | 通过 | 实际 `pnpm build`，Vite 7.3.8，36 模块，产物正常生成 |
| 自动化测试 | 7/7 通过 | 环境解析/默认值/URL/端口/错误不反射密钥，以及 Fastify ready/inject；未使用真实模型 |
| 测试修复 | 完成并重验 | Zod refine 中 new URL 可能抛 TypeError，已捕获并转为脱敏 EnvironmentError；tsx CLI IPC 受限，测试改为 node --import tsx |
| 后续既定依赖 | 已声明，待安装 | SDK/SQLite/Markdown/highlight 及类型包统一在 P1 安装，不提前实现业务；离线缺 @types/better-sqlite3 元数据 |
| 真实 TCP listen | 环境阻塞 | node:http.listen(127.0.0.1,0) → EPERM；自动化环境无法监听任何本地端口 |
| P1 HTTP smoke | 已编写/本环境受阻 | verify-p1 实际运行返回 EPERM，生成 passed:false 报告；需在本机执行 pnpm verify:p1 才能证明通过 |
| API Key | 尚未配置 | 只检查了是否为占位值，没有打印或复制内容；本阶段不调用 API |

## P1 本机报告与退出提示处理

- 已读取用户本机报告：`passed: true`，Node v22.21.1，时间 `2026-11-15T07:09:12.072Z`，config/Fastify HTTP/Vite HTTP/Vue transform 四项检查完成。接受报告时 8 个来源文件哈希与实际文件全部一致。
- 已确认剩余一期依赖安装：openai 7.57.0、better-sqlite3 12.11.1；SQLite 原生模块实际在内存执行 SELECT 1 成功，内嵌 SQLite 3.53.2。
- `pnpm install --offline --frozen-lockfile --lockfile-only --ignore-scripts` 实际成功，说明当前 manifest 与锁文件一致；不宣称该命令重新下载或安装全部依赖。
- 用户在成功后见到 `The build was canceled`。安装的 Vite 源码表明依赖优化器在 close 时取消后台构建；短期 smoke 曾触发扫描又立即关闭。修复仅作用于验收：`optimizeDeps: {noDiscovery:true,include:[]}`、`ws:false`，并在关闭完成后才写成功报告。
- 回归：以无 TCP middleware 模式实际创建 Vite、转换 main/App/ChatView 并关闭，退出 0，无 canceled 或 WebSocket 错误。完整 HTTP 修正版未在此环境重跑，不覆盖用户已通过的原始 HTTP 报告。
- P1 已接受通过。后续 P2 增加了 env 占位检测函数，因此 P1 报告是当时版本的历史证据，不要求它永远与后续业务修订后的所有文件一致。

## P2 已执行

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| Provider 接口/适配器 | 已实现 | 固定 ChatInput/ModelEvent/ModelProvider；SDK 7.57.0；顶层 thinking disabled、stream、输入 model、max_tokens=4096 |
| SDK 重试与日志 | 通过 | 401/403/429/408/504/500 均只请求一次；网络失败与超时不重试；SDK logLevel off，不反射原始 headers/payload/cause |
| 流生命周期 | 通过 | 增量与 fullContent 一致；异常 EOF、长度截断、内容过滤、工具 finish 不发 done；空回答拒绝完成 |
| Abort 传导 | 通过 | 预先取消不发请求；部分输出后外部 abort 到达 SDK transport；消费方提前 return 取消请求与 body；不把 abort 当正常完成 |
| 错误映射 | 通过 | 401/403→CONFIG_ERROR；429→RATE_LIMITED；连接超时/408/504→UPSTREAM_TIMEOUT；其他错误脱敏为 UPSTREAM_ERROR |
| 自动化测试 | 33/33 通过 | 20 个顶层场景及子测试，0 失败/跳过；使用真实 SDK + 注入 fetch + Response/SSE，不监听端口，不调用真实 API |
| 类型检查 | 通过 | shared/server/web 全部成功，独立 provider 脚本纳入 server tsconfig |
| 真实脚本前置保护 | 通过 | 实际执行 pnpm test:provider，Key 占位时调用前返回 CONFIG_ERROR，没有上游费用 |
| 真实 DeepSeek 连通性 | 已通过 | 用户更正 Key 后本机报告通过，详见下方 P2 真实调用验收记录 |

## P2 恢复顺序（历史，已完成）

1. 用户直接在仓库根 `.env` 填写有效 Key，不发到聊天。
2. 用户本机执行 `pnpm test:provider`，仅发起一次短的真实流式请求。
3. 读取 `docs/provider-smoke-result.json`，确认 passed:true、官方 endpoint 或明确的自定义 endpoint、model、reasoningLength=0、contentLength>0、来源哈希未漂移。
4. 真实验收通过后勾选 P2-05，再进入 P3 持久化/会话接口。mock 通过不代替真实调用。

此处为 P2 真实验收前的历史记录。最新结论见下方 P2/P3/P4 记录与 WORK_PLAN.md。

## P1 恢复顺序（历史）

1. 用户在可联网的本机终端进入项目，`nvm use`（或自行切换 Node 22），执行 `pnpm install` 补齐既定依赖。
2. 用户执行 `pnpm verify:p1`，串行重验结构、测试、构建和实际 web/server 本地 HTTP。
3. 检查 `docs/p1-smoke-result.json` 中 passed 与 sourceHashes；报告不包含 Key 或正文，仅记录验证版本与文件哈希。
4. HTTP smoke 证明入口与 Vue 模块可提供，不宣称浏览器交互测试通过；P1 验收完成后勾选 WORK_PLAN 对应项。
5. 再进入 P2，编写 Provider 与真实连通性脚本。用户可提前本地填写 .env，但不要发到聊天里。

以上为 P1 历史步骤，不要重复执行已不适用当前业务路由的 P1 HTTP 断言。

## P2 真实调用验收完成

- 用户修正本机 Key 后通过真实测试；读取报告 `checkedAt=2026-11-15T07:22:51.636Z`、passed:true、官方 endpoint、deepseek-flash、thinking disabled、reasoningLength=0、2 个增量、4 字符、首内容 526ms。
- 接受报告时 8 个来源哈希一致。后续 shared 类型的合法变更不使已接受的 P2 历史证据失效。
- 不需要重新填写、发送或反复验证 Key。P2 已通过并进入 P3。

## P3 已执行

- 两张固定表、WAL、外键/级联/索引、Repository、四个 REST 接口完成，接口形状与错误码保持规划。
- 52/52 自动化测试及完整类型检查通过。含 SQLite 事务故障回滚、终态防覆盖、稳定历史窗口、真实文件及独立子进程重启/恢复。
- 本环境未运行 TCP curl；Fastify inject 是接口测试证据。P3 已通过，进入 P4。

## P4 验证记录（已通过）

| 项目 | 结果与范围 |
| --- | --- |
| SSE 后端 | 唯一 POST stream、严格请求校验、前置占位/原子创建、心跳、批次、超时、取消与关闭清理已实现 |
| 持久化顺序 | 实际 SQLite + sink 回调断言：每个 delta 发送前已提交；complete 发送前状态 completed；部分失败/取消保留尾部 |
| 生命周期 | 同会话拒绝、跨会话隔离、生成中删除拒绝、reasoning 不续期、content 续期、静默 iterator 取消、正常完成后 close 不覆盖终态通过 |
| 背压 | 模拟 ServerResponse 验证 drain 等待、不堆积心跳、超时断开、监听清理；不宣称已完成 P6 实际 TCP 慢读测试 |
| 前端协议 | TextDecoder 流式解码；中文/emoji 单字节分片；CRLF 全部分割位置；多 data 行；心跳；无终止 EOF、错误帧/身份/顺序拒绝通过 |
| 前端状态 | 乐观消息 ID 绑定、GET 对账、400/404/409 回滚、网络断开不重试 POST、停止部分保留、等待收尾后切换、双发保护通过 |
| 自动化回归 | 73/73 测试通过，0 失败/跳过；包含 P1–P3 既有测试及监听注册前响应已断开的回归 |
| 类型/生产构建 | 通过：server/shared tsc、web vue-tsc 与 Node 工具/测试 tsc，Vite 7.3.8 生产构建成功；没有自动化浏览器运行证据 |
| 本机验收脚本 | 用户本机 `pnpm verify:p4` 已通过，passed:true / stage:complete、9 项检查；33 个来源哈希核验一致。此前本环境首次 listen 的 EPERM 是历史环境限制 |
| 浏览器 | 用户明确确认“浏览器通过”；P4 流式展示/刷新/停止/输入法清单完成，来源为人工验收，未冒称自动化浏览器结果 |

P4 命令与用户浏览器验收均通过。P5 和 P6 的后续结果见下方。

### P4 本机报告核验

- 报告时间 `2026-11-15T07:42:14.595Z`，Node v22.21.1，model=deepseek-flash，passed:true；读取时 33 个来源文件哈希全部一致。
- 9 项检查：正常流式 HTTP（请求体结束不误取消）、中文/emoji、complete 与 GET/DB 一致、HTTP 断开取消上游、取消保留部分正文、并发 POST 与生成中 DELETE 的 JSON 409、文件重开保留两种终态、真实模型正常完成与落库、真实模型断开取消与部分落库。
- 真实完成：4 个内容批次、46 字符、首内容 319ms；真实取消保留 1 字符。该次脚本取消较早，证明 cancelled 终态与非空部分正文；浏览器停止体验另由用户随后确认通过。
- 用户命令输出同时证明 73/73 测试、类型检查、生产构建成功。此脚本不自动验证浏览器渲染、输入法或 P6 的操作系统级崩溃/实际慢读背压。

## P5 验证（已通过）

以下表格记录 P5 本地验证的范围；表后的本机报告和用户确认已关闭当时的待验收项。

| 项目 | 实际结果与范围 |
| --- | --- |
| 上下文输入 | Service 调用 Provider 的实际 messages 断言：system + 最近 20 条 completed 历史 + 当前 user；排除当前 user 后再 limit，毫秒同值稳定排序，当前问题恰一次，其他会话及非 completed 消息不串入 |
| 连续五轮（本地 mock） | 真实 SQLite 与 mock Provider 连续五轮，实际上下文长度 2/4/6/8/10、历史答复恰一次；不是五轮真实模型验收 |
| 侧栏/删除状态 | 固定 260px 侧栏、删除确认；本地 Pinia 测试覆盖当前/最后一个/非当前删除、409 保留、重复请求保护、删除后详情失败、列表更新排序 |
| 竞态 | 取消后等待旧 GET 收尾，再取新会话；停止后与切换后的旧增量/错误被忽略；新建等待取消、生成中删非当前不取消当前、加载 GET 时防并发写入 |
| Markdown | HTML 始终关闭、links 固定 target/rel；表格/列表/换行与原始 HTML 转义、危险链接拒绝通过；未知/未闭合/恶意语言 fence 保持转义 |
| 高亮与滚动 | 仅引入 js/ts/json/bash/sql/python/xml(html)/css 子集；本地策略测试覆盖跟随、超过一屏暂停、手动回到底部与恢复；实际浏览器布局/弹窗/滚动已由用户确认通过 |
| 本地回归 | 86/86 自动化测试，0 失败/跳过；完整类型检查与 Vite 7.3.8 生产构建通过，工程结构检查通过，无新增依赖 |
| 五轮真实验收脚本 | `scripts/verify-p5.ts` 已实现并纳入 server 类型检查；本环境首次 listen EPERM 后，用户在本机执行通过，真实 5 轮/8 项检查；报告详见下方 |

P5-05 后续已通过：报告 `2026-11-15T08:06:52.651Z`、passed:true、stage:complete、真实五轮/8 项检查，实际 Provider 上下文长度 2/4/6/8/10，reasoningLength=0；首内容 964/648/783/639/881ms。接受时 36 个来源哈希一致。用户确认新增浏览器交互“全部通过”，P5 已完成并进入 P6。后续合法变更不要求已接受的历史 P5 报告哈希永久不变。

## P6 首轮验证（历史；最终结果见文末）

| 项目 | 实际结果与范围 |
| --- | --- |
| 全部错误码 | 8 个固定状态码/消息校验；SDK 的 401/403/429/408/504/500 经过实际 Service/SSE，一次上游调用、failed 终态、无敏感 payload/headers 反射 |
| DB 故障 | 初始原子写失败保持 JSON/不调用上游；批次失败不发布未提交增量；完成提交失败不假 complete；全写故障保留此前提交前缀，恢复后 streaming→failed；修复错误帧发送前立即 abort 上游 |
| 完成/关闭与资源 | 40 轮 complete 后 close 保持 completed、无重复终态；50 次 writer 关闭移除监听；同步 iterator.return 抛错不影响 settled/锁释放；header 失败后仍收尾；shutdown 后不接受新生成任务 |
| 实际 SIGKILL（本地） | 独立 Node 子进程写真实文件 SQLite，stdout readiness 后由父进程 SIGKILL；重启应用读到完整已提交中文/emoji、failed 与 completedAt。不是模拟 exit，也不冒称 HTTP 增量后崩溃测试 |
| Markdown | 恶意 HTML/链接/fence、未知/未闭合语言及 highlighter 抛错均回退转义；实际 Chrome DOM 与脚本执行仍待最终命令 |
| Key 构建隔离 | 验收子进程环境使用随机合成 Key；实际构建生产 web 和浏览器测试包，扫描 4 个产物中的原文/URL 编码/base64 形式，无泄漏；不读取/输出真实 Key |
| 本地完整验证 | 105/105 测试，0 失败/跳过；所有类型检查、Vite 生产构建、工程结构通过；`pnpm install --offline --frozen-lockfile --lockfile-only --ignore-scripts` 成功，证明 manifest/lock 一致，不等于全新机器安装 |
| 最终脚本 | `scripts/verify-p6.ts`、受控 Provider 子进程、Chrome 浏览器入口均已纳入类型检查；`pnpm verify:p6` 实际执行到 TCP 阶段 EPERM，报告 passed:false / checks:1 / realModelCalls:0 |
| 仍待验收 | 本机 `pnpm verify:p6`：真实 TCP 断连/慢读、HTTP 增量后 SIGKILL 重启、活动生成 SIGTERM 清理、Chrome 恶意 DOM/实际 API 请求与完整日志扫描 |

最终报告 `docs/p6-smoke-result.json` 已忽略；仅保留来源哈希、阶段、检查名、数值指标，无 Key/正文/进程原始输出。临时端口/数据库/浏览器配置独立，不触碰日常数据，不调用真实模型。失败不吞掉，不以已有单测替代未运行 TCP 或 Chrome 项。A01–A21 逐项见 `ACCEPTANCE.md`；P6-03/04 完成前不标记一期交付。

### P6 用户本机执行与浏览器诊断修订

用户本机报告 `2026-11-15T09:45:05.444Z` 已通过前 8 项，包括真实 TCP 完成/断连/并发/超时/上游错误、暂停读取的实际背压、收到 HTTP 增量后 SIGKILL 重启恢复、活动生成 SIGTERM 清理。慢读消费停在 13 块、最大缓冲 65877 字节、SIGTERM 退出 7ms。P6-03 已完成。

最后 Chrome 阶段返回 P6_CHECK_FAILED；旧脚本无细分失败断言、临时 DOM/日志已清理，不能确定根因或据此认定 XSS/Key 泄漏。修订仅涉及 `p6-browser.ts`、`p6-server.ts`、`verify-p6.ts`：移除虚拟时间预算/DOM dump 判据，改为浏览器完成后向独立 fixture 显式回传，父进程按真实墙钟限时等待；结果只接受布尔值/有界计数，记录 completedRequests/step 与 DOM 安全结果，失败使用具体错误码。无公开业务接口变更。其他 56 个来源哈希与本机报告一致。

修订后 105/105 测试、完整类型、安全构建/4 个产物扫描通过。本机成功的前 8 项保留为历史证据，不用受限环境的失败覆盖；Chrome 和后续全日志扫描仍需本机重跑 `pnpm verify:p6`。P6-04 未通过前不标记一期完成。

### P6 最终验收通过

用户本机重跑成功；回读 `docs/p6-smoke-result.json`，时间 `2026-11-15T09:54:54.464Z`、Node v22.21.1、passed:true、stage:complete，11 项检查全部通过。59 个来源哈希与当前源码一致，无漂移。

- 真实 TCP：10 次正常完成/close 无锁遗留、主动断开取消上游且保留前缀、同会话 POST/DELETE 409、跨会话独立、超时/上游失败无假 complete。
- 实际慢读：消费停在 13 块，最大缓冲 65877 字节；断开后 cancelled、部分内容保留、active=0。
- 实际进程演练：收到已提交 HTTP 增量后 SIGKILL，重启保留中文/emoji 前缀并恢复 failed；活动生成 SIGTERM 后 cancelled 持久化、active=0、退出 7ms。
- Chrome：passed=true、xssExecuted=false、activeElements=0、linksSafe=true、networkCompleted=true、completedRequests=5、step=7；5 次真实 API 请求无合成 Key/Authorization，stream 请求字段精确。
- 安全与清理：4 个构建产物及所有捕获进程输出无合成 Key；全部自有进程/临时数据清理成功，真实模型请求为 0。

原浏览器阶段失败的具体断言未被保存；修订等待方式后通过，不将推测写成已确定根因。P6-04 已完成，P0–P6 和 A01–A21 全部通过；README/WORK_PLAN/证据表均已收尾，无需用户重复验收。
