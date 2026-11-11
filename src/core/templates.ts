/**
 * 句式模板引擎。
 *
 * 移植自 dsh-doubao/lib/templates.js。
 *
 * 调研来的 49 条模板里，占位符大小写不一、语义槽没有来源，直接套会吐出
 * 「{BODY}」「你不是{A}」这种残句。这里做三件事：
 *   1. 归一化槽位名（大小写、别名）
 *   2. 按槽位给模板定角色（开场/排比/诊断/边界/转场/收尾/填充/拒答）
 *   3. 渲染时缺槽就整条放弃，绝不留半个花括号
 */

import { LEXICON } from './lexicon';
import type { TemplateContext, TemplateEntry, TemplateRole } from './types';
import type { Rng } from './render';

/** 槽位别名 → 规范名。 */
const ALIASES = new Map<string, string>([
  ['body', 'body'],
  ['diagnosis', 'diagnosis'],
  ['action', 'action'],
  ['core', 'core'],
  ['deeper', 'deeper'],
  ['summary', 'summary'],
  ['not_x', 'not_x'],
  ['but_y', 'but_y'],
  ['plain', 'plain'],
  ['deep', 'deep'],
  ['root', 'root'],
  ['calm', 'calm'],
  ['conclusion', 'conclusion'],
  ['reason', 'reason'],
  ['how', 'how'],
  ['one_line', 'one_line'],
  ['claim', 'claim'],
  ['aside', 'aside'],
  ['observation', 'observation'],
  ['ugly_truth', 'ugly_truth'],
  ['nod', 'nod'],
  ['fact', 'fact'],
  ['pivot', 'pivot'],
]);

/** 单字母槽位：X/Y/Z 是形容词，A/B/C 是语义对。 */
const STEP_SLOTS = new Set(['step1', 'step2', 'step3', 'l1', 'l2', 'l3', 'p1', 'p2', 'p3']);

const SLOT_RE = /\{([^{}]*)\}/g;

function normalizeSlot(raw: string): string | null {
  const rawText = String(raw).trim();
  // 大小写是语义：{A} 是「表面判断」，{a} 是正文内容槽，不能合并
  if (['A', 'B', 'C'].includes(rawText)) return rawText;
  if (['a', 'b', 'c'].includes(rawText)) return rawText;
  const key = rawText.toLowerCase();
  if (key === 'x' || key === 'y' || key === 'z') return key.toUpperCase();
  if (STEP_SLOTS.has(key)) return key;
  return ALIASES.get(key) ?? null;
}

/** 抽出模板的槽位；出现未知槽位或括号不配对就判为不可用。 */
export function analyze(template: unknown): TemplateEntry | null {
  if (typeof template !== 'string' || !template.trim()) return null;
  if (template.split('{').length !== template.split('}').length) return null;
  const slots: string[] = [];
  SLOT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SLOT_RE.exec(template)) !== null) {
    const slot = normalizeSlot(match[1]);
    if (!slot) return null;
    slots.push(slot);
  }
  return { template, slots: [...new Set(slots)] };
}

/** 按槽位形状给模板定角色。 */
function roleOf(entry: TemplateEntry): TemplateRole {
  const set = new Set(entry.slots);
  const text = entry.template;
  const only = (...names: string[]): boolean => entry.slots.every((slot) => names.includes(slot));

  if (set.size === 0) {
    if (/抱歉|无法回答|换个方向/.test(text)) return 'refusal';
    if (/这样反而更稳|能意识到|你不是错了|第一，/.test(text)) return 'filler';
    return 'opener';
  }
  if (only('action')) return 'closer';
  if (only('X', 'Y', 'Z')) return 'prefix';
  if (only('diagnosis', 'core')) return 'diagnosis';
  if (only('deeper', 'deep', 'root', 'plain', 'summary', 'calm', 'aside', 'observation', 'ugly_truth', 'nod', 'fact', 'pivot')) {
    return 'transition';
  }
  if (only('step1', 'step2', 'step3', 'l1', 'l2', 'l3', 'p1', 'p2', 'p3')) return 'filler';
  if (only('a', 'b', 'c')) return 'filler';
  if (only('A', 'B', 'C')) {
    if (/不\{A\}|也不\{B\}/.test(text)) return 'boundary';
    return 'diagnosis';
  }
  if (only('A', 'B', 'C', 'not_x', 'but_y') && /不\{A\}/.test(text)) return 'boundary';
  if (only('A', 'B', 'C', 'not_x', 'but_y')) return 'diagnosis';
  return 'filler';
}

