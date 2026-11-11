/* METADATA
{
  "name": "doubao_tools",
  "display_name": {
    "zh": "豆包语工具",
    "en": "Doubao Style Tools"
  },
  "description": {
    "zh": "豆包语的模型可见入口：查看当前档位与统计、调整参数、把任意文本渲染成豆包语、读取词库规模与自定义词条。这些工具与 /doubao 命令读写同一份配置文件。",
    "en": "Model-facing entry points for Doubao style: inspect the active level and counters, adjust parameters, render arbitrary text into Doubao style, and read lexicon sizes and custom entries. These tools share the same configuration file as the /doubao command."
  },
  "enabledByDefault": false,
  "category": "Utility",
  "tools": [
    {
      "name": "doubao_status",
      "display": { "label": { "zh": "查看豆包语设置", "en": "Doubao style status" }, "icon": "tune" },
      "description": {
        "zh": "读取当前档位、各段条数、两条通道开关、词库规模与配置路径。只读。",
        "en": "Reads the active level, section counts, both channel switches, lexicon sizes, and configuration paths. Read-only."
      },
      "parameters": []
    },
    {
      "name": "doubao_configure",
      "display": { "label": { "zh": "调整豆包语设置", "en": "Configure Doubao style" }, "icon": "settings" },
      "description": {
        "zh": "按需修改豆包语配置，只改传入的字段。修改前会自动为旧配置留一份快照。",
        "en": "Updates Doubao style settings; only supplied fields change. The previous settings are snapshotted before writing."
      },
      "parameters": [
        {
          "name": "enabled",
          "description": { "zh": "总开关。", "en": "Master switch." },
          "type": "boolean",
          "required": false
        },
        {
          "name": "level",
          "description": { "zh": "强度档位：off / light / medium / heavy / max。", "en": "Intensity level: off, light, medium, heavy, or max." },
          "type": "string",
          "required": false
        },
        {
          "name": "promptEnabled",
          "description": { "zh": "提示词通道：把风格规范注入系统提示词。", "en": "Prompt channel: inject the style specification into the system prompt." },
          "type": "boolean",
          "required": false
        },
        {
          "name": "tailEnabled",
          "description": { "zh": "尾部通道：回复结束时追加外壳气泡。", "en": "Tail channel: append shell bubbles when a response finishes." },
          "type": "boolean",
          "required": false
        },
        {
          "name": "knobs",
          "description": {
            "zh": "按需覆盖单项参数的对象，例如 {\"negationCount\":12,\"diagnoses\":2}。可用键：barrage、negationCount、negationRounds、diagnoses、boundaries、fillers、dilate、openers、transitions、serviceClosers、refusalChance、templateShare、seed。",
            "en": "Object overriding individual knobs, e.g. {\"negationCount\":12,\"diagnoses\":2}. Keys: barrage, negationCount, negationRounds, diagnoses, boundaries, fillers, dilate, openers, transitions, serviceClosers, refusalChance, templateShare, seed."
          },
          "type": "object",
          "required": false
        },
        {
          "name": "skipToolTurns",
          "description": { "zh": "工具调用轮次是否跳过外壳。", "en": "Whether tool-call turns skip the tail shell." },
          "type": "boolean",
          "required": false
        },
        {
          "name": "skipCodeBlocks",
          "description": { "zh": "含代码块的正文是否跳过信息稀释。", "en": "Whether bodies containing code blocks skip dilation." },
          "type": "boolean",
          "required": false
        }
      ]
    },
    {
      "name": "doubao_render",
      "display": { "label": { "zh": "渲染豆包语", "en": "Render Doubao style" }, "icon": "auto_awesome" },
      "description": {
        "zh": "把一段普通文本渲染成豆包语：高能前置、信息稀释、疗愈诊断、否定清单、复读、服务化收尾。同一种子可复现同一结果。",
        "en": "Renders plain text into Doubao style: energetic prefix, dilation, therapeutic diagnosis, negation inventory, repetition, and a service closing. The same seed reproduces the same output."
      },
      "parameters": [
        {
          "name": "text",
          "description": { "zh": "要渲染的原文。", "en": "Source text to render." },
          "type": "string",
          "required": true
        },
        {
          "name": "seed",
          "description": { "zh": "随机种子；不传则用配置里的种子，配置为 0 时随机。", "en": "Random seed; defaults to the configured seed, and to random when that is 0." },
          "type": "number",
          "required": false
        },
        {
          "name": "level",
          "description": { "zh": "临时用某个档位渲染，不写入配置。", "en": "Render with a temporary level without writing configuration." },
          "type": "string",
          "required": false
        }
      ]
    },
    {
      "name": "doubao_lexicon",
      "display": { "label": { "zh": "查看豆包语词库", "en": "Doubao lexicon" }, "icon": "menu_book" },
      "description": {
        "zh": "读取词库规模，或查看某一类词条（含自定义词条）。",
        "en": "Reads lexicon sizes, or lists the entries of one category including custom ones."
      },
      "parameters": [
        {
          "name": "key",
          "description": {
            "zh": "词条类别：intensifiers / negation_items / diagnosis_lines / meta_openers / meta_transitions / boundary_commitments / service_closers / refusal_closers / empathy_fillers / sentence_templates。省略则只返回规模。",
            "en": "Category: intensifiers, negation_items, diagnosis_lines, meta_openers, meta_transitions, boundary_commitments, service_closers, refusal_closers, empathy_fillers, or sentence_templates. Omit for sizes only."
          },
          "type": "string",
          "required": false
        },
        {
          "name": "limit",
          "description": { "zh": "最多返回多少条，默认 20，上限 200。", "en": "Maximum entries to return; default 20, max 200." },
          "type": "number",
          "required": false
        }
      ]
    }
  ]
}
*/

