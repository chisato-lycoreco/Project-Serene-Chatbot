/**
 * 看法落盘：`beliefs.json`。
 *
 * 只存「后来学到的」；人格种子在 persona.json 里，每次读的时候和这里合起来，
 * 所以换人格不会把上一个人的看法带过去。
 */

import { applyEvidence, normalizeBeliefs } from "../core/beliefs.js";
import { DocStore } from "./doc-store.js";

const DEFAULTS = { version: 1, beliefs: [] };

export class BeliefStore {
  constructor({ dir }) {
    this.doc = new DocStore({
      dir,
      file: "beliefs.json",
      defaults: DEFAULTS,
      normalize: (raw) => ({ version: 1, beliefs: normalizeBeliefs(raw?.beliefs) }),
    });
  }

  get beliefs() {
    return this.doc.get().beliefs;
  }

  record(input) {
    const result = applyEvidence(this.beliefs, input);
    if (result.changed) this.doc.set({ version: 1, beliefs: result.beliefs });
    return result;
  }

  reset() {
    return this.doc.reset();
  }
}
