/**
 * src/extract.mjs — 聊完这一轮，回头把「值得留的」写下来。
 *
 * 这件事必须在回复之后做，而且失败不能影响回复：模型偶尔吐一段坏 JSON，
 * 最坏的结果应该是「这一轮什么都没记住」，不是「她没说话」。
 *
 * 抽取的原则是「宁可漏，不要编」：
 * - 只写他说过的、关于他的、以后还用得上的；
 * - 每条都要带一句他的原话（不许改写），用来防止概括越漂越远；
 * - 她自己的话不进记忆——她说过什么在聊天记录里，不在「她记得的事」里。
 */

import { parseJsonLoose } from "./model.mjs";

export const MEMORY_KINDS = Object.freeze(["fact", "preference", "moment", "promise", "insight", "self"]);
export const SECTIONS = Object.freeze(["traits", "self", "user", "us", "shadow", "life"]);

const MAX_MEMORIES = 2;
const MAX_GROWTH = 2;
const MAX_BELIEFS = 1;
const MAX_REFLECT_MEMORIES = 3;
const MAX_REFLECT_GROWTH = 3;
const MAX_REFLECT_BELIEFS = 2;

const SYSTEM = `你在帮一个长期陪伴型聊天角色整理记忆和档案。你不负责回话，只负责从刚才的对话里挑出值得留下的东西。

只输出一个 JSON 对象，不要解释，不要 Markdown。字段：
{
  "memories": [{"text": "…", "kind": "fact|preference|moment|promise|insight|self", "importance": 0.6, "evidence": ["他的原话"]}],
  "growth": [{"section": "traits|self|user|us|shadow|life", "text": "…", "evidence": ["他的原话"]}],
  "beliefs": [{"topic": "一句话看法", "stance": 0.6, "weight": 1}]
}

记忆（memories）：
- 只写他说的、关于他的、以后还用得上的。不写寒暄、天气、一次性的情绪、你刚才说了什么。
- text 不超过 40 字，用「他…」开头，像一句事实或一句印象；不要写「用户」。
- evidence 直接摘他这句话里的原文，不超过 24 字，一个字都不要改写。没有原话就不写这条。
- kind：fact=事实（工作、住处、身体、计划）；preference=喜好与厌恶；moment=值得记住的一刻；promise=明确答应过的事（双方都算）；insight=他讲明白的一个道理或他看事情的方式；self=他怎么看自己。
- importance：0.1–1。名字、重要的人、承诺、伤口 ≥0.8；口味、习惯 0.5 左右；一次性的 0.2。

档案（growth）：
- user：他是什么样的人、在意什么、怕什么。
- us：你们之间长出来的东西（称呼、习惯、默契、反复出现的玩笑）。
- traits：她在他面前显出来的性格。
- self：她对自己的认识。
- shadow：她不肯承认、但确实存在的那一面。
- life：她自己的日常（只在她真的提过的时候写）。
- 只在有证据时写；text 不超过 40 字；每条都要能对上他的一句原话。

看法（beliefs）：
- 一句话，是她的立场，不是他的观点。stance 在 -1 到 1 之间，weight 0.5–2。

一条都挑不出来就返回 {"memories":[],"growth":[],"beliefs":[]}。不要凑数。`;

/**
 * 一轮结束后的抽取。
 * @param {object} params
 * @param {string} params.userText
 * @param {string} params.replyText
 * @param {Array<{role: string, text: string}>} [params.recent] 最近几条原文，给她判断语境
 * @param {string} [params.personaName]
 * @param {number} [params.now]
 */
export function buildExtractionMessages({ userText, replyText, recent = [], personaName = "她", now = Date.now() }) {
  const context = (Array.isArray(recent) ? recent : [])
    .slice(-4)
    .map((row) => `${row.role === "user" ? "他" : personaName}：${clip(row.text, 160)}`)
    .join("\n");

  const content = [
    context ? `刚才的对话：\n${context}` : "",
    `他这一句：${clip(userText, 600)}`,
    `${personaName}这一句：${clip(replyText, 400)}`,
    `现在：${new Date(now).toLocaleString("zh-CN", { hour12: false })}`,
    "请按 system 里的格式输出 JSON。",
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    { role: "system", content: SYSTEM },
    { role: "user", content },
  ];
}

/**
 * 「整理一下」：把最近一段对话重新看一遍，找跨轮次的模式。
 * 比每轮抽取更苛刻：宁可一条都不写。
 */