/**
 * 豆包语工具子包。
 *
 * 与主入口共用 `ToolPkg.getConfigDir()`（安装所有者维度），所以两边读写同一份
 * doubao-profile.json。设置解析逻辑在这里有一份精简副本：主入口与子包是两个
 * 独立运行时，复制比跨文件 require 更抗版本漂移（详见 docs/RUNTIME-FACTS.md）。
 *
 * 跨文件只 require 纯函数核心（config / render / lexicon），它们没有宿主依赖。
 */

import { normalizeConfig, presetFor, resolveBand } from "../core/config";
import type { DoubaoConfig, DoubaoLevel } from "../core/types";
import { expandText, createRng, previewSample } from "../core/render";
import { LEXICON, viewLexicon } from "../core/lexicon";

const SETTINGS_FILE = "doubao-profile.json";
const SNAPSHOT_DIR = "snapshots";
const DEFAULT_KEEP = 20;

interface Settings {
  schemaVersion: number;
  config: DoubaoConfig;
  prompt: { previewOnly: boolean; customSection: string };
  tail: { delayMs: number; maxParagraphs: number; dedupe: boolean };
  snapshots: { keep: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(num)));
}

function defaultSettings(): Settings {
  return {
    schemaVersion: 1,
    config: normalizeConfig({}),
    prompt: { previewOnly: false, customSection: "" },
    tail: { delayMs: 120, maxParagraphs: 6, dedupe: true },
    snapshots: { keep: DEFAULT_KEEP },
  };
}

function mergeSettings(base: Settings, patch: unknown): Settings {
  const out: Settings = JSON.parse(JSON.stringify(base)) as Settings;
  if (!isRecord(patch)) return out;
  if (isRecord(patch.config)) out.config = normalizeConfig({ ...out.config, ...patch.config });
  if (isRecord(patch.prompt)) {
    if (typeof patch.prompt.previewOnly === "boolean") out.prompt.previewOnly = patch.prompt.previewOnly;
    if (typeof patch.prompt.customSection === "string") out.prompt.customSection = patch.prompt.customSection;
  }
  if (isRecord(patch.tail)) {
    out.tail.delayMs = clampInt(patch.tail.delayMs, out.tail.delayMs, 0, 3000);
    out.tail.maxParagraphs = clampInt(patch.tail.maxParagraphs, out.tail.maxParagraphs, 1, 12);
    if (typeof patch.tail.dedupe === "boolean") out.tail.dedupe = patch.tail.dedupe;
  }
  if (isRecord(patch.snapshots)) {
    out.snapshots.keep = clampInt(patch.snapshots.keep, out.snapshots.keep, 1, 200);
  }
  return out;
}

function configDir(): string {
  return ToolPkg.getConfigDir();
}

