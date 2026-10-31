/**
 * src/model.mjs — 网页版唯一一处「发出去」的 HTTP。
 *
 * 只做传输：拼请求、超时、重试、拆包、把错误翻成一句人话。
 * 业务（她该说什么）在 prompt.mjs / runtime.mjs，这样换模型不用碰人格。
 */

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * @param {object} params
 * @param {Array<{role: string, content: string}>} params.messages
 * @param {string} params.apiKey
 * @param {string} [params.model]
 * @param {string} [params.baseUrl]
 * @param {boolean} [params.json] 要一个 JSON 对象（DeepSeek 的 response_format）
 * @param {number} [params.maxTokens]
 * @param {number} [params.temperature]
 * @param {number} [params.timeoutMs]
 * @param {number} [params.retries]
 * @param {typeof fetch} [params.fetchImpl]
 * @returns {Promise<{text: string, usage: object|null, model: string, latencyMs: number}>}
 */
export async function complete({
  messages,
  apiKey,
  model,
  baseUrl = "https://api.deepseek.com",
  json = false,
  maxTokens = 360,
  temperature = 1.05,
  timeoutMs = 90_000,
  retries = 2,
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) throw new ModelError("还没有 key。先把 DeepSeek 的 API key 填进来。", "NO_KEY");
  if (!Array.isArray(messages) || messages.length === 0) throw new ModelError("没有可发的内容。", "EMPTY");

  const url = `${String(baseUrl).replace(/\/+$/, "")}/chat/completions`;
  const body = {
    model,
    messages: messages.map((message) => ({ role: message.role, content: clean(message.content) })),
    stream: false,
    max_tokens: Math.max(32, Math.min(4096, Math.round(maxTokens))),
    temperature: Math.max(0, Math.min(2, Number(temperature) || 1)),
  };
  if (json) body.response_format = { type: "json_object" };

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        const detail = await safeText(response);
        const error = new ModelError(explainStatus(response.status, detail), `HTTP_${response.status}`);
        error.status = response.status;
        if (RETRYABLE.has(response.status) && attempt < retries) {
          lastError = error;
          await sleep(500 * (attempt + 1) ** 2);
          continue;
        }
        throw error;
      }

      const payload = await response.json();
      const text = String(payload?.choices?.[0]?.message?.content ?? "").trim();
      if (!text) {
        const error = new ModelError("她这次没说出话（空回复）。可以再说一句试试。", "EMPTY_REPLY");
        if (attempt < retries) {
          lastError = error;
          await sleep(400 * (attempt + 1));
          continue;
        }
        throw error;
      }
      return {
        text,
        usage: payload?.usage ?? null,
        model: String(payload?.model ?? model ?? ""),
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof ModelError && !RETRYABLE.has(error.status)) throw error;
      const normalized = normalizeNetworkError(error, timeoutMs);
      if (attempt >= retries) throw normalized;
      lastError = normalized;
      await sleep(500 * (attempt + 1) ** 2);
    }
  }
  throw lastError ?? new ModelError("请求没发出去。", "NETWORK");
}

export class ModelError extends Error {
  constructor(message, code = "MODEL") {
    super(message);
    this.name = "ModelError";
    this.code = code;
  }
}

function normalizeNetworkError(error, timeoutMs) {
  if (error?.name === "AbortError") {
    return new ModelError(`等了 ${Math.round(timeoutMs / 1000)} 秒还没回。网络或接口可能卡住了。`, "TIMEOUT");
  }
  if (error instanceof ModelError) return error;
  const cause = error?.cause?.code || error?.code || "";
  const hint =
    cause === "ENOTFOUND" || cause === "EAI_AGAIN"
      ? "找不到 api.deepseek.com：检查一下网络或代理。"
      : cause === "ECONNREFUSED" || cause === "ECONNRESET"
        ? "连接被拒绝了：代理设置或防火墙可能挡着。"
        : "网络没通。";
  return new ModelError(hint, "NETWORK");
}

function explainStatus(status, detail) {
  const tail = String(detail ?? "").replace(/\s+/g, " ").slice(0, 160);
  if (status === 401) return "key 不对，或者已经被删了。去 platform.deepseek.com 重新建一个。";
  if (status === 402) return "账户余额不够了。";
  if (status === 403) return "这个 key 没有权限用这个模型。";
  if (status === 404) return "模型名不对。把模型改成 deepseek-chat 试试。";
  if (status === 429) return "请求太密了，等一下再发。";
  if (status >= 500) return "DeepSeek 那边出错了，再试一次通常就好。";
  return `请求失败（${status}）${tail ? `：${tail}` : ""}`;
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/** JSON 字符串里混进孤立代理项会让请求体非法，先清掉。 */
export function clean(value) {
  return String(value ?? "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

/** 从模型回包里抠 JSON：允许被 ```json 包着，也允许前后有废话。 */
export function parseJsonLoose(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const direct = tryParse(candidate);
  if (direct) return direct;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) return tryParse(candidate.slice(start, end + 1));
  return null;
}

function tryParse(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}
