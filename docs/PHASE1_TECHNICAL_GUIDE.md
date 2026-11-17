# 一期技术与功能导引

这是一份面向初学者的 HealthAI 一期阅读指南。它解释现有聊天 MVP 的功能、代码分层和一次消息的完整生命周期，帮助你在阅读源码前建立整体模型。本文不增加产品需求；一期的实现事实以 `PHASE1_DEVELOPMENT.md` 和实际源码为准。

## 1. 先建立整体认识

一期是一个只在本机运行的桌面 Web 聊天应用：Vue 前端、Fastify 后端、SQLite 本地数据库，以及 DeepSeek 流式模型调用。它没有账号系统，也没有把服务暴露到公网。

用户可以：

- 创建、切换和删除会话；
- 发送中文或其他文本问题，逐步看到模型回答；
- 停止正在生成的回答；
- 刷新页面后恢复历史消息；
- 使用 Markdown、代码块和安全链接显示回答。

一期没有实现报告上传、RAG 知识库、工具调用、Agent、健康档案或自动诊断。这些属于二期候选能力，不要把当前聊天助手理解成医疗系统。

## 2. 从这几个文件开始

建议按下面顺序阅读，每次只回答一个问题：

| 顺序 | 文件 | 你要理解的问题 |
| --- | --- | --- |
| 1 | `apps/web/src/views/ChatView.vue` | 页面由哪些组件组成，启动时做了什么？ |
| 2 | `apps/web/src/composables/useChat.ts` | 点击发送后，前端如何管理临时消息、停止和恢复？ |
| 3 | `apps/web/src/api/chat.ts` | 浏览器如何发送 HTTP 和解析 SSE？ |
| 4 | `apps/server/src/modules/chat/chat.route.ts` | 后端有哪些接口，什么请求会被拒绝？ |
| 5 | `apps/server/src/modules/chat/chat.service.ts` | 生成任务、上下文、取消和终态如何控制？ |
| 6 | `apps/server/src/providers/deepseek.provider.ts` | SDK 请求如何变成流式模型事件？ |
| 7 | `apps/server/src/modules/chat/chat.repository.ts` | 消息怎样写入 SQLite，事务保证什么？ |
| 8 | `apps/server/src/database/schema.sql` | 两张表和消息状态分别代表什么？ |
| 9 | `packages/shared/src/chat.ts` | 前后端共享哪些类型和事件契约？ |

先读接口和数据流，再读 CSS、组件细节和测试。这样不容易迷失在实现细节里。

## 3. 一次发送是怎样完成的

可以把一次发送想成下面这条链：

```text
输入框
  -> useChat 创建本地临时 user/assistant 消息
  -> POST /api/chat/stream
  -> Route 校验请求
  -> ChatService 原子创建数据库消息并占用会话
  -> Repository 读取最近历史
  -> Provider 调用 DeepSeek
  -> SSE 持续发送回答片段
  -> SQLite 先提交、浏览器后显示
  -> 结束后 GET 会话详情对账
```

### 3.1 前端先显示临时消息

点击发送时，`useChat` 先把用户问题和一个空的 assistant 消息放进 Pinia store。这样界面可以立即响应，不必等待网络。临时 ID 只在浏览器内有效；收到服务端 `message_start` 后，前端把 assistant 的 ID 换成数据库真实 ID。

这里有一个重要原则：前端的临时状态是体验层，SQLite 返回的详情才是权威状态。网络不确定时，代码不会自动重发同一个 POST，而是使用 GET 查询服务端结果。

### 3.2 后端先做校验和占位

`chat.route.ts` 只接受：

```json
{"conversationId":"...","message":"..."}
```

字段必须是字符串，问题去掉首尾空白后长度为 1 到 8000，且不接受未知字段。`ChatService.prepareTurn` 会检查会话存在、同一会话是否已有生成任务、模型 Provider 是否配置，然后在一个短事务中创建：

1. `completed` 状态的 user 消息；
2. 空的 `streaming` 状态 assistant 消息；
3. 当前会话的更新时间。

同一会话只能有一个生成任务；不同会话可以并行。这个内存占位只保证当前进程内的互斥。

### 3.3 服务端组装模型上下文

Service 读取固定 system prompt、最近 20 条 `completed` 消息和本轮 user 消息。历史由服务端读取，浏览器不上传整段历史：

```text
system prompt
+ 最近 20 条已完成消息
+ 当前问题
```

system prompt 位于 `apps/server/src/prompts/system.ts`，它要求模型提供一般健康知识、说明不确定性、不进行诊断或处方建议。

### 3.4 Provider 处理模型流

`DeepSeekProvider` 使用 OpenAI SDK 的兼容接口发起 `stream: true` 请求，并关闭 reasoning，设置 `max_tokens: 4096`。它把上游转换成少量内部事件：

- `content`：可显示的回答增量；
- `reasoning`：内部事件，Service 不保存、不发送给浏览器；
- `done`：只有收到正常 `stop`、内容非空且流完整结束时才产生。

超时、截断、空回答、内容过滤和非正常结束都不能伪装成成功。SDK 重试被关闭，错误会被映射成项目自己的安全错误码，不把上游 headers 或原始错误发给用户。

### 3.5 SSE 把片段送回浏览器

