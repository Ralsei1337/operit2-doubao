import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * core 层离线单测：直接加载 tsc 产物（dist/core/*.js），不碰 ToolPkg 运行时。
 *
 * 覆盖：种子可复现、off 档空转、档位长度单调、否定清单条数、自定义词条优先、
 * 模板渲染无残留花括号、脏配置归一化、代码块跳过。
 *
 * 运行：node test/core.test.mjs（先 `./node_modules/.bin/tsc -p tsconfig.json`）
 */

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "../dist");

let config;
let lexicon;
let templates;
let render;
try {
  config = require(path.join(dist, "core/config.js"));
  lexicon = require(path.join(dist, "core/lexicon.js"));
  templates = require(path.join(dist, "core/templates.js"));
  render = require(path.join(dist, "core/render.js"));
} catch (error) {
  console.error("加载 dist 失败，请先运行 ./node_modules/.bin/tsc -p tsconfig.json");
  console.error(String(error?.message ?? error));
  process.exit(1);
}

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("PASS  " + name);
  } catch (error) {
    failures.push({ name, error });
    console.log("FAIL  " + name + "  — " + (error?.message ?? String(error)));
  }
}

const { normalizeConfig, presetFor, resolveBand, splitLines, LEVELS, LIMITS, DEFAULTS, CONFIG_VERSION } = config;
const { buildShell, createRng, expandText, inflateBody, previewSample, buildPrefix, buildSuffix, DEMO_BODY } = render;
const { viewLexicon, lexiconStats, LEXICON } = lexicon;
const { templateStats, pickTemplate, buildTemplates, analyze } = templates;

const BODY = "这段代码的作用是把请求转发到上游服务，它会在超时后重试一次。";
const ROLES = ["opener", "prefix", "diagnosis", "boundary", "transition", "closer", "refusal", "filler"];

/* ---------------- 1. 种子可复现 ---------------- */

check("同 seed 两次 expandText 完全一致", () => {
  const cfg = normalizeConfig({ level: "heavy", seed: 20261111 });
  const a = expandText(BODY, cfg, createRng(20261111));
  const b = expandText(BODY, cfg, createRng(20261111));
  assert.equal(a, b);
  assert.ok(a.length > BODY.length, "heavy 档应当比正文更长");
});

check("不同 seed 输出不同", () => {
  const cfg = normalizeConfig({ level: "heavy", seed: 1 });
  const a = expandText(BODY, cfg, createRng(1));
  const b = expandText(BODY, cfg, createRng(2));
  assert.notEqual(a, b);
});

check("createRng 是 mulberry32：seed=0 落到 0x9e3779b9 且序列稳定", () => {
  const a = createRng(0);
  const b = createRng(0);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  // seed 0 与 seed 0x9e3779b9 等价
  const c = createRng(0x9e3779b9);
  assert.deepEqual(seqA, [c(), c(), c()]);
  for (const value of seqA) assert.ok(value >= 0 && value < 1);
});

check("buildShell 与 expandText 同种子同随机流时外壳一致", () => {
  // light 档：openers/transitions/dilate 都是 0，inflateBody 不消耗随机数，
  // 于是 buildShell 与 expandText 走的是同一条随机流，外壳应当逐字相同。
  const cfg = normalizeConfig({ level: "light", seed: 9 });
  const shell = buildShell(cfg, createRng(9));
  const text = expandText(BODY, cfg, createRng(9));
  const expected = [shell.prefix, BODY, ...shell.suffix].filter(Boolean).join("\n\n");
  assert.equal(text, expected);
});

/* ---------------- 2. off 档空转 ---------------- */

check("level=off：prefix 为空、suffix 为空", () => {
  const cfg = normalizeConfig({ level: "off", seed: 3 });
  const shell = buildShell(cfg, createRng(3));
  assert.equal(shell.prefix, "");
  assert.deepEqual(shell.suffix, []);
});

check("level=off：expandText 单段正文原样返回", () => {
  const cfg = normalizeConfig({ level: "off" });
  assert.equal(expandText(BODY, cfg, createRng(1)), BODY);
  // 空正文不产出任何东西
  assert.equal(expandText("", cfg, createRng(1)), "");
  assert.equal(expandText("   \n ", cfg, createRng(1)), "");
});

check("level=off：残留参数被清零", () => {
  const cfg = normalizeConfig({ level: "off", barrage: 30, negationCount: 50, templateShare: 90, openers: 3 });
  assert.equal(cfg.barrage, 0);
  assert.equal(cfg.negationCount, 0);
  assert.equal(cfg.templateShare, 0);
  assert.equal(cfg.openers, 0);
  assert.equal(cfg.negationRounds, 1);
  assert.equal(resolveBand(cfg), "off");
});

