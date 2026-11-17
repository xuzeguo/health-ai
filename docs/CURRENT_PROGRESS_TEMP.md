# HealthAI 当前进度临时上下文

> 当前路线已重设为 AI 技术学习项目：以 `docs/PHASE2_LEARNING_PLAN.md` 为唯一有效二期计划。OCR、健康报告产品和通用 workflow 不再是必做范围。

更新时间：2026-11-17，Asia/Shanghai。工作区：`/Users/guoxuze/Documents/myproject/health-ai`。

## 1. 第一优先级：当前暂停，不得自动开始P1

用户在P0完成后明确说：**“等一下，先不要开始P1”**。本次请求仅生成交接上下文，不恢复开发。

- F02-P0：选定本机macOS路径的技术验证已通过。
- F02-P1：未开始实现，未编写P1专属执行规格或测试代码。
- 已读过一期数据库、ChatService和app装配源码，为可能的P1工作了解现状；读取不代表开始实现。
- 下次先读本文和用户新指令。只有用户明确恢复后，才细化P1测试条件并开发；不要将早先“开始/继续”覆盖后来的暂停。

## 2. 已完成事项

一期本机单用户聊天MVP已交付，二期是在其上扩展，不能重写已有稳定生命周期。

本次会话已完成：

1. 阅读一期说明与坚果云两份二期v1.0文档，核对源码并评审。
2. 将设计缺陷落实为二期需求、技术设计、开发计划v1.2。
3. 开发前编写七阶段77项测试条件，用户明确要求每阶段严格测试通过后才能继续。
4. 用户授权开始后执行F02-P0；先写实验规格与失败测试，再编写隔离实验。
5. 验证文本、工具、识别、Embedding、存储、LangChain及证据充分性；形成阶段报告和ADR。
6. P0结束后用户要求暂停P1。没有提交/推送Git，没有访问或迁移日常真实健康数据库。

## 3. P0结果与选型

| 能力 | 实测结论 |
| --- | --- |
| JSON输出 | DeepSeek JSON模式＋Zod通过；原生JSON Schema完整/最小请求都400，明确不采用 |
| 抽取 | 20份固定合成文本按标注通过：12可审核、8模糊/异常单位需复核；不响应自动确认注入 |
| 报告图片 | macOS Vision中文/英文OCR，两张实际生成的PNG经OCR→模型抽取，日期/体重/体脂/骨骼肌值匹配 |
| 工具调用 | 单工具、连续两轮tool消息、结果回传及最终回答通过 |
| 流式工具 | 原生/LangChain聚合通过；交错、冲突、截断、字节及结束帧边界有离线合同测试 |
| Embedding | macOS NaturalLanguage中文sentence embedding revision1、640维，实际模型可用 |
| 检索 | 六篇合成短文，24有答案问题Recall@5=22/24，Top1=14/24；另有6个无答案/越界问题 |
| 存储 | better-sqlite3持久化标准化向量、cosine精确扫描；重开、删除、维度拒绝、重建事务切换和回滚通过 |
| LangChain | core1.4.1/openai1.8.4；Prompt、JSON、stream tools、tool回传、取消、实际本地检索→模型引用回答通过 |
| 证据检查 | 10例：6无答案/越界、2命中、2未召回，受限JSON判定均匹配标注 |
| 累计离线检查 | **117/117测试通过，0 skipped；类型检查与构建通过** |
| 产物审计 | 安全报告0600；禁止raw字段不存在；配置Key未出现在报告与3个构建产物中 |

这些仅证明本机技术可行性，不代表任意真实报告95%准确率，也不代表二期产品AC已完成。P2须补授权脱敏真实模板、JPEG和图像扰动；P4须补可信真实语料及引用语义评测。首批支持候选为单张PNG/JPEG，P0实际只验证PNG；PDF尚不支持。

## 4. 重要失败、修复及限制

