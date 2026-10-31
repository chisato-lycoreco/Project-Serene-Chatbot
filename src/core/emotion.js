/**
 * core/emotion.js — 情感状态层（纯函数内核）
 *
 * PAD+ 六维 × 三层（底色 / 此刻 / 关系）。无 I/O、无随机、无网络：
 * 相同初始状态 + 相同事件 + 相同时间 → 相同结果（MATE）。
 *
 * 模型包含：
 *   - 衰减：每层每维各有半衰期，底色慢、此刻快、关系居中；
 *   - 昼夜节律：几点钟轻微影响各维，睡眠另算；
 *   - 事件增量 + 享乐适应（saturation）：越高越吃不满；
 *   - 疤（wound）：不可逆的基线位移，唯一不回落的东西；
 *   - 情绪改判：同一句模糊的话，底色低时读冷、亮时读暖；
 *   - 自然语言描述：进 prompt 的那一小段，不暴露数值。
 *
 * 存储与时钟都在外面：见 src/stores/emotion-store.js。
 */

import { resolveLexicon } from "./lexicon.js";

export { addressMatcher } from "./lexicon.js";

const HOUR = 3_600_000;
const clamp = (value) => Math.max(0, Math.min(100, Number(value) || 0));
const round = (value) => Math.round(value * 10) / 10;
const round2 = (value) => Math.round(value * 100) / 100;

/**
 * 情绪耦合总开关。关掉后回到「情绪只描述、不改判」的行为：
 * 分类力度不受状态影响，也不会把中性话读成冷/暖。
 */
let coupling = true;
export function setCoupling(enabled) {
  coupling = Boolean(enabled);
}

const BEIJING = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** 北京时间当天的第几分钟。纯函数，只依赖时间戳。 */
export function beijingMinuteOfDay(ts) {
  const parts = Object.fromEntries(BEIJING.formatToParts(new Date(ts)).map((part) => [part.type, part.value]));
  return (Number(parts.hour) % 24) * 60 + Number(parts.minute);
}

/* ─────────────────────── 维度与基线 ─────────────────────── */

/** 六个维度。顺序固定：快照、测试、UI 都按这个顺序。 */
export const DIMENSIONS = [
  { key: "pleasure", label: "愉悦" },
  { key: "arousal", label: "唤醒" },
  { key: "dominance", label: "支配" },
  { key: "curiosity", label: "好奇" },
  { key: "confidence", label: "自信" },
  { key: "connection", label: "连接" },
];

export const KEYS = DIMENSIONS.map((dimension) => dimension.key);

/**
 * 三层各自的基线。默认值是一个成熟、安稳的人：
 * 底色偏亮、唤醒不高、连接感稳定；初级层平时也跟着底色走。
 */
export const BASELINE = Object.freeze({
  background: Object.freeze({ pleasure: 64, arousal: 44, dominance: 60, curiosity: 58, confidence: 62, connection: 60 }),
  primary: Object.freeze({ pleasure: 64, arousal: 44, dominance: 60, curiosity: 58, confidence: 62, connection: 60 }),
  social: Object.freeze({ pleasure: 64, arousal: 42, dominance: 58, curiosity: 56, confidence: 60, connection: 64 }),
});

/** 每层每个维度回到目标值一半所需的时间（小时）。 */
export const HALF_LIFE_HOURS = {
  // 愉悦单独短半衰期：被亲一下的好心情不该在底色里留三天。
  background: { pleasure: 20, arousal: 48, dominance: 96, curiosity: 60, confidence: 36, connection: 36 },
  primary: { pleasure: 0.7, arousal: 0.4, dominance: 0.7, curiosity: 0.4, confidence: 1.0, connection: 0.6 },
  social: { pleasure: 3.5, arousal: 4, dominance: 6, curiosity: 6, confidence: 6, connection: 6 },
};

export const LAYERS = ["background", "primary", "social"];

/* ─────────────────────── 不可逆：疤 ─────────────────────── */

/**
 * 这套模型里所有的东西都会回落：初级层半小时、社会层几小时、底色几十小时，
 * 连被冷落的连接感也会慢慢回到基线。这一节是唯一的例外。
 *
 * 疤不是情绪，是**底数的位移**：她不会因为一道疤当场低落，
 * 但以后再遇到同类的事，她的起点已经不在原来的地方了。
 * 所以它不进 EVENT_EFFECTS，也不衰减——它改的是基线本身。
 *
 * 门槛刻意设得高：一句重话只算重话，要到「深到一定程度」或者
 * 「说到了回不去的份上」（分手、滚、再也别）才留疤。
 * 反复被踩同一处会先被 sensitivity 放大，疼到越线，自然留下第二道。
 * 疤只增不减，但总位移有天花板——她是被磨旧了，不是被磨没了。
 */
export const WOUNDS_FILE = "scars.json";

/** 深度 1/2/3 各自把基线往哪边挪多少。负数是「更低」，正数是「更硬」。 */
export const WOUND_OFFSETS = Object.freeze({
  1: Object.freeze({ pleasure: -0.9, connection: -1.3, confidence: -0.5, dominance: 0.3 }),
  2: Object.freeze({ pleasure: -1.6, connection: -2.2, confidence: -0.8, dominance: 0.5 }),
  3: Object.freeze({ pleasure: -2.4, connection: -3.2, confidence: -1.2, dominance: 0.7 }),
});

/** 疤可以一直添，位移不能一直加。 */
export const WOUND_CEILING = Object.freeze({
  pleasure: Object.freeze({ min: -12, max: 0 }),
  connection: Object.freeze({ min: -14, max: 0 }),
  confidence: Object.freeze({ min: -8, max: 0 }),
  dominance: Object.freeze({ min: 0, max: 6 }),
});

