# 平台事实与待验证清单

本文只记录**能在 `types/*.d.ts` 里指到行号**的事实。任何推断、假设、待实测的东西，一律放进最后一节，不混进事实表。

行号对应当前工程里的 `types/toolpkg.d.ts`、`types/chat.d.ts`、`types/files.d.ts`、`types/storage.d.ts`（由 Operit2 SDK 生成）。类型文件升级后行号会漂移，改之前先 `grep` 函数名确认。

---

## 1. 钩子注册入口

`export namespace ToolPkg` 从 `toolpkg.d.ts:7` 开始；同一批函数在文件末尾另有全局别名（`4339–4445`），两种写法等价。

| 函数 | 命名空间方法 | 全局别名 | 用途 |
|---|---|---|---|
| `registerSystemPromptComposeHook` | `toolpkg.d.ts:4251` | `:4437` | 系统提示组装 |
| `registerToolPromptComposeHook` | `toolpkg.d.ts:4255` | `:4445` | 工具提示组装与过滤 |
| `registerPromptFinalizeHook` | `toolpkg.d.ts:4259` | `:4421` | 发模型前最后一道 |
| `registerChatResponseHook` | `toolpkg.d.ts:4219` | `:4364` | 原生定时回复呈现 |
| `registerChatMessageMenuItem` | `toolpkg.d.ts:4210` | `:4360` | 消息长按菜单项 |
| `registerCoreCommand` | `toolpkg.d.ts:4271` | `:4377` | `/` 斜杠命令 |

本工程只用了其中三个：`registerSystemPromptComposeHook`、`registerChatResponseHook`、`registerCoreCommand`。

注册对象都要求 `{ id: string, function: … }`：

| 类型 | 行号 |
|---|---|
| `SystemPromptComposeHookRegistration` | `toolpkg.d.ts:3682` |
| `ChatResponseHookRegistration` | `toolpkg.d.ts:804` |
| `CoreCommandRegistration` | `toolpkg.d.ts:3752`（`id` / `name` / `title` / `description` / `usage` / `function`） |

---

## 2. 系统提示通道

| 事实 | 依据 |
|---|---|
| 阶段枚举为 `before_compose_system_prompt` / `compose_system_prompt_sections` / `after_compose_system_prompt` | `toolpkg.d.ts:889` |
| 事件类型 `SystemPromptComposeHookEvent`，payload 类型 `PromptHookEventPayload` | `toolpkg.d.ts:2315` / `:1191` |
| payload 里 `systemPrompt?: string`（可选） | `toolpkg.d.ts:1231` |
| payload 里 `stage?: string`，可能缺省 | `toolpkg.d.ts:1195` |
| 返回值 `PromptHookObjectResult` 里的 `systemPrompt?: string` | `toolpkg.d.ts:1123` / `:1143` |
| 返回 `{ systemPrompt }` **整体替换该阶段当前值**，不是追加 | `toolpkg.d.ts:1123` 注释「Contains the system prompt assembled at this hook stage」 |
| 事件基类 `HookEventBase` 提供 `event` / `eventName` / `eventPayload` / `timestampMs` | `toolpkg.d.ts:1571` |
| handler 签名 `(arg0: SystemPromptComposeHookEvent) => SystemPromptComposeHookReturn` | `toolpkg.d.ts:1536` |

本工程的做法：**`after_compose_system_prompt` 为主，`compose_system_prompt_sections` 兜底**——两个阶段都接受，靠 `<!-- operit-doubao:profile -->` 标记去重，所以不会注入两次；`payload.stage` 缺省时回落到 `event.eventName`（`src/main.ts` 的 `stageOf`）。返回 `null` 表示「不参与」，宿主保留原值。

为什么接受两个阶段：代码注释写的是「主阶段是 `after_compose_system_prompt`；`sections` 阶段作为兜底：某些宿主版本在 `after` 阶段不带 `systemPrompt`，此时在 `sections` 阶段就注入」。两段共用同一份文本与同一套标记判断，第二次跑时 `appendSection` 看到标记直接返回原串，所以不会注入两份；代价只是一次字符串 `includes`。

---

## 3. 回复呈现通道

