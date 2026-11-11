# 豆包语助手（Operit2 ToolPkg）

把助手的回复写成中文互联网所说的「豆包语」：**排比式真诚 + 清单式边界 + 疗愈式诊断 + 复读式共情 + 服务式收尾**——听起来很懂你，细看像模板；情绪价值拉满，信息密度很低。

本工程是 DSH 插件 [dsh-doubao](https://github.com/Ralsei1337/dsh-doubao) 的 Operit2 移植版。只改输出风格，不改角色设定、权限与工具行为。

---

## 它改什么 / 不改什么

| 改 | 不改 |
|---|---|
| 系统提示词末尾追加一段风格规范（模型自己就按六段结构写正文） | 模型原文一个字都不改 |
| 回复结束后追加若干外壳气泡（诊断 / 否定清单 / 复读 / 收尾） | 不修改、不替换、不前插已有内容 |
| `/doubao` 命令与 4 个模型可见工具的读写（同一份配置） | 不改工具权限、不改模型选择、不改会话设置 |
| 追加气泡带 `doubao-tail=1` 属性标记 | 追加内容不进 canonical 历史，不污染下一轮上下文 |

---

## 安装

1. 取打包产物 `artifacts/com.operit.doubao_style-1.0.0.toolpkg`（ZIP，manifest 在根目录），在 Operit2 里导入。
2. 到 **插件设置** 里启用「豆包语助手」。manifest 里 `enabled_by_default: false`，装完默认是关的。
3. 到 **子包** 里启用「豆包语工具」（`doubao_tools`），否则模型看不到 4 个 `doubao_*` 工具。

启用后默认状态：总开关开、两条通道都开、档位 `medium`（标准）。

从源码构建：

```bash
npm install
npm run build      # 生成数据模块（scripts/gen-data.mjs）+ tsc 编译到 dist/
npm run pack       # 打 artifacts/com.operit.doubao_style-1.0.0.toolpkg
```

`scripts/build.mjs` 会在打包前校验：manifest 可解析、`main` / `subpackages[].entry` 指向真实文件、主入口导出 `registerToolPkg`、子包入口含 `METADATA` 块。

---

## 三个入口

| 入口 | 注册点 | 作用 |
|---|---|---|
| ① 提示词通道 | `ToolPkg.registerSystemPromptComposeHook`，`after_compose_system_prompt` 为主、`compose_system_prompt_sections` 兜底 | 把风格规范追加进 `systemPrompt`，让模型自己写对正文 |
| ② 尾部通道 | `ToolPkg.registerChatResponseHook`，在 `finished` 事件返回 `ResponsePresentationDelta` | 回复结束后追加外壳气泡：诊断、否定清单、复读、服务化收尾 |
| ③ 命令与工具 | `ToolPkg.registerCoreCommand` + 子包 `doubao_tools` | `/doubao` 命令调参；4 个工具给模型自查自调 |

两条通道可以单独关（`/doubao prompt off`、`/doubao tail off`）。只留提示词通道更自然；只留尾部通道更稳定（外壳 100% 出现）。

**子包的 4 个工具**（模型可见，与 `/doubao` 读写同一份配置）：

| 工具 | 作用 | 参数 | 副作用 |
|---|---|---|---|
| `doubao_status` | 读档位、分带、两条通道、各段条数、词库规模、配置路径 | 无 | 只读 |
| `doubao_configure` | 改配置，只改传入的字段 | `enabled`、`level`、`promptEnabled`、`tailEnabled`、`knobs`（对象，覆盖单项数值）、`skipToolTurns`、`skipCodeBlocks` | 写配置并给旧值留快照；`level` 会套用该档预设值 |
| `doubao_render` | 把一段文本渲染成豆包语 | `text`（必填）、`seed`、`level`（临时档位，不写配置） | 无 |
| `doubao_lexicon` | 读词库规模，或某一类词条（含自定义） | `key`（类别名）、`limit`（默认 20，上限 200） | 只读 |

不传任何受支持字段时 `doubao_configure` 返回 `applied: false`，不会写盘。

---

## `/doubao` 命令表

命令名 `doubao`，参数以空格分隔。无参等价于 `status`。

| 命令 | 作用 | 输出 |
|---|---|---|
| `/doubao`、`/doubao status` | 查看档位、分带、两条通道、全部参数、计数、词库规模、快照与路径 | JSON |
| `/doubao on` / `off` | 总开关 | `豆包语助手已启用。/ 已停用。` |
| `/doubao level off\|light\|medium\|heavy\|max` | 切档 | `强度档位：medium（50%），实际分带 medium。` |
| `/doubao prompt on\|off` | 提示词通道 | `提示词通道：开 / 关` |
| `/doubao tail on\|off` | 尾部通道 | `尾部通道：开 / 关` |
| `/doubao set <参数> <值>` | 调单项参数，数值会按区间裁剪 | `已设置 negationCount = 12` |
| `/doubao custom intensifiers\|negations\|closers add <词条>` | 追加自定义词条（一行一条） | `自定义词条（intensifiers）已更新：N 条。` |
| `/doubao custom intensifiers\|negations\|closers clear` | 清空该类自定义词条 | 同上 |
| `/doubao render <文本>` | 用当前配置把文本渲染成豆包语 | 渲染结果 |
| `/doubao preview` | 用固定演示正文渲染一次（不接受参数） | 渲染结果 |
| `/doubao lexicon [键名]` | 词库规模；给键名则给该类条数 | JSON / `key: N 条` |
| `/doubao snapshots` | 列出快照文件名 | 每行一个；空则 `暂无快照。` |
| `/doubao revert [快照名]` | 回滚配置；省略则回滚到最新一份 | `已回滚到 <快照名>` |
| `/doubao reset` | 恢复默认配置（旧值先留快照） | `已恢复默认配置（旧值已留快照）。` |

`set` 的数值键：`barrage`、`negationCount`、`negationRounds`、`diagnoses`、`boundaries`、`fillers`、`dilate`、`openers`、`transitions`、`serviceClosers`、`refusalChance`、`templateShare`、`seed`。
`set` 的布尔键：`skipCodeBlocks`、`skipToolTurns`、`enabled`、`promptEnabled`、`tailEnabled`（接受 `true/false/on/off/1/0`）。

**切档的行为**：`/doubao level <档>` = **套用该档的一组预设数值**，覆盖 12 个数值旋钮（`barrage`、`negationCount`、`negationRounds`、`diagnoses`、`boundaries`、`fillers`、`dilate`、`openers`、`transitions`、`serviceClosers`、`refusalChance`、`templateShare`）；非数值项保持不变——`enabled`、`promptEnabled`、`tailEnabled`、`skipCodeBlocks`、`skipToolTurns`、三类自定义词条、`seed`。`off` 档除 `seed` 外全部清零。想保留手调值就不要用 `level`，改用 `set` 逐项改；想回到某档原厂数值，直接 `level <档>` 即可，不必先 `reset`。`doubao_configure` 传 `level` 的行为与命令完全一致。

---

## 五档强度

档位不是连续旋钮：点一档 = 一组确定参数，之后还能逐项微调。下表数值取自源码档位表（`src/core/config.ts` 的 `LEVEL_PRESETS`，与 `dsh-doubao/lib/config.js` 一致）。

| 参数 | 含义 | off | light | medium（默认） | heavy | max |
|---|---|---|---|---|---|---|
| `barrage` | 形容词排比条数 | 0 | 3 | 5 | 10 | 20 |
| `negationCount` | 否定项条数 | 0 | 4 | 8 | 18 | 45 |
| `negationRounds` | 否定清单复读遍数 | 1 | 1 | 2 | 3 | 4 |
| `diagnoses` | 疗愈诊断条数 | 0 | 1 | 1 | 2 | 3 |
| `boundaries` | 边界承诺段数 | 0 | 1 | 1 | 2 | 3 |
| `fillers` | 共情填充句条数 | 0 | 1 | 2 | 3 | 5 |
| `dilate` | 信息稀释重复次数 | 0 | 0 | 1 | 2 | 3 |
| `openers` | 元话语开场数量 | 0 | 0 | 1 | 2 | 3 |
| `transitions` | 段落间过渡铺垫数量 | 0 | 0 | 1 | 2 | 3 |
| `serviceClosers` | 服务化收尾句数 | 0 | 1 | 1 | 2 | 3 |
| `refusalChance` | 反转拒答概率（%） | 0 | 0 | 3 | 8 | 15 |
| `templateShare` | 走句式模板的占比（%） | 0 | 25 | 40 | 60 | 100 |
| `intensity` | 展示用百分数（不参与计算） | 0 | 25 | 50 | 75 | 100 |

其中 `boundaries`、`openers`、`transitions` 实际只当开关用（0 = 关，≥1 = 开），`fillers` 最多取 3 条——逐项见 `docs/STYLE-GUIDE.md` 第 7 节。

各参数的合法区间（`set` 会按此裁剪，超出即截断）：

| 参数 | 区间 | 参数 | 区间 |
|---|---|---|---|
| `barrage` | 0–40 | `fillers` | 0–8 |
| `negationCount` | 0–80 | `dilate` | 0–4 |
| `negationRounds` | 1–6 | `openers` | 0–3 |
| `diagnoses` | 0–4 | `transitions` | 0–3 |
| `boundaries` | 0–4 | `serviceClosers` | 0–3 |
| `refusalChance` | 0–100 | `templateShare` | 0–100 |
| `seed` | 0–2147483647 | | |

另有三个渲染开关，默认值如下：

| 键 | 默认 | 作用 |
|---|---|---|
| `skipCodeBlocks` | `true` | 正文含代码块（` ``` `）时整段跳过正文加料：不加序数词、不加铺垫、不做稀释；外壳照常 |
| `skipToolTurns` | `true` | 回复里出现 `tool_call` / `tool_result` 时跳过尾部外壳 |
| `seed` | `0` | `0` = 每次随机；非 0 = 同种子出同一段文本。不属于档位表，切档不会改它 |

**实际分带**（`resolveBand`）与档位不完全等价：档位 `off` 就是 `off`；`barrage`、`negationCount`、`serviceClosers` 三个都为 0 时也回落 `off`（参数被手动清零 = 关了）；其余按 `barrage` 判断——`>= 12` 为 `full`，`>= 5` 为 `medium`，否则 `light`。这样「档位说拉满、参数全是 0」不会自相矛盾。`status` 里的 `band` 就是它。

---

## 自定义词条

三类，一行一条，**排在内置词条之前**（渲染时优先取用）：

| 类别 | 命令 | 进哪一段 |
|---|---|---|
| 形容词 | `custom intensifiers add <词条>` | 高能前置的「最X、最Y」排比 |
| 否定项 | `custom negations add <词条>` | 否定清单「不X，不Y」 |
| 收尾句 | `custom closers add <词条>` | 服务化收尾 |

```text
/doubao custom intensifiers add 最不端着
/doubao custom intensifiers add 最像人话
/doubao custom negations add 不给你贴标签
/doubao custom closers add 要不要我给你留一份备忘？
```

重复词条会被去重；`clear` 清空该类别。自定义词条写进配置文件，和内置词条合并成「词库视图」（`viewLexicon`），渲染时先取自定义部分再随机补齐。

---

## 配置与快照位置

都在 `ToolPkg.getConfigDir()` 下（安装所有者维度，主入口与子包共用同一个目录）：

```text
<ToolPkg.getConfigDir()>/
├── doubao-profile.json     # 配置：config + prompt + tail + snapshots
└── snapshots/
    ├── 2026-11-11T13-24-05-123Z.json
    └── ...                 # 每次保存前的旧值，默认保留 20 份（1–200）
```

`doubao-profile.json` 的结构：

```jsonc
{
  "schemaVersion": 1,
  "config": { /* 档位、13 个数值参数、3 个自定义词条字段、3 个开关、seed */ },
  "prompt": { "previewOnly": false, "customSection": "" },
  "tail": { "delayMs": 120, "maxParagraphs": 6, "dedupe": true },
  "snapshots": { "keep": 20 }
}
```

`prompt.previewOnly`（只统计注入长度、不改写提示词）和 `prompt.customSection`（自定义规范正文，覆盖内置正文）没有命令入口，要手改这个文件；`customSection` 非空时，`<!-- operit-doubao:profile -->` 标记仍由插件自动补齐。

`tail.delayMs` 上限 3000（宿主规定），`tail.maxParagraphs` 区间 1–12，`tail.dedupe` 打开时若检测到模型已经自己写成豆包语就不追加（计数里体现为 `tailSkippedAlready`）。

---

## 常见问题

**为什么我开了没反应？**

按顺序查四件事：

1. **档位是 `off`**。`off` 会把除 `seed` 外的数值全部清零，两条通道都空转。`/doubao status` 看 `band`，是 `off` 就 `level medium`。
2. **子包没启用**。这只影响 4 个 `doubao_*` 工具是否可见；提示词通道与尾部通道由主包注册，子包关着也照常工作。如果你本来是想用工具调参，去启用子包。
3. **提示词通道被别的插件覆盖**。`after_compose_system_prompt` 的返回值会整体替换该阶段的值。别的插件若返回一份不含 `<!-- operit-doubao:profile -->` 的完整 `systemPrompt`，本段就被盖掉；下一轮 compose 会重新注入。反复丢就关掉那个插件，或只留尾部通道。
4. **这是工具轮次**。`skipToolTurns` 默认开，`finished` 快照里出现 `tool_call` / `tool_result` 就不追加外壳——避免在工具结果后面堆共情。

**为什么回复正文没有变长？**

尾部通道只能追加，不能改写。正文长度完全由提示词通道决定：模型不听话，正文就不会膨胀，只能看到后面多出来的几段外壳。想稳定变长就提高档位并确认提示词通道开着。

**切档会不会覆盖我手调的参数？**

会。`/doubao level <档>` 就是「套预设」：12 个数值旋钮被该档数值覆盖，非数值项（开关、自定义词条、`seed`）不动。想保留手调值就不要用 `level`，用 `set <参数> <值>` 或 `doubao_configure` 的 `knobs` 逐项改；想回到某档原厂数值，直接 `level <档>` 即可，不必先 `reset`。命令与 `doubao_configure` 两个入口行为一致。

**为什么外壳重复了两份？**

`tail.dedupe` 关掉时会出现：模型自己写了否定清单与收尾，尾部又补一份。默认开着，命中就不追加。

**为什么 `revert` 说没有快照？**

快照只在「保存」时生成：第一次保存前没有旧值，所以 `snapshots/` 是空的。先改一次配置再看。

---

## 已知限制

1. **没有流式改写钩子。** DSH 版能在 `llm/stream` 上改写正文、前插前缀；Operit2 没有等价钩子。所以「改写模型正文」这条通道降级为：提示词通道让模型自己写对 + 回复结束时追加外壳气泡。**原文一个字都不改。**
2. **追加是 append-only。** `ResponsePresentationDelta` 不能前插，「高能前置」只能靠提示词通道让模型自己写；尾部通道只补诊断、否定清单、复读、收尾。
3. **气泡是展示层。** 追加的外壳不进 canonical 历史，下一轮对话不会把它当上下文——既不会污染历史，也意味着你不能靠外壳「教育」模型。
4. 单次回复最多 256 个气泡、单个气泡 `delayMs` 最多 3000ms（宿主上限）。本插件默认最多 6 个气泡（`tail.maxParagraphs: 6`）、每段一个气泡、120ms，离上限很远。
5. 一次回复只追加一次（`emitted` 标记），`snapshot` 事件不会重复追加。
6. 主入口与子包是两个独立运行时，设置解析逻辑各有一份精简副本；两者读写同一份 `doubao-profile.json`，但不会共享内存状态。
7. 提示词通道只在 `after_compose_system_prompt`（主）与 `compose_system_prompt_sections`（兜底）两个阶段动手，靠 `<!-- operit-doubao:profile -->` 标记去重，不碰 summary 钩子——标题与摘要不会被豆包语污染（等价于 DSH 版 `skipPurposes` 的效果）。

---

## 文档

| 文件 | 内容 |
|---|---|
| `docs/DESIGN.md` | 为什么这样分层、为什么只追加、为什么用 JSON 而非 Storage API、幂等与兜底 |
| `docs/RUNTIME-FACTS.md` | 平台事实表（带 `types/*.d.ts` 行号）+ 装机后待实测清单 |
| `docs/STYLE-GUIDE.md` | 豆包语的可操作规格：六段结构、例句来源、什么算跑偏 |

---

## 许可证

MIT，见 [LICENSE](LICENSE)。
