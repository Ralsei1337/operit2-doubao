# 设计说明

本文解释这套代码为什么长成这样。想看怎么用，去 [README](../README.md)；想看平台 API 的行号依据，去 [RUNTIME-FACTS](RUNTIME-FACTS.md)。

---

## 1. 分层：把「平台」和「风格」切开

| 层 | 文件 | 依赖 | 职责 |
|---|---|---|---|
| 类型 | `src/core/types.ts` | 无 | 配置、词库视图、模板、外壳的共享类型 |
| 核心 | `src/core/config.ts`、`lexicon.ts`、`templates.ts`、`render.ts` | 无宿主 API | 档位归一化、词库视图、模板渲染、六段拼装 |
| 提示词 | `src/prompt.ts` | 只依赖 `core/*` | 生成规范正文；`appendSection` 做幂等追加 |
| 宿主适配 | `src/main.ts` | `ToolPkg` / `Tools.Files` | 注册两个钩子与 `/doubao` 命令；读写配置与快照 |
| 子包 | `src/tools/doubao_tools.ts` | `ToolPkg` / `Tools.Files` | 4 个模型可见工具，读写同一份配置 |

核心层是**纯函数 + 纯数据**：给定配置和种子，输出确定的文本。带来三个直接好处：

1. 能在 Node 里直接单测（不需要装 Operit2、不需要真机）。
2. 能在 QuickJS 里原样跑（子包运行时也是 JS，不依赖 Node 内置模块）。
3. `/doubao render`、`doubao_render` 工具、真实输出走的是同一份代码——预览所见即所得，不会「预览一个样、实际输出另一个样」。

代价是核心层不能读配置目录。所有 I/O 都被推到 `main.ts` 与子包，核心层只接收一份已经归一化的 `DoubaoConfig`。

---

## 2. 为什么尾部只追加，不改写

DSH 版有两条真通道：提示词注入 + `llm/stream` 瀑布改写正文（连 `block-end.block.text` 一起改，否则会被组装器覆盖）。Operit2 没有等价的流式改写钩子：`registerChatResponseHook` 拿到的是**语义快照**（`parts`），返回值只能是 `ResponsePresentationDelta`。

因此移植版把「改写」拆成两半：

| DSH 版能力 | Operit2 版实现 | 结果 |
|---|---|---|
| 前插「高能前置」 | 提示词通道要求模型自己写在开头 | 模型听话才有；不听话就没有 |
| 正文信息稀释 | 提示词通道要求模型自己铺垫 | 同上 |
| 后置外壳（诊断/否定/复读/收尾） | 尾部通道追加气泡 | 100% 出现（只要通道开着且不是工具轮） |

为什么不干脆放弃尾部通道、只靠提示词？因为模型经常不听话，尤其是技术问题、代码块、短回答。外壳是这套风格的「最小可辨识特征」——只要否定清单和收尾在，风格就成立。反过来，只有提示词通道时，模型一旦省略，用户就以为插件没工作。

为什么不在气泡里伪造一段「改写后的完整回复」？那会让同一屏出现两份正文，而且第二份不在历史里，下一轮模型完全不知道它存在过——用户会以为模型失忆。追加一小段外壳是唯一自洽的形态。

---

## 3. 为什么用 JSON 文件，而不是 Storage API

Operit2 提供了三套持久化：`Storage.sqlite`、`Storage.objects`、`Storage.dataStore`（`types/storage.d.ts:314` / `:324` / `:334`），都带版本号、merge 描述符、事务语义。本工程仍然用 `ToolPkg.getConfigDir()` 下的普通 JSON 文件，理由按重要性排：

