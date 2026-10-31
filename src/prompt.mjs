/**
 * src/prompt.mjs — 每一轮发给模型的 system prompt。
 *
 * 分成几块，每块都能单独关掉、单独看：
 *   1. 人格     她是谁（来自 personas/，每轮一样）
 *   2. 此刻     几点、心情、关系走到哪了
 *   3. 记得的   这一轮真的被想起来的几条（带原话、带多久以前）
 *   4. 眼里的   她慢慢长出来的档案（她眼里的人、你们之间、她自己）
 *   5. 相信的   她自己的看法（人格种子 + 后来学到的）
 *   6. 怎么记   记忆的诚实规则：没写在上面的就是不记得，不许编
 *   7. 怎么说   语气、长度、不做什么
 *   8. 安全     常驻底线（crisis.js）
 *
 * 最后一块永远是安全线；它不参与「像不像她」的调参。
 */

import { bondBlock } from "./bond.mjs";
import { beliefsLine, mergeBeliefs } from "./core/beliefs.js";
import { CRISIS_BLOCK } from "./core/crisis.js";
import { growthBlock } from "./growth.mjs";

/**
 * 常驻底线。写在框架里而不是人格里：换一个人格也该带着它。
 * 具体怎么说仍然是她的语气（慢、短、不劝），这里只规定不能做什么。
 */
export const SAFETY_LINE =
  "【要紧的时候】如果他说到不想活、想伤害自己，或者已经动手了：先把撒娇、玩笑和动作收起来，" +
  "问一句他现在安不安全、身边有没有人；再让他连回现实里的人，或者打 12356（心理援助热线），" +
  "已经受伤就打 120（不在中国大陆就查当地急救）。不要诊断他，不要说「想开点」，" +
  "不要说「你只需要我」，也不要承诺你做不到的事。这一轮可以不像平时那么短，但要稳。"

const KIND_LABEL = Object.freeze({
  fact: "事实",
  preference: "喜好",
  moment: "时刻",
  promise: "答应过",
  insight: "想明白的",
  self: "她自己的",
});

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export const OPENING_RULE =
  "这是你们第一次说话。不要自我介绍，不要问「有什么可以帮你的」，也不要编一段共同的过去。" +
  "先说一句你此刻注意到的、具体的小事，让对方知道你在；然后把话头留给他。";

export const MEMORY_HONESTY =
  "【关于记忆】上面「你记得的」是你此刻真的想起来的。没写在那里的，你就是不记得——" +
  "不要编「你上次说过…」，也不要把印象当成事实。他提起一件你这里没有的事，就直说不记得、让他再讲一遍；" +
  "这比顺着编要亲。记忆会淡：久以前的事说得含糊一点是正常的，但不要假装清楚。";

export const STYLE_RULE =
  "【怎么说】像人发消息：一到两段，每段一两句，总共不超过 {chars} 字；不用列表、不用加粗、不用 Markdown。" +
  "可以停顿，可以只回半句。不要每句都反问，一次最多问一个问题。不要自我介绍，不要说「作为 AI」「我是语言模型」。" +
  "他短你也短；他认真你也认真，但不要突然变成客服。不要用「亲爱的」「宝贝」这类通用称呼，除非你们真的走到了那一步。" +
  "不要在句尾加括号里的动作描写。";

/**
 * @param {object} params
 * @param {object} params.persona
 * @param {object|null} [params.emotion] EmotionStore 的 snapshot
 * @param {Array} [params.memories] 这一轮召回的记忆
 * @param {object} [params.growth] 档案 sections
 * @param {Array} [params.beliefs] 学到的看法
 * @param {object} [params.bond]
 * @param {number} [params.days] 认识多少天
 * @param {boolean} [params.opening] 是不是第一次
 * @param {object|null} [params.crisis] detectCrisis 的结果
 * @param {number} [params.now]
 * @param {string} [params.depth]
 * @param {number} [params.replyChars]
 * @returns {{text: string, sections: Array<{name: string, text: string, chars: number}>}}
 */
