/**
 * 落盘测试：记忆的追加日志、归档、手动忘掉。
 * 用临时目录，不碰仓库里的 data/。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MERGE_AT, MemoryStore, similarity } from "../src/stores/memory-store.js";
import { ChatStore } from "../src/stores/chat-store.js";
import { GrowthStore } from "../src/stores/growth-store.js";
import { SnapshotStore } from "../src/snapshots.mjs";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "serene-store-"));
}

test("记忆：写进去、召回得到、原文和出处都在", () => {
  const dir = tempDir();
  const store = new MemoryStore({ dir });
  const added = store.add({
    text: "他工作很忙，经常加班到很晚",
    kind: "fact",
    importance: 0.8,
    evidence: ["加班到十一点"],
  });
  assert.equal(added.merged, false);

  const recalled = store.recall("最近加班好多", { limit: 5 });
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].text, "他工作很忙，经常加班到很晚");
  assert.deepEqual(recalled[0].evidence, ["加班到十一点"]);
  assert.ok(recalled[0].score > 0);
});

test("记忆：毫不相干的话可能一条都想不起来（允许返回 0）", () => {
  const dir = tempDir();
  const store = new MemoryStore({ dir });
  store.add({ text: "他养了一只猫", kind: "fact", importance: 0.7 });
  const recalled = store.recall("今天股市怎么样", { limit: 5 });
  assert.equal(recalled.length, 0);
});

test("记忆：同一件事重复抽取会合并，不会越长越多", () => {
  const dir = tempDir();
  const store = new MemoryStore({ dir });
  store.add({ text: "他工作很忙，经常加班到很晚", kind: "fact", importance: 0.8, evidence: ["加班"] });
  const second = store.add({ text: "他工作很忙，经常加班到很晚", kind: "fact", importance: 0.8, evidence: ["通勤"] });
  assert.equal(second.merged, true);
  assert.equal(store.all().length, 1);
  assert.ok(store.all()[0].evidence.includes("通勤"));
  assert.equal(similarity("他工作很忙，经常加班到很晚", "他工作很忙，经常加班到很晚"), 1);
});

test("记忆：忘掉是追加一条 forget，不是把历史抹掉", () => {
  const dir = tempDir();
  const store = new MemoryStore({ dir });
  const { memory } = store.add({ text: "他答应下周去看医生", kind: "promise", importance: 0.9 });
  const record = store.forget(memory.id);
  assert.equal(record.id, memory.id);
  assert.equal(store.all().length, 0);
  assert.equal(store.forgotten().length, 1);

  const lines = readFileSync(join(dir, "memories.jsonl"), "utf8").trim().split("\n");
  assert.ok(lines.some((line) => JSON.parse(line).type === "forget"));
});

test("记忆：归档的不再参与召回，但还查得到", () => {
  const dir = tempDir();
  const store = new MemoryStore({ dir });
  const { memory } = store.add({ text: "他以前住在城南", kind: "fact", importance: 0.6 });
  const before = store.archiveBefore(Date.now() + 1);
  assert.equal(before.length, 1);
  assert.equal(store.recall("城南", { limit: 5 }).length, 0);
  assert.equal(store.all().filter((item) => item.archived)[0].id, memory.id);
});

test("对话：落盘顺序可恢复，清空只是改名", () => {
  const dir = tempDir();
  const store = new ChatStore({ dir });
  store.append({ role: "user", text: "在吗" });
  store.append({ role: "her", text: "在。" });
  assert.equal(store.all().length, 2);
  assert.equal(store.count, 1); // count 只数「他」说了几轮

  const reloaded = new ChatStore({ dir });
  assert.equal(reloaded.all().length, 2);
  assert.equal(reloaded.recent(1)[0].text, "在。");
  assert.equal(reloaded.history(10).length, 2);

  store.clear();
  assert.equal(store.all().length, 0);
  assert.equal(new ChatStore({ dir }).all().length, 0);
});

test("档案：改动会留快照，可以退回去", () => {
  const dir = tempDir();
  const store = new GrowthStore({ dir });
  store.apply([{ section: "user", text: "他不太会说累" }], { reason: "第一轮" });
  const firstSnapshot = store.snapshotList(1)[0]?.id;
  assert.ok(firstSnapshot);
  store.apply([{ section: "user", text: "他把累说成没事" }]);
  assert.equal(store.sections.user.length, 2);

  const restored = store.restore(firstSnapshot);
  assert.ok(restored);
  assert.equal(store.sections.user.length, 1);
});

test("快照：超过保留数会清旧的，读不存在的返回 null", () => {
  const dir = tempDir();
  const store = new SnapshotStore({ dir, name: "test", keep: 3 });
  for (let index = 0; index < 6; index += 1) store.capture({ index }, { reason: `第${index}次` });
  assert.equal(store.list().length, 3);
  assert.equal(store.read("nope"), null);
});