/** 语义对模板白名单：{A}/{B} 只能填成「不是A，是B」读得通的句式。 */
const PAIR_TEMPLATES = new Set<string>([
  '我就在这里，不{A}，不{B}，不{C}。',
  '我不{A}，也不{B}；我只{C}。',
  '不是{not_x}，而是{but_y}。',
  '你不是{A}，你只是{B}。',
  '你怕的不是{A}，是{B}。',
  '你缺的不是{A}，是{B}。',
  '你要的不是{A}，是{B}。',
  '表面上看是{A}，本质上是{B}。',
  '我知道你现在最想听的不是{A}，是{B}。',
  '我不评价{A}，我只说{B}。',
  '这不是{A}的问题，是{B}的问题。',
]);

/** 清洗后的模板表，按角色分组。 */
export function buildTemplates(raw: readonly string[] = LEXICON.sentence_templates): {
  roles: Record<TemplateRole, TemplateEntry[]>;
  dropped: string[];
} {
  const roles: Record<TemplateRole, TemplateEntry[]> = {
    opener: [], prefix: [], diagnosis: [], boundary: [], transition: [], closer: [], refusal: [], filler: [],
  };
  const dropped: string[] = [];
  for (const template of raw ?? []) {
    const entry = analyze(template);
    if (!entry) { dropped.push(template); continue; }
    const role = roleOf(entry);
    // 含 {A}/{B}/{C} 但不是白名单句式的，填进去就是病句，直接丢
    const usesPair = entry.slots.some((slot) => ['A', 'B', 'C', 'not_x', 'but_y'].includes(slot));
    if (usesPair && !PAIR_TEMPLATES.has(template)) { dropped.push(template); continue; }
    roles[role].push(entry);
  }
  return { roles, dropped };
}

const BUILT = buildTemplates();

/** 诊断用的成对语义槽：A 是表面判断，B 是「其实」。 */
const PAIRS: readonly (readonly [string, string])[] = [
  ['想太多', '想得太明白了'],
  ['矫情', '撑太久了'],
  ['脆弱', '太久没被好好对待了'],
  ['敏感', '太用力了'],
  ['不够好', '被放在了不对的位置'],
  ['不努力', '没被看见'],
  ['懒', '耗尽了'],
  ['冷漠', '学会了保护自己'],
  ['逃避', '需要喘口气'],
  ['要强', '没人可依靠'],
  ['放不下', '没被好好告别过'],
  ['不会爱', '没被好好爱过'],
  ['不合群', '没遇到对的人'],
  ['要求高', '不想再将就了'],
  ['情绪化', '憋太久了'],
  ['玻璃心', '被扎太多次了'],
];

const POSITIVES: readonly string[] = [
  '陪着你', '听你把话说完', '站在你这边', '把话说清楚',
  '陪你慢慢来', '接住你', '等你准备好', '替你留一盏灯',
];

const ACTIONS: readonly string[] = [
  '生成一张「接住你」的图片',
  '把这些整理成一份清单',
  '再给你一版更温柔的',
  '把它写成一段可以发出去的话',
  '把要点做成一张卡片',
  '帮你把这段话缩短到五十字',
  '把上面的内容拆成三步',
  '给你排个优先级',
  '把这段话润色一下',
];

const STEPS: readonly (readonly [string, string, string])[] = [
  ['先允许自己难受一会儿', '再把事情拆成能动手的小块', '最后才谈怎么解决'],
  ['先别急着解释', '先照顾好自己的情绪', '再决定要不要回应'],
  ['先睡一觉', '再找一个信得过的人说一遍', '最后再回来看这件事'],
];

const TEXTS: readonly string[] = [
  '你不是来要答案的，你是来要一个确认的',
  '你已经很努力了',
  '你只是太久没被认真听见了',
  '这件事不该由你一个人扛',
  '你现在这样就很好',
  '你可以慢一点',
];

/** 空表时返回空串（与旧版一致），供「缺槽就放弃」的判定使用。 */
function pick(rng: Rng, list: readonly string[] | null | undefined): string {
  if (!Array.isArray(list) || list.length === 0) return '';
  return list[Math.floor(rng() * list.length) % list.length];
}

/** 取一条（非字符串表用）；表是模块内常量且非空，兜底分支不会走到。 */
function pickItem<T>(rng: Rng, list: readonly T[]): T {
  return list[Math.floor(rng() * list.length) % list.length] ?? list[0];
}

/**
 * 把自定义词条排到最前，其余打乱。
 * 这样「优先」是真的优先，而不是提高一点概率。
 */
