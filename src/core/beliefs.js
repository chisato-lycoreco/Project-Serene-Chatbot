/**
 * core/beliefs.js — 她自己的看法（纯函数）
 *
 * 和记忆不是一回事：记忆回答「发生过什么」，看法回答「她怎么看」。
 * 「他上次说讨厌吵闹」是记忆；「安静比热闹好」是看法。
 *
 * 看法要能被一次事件推动，但也不能被一次事件翻面——所以每次只挪一部分，
 * 而且要有「底气」（confidence）：听得多、被验证过，才更敢说。
 *
 * 人格可以给种子（`persona.beliefs`）；没有种子就是空的，不替她编世界观。
 * 不落盘、不看时间：`now` 由调用方给。
 */

/** 最多记多少条看法；超了先丢底气最低的。 */
export const MAX_BELIEFS = 24;
/** 一次事件能把旧立场挪走多少。 */
const STANCE_PULL = 0.3;
/** 没听过的新看法，一开始有多少底气。 */
const NEW_CONFIDENCE = 0.35;
/** 底气上限：再确定也留一点余地。 */
const MAX_CONFIDENCE = 0.95;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const sentence = (value) => String(value ?? "").trim().replace(/[。.！!；;，,、\s]+$/, "");

/**
 * 把人格里的种子收成标准形状；非法项直接丢，不猜。
 * @param {Array} list
 */
export function normalizeBeliefs(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const topic = sentence(item?.topic).slice(0, 40);
    if (!topic || seen.has(topic)) continue;
    const stance = Number(item?.stance);
    if (!Number.isFinite(stance)) continue;
    seen.add(topic);
    out.push({
      topic,
      stance: clamp(stance, -1, 1),
      confidence: clamp(Number.isFinite(Number(item?.confidence)) ? Number(item.confidence) : NEW_CONFIDENCE, 0, MAX_CONFIDENCE),
      evidence: Math.max(0, Math.floor(Number(item?.evidence) || 0)),
      updatedAt: Number(item?.updatedAt) || 0,
    });
  }
  return out.slice(0, MAX_BELIEFS);
}

/**
 * 记一次「她听见了什么」，看法跟着动一点。
 *
 * @param {Array} beliefs 现有看法
 * @param {object} input
 * @param {string} input.topic 看法本身，一句话（「安静比热闹好」）
 * @param {number} [input.stance] 这次事件支持的立场 −1~1；不给就只是「又听到一次」
 * @param {number} [input.weight] 这次的分量，默认 1；0.5 = 半信半疑，2 = 很重
 * @param {number} [now]
 * @returns {{beliefs: Array, belief: object, changed: boolean}}
 */
export function applyEvidence(beliefs, { topic, stance, weight = 1, now = 0 } = {}) {
  const text = sentence(topic).slice(0, 40);
  if (!text) return { beliefs: normalizeBeliefs(beliefs), belief: null, changed: false };
  const list = normalizeBeliefs(beliefs);
  const next = list.slice();
  const index = next.findIndex((item) => item.topic === text);
  const pull = clamp(Number(weight) || 1, 0.1, 3) * STANCE_PULL;
  const hasStance = Number.isFinite(Number(stance)) && String(stance ?? "").trim() !== "";

  let belief;
  if (index >= 0) {
    const old = next[index];
    const target = hasStance ? clamp(Number(stance), -1, 1) : old.stance;
    belief = {
      ...old,
      stance: clamp(old.stance + (target - old.stance) * Math.min(1, pull), -1, 1),
      confidence: clamp(old.confidence + (MAX_CONFIDENCE - old.confidence) * Math.min(0.5, pull / 2), 0, MAX_CONFIDENCE),
      evidence: old.evidence + 1,
      updatedAt: Number(now) || old.updatedAt,
    };
    next[index] = belief;
  } else {
    if (!hasStance) return { beliefs: list, belief: null, changed: false };
    belief = {
      topic: text,
      stance: clamp(Number(stance), -1, 1),
      confidence: Math.min(MAX_CONFIDENCE, NEW_CONFIDENCE + Math.min(0.2, pull / 3)),
      evidence: 1,
      updatedAt: Number(now) || 0,
    };
    next.push(belief);
  }

  next.sort((a, b) => b.confidence - a.confidence || b.evidence - a.evidence);
  return { beliefs: next.slice(0, MAX_BELIEFS), belief, changed: true };
}

/**
 * 给 prompt 用的一句话。只挑有底气的，最多三条；空的时候返回空串。
 * 不写「我认为」——看法就是她说话时的底色，不需要声明。
 */
export function beliefsLine(beliefs, { limit = 3, minConfidence = 0.4 } = {}) {
  const list = normalizeBeliefs(beliefs)
    .filter((item) => item.confidence >= minConfidence && Math.abs(item.stance) >= 0.15)
    .sort((a, b) => b.confidence * Math.abs(b.stance) - a.confidence * Math.abs(a.stance))
    .slice(0, limit);
  if (!list.length) return "";
  return `你相信：${list.map((item) => item.topic).join("；")}。`;
}

/**
 * 人格种子 + 后来学到的：同一个话题以学到的为准，其余按底气排序。
 * 换人格时种子跟着换，学到的留在该人格自己的数据目录里，不会串。
 */
export function mergeBeliefs(seeds, learned) {
  const merged = new Map();
  for (const item of normalizeBeliefs(seeds)) merged.set(item.topic, item);
  for (const item of normalizeBeliefs(learned)) merged.set(item.topic, item);
  return [...merged.values()].sort((a, b) => b.confidence - a.confidence || b.evidence - a.evidence).slice(0, MAX_BELIEFS);
}

export const __test__ = { STANCE_PULL, NEW_CONFIDENCE, MAX_CONFIDENCE };
