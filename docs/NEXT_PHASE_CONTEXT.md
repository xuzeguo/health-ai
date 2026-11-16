# 下一阶段最小上下文

基线：一期工程 2026-11-15；二期文档状态更新 2026-11-16，仓库 `health-ai/`。用途：新会话优先读本文件，再按需读源码或 [一期开发文档](PHASE1_DEVELOPMENT.md)。这是项目快照，后续用户指令和实际代码变更优先。

## 当前结论

- **最新用户指令：暂停，先不要开始P1。** 当前仅生成交接文档，尚未开始P1代码、专属测试或执行规格；早先“开始/继续”不覆盖后来的暂停。下次优先读 [当前进度临时上下文](CURRENT_PROGRESS_TEMP.md)，等待用户明确恢复后才实施下一阶段。
- 用户随后授权提交当前文档、P0实验与测试；该授权不包含推送或恢复P1。提交结果以Git实际记录为准，不因文档旧有“未提交”快照重复提交。
- Feature 01 本机单进程桌面 Web 聊天 MVP 已交付：P0–P6、A01–A21 全部通过。
- Feature 02 的“开始/继续”授权已被最新暂停指令收紧。**F02-P0已通过选定本地macOS路径；P1未开始，恢复后先细化测试条件再实现。** 先读 `docs/PHASE2_P0_STATUS.md`、`docs/PHASE2_DECISIONS.md`；真实实验位于 `apps/server/experiments/phase2-p0/`，不要重复已完成模型请求。选型：Vision OCR（Objective-C helper）、NaturalLanguage中文sentence embedding revision1/640维、SQLite小库精确向量扫描、DeepSeek JSON＋Zod、LangChain。原生Schema两次400不采用；无固定相似度阈值可可靠拒答，独立证据充分性判定10例通过。
- P0累计47次真实API请求（上限50），已知usage输入9681/输出1232仅下界；20份合成文本、2张OCR图片、真实本地检索及最终模型引用链通过。仅工程样本，真实报告/语料质量留P2/P4；不是业务功能交付。P0报告Git忽略0600，保留失败历史。117/117离线测试、类型/build和报告隐私扫描通过。
- 用户要求每阶段开发前写周全测试条件并严格放行，见 `docs/PHASE2_TEST_PLAN.md`。授权范围内pnpm直接运行，复用系统已有规则，仅sandbox强制时升级。不打印/覆盖.env，不操作真实健康DB，无自动Git提交/推送。LangChain暂为锁定实验devDependencies，helper仅用于macOS正常宿主；沙箱内系统模型可能不可用。
- 105/105 测试、类型/生产构建、锁文件一致性通过。最终 P6：`2026-11-15T09:54:54.464Z`、passed:true/stage:complete、11 项、59 个源码哈希一致。真实模型与人工 UI 在 P2/P4/P5 已接受，无需重新配 Key 或重复验收。
- 用户偏好：先生成计划，再逐项实现；授权范围内自主完成，减少反复确认。不要打印/覆盖已有 `.env` 或输出健康聊天正文；仅为用户授权的安全审计可在内存读取敏感值而不回显。用户已授权首次 Git 提交并推送到 xuzeguo/health-ai；执行结果以实际 Git 状态为准，不虚构 commit/tag 或推送成功。首次公开前检查见 PUBLISH_SECURITY.md。

## 栈与启动

Node22（>=22.12 <23）、pnpm10.26.0；Vue3.5/TS5/Pinia3/Router4/ElementPlus2/Vite7；Fastify5/Zod4/openai7/better-sqlite3 12；markdown-it14/highlight.js11。依赖以 lock 为准，无 ORM/auth/Redis/RAG/Agent。

`pnpm dev:server`、`pnpm dev:web`，Web **5188**、API默认3000；Web /api proxy 到后端 PORT。配置在项目根 `.env`，由 env.ts 按 import.meta.url 定位；默认模型 deepseek-flash、DB `data/health-ai.db`。启动不调用模型，Key 已由用户配置并验收。

shared exports TS 源码、零运行依赖、不单独构建。server 以 tsx 执行；根 build=类型检查+web构建，不输出独立 server JS，也没有生产静态托管方案。

## 不应意外破坏的契约