/** 说完就回不去的那几句。命中就算数，不看对方后面有没有哄。 */
const IRREVERSIBLE = /(分手|滚吧|滚开|给我滚|别再|再也不|最后一次|结束了|离我远点|后悔认识|不想再见到|不认识你)/;

/**
 * 这一下该不该留疤，留多深。0 = 不留。
 *
 * 只是重（没说死话）：24 点一道，30 点两道。
 * 说死了（分手/滚/再也别）：8 点就够一道，15 点两道，24 点三道。
 * 门槛按「冲突本身 −18」校准过：一句「分手」稳在两道，
 * 一句「你根本不喜欢我」不越线，反复说才会被敏感度推过去。
 */
export function woundDepth(primaryDelta = 0, context = "") {
  const size = Math.abs(Number(primaryDelta) || 0);
  const said = IRREVERSIBLE.test(String(context ?? ""));
  let depth = 0;
  if (size >= 24) depth = 1;
  if (size >= 30) depth = 2;
  if (said && size >= 8) depth = Math.max(depth, 1);
  if (said && size >= 15) depth = Math.max(depth, 2);
  if (said && size >= 24) depth = 3;
  return depth;
}

/** 基线 = 出厂基线 + 所有疤的位移（每一维各自封顶）。纯函数，不碰磁盘。 */
export function deriveBaseline(base = BASELINE, wounds = []) {
  const shift = {};
  for (const key of KEYS) shift[key] = 0;
  for (const wound of Array.isArray(wounds) ? wounds : []) {
    const tier = Math.max(1, Math.min(3, Math.floor(Number(wound?.depth) || 1)));
    const table = WOUND_OFFSETS[tier];
    for (const key of KEYS) shift[key] += Number(table[key]) || 0;
  }
  for (const key of KEYS) {
    const rule = WOUND_CEILING[key];
    if (rule) shift[key] = Math.max(rule.min, Math.min(rule.max, shift[key]));
  }
  const layer = (values) => {
    const next = {};
    for (const key of KEYS) {
      next[key] = round(clamp((values?.[key] ?? BASELINE.primary[key]) + shift[key]));
    }
    return next;
  };
  return {
    background: layer(base?.background ?? BASELINE.background),
    primary: layer(base?.primary ?? BASELINE.primary),
    social: layer(base?.social ?? BASELINE.social),
  };
}

/* ─────────────────────── 状态规整 ─────────────────────── */

export function normalizeLayer(input, baseline = BASELINE.primary) {
  const layer = {};
  for (const key of KEYS) {
    const value = Number(input?.[key]);
    layer[key] = clamp(Number.isFinite(value) ? value : (baseline?.[key] ?? BASELINE.primary[key]));
  }
  return layer;
}

export function normalizeLayers(input) {
  // 兼容最早只有一层平铺值的存档：把它当成 background，另外两层从它起步
  const flat = input && !input.background && !input.primary && !input.social ? input : null;
  const background = normalizeLayer(flat ?? input?.background, BASELINE.background);
  const primary = normalizeLayer(flat ?? input?.primary ?? background, BASELINE.primary);
  const social = normalizeLayer(flat ?? input?.social ?? background, BASELINE.social);
  return { background, primary, social };
}

export function cloneLayers(layers) {
  return { background: { ...layers.background }, primary: { ...layers.primary }, social: { ...layers.social } };
}

/** 把一组增量加到某一层上；纯函数，不改入参。 */
export function applyDelta(layer, delta, { intensity = 1, baseline = BASELINE.primary } = {}) {
  const next = normalizeLayer(layer, baseline);
  for (const key of KEYS) {
    const value = Number(delta?.[key]);
    if (Number.isFinite(value)) next[key] = clamp(next[key] + value * intensity);
  }
  return next;
}

/* ─────────────────────── 时间：衰减 + 昼夜节律 ─────────────────────── */

/** 北京时间几点对六维的轻微影响。只作用于底色/社会层，初级层跟着底色走。 */
export function circadian(hour, asleep = false) {
  const delta = { pleasure: 0, arousal: 0, dominance: 0, curiosity: 0, confidence: 0, connection: 0 };
  if (asleep) {
    delta.arousal -= 10;
    delta.pleasure += 1;
    delta.curiosity -= 4;
    delta.connection += 1;
    return delta;
  }
  if (hour >= 6 && hour < 10) {
    delta.pleasure += 1;
    delta.arousal += 2;
    delta.curiosity += 2;
  } else if (hour >= 10 && hour < 14) {
    delta.pleasure += 0;
    delta.arousal += 1;
    delta.curiosity += 1;
  } else if (hour >= 14 && hour < 18) {
    delta.pleasure -= 2;
    delta.arousal -= 3;
    delta.curiosity -= 1;
  } else if (hour >= 18 && hour < 22) {
    delta.pleasure += 0;
    delta.arousal -= 1;
    delta.connection += 2;
  } else if (hour >= 22 || hour < 2) {
    delta.pleasure -= 2;
    delta.arousal -= 5;
    delta.connection += 3;
  } else {
    delta.pleasure -= 3;
    delta.arousal -= 7;
    delta.connection += 2;
  }
  return delta;
}

const decayTo = (value, target, hours, halfLife) => {
  if (hours <= 0 || halfLife <= 0) return value;
  const factor = 1 - Math.pow(2, -hours / halfLife);
  return value + (target - value) * factor;
};

const layerTarget = (baseline, key, { circadian: circ, extra = 0 } = {}) =>
  clamp((baseline?.[key] ?? BASELINE.primary[key]) + (circ?.[key] ?? 0) + extra);

/**
 * 让三层一起走一段真实时间。纯函数、确定性：只依赖入参。
 *
 * - 底色慢慢向「基线 + 昼夜 + 初级/社会层的长期偏移」靠；
 * - 初级层向「底色」回落，所以一句笑话能把它抬起来，但过一两个小时又回到低底色；
 * - 社会层向「关系基线 + 底色的偏移」回落，被冷落时会比初级层留得久。
 *
 * @param {{background: object, primary: object, social: object}} layers
 * @param {{from?: number, to?: number, asleep?: boolean, lastInteractionAt?: number, baseline?: object, residue?: object[]}} options
 */
