/**
 * src/stores/trace-store.js — 「透视」：这一轮她为什么这么说。
 *
 * 它记录的不是日志，是一次可复盘的现场：prompt 的每一块、召回了哪几条、
 * 情绪从什么变成什么、写进去了什么、哪条风格规则没守住、花了多久。
 *
 * 只留最近 80 轮；旧的自动让位。里面没有密钥。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const KEEP = 80;

export class TraceStore {
  #dir;
  #file;
  #rows = null;

  constructor({ dir, file = "traces.jsonl" } = {}) {
    this.#dir = dir;
    this.#file = file;
  }

  get file() {
    return join(this.#dir, this.#file);
  }

  load() {
    if (this.#rows) return this;
    const rows = [];
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        const text = line.trim();
        if (!text) continue;
        try {
          const row = JSON.parse(text);
          if (row?.id) rows.push(row);
        } catch {
          // 坏行跳过。
        }
      }
    }
    this.#rows = rows.slice(-KEEP);
    return this;
  }

  add(trace) {
    this.load();
    this.#rows.push(trace);
    if (this.#rows.length > KEEP) this.#rows = this.#rows.slice(-KEEP);
    try {
      mkdirSync(this.#dir, { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(trace)}\n`, "utf8");
    } catch {
      // 透视写不进去，不该拦住聊天。
    }
    return trace;
  }

  get(id) {
    this.load();
    return this.#rows.find((row) => row.id === id) ?? null;
  }

  recent(limit = 20) {
    this.load();
    return this.#rows
      .slice(-Math.max(1, limit))
      .reverse()
      .map((row) => ({
        id: row.id,
        at: row.at,
        kind: row.kind,
        userText: row.userText,
        chars: row.reply?.chars ?? 0,
        latencyMs: row.reply?.latencyMs ?? 0,
        wrote: row.wrote ?? null,
        styleOk: row.style?.ok !== false,
      }));
  }
}