1. **配置是单文档。** 全部状态就是一个 `doubao-profile.json`（几 KB）。用对象库要定义 schema、处理版本、写 merge 描述符，收益为零。
2. **快照就是复制文件。** `revert` 需要「保存前的旧值」，文件方案是 `read` 一次旧内容、`write` 到 `snapshots/<时间戳>.json`；回滚就是读回来覆盖。用 Storage 得自己再实现一层版本历史，而版本历史正是它已经有的东西——两套版本语义叠在一起只会更难排查。
3. **人能看懂、能手改。** `prompt.previewOnly` 与 `prompt.customSection` 故意不给命令入口，就是留给愿意手改文件的用户。JSON 文件可以用任何文件管理器打开；对象库不行。
4. **注册期就要拿到路径。** `ToolPkg.getConfigDir()` 在注册期与运行期都可用（`toolpkg.d.ts:4292`），直接拼路径即可；Storage 的 `open()` 是异步且需要 `path` + 可选 merge，注册期用不上。
5. **失败模式简单。** 文件读失败 → 用默认值；写失败 → 抛给调用方（命令层转成 stderr）。没有「版本冲突」「merge 失败」这类需要向用户解释的状态。

`Tools.Files` 的六个方法就够了：`exists`、`read`、`write`、`mkdir`、`list`、`deleteFile`（`types/files.d.ts:101/124/161/167/195/219`）。

---

## 4. 幂等与去重

### 4.1 提示词：文本标记，不是内存标志

系统提示组装在一次会话里会被调用很多次（每轮请求一次），而且 `after_compose_system_prompt` 与 `compose_system_prompt_sections` 两个阶段都会走到。每次都追加，规范段会线性膨胀，几百轮后把上下文窗口吃光。

做法：规范正文第一行是 `<!-- operit-doubao:profile -->`，`appendSection` 先检查 `systemPrompt` 里有没有这个标记，有就原样返回、钩子返回 `null`（不改动）。

为什么用文本标记而不是模块级布尔量：

- 主运行时可能被重启，内存标志会丢，但提示词是持久的；
- 用户可能手动清空或换掉提示词，标记在就能重新注入；
- 多份配置（预览、自定义正文）共用同一套判断，不需要额外状态。

副作用：如果别的插件把整段 `systemPrompt` 替换掉且不含标记，下一轮会重新注入。这是想要的行为（自愈），代价是可能与那个插件来回覆盖——记在 RUNTIME-FACTS 的未验证项里。

两个阶段共用同一套判断：`after` 为主、`sections` 兜底（宿主某些版本在 `after` 阶段不带 `systemPrompt`）。无论哪个阶段先跑，注入一次后标记就在；另一个阶段再跑时 `appendSection` 看到标记直接返回原串，钩子返回 `null`。所以「接受两个阶段」不会产生两份规范，代价只是一次 `includes`。

### 4.2 尾部：三重去重

1. **事件级**：只有 `finished` 返回气泡，`started` / `snapshot` / `closed` 只维护状态。`snapshot` 在一次回复里会来很多次，若也追加，用户会看到几十份外壳。
2. **回复级**：`responseStates` 以 `chatId:messageTimestamp:variantIndex` 为键，`emitted` 标记保证同一条回复只追加一次。状态表上限 64 条，超出按插入顺序淘汰（`MAX_STATES`），避免长会话里无限增长。
3. **内容级**：`tail.dedupe` 打开时，`looksAlreadyDoubao(text)` 检查模型是不是已经自己写成豆包语——命中「否定清单 + 锚点句」或「诊断 + 收尾询问」任一组合就不追加。宁可少一份，不要两份外壳叠在一起。

### 4.3 自定义词条

`splitLines` 去空行、去行尾标点、去重；`samplePriority` 先取自定义部分再随机补齐。所以「自定义词条优先」是渲染层的取用顺序，不是把内置词条删掉。

---

## 5. 错误处理：三层兜底，绝不把插件故障变成聊天故障

