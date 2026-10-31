# 架构

这不是一个「聊天页面 + prompt」的项目。它把一轮对话拆成七个可以单独看、单独测的阶段，每个阶段都有落盘或可解释的输出。这份文档讲调用顺序、每一层为什么这么切、以及你想加东西时该动哪里。

---

## 1. 一张图

```text
浏览器
  │  POST /api/chat {text}
  ▼
server.mjs ── 路由、静态文件、错误码、1MB 体积上限
  │
  ▼
runtime.mjs  #say()           ← 串行队列，一轮跑完才跑下一轮
  │
  ├─ 1. 危机识别        core/crisis.js       关键词 → none / watch / high
  ├─ 2. 情绪更新        core/emotion.js      读这句 → 三层 PAD 快照
  ├─ 3. 关系记录        bond.mjs + stores/bond-store.js
  ├─ 4. 记忆召回        core/recall.js       激活度 + 确定性抽样（可 0 条）
  ├─ 5. 拼 prompt       prompt.mjs           人格 / 此刻 / 记得的 / 眼里的 / 相信的 / 规则 / 底线
  ├─ 6. 调模型          model.mjs            DeepSeek chat/completions
  │     └─ 清洗        text.mjs              去前缀、去引号、拆 1–2 个气泡
  ├─ 7. 风格检查        core/style.js        长度、句数、问句、助手腔、Markdown
  ├─ 8. 记忆加固        stores/memory-store   只有真的说出口的记忆才变牢
  ├─ 9. 抽取写入        extract.mjs           每轮 0–2 条记忆 / 2 条档案 / 1 条看法
  └─ 10. 透视落盘       stores/trace-store.js 最近 80 轮完整现场
  │
  ▼
{ messages, traceId, state }  →  浏览器整体重渲染
```

「一轮」是串行的：`runtime` 内部用一条 Promise 链（`#serial`）把同一进程的请求排好队，避免两条消息同时写 JSONL、同时改关系。单用户场景下这足够了；也意味着**它不是多用户服务**。

---

## 2. 分层与职责

### `server.mjs` —— 只做 HTTP

- 路由表、JSON body 解析（1 MB 上限）、静态文件（带路径穿越检查）。
- 错误翻译：`HttpError` 带自己的状态码；`ModelError` 的 `NO_KEY / EMPTY / BAD_KEY` 映射 400，其余 502。
- **没有业务逻辑**。它不知道记忆是什么，只把请求交给 runtime。

### `src/runtime.mjs` —— 编排

唯一知道「一轮对话要做哪些事、按什么顺序」的地方。所有 store 在这里组装，所有跨层副作用在这里发生。

它不实现打分、不拼 prompt 的细节、不解析模型 JSON——那些在各自的纯函数里。

### `src/core/` —— 纯函数

| 文件 | 职责 | 有没有副作用 |
| --- | --- | --- |
| `recall.js` | 分词、线索分、保持率、激活度、强化 | 无 |
| `emotion.js` | PAD 六维、三层、事件识别、快照 | 无 |
| `lexicon.js` | 情绪词表与程度词 | 无 |
| `style.js` | 回复风格检查 | 无 |
| `crisis.js` | 危机关键词 | 无 |
| `beliefs.js` | 看法的归一化与合并 | 无 |

纯函数的意义：测试不需要起服务、不需要 mock 时间、不需要模型。`npm test` 里一半的用例直接调它们。

### `src/stores/` —— 落盘

| 文件 | 落盘文件 | 写法 |
| --- | --- | --- |
| `chat-store.js` | `chat.jsonl` | 追加；清空 = 改名 `.bak` |
| `memory-store.js` | `memories.jsonl` | 追加日志（memory / patch / merge / forget / reinforce） |
| `growth-store.js` | `growth.json` | 原子替换 + 快照 |
| `bond-store.js` | `bond.json` | 原子替换 |
| `belief-store.js` | `beliefs.json` | 原子替换 |
| `emotion-store.js` | `emotion.json` + `scars.json` | 原子替换 |
| `doc-store.js` | 通用 JSON 文档 | 读一次进内存，写时整份替换 |
| `trace-store.js` | `traces.jsonl` | 追加，保留最近 80 条 |

