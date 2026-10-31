/**
 * src/stores/memory-store.js — 长期记忆的落盘、去重与召回。
 *
 * 存储是「一行一条 JSON」的追加日志（jsonl）：写入永远只往后加，
 * 不改历史行。改一条、忘一条、合并两条，都会再记一行。
 * 好处是进程被杀也不会留下半截 JSON，而且「她忘了什么」和「她记得什么」一样可查。
 *
 * 行类型：
 *   { id, text, kind, … }                       一条记忆
 *   { type:"reinforce", id, … }                 被想起了一次
 *   { type:"patch", id, text?/importance?/… }   手动改过
 *   { type:"merge", id, … }                     抽取出来和旧记忆重复，合并
 *   { type:"forget", id, at, reason }           忘了（容量 / 手动 / 归档）
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MEMORY_CAPACITY,
  MAX_TEXT_CHARS,
  activate,
  normalizeMemory,
  rank,
  reinforce as reinforceMemory,
  retention,
  tokenize,
} from "../core/recall.js";

/** 两条记忆说到同一件事的阈值。真实对话里 0.8 以上基本是同一句。 */
export const MERGE_AT = 0.8;

export class MemoryStore {
  #dir;
  #file;
  #cap;
  #curve;
  #anchorMode;
  #items = null;
  #index = new Map();
  #forgotten = [];

  constructor({
    dir,
    file = "memories.jsonl",
    capacity = MEMORY_CAPACITY,
    curve = "v2",
    anchorMode = process.env.SERENE_MEMORY_ANCHORS,
  } = {}) {
    if (!dir) throw new Error("MemoryStore 需要一个数据目录");
    this.#dir = dir;
    this.#file = file;
    this.#cap = Math.max(10, Number(capacity) || MEMORY_CAPACITY);
    this.#curve = curve === "v1" ? "v1" : "v2";
    this.#anchorMode = anchorMode;
  }

