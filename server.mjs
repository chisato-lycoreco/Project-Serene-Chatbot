/**
 * server.mjs — 一个文件的服务端，没有框架、没有构建。
 *
 * 只做三件事：发静态文件、把 /api 转给 runtime、把错误翻成一句人话。
 * 业务全在 src/ 里；这个文件不认人格，也不碰记忆。
 */

import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { HttpError, SereneRuntime } from "./src/runtime.mjs";
import { ModelError } from "./src/model.mjs";
import { ROOT, VERSION, loadEnvFile } from "./src/config.mjs";

loadEnvFile();

const PORT = Number(process.env.SERENE_PORT) || 4310;
const HOST = process.env.SERENE_HOST || "127.0.0.1";
const DEMO = process.argv.includes("--demo") || process.env.SERENE_DEMO === "1";
const PUBLIC = join(ROOT, "public");
const BODY_LIMIT = 1_000_000;

const runtime = new SereneRuntime({ demo: DEMO });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const server = createServer(async (request, response) => {
  const startedAt = Date.now();
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await api(request, response, url);
    } else {
      await staticFile(response, url.pathname);
    }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : error instanceof ModelError ? modelStatus(error) : 500;
    const message =
      error instanceof HttpError || error instanceof ModelError
        ? error.message
        : `服务端出了点问题：${error instanceof Error ? error.message : String(error)}`;
    const code = error instanceof HttpError || error instanceof ModelError ? error.code : "INTERNAL";
    if (status >= 500) console.error(`[${new Date().toISOString()}] ${request.method} ${url.pathname}`, error);
    sendJson(response, status, { error: { message, code } });
  } finally {
    const ms = Date.now() - startedAt;
    console.log(`${request.method} ${url.pathname} ${response.statusCode} ${ms}ms`);
  }
});

/* ───────────────────────── /api ───────────────────────── */

async function api(request, response, url) {
  const method = request.method ?? "GET";
  const path = url.pathname;
  const parts = path.split("/").filter(Boolean); // ["api", ...]

  if (method === "GET" && path === "/api/health") {
    return sendJson(response, 200, { ok: true, version: VERSION, demo: DEMO });
  }

  if (method === "GET" && path === "/api/state") {
    return sendJson(response, 200, runtime.state());
  }

  if (method === "GET" && path === "/api/timeline") {
    return sendJson(response, 200, runtime.timeline());
  }

  if (method === "GET" && path === "/api/memories") {
    const result = runtime.listMemories({
      q: url.searchParams.get("q") ?? "",
      kind: url.searchParams.get("kind") ?? "",
      archived: url.searchParams.get("archived") === "1",
    });
    return sendJson(response, 200, result);
  }

  if (method === "POST" && path === "/api/memories") {
    const body = await readJson(request);
    return sendJson(response, 200, runtime.addMemory(body));
  }

  if (parts[1] === "memories" && parts.length === 3 && (method === "PATCH" || method === "DELETE")) {
    const id = decodeURIComponent(parts[2]);
    if (method === "DELETE") return sendJson(response, 200, runtime.forgetMemory(id));
    const body = await readJson(request);
    return sendJson(response, 200, runtime.updateMemory(id, body));
  }

  if (method === "GET" && path === "/api/growth") {
    return sendJson(response, 200, runtime.growthState());
  }

  if (method === "POST" && path === "/api/growth/restore") {
    const body = await readJson(request);
    return sendJson(response, 200, runtime.restoreGrowth(String(body.id ?? "")));
  }

  if (method === "POST" && path === "/api/growth/reset") {
    return sendJson(response, 200, runtime.resetGrowth());
  }

  if (method === "POST" && path === "/api/open") {
    return sendJson(response, 200, await runtime.openFirst());
  }

  if (method === "POST" && path === "/api/chat") {
    const body = await readJson(request);
    return sendJson(response, 200, await runtime.chatOnce(body.text));
  }

  if (method === "POST" && path === "/api/reflect") {
    return sendJson(response, 200, await runtime.reflect());
  }

  if (method === "GET" && path === "/api/traces") {
    return sendJson(response, 200, { items: runtime.traceList(30) });
  }

  if (method === "GET" && parts[1] === "traces" && parts.length === 3) {
    return sendJson(response, 200, runtime.getTrace(decodeURIComponent(parts[2])));
  }

  if (method === "GET" && path === "/api/search") {
    const q = url.searchParams.get("q") ?? "";
    return sendJson(response, 200, { items: runtime.chat.search(q, { limit: 30 }) });
  }

  if (method === "PUT" && path === "/api/settings") {
    const body = await readJson(request);
    return sendJson(response, 200, { settings: runtime.updateSettings(body) });
  }

  if (method === "GET" && path === "/api/export") {
    const payload = runtime.exportAll();
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="serene-${new Date().toISOString().slice(0, 10)}.json"`,
    });
    return response.end(`${JSON.stringify(payload, null, 2)}\n`);
  }

  if (method === "POST" && path === "/api/reset") {
    const body = await readJson(request);
    return sendJson(response, 200, runtime.reset(String(body.scope ?? "chat")));
  }

  throw new HttpError(404, `没有这个接口：${method} ${path}`, "NO_ROUTE");
}

/* ───────────────────────── 静态文件 ───────────────────────── */

async function staticFile(response, pathname) {
  const clean = decodeURIComponent(pathname);
  const target = resolve(join(PUBLIC, normalize(clean)));
  if (target !== PUBLIC && !target.startsWith(`${PUBLIC}${sep}`)) throw new HttpError(403, "不许出去。", "FORBIDDEN");
  const file = existsSync(target) && statSync(target).isFile() ? target : join(PUBLIC, "index.html");
  if (!existsSync(file)) throw new HttpError(404, "页面还没生成。", "NO_FILE");
  response.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-cache",
  });
  response.end(readFileSync(file));
}

/* ───────────────────────── 工具 ───────────────────────── */

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((done, fail) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        fail(new HttpError(413, "发的东西太大了。", "TOO_LARGE"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return done({});
      try {
        const value = JSON.parse(text);
        done(value && typeof value === "object" ? value : {});
      } catch {
        fail(new HttpError(400, "请求体不是合法 JSON。", "BAD_JSON"));
      }
    });
    request.on("error", fail);
  });
}

function modelStatus(error) {
  if (["NO_KEY", "EMPTY", "BAD_KEY"].includes(error.code)) return 400;
  if (error.status === 401 || error.status === 402) return 502;
  return 502;
}

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log("");
  console.log(`  Project-Serene-Chatbot v${VERSION}`);
  console.log(`  ${DEMO ? "demo 模式（不调用模型，预置回话）" : "模型：DeepSeek"}`);
  console.log(`  ${url}`);
  console.log("");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log("\n收工。记忆已经落盘。");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