两种写法是有意的：

- **对话和记忆是追加日志**：进程被杀不会留下半截 JSON；「忘了什么」也可查。
- **档案、关系、看法是整份替换**：它们小、需要整体一致，替换比补丁简单。写入先写临时文件再 `rename`，避免写到一半断电。

### `src/prompt.mjs` —— 只拼字符串

输入是已经算好的东西（人格、情绪快照、关系、召回结果、档案、看法、危机级别），输出是 `{ text, sections }`。

`sections` 不只是给调试看的：透视面板按它分块展示，你能直接看到「这一轮人格占了多少字、记忆占了多少字」。**prompt 变长不是抽象的，它有数字。**

### `public/` —— 零构建前端

`index.html` + `app.js` + `style.css`，没有打包器、没有框架、没有 npm 依赖。`app.js` 只做三件事：

1. 调 `/api/*`；
2. 把 `state` 渲染成 DOM（所有动态文本走 `textContent`，不拼 HTML）；
3. 处理面板切换、记忆 CRUD、设置表单、透视弹窗。

代价是没有组件复用；收益是打开源码就能改，不需要先学一套构建链。

---

## 3. 一轮对话的细节

### 3.1 串行与错误边界

```js
chatOnce(text) {
  return this.#serial(() => this.#say(text));
}
```

`#serial` 把任务接到一条 Promise 链的末尾，前一个失败也不会卡死后面的。两条消息几乎同时到达时，第二条会等第一条把 JSONL 和关系写完。

错误分两类：

- **用户能改的**（空消息、没 key、key 无效）→ 400，前端把原文放回输入框；
- **上游的**（模型超时、502、空回复）→ 502，前端只 toast，不吞掉已经写进去的用户消息。

### 3.2 先落用户消息，再调模型

顺序是：危机 → 情绪 → 关系 → 召回 → **写用户消息** → 拼 prompt → 调模型。

先写用户消息，是为了模型失败时这句话也不丢：刷新后它还在，她下次还能接上。代价是如果模型连续失败，聊天记录里会有几句「没有回应的独白」——这比丢掉用户说的话更可接受。

### 3.3 回复的清洗与拆分

模型输出先过 `cleanReply`：

- 去掉 `知遥：` 这样的前缀；
- 去掉整体包裹的引号；
- 去掉首尾空白。

再 `splitBubbles`：

- 按换行 / 空行拆；
- 去掉 `-` `*` `1.` 这类列表标记（她不该用列表说话）；
- 最多 2 个气泡（危机关头 3 个）；
- 超出的合并进最后一个气泡，不丢内容。

气泡是界面层的「换气」，不是两句话——所以她不发「在吗」+「今天怎么样」这种拆开的寒暄。

### 3.4 风格检查只度量，不改写

`checkStyle` 看：长度、句数、问句数、助手腔（「作为一个 AI」「我可以帮你」）、列表、自我解释、Markdown。

结果写进透视的 `style.issues`。**它不会触发重试，也不会自动改回复**。原因：自动改写会把「她说话」变成「一个滤镜说话」，而且重试会让延迟翻倍。当前选择是把问题暴露给你，而不是假装没有。

### 3.5 记忆加固的判定

`#usedMemories(recall, reply)` 用词面重叠判断「这条记忆有没有真的被说出口」：

- 记忆 ≤ 8 个 token：重叠 ≥ 1 就算；
- 更长：重叠 ≥ 2 才算。

只在**回复已经生成之后**调用。召回了但没用上的记忆不会加固——否则「想起来」会变成自我强化，越召回越牢，最后变成背景板。

### 3.6 抽取在回复之后

抽取失败不影响回复：`#remember` 捕获所有异常，写进透视的 `extractionError`，这一轮就是「什么都没记住」。

危机轮、记忆开关关闭时直接跳过，透视里写明原因。