| 事实 | 依据 |
|---|---|
| 事件枚举 `started \| snapshot \| finished \| closed` | `toolpkg.d.ts:737` |
| payload：`{ chatId, messageTimestamp, variantIndex, parts }` | `toolpkg.d.ts:742`（字段 `:746` / `:750` / `:754` / `:758`） |
| `parts` 是**完整有序语义快照**，不是增量 | `toolpkg.d.ts:758` 注释「complete, ordered semantic snapshot」 |
| `MessagePart` 字段：`partId` / `sequence` / `kind` / `content` / `toolCallId` / `toolName` / `attributes` | `chat.d.ts:218` |
| `MessagePartKind` = `markdown \| thinking \| tool_call \| tool_result \| status` | `chat.d.ts:231` |
| 返回 `ResponsePresentationDelta { bubbles: ResponseBubble[] }` | `toolpkg.d.ts:778`（字段 `:782`） |
| `ResponseBubble { parts: Chat.MessagePart[], delayMs: number }` | `toolpkg.d.ts:764`（字段 `:768` / `:772`） |
| **append-only**：只追加新出现的稳定气泡 | `toolpkg.d.ts:778` 注释「Appends only newly stable response bubbles」 |
| 单次回复上限 **256 个气泡** | `toolpkg.d.ts:778` 注释「limited to 256 bubbles per response」 |
| `delayMs` 最多 **3000ms** | `toolpkg.d.ts:772` 注释「Waits up to 3000 milliseconds」 |
| 返回类型 `ChatResponseHookOutput = boolean \| ResponsePresentationDelta \| void` | `toolpkg.d.ts:794` |
| 允许异步：`ChatResponseHookReturn` 含 `Promise<…>` | `toolpkg.d.ts:799` |
| 气泡的 `parts` 不替换 canonical 历史 | `toolpkg.d.ts:768` 注释「without replacing canonical model history」 |

本工程的做法：`started` 建状态，`snapshot` / `finished` 刷新 `markdown` 与「是否含工具调用」，只在 `finished` 返回 `{ bubbles }`；每段外壳一个气泡，`delayMs` 默认 120（远低于 3000 上限）；默认最多 6 个气泡（远低于 256 上限）。气泡的 `parts[0].attributes` 带 `doubao-tail: "1"`。

---

## 4. 命令与菜单

| 事实 | 依据 |
|---|---|
| 事件名 `core_command` | `toolpkg.d.ts:909` |
| payload：`{ commandId, commandName, args, json }` | `toolpkg.d.ts:1365` |
| handler 返回 `CoreCommandResult`：`{ stdout?, stderr?, json? }` | `toolpkg.d.ts:1446` |
| 事件类型 `CoreCommandHookEvent` | `toolpkg.d.ts:2345` |
| 菜单项 `ChatMessageMenuItemRegistration`（`dialog` 支持 Compose DSL） | `toolpkg.d.ts:2974` |
| 菜单 payload 的 `ChatMessageSnapshot`（`timestamp` / `sender` / `content` …） | `toolpkg.d.ts:1899` |
| `ChatMessageMenuDialogRegistration { screen, title }` | `toolpkg.d.ts:2959` |
| `UiRouteRegistration` / `ToolboxUiModuleRegistration` | `toolpkg.d.ts:2687` / `:2657` |

本工程用了 `registerCoreCommand`（`name: "doubao"`）；菜单项与 UI 路由**没有注册**（理由见 `DESIGN.md` 第 6 节）。

---

## 5. 存储与文件

| 事实 | 依据 |
|---|---|
| `ToolPkg.getConfigDir(pluginId?)`：注册期与运行期都可用，按「安装所有者」维度 | `toolpkg.d.ts:4292`（命名空间）/ `:4311`（全局） |
| `getLocalDataDir()` / `getSpaceDataDir()` 另有独立维度 | `toolpkg.d.ts:4296` / `:4300`（全局别名 `:4315` / `:4319`） |
| `Tools.Files.read(path)` → `FileContentData` | `types/files.d.ts:195`（另有 options 重载 `:199`） |
| `Tools.Files.write(path, content, append?)` | `types/files.d.ts:219` |
| `Tools.Files.exists(path)` → `FileExistsData` | `types/files.d.ts:124` |
| `Tools.Files.list(path)` → `DirectoryListingData` | `types/files.d.ts:161` |
| `Tools.Files.mkdir(path, create_parents?)` | `types/files.d.ts:167` |
| `Tools.Files.deleteFile(path, recursive?)` | `types/files.d.ts:101` |
| Storage 三套接口：`Storage.sqlite` / `Storage.objects` / `Storage.dataStore`，均带版本与 merge 语义 | `types/storage.d.ts:314` / `:324` / `:334`（各自的 `open` 在 `:318` / `:328` / `:338`） |

