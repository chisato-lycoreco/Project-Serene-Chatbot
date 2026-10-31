/**
 * 整条链路：demo 模式不调模型，但记忆、档案、关系、透视都真走。
 * 用临时 data 目录，跑完就扔。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { SereneRuntime } = await import("../src/runtime.mjs");

/** 每个用例一个干净的 data 目录，别让上一轮的记忆串进来。 */
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "serene-runtime-"));
  process.env.SERENE_DATA_DIR = dir;
  return new SereneRuntime({ demo: true });
}

test("第一轮：说一句，她回一两句，记忆和档案都长出来", async () => {
  const runtime = fresh();
  assert.equal(runtime.state().opening, true);
  assert.equal(runtime.state().chat.messages.length, 0);

  const result = await runtime.chatOnce("今天加班到十一点，地铁上站着都睡着了");
  assert.equal(result.messages[0].role, "user");
  assert.ok(result.messages.filter((message) => message.role === "her").length >= 1);
  assert.ok(result.messages.filter((message) => message.role === "her").length <= 2);

  const state = runtime.state();
  assert.equal(state.opening, false);
  assert.equal(state.memory.size, 1);
  assert.ok(state.growth.total >= 1);
  assert.ok(state.chat.messages.length >= 2);
  assert.equal(state.timeline.turns, 1);

  const trace = runtime.getTrace(result.traceId);
  assert.equal(trace.kind, "say");
  assert.equal(trace.wrote.memories.length, 1);
  assert.ok(trace.prompt.chars > 100);
  assert.ok(trace.style.ok);
});

test("第二轮：提一句，第一轮的「加班」会被想起来", async () => {
  const runtime = fresh();
  const first = await runtime.chatOnce("今天加班到十一点，地铁上站着都睡着了");
  assert.ok(first);

  const second = await runtime.chatOnce("你还记得我最近老加班吗");
  const trace = runtime.getTrace(second.traceId);
  assert.ok(trace.recall.length >= 1);
  assert.ok(trace.recall.some((memory) => /加班/.test(memory.text)));
  assert.ok(trace.recall[0].score > 0);
});

test("第三轮：换一件事，记忆会分开长，不会被并成一条", async () => {
  const runtime = fresh();
  await runtime.chatOnce("今天加班到十一点，地铁上站着都睡着了");
  await runtime.chatOnce("下周三我要去面试，有点慌");
  const state = runtime.state();
  assert.ok(state.memory.size >= 2);
  const texts = runtime.listMemories().items.map((item) => item.text).join("\n");
  assert.match(texts, /加班/);
  assert.match(texts, /面试/);
});

test("透视：每一轮都留得下，能查到召回、情绪和写入了什么", async () => {
  const runtime = fresh();
  const result = await runtime.chatOnce("我其实不太喜欢人多的地方，吵得慌");
  const trace = runtime.getTrace(result.traceId);
  assert.ok(trace.emotion.before.background);
  assert.ok(trace.emotion.after.primary);
  assert.equal(trace.extractionSkipped, null);
  assert.ok(trace.wrote);

  const list = runtime.traceList(5);
  assert.ok(list.some((item) => item.id === result.traceId));
});

test("整理：demo 也能跑，跑完状态一致", async () => {
  const runtime = fresh();
  await runtime.chatOnce("今天加班到十一点，地铁上站着都睡着了");
  await runtime.chatOnce("我其实不太喜欢人多的地方");
  const result = await runtime.reflect();
  assert.ok(result.state);
  assert.ok(runtime.traceList(5).some((item) => item.kind === "reflect"));
});

test("手动管记忆：钉住、改、忘掉、归档都不炸", async () => {
  const runtime = fresh();
  const added = runtime.addMemory({ text: "他喜欢在雨天出门", kind: "preference", importance: 0.7 });
  assert.equal(added.memory.text, "他喜欢在雨天出门");

  const pinned = runtime.updateMemory(added.memory.id, { pinned: true });
  assert.equal(pinned.memory.pinned, true);

  const edited = runtime.updateMemory(added.memory.id, { text: "他喜欢在雨天走路" });
  assert.equal(edited.memory.text, "他喜欢在雨天走路");

  const forgotten = runtime.forgetMemory(added.memory.id);
  assert.equal(forgotten.forgotten.id, added.memory.id);
  assert.equal(runtime.listMemories().items.length, 0);
  assert.ok(runtime.listMemories().forgotten.length >= 1);
});

test("导出：有对话、记忆、关系，没有 key", async () => {
  const runtime = fresh();
  await runtime.chatOnce("今天有点累");
  const payload = runtime.exportAll();
  assert.equal(payload.app, "Project-Serene-Chatbot");
  assert.ok(payload.chat.length >= 2);
  assert.ok(payload.bond);
  assert.ok(!JSON.stringify(payload).includes("sk-"));
});

test("重置：清对话不动记忆；全部重置才归零", async () => {
  const runtime = fresh();
  await runtime.chatOnce("今天加班到十一点");
  const before = runtime.state().memory.size;
  assert.ok(before >= 1);

  runtime.reset("chat");
  assert.equal(runtime.state().chat.messages.length, 0);
  assert.equal(runtime.state().memory.size, before);

  runtime.reset("all");
  assert.equal(runtime.state().memory.size, 0);
  assert.equal(runtime.state().chat.messages.length, 0);
});

test("落盘：data 目录里是能直接读的 JSON / JSONL", async () => {
  const runtime = fresh();
  await runtime.chatOnce("今天有点累");
  const dir = runtime.dir;
  const rows = readFileSync(join(dir, "chat.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(rows.every((row) => row.id && row.role && typeof row.text === "string"));
});
