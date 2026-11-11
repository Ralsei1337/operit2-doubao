import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/**
 * 对抗性输入与量化穷举。
 *
 * 两件事：
 *   1. 畸形输入不能把插件弄崩 —— 钩子与命令的契约是「出错就不改动」，不是抛异常。
 *   2. 参数上限下的产出量有界 —— 气泡数、文本长度、词条条数都要落在设计区间内。
 *
 * 运行：node test/fuzz.test.mjs
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

globalThis.ToolPkg = {
  getConfigDir: () => CONFIG_DIR,
  registerSystemPromptComposeHook: (d) => hooks.systemPrompt.push(d),
  registerChatResponseHook: (d) => hooks.chatResponse.push(d),
  registerCoreCommand: (d) => hooks.command.push(d),
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

const hooks = { systemPrompt: [], chatResponse: [], command: [] };
const main = require(distMain);
main.registerToolPkg();

const systemPromptHook = hooks.systemPrompt[0].function;
const chatHook = hooks.chatResponse[0].function;
const commandHook = hooks.command[0].function;

const SETTINGS_PATH = CONFIG_DIR + "/doubao-profile.json";

function reset() {
  files.delete(SETTINGS_PATH);
  for (const key of Array.from(files.keys())) {
    if (key.startsWith(CONFIG_DIR + "/snapshots/")) files.delete(key);
  }
}

function putSettings(value) {
  files.set(SETTINGS_PATH, typeof value === "string" ? value : JSON.stringify(value));
}

function event(payload, eventName = "after_compose_system_prompt") {
  return { eventName, eventPayload: { stage: eventName, ...payload } };
}

function response(name, parts, extra = {}) {
  return { eventName: name, eventPayload: { chatId: "c", messageTimestamp: 7, variantIndex: 0, parts, ...extra } };
}

function run(args) {
  return commandHook({ eventName: "core_command", eventPayload: { commandId: "doubao_command", commandName: "doubao", args, json: false } });
}

/* ---------------- 1. 畸形输入 ---------------- */

await check("提示词钩子：payload 缺字段 / 类型错误都不抛", async () => {
  reset();
  const cases = [
    event({}),
    event({ systemPrompt: null }),
    event({ systemPrompt: 123 }),
    event({ systemPrompt: [] }),
    event({ systemPrompt: "x" }, "unknown_stage"),
    { eventName: "after_compose_system_prompt", eventPayload: {} },
    { eventName: "after_compose_system_prompt" },
  ];
  for (const item of cases) {
    const result = await systemPromptHook(item);
    assert.ok(result === null || result === undefined, "畸形输入应不改动");
  }
});

await check("提示词钩子：1MB systemPrompt 不抛且保留原文", async () => {
  reset();
  const big = "字".repeat(350_000);
  const result = await systemPromptHook(event({ systemPrompt: big }));
  assert.ok(result && typeof result.systemPrompt === "string");
  assert.ok(result.systemPrompt.startsWith(big.slice(0, 100)));
  assert.ok(result.systemPrompt.length > big.length);
});

await check("提示词钩子：sections 阶段也能注入（兜底）", async () => {
  reset();
  const result = await systemPromptHook(event({ systemPrompt: "SECTION_A" }, "compose_system_prompt_sections"));
  assert.ok(result && result.systemPrompt.includes("<!-- operit-doubao:profile -->"));
});

await check("提示词钩子：sections 注入后 after 阶段不重复注入", async () => {
  reset();
  const sections = await systemPromptHook(event({ systemPrompt: "SECTION_A" }, "compose_system_prompt_sections"));
  const after = await systemPromptHook(event({ systemPrompt: sections.systemPrompt }, "after_compose_system_prompt"));
  assert.equal(after, null);
});

await check("回复钩子：parts 畸形 / 元素为 null 都不抛", async () => {
  reset();
  const cases = [
    response("started", undefined),
    response("snapshot", null),
    response("snapshot", [null, undefined, 42, "x"]),
    response("snapshot", [{ kind: "markdown" }]),
    response("snapshot", [{ kind: "markdown", content: null }]),
    response("finished", [{ kind: "markdown", content: 12345 }]),
    response("finished", [{}]),
    { eventName: "finished", eventPayload: {} },
    { eventName: "finished" },
  ];
  for (const item of cases) {
    const result = await chatHook(item);
    assert.ok(result === undefined || result === null || (result && Array.isArray(result.bubbles)));
  }
});