### 3.7 透视

每轮写一条 `traces.jsonl`，包含：

- 用户的这一句、她的气泡；
- prompt 的完整分块与字数（**不含 API key**）；
- 召回列表、分数、保持率、是否靠专名锚点捞回来的；
- 情绪前后快照；
- 抽取写入的记忆 / 档案 / 看法；
- 风格问题；
- 延迟、模型名、token 用量。

只留最近 80 条，超出从头部丢。它不是审计日志，是「刚才那一轮她为什么这么说」的现场。

---

## 4. 状态与一致性

### 4.1 谁是真相

| 数据 | 真相在 | 内存里的副本 |
| --- | --- | --- |
| 对话 | `chat.jsonl` | `ChatStore.#items` |
| 记忆 | `memories.jsonl` | `MemoryStore.#items` + 索引 |
| 档案 | `growth.json` | `DocStore` 缓存 |
| 关系 | `bond.json` | `BondStore` 缓存 |
| 情绪 | `emotion.json` | `EmotionStore` 缓存 |

所有 store 都是「首次访问时读盘，之后用内存，写时同步落盘」。没有缓存失效逻辑，因为单进程、单用户、文件不会被外部改——**如果你手改了 `data/` 里的文件，需要重启服务**。

### 4.2 重置语义

`POST /api/reset {scope}`：

- `chat`：`chat.jsonl` 改名为 `.bak`，记忆、档案、关系不动；
- `memories` / `growth` / `beliefs` / `emotion` / `bond`：对应文件改名为 `.bak`，内存状态重置；档案还会先留一份快照；
- `all`：以上全部。

**没有真删。** 每个 scope 都把旧文件改名成带时间戳的 `.bak`；档案重置还会额外留一份快照。这样「重置」不会变成不可逆的灾难。

### 4.3 档案快照

`GrowthStore.apply` 只在内容真的变化时写盘，并在写盘前 `capture` 一份当前状态。`restore(id)` 会先把「现在的样子」也存一份，再回滚——所以回滚本身也是可回滚的。

快照保留最近 30 份（`SnapshotStore` 默认），文件名带时间戳，直接可读。

---

## 5. 前端为什么这么写

### 5.1 一次请求，整体重渲染

`POST /api/chat` 返回 `state`（和首屏同一个结构），前端直接替换 `state.data` 再 `renderAll()`。

没有局部 patch、没有乐观更新之外的 diff。原因是状态小（几百条消息 + 几十条记忆），整体重渲染在浏览器里是毫秒级；而局部更新最容易出的 bug 是「面板和聊天不同步」。

发送时先乐观插入用户气泡，失败时保留原文；成功后用服务端状态覆盖。

### 5.2 安全渲染

`app.js` 里所有用户 / 模型文本都走 `textContent`，没有一处 `innerHTML`。记忆、档案、透视里的文本都来自模型或用户输入，绝不能拼进 HTML。

### 5.3 可访问性

- 消息区 `role="log"`、`aria-live="polite"`；
- 面板按钮是 `<button>` 而不是 `<div onclick>`；
- 焦点可见；
- `prefers-reduced-motion` 下关闭动画；
- 抽屉在窄屏用 `aria-expanded` / `hidden` 控制。

### 5.4 三张只读页面

`/mechanisms`、`/brain`、`/monitor` 各自一份 HTML + JS + CSS，共用 `public/pages.css` 的色板与版式，不引入聊天页的 `app.js`。

- **数据来源**：`/api/live` 是监测页的完整快照；`/api/state` 给脑内图提供档案、记忆、看法与关系；机制页同时用 `/api/live`、`/api/traces` 和 `/api/recall-preview`。
- **刷新方式**：监测页 2.5 秒轮询，机制页 5 秒；脑内图只在打开时拉一次，之后靠切视图重建，不轮询。
- **只读边界**：除了 demo 的 `POST /api/demo/seed` 和机制页的 `POST /api/recall-preview`（只算分、不写盘），三张页面没有写接口。
- **图形**：情绪雷达、记忆环、延迟折线、脑内图都是 Canvas 2D，按 `devicePixelRatio` 缩放；文字仍走 `textContent`，没有 `innerHTML`。
- **窄屏**：脑内图在 `< 620px` 时只标六个大类，细节点点开看详情；监测页从 12 列塌成单列，靠 `pages.css` 里同一组断点。

