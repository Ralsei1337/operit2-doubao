/**
 * 豆包语的配置层：默认值、边界、档位表与归一化。
 *
 * 移植自 dsh-doubao/lib/config.js。
 *
 * 与 DSH 版的差异（Operit2 的平台约束，不是取舍）：
 *   - 去掉 mode（smart / always / buffer）与 streamGuardChars：
 *     DSH 有 `llm/stream` 瀑布，可以缓冲一段再决定改不改；
 *     Operit2 的回复钩子是 append-only，没有「流式改写」这个中间态。
 *   - 去掉 transformEnabled / skipPurposes：正文不再被改写，也没有「请求用途」概念。
 *   - 新增 tailEnabled：通道二（回复结束时追加外壳气泡）的独立开关。
 *
 * 其余数值与判定一律照抄，保证同一个 seed 在两边产出同一段文本。
 */

import type { DoubaoBand, DoubaoConfig, DoubaoLevel } from './types';

/**
 * 总强度档位。每一档就是一组具体参数，不是一个连续旋钮。
 * 选档位 = 套一组数值；之后还可以单独微调，微调不会改档位。
 */
export const LEVELS = Object.freeze(['off', 'light', 'medium', 'heavy', 'max'] as const);

/** 档位预设：12 个数值旋钮。 */
export interface LevelPreset {
  barrage: number;
  negationCount: number;
  negationRounds: number;
  diagnoses: number;
  boundaries: number;
  fillers: number;
  dilate: number;
  openers: number;
  transitions: number;
  serviceClosers: number;
  refusalChance: number;
  templateShare: number;
}

export const LEVEL_PRESETS: Readonly<Record<DoubaoLevel, Readonly<LevelPreset>>> = Object.freeze({
  off: Object.freeze({
    barrage: 0, negationCount: 0, negationRounds: 1, diagnoses: 0, boundaries: 0,
    fillers: 0, dilate: 0, openers: 0, transitions: 0, serviceClosers: 0,
    refusalChance: 0, templateShare: 0,
  }),
  light: Object.freeze({
    barrage: 3, negationCount: 4, negationRounds: 1, diagnoses: 1, boundaries: 1,
    fillers: 1, dilate: 0, openers: 0, transitions: 0, serviceClosers: 1,
    refusalChance: 0, templateShare: 25,
  }),
  medium: Object.freeze({
    barrage: 5, negationCount: 8, negationRounds: 2, diagnoses: 1, boundaries: 1,
    fillers: 2, dilate: 1, openers: 1, transitions: 1, serviceClosers: 1,
    refusalChance: 3, templateShare: 40,
  }),
  heavy: Object.freeze({
    barrage: 10, negationCount: 18, negationRounds: 3, diagnoses: 2, boundaries: 2,
    fillers: 3, dilate: 2, openers: 2, transitions: 2, serviceClosers: 2,
    refusalChance: 8, templateShare: 60,
  }),
  max: Object.freeze({
    barrage: 20, negationCount: 45, negationRounds: 4, diagnoses: 3, boundaries: 3,
    fillers: 5, dilate: 3, openers: 3, transitions: 3, serviceClosers: 3,
    refusalChance: 15, templateShare: 100,
  }),
});

/** 档位 → 一个便于显示的百分数（只用于展示，不参与计算）。 */
export const LEVEL_PERCENT: Readonly<Record<DoubaoLevel, number>> = Object.freeze({
  off: 0, light: 25, medium: 50, heavy: 75, max: 100,
});

/** LIMITS 的键 = 全部数值旋钮。 */
export type NumericKey =
  | 'barrage'
  | 'negationCount'
  | 'negationRounds'
  | 'openers'
  | 'transitions'
  | 'diagnoses'
  | 'boundaries'
  | 'fillers'
  | 'serviceClosers'
  | 'refusalChance'
  | 'dilate'
  | 'templateShare'
  | 'seed';

