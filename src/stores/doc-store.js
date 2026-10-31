/**
 * 一份 JSON 文档的读写：原子写，读坏了退回默认值。
 *
 * 看法、用户模型、天气、夜里的自省都只有一小份状态，没必要各写一遍落盘代码。
 * 这里只做「读一次、改一次、写一次」，不做业务判断——业务判断都在 core/ 的纯函数里。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export class DocStore {
  constructor({ dir, file, defaults = {}, normalize = (value) => value }) {
    this.dir = dir;
    this.file = file;
    this.path = join(dir, file);
    this.defaults = defaults;
    this.normalize = normalize;
    this.state = null;
  }

  load() {
    if (this.state) return this.state;
    let raw = null;
    try {
      raw = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : null;
    } catch {
      raw = null;
    }
    this.state = this.normalize(raw ?? this.defaults);
    return this.state;
  }

  get() {
    return this.load();
  }

  set(next) {
    this.state = this.normalize(next);
    this.save();
    return this.state;
  }

  update(fn) {
    return this.set(fn(this.load()));
  }

  save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
      renameSync(temp, this.path);
      return true;
    } catch {
      return false;
    }
  }

  reset() {
    this.state = this.normalize(this.defaults);
    this.save();
    return this.state;
  }
}