新增可视化时，优先复用 `pages.css` 的 token（颜色、间距、卡片）和 `/api/live` 的字段，不要为一张图新增写接口。

---

## 6. 想加东西时动哪里

| 想加的功能 | 动这里 | 注意 |
| --- | --- | --- |
| 新的记忆类型 | `core/recall.js` 的 `MEMORY_KINDS`、前端 `KIND_LABEL`、抽取 prompt | 旧数据不受影响；容量与合并逻辑通用 |
| 新的档案节 | `growth.mjs` 的 `SECTION_CAPS`/`SECTION_LABEL`、前端 `SECTION_LABEL`、抽取 prompt | 上限要一起加，否则新节会无限长 |
| 新的关系轴 | `bond.mjs` 的 `AXES` / `INITIAL` / `EFFECTS`、前端 `AXIS_LABEL` | 旧 `bond.json` 会被 `normalizeBond` 补默认值 |
| 换模型供应商 | `src/model.mjs` | 只要兼容 OpenAI 的 `/chat/completions`，改 base URL 和错误映射即可 |
| 加一个 HTTP 接口 | `server.mjs` 路由 + `runtime` 方法 | 保持「server 不写业务」的边界 |
| 换前端框架 | `public/` | 接口契约不变；`state` 结构就是 API 文档 |
| 主动整理更频繁 | `runtime.reflect` | 现在是手动触发；加定时器要考虑成本和「她不该在你不在一时自己说话」 |

### 不建议加的

- **向量数据库 / embedding 召回**：当前召回是词面 + 确定性抽样，可解释、零依赖。换向量会引入一个外部服务和一个不可解释的分数，和「透视」的设计目标冲突。
- **多用户 / 登录**：所有 store 都是单文件单用户。要支持多用户，得先把「数据目录」变成「会话目录」，这是一次结构性改动。
- **后台定时任务**：这个仓库刻意不做「她主动找你」。主动行为会把「陪伴」变成「推送」，也会让记忆在不该写的时候被写。

---

## 7. 失败模式

| 故障 | 表现 | 处理 |
| --- | --- | --- |
| 没有 API key | 首屏能开，发送返回 400 `NO_KEY` | 前端把原文放回输入框，设置页提示 |
| key 无效 | 400 `BAD_KEY` | 同上 |
| 模型超时 / 502 | toast，用户消息保留 | 再说一句即可；不会写半条记忆 |
| 模型返回空 | 502 `EMPTY_REPLY` | 同上 |
| 抽取 JSON 坏 | 这一轮不写记忆，透视有 `extractionError` | 回复不受影响 |
| 进程在写 JSONL 时被杀 | 最多丢最后一行 | 追加日志本身不会损坏前面的行 |
| `data/` 被手改坏 | 启动时 JSON 解析失败 | 报错指向具体文件；备份后删掉该文件即可重建 |
| 端口被占 | `EADDRINUSE` | 换 `SERENE_PORT` |

---

## 8. 为什么零依赖

- 公开仓库，任何人 `git clone` 后只需要 Node 20，不用等 npm、不用处理锁文件漏洞。
- 依赖越少，「三年后还能跑」的概率越高。
- 代价：HTTP 路由、静态文件、JSON body 解析都要自己写。这些代码在 `server.mjs` 里一共不到 300 行，可读、可改。

唯一的外部服务是模型 API。除此之外没有任何出网请求。

---

## 9. 相关文档

- [README](../README.md)：它是什么、怎么跑
- [docs/MEMORY.md](MEMORY.md)：记忆的公式、参数、写入与召回
- [docs/PERSONA.md](PERSONA.md)：人格包怎么写、白纸原则、调参流程
