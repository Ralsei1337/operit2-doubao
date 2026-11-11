#!/usr/bin/env node
/**
 * 把调研产物（lexicon.json / phrase-bank.json）生成成 TS 常量模块。
 *
 * 为什么要有这一步：插件产物跑在 Operit2 的 QuickJS 里，运行时没有 fs，
 * 也不能 `import ... with { type: 'json' }`。所以 JSON 必须在开发期折成
 * `src/data/*.data.ts` 里的 `const`，编译后随 dist 一起进包。
 *
 * 这是开发期脚本，允许用 node 内置模块；产物（src/data/*.data.ts）不引用任何内置模块。
 *
 * 用法：
 *   node scripts/gen-data.mjs                 # 默认读仓库内 vendor/（CI 与离线构建都走这条）
 *   node scripts/gen-data.mjs <源目录>         # 指定 dsh-doubao/lib 的路径
 *   DOUBAO_SOURCE_DIR=<源目录> node scripts/gen-data.mjs
 *
 * 源 JSON 已 vendor 到仓库根目录的 vendor/，CI 不再依赖本机的 dsh-doubao 检出。
 *
 * 来源：移植自 dsh-doubao/lib/lexicon.json 与 dsh-doubao/lib/phrase-bank.json。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, "src", "data");

const VENDORED_SOURCE = path.join(root, "vendor");
const LOCAL_SOURCE = "/root/DSHA开发/dsh-doubao/lib";

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const explicit = process.argv[2] ?? process.env.DOUBAO_SOURCE_DIR ?? "";
const sourceDir = explicit !== ""
  ? explicit
  : firstExisting([VENDORED_SOURCE, LOCAL_SOURCE]) ?? VENDORED_SOURCE;

function fail(message) {
  console.error("生成失败：" + message);
  process.exit(1);
}

if (!fs.existsSync(sourceDir)) fail("源目录不存在：" + sourceDir);

/** 读一个 JSON 词库文件，并校验形状：对象 → 字符串数组。 */
function readLexicon(fileName) {
  const full = path.join(sourceDir, fileName);
  if (!fs.existsSync(full)) fail("缺少源文件：" + full);

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (error) {
    fail(full + " 不是合法 JSON：" + error.message);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(full + " 的顶层必须是对象");
  }

  const out = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!Array.isArray(value)) fail(full + " 的 " + key + " 必须是数组");
    for (const item of value) {
      if (typeof item !== "string") fail(full + " 的 " + key + " 里有非字符串条目");
    }
    if (value.length === 0) fail(full + " 的 " + key + " 是空数组");
    out[key] = value;
  }
  const count = Object.keys(out).length;
  if (count === 0) fail(full + " 没有任何词条分组");
  return out;
}

/** 生成一个 `Record<string, string[]>` 常量模块的源码。 */
function emitModule({ constName, title, sourceName, data }) {
  const lines = [];
  lines.push("/**");
  lines.push(" * " + title);
  lines.push(" *");
  lines.push(" * 由 scripts/gen-data.mjs 从 dsh-doubao/lib/" + sourceName + " 生成，请勿手改。");
  lines.push(" * 改词条请改源 JSON，然后重跑 `npm run data`。");
  lines.push(" *");
  lines.push(" * 为什么是常量：Operit2 的 QuickJS 里没有 fs，JSON 必须在开发期折成 TS 常量。");
  lines.push(" */");
  lines.push("");
  lines.push("export const " + constName + ": Record<string, string[]> = {");

  for (const key of Object.keys(data)) {
    lines.push("  " + JSON.stringify(key) + ": [");
    for (const item of data[key]) lines.push("    " + JSON.stringify(item) + ",");
    lines.push("  ],");
  }
  lines.push("};");
  lines.push("");
  return lines.join("\n");
}

const lexicon = readLexicon("lexicon.json");
const phrases = readLexicon("phrase-bank.json");

fs.mkdirSync(outDir, { recursive: true });

const targets = [
  {
    file: "lexicon.data.ts",
    constName: "LEXICON_DATA",
    title: "调研词库原始数据（lexicon.json 的 TS 常量版）。",
    sourceName: "lexicon.json",
    data: lexicon,
  },
  {
    file: "phrase-bank.data.ts",
    constName: "PHRASE_BANK",
    title: "语料句式骨架（phrase-bank.json 的 TS 常量版）。",
    sourceName: "phrase-bank.json",
    data: phrases,
  },
];

for (const target of targets) {
  const full = path.join(outDir, target.file);
  fs.writeFileSync(full, emitModule(target), "utf8");
  const total = Object.values(target.data).reduce((sum, list) => sum + list.length, 0);
  console.log(
    "已生成 src/data/" + target.file + "  (" + Object.keys(target.data).length + " 组 / " + total + " 条)"
  );
}
