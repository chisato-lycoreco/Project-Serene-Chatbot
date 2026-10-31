/**
 * src/stores/growth-store.js — 人格档案的落盘。
 *
 * 档案每变一次都留一份快照。不是不信任模型，是让「长歪了」这件事有后悔药：
 * 打开面板，看到第几天的她是什么样，点一下就退回去。
 */

import { join } from "node:path";
import { absorb, emptyGrowth, normalizeSections, stats, total } from "../growth.mjs";
import { SnapshotStore } from "../snapshots.mjs";
import { DocStore } from "./doc-store.js";

const DEFAULTS = { version: 1, sections: emptyGrowth() };

export class GrowthStore {
  constructor({ dir, seeds = null }) {
    this.dir = dir;
    this.doc = new DocStore({
      dir,
      file: "growth.json",
      defaults: DEFAULTS,
      normalize: (raw) => ({
        version: 1,
        sections: normalizeSections(raw?.sections ?? seeds ?? emptyGrowth()),
      }),
    });
    this.snapshots = new SnapshotStore({ dir, name: "growth" });
  }

  get sections() {
    return this.doc.get().sections;
  }

  /** 只有内容真的变了才写盘、才留快照。 */
  apply(items, { now = Date.now(), reason = "对话里长出来的" } = {}) {
    let sections = this.sections;
    let changed = 0;
    for (const item of Array.isArray(items) ? items : []) {
      const result = absorb(sections, item, { now });
      sections = result.sections;
      if (result.changed) changed += 1;
    }
    if (!changed) return { changed: 0, snapshot: null };
    this.doc.set({ version: 1, sections });
    const snapshot = this.snapshots.capture({ sections }, { reason, now });
    return { changed, snapshot };
  }

  /** 手动退回到某一份快照。退之前先把她现在的样子也存一份。 */
  restore(id, { now = Date.now() } = {}) {
    const payload = this.snapshots.read(id);
    if (!payload?.data?.sections) return null;
    const current = this.snapshots.capture({ sections: this.sections }, { reason: "回滚前", now });
    const sections = normalizeSections(payload.data.sections);
    this.doc.set({ version: 1, sections });
    return { sections, restoredFrom: payload, savedCurrent: current };
  }

  reset({ now = Date.now() } = {}) {
    if (total(this.sections) > 0) this.snapshots.capture({ sections: this.sections }, { reason: "重置前", now });
    this.doc.set({ version: 1, sections: emptyGrowth() });
    return this.sections;
  }

  snapshotList(limit = 20) {
    return this.snapshots.list({ limit });
  }

  stats() {
    return { sections: stats(this.sections), total: total(this.sections) };
  }
}
