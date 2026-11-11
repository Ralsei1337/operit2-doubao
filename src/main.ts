/// <reference path="../types/index.d.ts" />

/**
 * 豆包语助手（Doubao Style）· Operit2 ToolPkg 版
 *
 * 移植自 DSH 插件 dsh-doubao（https://github.com/Ralsei1337/dsh-doubao）。
 *
 * 两条通道：
 *   ① 提示词通道 —— 在 `after_compose_system_prompt` 追加「豆包语」风格规范，
 *      让模型自己就用豆包语写正文；
 *   ② 尾部通道 —— 在 `ChatResponseHook` 的 `finished` 事件里，用
 *      `ResponsePresentationDelta` 追加外壳气泡：疗愈诊断、否定清单、复读、收尾。
 *
 * 与 DSH 版的差别（平台决定，不是取舍）：
 *   - DSH 有 `llm/stream` 瀑布，可以改写正文、前插前缀；Operit2 的回复钩子
 *     **只能追加气泡**（append-only），所以前缀交给提示词通道，尾部由钩子兜底。
 *   - 气泡属于展示层，不进 canonical 历史：追加的外壳不会被下一轮对话当成上下文。
 *
 * 设计约束：只改输出风格，不改角色设定、权限、工具行为；任何异常都静默回落到
 * 「不改动」，不让插件故障影响用户对话。
 */

import type { Chat as ChatNamespace } from "../types/chat";
import { normalizeConfig, presetFor, resolveBand, splitLines, LEVELS, LEVEL_PERCENT, LIMITS } from "./core/config";
import type { DoubaoConfig, DoubaoLevel } from "./core/types";
import { lexiconStats } from "./core/lexicon";
import { templateStats } from "./core/templates";
import { buildShell, createRng, expandText, previewSample } from "./core/render";
import { appendSection, promptSectionText } from "./prompt";

/* ========================================================================
 * 1. 常量
 * ===================================================================== */

const PLUGIN_VERSION = "1.0.0";
const SETTINGS_FILE = "doubao-profile.json";
const SNAPSHOT_DIR = "snapshots";

const HOOK_SYSTEM_PROMPT = "doubao.system_prompt_compose";
const HOOK_CHAT_RESPONSE = "doubao.chat_response";
const COMMAND_ID = "doubao_command";

/** 追加气泡的属性标记，便于宿主与其他插件识别「这是外壳，不是正文」。 */
const TAIL_ATTRIBUTE = "doubao-tail";

/* ========================================================================
 * 2. 设置模型
 * ===================================================================== */

export interface DoubaoSettings {
  schemaVersion: number;
  /** 移植过来的渲染配置（档位、各段条数、自定义词条、种子）。 */
  config: DoubaoConfig;
  prompt: {
    /** 预览模式：只统计将要注入的长度，不改写提示词。 */
    previewOnly: boolean;
    /** 自定义规范正文；空串表示用内置正文。 */
    customSection: string;
  };
  tail: {
    /** 每个气泡之间的延迟（毫秒），宿主上限 3000。 */
    delayMs: number;
    /** 单次回复最多追加多少个气泡。 */
    maxParagraphs: number;
    /** 检测到模型已经自己写成豆包语时，不再追加外壳。 */
    dedupe: boolean;
  };
  snapshots: {
    /** 保存设置时保留的历史快照份数。 */
    keep: number;
  };
}

function defaultSettings(): DoubaoSettings {
  return {
    schemaVersion: 1,
    config: normalizeConfig({}),
    prompt: { previewOnly: false, customSection: "" },
    tail: { delayMs: 120, maxParagraphs: 6, dedupe: true },
    snapshots: { keep: 20 },
  };
}

const DEFAULT_SETTINGS: DoubaoSettings = defaultSettings();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(num)));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 档位预设覆盖的 12 个数值旋钮。 */
const NUMERIC_PRESET_KEYS = [
  "barrage",
  "negationCount",
  "negationRounds",
  "diagnoses",
  "boundaries",
  "fillers",
  "dilate",
  "openers",
  "transitions",
  "serviceClosers",
  "refusalChance",
  "templateShare",
] as const;

/**
 * 把任意补丁收敛成完整设置。
 *
 * 脏数据一律回落默认值：插件配置坏了，用户应该看到「风格没生效」，
 * 而不是「聊天报错」。
 */