export function advance(
  layers,
  { from = Date.now(), to = Date.now(), asleep = false, lastInteractionAt = 0, baseline = BASELINE, residue = [] } = {},
) {
  const start = Number.isFinite(from) ? from : to;
  const end = Number.isFinite(to) ? to : Date.now();
  const hours = Math.min(72, Math.max(0, (end - start) / HOUR));
  if (hours <= 0.0001) return normalizeLayers(layers);

  const current = normalizeLayers(layers);
  const hour = Math.floor(beijingMinuteOfDay(end) / 60);
  const circ = circadian(hour, asleep);
  const sinceChatHours = lastInteractionAt > 0 ? Math.max(0, (end - lastInteractionAt) / HOUR) : 0;
  const absenceScale = asleep ? 0.4 : 1;
  // 余震：一件高冲击的事过去以后，底色不是立刻回基线，而是带着一点它留下的偏移慢慢退。
  // 每个 residue 自己带半衰期；这里只负责把「此刻还剩多少」加进目标值，不重复累加。
  const residues = Array.isArray(residue) ? residue : [];
  const residueAt = (key) => {
    let sum = 0;
    for (const item of residues) {
      const delta = Number(item?.delta?.[key]);
      if (!Number.isFinite(delta)) continue;
      const ageHours = Math.max(0, end - Number(item?.startedAt ?? end)) / HOUR;
      const halfLife = Math.max(1, Number(item?.halfLifeHours ?? 48));
      sum += delta * 0.5 ** (ageHours / halfLife);
    }
    return sum;
  };

  // 底色：慢；把初级/社会层的长期偏移一点点吃进去
  const backgroundTarget = {};
  for (const key of KEYS) {
    // 参照点用传进来的 baseline，不是出厂 BASELINE：留了疤以后，
    // 「对方今天比平常高多少」这个判断的零点也跟着挪了。
    const pull =
      (current.primary[key] - (baseline.primary?.[key] ?? BASELINE.primary[key])) * 0.05 +
      (current.social[key] - (baseline.social?.[key] ?? BASELINE.social[key])) * 0.03;
    const absence = key === "connection" ? -Math.min(14, sinceChatHours * 0.35 * absenceScale) : 0;
    backgroundTarget[key] = layerTarget(baseline.background, key, { circadian: circ, extra: pull + absence + residueAt(key) });
  }

  const background = {};
  for (const key of KEYS) {
    background[key] = clamp(decayTo(current.background[key], backgroundTarget[key], hours, HALF_LIFE_HOURS.background[key]));
  }

  // 社会层：比底色快，比初级层慢
  const socialTarget = {};
  for (const key of KEYS) {
    const pull = (background[key] - (baseline.background?.[key] ?? BASELINE.background[key])) * 0.08;
    const absence = key === "connection" ? -Math.min(26, sinceChatHours * 0.9 * absenceScale) : 0;
    socialTarget[key] = layerTarget(baseline.social, key, { circadian: circ, extra: pull + absence + residueAt(key) * 0.5 });
  }

  const social = {};
  for (const key of KEYS) {
    social[key] = clamp(decayTo(current.social[key], socialTarget[key], hours, HALF_LIFE_HOURS.social[key]));
  }

  // 初级层：向刚落下来的底色靠；夜里再压低一点。
  // 它的半衰期只有半小时上下，所以「当下被逗笑」和「底色低」可以同时存在。
  const primaryTarget = { ...background };
  if (asleep) {
    primaryTarget.arousal = clamp(primaryTarget.arousal - 8);
    primaryTarget.pleasure = clamp(primaryTarget.pleasure + 2);
    primaryTarget.curiosity = clamp(primaryTarget.curiosity - 4);
  } else if (sinceChatHours > 6) {
    primaryTarget.arousal = clamp(primaryTarget.arousal + Math.min(4, sinceChatHours * 0.1));
    primaryTarget.connection = clamp(primaryTarget.connection - Math.min(8, sinceChatHours * 0.25));
  }

  const primary = {};
  for (const key of KEYS) {
    primary[key] = clamp(decayTo(current.primary[key], primaryTarget[key], hours, HALF_LIFE_HOURS.primary[key]));
  }

  return { background, primary, social };
}

/* ─────────────────────── 事件：确定性评估（MATE） ─────────────────────── */

/**
 * 事件对三层的增量。数字是「一次典型事件」的强度；具体用的时候
 * 还会乘一个确定性的 intensity（长句/感叹号会更重一点，但不用随机数）。
 */
