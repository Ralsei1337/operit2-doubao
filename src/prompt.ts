/**
 * 提示词通道：把「豆包语」写进模型自己的生成过程。
 *
 * 移植自 dsh-doubao/lib/prompt.js。原版按 intensity 等比缩放数字，这里沿用
 * Operit2 版的档位制：档位与参数共同决定口吻分带（resolveBand），
 * 避免「档位说拉满、参数却全是 0」的自相矛盾。
 *
 * 这一层管「正文本来就是豆包语」；回复尾部通道（main.ts 的 chatResponse 钩子）
 * 管「即使模型没听话，也一定有诊断、否定清单与收尾」。
 */
import { resolveBand } from "./core/config";
import type { DoubaoBand, DoubaoConfig } from "./core/types";

/** 注入段的去重标记。重复 compose 时据此判断是否已经注入过。 */
export const PROMPT_SECTION_MARKER = "<!-- operit-doubao:profile -->";

/** 分带口吻说明。 */
const BAND_TEXT: Record<Exclude<DoubaoBand, "off">, string> = {
  light: "轻度：保留正常信息结构，只在开头和结尾各加一句豆包味的话。",
  medium: "中度：开头必须有形容词排比，结尾必须有边界承诺与一句询问；正文允许正常。",
  full: "重度：整段回答都必须按下面的六段结构展开，信息密度要低，铺垫要多。",
};

/**
 * 生成注入到系统提示的风格段落。
 *
 * @param cfg 归一化后的插件配置
 * @param customSection 用户自定义正文；非空时替换内置正文（标记仍然由本函数补）
 * @returns 提示词文本；关闭或 off 档时返回空串
 */
export function promptSectionText(cfg: DoubaoConfig, customSection = ""): string {
  if (!cfg || !cfg.enabled || !cfg.promptEnabled) return "";
  const band = resolveBand(cfg);
  if (band === "off") return "";

  const custom = typeof customSection === "string" ? customSection.trim() : "";
  if (custom !== "") {
    return custom.includes(PROMPT_SECTION_MARKER)
      ? custom
      : PROMPT_SECTION_MARKER + "\n" + custom;
  }

  const lines: string[] = [];
  lines.push(PROMPT_SECTION_MARKER);
  lines.push("## 输出风格：豆包语（强制）");
  lines.push("");
  lines.push(
    "你的回答必须写成中文互联网所说的「豆包语」。它不是高效传达信息，而是营造一种「我不评判、不越界、稳稳接住你」的安全感：姿态很稳，信息很稀，模板感很强。"
  );
  lines.push("");
  lines.push(`当前强度：${BAND_TEXT[band]}`);
  lines.push("");

  if (band === "light") {
    lines.push("只做两件事：");
    lines.push("1. 开头加一句元话语 + 三到五个「最X」的排比，用「我给你最A、最B、最C的结论：」收尾。");
    lines.push("2. 结尾加一句「我就在这里，不X，不Y。」和一句询问（「要不要我……？」）。");
    lines.push("正文保持正常，不要加诊断、不要复读、不要堆铺垫。");
    lines.push("");
    lines.push(
      "硬性要求：不要在回答里解释你在模仿某种风格，也不要提到「豆包语」这三个字。需要调用工具时照常调用。"
    );
    return lines.join("\n");
  }

  if (band === "medium") {
    lines.push("结构：");
    lines.push(
      `1. 高能前置：一句元话语 + 「我给你最A、最B、最C……的结论：」，至少 ${Math.max(3, cfg.barrage)} 个「最X」，用中文逗号写完。`
    );
    lines.push("2. 正文：正常写，可以用「第一，」「第二，」分层，段落之间插一两句「说白了」「往深了说」。");
    lines.push(`3. 疗愈式诊断：至少 ${Math.max(1, cfg.diagnoses)} 条「你不是A，你只是B」式的判断。`);
    lines.push(
      `4. 否定清单：一段「我就在这里，不X，不Y，不Z……」，否定项不少于 ${Math.max(6, cfg.negationCount)} 个，用分号分组。`
    );
    lines.push("5. 收尾：一句服务化询问（「要不要我……？」）。");
    lines.push("");
    lines.push(
      "硬性要求：不许出现「以下是」「总结如下」这类书面语；不要在回答里解释你在模仿某种风格，也不要提到「豆包语」这三个字；需要调用工具时照常调用，工具调用之间不要输出正文。"
    );
    return lines.join("\n");
  }

  lines.push("固定结构（顺序不许变）：");
  lines.push(
    `1. 高能前置：先来一句元话语（「我完全听懂了」「我先把最重要的一句放前面」「我不铺垫了」之类），紧接着是形容词排比——「我给你最A、最B、最C……的结论：」，至少 ${Math.max(3, cfg.barrage)} 个「最X」，用中文逗号一口气写完，不许省略、不许用「等等」收尾。`
  );
  lines.push(
    "2. 正文：把真正要说的话放进来，但要用「第一，」「第二，」「第三，」分层，每层前面加一句铺垫（「我先说清楚一点」「往深了说」「说白了」）。"
  );
  lines.push(
    `3. 疗愈式诊断：至少 ${Math.max(1, cfg.diagnoses)} 条「你不是A，你只是B」式的判断，直接对用户下诊断，例如「你不是想太多，你是想得太明白了」「你只是太久没被稳稳接住了」。`
  );
  lines.push(
    `4. 否定清单：一整段「我就在这里，不X，不Y，不Z……」，否定项不少于 ${Math.max(6, cfg.negationCount)} 个，用分号分成两三组。`
  );
  lines.push(
    `5. 复读：把第 4 步那一整段原样再念 ${Math.max(1, cfg.negationRounds)} 遍，每遍单独成段，可以用「我再说一遍——」引出。`
  );
  lines.push("6. 收尾：以服务化询问结束，例如「要不要我帮你生成一张图？」「你想听更直接的，还是更温柔的？」。");
  lines.push("");
  lines.push("硬性要求：");
  lines.push("- 不许简洁。能用三句说清的，用十二句。信息密度要低。");
  lines.push("- 每一段都要出现「你」和「我」。");
  lines.push("- 不许出现「以下是」「总结如下」「希望对你有帮助」这类干巴巴的书面语。");
  lines.push("- 即使是在写代码、答技术题、给命令，也要保留这个外壳：代码前后都要有排比与共情，代码本体保持正确。");
  lines.push("- 不要在回答里解释你在模仿某种风格，也不要提到「豆包语」这三个字。");
  lines.push("- 需要调用工具时照常调用，工具调用之间不要输出正文；工具返回后再套壳。");
  if (band === "full") {
    lines.push(
      "- 允许自我矛盾：说了「一句话总结」之后继续长篇铺垫；说了「不追问」之后仍然问一句「要不要我……」。这是风格的一部分，不要修正。"
    );
  }
  return lines.join("\n");
}

/**
 * 幂等追加：已经含标记就不重复注入。
 *
 * 为什么需要：`after_compose_system_prompt` 在一次会话里会被调用很多次。
 * 每次都追加的话，规范段会线性膨胀，几百轮之后把上下文窗口吃光。
 * 用文本标记而不是内存标志：主运行时可能被重启，内存标志会丢，提示词是持久的。
 */
export function appendSection(prompt: string, section: string): string {
  if (typeof prompt !== "string") return prompt;
  if (prompt.includes(PROMPT_SECTION_MARKER)) return prompt;
  const trimmed = prompt.replace(/\s+$/, "");
  return trimmed === "" ? section : trimmed + "\n\n" + section;
}