export function mergeSettings(base: DoubaoSettings, patch: unknown): DoubaoSettings {
  const out = clone(base);
  if (!isRecord(patch)) return out;

  if (typeof patch.schemaVersion === "number") out.schemaVersion = Math.trunc(patch.schemaVersion);

  if (isRecord(patch.config)) {
    // 手改配置文件时常见写法是只写 {"level":"heavy"}：这时按「选档位 = 套一组数值」
    // 处理，补上该档预设；一旦显式给了任何数值旋钮，就以显式值为准，不再套预设。
    const patchConfig = patch.config as Record<string, unknown>;
    const explicitKnobs = NUMERIC_PRESET_KEYS.some((key) => typeof patchConfig[key] === "number");
    const requestedLevel = typeof patchConfig.level === "string" ? patchConfig.level : "";
    const levelPreset =
      !explicitKnobs && LEVELS.includes(requestedLevel as DoubaoLevel) && requestedLevel !== out.config.level
        ? presetFor(requestedLevel)
        : null;
    out.config = normalizeConfig({
      ...out.config,
      ...(levelPreset ?? {}),
      ...patchConfig,
    });
  }

  const prompt = patch.prompt;
  if (isRecord(prompt)) {
    if (typeof prompt.previewOnly === "boolean") out.prompt.previewOnly = prompt.previewOnly;
    if (typeof prompt.customSection === "string") out.prompt.customSection = prompt.customSection;
  }

  const tail = patch.tail;
  if (isRecord(tail)) {
    out.tail.delayMs = clampInt(tail.delayMs, out.tail.delayMs, 0, 3000);
    out.tail.maxParagraphs = clampInt(tail.maxParagraphs, out.tail.maxParagraphs, 1, 12);
    if (typeof tail.dedupe === "boolean") out.tail.dedupe = tail.dedupe;
  }

  const snapshots = patch.snapshots;
  if (isRecord(snapshots)) {
    out.snapshots.keep = clampInt(snapshots.keep, out.snapshots.keep, 1, 200);
  }

  return out;
}

/* ========================================================================
 * 3. 路径与文件
 * ===================================================================== */

function configDir(): string {
  return ToolPkg.getConfigDir();
}

function settingsPath(): string {
  return configDir() + "/" + SETTINGS_FILE;
}

function snapshotDir(): string {
  return configDir() + "/" + SNAPSHOT_DIR;
}

/** 读取设置；文件缺失或损坏时回落默认值，不抛。 */
export async function loadSettings(): Promise<DoubaoSettings> {
  try {
    const exists = await Tools.Files.exists(settingsPath());
    if (!exists.exists) return clone(DEFAULT_SETTINGS);
    const file = await Tools.Files.read(settingsPath());
    return mergeSettings(DEFAULT_SETTINGS, JSON.parse(file.content));
  } catch (error) {
    counters.lastError = "loadSettings: " + String(error);
    console.error("[doubao] loadSettings failed:", String(error));
    return clone(DEFAULT_SETTINGS);
  }
}

/** 写设置；写盘前给旧值留一份快照。 */
export async function saveSettings(next: DoubaoSettings): Promise<DoubaoSettings> {
  const merged = mergeSettings(DEFAULT_SETTINGS, next);
  try {
    const exists = await Tools.Files.exists(settingsPath());
    if (exists.exists) {
      const previous = await Tools.Files.read(settingsPath());
      await snapshotContent(previous.content);
    }
  } catch (error) {
    console.error("[doubao] snapshot before save failed:", String(error));
  }
  await Tools.Files.mkdir(configDir(), true);
  await Tools.Files.write(settingsPath(), JSON.stringify(merged, null, 2), false);
  await pruneSnapshots(merged.snapshots.keep);
  return merged;
}

async function snapshotContent(content: string): Promise<string> {
  await Tools.Files.mkdir(snapshotDir(), true);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = snapshotDir() + "/" + stamp + ".json";
  await Tools.Files.write(path, content, false);
  return path;
}