  get file() {
    return join(this.#dir, this.#file);
  }

  get capacity() {
    return this.#cap;
  }

  load() {
    if (this.#items) return this;
    const items = [];
    const index = new Map();
    const forgotten = [];
    this.#forgotten = forgotten;
    this.#index = index;
    this.#items = items;

    if (!existsSync(this.file)) return this;
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      const text = line.trim();
      if (!text) continue;
      let row;
      try {
        row = JSON.parse(text);
      } catch {
        // 半截行（进程被杀、磁盘满）直接跳过，不让一条坏记忆拖垮整个文件。
        continue;
      }
      if (!row || typeof row !== "object") continue;

      if (row.type === "forget") {
        forgotten.push(row);
        const victim = index.get(row.id);
        if (victim) {
          index.delete(row.id);
          const at = items.indexOf(victim);
          if (at >= 0) items.splice(at, 1);
        }
        continue;
      }
      if (row.type === "reinforce") {
        const memory = index.get(row.id);
        if (memory) Object.assign(memory, foldPatch(memory, row));
        continue;
      }
      if (row.type === "patch" || row.type === "merge") {
        const memory = index.get(row.id);
        if (memory) Object.assign(memory, foldEdit(memory, row));
        continue;
      }
      if (!row.id || !row.text) continue;
      // 老数据可能超过 80 字：读回时原样保留，不替用户改写历史。
      const memory = normalizeMemory(row, { now: Number(row.createdAt) || Date.now(), maxChars: Infinity });
      if (!memory || index.has(memory.id)) continue;
      items.push(memory);
      index.set(memory.id, memory);
    }
    return this;
  }

  /**
   * 写一条记忆。和已有记忆说到同一件事时合并，而不是并排躺着两条。
   *
   * @returns {{memory: object, merged: boolean}|null}
   */
  add(input, { now = Date.now() } = {}) {
    this.load();
    const memory = normalizeMemory(input, { now, maxChars: MAX_TEXT_CHARS });
    if (!memory) return null;

    const twin = this.#findTwin(memory);
    if (twin) {
      const merged = mergeMemory(twin, memory, now);
      Object.assign(twin, merged);
      appendFileSync(this.file, `${JSON.stringify({ type: "merge", ...merged })}\n`, "utf8");
      this.#reinforceOne(twin, now);
      return { memory: twin, merged: true };
    }

    this.#makeRoom(now);
    mkdirSync(this.#dir, { recursive: true });
    let id = memory.id;
    let suffix = 1;
    while (this.#index.has(id)) {
      suffix += 1;
      id = `${memory.id}_${suffix}`;
    }
    memory.id = id;
    appendFileSync(this.file, `${JSON.stringify(memory)}\n`, "utf8");
    this.#items.push(memory);
    this.#index.set(id, memory);
    return { memory, merged: false };
  }

  /** 召回。v2 允许空数组——这一轮没有相关的事，比硬塞两条无关的更像人。 */
  recall(query, { limit = 5, now = Date.now(), mood = 0, halfLifeDays = 45 } = {}) {
    this.load();
    const active = this.#items.filter((memory) => !memory.archived && !isExpired(memory, now));
    if (this.#curve === "v1") return rank(active, query, { limit, now, halfLifeDays });
    return activate(active, query, { limit, now, mood, anchorMode: this.#anchorMode });
  }

  /** 记「这几条真的被用上了」。只有确实进了回复才该调。 */
  reinforce(ids, { now = Date.now() } = {}) {
    this.load();
    const wanted = new Set((Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean));
    const touched = [];
    for (const id of wanted) {
      const memory = this.#index.get(id);
      if (!memory) continue;
      touched.push(this.#reinforceOne(memory, now));
    }
    return touched;
  }

  /**
   * 手动改一条：text / kind / importance / pinned / archived。
   * 只允许这几个字段，避免把 id、createdAt 这种账本字段改坏。
   */
  update(id, patch = {}, { now = Date.now() } = {}) {
    this.load();
    const memory = this.#index.get(String(id));
    if (!memory) return null;
    const next = foldEdit(memory, patch);
    Object.assign(memory, next);
    appendFileSync(this.file, `${JSON.stringify({ type: "patch", id: memory.id, at: now, ...next })}\n`, "utf8");
    return memory;
  }

  /** 忘掉一条。不是静默删除：文件末尾留一行 forget，面板里能看到忘了什么。 */
  forget(id, { now = Date.now(), reason = "manual" } = {}) {
    this.load();
    const memory = this.#index.get(String(id));
    if (!memory) return null;
    const record = { type: "forget", id: memory.id, at: now, kind: memory.kind, text: memory.text, reason };
    appendFileSync(this.file, `${JSON.stringify(record)}\n`, "utf8");
    this.#forgotten.push(record);
    this.#index.delete(memory.id);
    this.#items = this.#items.filter((item) => item !== memory);
    return record;
  }

  /** 把早于某个时间点的记忆收进档案：不参与召回，但仍然可查。 */
  archiveBefore(ts, { now = Date.now() } = {}) {
    this.load();
    const touched = [];
    for (const memory of [...this.#items]) {
      if (memory.archived || memory.pinned) continue;
      if (Number(memory.createdAt) >= ts) continue;
      this.update(memory.id, { archived: true }, { now });
      touched.push(memory.id);
    }
    return touched;
  }

  forgotten({ limit = 10 } = {}) {
    this.load();
    return this.#forgotten.slice(-Math.max(1, limit)).reverse();
  }

  all() {
    this.load();
    return this.#items;
  }

  get size() {
    this.load();
    return this.#items.length;
  }

  stats({ now = Date.now() } = {}) {
    this.load();
    const kinds = {};
    let stability = 0;
    let archived = 0;
    let active = 0;
    for (const memory of this.#items) {
      if (memory.archived) {
        archived += 1;
        continue;
      }
      active += 1;
      kinds[memory.kind] = (kinds[memory.kind] ?? 0) + 1;
      stability += Number(memory.stability) || 0;
    }
    return {
      size: active,
      archived,
      capacity: this.#cap,
      curve: this.#curve,
      kinds,
      forgotten: this.#forgotten.length,
      averageStability: active ? Math.round((stability / active) * 10) / 10 : 0,
      averageRetention: active
        ? Math.round(
            (this.#items
              .filter((memory) => !memory.archived)
              .reduce((sum, memory) => sum + retention(memory, now), 0) /
              active) *
              1000,
          ) / 1000
        : 0,
    };
  }

  /* ───────────────────────── 内部 ───────────────────────── */

  #findTwin(incoming) {
    for (const memory of this.#items) {
      if (memory.archived) continue;
      if (memory.kind !== incoming.kind) continue;
      if (similarity(memory.text, incoming.text) >= MERGE_AT) return memory;
    }
    return null;
  }

  #reinforceOne(memory, now) {
    const patch = { ...reinforceMemory(memory, { now }), at: now };
    Object.assign(memory, foldPatch(memory, patch));
    appendFileSync(this.file, `${JSON.stringify({ type: "reinforce", ...patch })}\n`, "utf8");
    return patch;
  }

  /** 容量管理：腾一个位置出来。过期的先走，然后 重要度 × 保持率 最低的。 */
  #makeRoom(now) {
    if (this.#items.length < this.#cap) return;
    let victim = null;
    let victimScore = Infinity;
    for (const memory of this.#items) {
      if (memory.pinned) continue;
      const expired = isExpired(memory, now);
      const score = (expired ? -1 : 0) + Number(memory.importance ?? 0.5) * retention(memory, now);
      if (score < victimScore) {
        victim = memory;
        victimScore = score;
      }
    }
    if (!victim) return;
    const record = {
      type: "forget",
      id: victim.id,
      at: now,
      kind: victim.kind,
      text: victim.text,
      reason: isExpired(victim, now) ? "expired" : "capacity",
    };
    appendFileSync(this.file, `${JSON.stringify(record)}\n`, "utf8");
    this.#forgotten.push(record);
    this.#index.delete(victim.id);
    this.#items = this.#items.filter((item) => item !== victim);
  }
}

/* ───────────────────────── 纯函数 ───────────────────────── */

/** 两句话的 Jaccard 相似度：中文按二元组、英文按词，够用且可解释。 */
export function similarity(a, b) {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (!left.size || !right.size) return 0;
  let hit = 0;
  for (const token of left) if (right.has(token)) hit += 1;
  return hit / (left.size + right.size - hit);
}

function mergeMemory(existing, incoming, now) {
  const longer =
    Array.from(incoming.text).length > Array.from(existing.text).length ? incoming.text : existing.text;
  return {
    id: existing.id,
    text: Array.from(longer).slice(0, MAX_TEXT_CHARS).join(""),
    evidence: [...new Set([...(existing.evidence ?? []), ...(incoming.evidence ?? [])])].slice(0, 3),
    importance: Math.max(Number(existing.importance) || 0, Number(incoming.importance) || 0),
    updatedAt: now,
    at: now,
  };
}

function foldPatch(memory, patch) {
  return {
    stability: Number(patch.stability) || memory.stability,
    lastRecall: Number(patch.lastRecall) || memory.lastRecall,
    recallCount: Math.max(Number(patch.recallCount) || 0, memory.recallCount),
  };
}

function foldEdit(memory, patch) {
  const next = {};
  if (typeof patch.text === "string" && patch.text.trim()) {
    next.text = Array.from(patch.text.trim()).slice(0, MAX_TEXT_CHARS).join("");
    next.updatedAt = Number(patch.at) || Date.now();
  }
  if (["fact", "preference", "moment", "promise", "insight", "self"].includes(patch.kind)) next.kind = patch.kind;
  if (Number.isFinite(Number(patch.importance))) next.importance = Math.min(1, Math.max(0, Number(patch.importance)));
  if (Array.isArray(patch.evidence)) {
    next.evidence = patch.evidence.map((line) => String(line).trim()).filter(Boolean).slice(0, 3);
  }
  if (typeof patch.pinned === "boolean") next.pinned = patch.pinned;
  if (typeof patch.archived === "boolean") next.archived = patch.archived;
  return next;
}

function isExpired(memory, now) {
  return Number(memory.validUntil) > 0 && Number(memory.validUntil) < now;
}