- 相似度无法单独判断有无答案：负例最高约0.964，部分正例Top1约0.889，不能冻结一个阈值声称可靠拒答。选择Top5候选＋独立证据充分性判断＋citation校验，仍须后续扩大评测；额外调用和延迟计入预算。
- 将“解释并引用来源”等格式要求一起Embedding时，目标文档排第6，两次在模型调用前失败。检索输入只保留语义问题、格式要求留在生成Prompt后，目标排第1，组合链通过。保留失败，不重复调用已通过的22个抽取案例。
- 系统OCR/Embedding在沙箱内不可用、正常宿主权限下可用。生产需要启动自检和受限子进程；不可用必须明确报错，不能当成空结果。
- Swift编译出现SwiftBridging模块冲突，未修系统工具链；改用Objective-C helper成功。Swift文件保留为失败实验候选，实际用`.m`文件。
- 向量存储是小库O(ND)精确扫描，不是ANN；实验限制2000chunks/4096维。生产性能与主线程隔离仍需实现。
- 初版原生实验成功duration错误记录为0ms，已注明无效，不用作延迟指标；后续脚本计时已修正，不为此重复付费请求。

## 5. 调用与Token账目

P0累计**47次真实API请求**，阶段预算上限50：原生6＋LangChain/最小Schema复核5＋多轮工具3＋抽取/组合链23＋证据检查10。

已知usage：输入9681、输出1232tokens，**仅为下界**，取消、部分包装器及失败请求usage缺失，不能推断精确费用。早先沙箱另有5次立即失败连接尝试，计费情况未知。

不要无原因重跑真实脚本；尤其`run.ts`包含真实调用，并非离线测试。部分运行器会把上次结果嵌入历史，新实验应保留历史并独立统计；不要将嵌套历史重复计费。P0不是剩余3次必须花完，若需新增调用先判断是否必要及是否属于新阶段。

完整项目预算是规划估算：23–30个8小时有效开发日，含20%余量28–36日；Codex未来开发约640万–1170万tokens，应用真实测试约127万–207万文本tokens，Embedding约12万–36万tokens。该预算形成于本地方案验证前，恢复后可根据本地Embedding路径修订，不能把它当已发生消耗或固定账单。

## 6. 下次按需阅读的文件

| 用途 | 文件 |
| --- | --- |
| 本次交接入口 | `docs/CURRENT_PROGRESS_TEMP.md` |
| 一期契约及最小上下文 | `docs/NEXT_PHASE_CONTEXT.md`、`docs/reference/PHASE1_DEVELOPMENT.md` |
| 二期需求 | `docs/archive/phase2-product-route/PHASE2_REQUIREMENTS.md` |
| 二期技术设计 | `docs/archive/phase2-product-route/PHASE2_TECHNICAL_DESIGN.md` |
| 阶段计划/工时/Token | `docs/archive/phase2-product-route/PHASE2_DEVELOPMENT_PLAN.md` |
| 开发前测试条件 | `docs/archive/phase2-product-route/PHASE2_TEST_PLAN.md` |
| 评审修订对照 | `docs/archive/phase2-product-route/PHASE2_REVIEW_AND_PLAN.md` |
| P0开工前实验条件 | `docs/archive/phase2-p0/PHASE2_P0_EXECUTION.md` |
| P0最终阶段报告 | `docs/archive/phase2-p0/PHASE2_P0_STATUS.md` |
| ADR与选型限制 | `docs/archive/phase2-product-route/PHASE2_DECISIONS.md` |
| P0安全结果文件 | `docs/phase2-p0-smoke-result.json`，Git忽略、0600；勿打印整份内容 |
| P0源码 | `apps/server/experiments/phase2-p0/` |
| P0离线测试 | `apps/server/test/phase2-p0.test.ts`、`phase2-vector.test.ts` |

实验目录包括：contracts、dataset、vector-store、evidence-contract、run、langchain、multiround、local、extraction、evidence、audit、retrieval-diagnostic，以及local-capabilities.m/swift。不要把实验直接视为生产服务。

## 7. 工作树与环境

交接文档生成时所有二期变更尚未提交；用户随后明确授权“先提交这部分工作”。本次提交范围如下，实际提交记录和工作树状态以`git log`及`git status`为准。该授权不包含推送或恢复P1。