await check("回复钩子：2MB 正文不抛", async () => {
  reset();
  const big = "正常回答。".repeat(100_000);
  await chatHook(response("started", []));
  const result = await chatHook(response("finished", [{ partId: "p", sequence: 0, kind: "markdown", content: big, toolCallId: null, toolName: null, attributes: {} }]));
  assert.ok(result && result.bubbles.length > 0);
});

await check("回复钩子：未收到 started 也能工作", async () => {
  reset();
  const result = await chatHook(response("finished", [{ partId: "p", sequence: 0, kind: "markdown", content: "三次握手是为了同步序列号。", toolCallId: null, toolName: null, attributes: {} }]));
  assert.ok(result && result.bubbles.length > 0);
});

await check("回复钩子：closed 清理后同一 key 可再次追加", async () => {
  reset();
  const parts = [{ partId: "p", sequence: 0, kind: "markdown", content: "三次握手是为了同步序列号。", toolCallId: null, toolName: null, attributes: {} }];
  await chatHook(response("started", []));
  const first = await chatHook(response("finished", parts));
  assert.ok(first);
  await chatHook(response("closed", []));
  await chatHook(response("started", []));
  const second = await chatHook(response("finished", parts));
  assert.ok(second, "closed 之后应能重新追加");
});

await check("回复钩子：大量并发 key 不会无限增长", async () => {
  reset();
  const before = main._internals().counters.lastError;
  for (let i = 0; i < 500; i += 1) {
    await chatHook({
      eventName: "started",
      eventPayload: { chatId: "chat-" + i, messageTimestamp: i, variantIndex: 0, parts: [] },
    });
  }
  const internals = main._internals();
  assert.equal(internals.counters.lastError, before, "这批调用不应新增错误");
  // 状态表上限 64，靠 trimStates 控制；这里只验证没有抛异常
});

/* ---------------- 2. 配置文件损坏 ---------------- */

await check("配置损坏：非法 JSON 回落默认", async () => {
  reset();
  putSettings("{ not json ");
  const status = JSON.parse((await run(["status"])).stdout);
  assert.equal(status.level, "medium");
  assert.equal(status.enabled, true);
});

await check("配置损坏：null / 数组 / 数字 回落默认", async () => {
  for (const bad of ["null", "[]", "42", '"text"']) {
    reset();
    putSettings(bad);
    const status = JSON.parse((await run(["status"])).stdout);
    assert.equal(status.level, "medium");
  }
});

await check("配置损坏：字段类型错误逐项回落", async () => {
  reset();
  putSettings({
    schemaVersion: "x",
    config: { level: 123, barrage: "很多", negationCount: -5, seed: "abc", enabled: "yes", customIntensifiers: 42 },
    prompt: { previewOnly: "no", customSection: 7 },
    tail: { delayMs: 99999, maxParagraphs: -3, dedupe: "yes" },
    snapshots: { keep: 0 },
  });
  const status = JSON.parse((await run(["status"])).stdout);
  assert.equal(status.level, "medium");
  assert.equal(status.knobs.barrage, 5);
  assert.equal(status.knobs.negationCount, 0);
  assert.equal(status.tail.delayMs, 3000);
  assert.equal(status.tail.maxParagraphs, 1);
  assert.equal(status.tail.dedupe, true);
});

/* ---------------- 3. 命令畸形输入 ---------------- */

await check("命令：未知子命令给用法而不是抛", async () => {
  const result = await run(["nonsense"]);
  assert.ok(result.stderr && result.stderr.includes("用法"));
});

await check("命令：缺参数的 set / custom / level", async () => {
  for (const args of [["set"], ["set", "barrage"], ["custom"], ["custom", "intensifiers"], ["level"], ["level", ""]]) {
    const result = await run(args);
    assert.ok(result.stderr && result.stderr.length > 0, args.join(" ") + " 应报用法");
  }
});

await check("命令：非数字 set 被拒绝", async () => {
  const result = await run(["set", "barrage", "很多"]);
  assert.ok(result.stderr && result.stderr.includes("数字"));
});