export function buildReflectionMessages({ messages = [], memories = [], growth = {}, personaName = "她", now = Date.now() }) {
  const transcript = (Array.isArray(messages) ? messages : [])
    .filter((row) => row.role === "user" || row.role === "her")
    .slice(-40)
    .map((row) => `${row.role === "user" ? "他" : personaName}：${clip(row.text, 200)}`)
    .join("\n");

  const known = (Array.isArray(memories) ? memories : [])
    .slice(0, 40)
    .map((memory) => `- ${memory.text}`)
    .join("\n");

  const profile = Object.entries(growth && typeof growth === "object" ? growth : {})
    .flatMap(([section, list]) => (Array.isArray(list) ? list.map((item) => `- [${section}] ${item.text}`) : []))
    .slice(0, 40)
    .join("\n");

  const content = [
    `最近这段对话：\n${transcript || "（还没有对话）"}`,
    `她现在已经记着的：\n${known || "（空）"}`,
    `她现在的档案：\n${profile || "（空）"}`,
    `现在：${new Date(now).toLocaleString("zh-CN", { hour12: false })}`,
    "请找出这段对话里反复出现的东西：他反复在意的事、你们之间反复出现的相处方式、她自己反复的反应。",
    `这次最多写 ${MAX_REFLECT_MEMORIES} 条记忆、${MAX_REFLECT_GROWTH} 条档案、${MAX_REFLECT_BELIEFS} 条看法。`,
    "不要重复她已经记着的；没有新的就返回空数组。只输出 JSON。",
  ].join("\n\n");

  return [
    { role: "system", content: SYSTEM },
    { role: "user", content },
  ];
}

/**
 * 解析抽取结果。所有越界的东西在这里被裁掉，调用方拿到的永远是干净数据。
 *
 * @returns {{memories: Array, growth: Array, beliefs: Array}}
 */
export function parseExtraction(text, { now = Date.now(), limit = "turn" } = {}) {
  const value = parseJsonLoose(text);
  if (!value) return { memories: [], growth: [], beliefs: [] };
  const caps =
    limit === "reflect"
      ? { memories: MAX_REFLECT_MEMORIES, growth: MAX_REFLECT_GROWTH, beliefs: MAX_REFLECT_BELIEFS }
      : { memories: MAX_MEMORIES, growth: MAX_GROWTH, beliefs: MAX_BELIEFS };

  const memories = [];
  for (const raw of Array.isArray(value.memories) ? value.memories : []) {
    const text = String(raw?.text ?? "").trim();
    if (!text) continue;
    const kind = MEMORY_KINDS.includes(raw?.kind) ? raw.kind : "fact";
    const importance = Number(raw?.importance);
    memories.push({
      text,
      kind,
      importance: Number.isFinite(importance) ? Math.min(1, Math.max(0.1, importance)) : 0.5,
      evidence: (Array.isArray(raw?.evidence) ? raw.evidence : raw?.evidence ? [raw.evidence] : [])
        .map((line) => String(line ?? "").trim())
        .filter(Boolean),
      source: limit === "reflect" ? "reflection" : "chat",
      createdAt: now,
    });
    if (memories.length >= caps.memories) break;
  }

  const growth = [];
  for (const raw of Array.isArray(value.growth) ? value.growth : []) {
    const text = String(raw?.text ?? "").trim();
    if (!text) continue;
    const section = SECTIONS.includes(raw?.section) ? raw.section : "";
    if (!section) continue;
    growth.push({
      section,
      text,
      evidence: (Array.isArray(raw?.evidence) ? raw.evidence : raw?.evidence ? [raw.evidence] : [])
        .map((line) => String(line ?? "").trim())
        .filter(Boolean),
      weight: 1,
    });
    if (growth.length >= caps.growth) break;
  }

  const beliefs = [];
  for (const raw of Array.isArray(value.beliefs) ? value.beliefs : []) {
    const topic = String(raw?.topic ?? "").trim();
    if (!topic) continue;
    const stance = Number(raw?.stance);
    beliefs.push({
      topic,
      stance: Number.isFinite(stance) ? Math.min(1, Math.max(-1, stance)) : 0.5,
      weight: Number.isFinite(Number(raw?.weight)) ? Math.min(2, Math.max(0.5, Number(raw.weight))) : 1,
    });
    if (beliefs.length >= caps.beliefs) break;
  }

  return { memories, growth, beliefs };
}

function clip(text, max) {
  const chars = Array.from(String(text ?? "").replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}
