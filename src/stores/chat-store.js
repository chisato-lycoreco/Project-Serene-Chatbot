/**
 * src/stores/chat-store.js — 对话记录。
 *
 * 一行一条，追加写。它只是「说过什么」的账本，不是记忆：
 * 记忆是提炼过的，聊天记录是原文。原话用来做两件事——
 * 一是给记忆当证据，二是让她能被问「你上次到底怎么说的」。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const MAX_TEXT = 4000;

export class ChatStore {
  #dir;
  #file;
  #items = null;

  constructor({ dir, file = "chat.jsonl" } = {}) {
    if (!dir) throw new Error("ChatStore 需要一个数据目录");
    this.#dir = dir;
    this.#file = file;
  }

  get file() {
    return join(this.#dir, this.#file);
  }

  load() {
    if (this.#items) return this;
    const items = [];
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        const text = line.trim();
        if (!text) continue;
        try {
          const row = JSON.parse(text);
          if (row?.id && row?.role && typeof row.text === "string") items.push(row);
        } catch {
          // 坏行跳过。
        }
      }
    }
    this.#items = items;
    return this;
  }

  append(message, { now = Date.now() } = {}) {
    this.load();
    const row = {
      id: String(message.id ?? `c_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`),
      role: message.role === "her" || message.role === "note" ? message.role : "user",
      text: Array.from(String(message.text ?? "")).slice(0, MAX_TEXT).join(""),
      at: Number(message.at) || now,
      kind: String(message.kind ?? "say"),
      ...(message.replyTo ? { replyTo: String(message.replyTo) } : {}),
    };
    if (!row.text.trim()) return null;
    mkdirSync(this.#dir, { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(row)}\n`, "utf8");
    this.#items.push(row);
    return row;
  }

  all() {
    this.load();
    return this.#items;
  }

  recent(limit = 40) {
    this.load();
    return this.#items.slice(-Math.max(1, limit));
  }

  /** 给模型的历史：她的话、他的话；note 这类旁白不进历史。 */
  history(limit = 18) {
    this.load();
    return this.#items
      .filter((row) => row.role === "user" || row.role === "her")
      .slice(-Math.max(1, limit))
      .map((row) => ({ role: row.role === "user" ? "user" : "assistant", content: row.text }));
  }

  search(query, { limit = 20 } = {}) {
    this.load();
    const needle = String(query ?? "").trim().toLowerCase();
    if (!needle) return [];
    return this.#items
      .filter((row) => row.role !== "note" && row.text.toLowerCase().includes(needle))
      .slice(-Math.max(1, limit))
      .reverse();
  }

  get count() {
    this.load();
    return this.#items.filter((row) => row.role === "user").length;
  }

  span() {
    this.load();
    const rows = this.#items.filter((row) => row.role !== "note");
    if (!rows.length) return { first: 0, last: 0 };
    return { first: Number(rows[0].at) || 0, last: Number(rows[rows.length - 1].at) || 0 };
  }

  /** 清空对话：不真删，改个名归档。记忆不动。 */
  clear({ now = Date.now() } = {}) {
    this.load();
    if (existsSync(this.file)) {
      try {
        renameSync(this.file, `${this.file}.${now}.bak`);
      } catch {
        // 改不了名就留着，下次启动照常读旧的。
      }
    }
    this.#items = [];
    return this.file;
  }
}