/* ---------------- 3. 档位长度单调 ---------------- */

check("light < medium < heavy < max 输出长度单调递增", () => {
  const lengths = ["light", "medium", "heavy", "max"].map((level) => {
    // templateShare=0：固定走词库拼装，避免模板长短带来的抖动
    const cfg = normalizeConfig({ level, seed: 20261111, templateShare: 0 });
    return expandText(BODY, cfg, createRng(20261111)).length;
  });
  for (let i = 1; i < lengths.length; i += 1) {
    assert.ok(
      lengths[i] > lengths[i - 1],
      `档位长度应当递增，实际 ${JSON.stringify(lengths)}（第 ${i} 段没变长）`
    );
  }
});

/* ---------------- 4. 否定清单条数 ---------------- */

/** 用只开边界段的配置渲染，把否定清单单独拎出来数。 */
function boundaryParagraph(count, seed) {
  const cfg = normalizeConfig({
    level: "medium",
    seed,
    boundaries: 1,
    negationCount: count,
    diagnoses: 0,
    fillers: 0,
    serviceClosers: 0,
    negationRounds: 1,
    refusalChance: 0,
    templateShare: 0,
  });
  const suffix = buildSuffix(cfg, viewLexicon(cfg), createRng(seed));
  assert.equal(suffix.length, 1, "只开边界段时应当只有一段");
  return suffix[0];
}

check("negationCount=N 时否定清单项数 ≥ min(N, 词库长度)", () => {
  const total = LEXICON.negation_items.length;
  for (const requested of [4, 8, 17, 18, 45, 80, 999]) {
    const paragraph = boundaryParagraph(requested, 5);
    const items = paragraph.split(/[、；]/).filter((part) => part.trim());
    const expected = Math.min(normalizeConfig({ level: "medium", negationCount: requested }).negationCount, total);
    assert.ok(
      items.length >= expected,
      `negationCount=${requested} 期望 ≥ ${expected} 项，实际 ${items.length} 项`
    );
  }
});

check("否定清单上限被 LIMITS 收口（negationCount ≤ 80）", () => {
  const cfg = normalizeConfig({ level: "max", negationCount: 999 });
  assert.equal(cfg.negationCount, LIMITS.negationCount[1]);
  const paragraph = boundaryParagraph(999, 6);
  const items = paragraph.split(/[、；]/).filter((part) => part.trim());
  assert.ok(items.length >= Math.min(999, LEXICON.negation_items.length, LIMITS.negationCount[1]));
});

/* ---------------- 5. 自定义词条优先 ---------------- */

check("自定义词条优先：customIntensifiers 第一条出现在输出里", () => {
  const first = "最省钱";
  const cfg = normalizeConfig({
    level: "heavy",
    seed: 4,
    templateShare: 0,
    customIntensifiers: [first, "最稳当", "最省心"].join("\n"),
  });
  const text = expandText(BODY, cfg, createRng(4));
  assert.ok(text.includes(first), "自定义形容词的第一条必须被用上");
  // 内置词条仍然在后面兜底
  assert.ok(viewLexicon(cfg).intensifiers.length > LEXICON.intensifiers.length);
});

check("自定义词条优先：negation 与 closer 同样生效", () => {
  const cfg = normalizeConfig({
    level: "medium",
    seed: 8,
    templateShare: 0,
    customNegations: "不催你\n不逼你",
    customClosers: "要不要我再来一版？",
  });
  const view = viewLexicon(cfg);
  assert.equal(view.negation_items[0], "不催你");
  assert.equal(view.service_closers[0], "要不要我再来一版？");
  assert.deepEqual(view.__custom, { negation_items: 2, service_closers: 1 });
  const text = expandText(BODY, cfg, createRng(8));
  assert.ok(text.includes("不催你"));
  assert.ok(text.includes("要不要我再来一版？"));
});

check("自定义词条去重且并入内置词库", () => {
  const cfg = normalizeConfig({ customIntensifiers: "最直接\n最直接\n最省钱" });
  const view = viewLexicon(cfg);
  assert.equal(view.intensifiers.filter((item) => item === "最直接").length, 1);
  assert.equal(view.__custom.intensifiers, 2);
});

/* ---------------- 6. 模板渲染无残留花括号 ---------------- */