function settingsPath(): string {
  return configDir() + "/" + SETTINGS_FILE;
}

function snapshotDir(): string {
  return configDir() + "/" + SNAPSHOT_DIR;
}

async function loadSettings(): Promise<Settings> {
  try {
    const exists = await Tools.Files.exists(settingsPath());
    if (!exists.exists) return defaultSettings();
    const file = await Tools.Files.read(settingsPath());
    return mergeSettings(defaultSettings(), JSON.parse(file.content));
  } catch {
    return defaultSettings();
  }
}

async function snapshotContent(content: string): Promise<void> {
  try {
    await Tools.Files.mkdir(snapshotDir(), true);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await Tools.Files.write(snapshotDir() + "/" + stamp + ".json", content, false);
  } catch {
    /* 快照失败不影响主流程 */
  }
}

async function saveSettings(next: Settings): Promise<Settings> {
  const merged = mergeSettings(defaultSettings(), next);
  try {
    const exists = await Tools.Files.exists(settingsPath());
    if (exists.exists) {
      const previous = await Tools.Files.read(settingsPath());
      await snapshotContent(previous.content);
    }
  } catch {
    /* 同上 */
  }
  await Tools.Files.mkdir(configDir(), true);
  await Tools.Files.write(settingsPath(), JSON.stringify(merged, null, 2), false);
  return merged;
}

/* ========================================================================
 * 工具实现
 * ===================================================================== */

/** 读取当前配置与统计。 */
async function doubao_status(): Promise<Record<string, unknown>> {
  const settings = await loadSettings();
  const cfg = settings.config;
  const sizes: Record<string, number> = {};
  let total = 0;
  for (const [key, list] of Object.entries(LEXICON)) {
    sizes[key] = list.length;
    total += list.length;
  }
  sizes.total = total;
  return {
    enabled: cfg.enabled,
    level: cfg.level,
    band: resolveBand(cfg),
    intensity: cfg.intensity,
    channels: { prompt: cfg.promptEnabled, tail: cfg.tailEnabled },
    knobs: {
      barrage: cfg.barrage,
      negationCount: cfg.negationCount,
      negationRounds: cfg.negationRounds,
      diagnoses: cfg.diagnoses,
      boundaries: cfg.boundaries,
      fillers: cfg.fillers,
      dilate: cfg.dilate,
      openers: cfg.openers,
      transitions: cfg.transitions,
      serviceClosers: cfg.serviceClosers,
      refusalChance: cfg.refusalChance,
      templateShare: cfg.templateShare,
      seed: cfg.seed,
    },
    render: { skipCodeBlocks: cfg.skipCodeBlocks, skipToolTurns: cfg.skipToolTurns },
    custom: {
      intensifiers: cfg.customIntensifiers.trim() === "" ? 0 : cfg.customIntensifiers.split(/\r?\n/).filter((line) => line.trim() !== "").length,
      negations: cfg.customNegations.trim() === "" ? 0 : cfg.customNegations.split(/\r?\n/).filter((line) => line.trim() !== "").length,
      closers: cfg.customClosers.trim() === "" ? 0 : cfg.customClosers.split(/\r?\n/).filter((line) => line.trim() !== "").length,
    },
    tail: settings.tail,
    prompt: { previewOnly: settings.prompt.previewOnly, customSectionChars: settings.prompt.customSection.length },
    lexicon: sizes,
    paths: { settings: settingsPath(), snapshots: snapshotDir() },
  };
}

