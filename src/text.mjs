/**
 * src/text.mjs — 把模型吐的一段话拆成「消息气泡」。
 *
 * 聊天不是写文章：一条太长的回复，读起来像客服。她一次只说一两句，
 * 换行就是换一口气。这里只做拆句，不改写内容。
 */

/** 去掉模型偶尔带出来的「知遥：」前缀和首尾引号。 */
export function cleanReply(text, { name = "" } = {}) {
  let value = String(text ?? "").trim();
  if (!value) return "";
  if (name) {
    const prefix = new RegExp(`^\\s*${escapeRegExp(name)}\\s*[：:]\\s*`);
    value = value.replace(prefix, "");
  }
  value = value.replace(/^["“「]([\s\S]*)["”」]$/, "$1").trim();
  return value;
}

/**
 * @param {string} text
 * @param {{max?: number}} [options]
 * @returns {string[]}
 */
export function splitBubbles(text, { max = 2 } = {}) {
  const value = String(text ?? "").trim();
  if (!value) return [];
  const parts = value
    .split(/\n{2,}|\n/)
    .map((part) => part.trim().replace(/^[-*•·]\s+/, ""))
    .filter(Boolean);
  if (!parts.length) return [];
  if (parts.length <= max) return parts;
  // 超了就合并中间几条，而不是丢掉：丢掉的可能是最要紧的那句。
  const head = parts.slice(0, max - 1);
  const tail = parts.slice(max - 1).join("\n");
  return [...head, tail];
}

export function truncate(text, max) {
  const chars = Array.from(String(text ?? ""));
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
