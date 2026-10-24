# 给 `dsh-memory-refine` 加「记忆召回」——需求说明 v2

> 目标读者：另一个编码 AI（workbuddy）。
> v2 依据：`docs/recall-spec-review.md` 的实测评审。v1 的骨架保留，**验收表和全部参数按真实语料重写**。
> 你要做的是一次**加法**：新增一个检索文件 + 注册一个工具，现有的读写路径一行都不动。

---

## 0. v1 → v2 改了什么（先看这段，别照着 v1 做）

| 项 | v1 | v2 |
|---|---|---|
| 验收表 | 4 条里 3 条指向不存在的文件 | 用第 6 节的真实数据表 |
| archive 层 | 没处理 | 降权 ×0.3 + `scope` 默认 `live`（不含存档） |
| 切段 | 按标题切、超 1200 字按空行再切 | 按**条目**切（`- ` 起始行），600 字上限，找不到切点就按行硬切 |
| 段标题 | 取最近的 Markdown 标题 | 加 `label`：取段首列表项前 30 字（这份语料里条目自带标题） |
| 预算 | 每段 800 字 × 5 段（实际 6–12KB） | **总预算 1300 字符**，默认 3 段，单段 400 字 |
| 截断 | 从头截 800 字 | 取命中最多的那行**前后各 12 行** |
| 打分 | 纯 TF-IDF | 加 coverage 门槛（≥0.5）+ 文件名 boost + archive 降权 |
| 停用词 | 不过滤 2-gram；且会误删「他/我」 | 按"两字都在停用集才丢"，**保留 他 / 我** |

---

## 1. 目标

给插件加一个工具 `memory_recall`：**给一个关键词，返回几段最相关的原文片段**（带文件路径、行号、版本号），而不是让模型把整份记忆文件从头读到尾。

现在 `memory_read` 一份 `我们的线.md` 要 33KB；召回要压到 **≤ 4KB**，且不能把过时存档当现行事实喂回来。

---

## 2. 现状（先读这三个文件再动手）

插件根目录：`E:\大肥鱼的工作区\memory-refine`

| 文件 | 作用 |
|---|---|
| `index.js`（1001 行） | 注册五个工具：`memory_list` / `memory_read` / `memory_write` / `memory_import` / `memory_gather`。每个是 `{ name, description, parameters, output: { schema, render }, execute }` |
| `memory.js`（317 行） | 受管文件访问层：`DSH_HOME` / `MEMORY_DIR` / `AGENTS_FILE` / `describe` / `list` / `read` / `readRaw` / `write` / `versionOf` / **`layerOf`**（返回 `inject` / `index` / `topic` / `archive`） |
| `gather.js`、`protocol.js` | 与本需求无关，不要碰 |

工程约定：**ESM、零依赖、全同步**、中文注释（讲"为什么"）。`export const inject = ['skills', 'tools', 'commands']`。

---

## 3. 新增文件 `search.js`

导出两个函数：

```js
export function segments(scope = 'live')
// -> [{ path, layer, version, label, startLine, endLine, text, terms }]

export function recall(query, { limit = 3, scope = 'live' } = {})
// -> { query, total, hits: [{ path, layer, version, label, startLine, endLine, coverage, score, text }], fallback }
```

### 3.1 切段（`segments`）

1. 用 `list(scope)` 拿受管 `.md`（它已处理白名单与跳过目录）。
2. **切点优先级**（这是 v2 的核心改动）：
   - 空行；
   - **列表项起始行**（匹配 `^\s*[-*]\s` 或 `^\s*\d+\.\s`），且它前面是空行或上一条的结尾；
   - **行号硬切**：每 30 行一段（兜底，保证永远没有巨段）。
3. **段上限 600 字**（不是 1200）。超了就按上面优先级再找切点；一个切点都没有时**必须**按 30 行硬切，不许返回一个 34KB 的段。
4. 每段记：`path`、`layer`（用 `layerOf`）、`version`（用 `versionOf` 算该文件内容哈希）、`startLine`、`endLine`。
5. `label`：取段首**列表项的前 30 字**（形如 `⭐ 破甲插件：他看过两次，没装`）；段首不是列表项时退回取最近的 Markdown 标题行前 20 字。

> 为什么：`我们的线.md` 33KB / 88 行**只有 1 个** `#` 标题，`他-这个人.md` 同理。按标题切会让 8–10 段的 title 一模一样，模型无法区分。这份记忆的真实结构是 `- **⭐ 小标题**：正文`，条目自带标题。

### 3.2 分词

- **先剥注释再分词，但保留行号**：把 `<!--@refine ... -->` / `<!-- ... -->` 从**打分用的文本**里删掉，行号仍按原文位置算。
  （否则 `refine`、`20261024`、`session-xxxx` 会进词表，而且用户查日期会命中所有 refine 注释行。）
- 英文/数字：按非字母数字切，转小写，长度 ≥ 2。
- 中文：**2-gram**（`底线测试` → `底线`/`线测`/`测试`），另保留 2–6 字的连续汉字段。
- 停用词：只丢「**两个字都在停用集里**」的 bigram。停用集：`的 了 是 在 和 与 也 都 就 很 吗 呢 吧 啊 这 那 个 有 没 不 会 要 你 我 他` 中**排除 `你 / 我 / 他`**——这三个字在这份语料里是实体（他=用户，我=助手），丢不得。

### 3.3 打分

```
基础分   = Σ (tf_in_segment × log(N / df)) / sqrt(段长)
覆盖度   = 命中的 query 词数 / query 词总数      // query 只有 1 个词时，命中即 1.0
文件名   ：path 或文件名命中 query（子串）时，score = max(score, 该 query 的 top1 分 × 1.5)
存档降权 ：layer === 'archive' 时 score *= 0.3
```

