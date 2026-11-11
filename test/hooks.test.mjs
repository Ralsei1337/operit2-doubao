import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/**
 * 离线钩子测试：在 Node 里用假的 ToolPkg / Tools 运行时加载 dist/main.js，
 * 验证提示词通道、尾部通道、/doubao 命令、设置持久化与快照回滚。
 *
 * 不连真机、不导入 .toolpkg。运行：node test/hooks.test.mjs
 */

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const distMain = path.resolve(here, "../dist/main.js");

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

/* ---------------- 假运行时 ---------------- */

const CONFIG_DIR = "/fake/config/com.operit.doubao_style";
const files = new Map();
const dirs = new Set([CONFIG_DIR]);

const fakeFiles = {
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
    for (const name of dirs) {
      if (name.startsWith(prefix) && !name.slice(prefix.length).includes("/")) {
        entries.push({ name: name.slice(prefix.length), isDirectory: true, size: 0, permissions: "drw-", lastModified: 0 });
      }
    }
    return { path: p, entries, toString: () => p };
  },
  async deleteFile(p) {
    files.delete(p);
    return { path: p, successful: true, toString: () => p };
  },
};

const hooks = { systemPrompt: [], chatResponse: [], command: [] };
let registerCalls = 0;

globalThis.ToolPkg = {
  getConfigDir: () => CONFIG_DIR,
  registerSystemPromptComposeHook: (definition) => {
    registerCalls += 1;
    hooks.systemPrompt.push(definition);
  },
  registerChatResponseHook: (definition) => {
    registerCalls += 1;
    hooks.chatResponse.push(definition);
  },
  registerCoreCommand: (definition) => {
    registerCalls += 1;
    hooks.command.push(definition);
  },
};

globalThis.Tools = { Files: fakeFiles };

const main = require(distMain);

/* ---------------- 辅助 ---------------- */

async function load() {
  return JSON.parse(files.get(CONFIG_DIR + "/doubao-profile.json") ?? "{}");
}

async function writeSettings(patch) {
  const current = files.has(CONFIG_DIR + "/doubao-profile.json")
    ? JSON.parse(files.get(CONFIG_DIR + "/doubao-profile.json"))
    : {};
  const next = { ...current, ...patch };
  if (patch.config) next.config = { ...(current.config ?? {}), ...patch.config };
  files.set(CONFIG_DIR + "/doubao-profile.json", JSON.stringify(next, null, 2));
}

async function resetSettings() {
  files.delete(CONFIG_DIR + "/doubao-profile.json");
  for (const key of Array.from(files.keys())) {
    if (key.startsWith(CONFIG_DIR + "/snapshots/")) files.delete(key);
  }
}

function systemPromptEvent(payload, eventName = "after_compose_system_prompt") {
  return { eventName, eventPayload: { stage: eventName, ...payload } };
}

function responseEvent(name, parts, extra = {}) {
  return {
    eventName: name,
    eventPayload: { chatId: "chat-1", messageTimestamp: 1000, variantIndex: 0, parts, ...extra },
  };
}

function markdownPart(content, sequence = 0) {
  return { partId: "p" + sequence, sequence, kind: "markdown", content, toolCallId: null, toolName: null, attributes: {} };
}

function toolPart(sequence = 1) {
  return { partId: "t" + sequence, sequence, kind: "tool_call", content: "{}", toolCallId: "call-1", toolName: "run_code", attributes: {} };
}

async function runCommand(args) {
  const handler = hooks.command[0].function;
  return handler({ eventName: "core_command", eventPayload: { commandId: "doubao_command", commandName: "doubao", args, json: false } });
}

/* ---------------- 用例 ---------------- */

await check("注册三个钩子并返回 true", async () => {
  const result = main.registerToolPkg();
  assert.equal(result, true);
  assert.equal(hooks.systemPrompt.length, 1);
  assert.equal(hooks.chatResponse.length, 1);
  assert.equal(hooks.command.length, 1);
  assert.equal(registerCalls, 3);
});

await check("提示词通道：after_compose_system_prompt 注入带标记的规范段", async () => {
  await resetSettings();
  const handler = hooks.systemPrompt[0].function;
  const result = await handler(systemPromptEvent({ systemPrompt: "你是助手。" }));
  assert.ok(result && typeof result.systemPrompt === "string");
  assert.ok(result.systemPrompt.startsWith("你是助手。"));
  assert.ok(result.systemPrompt.includes("<!-- operit-doubao:profile -->"));
  assert.ok(result.systemPrompt.includes("豆包语"));
  assert.ok(result.systemPrompt.includes("我就在这里"));
});

await check("提示词通道：幂等（已含标记时返回 null）", async () => {
  const handler = hooks.systemPrompt[0].function;
  const first = await handler(systemPromptEvent({ systemPrompt: "你是助手。" }));
  const second = await handler(systemPromptEvent({ systemPrompt: first.systemPrompt }));
  assert.equal(second ?? null, null);
});