- 修改的已有文件：`.gitignore`、`apps/server/package.json`、`apps/server/tsconfig.json`、`pnpm-lock.yaml`、`docs/NEXT_PHASE_CONTEXT.md`。
- 本次新增：二期文档、实验目录、两份测试及本文。先看`git status --short`，不要清理、覆盖或reset这些工作。
- 新增锁定devDependencies：`@langchain/core@1.4.1`、`@langchain/openai@1.8.4`；一期生产Provider、chat服务、数据库初始化、前端业务代码未改。
- 当前Node22.21.1、pnpm10.26.0、Apple Silicon/macOS；Web5188、API默认3000。
- `/tmp/healthai-p0-local/probe`当前存在（55208字节），只是可重建本地二进制，重启/临时目录清理后可能丢失。模块编译缓存也在该临时目录，无需迁移或提交。
- `.env`由现有loadConfig在进程内加载用于已授权实验；不要打印、覆盖或让Key进入日志。未新增云账户或下载大模型。
- 仓库文档包含最新P0结果；坚果云只同步过四份v1.2设计/测试文档，之后的执行状态、ADR、P0报告及暂停状态尚未再次同步。下次以仓库和用户最新指令为准。

## 8. 必要时的复现方式

纯文档交接无需重跑测试。以下是以后代码变化或排障时使用的命令，不要求新会话先全部执行：

```sh
pnpm test
pnpm build
pnpm --filter @health-ai/server exec node --import tsx --test test/phase2-p0.test.ts test/phase2-vector.test.ts
```

helper丢失且确有必要验证本地系统能力时，可重新编译；输入只使用合成文件，编译不调用模型：

```sh
mkdir -p /tmp/healthai-p0-local
clang -fobjc-arc -fmodules-cache-path=/tmp/healthai-p0-local/clang-cache -framework Foundation -framework NaturalLanguage -framework Vision -framework AppKit apps/server/experiments/phase2-p0/local-capabilities.m -o /tmp/healthai-p0-local/probe
```

`local.ts`使用系统模型、不调用云模型，但仍可能需要正常宿主权限；`run/langchain/multiround/extraction/evidence.ts`会真实调用云模型，禁止作为常规回归重复运行。`audit.ts`会在内存加载Key做报告/构建扫描，不输出Key。

## 9. 用户恢复后的P1切入点

**仅在用户明确恢复后执行。** 先读取测试计划T1-01…12并创建P1专属执行规格，明确fixtures、预期、故障注入、命令和证据，然后再编写测试及实现。

1. 旧库迁移：目前只有schema.sql的CREATE IF NOT EXISTS，没有migration；设计版本/checksum、旧库结构验证、失败回滚、WAL一致性备份测试。禁止用真实库做实验。
2. 共享会话占位：当前ChatService.active是私有Map，生成/删除共用；未来分析入口必须共享注册表，测试同会话互斥、旧finally不释放新占位、异常释放和关闭。
3. AI端口：一期Provider只支持system/user/assistant文本，finish_reason=tool_calls会失败；新增二期端口/适配，保留一期完成判据。
4. v2事件与恢复：现有SseWriter类型绑定ChatStreamEvent，前端只解码五事件；新协议独立，不直接把实验event塞入旧链路。
5. 生产Prompt/Schema、最小workflow_runs、requestId对账和评测基架，逐项按P1退出条件验证；不能直接跳到上传页面。

P1–P6全部业务仍待实现：报告上传/审核、正式Measurement、健康只读SQL工具、知识导入/检索管理、v2工作流、组合分析界面和趋势图。

## 10. 下次开场模板

> 继续HealthAI。先读取docs/CURRENT_PROGRESS_TEMP.md和docs/NEXT_PHASE_CONTEXT.md。F02-P0已完成本机路径验证，117项离线测试及构建通过；用户上次明确暂停，P1尚未开始。本次指令是：【继续审查/明确恢复P1/其他任务】。只有本次明确恢复才开始P1；先写周全测试条件，再实现和严格验证。不重复已通过真实模型实验，不打印或覆盖.env，不操作日常真实库，不自动提交推送。