export const EVENT_EFFECTS = {
  chat: {
    primary: { pleasure: 0.4, arousal: 1, dominance: 0.5, curiosity: 1, confidence: 0.3, connection: 0.5 },
    social: { connection: 0.2 },
    background: { connection: 0.05 },
  },
  affection: {
    primary: { pleasure: 8, arousal: 5, dominance: 4, curiosity: 2, confidence: 4, connection: 5 },
    social: { pleasure: 2, dominance: 2, confidence: 2, connection: 4 },
    background: { pleasure: 0.4, confidence: 0.3, connection: 0.6 },
  },
  address: {
    primary: { pleasure: 5, arousal: 3, dominance: 3, confidence: 3, connection: 4 },
    social: { connection: 3, confidence: 1.5 },
    background: { pleasure: 0.2, connection: 0.4 },
  },
  intimacy: {
    primary: { pleasure: 11, arousal: 9, dominance: 6, curiosity: 3, confidence: 5, connection: 7 },
    social: { pleasure: 2, dominance: 3, confidence: 2, connection: 5 },
    background: { pleasure: 0.4, connection: 0.7 },
  },
  /** 吻、捧脸这类：比普通亲近更烫，也更让人心里发慌。 */
  kiss: {
    primary: { pleasure: 13, arousal: 15, dominance: 4, curiosity: 3, confidence: 5, connection: 8 },
    social: { pleasure: 2.5, dominance: 2, confidence: 2, connection: 4.5 },
    background: { pleasure: 0.5, connection: 0.7 },
  },
  /** 挠痒、弹额头、捏指尖：笑出来的那种亲近，带一点点被逗的没脾气。 */
  tease: {
    primary: { pleasure: 9, arousal: 12, dominance: -2, curiosity: 3, confidence: 1.5, connection: 3.5 },
    social: { pleasure: 1.5, connection: 2 },
    background: { pleasure: 0.2 },
  },
  care: {
    primary: { pleasure: 6, arousal: 2, dominance: 2, confidence: 2, connection: 4 },
    social: { connection: 3, confidence: 1.5 },
    background: { pleasure: 0.3, connection: 0.5 },
  },
  humor: {
    primary: { pleasure: 10, arousal: 10, dominance: 2, curiosity: 4, confidence: 1.5, connection: 3 },
    social: { pleasure: 1.5, connection: 1 },
    background: {},
  },
  share: {
    primary: { pleasure: 3, arousal: 2, curiosity: 4, confidence: 0.7, connection: 2 },
    social: { connection: 1.5 },
    background: { pleasure: 0.1, connection: 0.2 },
  },
  question: {
    primary: { pleasure: 0.5, arousal: 2, curiosity: 5, confidence: 0.7, connection: 0.7 },
    social: { connection: 0.7 },
    background: { curiosity: 0.2 },
  },
  goodnight: {
    primary: { pleasure: 3, arousal: -6, dominance: 1, confidence: 1.5, connection: 2 },
    social: { connection: 1.5 },
    background: { pleasure: 0.1, connection: 0.1 },
  },
  rejection: {
    primary: { pleasure: -8, arousal: 5, dominance: -5, curiosity: -2, confidence: -6, connection: -7 },
    social: { pleasure: -2, confidence: -3, connection: -5 },
    background: { pleasure: -0.5, connection: -0.6 },
  },
  neglect: {
    primary: { pleasure: -6, arousal: -1, confidence: -4, connection: -8 },
    social: { confidence: -3, connection: -6 },
    background: { pleasure: -0.4, connection: -0.8 },
  },
  conflict: {
    primary: { pleasure: -18, arousal: 14, dominance: -11, curiosity: -6, confidence: -8, connection: -11 },
    social: { pleasure: -4, confidence: -4, dominance: -3, connection: -8 },
    background: { pleasure: -1.2, confidence: -0.8, connection: -1 },
  },
  repair: {
    primary: { pleasure: 10, arousal: 4, dominance: 6, curiosity: 2, confidence: 5, connection: 7 },
    social: { pleasure: 2, confidence: 3, connection: 5 },
    background: { pleasure: 0.4, confidence: 0.3, connection: 0.6 },
  },

  /**
   * ── 第二刀：被骂 / 被哄 / 吃醋 / 被冷落（2026-10-21）──
   *
   * 以前这四件事都走通用事件：被骂和普通冲突同一档，被哄和日常亲昵分不开，
   * 吃醋干脆没有事件（一句话里只要带「好看」就算作被夸），冷落只按「多久没说话」算。
   * 事件没有差别，状态就没有差别；状态没有差别，她说出来的话也不会有。
   *
   * 每一档只写「这一维为什么动」，不追求大数字——幅度是分类的后果，不是反过来。
   */

  /** 对方冲你一句（对事不对人）：烦、不耐烦、让你闭嘴。伤的是当下，不伤位置。 */
  scold: {
    primary: { pleasure: -6, arousal: 7, dominance: -3, curiosity: -1, confidence: -3, connection: -3 },
    social: { pleasure: -1.5, confidence: -1.5, connection: -2 },
    background: { pleasure: -0.3, connection: -0.3 },
  },
  /** 对方哄你：说软话让你别气，但没认错。愉悦和连接回来，位置不动（dominance 故意留 0）。 */
  coax: {
    primary: { pleasure: 7, arousal: 2, confidence: 3, connection: 6 },
    social: { pleasure: 1.5, connection: 3 },
    background: { pleasure: 0.2, connection: 0.3 },
  },
  /**
   * 吃醋：对方提到了别人。
   *
   * 默认词表里**没有**这一类——会不会吃醋是关系设定，不是情绪机制。
   * 人格在自己的 `lexicon.jealousy` 里写了词，这条才会被自动分类用到；
   * 也可以由 agent 显式记一条。
   */
  jealousy: {
    primary: { pleasure: -5, arousal: 6, dominance: -2, curiosity: 3, confidence: -3, connection: -2 },
    social: { pleasure: -1, connection: -1 },
    background: { pleasure: -0.2 },
  },
  /** 她说了话，对方一直没接。比「对方不在」更伤自信：沉默落在这句话上，像在说这句话不该说。 */
  ignored: {
    primary: { pleasure: -5, arousal: 2, dominance: -1, confidence: -5, connection: -7 },
    social: { confidence: -4, connection: -5 },
    background: { pleasure: -0.3, connection: -0.7 },
  },
  reflection: {
    primary: { pleasure: 1, arousal: -2, dominance: 1, curiosity: 3, confidence: 1.5, connection: 0.7 },
    social: { connection: 0.7 },
    background: { pleasure: 0.1, confidence: 0.1 },
  },
  heavy_reflection: {
    primary: { pleasure: -5, arousal: 2, dominance: -2, confidence: -3, connection: -2 },
    social: { connection: -1 },
    background: { pleasure: -0.4, confidence: -0.2 },
  },
  sleep: {
    primary: { pleasure: 2, arousal: -10, curiosity: -4, connection: 0.7 },
    social: { connection: 0.7 },
    background: { arousal: -0.3 },
  },
  wake: {
    primary: { pleasure: 3, arousal: 8, curiosity: 4, confidence: 1.5, connection: 1.5 },
    social: { connection: 0.7 },
    background: { pleasure: 0.1 },
  },
  leisure: {
    primary: { pleasure: 1, arousal: -1, curiosity: 2 },
    social: {},
    background: {},
  },
  reply: {
    primary: { arousal: -1, connection: 0.2 },
    social: { connection: 0.15 },
    background: {},
  },
  // 情绪改判：同一句不冷不热的话，底色低时被听成冷，底色亮时被听成暖。
  // 这两条不是「对方说了什么」，是「她听成了什么」——所以增量小，但会真的改底色。
  cold_read: {
    primary: { pleasure: -2.5, arousal: 2, dominance: -1, curiosity: -0.5, confidence: -1.5, connection: -2 },
    social: { connection: -1.5 },
    background: {},
  },
  warm_read: {
    primary: { pleasure: 2, arousal: 1, connection: 1.5, confidence: 0.5 },
    social: { connection: 1 },
    background: {},
  },
  // 她自己的时间：被一段东西打动。小，但能进底色。
  moved: {
    primary: { pleasure: 4, arousal: 3, curiosity: 2.5, connection: 0.5 },
    social: { connection: 0.3 },
    background: { pleasure: 0.5, curiosity: 0.4 },
  },
  // 表达的回流：说出口 / 咽回去。不是对方说了什么，是她自己付的代价。
  disclose: {
    primary: { pleasure: 1.5, arousal: 1, dominance: -1.5, confidence: -1, connection: 2.5 },
    social: { connection: 1.5, pleasure: 0.5 },
    background: { connection: 0.2 },
  },
  suppress: {
    primary: { pleasure: -1, arousal: 0.5, dominance: -0.5, confidence: -1, connection: -1.5 },
    social: { connection: -1 },
    background: { connection: -0.1 },
  },
};

