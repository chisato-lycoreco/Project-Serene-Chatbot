/**
 * src/stores/bond-store.js — 关系四条轴的落盘。
 */

import { driftBond, initialBond, normalizeBond, updateBond } from "../bond.mjs";
import { DocStore } from "./doc-store.js";

export class BondStore {
  constructor({ dir }) {
    this.doc = new DocStore({
      dir,
      file: "bond.json",
      defaults: initialBond(),
      normalize: (raw) => normalizeBond(raw),
    });
  }

  get bond() {
    return this.doc.get();
  }

  record(kind, { now = Date.now() } = {}) {
    const result = updateBond(this.bond, kind, { now });
    if (Object.keys(result.deltas).length) this.doc.set(result.bond);
    return result;
  }

  drift({ now = Date.now(), idleDays = 0 } = {}) {
    const result = driftBond(this.bond, { now, idleDays });
    if (Object.keys(result.deltas).length) this.doc.set(result.bond);
    return result;
  }

  reset({ now = Date.now() } = {}) {
    return this.doc.set(initialBond(now));
  }
}