本工程用 `getConfigDir()` + 普通 JSON 文件（`doubao-profile.json` + `snapshots/`），不用 Storage API，理由见 `DESIGN.md` 第 3 节。

---

## 6. 打包与入口

| 事实 | 依据 |
|---|---|
| `.toolpkg` 就是 ZIP，`manifest.json` 在根目录 | `scripts/build.mjs`（自写 ZIP 写入器，deflate + CRC32） |
| 主入口必须导出 `exports.registerToolPkg = …` | `scripts/build.mjs` 正则校验 `/exports\.registerToolPkg\s*=/` |
| 子包入口文件必须含 `/* METADATA … */` JSON 块 | `scripts/build.mjs` 校验 `/METADATA/`；`src/tools/doubao_tools.ts` 首行 |
| `manifest.api_version` 必须是 `2.0.0`，`schema_version` 必须是 `1` | `scripts/build.mjs` |
| 子包 id `doubao_tools`，entry `dist/tools/doubao_tools.js` | `manifest.json` `subpackages[0]` |
| 打包清单：`manifest.json` / `dist/main.js` / `dist/prompt.js` / `dist/core/*.js`（config、lexicon、render、templates、types）/ `dist/data/*.data.js` / `dist/tools/doubao_tools.js` / `README.md` / 三份 `docs/*.md` / `LICENSE` | `scripts/build.mjs` 的 `INCLUDE` 与 `CORE_FILES` |
| 产物名 `<toolpkg_id>-<version>.toolpkg` → `com.operit.doubao_style-1.0.0.toolpkg` | `scripts/build.mjs` |

---

## 7. 本工程用到的固定标识

| 标识 | 值 | 位置 |
|---|---|---|
| 提示词钩子 id | `doubao.system_prompt_compose` | `src/main.ts` |
| 回复钩子 id | `doubao.chat_response` | `src/main.ts` |
| 命令 id / name | `doubao_command` / `doubao` | `src/main.ts` |
| 提示词去重标记 | `<!-- operit-doubao:profile -->` | `src/prompt.ts` |
| 气泡属性 | `doubao-tail` = `"1"` | `src/main.ts` |
| 配置文件名 | `doubao-profile.json` | `src/main.ts`、`src/tools/doubao_tools.ts` |
| 快照目录 | `snapshots/`（在 `getConfigDir()` 下） | 同上 |
| 状态表上限 | 64 条（`MAX_STATES`） | `src/main.ts` |

---

## 8. 未验证项（装机后按此清单实测）

下面每一条都是「代码按这个假设写，但还没在真机 Operit2 上验证」。实测时逐条打勾，把结果补进本文件；**不要**把没验证的结论写进 README。

### 8.1 `after_compose_system_prompt` 的 `payload.systemPrompt` 非空

- 为什么重要：`src/main.ts` 在 `systemPrompt` 为空字符串时直接返回 `null`（不注入）。如果宿主在这一阶段传空串，提示词通道会静默失效。
- 怎么测：临时在 `onSystemPromptCompose` 里 `console.log(JSON.stringify({ stage, len: current.length }))`，开一次新会话，看日志。
- 预期：`stage === "after_compose_system_prompt"`，`len > 0`（至少含宿主自己的基础提示）。
- 若不符：把 `current === ""` 的早退改成「空串时直接返回 `{ systemPrompt: section }`」。

### 8.2 多插件叠加顺序

- 为什么重要：返回 `{ systemPrompt }` 是**整体替换**。两个插件都在这个阶段返回完整串时，后执行的会覆盖先执行的。
- 怎么测：同时启用另一个会改系统提示的插件，各写一个可识别标记，开新会话看最终提示里两个标记是否都在。
- 预期：不确定。若互相覆盖，需要改成「读最新 `systemPrompt` 再拼」，或与其他插件约定顺序。
- 记录项：谁先谁后、覆盖方向、是否与本插件的标记去重冲突。

### 8.3 `finished` 事件里追加气泡的真实呈现