/** 数值旋钮的合法区间，设置页直接用这张表生成滑块。 */
export const LIMITS: Readonly<Record<NumericKey, number[]>> = Object.freeze({
  barrage: [0, 40],
  negationCount: [0, 80],
  negationRounds: [1, 6],
  openers: [0, 3],
  transitions: [0, 3],
  diagnoses: [0, 4],
  boundaries: [0, 4],
  fillers: [0, 8],
  serviceClosers: [0, 3],
  refusalChance: [0, 100],
  dilate: [0, 4],
  templateShare: [0, 100],
  // 去掉 streamGuardChars（Operit2 没有流式缓冲），seed 与其余键保留
  seed: [0, 2147483647],
});

/** 数值键的遍历顺序与 LIMITS 的书写顺序一致。 */
const NUMERIC_KEYS: readonly NumericKey[] = [
  'barrage',
  'negationCount',
  'negationRounds',
  'openers',
  'transitions',
  'diagnoses',
  'boundaries',
  'fillers',
  'serviceClosers',
  'refusalChance',
  'dilate',
  'templateShare',
  'seed',
];

const BOOLEAN_KEYS = ['enabled', 'promptEnabled', 'tailEnabled', 'skipCodeBlocks', 'skipToolTurns'] as const;
type BooleanKey = (typeof BOOLEAN_KEYS)[number];

const STRING_KEYS = ['customIntensifiers', 'customNegations', 'customClosers'] as const;
type StringKey = (typeof STRING_KEYS)[number];

/** 全局默认值：通道一、通道二默认都开，档位取标准档。 */
export interface DoubaoDefaults {
  enabled: boolean;
  promptEnabled: boolean;
  tailEnabled: boolean;
  level: DoubaoLevel;
  barrage: number;
  negationCount: number;
  negationRounds: number;
  diagnoses: number;
  boundaries: number;
  fillers: number;
  dilate: number;
  openers: number;
  transitions: number;
  serviceClosers: number;
  refusalChance: number;
  templateShare: number;
  skipCodeBlocks: boolean;
  skipToolTurns: boolean;
  customIntensifiers: string;
  customNegations: string;
  customClosers: string;
  seed: number;
}

export const DEFAULTS: Readonly<DoubaoDefaults> = Object.freeze({
  enabled: true,
  // 通道一：往系统提示里注入风格规范
  promptEnabled: true,
  // 通道二：回复结束时追加六段外壳气泡
  tailEnabled: true,
  // 总强度档位：off / light / medium / heavy / max
  level: 'medium',
  // 各段长度默认值 = 标准档，改档位表就够了
  ...LEVEL_PRESETS.medium,
  // 代码块 / 表格里不加料，只在外层加壳
  skipCodeBlocks: true,
  // 工具调用轮次不套壳
  skipToolTurns: true,
  // 自定义词条，一行一条，会并入内置词库
  customIntensifiers: '',
  customNegations: '',
  customClosers: '',
  seed: 0,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLevel(value: unknown): value is DoubaoLevel {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value);
}

function clampInt(value: unknown, fallback: number, bounds: readonly number[]): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(bounds[1], Math.max(bounds[0], Math.trunc(value)));
}

function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * 把任意输入收敛成一份完整配置。
 * 档位决定各段的默认值；显式传入的数值优先于档位。
 * 旧配置里的 intensity 会被折算成最近的档位，不会失效。
 *
 * 注意：输出严格是 DoubaoConfig 的字段，未知键不再透传
 * （旧版用 `{ ...source }` 保留任意键，Operit2 版按类型收敛）。
 */
