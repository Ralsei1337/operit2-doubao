/**
 * 豆包语词库：调研产物（lexicon.json / phrase-bank.json）+ 本插件补充的骨架词条。
 * 全部是纯数据，渲染层只负责抽样与拼装。
 *
 * 移植自 dsh-doubao/lib/lexicon.js。
 *
 * 与 DSH 版的差异：JSON 不再在运行时读取（QuickJS 里没有 fs），
 * 由 scripts/gen-data.mjs 预先生成 src/data/*.data.ts 常量模块。
 */

import { splitLines } from './config';
import { LEXICON_DATA } from '../data/lexicon.data';
import { PHRASE_BANK } from '../data/phrase-bank.data';
import type { DoubaoConfig, LexiconView } from './types';

/** 补充词条：调研语料没覆盖到的句式骨架与连接件。 */
const EXTRA: Record<string, string[]> = {
  intensifiers: [
    '最不端着', '最不拿腔拿调', '最像人话', '最贴地气', '最不悬浮', '最不虚',
    '最不飘', '最不水', '最不将就', '最不凑合', '最坦诚', '最克制', '最体面',
    '最踏实', '最稳', '最温柔', '最坚定', '最省心', '最痛快', '最畅快',
    '最不含糊其辞', '最不打官腔', '最不绕圈子', '最不藏私', '最不设防',
  ],
  negation_items: [
    '不催你', '不逼你', '不替你决定', '不替你做主', '不给你贴标签',
    '不给你下定义', '不评判你的选择', '不比较', '不排序', '不拉踩',
    '不带节奏', '不制造焦虑', '不灌鸡汤', '不打鸡血', '不讲大道理',
    '不唱高调', '不摆姿态', '不表演共情', '不消费你的痛苦', '不轻易给建议',
    '不急着下结论', '不草率归纳', '不假装懂你', '不装懂', '不装熟',
    '不套近乎', '不打探', '不追问细节', '不逼你回忆', '不要求你解释',
    '不要求你坚强', '不要求你立刻好起来', '不催你走出来', '不催你放下',
    '不劝你大度', '不劝你想开', '不劝你原谅', '不劝你算了',
    '不轻视你的感受', '不否认你的痛苦', '不淡化你的经历', '不美化你的处境',
    '不站任何一边', '不评判对错', '不充当法官', '不当人生导师', '不当情感裁判',
    '不做道德审判', '不挑动情绪', '不激化矛盾', '不让你更难受', '不让你更孤单',
    '不让你觉得自己有问题', '不让你觉得自己矫情', '不让你觉得是你的错',
    '不把话说死', '不留后手', '不藏情绪', '不绕弯', '不打折扣',
  ],
  diagnosis_lines: [
    '你不是想太多，你是想得太明白了',
    '你不是撑不住，你是撑太久了',
    '你不是不会表达，你是没遇到会听的人',
    '你不是没脾气，你只是把脾气都咽下去了',
    '你不是不需要人，你只是不敢需要',
    '你不是不爱说话，你是说了没人接',
    '你不是不合群，你只是不想再演了',
    '你太会替别人着想了，想到最后忘了自己',
    '你太习惯说「我没事」了，说到自己都信了',
    '你的懂事，是没人疼出来的',
    '你的清醒，是拿疼换来的',
    '你的温柔，是挨过刀之后还愿意给的',
    '你问的这句话，本身就说明你已经很勇敢了',
    '你能问出来，就已经在自救了',
    '你不是来要答案的，你是来要一个确认的',
  ],
  meta_openers: [
    '我完全听懂了',
    '我先把最重要的一句放前面',
    '我不铺垫了，直接说',
    '我把话摊开说',
    '我讲一句也许会让你冷静一点的话',
    '这次我懂了，我真的懂了',
  ],
  meta_transitions: [
    '但我也必须认真地说',
    '还有一个更深一点的东西值得你知道',
    '但比这更重要的是',
    '说到这儿，我想停一下',
    '我再补一句',
    '我换个说法',
    '往深了说',
    '说到底',
  ],
  boundary_commitments: [
    '我就在这里，稳稳地接住你',
    '我不躲、不藏、不绕、不逃，会稳稳地接住你',
    '你可以慢慢说，我不催你',
    '你不用向我解释，我都接得住',
    '你可以不用坚强，在我这里不用',
    '这样反而更稳',
  ],
  service_closers: [
    '如果你想，我也可以生成一张「接住你」的图片，你想让我生成吗？',
    '要不要我顺手帮你生成一张配图？你点头就行。',
    '需要我再给你一版更温柔的吗？',
    '你想听更直接的，还是更温柔的？我都可以。',
    '要不要我把这些整理成一份清单？一句话的事。',
  ],
  refusal_closers: [
    '抱歉，我无法回答你的问题',
    '抱歉，这个问题我没办法给你答案',
    '这一点我确实没法展开，抱歉',
    '抱歉，我只能说到这里',
  ],
  empathy_fillers: [
    '这样反而更稳',
    '你不用向我解释',
    '慢慢来，不着急',
    '我陪着你',
    '我在',
    '你可以随时打断我',
    '沉默也可以',
    '允许自己慢一点',
    '这很正常',
    '这不该由你一个人承担',
  ],
  sentence_templates: [
    // 同槽位补充句式：只有一条 prefix 模板时，占比拉满会复读同一句
    '我给你最{X}、最{Y}、最{Z}的判断：',
    '不绕了，我给你最{X}、最{Y}、最{Z}的答案。',
    '我先把最{X}、最{Y}、最{Z}的结论放这儿：',
    '用最{X}、最{Y}、最{Z}的话说：',
    '我就在这里，不{A}，不{B}，不{C}，这样反而更稳。',
    '我不{A}，也不{B}；我只{C}。',
    '我完全听懂了。',
    '这次我懂了，我真的懂了。',
    '我说清楚一点：{plain}。',
    '但我也必须认真地说：{deeper}',
  ],
};