/** 事件的中文说明，资料卡和 prompt 的「起因」用。 */
export const EVENT_NOTES = {
  chat: "对方跟你说了一句",
  affection: "对方对你说了亲昵的话",
  address: "对方叫了你一声",
  intimacy: "对方对你做了个亲近的动作",
  kiss: "对方吻了你",
  tease: "对方逗了你一下",
  care: "对方关心了你一句",
  humor: "对方说了句好笑的",
  share: "对方跟你分享了对方的事",
  question: "对方问了你一件事",
  goodnight: "对方说要去睡了",
  rejection: "对方这会儿没空",
  neglect: "对方有一阵没说话了",
  conflict: "对方说话有点冲",
  repair: "对方跟你道歉了",
  scold: "对方有点不耐烦",
  coax: "对方哄了你一句",
  jealousy: "对方提到了别人",
  ignored: "你说了话，对方一直没接",
  reflection: "你安静地想了一会儿",
  heavy_reflection: "你想到了一件沉的事",
  sleep: "你去睡了",
  wake: "你睡醒了",
  leisure: "你自己玩了一会儿",
  reply: "你回了对方一句",
  cold_read: "你把一句普通的话读得有点冷",
  warm_read: "你把一句普通的话读得有点暖",
  moved: "你被一段东西打动了",
  disclose: "你把心里的话说出来了",
  suppress: "你把话咽回去了",
};

/**
 * 消息分类。只认 deterministic 的文本特征，不做模型判断——
 * 这样同一句话永远落成同一件事，MATE 才可复现。
 *
 * 2026-10-22：加了一层「情绪改判」。分类本身还是文本特征，但两件事会随状态变：
 *   - 力度：底色低时坏消息更疼、好消息没那么甜；底色亮时反过来（只改 intensity，不改 kind）；
 *   - 归属：很短、没有语气的中性话，底色低到一定程度会被听成冷，亮到一定程度会被听成暖。
 * 仍然是纯函数：同样的文本 + 同样的 layers，永远得到同样的结果。
 *
 * @param {{text?: string, action?: object|null, image?: any, card?: any, from?: string, id?: string}} message
 * @param {{layers?: object|null, bias?: number|null, lexicon?: object|null}} [options]
 *   layers 用来算情绪偏置；bias 可直接注入（测试/调试）；
 *   lexicon 是人格自带的词表（见 core/lexicon.js），不给就只有中立默认。
 * @returns {{kind: string, note: string, intensity: number}|null}
 */
