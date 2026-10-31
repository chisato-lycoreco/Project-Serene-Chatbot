/**
 * src/snapshots.mjs — 档案的时光机。
 *
 * 人格档案每长一条，就存一份当时的全文。不为了审计，为了「反悔」：
 * 模型把她写成另一个人、或者你自己手动改坏了，可以退回去。
 *
 * 文件是普通 JSON，放在 data/snapshots/<档案名>/ 下，可以直接打开看。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class SnapshotStore {
  /**
   * @param {object} options
   * @param {string} options.dir 数据目录
   * @param {string} options.name 档案名（growth / beliefs / …）
   * @param {number} [options.keep] 最多留几份
   */
  constructor({ dir, name, keep = 30 }) {
    this.dir = join(dir, "snapshots", name);
    this.name = name;
    this.keep = Math.max(3, Number(keep) || 30);
    this.seq = 0;
  }

  /**
   * 存一份。
   * @param {object} data 要完整保存的内容
   * @param {string} [reason] 为什么变（写给人看的一句话）
   * @param {number} [now]
   */
  capture(data, { reason = "", now = Date.now() } = {}) {
    mkdirSync(this.dir, { recursive: true });
    const id = `${now.toString(36)}-${(this.seq++).toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const payload = { id, at: now, reason: String(reason).slice(0, 80), data };
    writeFileSync(join(this.dir, `${id}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    this.#prune();
    return { id, at: now, reason: payload.reason };
  }

  /** 新到旧。 */
  list({ limit = 30 } = {}) {
    if (!existsSync(this.dir)) return [];
    const rows = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      const payload = this.#read(name);
      if (!payload) continue;
      rows.push({
        id: payload.id,
        at: payload.at,
        reason: payload.reason,
        count: countItems(payload.data),
      });
    }
    return rows.sort((a, b) => b.at - a.at).slice(0, Math.max(1, limit));
  }

  read(id) {
    const safe = String(id ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safe) return null;
    return this.#read(`${safe}.json`);
  }

  /* ───────────────────────── 内部 ───────────────────────── */

  #read(name) {
    try {
      const payload = JSON.parse(readFileSync(join(this.dir, name), "utf8"));
      return payload && payload.id ? payload : null;
    } catch {
      return null;
    }
  }

  #prune() {
    const rows = this.list({ limit: 10_000 });
    for (const row of rows.slice(this.keep)) {
      try {
        unlinkSync(join(this.dir, `${row.id}.json`));
      } catch {
        // 删不掉就留着，不影响读。
      }
    }
  }
}

function countItems(data) {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === "object") {
    let count = 0;
    for (const value of Object.values(data)) {
      if (Array.isArray(value)) count += value.length;
      else if (value && typeof value === "object") count += countItems(value);
    }
    return count;
  }
  return 0;
}