check("模板渲染 200 次不留残留花括号（全部 roles）", () => {
  for (const role of ROLES) {
    const rng = createRng(20261111);
    const ctx = {
      intensifiers: LEXICON.intensifiers,
      negations: LEXICON.negation_items,
      diagnoses: LEXICON.diagnosis_lines,
      intensifierPriority: 2,
      negationPriority: 2,
    };
    let rendered = 0;
    for (let i = 0; i < 200; i += 1) {
      const text = pickTemplate(role, rng, ctx);
      assert.ok(text !== null, `角色 ${role} 第 ${i} 次渲染返回 null`);
      assert.ok(!/[{}]/.test(text), `角色 ${role} 渲染出残留花括号：${text}`);
      rendered += 1;
    }
    assert.equal(rendered, 200);
  }
});

check("模板表统计与 DSH 版一致（51 条可用 / 7 条丢弃）", () => {
  const stats = templateStats();
  assert.equal(stats.total, 51);
  assert.equal(stats.dropped, 7);
  assert.equal(stats.prefix, 5);
  assert.equal(stats.boundary, 2);
  assert.equal(stats.refusal, 1);
  for (const role of ROLES) assert.ok(stats[role] > 0, `角色 ${role} 不应为空`);
});

check("未知槽位与括号不配对的模板被丢弃", () => {
  assert.equal(analyze("这里有{BOGUS}槽位"), null);
  assert.equal(analyze("少一个右括号{A"), null);
  assert.deepEqual(analyze("我给你最{X}的结论：").slots, ["X"]);
  const built = buildTemplates(["我给你最{X}的结论：", "{BOGUS}", "不配对的{A}"]);
  assert.equal(built.roles.prefix.length, 1);
  assert.equal(built.dropped.length, 2);
});

/* ---------------- 7. 脏配置归一化 ---------------- */

check("normalizeConfig 对脏数据给出合法结果", () => {
  for (const raw of [null, undefined, "字符串", 42, true, [], () => {}, { level: "不存在的档位" }]) {
    const cfg = normalizeConfig(raw);
    assert.equal(cfg.level, DEFAULTS.level);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.tailEnabled, true);
    for (const [key, bounds] of Object.entries(LIMITS)) {
      const value = cfg[key];
      assert.equal(typeof value, "number", `${key} 应当是数字`);
      assert.ok(value >= bounds[0] && value <= bounds[1], `${key}=${value} 越界`);
      assert.equal(value, Math.trunc(value), `${key} 应当是整数`);
    }
  }
});

check("normalizeConfig：越界数值被 clamp 到边界", () => {
  const cfg = normalizeConfig({ barrage: 999, negationCount: -5, seed: 1e13, dilate: 100 });
  assert.equal(cfg.barrage, LIMITS.barrage[1]);
  assert.equal(cfg.negationCount, LIMITS.negationCount[0]);
  assert.equal(cfg.seed, LIMITS.seed[1]);
  assert.equal(cfg.dilate, LIMITS.dilate[1]);
});

check("normalizeConfig：level=off 带残留参数一律清零", () => {
  const cfg = normalizeConfig({ level: "off", barrage: 30, negationCount: 50, dilate: 4, templateShare: 100 });
  for (const key of ["barrage", "negationCount", "dilate", "templateShare", "openers", "transitions", "diagnoses", "boundaries", "fillers", "serviceClosers", "refusalChance"]) {
    assert.equal(cfg[key], 0, `${key} 在 off 档应当为 0`);
  }
  // seed 不属于档位表，off 档仍然保留
  assert.equal(normalizeConfig({ level: "off", seed: 123 }).seed, 123);
});

check("normalizeConfig：旧 intensity 折算成档位", () => {
  const cases = [
    [0, "off"],
    [30, "light"],
    [50, "medium"],
    [70, "heavy"],
    [100, "max"],
    [-10, "off"],
    [500, "max"],
  ];
  for (const [intensity, level] of cases) {
    const cfg = normalizeConfig({ intensity });
    assert.equal(cfg.level, level, `intensity=${intensity} 应当折算成 ${level}`);
    assert.equal(cfg.intensity, config.LEVEL_PERCENT[level]);
  }
});