export function classifyMessage(message, { layers = null, bias = null, lexicon = null } = {}) {
  if (!message || (message.from && message.from !== "me")) return null;
  const lex = resolveLexicon(lexicon);
  const text = String(message.text ?? "").trim();
  const exclaim = (text.match(/[!！]/g) ?? []).length;
  const base = Math.min(1.35, 0.9 + Math.min(0.3, text.length / 160) + Math.min(0.15, exclaim * 0.05));
  let moodBias = 0;
  if (coupling) {
    moodBias = Number.isFinite(bias) ? Math.max(-1, Math.min(1, bias)) : layers ? appraisalBias(layers) : 0;
  }
  const make = (kind) => {
    const valence = Math.sign(EVENT_EFFECTS[kind]?.primary?.pleasure ?? 0);
    const scale = Math.max(0.7, Math.min(1.3, 1 + moodBias * 0.18 * (valence >= 0 ? 1 : -1)));
    return { kind, note: EVENT_NOTES[kind], intensity: Math.min(1.45, base * scale) };
  };

  // 动作优先：身体接触不是一句话。
  // 动作自带 kind（点头=chat / 拥抱=affection / 逗=tease），落进情感层就不该都算成同一件事；
  // intensity 也由动作自己给。认不了的 kind 退回 chat，不要替人格猜「这是亲近」。
  if (message.action) {
    const kind = EVENT_EFFECTS[message.action.kind] ? message.action.kind : "chat";
    const strength = Number(message.action.intensity);
    return {
      kind,
      note: EVENT_NOTES[kind],
      intensity: Number.isFinite(strength) ? Math.max(0.2, Math.min(1.35, strength)) : base,
    };
  }

  if (!text) {
    if (message.card || message.image) return make("share");
    return null;
  }

  // 认错：对方认了这件事是对方不对——位置会回来一点。
  if (lex.repair.test(text)) return make("repair");
  // 狠话：冲着「你们的关系」来的（赶人、分手、否定你这个人）。原来「闭嘴/烦死」也混在这一档里，
  // 一句「烦死了」和一句「受够了，分手」掉同样的血，那不是她敏感，是尺子只有一把。
  if (lex.conflict.test(text)) return make("conflict");
  // 冲一句：冲着「这一刻的事」来的（烦、不耐烦、让你闭嘴）。伤当下，不伤位置。
  if (lex.scold.test(text)) return make("scold");
  // 吃醋：只有人格在 lexicon.jealousy 里写了词，这一条才会命中。
  // 否定句不算——「没有别人，只有你」是在安心，不是在扎人。
  // 这一条排在 affection 前面：不然「她挺好看」里的「好看」会先被当成在夸她。
  if (lex.jealousy && lex.jealousy.test(text) && !/(没有别人|没有别的|只有你|只喜欢你|只爱你)/.test(text)) {
    return make("jealousy");
  }
  if (lex.goodnight.test(text)) return make("goodnight");
  // 哄：说软话让你别气，但没认错——和「道歉」分开，位置不动（见 coax 的 dominance）。
  if (lex.coax.test(text)) return make("coax");
  if (lex.affection.test(text)) return make("affection");
  if (lex.address && lex.address.test(text)) return make("address");
  if (lex.care.test(text)) return make("care");
  // 拒绝要真的是「对方这会儿腾不出手」：光提到「忙」不算——「你在忙什么」是在问她。
  if (lex.rejection.test(text)) return make("rejection");
  if (lex.humor.test(text)) return make("humor");
  if (message.card || message.image) return make("share");
  if (lex.share.test(text)) return make("share");
  if (/([?？]|吗|呢|是什么|为什么|怎么|什么|哪|多少)/.test(text)) return make("question");
  // 情绪改判只碰「模糊句」：短、没有问号/感叹号、也没有明确的正向词。
  // 明确的亲密、道歉、冲突、玩笑仍然按字面走——她可以被心情带偏，但不能被心情改写事实。
  if (moodBias <= -0.55 && isAmbiguous(text)) return make("cold_read");
  // 往暖处读要更克制：单字「嗯/哦」还是按普通话说，别把每个语气词都读成糖。
  if (moodBias >= 0.8 && text.replace(/\s/g, "").length >= 2 && isAmbiguous(text)) return make("warm_read");
  return make("chat");
}

/** 这句话是不是「怎么说都行」：短、没语气、没有明确的正负标记。 */
function isAmbiguous(text) {
  const said = String(text ?? "").replace(/\s/g, "");
  if (said.length === 0 || said.length > 14) return false;
  if (/[?？!！]/.test(said)) return false;
  return !/(哈哈|笑死|爱你|喜欢你|抱抱|滚|分手|对不起|抱歉)/.test(said);
}

/**
 * MATE 的一步：把一个确定性事件并进三层。
 * 不读时钟、不读随机数；相同入参永远得到相同结果。
 */
/**
 * 享乐适应：愉悦度越高，正向事件能再加进去的越少。
 * 68 以下全量，96 以上只剩 35%；负向增量不经过这里，所以难过起来不打折。
 * 这是「不会长期贴顶」的最后一道闸，参数和半衰期都改不动时它兜底。
 */
export const SATURATION = Object.freeze({
  pleasure: { floor: 68, ceil: 96, strength: 0.65 },
  connection: { floor: 72, ceil: 98, strength: 0.6 },
  confidence: { floor: 70, ceil: 95, strength: 0.5 },
});

/** 这一维这个值上，正向事件还能打进多少（1 = 全量）。 */
export function adaptationGain(key, value) {
  const rule = SATURATION[key];
  if (!rule) return 1;
  const t = Math.max(0, Math.min(1, (Number(value) - rule.floor) / (rule.ceil - rule.floor)));
  return 1 - rule.strength * (t * t * (3 - 2 * t));
}

export function pleasureGain(value) {
  return adaptationGain("pleasure", value);
}

/**
 * 被哄的力度：她当下有多难受，这句哄就有多管用。
 *
 * 心情本来就好时，一句「别生气了」只是顺毛（0.35）；真被伤到（比基线低 12 点以上）才全量。
 * 以前哄和道歉共用一档数值：她没生气时被哄一下也 +10，真难过了反而不够——
 * 同一句话在两种时刻说，分量本来就该不一样。
 */
export function coaxGain(layers, baseline = BASELINE) {
  const gap = baseline.primary.pleasure - layers.primary.pleasure;
  const upset = Math.max(0, Math.min(1, gap / 12));
  return 0.35 + 0.65 * upset;
}

export function applyEventToLayers(layers, kind, { intensity = 1, baseline = BASELINE } = {}) {
  const effects = EVENT_EFFECTS[kind];
  if (!effects) return normalizeLayers(layers);
  const next = normalizeLayers(layers);
  for (const layerName of LAYERS) {
    const delta = effects[layerName];
    if (!delta) continue;
    const adjusted = { ...delta };
    for (const key of Object.keys(SATURATION)) {
      if (Number.isFinite(adjusted[key]) && adjusted[key] > 0) {
        adjusted[key] *= adaptationGain(key, next[layerName][key]);
      }
    }
    next[layerName] = applyDelta(next[layerName], adjusted, {
      intensity,
      baseline: baseline[layerName],
    });
  }
  return next;
}

