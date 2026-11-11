import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/**
 * 离线子包测试：用假的 ToolPkg / Tools 运行时加载 dist/tools/doubao_tools.js，
 * 验证四个模型可见工具、与主入口共用配置文件、以及跨文件 require 的解析。
 *
 * 不连真机、不导入 .toolpkg。运行：node test/tools.test.mjs
 */

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const distTools = path.resolve(here, "../dist/tools/doubao_tools.js");

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("PASS  " + name);
  } catch (error) {
    failures.push({ name, error });
    console.log("FAIL  " + name + "  —  " + (error?.message ?? String(error)));
  }
}

const CONFIG_DIR = "/fake/config/com.operit.doubao_style";
const files = new Map();
const dirs = new Set([CONFIG_DIR]);

globalThis.ToolPkg = {
  getConfigDir: () => CONFIG_DIR,
};

globalThis.Tools = {
  Files: {
    async exists(p) {
      return { path: p, exists: files.has(p) || dirs.has(p), isDirectory: dirs.has(p), size: 0, toString: () => p };
    },
    async read(p) {
      if (!files.has(p)) throw new Error("ENOENT " + p);
      const content = files.get(p);
      return { path: p, content, size: content.length, toString: () => p };
    },
    async write(p, content) {
      files.set(p, String(content));
      return { operation: { path: p, successful: true }, aiDiffInstructions: "", toString: () => p };
    },
    async mkdir(p) {
      dirs.add(p);
      return { path: p, successful: true, toString: () => p };
    },
    async list(p) {
      const prefix = p.replace(/\/+$/, "") + "/";
      const entries = [];
      for (const name of files.keys()) {
        if (name.startsWith(prefix) && !name.slice(prefix.length).includes("/")) {
          entries.push({ name: name.slice(prefix.length), isDirectory: false, size: files.get(name).length, permissions: "-rw-", lastModified: 0 });
        }
      }
      return { path: p, entries, toString: () => p };
    },
    async deleteFile(p) {
      files.delete(p);
      return { path: p, successful: true, toString: () => p };
    },
  },
};

const tools = require(distTools);

async function reset() {
  files.delete(CONFIG_DIR + "/doubao-profile.json");
  for (const key of Array.from(files.keys())) {
    if (key.startsWith(CONFIG_DIR + "/snapshots/")) files.delete(key);
  }
}

await check("子包导出四个工具", async () => {
  for (const name of ["doubao_status", "doubao_configure", "doubao_render", "doubao_lexicon"]) {
    assert.equal(typeof tools[name], "function", name + " 应该是函数");
  }
});

await check("doubao_status 读默认配置", async () => {
  await reset();
  const result = await tools.doubao_status();
  assert.equal(result.enabled, true);
  assert.equal(result.level, "medium");
  assert.equal(result.channels.prompt, true);
  assert.equal(result.channels.tail, true);
  assert.ok(result.lexicon.total > 300);
  assert.ok(result.paths.settings.endsWith("doubao-profile.json"));
});

await check("doubao_configure 只改传入字段", async () => {
  await reset();
  const before = await tools.doubao_status();
  const result = await tools.doubao_configure({ enabled: true, knobs: { negationCount: 12 } });
  assert.equal(result.applied, true);
  assert.equal(result.settings.knobs.negationCount, 12);
  assert.equal(result.settings.knobs.diagnoses, before.knobs.diagnoses, "未传入的字段应保持不变");
});

await check("doubao_configure 切档位套用预设", async () => {
  await reset();
  const result = await tools.doubao_configure({ level: "max" });
  assert.equal(result.settings.level, "max");
  assert.equal(result.settings.knobs.barrage, 20);
  assert.equal(result.settings.knobs.negationCount, 45);
});

await check("doubao_configure 空参数不改配置", async () => {
  await reset();
  const result = await tools.doubao_configure({});
  assert.equal(result.applied, false);
});

await check("doubao_configure 写盘并留快照", async () => {
  await reset();
  await tools.doubao_configure({ level: "light" });
  assert.ok(files.has(CONFIG_DIR + "/doubao-profile.json"));
  await tools.doubao_configure({ level: "heavy" });
  const snapshots = Array.from(files.keys()).filter((key) => key.startsWith(CONFIG_DIR + "/snapshots/"));
  assert.ok(snapshots.length >= 1, "第二次写入前应留下快照");
});

await check("doubao_render 膨胀文本且可复现", async () => {
  await reset();
  const input = "三次握手是为了同步初始序列号。";
  const first = await tools.doubao_render({ text: input, seed: 12345 });
  const second = await tools.doubao_render({ text: input, seed: 12345 });
  assert.equal(first.ok, true);
  assert.ok(first.charsOut > first.charsIn);
  assert.equal(first.text, second.text);
});

await check("doubao_render 空文本报错", async () => {
  const result = await tools.doubao_render({ text: "   " });
  assert.equal(result.ok, false);
});

await check("doubao_render 临时档位不写配置", async () => {
  await reset();
  await tools.doubao_render({ text: "随便一段话。", level: "max" });
  assert.equal(files.has(CONFIG_DIR + "/doubao-profile.json"), false, "临时档位不应写配置文件");
});

await check("doubao_lexicon 返回规模", async () => {
  const result = await tools.doubao_lexicon({});
  assert.equal(result.ok, true);
  assert.ok(result.sizes.intensifiers > 100);
  assert.ok(result.sizes.total > 300);
});

await check("doubao_lexicon 返回某类词条", async () => {
  const result = await tools.doubao_lexicon({ key: "intensifiers", limit: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.key, "intensifiers");
  assert.equal(result.returned, 5);
  assert.equal(result.entries.length, 5);
});

await check("doubao_lexicon 未知键报错", async () => {
  const result = await tools.doubao_lexicon({ key: "nope" });
  assert.equal(result.ok, false);
});

await check("子包与主入口共用同一份配置文件", async () => {
  await reset();
  await tools.doubao_configure({ knobs: { diagnoses: 3 } });
  const raw = JSON.parse(files.get(CONFIG_DIR + "/doubao-profile.json"));
  assert.equal(raw.config.diagnoses, 3);
  assert.equal(raw.schemaVersion, 1);
  const status = await tools.doubao_status();
  assert.equal(status.knobs.diagnoses, 3);
});

console.log("\n" + passed + " passed, " + failures.length + " failed");
if (failures.length > 0) {
  for (const failure of failures) console.error("\n" + failure.name + "\n" + (failure.error?.stack ?? String(failure.error)));
  process.exit(1);
}