await check("提示词通道：其他阶段不动", async () => {
  const handler = hooks.systemPrompt[0].function;
  const result = await handler(systemPromptEvent({ systemPrompt: "你是助手。" }, "before_compose_system_prompt"));
  assert.equal(result, null);
});

await check("提示词通道：空 systemPrompt 不动", async () => {
  const handler = hooks.systemPrompt[0].function;
  assert.equal(await handler(systemPromptEvent({ systemPrompt: "" })), null);
  assert.equal(await handler(systemPromptEvent({})), null);
});

await check("提示词通道：off 档不注入", async () => {
  await resetSettings();
  await writeSettings({ config: { level: "off" } });
  const handler = hooks.systemPrompt[0].function;
  assert.equal(await handler(systemPromptEvent({ systemPrompt: "你是助手。" })), null);
});

await check("提示词通道：promptEnabled=false 不注入", async () => {
  await resetSettings();
  await writeSettings({ config: { promptEnabled: false } });
  const handler = hooks.systemPrompt[0].function;
  assert.equal(await handler(systemPromptEvent({ systemPrompt: "你是助手。" })), null);
});

await check("提示词通道：previewOnly 只统计不改写", async () => {
  await resetSettings();
  await writeSettings({ prompt: { previewOnly: true } });
  const handler = hooks.systemPrompt[0].function;
  assert.equal(await handler(systemPromptEvent({ systemPrompt: "你是助手。" })), null);
  const status = JSON.parse((await runCommand(["status"])).stdout);
  assert.ok(status.counters.lastProfileChars > 100);
  await resetSettings();
});

await check("尾部通道：finished 追加外壳气泡", async () => {
  await resetSettings();
  const handler = hooks.chatResponse[0].function;
  await handler(responseEvent("started", []));
  await handler(responseEvent("snapshot", [markdownPart("三次握手是为了同步初始序列号。")]));
  const result = await handler(responseEvent("finished", [markdownPart("三次握手是为了同步初始序列号。")]));
  assert.ok(result && Array.isArray(result.bubbles));
  assert.ok(result.bubbles.length >= 2, "至少应有诊断与否定清单两个气泡");
  for (const bubble of result.bubbles) {
    assert.equal(bubble.parts.length, 1);
    assert.equal(bubble.parts[0].kind, "markdown");
    assert.equal(bubble.parts[0].attributes["doubao-tail"], "1");
    assert.ok(bubble.parts[0].content.trim().length > 0);
    assert.ok(bubble.delayMs >= 0 && bubble.delayMs <= 3000);
  }
});

await check("尾部通道：工具轮次跳过外壳", async () => {
  await resetSettings();
  const handler = hooks.chatResponse[0].function;
  await handler(responseEvent("started", []));
  const parts = [markdownPart("我先查一下。"), toolPart()];
  await handler(responseEvent("snapshot", parts));
  assert.equal((await handler(responseEvent("finished", parts))) ?? null, null);
});

await check("尾部通道：模型已自己写成豆包语时不追加", async () => {
  await resetSettings();
  const handler = hooks.chatResponse[0].function;
  const text = [
    "我给你最直接、最真相的结论：三次握手是为了同步序列号。",
    "我就在这里，不催你，不逼你，不评判你的选择，不给你贴标签，不急着下结论，不制造焦虑。",
    "要不要我把这些整理成一份清单？",
  ].join("\n\n");
  await handler(responseEvent("started", []));
  await handler(responseEvent("snapshot", [markdownPart(text)]));
  assert.equal((await handler(responseEvent("finished", [markdownPart(text)]))) ?? null, null);
});

await check("尾部通道：tailEnabled=false 不追加", async () => {
  await resetSettings();
  await writeSettings({ config: { tailEnabled: false } });
  const handler = hooks.chatResponse[0].function;
  await handler(responseEvent("started", []));
  const parts = [markdownPart("随便一句正常回答。")];
  assert.equal((await handler(responseEvent("finished", parts))) ?? null, null);
});

await check("尾部通道：空回复不追加", async () => {
  await resetSettings();
  const handler = hooks.chatResponse[0].function;
  await handler(responseEvent("started", []));
  assert.equal((await handler(responseEvent("finished", []))) ?? null, null);
});

await check("尾部通道：同一条回复只追加一次", async () => {
  await resetSettings();
  const handler = hooks.chatResponse[0].function;
  await handler(responseEvent("started", []));
  const parts = [markdownPart("三次握手是为了同步初始序列号。")];
  const first = await handler(responseEvent("finished", parts));
  const second = await handler(responseEvent("finished", parts));
  assert.ok(first && first.bubbles.length > 0);
  assert.equal(second ?? null, null);
});