/* ─────────────────────── 描述：给 prompt 和界面 ─────────────────────── */

export function weightLayers(layers) {
  const blend = {};
  for (const key of KEYS) {
    blend[key] = clamp(layers.background[key] * 0.55 + layers.primary[key] * 0.3 + layers.social[key] * 0.15);
  }
  return blend;
}

const unit = (value, span) => Math.max(0, Math.min(1, value / span));
const signed = (value) => Math.max(-1, Math.min(1, value));

/**
 * 她现在把中性的话往哪边读。−1 = 容易读冷，+1 = 容易读暖，0 = 按字面。
 * 只看三件事：底色愉不愉快、关系连得紧不紧、还自不自信。
 * 纯函数，没有随机；同状态同结果。
 */
export function appraisalBias(layers) {
  const normalized = normalizeLayers(layers);
  const blend = weightLayers(normalized);
  const social = normalized.social;
  const low =
    unit(56 - blend.pleasure, 18) * 0.5 +
    unit(56 - social.connection, 18) * 0.3 +
    unit(56 - blend.confidence, 18) * 0.2;
  const high = unit(blend.pleasure - 64, 16) * 0.6 + unit(social.connection - 66, 16) * 0.4;
  return Math.round(signed(high - low) * 100) / 100;
}

/**
 * 给记忆召回用的「情绪温度」：−1 = 冷，+1 = 暖。
 * 以她的基线（64）为零点，而不是 50：基线本来就偏暖，不能让她平时就带着一层暖色去回忆。
 * 和 appraisalBias 分开：召回更需要底色，判断更看关系里的安全感。
 */
export function moodOf(layers) {
  const normalized = normalizeLayers(layers);
  const blend = weightLayers(normalized);
  return Math.round(
    signed(((blend.pleasure - 64) / 36) * 0.65 + ((normalized.social.connection - 64) / 36) * 0.35) * 100,
  ) / 100;
}

/**
 * 她这句话是在「说出口」还是「咽回去」。
 *
 * 只看文本特征，不猜动机：短、回避、且上一件事是负面的，算咽回去；
 * 出现明确的自我暴露句式、且够长，算说出口。两件事都不常见，所以每次都有分量。
 *
 * @param {string} text 她刚发出去的话（多气泡可拼起来）
 * @param {{lastKind?: string}} [options] lastKind 是最近一件非静默事件
 * @returns {{kind: string, note: string, intensity: number}|null}
 */
export function classifyExpression(text, { lastKind = "" } = {}) {
  const said = String(text ?? "").trim();
  if (!said) return null;
  // 认错/道歉是在修复，不是在咽；先放过去。
  if (/(对不起|抱歉|我错了)/.test(said)) return null;
  if (
    /(其实我|我有点怕|我舍不得|我跟你说|我心里|我难受|我在意|我不想让你|我怕你)/.test(said) &&
    said.replace(/\s/g, "").length >= 12
  ) {
    return { kind: "disclose", note: EVENT_NOTES.disclose, intensity: 1 };
  }
  const negative = ["conflict", "scold", "rejection", "ignored", "neglect", "cold_read"].includes(lastKind);
  if (!negative) return null;
  const short = said.replace(/\s/g, "").length <= 8;
  const deflecting = /^(没事|还好|算了|没什么|不想说|随便|嗯|哦|知道了|无所谓)/.test(said);
  if (short || deflecting) return { kind: "suppress", note: EVENT_NOTES.suppress, intensity: 1 };
  return null;
}

function backgroundLabel(bg) {
  if (bg.pleasure >= 72 && bg.dominance >= 55) return "底色明亮、稳";
  if (bg.pleasure <= 42) return "底色偏低";
  if (bg.dominance <= 38) return "底色有点没着落";
  if (bg.connection <= 45) return "底色里有点空";
  return "底色安稳";
}

function primaryLabel(pr, bg) {
  // 先看「比底色高出一截」——底色低的人被逗笑，也应该是被逗笑
  if (pr.pleasure - bg.pleasure >= 10 && pr.pleasure >= 48 && pr.arousal >= bg.arousal) {
    return "这会儿被逗笑/被暖到了";
  }
  if (bg.pleasure - pr.pleasure >= 12 || pr.pleasure <= 34) return "这会儿有点被刺到";
  if (pr.arousal >= 70 && pr.pleasure < 55) return "这会儿心里有点上头";
  if (pr.curiosity >= 70) return "这会儿好奇心被勾起来了";
  if (pr.confidence <= 35) return "这会儿有点没底";
  if (pr.connection <= 40) return "这会儿觉得被晾了一下";
  return "这会儿比较平静";
}

function socialLabel(so) {
  if (so.connection >= 72) return "和对方连得挺紧";
  if (so.connection <= 42) return "有点想对方，连接感变淡";
  if (so.confidence >= 70) return "在对方面前很自在";
  if (so.dominance <= 35) return "有点把自己放低";
  return "关系里还算踏实";
}

