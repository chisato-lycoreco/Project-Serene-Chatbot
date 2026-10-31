/**
 * scripts/check.mjs — 不跑测试，只确认每个 JS 文件语法没坏。
 *
 * 为什么不用 glob：Node 的 `--check` 一次只吃一个文件，而 Windows 的 shell 不展开通配符。
 * 这里递归走一遍仓库，跳过 data/ 和 node_modules/。
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set([".git", "data", "node_modules"]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (entry.endsWith(".mjs") || entry.endsWith(".js")) out.push(path);
  }
  return out;
}

const files = walk(ROOT);
let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failed += 1;
    console.error(`✖ ${relative(ROOT, file)}\n${result.stderr}`);
  }
}

if (failed) {
  console.error(`\n${failed} 个文件没通过语法检查。`);
  process.exit(1);
}
console.log(`✔ ${files.length} 个文件的语法都通过。`);