export async function listSnapshots(): Promise<string[]> {
  try {
    const listing = await Tools.Files.list(snapshotDir());
    return listing.entries
      .filter((entry) => entry.isDirectory === false && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function pruneSnapshots(keep: number): Promise<void> {
  const names = await listSnapshots();
  if (names.length <= keep) return;
  for (const name of names.slice(0, names.length - keep)) {
    try {
      await Tools.Files.deleteFile(snapshotDir() + "/" + name);
    } catch (error) {
      console.error("[doubao] prune failed:", String(error));
    }
  }
}

/** 回滚到指定快照（不指定则用最新一份）。 */
export async function revertSettings(name?: string): Promise<{ ok: boolean; restored: string | null }> {
  const names = await listSnapshots();
  if (names.length === 0) return { ok: false, restored: null };
  const target = name && names.includes(name) ? name : names[names.length - 1];
  const file = await Tools.Files.read(snapshotDir() + "/" + target);
  const restored = mergeSettings(DEFAULT_SETTINGS, JSON.parse(file.content));
  await Tools.Files.write(settingsPath(), JSON.stringify(restored, null, 2), false);
  return { ok: true, restored: target };
}

/* ========================================================================
 * 4. 运行期计数
 * ===================================================================== */

const counters = {
  systemPromptCalls: 0,
  profileInjected: 0,
  responseEvents: 0,
  tailAppended: 0,
  tailSkippedTool: 0,
  tailSkippedAlready: 0,
  tailSkippedEmpty: 0,
  lastProfileChars: 0,
  lastTailBubbles: 0,
  lastError: "",
};

/* ========================================================================
 * 5. 提示词通道
 * ===================================================================== */

function stageOf(event: { eventName: string }, payload: { stage?: string }): string {
  const stage = payload.stage;
  return stage === undefined || stage === "" ? event.eventName : stage;
}

/**
 * 系统提示词组合钩子。
 *
 * 返回值会**整体替换**该阶段的值，所以必须基于 payload.systemPrompt 拼接，
 * 不能凭空造串；已含标记时返回 null，保证幂等。
 */
export async function onSystemPromptCompose(
  event: ToolPkg.SystemPromptComposeHookEvent
): Promise<ToolPkg.PromptHookObjectResult | null> {
  try {
    counters.systemPromptCalls += 1;
    const payload = (event && event.eventPayload) || ({} as ToolPkg.PromptHookEventPayload);
    // 主阶段是 after_compose_system_prompt；sections 阶段作为兜底：
    // 某些宿主版本在 after 阶段不带 systemPrompt，此时在 sections 阶段就注入。
    // 两处都注入不会重复——appendSection 检测到标记会原样返回。
    const stage = stageOf(event, payload);
    if (stage !== "after_compose_system_prompt" && stage !== "compose_system_prompt_sections") return null;

    const settings = await loadSettings();
    const cfg = settings.config;
    if (!cfg.enabled || !cfg.promptEnabled) return null;

    const current = payload.systemPrompt;
    if (typeof current !== "string" || current === "") return null;

    const section = promptSectionText(cfg, settings.prompt.customSection);
    if (section === "") return null;

    if (settings.prompt.previewOnly) {
      counters.lastProfileChars = section.length;
      return null;
    }

    const next = appendSection(current, section);
    if (next === current) return null;

    counters.profileInjected += 1;
    counters.lastProfileChars = section.length;
    return { systemPrompt: next };
  } catch (error) {
    counters.lastError = "system_prompt: " + String(error);
    console.error("[doubao] onSystemPromptCompose failed:", String(error));
    return null;
  }
}

/* ========================================================================
 * 6. 尾部通道
 * ===================================================================== */

interface ResponseState {
  hasToolCall: boolean;
  markdown: string;
  /** 已经追加过外壳的那一版正文；同一 key 收到不同正文时视为新回复。 */
  emittedText: string | null;
}

/** 单次回复的状态表。键 = chatId + 消息时间戳 + 变体序号。 */
const responseStates = new Map<string, ResponseState>();
const MAX_STATES = 64;

function responseKey(payload: ToolPkg.ChatResponseEventPayload): string {
  return String(payload.chatId) + ":" + String(payload.messageTimestamp) + ":" + String(payload.variantIndex);
}

function trimStates(): void {
  if (responseStates.size <= MAX_STATES) return;
  const overflow = responseStates.size - MAX_STATES;
  const keys = Array.from(responseStates.keys()).slice(0, overflow);
  for (const key of keys) responseStates.delete(key);
}

/** 判断模型是不是已经自己写成豆包语了。命中就不追加，避免双份外壳。 */
export function looksAlreadyDoubao(text: string): boolean {
  const source = typeof text === "string" ? text : "";
  if (source.trim() === "") return false;

  const paragraphs = source.split(/\n{2,}/);
  const hasNegationInventory = paragraphs.some((para) => {
    const hits = para.match(/不[\u4e00-\u9fa5]{1,6}[，、；。]/g);
    return hits !== null && hits.length >= 6;
  });
  const hasAnchor = /我就在这里|我就在这儿|我不走，我在这儿/.test(source);
  const hasDiagnosis = /你不是[^。！？\n]{1,14}，你(只是|是)/.test(source);
  const hasCloser = /要不要我|你想听更|你想让我|你点头就行/.test(source);

  return (hasAnchor && hasNegationInventory) || (hasDiagnosis && hasCloser);
}

function tailPart(content: string, index: number, stamp: number): ChatNamespace.MessagePart {
  return {
    partId: "doubao-" + String(stamp) + "-" + String(index),
    sequence: 0,
    kind: "markdown",
    content,
    toolCallId: null,
    toolName: null,
    attributes: { [TAIL_ATTRIBUTE]: "1" },
  };
}

/**
 * 回复呈现钩子。
 *
 * `started` / `snapshot` 只更新状态；`finished` 决定要不要追加外壳；
 * `closed` 清理状态。返回的 `ResponsePresentationDelta` 是**只能追加**的展示层，
 * 不会改写模型原文，也不进入 canonical 历史。
 */
export async function onChatResponse(
  event: ToolPkg.ChatResponseHookEvent
): Promise<ToolPkg.ResponsePresentationDelta | undefined> {
  try {
    counters.responseEvents += 1;
    const payload = (event && event.eventPayload) || ({} as ToolPkg.ChatResponseEventPayload);
    const name = event.eventName;
    const key = responseKey(payload);

    if (name === "started") {
      responseStates.set(key, { hasToolCall: false, markdown: "", emittedText: null });
      trimStates();
      return undefined;
    }
    if (name === "closed") {
      responseStates.delete(key);
      return undefined;
    }

    const state: ResponseState = responseStates.get(key) ?? { hasToolCall: false, markdown: "", emittedText: null };
    const rawParts = Array.isArray(payload.parts) ? payload.parts : [];
    // 宿主快照里混进 null / 非对象元素时按「没有这一段」处理，不能让整轮抛异常。
    const parts = rawParts.filter((part): part is ChatNamespace.MessagePart => typeof part === "object" && part !== null);
    if (parts.length > 0) {
      state.hasToolCall = parts.some((part) => part.kind === "tool_call" || part.kind === "tool_result");
      state.markdown = parts
        .filter((part) => part.kind === "markdown")
        .map((part) => (typeof part.content === "string" ? part.content : ""))
        .join("\n\n");
    }
    responseStates.set(key, state);
    trimStates();

    if (name !== "finished") return undefined;

    const settings = await loadSettings();
    const cfg = settings.config;
    if (!cfg.enabled || !cfg.tailEnabled) return undefined;
    if (resolveBand(cfg) === "off") return undefined;

    const text = state.markdown.trim();
    if (text === "") {
      counters.tailSkippedEmpty += 1;
      return undefined;
    }
    if (cfg.skipToolTurns && state.hasToolCall) {
      counters.tailSkippedTool += 1;
      return undefined;
    }
    if (settings.tail.dedupe && looksAlreadyDoubao(text)) {
      counters.tailSkippedAlready += 1;
      return undefined;
    }
    // 同一 key 只对同一版正文去重：宿主若复用时间戳承载新回复，仍然应该追加。
    if (state.emittedText !== null && state.emittedText === text) return undefined;

    const seed = cfg.seed > 0 ? cfg.seed : Math.floor(Math.random() * 1e9);
    const shell = buildShell(cfg, createRng(seed));
    const paragraphs = shell.suffix
      .filter((item): item is string => typeof item === "string" && item.trim() !== "")
      .slice(0, settings.tail.maxParagraphs);
    if (paragraphs.length === 0) return undefined;

    const stamp = typeof payload.messageTimestamp === "number" ? payload.messageTimestamp : Date.now();
    const bubbles: ToolPkg.ResponseBubble[] = paragraphs.map((paragraph, index) => ({
      parts: [tailPart(paragraph, index, stamp)],
      delayMs: settings.tail.delayMs,
    }));

    state.emittedText = text;
    counters.tailAppended += 1;
    counters.lastTailBubbles = bubbles.length;
    return { bubbles };
  } catch (error) {
    counters.lastError = "chat_response: " + String(error);
    console.error("[doubao] onChatResponse failed:", String(error));
    return undefined;
  }
}

/* ========================================================================
 * 7. 状态与命令
 * ===================================================================== */

export async function buildStatus(): Promise<Record<string, unknown>> {
  const settings = await loadSettings();
  const snapshots = await listSnapshots();
  const band = resolveBand(settings.config);
  return {
    version: PLUGIN_VERSION,
    enabled: settings.config.enabled,
    level: settings.config.level,
    band,
    intensity: settings.config.intensity,
    channels: {
      prompt: settings.config.promptEnabled,
      tail: settings.config.tailEnabled,
    },
    knobs: {
      barrage: settings.config.barrage,
      negationCount: settings.config.negationCount,
      negationRounds: settings.config.negationRounds,
      diagnoses: settings.config.diagnoses,
      boundaries: settings.config.boundaries,
      fillers: settings.config.fillers,
      dilate: settings.config.dilate,
      openers: settings.config.openers,
      transitions: settings.config.transitions,
      serviceClosers: settings.config.serviceClosers,
      refusalChance: settings.config.refusalChance,
      templateShare: settings.config.templateShare,
    },
    render: {
      seed: settings.config.seed,
      skipCodeBlocks: settings.config.skipCodeBlocks,
      skipToolTurns: settings.config.skipToolTurns,
      customIntensifiers: splitLines(settings.config.customIntensifiers).length,
      customNegations: splitLines(settings.config.customNegations).length,
      customClosers: splitLines(settings.config.customClosers).length,
    },
    tail: { ...settings.tail },
    prompt: { previewOnly: settings.prompt.previewOnly, customSectionChars: settings.prompt.customSection.length },
    counters: { ...counters },
    lexicon: lexiconStats(),
    templates: templateStats(),
    snapshots: { keep: settings.snapshots.keep, count: snapshots.length, latest: snapshots.length > 0 ? snapshots[snapshots.length - 1] : null },
    paths: { settings: settingsPath(), snapshots: snapshotDir() },
  };
}

function ok(stdout: string, json?: ToolPkg.JsonValue): ToolPkg.CoreCommandResult {
  return { stdout, json: json === undefined ? { ok: true } : json };
}

function fail(stdout: string): ToolPkg.CoreCommandResult {
  return { stdout, stderr: stdout, json: { ok: false, reason: stdout } };
}

const USAGE = [
  "用法：/doubao <子命令>",
  "  status                    查看档位、参数、通道开关与统计",
  "  on | off                  总开关",
  "  level off|light|medium|heavy|max   切换强度档位",
  "  prompt on|off             提示词通道（注入风格规范）",
  "  tail on|off               尾部通道（追加外壳气泡）",
  "  set <参数> <值>           调整单项参数，例如 set negationCount 12",
  "  custom intensifiers|negations|closers add <词条>   追加自定义词条（一行一条）",
  "  custom intensifiers|negations|closers clear        清空自定义词条",
  "  render <文本>             把一段文本渲染成豆包语（预览用）",
  "  preview                   用固定演示正文渲染一次",
  "  lexicon [键名]            查看词库规模",
  "  snapshots                 列出配置快照",
  "  revert [快照名]           回滚配置",
  "  reset                     恢复默认档位",
].join("\n");

const NUMERIC_KNOBS = [
  "barrage",
  "negationCount",
  "negationRounds",
  "diagnoses",
  "boundaries",
  "fillers",
  "dilate",
  "openers",
  "transitions",
  "serviceClosers",
  "refusalChance",
  "templateShare",
  "seed",
] as const;

const BOOLEAN_KNOBS = ["skipCodeBlocks", "skipToolTurns", "enabled", "promptEnabled", "tailEnabled"] as const;

export async function onDoubaoCommand(event: ToolPkg.CoreCommandHookEvent): Promise<ToolPkg.CoreCommandResult> {
  const rawArgs = event && event.eventPayload && Array.isArray(event.eventPayload.args) ? event.eventPayload.args : [];
  const args = rawArgs.map((arg) => String(arg).trim()).filter((arg) => arg !== "");
  const action = (args[0] ?? "status").toLowerCase();

  try {
    if (action === "status") {
      const status = await buildStatus();
      return ok(JSON.stringify(status, null, 2), status as ToolPkg.JsonValue);
    }

    if (action === "on" || action === "off") {
      const settings = await loadSettings();
      settings.config = normalizeConfig({ ...settings.config, enabled: action === "on" });
      const saved = await saveSettings(settings);
      return ok(`豆包语助手已${saved.config.enabled ? "启用" : "停用"}。`, { ok: true, enabled: saved.config.enabled });
    }

    if (action === "level") {
      const requested = (args[1] ?? "").toLowerCase() as DoubaoLevel;
      if (!LEVELS.includes(requested)) {
        return fail("用法：/doubao level off|light|medium|heavy|max");
      }
      const settings = await loadSettings();
      const base = settings.config;
      const preset = presetFor(requested);
      // 选档位 = 套一组数值：预设覆盖所有数值旋钮，非数值项（开关、自定义词条、种子）保持不变。
      settings.config = normalizeConfig({
        enabled: base.enabled,
        promptEnabled: base.promptEnabled,
        tailEnabled: base.tailEnabled,
        skipCodeBlocks: base.skipCodeBlocks,
        skipToolTurns: base.skipToolTurns,
        customIntensifiers: base.customIntensifiers,
        customNegations: base.customNegations,
        customClosers: base.customClosers,
        seed: base.seed,
        level: requested,
        ...preset,
      });
      const saved = await saveSettings(settings);
      return ok(
        `强度档位：${saved.config.level}（${LEVEL_PERCENT[saved.config.level]}%），实际分带 ${resolveBand(saved.config)}。`,
        { ok: true, level: saved.config.level, band: resolveBand(saved.config) }
      );
    }

    if (action === "prompt" || action === "tail") {
      const mode = (args[1] ?? "").toLowerCase();
      if (mode !== "on" && mode !== "off") return fail(`用法：/doubao ${action} on|off`);
      const settings = await loadSettings();
      const patch = action === "prompt" ? { promptEnabled: mode === "on" } : { tailEnabled: mode === "on" };
      settings.config = normalizeConfig({ ...settings.config, ...patch });
      const saved = await saveSettings(settings);
      return ok(
        `${action === "prompt" ? "提示词通道" : "尾部通道"}：${mode === "on" ? "开" : "关"}`,
        { ok: true, promptEnabled: saved.config.promptEnabled, tailEnabled: saved.config.tailEnabled }
      );
    }

    if (action === "set") {
      const key: string = String(args[1] ?? "");
      const raw = args.slice(2).join(" ");
      if (key === "" || raw === "") return fail("用法：/doubao set <参数> <值>\n可用参数：" + [...NUMERIC_KNOBS, ...BOOLEAN_KNOBS].join(", "));

      const settings = await loadSettings();
      const patch: Record<string, unknown> = {};
      if ((NUMERIC_KNOBS as readonly string[]).includes(key)) {
        const value = Number(raw);
        if (!Number.isFinite(value)) return fail(`参数 ${key} 需要一个数字。`);
        const bounds = (LIMITS as Record<string, number[]>)[key] ?? [0, 100];
        patch[key] = Math.min(bounds[1], Math.max(bounds[0], Math.trunc(value)));
      } else if ((BOOLEAN_KNOBS as readonly string[]).includes(key)) {
        const value = raw.toLowerCase();
        if (!["true", "false", "on", "off", "1", "0"].includes(value)) return fail(`参数 ${key} 需要 true/false。`);
        patch[key] = value === "true" || value === "on" || value === "1";
      } else {
        return fail("未知参数：" + key + "\n可用参数：" + [...NUMERIC_KNOBS, ...BOOLEAN_KNOBS].join(", "));
      }

      settings.config = normalizeConfig({ ...settings.config, ...patch });
      const saved = await saveSettings(settings);
      return ok(`已设置 ${key} = ${JSON.stringify((saved.config as unknown as Record<string, unknown>)[key])}`, {
        ok: true,
        key,
        value: (saved.config as unknown as Record<string, unknown>)[key] as ToolPkg.JsonValue,
      });
    }

    if (action === "custom") {
      const bucket = (args[1] ?? "").toLowerCase();
      const op = (args[2] ?? "").toLowerCase();
      const field =
        bucket === "intensifiers" ? "customIntensifiers"
          : bucket === "negations" ? "customNegations"
            : bucket === "closers" ? "customClosers"
              : "";
      if (field === "") return fail("用法：/doubao custom intensifiers|negations|closers add <词条> | clear");
      if (op !== "add" && op !== "clear") return fail("用法：/doubao custom " + bucket + " add <词条> | clear");

      const settings = await loadSettings();
      const current = settings.config as unknown as Record<string, string>;
      if (op === "clear") {
        current[field] = "";
      } else {
        const item = args.slice(3).join(" ").trim();
        if (item === "") return fail("要追加的词条不能为空。");
        const existing = splitLines(current[field]);
        if (!existing.includes(item)) existing.push(item);
        current[field] = existing.join("\n");
      }
      settings.config = normalizeConfig({ ...settings.config, ...(current as unknown as Partial<DoubaoConfig>) });
      await saveSettings(settings);
      return ok(`自定义词条（${bucket}）已更新：${splitLines(current[field]).length} 条。`, {
        ok: true,
        bucket,
        count: splitLines(current[field]).length,
      });
    }

    if (action === "render" || action === "preview") {
      const settings = await loadSettings();
      if (action === "preview") {
        const text = previewSample(settings.config);
        return ok(text, { ok: true, mode: "preview", text });
      }
      const input = args.slice(1).join(" ");
      if (input === "") return fail("用法：/doubao render <文本>");
      const text = expandText(input, settings.config, createRng(settings.config.seed > 0 ? settings.config.seed : 20261111));
      return ok(text, { ok: true, mode: "render", text });
    }

    if (action === "lexicon") {
      const stats = lexiconStats();
      const key = args[1];
      if (key && typeof (stats as Record<string, number>)[key] === "number") {
        return ok(`${key}: ${(stats as Record<string, number>)[key]} 条`, { ok: true, key, count: (stats as Record<string, number>)[key] });
      }
      return ok(JSON.stringify(stats, null, 2), stats as unknown as ToolPkg.JsonValue);
    }

    if (action === "snapshots") {
      const names = await listSnapshots();
      return ok(names.length === 0 ? "暂无快照。" : names.join("\n"), { ok: true, snapshots: names });
    }

    if (action === "revert") {
      const result = await revertSettings(args[1]);
      if (!result.ok) return fail("没有可回滚的快照。");
      return ok(`已回滚到 ${result.restored}`, { ok: true, restored: result.restored });
    }

    if (action === "reset") {
      await saveSettings(defaultSettings());
      return ok("已恢复默认配置（旧值已留快照）。", { ok: true });
    }

    return fail(USAGE);
  } catch (error) {
    return fail("命令执行失败：" + String(error));
  }
}

/* ========================================================================
 * 8. 注册
 * ===================================================================== */

const registrationState: Record<string, string> = {};

function registerSafely(key: string, action: () => void): void {
  try {
    action();
    registrationState[key] = "ok";
  } catch (error) {
    registrationState[key] = "failed: " + String(error);
    console.error("[doubao] register " + key + " failed:", String(error));
  }
}

export function registerToolPkg(): boolean {
  registerSafely("systemPromptCompose", () => {
    ToolPkg.registerSystemPromptComposeHook({ id: HOOK_SYSTEM_PROMPT, function: onSystemPromptCompose });
  });
  registerSafely("chatResponse", () => {
    ToolPkg.registerChatResponseHook({ id: HOOK_CHAT_RESPONSE, function: onChatResponse });
  });
  registerSafely("coreCommand", () => {
    ToolPkg.registerCoreCommand({
      id: COMMAND_ID,
      name: "doubao",
      title: { zh: "豆包语", en: "Doubao style" },
      description: {
        zh: "切换豆包语强度档位、调整各段条数、管理自定义词条、预览渲染结果、回滚配置。",
        en: "Switch the Doubao style level, tune section counts, manage custom entries, preview rendering, and roll back settings.",
      },
      usage: "/doubao [status|on|off|level|prompt|tail|set|custom|render|preview|lexicon|snapshots|revert|reset]",
      function: onDoubaoCommand,
    });
  });
  return true;
}

/** 连通性探针：证明主运行时确实执行了本包。 */
export function test_connection(): { passed: boolean; version: string } {
  return { passed: true, version: PLUGIN_VERSION };
}

/** 本包的可见入口是钩子与命令，没有业务工具（工具在 doubao_tools 子包里）。 */
export function test_tool_call(): { passed: boolean; message: string } {
  return { passed: false, message: "主入口注册提示词钩子、回复钩子与 /doubao 命令；工具在 doubao_tools 子包。" };
}

/** 供子包与测试复用：把注册结果与计数暴露出去。 */
export function _internals(): Record<string, unknown> {
  return { registrationState: { ...registrationState }, counters: { ...counters } };
}