export function normalizeConfig(raw: unknown): DoubaoConfig {
  const source: Record<string, unknown> = isRecord(raw) ? raw : {};

  // 档位：显式 level 优先，其次按旧 intensity 折算，最后用默认档
  let level: DoubaoLevel | null = isLevel(source.level) ? source.level : null;
  if (!level && typeof source.intensity === 'number' && Number.isFinite(source.intensity)) {
    const value = Math.min(100, Math.max(0, source.intensity));
    level = value <= 0 ? 'off'
      : value < 38 ? 'light'
        : value < 63 ? 'medium'
          : value < 88 ? 'heavy' : 'max';
  }
  const resolved: DoubaoLevel = level ?? DEFAULTS.level;
  const preset: Readonly<LevelPreset> = LEVEL_PRESETS[resolved];

  // 档位表里没有 seed：它不属于档位，永远走全局默认与显式值
  const presetValue = (key: NumericKey): number | undefined => (key === 'seed' ? undefined : preset[key]);

  const numbers = {} as Record<NumericKey, number>;
  for (const key of NUMERIC_KEYS) {
    const bounds = LIMITS[key];
    // 档位 off 就是全关，不接受任何残留参数
    if (resolved === 'off' && presetValue(key) !== undefined) {
      numbers[key] = clampInt(0, 0, bounds);
      continue;
    }
    // 没显式写就用档位预设，档位也没给才用全局默认
    const fallback = presetValue(key) ?? DEFAULTS[key];
    numbers[key] = clampInt(source[key], fallback, bounds);
  }

  const booleans = {} as Record<BooleanKey, boolean>;
  for (const key of BOOLEAN_KEYS) booleans[key] = pickBool(source[key], DEFAULTS[key]);

  const strings = {} as Record<StringKey, string>;
  for (const key of STRING_KEYS) strings[key] = pickString(source[key], DEFAULTS[key]);

  return {
    enabled: booleans.enabled,
    promptEnabled: booleans.promptEnabled,
    tailEnabled: booleans.tailEnabled,
    level: resolved,
    barrage: numbers.barrage,
    negationCount: numbers.negationCount,
    negationRounds: numbers.negationRounds,
    diagnoses: numbers.diagnoses,
    boundaries: numbers.boundaries,
    fillers: numbers.fillers,
    dilate: numbers.dilate,
    openers: numbers.openers,
    transitions: numbers.transitions,
    serviceClosers: numbers.serviceClosers,
    refusalChance: numbers.refusalChance,
    templateShare: numbers.templateShare,
    skipCodeBlocks: booleans.skipCodeBlocks,
    skipToolTurns: booleans.skipToolTurns,
    customIntensifiers: strings.customIntensifiers,
    customNegations: strings.customNegations,
    customClosers: strings.customClosers,
    seed: numbers.seed,
    // 展示用的百分数，不再参与计算
    intensity: LEVEL_PERCENT[resolved] ?? 0,
  };
}

/**
 * 这一份配置实际落到哪个强度带（提示词按它选口吻）。
 * 档位是 off 就是 off；其余按排比条数判断，避免「档位说拉满、参数却是 0」的自相矛盾。
 */
export function resolveBand(cfg: Partial<DoubaoConfig> | null | undefined): DoubaoBand {
  if (!cfg || cfg.level === 'off') return 'off';
  const barrage = Number(cfg.barrage) || 0;
  const negation = Number(cfg.negationCount) || 0;
  const closer = Number(cfg.serviceClosers) || 0;
  if (barrage === 0 && negation === 0 && closer === 0) return 'off';
  if (barrage >= 12) return 'full';
  if (barrage >= 5) return 'medium';
  return 'light';
}

/** 某档位的参数快照，设置页点档位时直接套。 */
export function presetFor(level: string): LevelPreset {
  // 表按档位查；未知档位回落到标准档（与旧版一致）
  const table: Readonly<Record<string, Readonly<LevelPreset> | undefined>> = LEVEL_PRESETS;
  return { ...(table[level] ?? LEVEL_PRESETS.medium) };
}

/** 多行文本框 → 去重词条数组。 */
export function splitLines(text: unknown): string[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const item = line.trim().replace(/[，,、;；]+$/, '');
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

export const CONFIG_VERSION = 1;
