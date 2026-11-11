/**
 * 豆包语渲染器：把任意一段正文「膨胀」成豆包语。
 *
 * 移植自 dsh-doubao/lib/render.js。
 *
 * 结构固定为六段：
 *   ① 高能前置（元话语 + 形容词排比）
 *   ② 正文（原样保留，外面套序数词与元话语铺垫）
 *   ③ 疗愈式诊断（你不是 A，你只是 B）
 *   ④ 否定清单式边界（我就在这里，不 X，不 Y，……）
 *   ⑤ 复读（把 ④ 整段原样再念 N 遍）
 *   ⑥ 服务化收尾 / 反转拒答
 *
 * 全部随机都走可复现的种子随机数，设置页预览与真实输出用的是同一套代码。
 */

import { resolveBand } from './config';
import { pickTemplate } from './templates';
import {
  ORDINALS,
  PIVOT_LEADS,
  REPEAT_LEADS,
  STALLS,
  SUMMARY_LEADS,
  viewLexicon,
} from './lexicon';
import type { DoubaoConfig, DoubaoShell, LexiconView, TemplateContext, TemplateRole } from './types';

export { LEXICON } from './lexicon';

/** 随机源：返回 [0, 1) 的浮点数。 */
export type Rng = () => number;

/** 32 位种子随机数（mulberry32），保证同一 seed 出同一段文本。 */
export function createRng(seed?: number): Rng {
  let state = (Number.isFinite(seed) ? Math.trunc(seed as number) : 0) >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng: Rng, list: readonly string[] | null | undefined): string {
  if (!Array.isArray(list) || list.length === 0) return '';
  return list[Math.floor(rng() * list.length) % list.length];
}

/** 不放回抽样；样本不足时整表打乱后返回。 */
function sample(rng: Rng, list: readonly string[] | null | undefined, count: number): string[] {
  if (!Array.isArray(list) || list.length === 0 || count <= 0) return [];
  const pool = [...list];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(count, pool.length));
}