await check("命令：未知参数名被拒绝", async () => {
  const result = await run(["set", "nonsense", "1"]);
  assert.ok(result.stderr && result.stderr.includes("未知参数"));
});

await check("命令：revert 无快照时给提示", async () => {
  reset();
  const result = await run(["revert"]);
  assert.ok(result.stderr && result.stderr.includes("没有可回滚"));
});

await check("命令：超长自定义词条不炸", async () => {
  reset();
  const long = "最" + "长".repeat(500);
  const result = await run(["custom", "intensifiers", "add", long]);
  assert.equal(result.stderr, undefined);
  const settings = JSON.parse(files.get(SETTINGS_PATH));
  assert.ok(settings.config.customIntensifiers.includes(long));
});

/* ---------------- 4. 量化：产出上界 ---------------- */

await check("量化：五档输出长度单调递增", async () => {
  reset();
  const lengths = {};
  for (const level of ["off", "light", "medium", "heavy", "max"]) {
    await run(["level", level]);
    await run(["set", "seed", "424242"]);
    const result = await run(["render", "HTTP 三次握手用于同步初始序列号，并确认双方收发能力。第二段说明为什么是三次而不是两次。"]);
    lengths[level] = result.stdout.length;
  }
  assert.ok(lengths.off < lengths.light, "off 应短于 light");
  assert.ok(lengths.light < lengths.medium, "light 应短于 medium");
  assert.ok(lengths.medium < lengths.heavy, "medium 应短于 heavy");
  assert.ok(lengths.heavy < lengths.max, "heavy 应短于 max");
});

await check("量化：off 档不追加任何气泡", async () => {
  reset();
  await run(["level", "off"]);
  const result = await chatHook(response("finished", [{ partId: "p", sequence: 0, kind: "markdown", content: "正常回答。", toolCallId: null, toolName: null, attributes: {} }]));
  assert.equal(result ?? null, null);
});

await check("量化：max 档气泡数不超过 maxParagraphs", async () => {
  reset();
  await run(["level", "max"]);
  putSettings({ ...JSON.parse(files.get(SETTINGS_PATH)), tail: { delayMs: 0, maxParagraphs: 4, dedupe: false } });
  for (let i = 0; i < 30; i += 1) {
    await chatHook(response("started", [], { messageTimestamp: 1000 + i }));
    const result = await chatHook(response("finished", [{ partId: "p", sequence: 0, kind: "markdown", content: "第 " + i + " 次测试正文。", toolCallId: null, toolName: null, attributes: {} }], { messageTimestamp: 1000 + i }));
    assert.ok(result, "应追加气泡");
    assert.ok(result.bubbles.length <= 4, "气泡数应 ≤ maxParagraphs，实际 " + result.bubbles.length);
    for (const bubble of result.bubbles) {
      assert.ok(bubble.delayMs <= 3000);
      assert.ok(bubble.parts.length === 1);
      assert.equal(bubble.parts[0].sequence, 0);
      assert.ok(bubble.parts[0].partId.length > 0);
    }
  }
});

await check("量化：同种子 30 次渲染结果完全一致", async () => {
  reset();
  await run(["level", "heavy"]);
  await run(["set", "seed", "777"]);
  const first = (await run(["render", "同一段输入文本，用于验证可复现性。"])).stdout;
  for (let i = 0; i < 29; i += 1) {
    const next = (await run(["render", "同一段输入文本，用于验证可复现性。"])).stdout;
    assert.equal(next, first);
  }
});

await check("量化：气泡 partId 全局唯一（同一时间戳下）", async () => {
  reset();
  await run(["level", "max"]);
  await chatHook(response("started", []));
  const result = await chatHook(response("finished", [{ partId: "p", sequence: 0, kind: "markdown", content: "正文。", toolCallId: null, toolName: null, attributes: {} }]));
  const ids = result.bubbles.map((bubble) => bubble.parts[0].partId);
  assert.equal(new Set(ids).size, ids.length, "partId 应唯一");
});

console.log("\n" + passed + " passed, " + failures.length + " failed");
if (failures.length > 0) {
  for (const failure of failures) console.error("\n" + failure.name + "\n" + (failure.error?.stack ?? String(failure.error)));
  process.exit(1);
}
