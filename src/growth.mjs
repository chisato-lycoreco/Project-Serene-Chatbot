/**
 * src/growth.mjs — 「她眼里的世界」是怎么一点点长出来的（纯函数）。
 *
 * 这不是用户画像，是**她自己的档案**：她是什么样的人、她怎么看自己、
 * 她眼里的他、你们之间、她不肯承认的那部分、她自己的日常。
 *
 * 每条都带出处（他当时说的原话）和权重。权重不是分数，是「这件事被印证过几次」：
 * 同一句话再听到一次，它会重一点；一直没有新证据，它会慢慢让位给新长出来的东西。
 *
 * 档案有上限。只增不减的档案最后会变成一张谁都不读的清单。
 */

import { tokenize } from "./core/recall.js";

export const SECTIONS = Object.freeze(["traits", "self", "user", "us", "shadow", "life"]);

export const SECTION_LABEL = Object.freeze({
  traits: "你是什么样的人",
  self: "你怎么看自己",
  user: "你眼里的他",
  us: "你们之间",
  shadow: "你不肯承认的那部分",
  life: "你的日常",
});

export const SECTION_CAPS = Object.freeze({
  traits: 8,
  self: 8,
  user: 10,
  us: 10,
  shadow: 6,
  life: 8,
});

export const MAX_ITEM_CHARS = 40;
export const MAX_EVIDENCE_CHARS = 24;
export const MERGE_AT = 0.72;
export const MAX_WEIGHT = 9;

const SECTION_SET = new Set(SECTIONS);

export function emptyGrowth() {
  return Object.fromEntries(SECTIONS.map((section) => [section, []]));
}

/**
 * 把模型抽出来的一条观察归一化。
 * 不合法（没文本、section 不认识）就返回 null——宁可少长一条，不长错一条。
 */
export function normalizeItem(raw, { section, now = Date.now() } = {}) {
  const key = SECTION_SET.has(section) ? section : SECTION_SET.has(raw?.section) ? raw.section : "";
  const text = String(raw?.text ?? "").trim().replace(/\s+/g, " ");
  if (!key || !text) return null;
  const chars = Array.from(text).slice(0, MAX_ITEM_CHARS).join("");
  const evidence = (Array.isArray(raw?.evidence) ? raw.evidence : raw?.evidence ? [raw.evidence] : [])
    .map((line) => Array.from(String(line ?? "").replace(/\s+/g, " ").trim()).slice(0, MAX_EVIDENCE_CHARS).join(""))
    .filter(Boolean)
    .slice(0, 2);
  return {
    id: `g_${now.toString(36)}_${hash(text).toString(36).slice(0, 4)}`,
    section: key,
    text: chars,
    evidence,
    weight: clamp(Math.round(Number(raw?.weight) || 1), 1, MAX_WEIGHT),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 把一条观察并进档案。
 *
 * - 同一节里说到同一件事 → 加固：权重 +1，取更长的那句，原话合并；
 * - 新的 → 加进来；超过这一节的上限 → 丢掉权重最低、最久没被印证的那条。
 *
 * @returns {{sections: object, changed: boolean, action: "added"|"merged"|"none", id: string}}
 */
export function absorb(sections, input, { now = Date.now() } = {}) {
  const current = normalizeSections(sections);
  const item = normalizeItem(input, { section: input?.section, now });
  if (!item) return { sections: current, changed: false, action: "none", id: "" };

  const list = current[item.section];
  const twin = list.find((existing) => similarity(existing.text, item.text) >= MERGE_AT);
  if (twin) {
    twin.text = Array.from(item.text).length > Array.from(twin.text).length ? item.text : twin.text;
    twin.evidence = [...new Set([...(twin.evidence ?? []), ...(item.evidence ?? [])])].slice(0, 2);
    twin.weight = Math.min(MAX_WEIGHT, Number(twin.weight) + 1);
    twin.updatedAt = now;
    return { sections: current, changed: true, action: "merged", id: twin.id };
  }

  list.push(item);
  if (list.length > SECTION_CAPS[item.section]) {
    const victim = [...list].sort(
      (a, b) => Number(a.weight) - Number(b.weight) || Number(a.updatedAt) - Number(b.updatedAt),
    )[0];
    current[item.section] = list.filter((existing) => existing !== victim);
  }
  return { sections: current, changed: true, action: "added", id: item.id };
}

export function normalizeSections(raw) {
  const result = emptyGrowth();
  const source = raw && typeof raw === "object" ? raw : {};
  for (const section of SECTIONS) {
    const list = Array.isArray(source[section]) ? source[section] : [];
    const seen = [];
    for (const item of list) {
      const text = String(item?.text ?? "").trim();
      if (!text) continue;
      if (seen.some((other) => similarity(other.text, text) >= MERGE_AT)) continue;
      seen.push({
        id: String(item?.id ?? `g_seed_${seen.length}`),
        text: Array.from(text).slice(0, MAX_ITEM_CHARS).join(""),
        evidence: (Array.isArray(item?.evidence) ? item.evidence : []).map(String).slice(0, 2),
        weight: clamp(Math.round(Number(item?.weight) || 1), 1, MAX_WEIGHT),
        createdAt: Number(item?.createdAt) || 0,
        updatedAt: Number(item?.updatedAt) || Number(item?.createdAt) || 0,
      });
    }
    result[section] = seen.slice(-SECTION_CAPS[section]);
  }
  return result;
}

/** 她读到的档案：每一节按权重、再按新旧排，最多取 `perSection` 条。 */
export function growthBlock(sections, { perSection = 3, sections: only = null } = {}) {
  const current = normalizeSections(sections);
  const keys = Array.isArray(only) && only.length ? only.filter((key) => SECTION_SET.has(key)) : SECTIONS;
  const parts = [];
  for (const section of keys) {
    const top = [...current[section]]
      .sort((a, b) => Number(b.weight) - Number(a.weight) || Number(b.updatedAt) - Number(a.updatedAt))
      .slice(0, perSection);
    if (!top.length) continue;
    const lines = top.map((item) => {
      const quote = item.evidence?.[0] ? `（他说过「${item.evidence[0]}」）` : "";
      return `- ${item.text}${quote}`;
    });
    parts.push(`【${SECTION_LABEL[section]}】\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

export function stats(sections) {
  const current = normalizeSections(sections);
  return Object.fromEntries(SECTIONS.map((section) => [section, current[section].length]));
}

export function total(sections) {
  return Object.values(stats(sections)).reduce((sum, count) => sum + count, 0);
}

/* ───────────────────────── 内部 ───────────────────────── */

function similarity(a, b) {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (!left.size || !right.size) return 0;
  let hit = 0;
  for (const token of left) if (right.has(token)) hit += 1;
  return hit / (left.size + right.size - hit);
}

function hash(text) {
  let value = 2166136261;
  for (const char of String(text)) {
    value ^= char.codePointAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