后端使用 Server-Sent Events，通过 `fetch` 的响应流发送：

```text
message_start       { messageId }
content_delta       { delta }
message_complete    { messageId }
message_error       { code, message }
message_cancelled   { messageId }
```

内容增量遵循“先落库，后发送”：SQLite 成功追加后，才发送 `content_delta`。最终状态提交为 `completed` 后，才发送 `message_complete`。这样刷新或连接断开后，数据库仍能恢复已经确认写入的内容。

前端的 `useSseParser` 处理跨网络分片、UTF-8 中文/emoji、LF/CRLF 和心跳注释。没有终止事件就遇到 EOF，会按失败处理。

### 3.6 结束、停止和故障恢复

正常结束时 assistant 变为 `completed`。用户点击停止、浏览器断开或服务关闭时，AbortSignal 会向 Provider 传递取消，assistant 变为 `cancelled`，已经保存的部分内容保留。上游失败、超时或数据库故障会进入 `failed`。

服务启动时会把上次崩溃留下的 `streaming` 消息恢复为 `failed`，不会自动再次调用模型。生成结束后，前端最多短暂 GET 对账，再以服务端详情覆盖临时状态。

## 4. 数据库中发生了什么

一期只有两张核心表：

- `conversations`：会话 ID、固定标题、创建时间和更新时间；
- `messages`：会话 ID、角色、正文、状态、模型和完成时间。

消息状态可以理解为一个小状态机：

```text
streaming -> completed   正常完成
streaming -> cancelled   用户停止、连接断开或关闭
streaming -> failed      上游错误、超时、数据库故障或重启恢复
```

user 消息创建后就是 `completed`。assistant 的正文可能分多批写入；最终状态更新和尾部内容在事务中完成。SQLite 使用 WAL、外键和 FULL synchronous，目标是让本地崩溃后的已提交内容尽可能可恢复。

## 5. 前端的几个关键设计

Pinia store 只保存页面需要的六类公共状态：会话列表、当前会话、消息、加载状态、生成状态和错误。生成任务的 AbortController、任务序号和收尾 Promise 保存在 `useChat` 闭包中，避免把短生命周期控制对象暴露成公共状态。

切换会话或新建会话时，前端先停止并等待旧任务收尾；旧任务的迟到事件会检查任务身份和视图版本，不能写入新会话。删除生成中的当前会话会被拒绝。这个竞态处理比“请求成功后更新页面”更接近真实 AI 产品的难点。

回答显示使用关闭 HTML 的 Markdown 渲染器，只允许有限语言高亮；链接固定 `target` 和 `rel`。这是因为模型输出仍然是不可信文本，不能直接当作 HTML 插入页面。

## 6. 怎样运行和观察

在仓库根目录准备 `.env` 后，两个终端分别运行：

```sh
pnpm dev:server
pnpm dev:web
```

打开 `http://127.0.0.1:5188`，发送一个问题。建议第一次只问：`请用三句话解释什么是流式输出。` 然后观察：

1. 文本是否逐步出现；
2. 刷新后消息是否仍在；
3. 生成中点击停止，部分回答是否保留；
4. 新建会话后，旧消息是否仍属于原会话；
5. 浏览器 Network 面板中的 `/api/chat/stream` 是否是 SSE。

不需要为了阅读一期导读运行真实测试。离线回归使用：

```sh
pnpm test
pnpm typecheck
pnpm build
```

这些命令不会调用真实模型。`pnpm test:provider` 和 `verify:p4`/`verify:p5` 会产生真实模型请求，学习阶段不要反复运行。

## 7. 推荐的学习练习

按难度递增做小练习，每次只改一个概念：

1. 修改 system prompt，让回答固定先给结论再给解释，观察效果和代码位置。
2. 在 `ModelProvider` 事件测试中区分 `reasoning` 与 `content`，确认 reasoning 不进入数据库。
3. 用 Fastify inject 测试一个非法请求，观察前置 JSON 错误和 SSE 内错误的区别。
4. 画出 `streaming -> completed/failed/cancelled` 状态图，并在数据库中找一条对应记录。
5. 阅读 `useChat` 的停止逻辑，解释为什么停止后不能立即发起同会话第二次请求。
6. 修改 Markdown 安全测试中的恶意 HTML，确认页面只显示文本而不执行脚本。

## 8. 读完后应能回答的问题

- 为什么历史消息由服务端读取，而不是由前端上传？
- 为什么 assistant 必须先创建为 `streaming`，不能等模型结束后再插入？
- 为什么数据库提交要早于 `content_delta` 发送？
- 为什么模型的 `done` 不能只看网络 EOF？
- 为什么停止操作需要 AbortSignal 和 GET 对账，而不是再次发送 POST？
- 为什么一期没有直接把当前服务部署到公网？

如果这些问题能用自己的话回答，你已经掌握了这个项目最重要的一期技术骨架，之后再学习二期的结构化抽取、工具调用和 RAG 会容易很多。

## 9. 一期边界

一期是本机单用户原型。SQLite 是本地明文存储，没有账号隔离和加密；内存任务锁不支持多进程；模型回答不是诊断意见。不要把它直接暴露到公网，也不要把真实敏感健康资料提交到 Git 或聊天中。