function orderWithPriority(rng: Rng, list: readonly string[] | null | undefined, priorityCount = 0): string[] {
  if (!Array.isArray(list) || list.length === 0) return [];
  const count = Math.max(0, Math.min(priorityCount, list.length));
  const head = list.slice(0, count);
  const rest = list.slice(count);
  for (let i = rest.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [...head, ...rest];
}

/** 把「不追问」拆成「追问」，供「不{A}」这类模板使用。 */
function bareNegation(item: unknown): string {
  return String(item).replace(/^不/, '').replace(/^别/, '');
}

function fillSlots(entry: TemplateEntry, rng: Rng, ctx: TemplateContext): Map<string, string> {
  const values = new Map<string, string>();
  const intensifiers = orderWithPriority(rng, ctx.intensifiers ?? [], ctx.intensifierPriority ?? 0);
  const negations = orderWithPriority(rng, ctx.negations ?? [], ctx.negationPriority ?? 0);
  let intensifierCursor = 0;
  let negationCursor = 0;
  const pair = pickItem(rng, PAIRS);
  const step = pickItem(rng, STEPS);
  const text = pick(rng, ctx.texts ?? TEXTS);
  const action = pick(rng, ctx.actions ?? ACTIONS);

  for (const slot of entry.slots) {
    if (values.has(slot)) continue;
    switch (slot) {
      case 'X': case 'Y': case 'Z': {
        // 顺序取词：自定义词条排在最前，一定会被用上
        const value = intensifiers[intensifierCursor] ?? pick(rng, intensifiers);
        intensifierCursor += 1;
        // 模板里写的是「最{X}」，词库本身也带「最」，去重一次
        const deduped = new RegExp(`最\\{${slot}\\}`).test(entry.template) ? value.replace(/^最/, '') : value;
        values.set(slot, deduped);
        break;
      }
      case 'A':
        values.set(slot, entry.template.includes('不{A}')
          ? bareNegation(negations[negationCursor++] ?? pick(rng, negations))
          : pair[0]);
        break;
      case 'B':
        values.set(slot, entry.template.includes('不{B}')
          ? bareNegation(negations[negationCursor++] ?? pick(rng, negations))
          : pair[1]);
        break;
      case 'C':
        // 「我只{C}」需要正向动作，不能填「不追问」
        values.set(slot, /我只\{C\}/.test(entry.template)
          ? pick(rng, POSITIVES)
          : bareNegation(negations[negationCursor++] ?? pick(rng, negations)));
        break;
      case 'not_x':
        values.set(slot, pair[0]);
        break;
      case 'but_y':
        values.set(slot, pair[1]);
        break;
      case 'diagnosis':
        values.set(slot, pick(rng, ctx.diagnoses ?? []) || text);
        break;
      case 'core':
        values.set(slot, pick(rng, ctx.diagnoses ?? []) || text);
        break;
      case 'action':
        values.set(slot, action);
        break;
      case 'step1': case 'l1': case 'p1':
        values.set(slot, step[0]);
        break;
      case 'step2': case 'l2': case 'p2':
        values.set(slot, step[1]);
        break;
      case 'step3': case 'l3': case 'p3':
        values.set(slot, step[2]);
        break;
      default:
        values.set(slot, ctx.body || text);
    }
  }
  return values;
}

/**
 * 渲染一条模板；缺槽或残留花括号就返回 null，让调用方回退。
 */
export function renderTemplate(
  entry: TemplateEntry | null | undefined,
  rng: Rng,
  ctx: TemplateContext = {},
): string | null {
  if (!entry) return null;
  const values = fillSlots(entry, rng, ctx);
  const out = entry.template.replace(SLOT_RE, (whole: string, raw: string) => {
    const slot = normalizeSlot(raw);
    const value = slot === null ? undefined : values.get(slot);
    return typeof value === 'string' && value ? value : whole;
  });
  if (/[{}]/.test(out)) return null;
  return out;
}

/**
 * 按角色抽一条模板并渲染。
 * @returns 渲染结果；该角色没有可用模板时返回 null
 */
export function pickTemplate(
  role: TemplateRole,
  rng: Rng,
  ctx: TemplateContext = {},
): string | null {
  const pool = BUILT.roles[role];
  if (!pool || pool.length === 0) return null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entry = pool[Math.floor(rng() * pool.length) % pool.length];
    const text = renderTemplate(entry, rng, ctx);
    if (text) return text;
  }
  return null;
}

export function templateStats(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [role, list] of Object.entries(BUILT.roles)) out[role] = list.length;
  out.dropped = BUILT.dropped.length;
  out.total = Object.values(BUILT.roles).reduce((sum, list) => sum + list.length, 0);
  return out;
}
