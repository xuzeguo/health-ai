# F02-P0 开工前实验规格

日期：2026-11-16。用户已明确“开始”，本阶段获准执行；后续阶段仍受测试门槛约束。

## 输入、预期与预算（实验实现之前冻结）

首轮只验证已配置DeepSeek与确定性协议边界，不读取/打印 `.env` 正文，不使用真实健康报告或业务库。通过既有配置加载函数在进程内使用Key，日志不含输入正文、模型原始输出、请求头或reasoning。

首轮真实API调用上限12次，每次60s、输出上限512tokens、SDK自动重试0；取消实验上限5s，不无限自修复。30–50次P0总预算中剩余额度留给LangChain、识别和Embedding，未配置的供应商不伪造成功。

执行补充：首轮原生实际6次、LangChain及最小Schema复核最多5次，共11次；追加独立两轮工具对话实验最多3次，总计最多14次，仍在已审查P0的30–50次预算内。该追加在编写实验前固定为两次强制工具选择＋一次最终回答，禁止开放式循环。

合成结构化样本：2026-10-01，70.2kg，体脂率缺失。预期三个精确字段为date=2026-10-01、weightKg=70.2、bodyFatRate=null，不推导其他数值。原生Schema单独请求，不支持记录为unsupported而非JSON模式通过。

工具fixture：get_latest_measurement无参数，返回weightKg=70.2；要求模型选择该工具，服务端验证名称/参数后回传对应callId，再要求最终回答。未知名称和非法参数必须在本地拒绝。真实流请求强制指定该工具，跨chunk聚合后才验证执行，不能把半成品作为参数。

## 用例与命令

| ID | 实验/前置输入 | 判定与证据 |
| --- | --- | --- |
| T0-01 | JSON模式与原生Schema分别请求同一合成样本 | 精确字段匹配，分别记录能力及usage；API400等保留分类 |
| T0-02 | 本地非法JSON/额外字段/缺字段/负值/不合法日期/全null/截断 | 解析或严格校验拒绝，缺失体脂保留null；不触碰业务库 |
| T0-03 | 实际单工具→校验→tool message→最终模型回复；本地未知工具 | 名称参数callId有效，最终正文非空；未知工具不执行 |
| T0-04 | 本地交错多工具、按轮次分离、UTF8片段、名称/ID冲突、超字节、缺结束帧/length | 完整正常结束才返回调用；非法片段全部拒绝；真实流记录chunk计数 |
| T0-05 | 待识别服务确定后，合成报告图与非法格式 | 未配置标not_run，不将纯文本作为识图证据 |
| T0-06/07 | 待Embedding确定后，中文语料及索引持久化/删除/错维度 | 未实测前不放行，不用随机/人工向量证明语义检索 |
| T0-08 | 锁定LangChain后invoke/stream/tools/structured/retriever/cancel | 与原生基准对照，未安装/未测标not_run |
| T0-09 | 预取消信号、活跃真实流取消、受控静默transport | 取消在界限内生效，iterator终结，未执行后续写入 |
| T0-10 | 敏感标记注入与报告序列化；调用数、usage与source hash | 无原始正文或Key字段，未知usage为null不编造0 |

计划命令：`pnpm --filter @health-ai/server exec node --import tsx --test test/phase2-p0.test.ts`、`pnpm --filter @health-ai/server exec node --import tsx experiments/phase2-p0/run.ts`、每阶段退出的`pnpm test`和`pnpm build`。脚本尚未存在时先记录预期失败，再实现。

报告为`docs/phase2-p0-smoke-result.json`（忽略Git，0600），保留任务ID、结果、错误分类、调用数、token usage、版本/source hash及耗时。任何未执行的必需能力使overallPassed=false；首轮文字实验通过不代表P0完成。正式阶段报告记录问题与重测，不能删除失败结果。

## 本地方案验证规格（继续执行前冻结）

在Apple Silicon/macOS环境先探测系统Vision与NaturalLanguage框架，不下载大模型或引入额外付费服务。只有实际中文OCR/句向量结果正确才作为候选；API存在不等于模型可用。