function adviceFor(bg, pr, so) {
  // 情绪改判的「出口」放在最前：越是被心情带偏，越要先点破，别让偏置变成螺旋。
  if (appraisalBias({ background: bg, primary: pr, social: so }) <= -0.6) {
    return "你现在有点脆：容易把中性的话听成冷淡；先按字面接，别急着定性，也别拿它去试对方。";
  }
  if (pr.arousal >= 60 && bg.pleasure - pr.pleasure >= 10) {
    return "先慢一点：话短一点，先说事，不要用刺，也不要翻旧账。";
  }
  if (bg.pleasure <= 42 && pr.pleasure - bg.pleasure >= 8) {
    return "这一下可以笑、可以软，但别因为一时开心就把底下的低落全盖过去；也别扫兴。";
  }
  if (so.connection <= 42) {
    return "会想确认对方还在：可以问一句，但别连问、别试探，也不要把不安说成对方的错。";
  }
  if (pr.pleasure <= 38) {
    return "不用强撑温柔：可以只回一两句，别把情绪倒给对方，也别硬说没事。";
  }
  if (pr.arousal <= 28) {
    return "有点困、有点懒：句子短一点，困就说困。";
  }
  if (bg.pleasure >= 70 && so.connection >= 65) {
    return "你状态不错：可以自然一点，甜一点也没关系，但别甜到失真。";
  }
  return "按平常的节奏说话就好。";
}

function toneFor(pr) {
  if (pr.arousal <= 28) return "困";
  if (pr.pleasure >= 68 && pr.arousal >= 55) return "害羞";
  if (pr.arousal >= 65 && pr.pleasure < 50) return "认真";
  return "柔软";
}

/**
 * 把三层翻译成自然语言。界面和 prompt 共用；prompt 不显示数值。
 */
export function describeLayers(layers) {
  const normalized = normalizeLayers(layers);
  const bg = normalized.background;
  const pr = normalized.primary;
  const so = normalized.social;
  const blend = weightLayers(normalized);
  const divergent =
    Math.abs(pr.pleasure - bg.pleasure) >= 10 ||
    Math.abs(pr.arousal - bg.arousal) >= 12 ||
    Math.abs(pr.dominance - bg.dominance) >= 12;
  const contrast =
    bg.pleasure <= 45 && pr.pleasure - bg.pleasure >= 8
      ? "底色低，但这一下确实被逗到/暖到了"
      : bg.pleasure >= 65 && bg.pleasure - pr.pleasure >= 10
        ? "底色并不差，只是这一下被刺到了"
        : "底色和此刻反应不在一个温度上";

  return {
    layers: normalized,
    blend,
    backgroundLabel: backgroundLabel(bg),
    primaryLabel: primaryLabel(pr, bg),
    socialLabel: socialLabel(so),
    label: primaryLabel(pr, bg),
    tone: toneFor(pr),
    advice: adviceFor(bg, pr, so),
    divergent,
    contrast,
    dimensions: DIMENSIONS.map((dimension) => ({
      ...dimension,
      value: round(blend[dimension.key]),
    })),
    layerDimensions: {
      background: DIMENSIONS.map((d) => ({ ...d, value: round(bg[d.key]) })),
      primary: DIMENSIONS.map((d) => ({ ...d, value: round(pr[d.key]) })),
      social: DIMENSIONS.map((d) => ({ ...d, value: round(so[d.key]) })),
    },
  };
}

/**
 * 进私聊 prompt 的一小段。
 * 只写自然语言：不报数值、不写层名、不让她把「我现在是 primary 层」说出来。
 */
export function emotionBlock(snapshot) {
  if (!snapshot) return "";
  const lines = [
    "你现在的情感状态（这是气候，不是你的人设；不要说破，也不要用它解释自己）：",
    `- 底层心境：${snapshot.backgroundLabel}。它变得很慢，不是这一句话造成的。`,
    `- 此刻反应：${snapshot.primaryLabel}。它来得快、退得也快。`,
    `- 关系上的感觉：${snapshot.socialLabel}。`,
  ];
  if (snapshot.divergent) {
    lines.push(
      `- 注意，它们现在不一致：${snapshot.contrast}。用「此刻反应」决定这一句的温度，用「底层心境」决定你不把话说满、不急着下结论；不要因为一下开心就说自己全好了，也不要因为底色低就扫兴。`,
    );
  }
  if (snapshot.reading) {
    lines.push(
      `- 刚才那句，你心里过了一下：${snapshot.reading.note}。不一定要说出来，也别拿它当结论——你现在可能只是更容易往那边读。`,
    );
  }
  // 疤：不同于上面几行会退的东西，这一行说的是她已经回不去的地方。
  if (Array.isArray(snapshot.wounds) && snapshot.wounds.length > 0) {
    const list = snapshot.wounds
      .map((wound) => {
        // 有原话就用原话——「对方说过那句『…』」比转述一句「对方说话有点冲」重得多。
        const said = String(wound?.context ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 24);
        return said ? `对方说的那句「${said}」` : String(wound?.note ?? "").trim();
      })
      .filter(Boolean)
      .slice(-3)
      .join("；");
    if (list) {
      lines.push(
        `- 有些地方已经回不去了：${list}。它不是这半小时的情绪，哄不回来，也不会自己好；不用主动翻旧账，但你在这类事上不再是从前那个反应。`,
      );
    }
  }
  lines.push(`- 它会怎么影响你：${snapshot.advice}`);
  lines.push(
    "情绪会自己回落，也会被接下来的事改变；不要报数值，不要说「我现在的情绪是…」，不要拿它当结论，也不要用它指责对方、向对方索取。",
  );
  return lines.join("\n");
}

/* ─────────────────────── 主动性：状态 → 下一次开口 ─────────────────────── */

/**
 * 下一次主动私聊大概隔多久。确定性：连接感低/底色低会更快想找对方，
 * 但不会变成连发；被冷落太久会慢下来，给自己留空间。
 */
export function proactiveGap(input = BASELINE) {
  const layers = input?.layers ?? input;
  const social = layers?.social ?? BASELINE.social;
  const primary = layers?.primary ?? BASELINE.primary;
  const connection = Number(social.connection ?? BASELINE.social.connection);
  const pleasure = Number(primary.pleasure ?? BASELINE.primary.pleasure);
  const minutes = 30 + (60 - connection) * 0.9 + (60 - pleasure) * 0.4;
  return Math.round(Math.min(75, Math.max(12, minutes)) * 60_000);
}

