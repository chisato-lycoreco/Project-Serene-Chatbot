/**
 * src/bond.mjs — 关系不是一句「好感度」，是四条会互相拉扯的轴。
 *
 *   closeness  亲近：愿不愿意把话往深里说
 *   trust      信任：说过的话会不会被当真
 *   security   安全感：吵过之后还回不回来
 *   expression 表达：她想说的时候，敢不敢说
 *
 * 全是 0–100 的慢变量。一次争吵不会把关系清零，一次甜言蜜语也涨不满。
 * 它们不进 prompt 的数字，只进一句自然的描述——她不该知道自己是 63.5。
 */

export const AXES = Object.freeze(["closeness", "trust", "security", "expression"]);

export const AXIS_LABEL = Object.freeze({
  closeness: "亲近",
  trust: "信任",
  security: "安全感",
  expression: "表达",
});

export const INITIAL = Object.freeze({ closeness: 8, trust: 22, security: 40, expression: 45 });

/**
 * 一类互动对四条轴的影响。数值是「一次」的量级：一天聊三十句也不会到 100。
 * 只认情感层已经认出来的 kind，不再单独做一遍语义判断。
 */
export const EFFECTS = Object.freeze({
  chat: { closeness: 0.15 },
  question: { closeness: 0.4, expression: 0.3 },
  share: { closeness: 1.2, trust: 1.0 },
  disclose: { closeness: 2.0, trust: 1.5 },
  address: { closeness: 0.8, expression: 0.4 },
  affection: { closeness: 2.2, security: 0.8 },
  intimacy: { closeness: 2.8, trust: 1.0, security: 0.6 },
  kiss: { closeness: 3.0, security: 1.0 },
  tease: { closeness: 1.2, expression: 0.6 },
  care: { closeness: 1.5, trust: 1.6 },
  humor: { closeness: 1.0, expression: 0.4 },
  goodnight: { closeness: 0.6, security: 0.5 },
  coax: { closeness: 1.6, security: 1.2 },
  repair: { trust: 3.0, security: 2.0, closeness: 1.0 },
  conflict: { closeness: -1.5, trust: -1.0, security: -6.0 },
  scold: { closeness: -1.0, trust: -0.8, security: -4.0 },
  rejection: { closeness: -1.6, trust: -0.6, security: -5.0 },
  neglect: { closeness: -0.8, security: -4.0 },
  ignored: { closeness: -0.8, security: -4.0 },
});

export function initialBond(now = Date.now()) {
  return { ...INITIAL, since: now, phase: "初识", events: [], updatedAt: now };
}

/**
 * 记一次互动。
 * @returns {{bond: object, deltas: object, phaseChanged: boolean}}
 */
export function updateBond(bond, kind, { now = Date.now() } = {}) {
  const current = normalizeBond(bond, now);
  const effect = EFFECTS[kind];
  if (!effect) return { bond: current, deltas: {}, phaseChanged: false };
  const deltas = {};
  for (const axis of AXES) {
    const delta = Number(effect[axis]) || 0;
    if (!delta) continue;
    const before = current[axis];
    current[axis] = clamp(before + delta, 0, 100);
    deltas[axis] = round(current[axis] - before);
  }
  const phase = phaseOf(current);
  const phaseChanged = phase !== current.phase;
  current.phase = phase;
  current.updatedAt = now;
  if (Object.keys(deltas).length) {
    current.events.push({ at: now, kind, deltas });
    if (current.events.length > 80) current.events = current.events.slice(-80);
  }
  return { bond: current, deltas, phaseChanged };
}

/** 时间也会让关系变：很久没说话，安全感会自己往下走一点点。 */
export function driftBond(bond, { now = Date.now(), idleDays = 0 } = {}) {
  const current = normalizeBond(bond, now);
  if (idleDays < 3) return { bond: current, deltas: {} };
  const loss = Math.min(8, (idleDays - 2) * 0.6);
  const deltas = { security: round(-loss) };
  current.security = clamp(current.security - loss, 0, 100);
  current.updatedAt = now;
  current.phase = phaseOf(current);
  return { bond: current, deltas };
}

export function phaseOf(bond) {
  const closeness = Number(bond?.closeness) || 0;
  const trust = Number(bond?.trust) || 0;
  if (closeness >= 82 && trust >= 78) return "很稳";
  if (closeness >= 62 && trust >= 62) return "默契";
  if (closeness >= 38 || trust >= 55) return "亲近";
  if (closeness >= 16 || trust >= 38) return "说上话了";
  return "初识";
}

/** 给 prompt 用的一段话：不出现数字，不出现「好感度」。 */
export function bondBlock(bond, { days = 0 } = {}) {
  const current = normalizeBond(bond);
  const phase = phaseOf(current);
  const lines = [];
  if (days > 0) lines.push(`你们认识 ${days} 天了。`);
  lines.push(`现在的关系：${phase}。`);

  if (current.trust >= 65) lines.push("他说的话，你信。");
  else if (current.trust <= 30) lines.push("他说的话，你还会先掂一掂。");

  if (current.security >= 65) lines.push("就算刚顶过两句，你也不担心他明天不来。");
  else if (current.security <= 30) lines.push("你心里没底：他会不会哪天就不来了。");

  if (current.closeness >= 65) lines.push("有些话你只对他说，也只在他这儿说得出口。");
  else if (current.closeness <= 15) lines.push("你们还没熟到可以什么都说的地步。");

  if (current.expression >= 60) lines.push("想说什么就说，不用先在心里过三遍。");
  else if (current.expression <= 30) lines.push("你想说的比说出口的多。");
  return lines.join("");
}

export function normalizeBond(bond, now = Date.now()) {
  const raw = bond && typeof bond === "object" ? bond : {};
  const result = {
    since: Number(raw.since) || now,
    updatedAt: Number(raw.updatedAt) || now,
    phase: String(raw.phase ?? "初识"),
    events: Array.isArray(raw.events)
      ? raw.events
          .filter((event) => event && Number.isFinite(Number(event.at)))
          .slice(-80)
          .map((event) => ({
            at: Number(event.at),
            kind: String(event.kind ?? ""),
            deltas: event.deltas && typeof event.deltas === "object" ? event.deltas : {},
          }))
      : [],
  };
  for (const axis of AXES) {
    const value = Number(raw[axis]);
    result[axis] = clamp(Number.isFinite(value) ? value : INITIAL[axis], 0, 100);
  }
  result.phase = phaseOf(result);
  return result;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value) {
  return Math.round(value * 100) / 100;
}