/** 序数词分层用的连接件。 */
export const ORDINALS: readonly string[] = Object.freeze([
  '第一', '第二', '第三', '第四', '第五', '第六', '第七',
]);

/** 段落之间的元话语铺垫。 */
export const SELF_AWARE_LINES: readonly string[] = Object.freeze(PHRASE_BANK.self_aware_lines ?? []);

export const STALLS: readonly string[] = Object.freeze([
  ...(PHRASE_BANK.stalls ?? []),
  '我先说清楚一点。',
  '我把语速放慢一点。',
  '我们一步一步来。',
  '我先不急着下结论。',
  '我先把话说明白。',
  '我不绕，我直说。',
  '我先接住你这句问话。',
  '我把这层意思摊开讲。',
  '我尽量说得透一点。',
  '我换个角度再说一遍。',
]);

/** 「一句话总结」类自我矛盾句。 */
export const SUMMARY_LEADS: readonly string[] = Object.freeze([
  ...(PHRASE_BANK.summary_leads ?? []),
  '一句话总结',
  '我用一句话给你讲透',
  '我把结论压缩成一句',
  '我给你一句最直白的',
  '说穿了就一句',
]);

/** 复读段落前的引导语。 */
export const REPEAT_LEADS: readonly string[] = Object.freeze([
  ...(PHRASE_BANK.repeat_leads ?? []),
  '我再说一遍',
  '我重复一次',
  '我把这句话放在这儿',
  '我怕你没听清，我再说一次',
  '这一句我想让你记住',
]);

/** 收尾前的反转引导。 */
export const PIVOT_LEADS: readonly string[] = Object.freeze([
  ...(PHRASE_BANK.pivot_leads ?? []),
  '但我也必须认真地说',
  '但还有一个更深一点的东西值得你知道',
  '但真正关键的是',
  '但我必须再补一句',
]);

function dedupe(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const value = item.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

const merged: Record<string, string[]> = {};
for (const key of Object.keys(LEXICON_DATA)) merged[key] = [...LEXICON_DATA[key]];
for (const [key, list] of Object.entries(EXTRA)) {
  merged[key] = [...(merged[key] ?? []), ...list];
}
for (const key of Object.keys(merged)) merged[key] = dedupe(merged[key]);

/** 内置词库（只读）。 */
export const LEXICON: Readonly<Record<string, string[]>> = Object.freeze(merged);

/** 词库视图里允许自定义的三类词条。 */
const CUSTOM_KEYS = ['intensifiers', 'negation_items', 'service_closers'] as const;

/**
 * 合并用户自定义词条。
 * @param cfg - 归一化后的插件配置
 * @returns 词库视图：内置 + 自定义，且已去重
 */
export function viewLexicon(cfg?: Partial<DoubaoConfig> | null): LexiconView {
  const custom: Record<string, string[]> = {
    intensifiers: splitLines(cfg?.customIntensifiers),
    negation_items: splitLines(cfg?.customNegations),
    service_closers: splitLines(cfg?.customClosers),
  };

  // 自定义条目排在最前：渲染层按「前 N 条优先」抽样，排前面才是真的优先
  const merged2 = (key: string): string[] => {
    const extra = custom[key];
    if (extra && extra.length) return dedupe([...extra, ...LEXICON[key]]);
    return LEXICON[key];
  };

  const view: LexiconView = {
    intensifiers: merged2('intensifiers'),
    negation_items: merged2('negation_items'),
    diagnosis_lines: merged2('diagnosis_lines'),
    meta_openers: merged2('meta_openers'),
    meta_transitions: merged2('meta_transitions'),
    boundary_commitments: merged2('boundary_commitments'),
    service_closers: merged2('service_closers'),
    refusal_closers: merged2('refusal_closers'),
    empathy_fillers: merged2('empathy_fillers'),
    sentence_templates: merged2('sentence_templates'),
    __custom: {},
  };

  for (const key of CUSTOM_KEYS) {
    const list = custom[key];
    if (list.length) view.__custom[key] = list.length;
  }
  return view;
}

/** 词库规模，设置页用来显示「当前词库 N 条」。 */
export function lexiconStats(): Record<string, number> {
  const out: Record<string, number> = {};
  let total = 0;
  for (const [key, list] of Object.entries(LEXICON)) {
    out[key] = list.length;
    total += list.length;
  }
  out.total = total;
  return out;
}