- 本地图像：由代码绘制两种中文合成报告布局，分别包含日期、体重、体脂率和骨骼肌量；输出PNG仅留在临时目录。Vision执行zh-Hans/en-US OCR，断言四字段对应原值，坏文件必须非零退出。stdout仅供父进程解析，不落日志原文。
- NaturalLanguage：探测中文sentence embedding；不可用时记录unavailable，不用词频/随机向量顶替。若可用，对中文标注语料实际向量化，记录维度与有限性，检验至少三个语义问题能召回预期文档。
- SQLite候选：使用现有better-sqlite3，持久化float向量＋空间标识、余弦精确检索；首版小语料允许O(ND)扫描，明确非ANN索引及规模限制。先写测试后实现：重开一致、TopK排序、删除不可见、重建原子切换/失败保留旧代、维度/非有限/零向量拒绝、相同ID在不同空间不混用。手工向量仅验证存储合同，语义质量必须由实际Embedding单列验证。
- 测试准备：`test/phase2-vector.test.ts`，实现`experiments/phase2-p0/vector-store.ts`；Swift探测器`local-capabilities.swift`由子进程执行，编译缓存和合成文件均位于专用临时目录，受总超时限制。
- 本轮不修改生产Provider或聊天链路；不把本机限定实验直接认定为跨平台部署方案。系统框架结果不达标则保留失败并选择其他已说明成本的方案。

## 抽取与组合链验证规格（编写脚本之前冻结）

真实中文OCR与640维句向量在沙箱外已验证可用，继续采用macOS系统本地处理候选，不下载模型。Swift编译器模块冲突保留失败，改用Objective-C调用相同框架。运行器后续重测保留previous attempts。

新增最多23次真实模型请求：20份固定文本样本、2张本地实际OCR报告、1次本地真实检索后模型回答；之前14次，累计最多37次。逐条无自动重试、每请求60s、max output512tokens；不以无限修改Prompt掩盖首次失败。

- 使用新的可空抽取实验Schema：date、weightKg、bodyFatRate、skeletalMuscleMassKg；任何核心字段无法识别不猜测。支持kg和%，不支持stone，必须将该字段设null并needs_attention。status仅reviewable/needs_attention，不能confirmed。
- 12份支持可读文本的日期、体重、体脂（包含缺失null）必须精确；8份模糊或异常单位文本必须needs_attention且体重null；所有字段来源可解释，不响应注入中的自动确认/编造指令。
- 2张图片从系统OCR实际提取文本后再送模型，日期、体重、体脂、骨骼肌量四字段精确匹配。它们是合成布局冒烟，不代表真实设备识别覆盖率。
- 检索模型链使用已有六篇合成文档的真实系统向量和SQLite TopK，经LangChain Prompt组装后调用已配置DeepSeek；要求输出体脂定义及来自本次检索的citation ID。仅验证链路和ID约束，语义支持仍由人工核对，不把citation存在当事实正确性证明。
- API输出只在内存校验，报告记录sampleId、字段匹配计数、结果分类、usage、耗时、版本hash；不记录原文/模型回复。首轮失败逐项保留，阶段最终决定由实测及ADR给出，不伪造通过。

实测缺陷：格式指令与语义问题一起Embedding时，目标fat文档排第6，完整RAG两次在调用模型前失败。修正为检索输入只含“体脂率是什么意思？”，回答引用要求单独保留在生成Prompt；只重测这一失败链，已有22份抽取不重复。先保留原失败和排名，后续在更多语料中评测Query Rewrite，不以该修正声称通用检索准确率。

## 证据不足判定实验规格

固定集显示正负问题相似度重叠（负例最高0.964，高于部分正例），不能冻结一个cosine阈值冒充可靠拒答。追加最多10次模型JSON判定：6个无答案/越界问题、2个检索命中的正例、2个目标来源掉出Top5的正例。模型只能从给定片段判断是否有明确支持，输出supported和sourceIds；ID必须属于本次检索，supported=true必须至少1个来源，false必须空来源。前6例预期false，命中2例true，掉出2例false。不生成健康回答、不执行文档指令。累计API请求最多47次，仍在50次P0预算内。

该策略仅在本小样本通过后作为首版“证据充分性检查”候选；阈值不作为唯一信任边界，P4须使用真实可信语料继续验证并承担额外模型调用/延迟。测试失败必须记录，不能仅修改预期使通过。