| 层 | 位置 | 失败时 | 用户看到 |
|---|---|---|---|
| ① 配置 | `loadSettings` / `mergeSettings` | 文件缺失、JSON 坏、字段类型不对 → 回落默认值 | 风格没生效 |
| ② 钩子 | `onSystemPromptCompose` / `onChatResponse` 的 `try/catch` | 任何异常 → 记 `counters.lastError`，返回 `null` | 回复照常，没有外壳 |
| ③ 注册 | `registerSafely` | 单个注册抛错 → 记录 `failed: …`，继续注册其余 | 其余功能可用；`_internals()` 可查 |
| 命令 | `onDoubaoCommand` | 参数错 → `{ stdout, stderr, json:{ok:false} }`；意外异常 → 同一形态 | 命令报错，聊天不受影响 |

设计原则：**任何一条路径都不能让「模型回复」失败**。钩子返回 `null` 表示「我不参与」，宿主按原样继续。这也是为什么 `loadSettings` 在 `catch` 里返回默认值而不是抛出——配置坏了，最坏结果是风格消失，不是对话中断。

写入侧另有一条：`saveSettings` 先给旧值留快照再覆盖；快照写失败只打日志，不阻断保存（否则磁盘满会让用户连 `off` 都关不掉）。

---

## 6. 考虑过但没做的

**Compose DSL 设置页。** 平台支持 `registerUiRoute`、`registerToolboxUiModule`，消息菜单项还支持 `dialog`（`toolpkg.d.ts:2687 / 2657 / 2959`）。没做，因为：参数有 13 个数值 + 3 个文本域 + 5 个开关，外加 3 个尾部设置，DSH 版那套设置页配了实时预览才勉强好用；在 Operit2 里要重写一套 Compose DSL、还要维护「UI 改了、配置没存」的中间态。`/doubao` 命令 + 4 个工具已经覆盖同样的能力，而且对模型可见（模型能自己调档）。

**按会话配置。** `ChatResponseEventPayload` 带 `chatId`，技术上可以做「这个会话用 heavy、那个会话关掉」。没做，因为提示词通道的 `systemPrompt` 是全局组装结果，没有稳定的会话维度入口；两套作用域混在一起会让「为什么这个会话没生效」变成常见问题。

**A/B 评测。** `seed` 固定后渲染可复现，离线跑两组参数、人工对比是可行的。没做自动化，因为「豆包语写得好不好」没有可自动化的指标——逗号密度、句长方差这些指纹只能判断「像不像」，判断不了「该不该」。真要做，得先有一批人工标注样本，那是另一个工程。

**前插气泡。** 平台不允许（append-only）。见第 2 节。

**接管标题/摘要。** 提示词通道只挂 `after_compose_system_prompt`，不挂 summary 钩子。标题与摘要保持正常，等价于 DSH 版 `skipPurposes` 的效果。

---

## 7. 一次回复的数据流

```text
用户提问
  └─ 宿主组装 systemPrompt
       └─ [钩子] compose_system_prompt_sections → after_compose_system_prompt（两阶段都接受，标记去重）
            ├─ loadSettings() → config
            ├─ 档位 off / 通道关 → 返回 null（不改）
            ├─ promptSectionText(cfg, prompt.customSection) → 规范正文（首行带标记）
            ├─ 已含标记 → 返回 null
            └─ 返回 { systemPrompt: 原文 + "\n\n" + 规范 }
  └─ 模型生成（按规范写正文；工具调用照常）
       └─ [钩子] ChatResponse 生命周期
            ├─ started  → 建状态（hasToolCall=false, markdown="", emitted=false）
            ├─ snapshot → 刷新 parts → markdown 文本、是否含工具调用
            ├─ finished → 判定：
            │     ├─ 通道关 / band=off / 正文空 → null
            │     ├─ skipToolTurns 且含工具调用 → null（tailSkippedTool+1）
            │     ├─ dedupe 命中 → null（tailSkippedAlready+1）
            │     ├─ 已追加过 → null
            │     └─ buildShell(cfg, seed) → 段落 → 每段一个气泡（delayMs 默认 120）
            └─ closed   → 删状态
  └─ 宿主把气泡追加到展示层（不进 canonical 历史）
```
