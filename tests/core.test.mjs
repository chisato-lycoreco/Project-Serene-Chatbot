/**
 * 「长成谁」这件事的纯函数测试：档案、关系、prompt、抽取。
 * 这些不需要模型，也不写盘。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { absorb, emptyGrowth, normalizeItem, stats, total } from "../src/growth.mjs";
import { driftBond, initialBond, normalizeBond, phaseOf, updateBond } from "../src/bond.mjs";
import { buildChatSystem, SAFETY_LINE } from "../src/prompt.mjs";
import { parseExtraction } from "../src/extract.mjs";

/* ───────────────────────── 档案 ───────────────────────── */

test("档案：同一件事说第二次会变重，不会长成两条", () => {
  let growth = emptyGrowth();
  const first = absorb(growth, { section: "user", text: "他累的时候不太会说", weight: 1 });
  assert.equal(first.action, "added");
  growth = first.sections;

  const second = absorb(growth, { section: "user", text: "他累的时候不太会说自己累", weight: 1 });
  assert.equal(second.action, "merged");
  assert.equal(second.sections.user.length, 1);
  assert.equal(second.sections.user[0].weight, 2);
  assert.match(second.sections.user[0].text, /自己累/);
});

test("档案：每一节有上限，超了先挤掉最轻的", () => {
  let growth = emptyGrowth();
  const words = ["安静", "健谈", "早起", "夜猫", "怕冷", "吃辣", "记性好", "路痴", "急性子", "慢热", "嘴硬", "心软", "爱干净", "怕麻烦"];
  for (const word of words) {
    growth = absorb(growth, { section: "traits", text: `她${word}`, weight: 1 }).sections;
  }
  assert.equal(growth.traits.length, 8);
});

test("档案：不认识的 section 和空文本都写不进去", () => {
  assert.equal(normalizeItem({ section: "nope", text: "一句话" }), null);
  assert.equal(normalizeItem({ section: "user", text: "   " }), null);
});

test("档案：一条最多 40 字，太长截断而不是整条丢", () => {
  const item = normalizeItem({ section: "user", text: "啊".repeat(80) });
  assert.equal([...item.text].length, 40);
  assert.equal(stats({ user: [item] }).user, 1);
  assert.equal(total({ user: [item] }), 1);
});

/* ───────────────────────── 关系 ───────────────────────── */

test("关系：从初识开始，被靠近会涨，但不会一步到顶", () => {
  const bond = initialBond();
  assert.equal(phaseOf(bond), "初识");
  const { bond: next } = updateBond(bond, "affection");
  assert.ok(next.closeness > bond.closeness);
  assert.ok(next.closeness < 40);
  assert.equal(next.closeness, Math.min(100, next.closeness));
});

test("关系：一场冲突会同时压信任和安心", () => {
  const bond = { ...initialBond(), closeness: 60, trust: 60, security: 60, expression: 60 };
  const { bond: next } = updateBond(bond, "conflict");
  assert.ok(next.trust < bond.trust);
  assert.ok(next.security < bond.security);
  assert.ok(next.closeness < bond.closeness);
});

test("关系：冷落久了，安心会先往回退，但退不到零", () => {
  const bond = { ...initialBond(), closeness: 70, trust: 70, security: 70 };
  const { bond: drifted } = driftBond(bond, { idleDays: 30 });
  assert.ok(drifted.security < bond.security);
  assert.ok(drifted.security >= 0);
  assert.equal(drifted.closeness, bond.closeness);
});

test("关系：负数或脏数据会被拉回合法范围", () => {
  const bond = normalizeBond({ closeness: -20, trust: 999, security: "x", expression: 0 });
  assert.equal(bond.closeness, 0);
  assert.equal(bond.trust, 100);
  assert.equal(bond.security, 40);
  assert.equal(bond.expression, 0);
});

/* ───────────────────────── prompt ───────────────────────── */

const persona = {
  name: "知遥",
  role: "一个住在你电脑里的存在。",
  summary: "话不多，但听得很认真。",
  traits: ["慢", "安静"],
  speech: ["句子短"],
  boundaries: ["不编记忆"],
  sections: { opening: "先说一句你注意到的小事。" },
  beliefs: [],
};

test("prompt：有记忆时才有「记得的」这一段，没想起就不占地方", () => {
  const withMemory = buildChatSystem({
    persona,
    memories: [{ text: "他很忙", kind: "fact", createdAt: Date.now(), evidence: ["加班到十一点"] }],
    now: Date.now(),
  });
  assert.ok(withMemory.sections.some((section) => section.name === "记得的"));
  assert.match(withMemory.text, /他很忙/);

  const without = buildChatSystem({ persona, memories: [], now: Date.now() });
  assert.ok(!without.sections.some((section) => section.name === "记得的"));
});

test("prompt：底线和「怎么记」永远在", () => {
  const system = buildChatSystem({ persona, now: Date.now(), crisis: { level: "high" } });
  assert.ok(system.text.includes(SAFETY_LINE));
  assert.ok(system.sections.some((section) => section.name === "怎么记"));
  assert.ok(system.sections.some((section) => section.name === "要紧的时候"));
});

test("prompt：第一次开口会带上「不要自我介绍」这条", () => {
  const system = buildChatSystem({ persona, now: Date.now(), opening: true });
  assert.ok(system.sections.some((section) => section.name === "第一次"));
  assert.match(system.text, /不要自我介绍/);
});

/* ───────────────────────── 抽取 ───────────────────────── */

test("抽取：能忍住只写一条，不凑数", () => {
  const result = parseExtraction(
    JSON.stringify({
      memories: [{ text: "他养了一只猫", kind: "fact", importance: 0.8, evidence: ["我养了只猫"] }],
      growth: [],
      beliefs: [],
    }),
  );
  assert.equal(result.memories.length, 1);
  assert.equal(result.memories[0].kind, "fact");
  assert.equal(result.growth.length, 0);
});

test("抽取：带 ```json 围栏也能读，坏 JSON 就什么都不写", () => {
  const fenced = parseExtraction('```json\n{"memories":[{"text":"他住在城南"}],"growth":[],"beliefs":[]}\n```');
  assert.equal(fenced.memories[0].text, "他住在城南");
  const broken = parseExtraction("我觉得他挺好的，但是我不想输出 JSON");
  assert.deepEqual(broken, { memories: [], growth: [], beliefs: [] });
});

test("抽取：一轮最多两条记忆、两条档案、一条看法", () => {
  const result = parseExtraction(
    JSON.stringify({
      memories: Array.from({ length: 6 }, (_, index) => ({ text: `记忆${index}`, evidence: ["原话"] })),
      growth: Array.from({ length: 6 }, (_, index) => ({ section: "user", text: `档案${index}` })),
      beliefs: Array.from({ length: 4 }, () => ({ topic: "一句话" })),
    }),
  );
  assert.equal(result.memories.length, 2);
  assert.equal(result.growth.length, 2);
  assert.equal(result.beliefs.length, 1);
});

test("抽取：不认识的类型退回 fact，不认识的 section 丢弃", () => {
  const result = parseExtraction(
    JSON.stringify({
      memories: [{ text: "他喜欢下雨", kind: "weather" }],
      growth: [{ section: "astrology", text: "他今天水逆" }],
      beliefs: [],
    }),
  );
  assert.equal(result.memories[0].kind, "fact");
  assert.equal(result.growth.length, 0);
});