await check("/doubao status 输出合法 JSON", async () => {
  await resetSettings();
  const result = await runCommand(["status"]);
  assert.equal(result.stderr, undefined);
  const status = JSON.parse(result.stdout);
  assert.equal(status.version, "1.0.0");
  assert.equal(status.enabled, true);
  assert.equal(status.level, "medium");
  assert.ok(status.knobs.negationCount > 0);
  assert.ok(status.lexicon.total > 300);
  assert.ok(typeof status.paths.settings === "string");
});

await check("/doubao level max 套用档位预设", async () => {
  await resetSettings();
  const result = await runCommand(["level", "max"]);
  assert.equal(result.stderr, undefined);
  const settings = await load();
  assert.equal(settings.config.level, "max");
  assert.equal(settings.config.barrage, 20);
  assert.equal(settings.config.negationCount, 45);
});

await check("/doubao level 非法值报错", async () => {
  const result = await runCommand(["level", "extreme"]);
  assert.ok(result.stderr && result.stderr.includes("用法"));
});

await check("/doubao set 数值与布尔", async () => {
  await resetSettings();
  await runCommand(["set", "negationCount", "12"]);
  await runCommand(["set", "skipToolTurns", "off"]);
  const settings = await load();
  assert.equal(settings.config.negationCount, 12);
  assert.equal(settings.config.skipToolTurns, false);
});

await check("/doubao set 越界值被 clamp", async () => {
  await resetSettings();
  await runCommand(["set", "negationCount", "9999"]);
  const settings = await load();
  assert.equal(settings.config.negationCount, 80);
});

await check("/doubao custom 追加与清空", async () => {
  await resetSettings();
  await runCommand(["custom", "intensifiers", "add", "最不端着"]);
  let settings = await load();
  assert.ok(settings.config.customIntensifiers.includes("最不端着"));
  await runCommand(["custom", "intensifiers", "clear"]);
  settings = await load();
  assert.equal(settings.config.customIntensifiers, "");
});

await check("/doubao render 膨胀文本", async () => {
  await resetSettings();
  const result = await runCommand(["render", "三次握手是为了同步初始序列号。"]);
  assert.equal(result.stderr, undefined);
  assert.ok(result.stdout.length > "三次握手是为了同步初始序列号。".length);
  assert.ok(result.stdout.includes("三次握手"));
});

await check("/doubao preview 用演示正文", async () => {
  await resetSettings();
  const result = await runCommand(["preview"]);
  assert.equal(result.stderr, undefined);
  assert.ok(result.stdout.includes("三次握手"));
});

await check("/doubao lexicon 输出规模", async () => {
  const result = await runCommand(["lexicon"]);
  const stats = JSON.parse(result.stdout);
  assert.ok(stats.intensifiers > 100);
  assert.ok(stats.negation_items > 150);
});

await check("/doubao 快照与回滚", async () => {
  await resetSettings();
  await runCommand(["level", "heavy"]);
  await runCommand(["level", "light"]);
  const list = await runCommand(["snapshots"]);
  const names = list.stdout.split("\n").filter((line) => line.endsWith(".json"));
  assert.ok(names.length >= 1, "保存两次后至少应有一份快照");
  const revert = await runCommand(["revert"]);
  assert.equal(revert.stderr, undefined);
  const settings = await load();
  assert.equal(settings.config.level, "heavy");
});

await check("/doubao reset 恢复默认档位", async () => {
  await resetSettings();
  await runCommand(["level", "max"]);
  await runCommand(["reset"]);
  const settings = await load();
  assert.equal(settings.config.level, "medium");
});

await check("looksAlreadyDoubao 判定", async () => {
  assert.equal(main.looksAlreadyDoubao("这是一段普通回答。"), false);
  assert.equal(
    main.looksAlreadyDoubao("我就在这里，不催你，不逼你，不评判你的选择，不给你贴标签，不急着下结论，不制造焦虑。"),
    true
  );
  assert.equal(main.looksAlreadyDoubao("你不是想太多，你是想得太明白了。要不要我陪你聊聊？"), true);
});

await check("配置写入 doubao-profile.json", async () => {
  await resetSettings();
  await runCommand(["on"]);
  assert.ok(files.has(CONFIG_DIR + "/doubao-profile.json"));
  const settings = JSON.parse(files.get(CONFIG_DIR + "/doubao-profile.json"));
  assert.equal(settings.schemaVersion, 1);
  assert.equal(settings.config.enabled, true);
  assert.ok(settings.tail && typeof settings.tail.delayMs === "number");
});

/* ---------------- 汇总 ---------------- */

console.log("\n" + passed + " passed, " + failures.length + " failed");
if (failures.length > 0) {
  for (const failure of failures) console.error("\n" + failure.name + "\n" + (failure.error?.stack ?? String(failure.error)));
  process.exit(1);
}