- 为什么重要：`ResponsePresentationDelta` 是展示层，宿主怎么渲染（独立气泡 / 同一气泡分段 / 折叠）没有类型层证据。
- 怎么测：`/doubao level heavy` 后提一个普通问题（不调工具），看回复末尾是否出现 4–6 段外壳，且原文没变。
- 预期：原文完整保留，外壳在下方逐段出现。
- 记录项：气泡之间的视觉间距、是否带时间戳、是否可选中复制、`attributes` 里的 `doubao-tail` 是否透出到 UI。

### 8.4 `delayMs` 行为

- 为什么重要：默认 120ms，代码假设它是「每个气泡发布前等待」。若宿主把它当「整批延迟」，观感会不同。
- 怎么测：把 `doubao-profile.json` 的 `tail.delayMs` 改成 `0` 与 `3000` 各试一次，观察出现节奏；再试 `3001` 确认被裁剪到 3000。
- 预期：`0` 一次性出现；`3000` 明显逐段停顿；`3001` 被 `clampInt(…, 0, 3000)` 截断。
- 记录项：实际是逐气泡延迟还是整批延迟；超上限时宿主是拒绝还是裁剪。

### 8.5 子包与主入口共用 `configDir`

- 为什么重要：两边各有一份设置解析副本，靠「同一个目录」保证一致。若子包拿到的 `getConfigDir()` 不同（例如按子包 id 分目录），两边会读写不同文件。
- 怎么测：`/doubao set negationCount 12` 之后，让模型调 `doubao_status`，看 `knobs.negationCount` 是否为 12；再让模型调 `doubao_configure({level:"heavy"})`，然后 `/doubao status` 看档位是否变了。
- 预期：双向一致。
- 若不符：改成由主入口通过 `registerApi` 暴露读写接口，子包 `callDependency` 调用（见 `toolpkg.d.ts` 的 `callDependency` / `registerApi`）。

### 8.6 256 气泡上限

- 为什么重要：`ResponsePresentationDelta` 注释写明「limited to 256 bubbles per response」，但超限行为（截断 / 报错 / 丢弃整批）没有说明。
- 怎么测：把 `tail.maxParagraphs` 调到 12（代码上限），`level max`，`negationRounds` 拉到 6，让外壳段落尽量多；再临时把 `maxParagraphs` 上限改到 300 试一次超限。
- 预期：≤256 正常；>256 时宿主截断或拒绝，且不影响正文。
- 记录项：超限是静默截断还是抛错；抛错时钩子返回值是否被丢弃。

### 8.7 提示词通道与 summary 钩子的隔离

- 为什么重要：README 声称「标题/摘要不会被污染」，依据是只挂了 `after_compose_system_prompt` / `compose_system_prompt_sections` 两个系统提示阶段，没有挂 summary 钩子。若宿主把同一钩子也用于摘要组装，结论就不成立。
- 怎么测：开新会话让宿主自动生成标题；检查标题是否出现「最X」「我就在这里」等特征。
- 预期：标题正常。

### 8.8 配置目录在注册期可用

- 为什么重要：`main.ts` 在注册函数里不读文件（只在钩子/命令里读），但 `getConfigDir()` 的注释说注册期可用。若实际不可用，`registerToolPkg` 期间任何路径拼接都会抛。
- 怎么测：在 `registerToolPkg` 开头 `console.log(ToolPkg.getConfigDir())`。
- 预期：返回非空路径字符串。

### 8.9 首次安装时配置目录不存在

- 为什么重要：`saveSettings` 先 `mkdir(configDir(), true)` 再写；`loadSettings` 先 `exists` 再读。若 `mkdir` 对已存在目录报错，保存会失败。
- 怎么测：全新安装后直接 `/doubao level light`，再 `ls` 配置目录。
- 预期：目录被创建，`doubao-profile.json` 存在且是格式化 JSON。

### 8.10 子包 METADATA 与工具可见性

- 为什么重要：子包默认 `enabledByDefault: false`，模型看不到工具是预期行为，但「启用后多久可见」没有验证。
- 怎么测：启用子包后新开一轮对话，问模型「你有哪些 doubao 工具」。
- 预期：能看到 4 个：`doubao_status` / `doubao_configure` / `doubao_render` / `doubao_lexicon`。