check("normalizeConfig：字符串/布尔类型回落", () => {
  const cfg = normalizeConfig({
    enabled: "yes",
    promptEnabled: 0,
    tailEnabled: null,
    skipCodeBlocks: "false",
    skipToolTurns: undefined,
    customIntensifiers: 123,
    customNegations: null,
    seed: "42",
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.promptEnabled, true);
  assert.equal(cfg.tailEnabled, true);
  assert.equal(cfg.skipCodeBlocks, true);
  assert.equal(cfg.skipToolTurns, true);
  assert.equal(cfg.customIntensifiers, "");
  assert.equal(cfg.customNegations, "");
  assert.equal(cfg.seed, 0);
});

check("normalizeConfig：显式参数优先于档位预设", () => {
  const cfg = normalizeConfig({ level: "light", barrage: 7, negationCount: 12 });
  assert.equal(cfg.barrage, 7);
  assert.equal(cfg.negationCount, 12);
  assert.equal(cfg.diagnoses, presetFor("light").diagnoses);
});

check("presetFor 未知档位回落到 medium", () => {
  assert.deepEqual(presetFor("不存在的档位"), presetFor("medium"));
  assert.deepEqual(presetFor("heavy"), { ...config.LEVEL_PRESETS.heavy });
});

check("resolveBand 分带判定", () => {
  assert.equal(resolveBand(null), "off");
  assert.equal(resolveBand({ level: "off", barrage: 20 }), "off");
  assert.equal(resolveBand({ level: "max", barrage: 0, negationCount: 0, serviceClosers: 0 }), "off");
  assert.equal(resolveBand({ level: "light", barrage: 3 }), "light");
  assert.equal(resolveBand({ level: "medium", barrage: 5 }), "medium");
  assert.equal(resolveBand({ level: "heavy", barrage: 12 }), "full");
});

check("splitLines 去重、去尾标点、丢空行", () => {
  assert.deepEqual(splitLines("a\nb\r\n a \n\nc，\n"), ["a", "b", "c"]);
  assert.deepEqual(splitLines("   "), []);
  assert.deepEqual(splitLines(null), []);
  assert.deepEqual(splitLines(42), []);
});

check("配置常量形状正确", () => {
  assert.deepEqual([...LEVELS], ["off", "light", "medium", "heavy", "max"]);
  assert.equal(CONFIG_VERSION, 1);
  assert.equal(DEFAULTS.enabled, true);
  assert.equal(DEFAULTS.promptEnabled, true);
  assert.equal(DEFAULTS.tailEnabled, true);
  assert.equal("streamGuardChars" in LIMITS, false, "Operit2 版没有流式缓冲，不该保留 streamGuardChars");
  assert.equal("mode" in DEFAULTS, false, "Operit2 版没有 mode");
});

/* ---------------- 8. 代码块跳过 ---------------- */

check("skipCodeBlocks=true 时含 ``` 的正文不被 inflateBody 改写", () => {
  const raw = "说明如下：\n\n```js\nconst a = 1;\n```\n\n结束。";
  const cfg = normalizeConfig({ level: "max", seed: 1, skipCodeBlocks: true });
  assert.equal(inflateBody(raw, cfg, createRng(1)), raw.trim());
});

check("skipCodeBlocks=false 时同样的正文会被改写", () => {
  const raw = "说明如下：\n\n```js\nconst a = 1;\n```\n\n结束。";
  const cfg = normalizeConfig({ level: "max", seed: 1, skipCodeBlocks: false });
  const out = inflateBody(raw, cfg, createRng(1));
  assert.notEqual(out, raw.trim());
  assert.ok(out.includes("```js"), "代码块内容本身仍应保留");
  assert.ok(out.includes("第一，"), "多段正文应当被序数词分层");
});

/* ---------------- 9. 词库与预览 ---------------- */

check("词库规模与 DSH 版一致（864 条 / 10 组）", () => {
  const stats = lexiconStats();
  assert.equal(stats.intensifiers, 132);
  assert.equal(stats.negation_items, 241);
  assert.equal(stats.diagnosis_lines, 94);
  assert.equal(stats.sentence_templates, 58);
  assert.equal(stats.total, 864);
  assert.equal(Object.keys(stats).length, 11, "10 组词条 + total");
});

check("previewSample 用固定种子且可复现", () => {
  const cfg = normalizeConfig({ level: "medium" });
  const a = previewSample(cfg);
  const b = previewSample(cfg);
  assert.equal(a, b);
  assert.ok(a.length > DEMO_BODY.length);
  // off 档：只留正文（DEMO_BODY 是多段，序数词分层不受档位控制，与 DSH 版一致）
  const offCfg = normalizeConfig({ level: "off" });
  assert.equal(previewSample(offCfg), inflateBody(DEMO_BODY, offCfg, createRng(20261111)));
});

check("buildPrefix 在无排比时仍以冒号收尾", () => {
  const cfg = normalizeConfig({ level: "light", barrage: 0, openers: 0, templateShare: 0 });
  const prefix = buildPrefix(cfg, viewLexicon(cfg), createRng(1));
  assert.equal(prefix, "我把话摊开说：");
});

/* ---------------- 汇总 ---------------- */

console.log("\n" + passed + "/" + (passed + failures.length) + " passed");
if (failures.length > 0) {
  for (const failure of failures) console.error("\n[" + failure.name + "]\n" + failure.error?.stack);
  process.exit(1);
}
