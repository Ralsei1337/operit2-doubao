/**
 * 豆包语核心层的共享类型。
 *
 * 这一层是纯数据与纯函数：不引用任何 ToolPkg / Tools 宿主 API，
 * 因此可以在 Node 里直接单测，也可以在 QuickJS 里原样运行。
 *
 * 分层约定：
 *   core/config.ts    配置归一化与档位表
 *   core/lexicon.ts   词库视图（内置 + 自定义）
 *   core/templates.ts 句式模板分析与渲染
 *   core/render.ts    六段外壳的拼装
 */

/** 强度档位。off 表示全关，其余四档各自对应一组具体参数。 */
export type DoubaoLevel = "off" | "light" | "medium" | "heavy" | "max";

/** 提示词口吻分带：由档位与参数共同决定，避免「档位拉满、参数为 0」的自相矛盾。 */
export type DoubaoBand = "off" | "light" | "medium" | "full";

/** 归一化之后的完整配置。所有数值都已 clamp 到合法区间。 */
export interface DoubaoConfig {
  /** 总开关。关闭时所有通道空转。 */
  enabled: boolean;
  /** 通道一：把风格规范注入系统提示词。 */
  promptEnabled: boolean;
  /** 通道二：在回复结束时追加外壳气泡。 */
  tailEnabled: boolean;
  /** 强度档位。 */
  level: DoubaoLevel;
  /** 形容词排比条数（「最A、最B、……的结论：」）。 */
  barrage: number;
  /** 否定清单条数。 */
  negationCount: number;
  /** 否定清单复读遍数（1 表示不复读）。 */
  negationRounds: number;
  /** 疗愈式诊断条数。 */
  diagnoses: number;
  /** 边界承诺段数。 */
  boundaries: number;
  /** 共情填充句条数。 */
  fillers: number;
  /** 信息稀释重复次数。 */
  dilate: number;
  /** 元话语开场数量。 */
  openers: number;
  /** 段落之间的过渡铺垫数量。 */
  transitions: number;
  /** 服务化收尾句数。 */
  serviceClosers: number;
  /** 反转拒答概率（百分比）。 */
  refusalChance: number;
  /** 模板路径占比（百分比）：命中则用句式模板，未命中走词库拼装。 */
  templateShare: number;
  /** 代码块与表格内不加料。 */
  skipCodeBlocks: boolean;
  /** 工具调用轮次不追加外壳。 */
  skipToolTurns: boolean;
  /** 自定义形容词，一行一条，排在内置词条之前。 */
  customIntensifiers: string;
  /** 自定义否定项，一行一条。 */
  customNegations: string;
  /** 自定义收尾句，一行一条。 */
  customClosers: string;
  /** 随机种子；0 表示每次随机。 */
  seed: number;
  /** 展示用百分数，不参与计算。 */
  intensity: number;
}

/** 词库视图：内置词条与自定义词条合并后的结果。 */
export interface LexiconView {
  intensifiers: string[];
  negation_items: string[];
  diagnosis_lines: string[];
  meta_openers: string[];
  meta_transitions: string[];
  boundary_commitments: string[];
  service_closers: string[];
  refusal_closers: string[];
  empathy_fillers: string[];
  sentence_templates: string[];
  /** 自定义词条条数，渲染时用于「优先取用」。 */
  __custom: {
    intensifiers?: number;
    negation_items?: number;
    service_closers?: number;
  };
}

/** 一条可渲染的句式模板。 */
export interface TemplateEntry {
  template: string;
  slots: string[];
}

/** 模板角色。 */
export type TemplateRole =
  | "opener"
  | "prefix"
  | "diagnosis"
  | "boundary"
  | "transition"
  | "closer"
  | "refusal"
  | "filler";

/** 模板渲染上下文。 */
export interface TemplateContext {
  body?: string;
  intensifiers?: string[];
  negations?: string[];
  diagnoses?: string[];
  texts?: string[];
  actions?: string[];
  intensifierPriority?: number;
  negationPriority?: number;
}

/** 外壳：前置句 + 后置段落。 */
export interface DoubaoShell {
  prefix: string;
  suffix: string[];
}