- API：POST/GET `/api/conversations`；GET/DELETE `/api/conversations/:id`；唯一生成 POST `/api/chat/stream`，严格 body `{conversationId,message}`（trim后1..8000）。无 stop 接口，无客户端历史上传。
- REST成功：创建201 `{conversation}`；列表`{conversations}`；详情`{conversation,messages}`；删除`{ok:true}`。前置错误JSON `{code,message}`；进入SSE后用错误帧。
- SSE：message_start `{messageId}` → content_delta `{delta}` → message_complete `{messageId}` / message_error `{code,message}` / message_cancelled `{messageId}`。ID属于assistant；15s注释心跳。EOF没有终态必须失败。
- 错误8种：INVALID_PARAM400、CONVERSATION_NOT_FOUND404、CONVERSATION_BUSY409、CONFIG_ERROR500、RATE_LIMITED429、UPSTREAM_TIMEOUT504、UPSTREAM_ERROR502、INTERNAL_ERROR500。文案统一由shared映射，不反射上游错误。
- SQLite两表conversations/messages，snake_case列→camelCase DTO；WAL/FK cascade/FULL。createTurn同事务创建completed user+streaming assistant；pending只保留在类型/schema中。终态completed/failed/cancelled不可被迟到事件覆盖；启动streaming→failed保留正文。暂无版本化migration，改表须处理旧库。
- Service按会话内存Map占位，同会话生成/删除409、跨会话并行。**75ms或1024字节批次先落库后delta，先终态提交后complete**；单个上游next在途；write=false等drain，10s上限，不排队心跳。
- 内容空闲60s，仅content续期，reasoning/心跳不续期；超时failed。监听response close而非request close，Abort传SDK。先分类失败/取消再自发abort；finally不等待不合作iterator，必须释放Map/settled。shutdown先取消活动任务再关DB。
- 上下文：system + 最近20条completed消息 + 当前user。排除当前user后limit，再稳定正序（时间+rowid）。20条不是20轮；失败assistant排除，但对应completed user可能保留；无token裁剪/摘要。
- Provider：stream true、顶层thinking disabled、max_tokens4096、SDK retries0/logoff，无fallback。只有正常流结束+stop+非空正文才done；截断/length等failed；reasoning仅内部事件。
- Store仅6字段：conversations/currentConversationId/messages/loading/generating/error。useChat闭包保存active/controller/settled/viewVersion；临时消息→start绑定真实assistant ID→终态GET对账。明确HTTP拒绝回滚，网络不确定不重发POST。停止立即本地保留文字，切换/新建等待旧任务收尾，旧流/GET不能污染新会话。GET最多20次间隔100ms，但单次请求无业务超时，非严格2s截止。
- UI：260px侧栏，标题固定“新对话”，IME Enter不误发；HTML关闭、安全链接target/rel、高亮8语言；上滚超过一屏暂停跟随。无移动端/账号/健康档案/自动标题/分页。

## 按任务读取文件

| 任务 | 路径 |
| --- | --- |
| 服务入口/配置/关闭 | apps/server/src/{index.ts,app.ts,config/env.ts} |
| 流/并发/持久化/接口 | apps/server/src/modules/chat/chat.{service,repository,route}.ts；common/sse.ts |
| 模型/提示词 | apps/server/src/providers/*；prompts/system.ts |
| DB/共享契约 | apps/server/src/database/*；packages/shared/src/* |
| 前端状态/流解析 | apps/web/src/{composables/useChat.ts,api/chat.ts,composables/useSseParser.ts,stores/chat.ts} |
| 视图/安全渲染 | apps/web/src/components/chat/*；utils/markdown.ts；composables/useAutoScroll.ts |
| 验收事实 | docs/ACCEPTANCE.md；需排查历史时才读VALIDATION.md/WORK_PLAN.md |

## 检查与环境经验

`pnpm test`不调真实模型；`pnpm build`包含typecheck。P6命令`pnpm verify:p6`全回归+受控TCP/SIGKILL/SIGTERM/Chrome/合成Key扫描，真实模型0次。test:provider/P4/P5分别调用真实模型1/2/5次，按改动需要执行。`verify:p1`是旧空骨架断言，当前不用。

P6已验：4产物无合成Key、慢读停在13块/最大写缓冲65877字节、SIGTERM退出7ms、Chrome五次业务请求完成、XSS=false/活动危险元素0/链接安全/请求字段精确。是测试指标，不是SLA。Chrome结果通过fixture显式回传；`/p6-result`仅测试脚本路由，绝不能移入生产。

历史执行环境限制：父目录`pnpm --dir health-ai ...`能选Node22；直接以项目workdir曾选Node24。tsx CLI在沙箱创建IPC失败时用`node --import tsx`。沙箱曾限制外网/TCP，用户本机已完成真实验收；新环境应先实际判断，不能把历史限制当当前事实。无需重复安装依赖。

`.env`、data、dist、node_modules、自动导入声明、docs/*smoke-result.json已忽略。报告含来源哈希/安全计数，不含Key/正文。下一阶段代码改变后，旧报告仍是历史证据，不要求历史哈希永远不变；新改动另按范围验证。

## 新会话开场模板

> 在 health-ai 继续开发。先读取 docs/NEXT_PHASE_CONTEXT.md；按本次任务再读相关源码，必要时查 docs/PHASE1_DEVELOPMENT.md。P0–P6 已验收完成，无需重复前期规划、安装或真实模型测试。本次目标是：【填写功能/约束/验收要求】。先给出可执行计划，再按计划实现和验证；同步更新受影响文档与本摘要，不输出密钥或聊天正文。