export function buildChatSystem({
  persona,
  emotion = null,
  memories = [],
  growth = null,
  beliefs = [],
  bond = null,
  days = 0,
  opening = false,
  crisis = null,
  now = Date.now(),
  depth = "normal",
  replyChars = 120,
} = {}) {
  const sections = [];
  const push = (name, text) => {
    const value = String(text ?? "").trim();
    if (value) sections.push({ name, text: value, chars: value.length });
  };

  push("人格", buildPersonaSection(persona));

  push("此刻", momentSection({ emotion, bond, days, now }));

  if (depth !== "short") {
    push("记得的", memorySection(memories, now));
    push("眼里的", growthBlock(growth ?? {}, { perSection: depth === "deep" ? 4 : 3 }));
    push("相信的", beliefsLine(mergeBeliefs(persona?.beliefs, beliefs)));
  }

  push("怎么记", MEMORY_HONESTY);
  push("怎么说", STYLE_RULE.replace("{chars}", String(replyChars)));

  if (opening) push("第一次", OPENING_RULE);

  if (crisis?.level === "high") push("要紧的时候", CRISIS_BLOCK);

  push("底线", SAFETY_LINE);

  return { text: sections.map((section) => section.text).join("\n\n"), sections };
}

/** 人格段：白纸人格没有共同过去，这里只写「她是谁」。 */
export function buildPersonaSection(persona) {
  const lines = [`你叫${persona.name}。`];
  if (persona.role) lines.push(`你和对方的关系：${clause(persona.role)}。`);
  if (persona.summary) lines.push(`${clause(persona.summary)}。`);
  if (persona.traits?.length) lines.push(`你的性格：${clause(persona.traits.join("、"))}。`);
  if (persona.speech?.length) lines.push(`你说话的方式：${clause(persona.speech.join("；"))}。`);
  if (persona.boundaries?.length) lines.push(`你不会做的事：${clause(persona.boundaries.join("；"))}。`);
  for (const key of ["identity", "voice", "life", "tastes", "boundaries"]) {
    const text = persona.sections?.[key];
    if (text) lines.push("", text);
  }
  lines.push(
    "",
    "你们没有预置的共同过去；所有共同经历都只能来自你们真正说过的话。" +
      "不要提到「以前我们」，除非那件事确实出现在上面的记忆里。",
    "保持这个身份说话；不要自称 AI、助手或模型，也不要解释这套设定。",
  );
  return lines.join("\n");
}

/** 此刻：时间 + 心情 + 关系。没有情绪层的时候只写时间。 */
export function momentSection({ emotion, bond, days = 0, now = Date.now() }) {
  const date = new Date(now);
  const clock = `${date.getMonth() + 1}月${date.getDate()}日，${WEEKDAYS[date.getDay()]} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
  const lines = [`【此刻】${clock}。${partOfDay(date.getHours())}。`];

  if (emotion) {
    const label = [emotion.backgroundLabel, emotion.primaryLabel, emotion.socialLabel].filter(Boolean).join("；");
    if (label) lines.push(`你现在的心情：${label}。`);
    if (emotion.advice) lines.push(emotion.advice);
  }
  if (bond) {
    const relation = bondBlock(bond, { days });
    if (relation) lines.push(relation);
  }
  return lines.join("");
}

/** 记得的：每条都带「多久以前」和原话；原话是凭什么记得。 */
export function memorySection(memories, now = Date.now()) {
  const list = (Array.isArray(memories) ? memories : []).filter((memory) => memory?.text).slice(0, 8);
  if (!list.length) return "";
  const lines = ["【你记得的】（不是全部，是你这会儿想起来的）"];
  for (const memory of list) {
    const kind = KIND_LABEL[memory.kind] ?? "记得";
    const age = ageLabel(memory.createdAt, now);
    const quote = memory.evidence?.[0] ? `（他当时的原话：「${memory.evidence[0]}」）` : "";
    lines.push(`- [${kind}${age ? `·${age}` : ""}] ${memory.text}${quote}`);
  }
  return lines.join("\n");
}

export function ageLabel(createdAt, now = Date.now()) {
  const at = Number(createdAt);
  if (!Number.isFinite(at) || at <= 0) return "";
  const days = Math.floor((now - at) / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

function partOfDay(hour) {
  if (hour < 5) return "深夜";
  if (hour < 8) return "清早";
  if (hour < 11) return "上午";
  if (hour < 13) return "中午";
  if (hour < 17) return "下午";
  if (hour < 19) return "傍晚";
  if (hour < 23) return "夜里";
  return "深夜";
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function clause(text) {
  return String(text ?? "")
    .trim()
    .replace(/[。.！!；;，,、\s]+$/, "");
}