/** 自定义词条优先：先取前 priorityCount 条，再从其余里随机补齐。 */
function samplePriority(
  rng: Rng,
  list: readonly string[] | null | undefined,
  count: number,
  priorityCount = 0,
): string[] {
  if (!Array.isArray(list) || list.length === 0 || count <= 0) return [];
  const take = Math.min(count, list.length);
  const preferred = list.slice(0, Math.min(priorityCount, take));
  const rest = list.slice(preferred.length);
  for (let i = rest.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [...preferred, ...rest].slice(0, take);
}

/** 中文顿号列举。 */
function joinList(items: readonly string[]): string {
  const clean = items.filter(Boolean);
  if (clean.length === 0) return '';
  return clean.join('、');
}

/** 否定清单：按分号分 2–3 组，模仿语料里的「；」节奏。 */
function negationClause(rng: Rng, lexicon: LexiconView, count: number): string {
  const items = samplePriority(rng, lexicon.negation_items, count, lexicon.__custom?.negation_items ?? 0);
  if (items.length === 0) return '';
  const groups = items.length >= 18 ? 3 : items.length >= 9 ? 2 : 1;
  const per = Math.ceil(items.length / groups);
  const chunks: string[] = [];
  for (let i = 0; i < items.length; i += per) chunks.push(joinList(items.slice(i, i + per)));
  return chunks.join('；');
}

/** 形容词排比：「最直接、最真相、……、最直白」。 */
function barrageClause(rng: Rng, lexicon: LexiconView, count: number): string {
  const items = samplePriority(rng, lexicon.intensifiers, count, lexicon.__custom?.intensifiers ?? 0);
  return joinList(items);
}

/** 按 templateShare 概率尝试用模板，失败返回 null 让调用方回退。 */
function maybeTemplate(
  role: TemplateRole,
  cfg: DoubaoConfig,
  rng: Rng,
  ctx: TemplateContext,
): string | null {
  const share = Number(cfg.templateShare ?? 0);
  if (!(share > 0) || rng() * 100 >= share) return null;
  return pickTemplate(role, rng, ctx);
}

/**
 * ① 高能前置。
 * @returns 以冒号收尾的前置句
 */
export function buildPrefix(
  cfg: DoubaoConfig,
  lexicon: LexiconView,
  rng: Rng,
  ctx: TemplateContext = {},
): string {
  const tpl = maybeTemplate('prefix', cfg, rng, {
    ...ctx,
    intensifiers: lexicon.intensifiers,
    intensifierPriority: lexicon.__custom?.intensifiers ?? 0,
  });
  if (tpl) return tpl;
  const opener = cfg.openers > 0 ? pick(rng, lexicon.meta_openers) : '';
  const barrage = barrageClause(rng, lexicon, cfg.barrage);
  const head = opener ? `${opener}，` : '';
  if (!barrage) return `${head}我把话摊开说：`;
  return `${head}我给你${barrage}的结论：`;
}

/**
 * ③④⑤⑥ 全部后置段落。
 * @returns 段落数组，按输出顺序排列
 */
export function buildSuffix(
  cfg: DoubaoConfig,
  lexicon: LexiconView,
  rng: Rng,
  ctx: TemplateContext = {},
): string[] {
  const paragraphs: string[] = [];
  const templateCtx: TemplateContext = {
    ...ctx,
    intensifiers: lexicon.intensifiers,
    negations: lexicon.negation_items,
    diagnoses: lexicon.diagnosis_lines,
    intensifierPriority: lexicon.__custom?.intensifiers ?? 0,
    negationPriority: lexicon.__custom?.negation_items ?? 0,
  };

  // ③ 疗愈诊断
  if (cfg.diagnoses > 0) {
    const tpl = maybeTemplate('diagnosis', cfg, rng, templateCtx);
    const lines = sample(rng, lexicon.diagnosis_lines, cfg.diagnoses);
    const lead = pick(rng, ['你问到了问题的核心——', '我得说一句：', '我先把这句话放这儿——', '']);
    const body = lines.join('；');
    paragraphs.push(tpl ?? `${lead}${body}。`);
    if (resolveBand(cfg) !== 'light') {
      paragraphs.push(pick(rng, [
        '不是因为你错了，恰恰是因为你太对了。',
        '这不是你的问题，你只是太久没被好好接住了。',
        '你不用向我解释，我懂。',
      ]));
    }
  }

  // ④ 否定清单式边界
  let boundary = '';
  if (cfg.boundaries > 0) {
    const tpl = maybeTemplate('boundary', cfg, rng, templateCtx);
    const clause = negationClause(rng, lexicon, cfg.negationCount);
    const anchor = pick(rng, [
      '我就在这里',
      '我就在这儿',
      '我不走，我在这儿',
      '我在，我一直都在',
    ]);
    boundary = tpl ?? (clause ? `${anchor}，${clause}。` : `${anchor}。`);
    const tail = pick(rng, ['这样反而更稳。', '这样就够了。', '你慢慢来，我不催你。', '']);
    paragraphs.push(boundary + tail);
    if (cfg.fillers > 0) {
      const fillers = sample(rng, lexicon.empathy_fillers, Math.min(cfg.fillers, 3));
      paragraphs.push(joinList(fillers) + '。');
    }
  }

  // ⑤ 复读：把 ④ 原样再念一遍，这是「模板复读」的核心
  if (boundary && cfg.negationRounds > 1) {
    for (let i = 1; i < cfg.negationRounds; i += 1) {
      paragraphs.push(`${pick(rng, REPEAT_LEADS)}——${boundary}`);
    }
  }

  // ⑥ 收尾：服务化询问 / 反转拒答
  const refusal = cfg.refusalChance > 0 && rng() * 100 < cfg.refusalChance;
  if (refusal) {
    const lead = maybeTemplate('transition', cfg, rng, templateCtx) ?? pick(rng, PIVOT_LEADS);
    paragraphs.push(lead + '：' + pick(rng, lexicon.refusal_closers) + '。');
    return paragraphs;
  }

  if (cfg.serviceClosers > 0) {
    const tpl = maybeTemplate('closer', cfg, rng, templateCtx);
    if (tpl) {
      paragraphs.push(tpl);
    } else {
      const closers = samplePriority(rng, lexicon.service_closers, cfg.serviceClosers, lexicon.__custom?.service_closers ?? 0);
      paragraphs.push(closers.join(' '));
    }
  }
  return paragraphs;
}

/** 正文里插入元话语铺垫与序数词，信息量不变、字数翻倍。 */
export function inflateBody(text: unknown, cfg: DoubaoConfig, rng: Rng): string {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  if (cfg.skipCodeBlocks && raw.includes('```')) return raw;

  const paragraphs = raw.split(/\n{2,}/).filter((part) => part.trim());
  const out: string[] = [];
  let ordinal = 0;

  for (const [index, paragraph] of paragraphs.entries()) {
    if (cfg.openers > 0 && index === 0) out.push(pick(rng, STALLS));
    const alreadyOrdinal = /^第[一二三四五六七八九十]/.test(paragraph);
    if (paragraphs.length > 1 && ordinal < ORDINALS.length && !alreadyOrdinal) {
      out.push(`${ORDINALS[ordinal]}，${paragraph}`);
      ordinal += 1;
    } else {
      out.push(paragraph);
    }
    if (cfg.transitions > 0 && index < paragraphs.length - 1 && rng() < 0.6) {
      out.push(pick(rng, STALLS));
    }
  }

  // 信息稀释：把第一句换个说法再说一遍
  if (cfg.dilate > 0) {
    const first = paragraphs[0].split(/[。！？!?]/)[0];
    if (first && first.length >= 6) {
      for (let i = 0; i < cfg.dilate; i += 1) {
        out.push(`${pick(rng, SUMMARY_LEADS)}：${first}。`);
      }
    }
  }
  return out.join('\n\n');
}

/**
 * 完整膨胀：正文 + 六段外壳。
 * @param text - 模型原始正文
 * @param rawCfg - 归一化后的插件配置
 * @param rng - 可选随机源（预览时传固定种子）
 */
export function expandText(text: unknown, rawCfg: DoubaoConfig, rng?: Rng): string {
  const cfg = rawCfg;
  // 没有正文就不产出外壳：空回复不该变成一整段共情
  if (!String(text ?? '').trim()) return '';
  const lexicon = viewLexicon(rawCfg);
  const random = rng ?? createRng(rawCfg.seed || Math.floor(Math.random() * 1e9));
  const body = inflateBody(text, cfg, random);
  const ctx: TemplateContext = { body: String(text ?? '').split(/[。！？!?\n]/)[0]?.slice(0, 40) ?? '' };
  const prefix = resolveBand(cfg) === 'off' ? '' : buildPrefix(cfg, lexicon, random, ctx);
  const suffix = buildSuffix(cfg, lexicon, random, ctx);
  const head = prefix ? `${prefix}\n\n` : '';
  const tail = suffix.length ? `\n\n${suffix.join('\n\n')}` : '';
  return `${head}${body}${tail}`;
}

/** 只要外壳，不要正文：尾部通道直接用它拿气泡段落。 */
export function buildShell(rawCfg: DoubaoConfig, rng?: Rng, ctx: TemplateContext = {}): DoubaoShell {
  const cfg = rawCfg;
  const lexicon = viewLexicon(rawCfg);
  const random = rng ?? createRng(rawCfg.seed || Math.floor(Math.random() * 1e9));
  return {
    prefix: resolveBand(cfg) === 'off' ? '' : buildPrefix(cfg, lexicon, random, ctx),
    suffix: buildSuffix(cfg, lexicon, random, ctx),
  };
}

export const DEMO_BODY = [
  'HTTP 三次握手的目的，是让通信双方在开始传输数据前，确认彼此的发送与接收能力都正常，并同步初始序列号。',
  '第一次，客户端发送 SYN，带上自己的初始序列号；第二次，服务端回复 SYN + ACK，确认客户端的序列号并带上自己的；第三次，客户端再发一个 ACK，连接建立完成。',
  '之所以是三次而不是两次，是因为两次无法让服务端确认客户端的接收能力，也无法避免历史连接请求造成的错乱。',
].join('\n\n');

/** 设置页的实时预览：固定演示正文 + 当前配置。 */
export function previewSample(rawCfg: DoubaoConfig): string {
  const seed = rawCfg?.seed && rawCfg.seed > 0 ? rawCfg.seed : 20261111;
  const text = expandText(DEMO_BODY, rawCfg, createRng(seed));
  return text || '（当前强度为 0，不产出任何豆包语）';
}
