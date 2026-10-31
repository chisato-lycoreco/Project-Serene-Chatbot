/**
 * core/style.js — 表达检查（纯函数）
 *
 * 这一层不生成话，只回答一个问题：**这句话像不像她说的**。
 *
 * 人格决定她说什么，情绪决定语气；但「像不像」有几条和人格无关的硬规则——
 * 不列点、不自称助手、不一次问三个问题、不拿通用的甜话糊弄。
 * 这些都是可以当场查出来的，不需要模型自己判断。
 *
 * 和别处一样：不落盘、不调模型、不看时间；同样的输入永远同样的输出。
 */

/** 一句话最多多长（按字符）。超过就该断句了。 */
export const MAX_CHARS = 120;
/** 一次回复最多几个句子。 */
export const MAX_SENTENCES = 4;
/** 一次回复最多几个问号。 */
export const MAX_QUESTIONS = 1;

const LIST_LINE = /^\s*(?:[-*•·]|\d+[.、)]|[（(]\d+[）)])\s+/;
const ASSISTANT = /作为一个\s*(?:AI|人工智能|语言模型|助手)|我可以帮(?:你|您)|有什么可以帮(?:你|您)|需要我帮你/;
const SELF_EXPLAIN = /我的(?:设定|人设|提示词|prompt)|我是(?:一个|一名)?\s*(?:AI|人工智能|语言模型|程序|助手)/i;
const ENDEARMENT = /亲爱的|宝贝|小可爱|老公|老婆/;
const QUESTION = /[？?]/;

/**
 * @param {string} text 她准备发出去的话
 * @param {object} [options]
 * @param {number} [options.maxChars]
 * @param {number} [options.maxSentences]
 * @param {number} [options.maxQuestions]
 * @returns {{ok: boolean, issues: Array<{code: string, message: string}>}}
 */
export function checkStyle(text, options = {}) {
  const maxChars = positive(options.maxChars, MAX_CHARS);
  const maxSentences = positive(options.maxSentences, MAX_SENTENCES);
  const maxQuestions = positive(options.maxQuestions, MAX_QUESTIONS);
  const value = String(text ?? "").trim();
  const issues = [];

  if (!value) {
    return { ok: false, issues: [{ code: "empty", message: "没有内容。要么说一句，要么别说。" }] };
  }

  const lines = value.split(/\r?\n/);
  if (lines.filter((line) => LIST_LINE.test(line)).length >= 1 || /^\s*(?:[-*•·]|\d+[.、)])/m.test(value)) {
    issues.push({ code: "list", message: "列点了。把要点说成一句话，不要编号。" });
  }

  if (ASSISTANT.test(value)) {
    issues.push({ code: "assistant", message: "自称助手 / 主动提供帮助了。你不是客服。" });
  }

  if (SELF_EXPLAIN.test(value)) {
    issues.push({ code: "self-explain", message: "在解释自己的设定。不要解释，直接说话。" });
  }

  if (ENDEARMENT.test(value)) {
    issues.push({ code: "endearment", message: "用了通用的甜话。亲昵要具体，具体到一件记得的事。" });
  }

  if (value.length > maxChars) {
    issues.push({ code: "too-long", message: `太长了（${value.length} 字）。一次只说一到两句。` });
  }

  const sentences = value.split(/[。！？!?…]+/).map((part) => part.trim()).filter(Boolean);
  if (sentences.length > maxSentences) {
    issues.push({ code: "too-many-sentences", message: `一口气说了 ${sentences.length} 句。留一点给对方。` });
  }

  const questions = value.split(QUESTION).length - 1;
  if (questions > maxQuestions) {
    issues.push({ code: "too-many-questions", message: `问了 ${questions} 个问题。想接话就接，别把话头推回去。` });
  }

  return { ok: issues.length === 0, issues };
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