/** 调整配置：只改传入的字段。 */
async function doubao_configure(params: {
  enabled?: boolean;
  level?: string;
  promptEnabled?: boolean;
  tailEnabled?: boolean;
  knobs?: Record<string, unknown>;
  skipToolTurns?: boolean;
  skipCodeBlocks?: boolean;
}): Promise<Record<string, unknown>> {
  const current = await loadSettings();
  const patch: Record<string, unknown> = {};

  if (typeof params.enabled === "boolean") patch.enabled = params.enabled;
  if (typeof params.promptEnabled === "boolean") patch.promptEnabled = params.promptEnabled;
  if (typeof params.tailEnabled === "boolean") patch.tailEnabled = params.tailEnabled;
  if (typeof params.skipToolTurns === "boolean") patch.skipToolTurns = params.skipToolTurns;
  if (typeof params.skipCodeBlocks === "boolean") patch.skipCodeBlocks = params.skipCodeBlocks;

  const requestedLevel = typeof params.level === "string" ? params.level.toLowerCase() : "";
  const level: DoubaoLevel | null = (["off", "light", "medium", "heavy", "max"] as DoubaoLevel[]).includes(requestedLevel as DoubaoLevel)
    ? (requestedLevel as DoubaoLevel)
    : null;
  if (level) {
    Object.assign(patch, presetFor(level), { level });
  }

  if (isRecord(params.knobs)) {
    for (const [key, value] of Object.entries(params.knobs)) {
      if (value === undefined || value === null) continue;
      patch[key] = value;
    }
  }

  if (Object.keys(patch).length === 0) {
    return { applied: false, reason: "no supported fields supplied", settings: current };
  }

  const next: Settings = { ...current, config: normalizeConfig({ ...current.config, ...patch }) };
  const saved = await saveSettings(next);
  return {
    applied: true,
    settings: {
      enabled: saved.config.enabled,
      level: saved.config.level,
      band: resolveBand(saved.config),
      channels: { prompt: saved.config.promptEnabled, tail: saved.config.tailEnabled },
      knobs: {
        barrage: saved.config.barrage,
        negationCount: saved.config.negationCount,
        negationRounds: saved.config.negationRounds,
        diagnoses: saved.config.diagnoses,
        boundaries: saved.config.boundaries,
        fillers: saved.config.fillers,
        dilate: saved.config.dilate,
        openers: saved.config.openers,
        transitions: saved.config.transitions,
        serviceClosers: saved.config.serviceClosers,
        refusalChance: saved.config.refusalChance,
        templateShare: saved.config.templateShare,
        seed: saved.config.seed,
      },
    },
  };
}

/** 把一段文本渲染成豆包语。 */
async function doubao_render(params: {
  text: string;
  seed?: number;
  level?: string;
}): Promise<Record<string, unknown>> {
  const source = typeof params.text === "string" ? params.text : "";
  if (source.trim() === "") return { ok: false, reason: "text is required" };

  const settings = await loadSettings();
  let cfg = settings.config;

  const requestedLevel = typeof params.level === "string" ? params.level.toLowerCase() : "";
  if ((["off", "light", "medium", "heavy", "max"] as DoubaoLevel[]).includes(requestedLevel as DoubaoLevel)) {
    cfg = normalizeConfig({ ...cfg, ...presetFor(requestedLevel as DoubaoLevel), level: requestedLevel });
  }

  const seed = Number.isFinite(Number(params.seed)) && Number(params.seed) > 0
    ? Math.trunc(Number(params.seed))
    : cfg.seed > 0 ? cfg.seed : 20261111;

  const text = expandText(source, cfg, createRng(seed));
  return {
    ok: true,
    level: cfg.level,
    band: resolveBand(cfg),
    seed,
    charsIn: source.length,
    charsOut: text.length,
    text,
  };
}

/** 读取词库规模或某一类词条。 */
async function doubao_lexicon(params: { key?: string; limit?: number }): Promise<Record<string, unknown>> {
  const settings = await loadSettings();
  const view = viewLexicon(settings.config);
  const limit = clampInt(params.limit, 20, 1, 200);

  const sizes: Record<string, number> = {};
  let total = 0;
  for (const [key, list] of Object.entries(LEXICON)) {
    sizes[key] = list.length;
    total += list.length;
  }
  sizes.total = total;

  const requested = typeof params.key === "string" ? params.key.trim() : "";
  if (requested === "") {
    return {
      ok: true,
      sizes,
      custom: {
        intensifiers: settings.config.customIntensifiers,
        negations: settings.config.customNegations,
        closers: settings.config.customClosers,
      },
    };
  }

  const list = (view as unknown as Record<string, string[]>)[requested];
  if (!Array.isArray(list)) {
    return { ok: false, reason: "unknown lexicon key: " + requested, sizes };
  }
  return {
    ok: true,
    key: requested,
    total: list.length,
    returned: Math.min(limit, list.length),
    entries: list.slice(0, limit),
  };
}

exports.doubao_status = doubao_status;
exports.doubao_configure = doubao_configure;
exports.doubao_render = doubao_render;
exports.doubao_lexicon = doubao_lexicon;