- **候选门槛：`coverage >= 0.5`**。只要覆盖率不达标就整段丢掉，不靠分数硬排。
  实测：`底线测试` 里有一条只命中 `测试`（coverage 0.33）的无关段，靠 tf 挂进了结果——加门槛后这类噪声会被剔除。
- 排序：`score` 降序，同分比 `coverage`，再同分优先 `inject` / `index` 层。
- **同一文件最多出 2 段**（防止一个文件霸榜）。

### 3.4 预算与截断（`recall`）

```
总预算 1300 字符（≈3.9KB 纯中文）
limit 默认 3，上限 10
单段上限 400 字，下限 120 字
从高分往低发，预算用完即停；命中不足就只发几条，不凑数
```

- **截断按命中位置**：找出该段里命中词最多的那一行，取它**前后各 12 行**；再按 400 字硬截。
  （v1 "从头截"会让命中词在段尾时，模型拿到一段不含命中词的文本还以为看全了。）
- 硬上限：`endLine - startLine <= 45`（防止巨段回归）。

### 3.5 0 命中兜底（`fallback`）

`hits` 为空时**不要返回空手**，返回一份清单（约 200 字节）：

```js
fallback: [{ path, layer, title }]   // 只列现役文件（不含 archive）的路径 + 首个 Markdown 标题
```

> 为什么：用户口语词和文件里写的词经常对不上（比如他说「银线」，文件里叫「我们的线」）。给清单比空手而归有用。**但绝不加同义词库、不加模糊匹配**——那会召回到不相干的段。

---

## 4. 在 `index.js` 注册 `memory_recall`

```js
const RECALL_TOOL = {
  name: 'memory_recall',
  description:
    '按关键词召回长期记忆里的相关片段（返回文件路径、行号、版本号，不返回全文）。想知道"以前聊过/定过什么"时先用它；命中不够再 memory_read 补全文。存档层默认不参与，要看旧版显式传 scope:"all"。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '关键词或短语，如「底线测试」「缓存命中」「破甲插件」' },
      limit: { type: 'integer', description: '返回几段，默认 3，上限 10' },
      scope: {
        type: 'string',
        enum: ['live', 'all', 'inject', 'memory'],
        description: 'live=现役（默认，不含存档）；all=含 archive；inject=只注入层；memory=只记忆目录',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  output: { schema: { ... }, render(_args, value) { ... } },
  async execute(args) {
    return recall(args.query, { limit: args?.limit ?? 3, scope: args?.scope ?? 'live' })
  },
}
```

- `output.schema` 与返回值严格对齐（`additionalProperties: false`），照 `memory_read` 的写法。
- `hits[].layer` 为 `archive` 时，`render` 里显式标 `[存档·已过时]`。
- `render` 建议格式：

```
# 路径:起-止行 · label · coverage 0.67
<片段文本>
---
```

- 把它加进现有 tools 注入数组（与其余五个并列）。

### 4.1 顺带一行（可选）

`protocol.js` 或 skill 描述里加一句：「想知道以前的事，先 `memory_recall`，别整份 `memory_read`。」

---

## 5. 硬约束

1. **不改** `memory_read` / `memory_write` / `memory_import` / `memory_list` / `memory_gather` 的任何行为；写路径「版本预检 → 备份 → 读回核验」三道闸一个字别动。
2. **零依赖**：纯 `node:` 内置，不引向量库/分词库。
3. **同步**：不改 async 流式。
4. 读文件走 `memory.js` 的 `list()` / `readRaw()`，不要自己 `readFileSync(用户传的路径)`。
5. 中文块注释，风格跟 `index.js` 一致。
6. 不加同义词扩展、不加模糊匹配。唯一例外是第 3.3 节的"文件名 boost"和第 3.5 节的"0 命中清单"，两者都不改变召回集合语义。

---

## 6. 验收（用真实数据，按评审实测重写）

| query | 必须召回 | 不允许出现 |
|---|---|---|
| `底线测试` | `memory/我们的线.md` 起始行 73；`memory/他-这个人.md` 起始行 44 | `memory/archive/` 下两份旧快照 |
| `缓存命中` | `memory/环境-这台机器.md` 起始行 19；`memory/我们的线.md` 起始行 85 | `archive/MEMORY-原版快照:22`、`archive/MEMORY-87行版:3` |
| `破甲插件` | `memory/我们的线.md` 起始行 66（「他看过两次，没装」） | **空结果**（v1 断言反了，已实测反证） |
| `银线` | `hits` 为空 **且** `fallback` 里有 `memory/我们的线.md` | 任何硬凑的段 |
| `我们的线` | `memory/我们的线.md` 排第 1（文件名命中） | 不相关段进 top3 |

非功能验收：

- 任一 query 返回体（含 render 文本）**≤ 4KB**；
- 单段 `endLine - startLine` **≤ 45 行**；
- 同一 query 里同一文件最多出现 2 段。

跑完把实际输出贴出来，**命中就是命中、没命中就返回 fallback**，不要为了过验收去调分数。

---

## 7. 部署提醒

改完必须**重启整个 DSH 进程**才生效——ESM 模块缓存按 URL 命中，在插件管理器里开关插件不会重新 import（README 第 46 行）。

---

## 8. 给实现者的自由度

切段策略、打分权重、预算数值都可以再调，只要满足：

- 中文能搜到（2-gram 生效）；
- 结果带 `path` / `startLine` / `endLine` / `version`；
- 单次返回 ≤ 4KB；
- 命中不足时给 fallback，不硬凑；
- 存档层默认不参与。

**不要**为了"显得聪明"加语义匹配或同义词扩展——这份语料的组织方式是"一条一块"，精确命中比模糊覆盖重要得多。
