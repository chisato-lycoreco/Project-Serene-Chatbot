/**
 * src/runtime.mjs — 一轮对话里发生的所有事，按顺序排好。
 *
 * 读一句 → 认情绪 → 认关系 → 想起来的几条 → 拼 prompt → 说 →
 * 拆气泡 → 看像不像她 → 记「被用上了」→ 回头抽取 → 写盘 → 留一份透视。
 *
 * 这里刻意不做「主动找人说话」、不做群聊、不做语音、不做自拍：
 * 这个仓库只把「记得」和「长成谁」这两件事做厚。
 */

import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { bondBlock, normalizeBond, phaseOf } from "./bond.mjs";
import { ROOT, VERSION, apiKey, dataDir, keySource, personaDir, readSettings, writeSettings } from "./config.mjs";
import { detectCrisis } from "./core/crisis.js";
import { mergeBeliefs } from "./core/beliefs.js";
import { tokenize } from "./core/recall.js";
import { checkStyle } from "./core/style.js";
import { demoExtract, demoReply } from "./demo.mjs";
import { buildExtractionMessages, buildReflectionMessages, parseExtraction } from "./extract.mjs";
import { total } from "./growth.mjs";
import { ModelError, complete } from "./model.mjs";
import { loadPersona } from "./persona.mjs";
import { buildChatSystem } from "./prompt.mjs";
import { BeliefStore } from "./stores/belief-store.js";
import { BondStore } from "./stores/bond-store.js";
import { ChatStore } from "./stores/chat-store.js";
import { EmotionStore } from "./stores/emotion-store.js";
import { GrowthStore } from "./stores/growth-store.js";
import { MemoryStore } from "./stores/memory-store.js";
import { TraceStore } from "./stores/trace-store.js";
import { cleanReply, splitBubbles } from "./text.mjs";

const MAX_USER_CHARS = 2000;
const TRACE_KEEP = 80;

export class HttpError extends Error {
  constructor(status, message, code = "HTTP") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class SereneRuntime {
  #chain = Promise.resolve();

  constructor({ demo = false } = {}) {
    this.demo = demo || process.argv.includes("--demo");
    this.dir = dataDir();
    this.settings = readSettings(this.dir);
    this.persona = loadPersona(personaDir(), { root: ROOT });
    this.chat = new ChatStore({ dir: this.dir });
    this.memories = new MemoryStore({ dir: this.dir });
    this.emotion = new EmotionStore({ dir: this.dir, baseline: this.persona.baseline });
    this.beliefs = new BeliefStore({ dir: this.dir });
    this.growth = new GrowthStore({ dir: this.dir });
    this.bond = new BondStore({ dir: this.dir });
    this.traces = new TraceStore({ dir: this.dir });
  }

  /* ───────────────────────── 对话 ───────────────────────── */

  chatOnce(rawText) {
    return this.#serial(() => this.#say(rawText));
  }

  openFirst() {
    return this.#serial(() => this.#open());
  }

  async #say(rawText) {
    const text = String(rawText ?? "").trim().slice(0, MAX_USER_CHARS);
    if (!text) throw new HttpError(400, "说点什么再发。", "EMPTY");
    const now = Date.now();
    const crisis = detectCrisis(text);
    const before = this.#emotionNow(now);
    const classified = this.emotion.applyMessage({ text }, { now });
    this.bond.record(classified?.kind ?? "chat", { now });
    const after = this.#emotionNow(now);

    const recall = this.#recall(text, after, now);
    const userMessage = this.chat.append({ role: "user", text, at: now, kind: "say" });
    const system = this.#system({ recall, after, crisis, now });
    const history = this.chat.history(this.settings.historyMessages);

    const reply = await this.#complete([{ role: "system", content: system.text }, ...history], {
      maxTokens: crisis.level === "high" ? 460 : this.settings.maxTokens,
      temperature: crisis.level === "high" ? 0.8 : this.settings.temperature,
      timeoutMs: 90_000,
    });

    const cleaned = cleanReply(reply.text, { name: this.persona.name });
    const bubbles = splitBubbles(cleaned, { max: crisis.level === "high" ? 3 : 2 }).slice(0, 3);
    if (!bubbles.length) throw new HttpError(502, "她这次没说出话。可以再说一句试试。", "EMPTY_REPLY");
    const joined = bubbles.join("\n");
    const style = checkStyle(
      joined,
      crisis.level === "high"
        ? { maxChars: 280, maxSentences: 6, maxQuestions: 1 }
        : { maxChars: this.settings.replyChars, maxSentences: 4, maxQuestions: 1 },
    );

    this.emotion.afterReply({ text: joined, lastKind: classified?.kind ?? "", now });

    // 只有真的出现在回复里的记忆才算「被想起」——想起来会变牢，想起来但没说出口不会。
    const used = this.#usedMemories(recall, joined);
    if (used.length) this.memories.reinforce(used, { now });

    const herMessages = bubbles.map((bubble) =>
      this.chat.append({ role: "her", text: bubble, at: Date.now(), kind: "say", replyTo: userMessage?.id }),
    );

    // 危机轮不写记忆：把「他说过不想活」变成一条长期记忆，以后每次召回都可能把它带回来。
    let extraction;
    if (crisis.level === "high") {
      extraction = { skipped: "危机轮不写入记忆" };
    } else if (!this.settings.remember) {
      extraction = { skipped: "记忆开关关着" };
    } else {
      extraction = await this.#remember({ userText: text, reply: joined, now });
    }

    const trace = this.#trace({
      kind: "say",
      at: now,
      userText: text,
      bubbles,
      system,
      reply,
      style,
      classified,
      crisis,
      before,
      after,
      recall,
      extraction,
    });

    return {
      messages: [userMessage, ...herMessages].filter(Boolean),
      traceId: trace.id,
      state: this.state(),
    };
  }

  async #open() {
    if (this.chat.all().length > 0) return { opening: false, messages: [] };
    const now = Date.now();
    const before = this.#emotionNow(now);
    const system = this.#system({ recall: [], after: before, crisis: { level: "none" }, now, opening: true });
    const reply = await this.#complete(
      [
        { role: "system", content: system.text },
        { role: "user", content: "（对方刚打开页面，还没说话。你先开口。）" },
      ],
      { maxTokens: 220, temperature: this.settings.temperature, timeoutMs: 60_000 },
    );
    const cleaned = cleanReply(reply.text, { name: this.persona.name });
    const bubbles = splitBubbles(cleaned, { max: 2 }).slice(0, 2);
    if (!bubbles.length) return { opening: false, messages: [] };
    const her = bubbles.map((bubble) => this.chat.append({ role: "her", text: bubble, at: Date.now(), kind: "opening" }));
    const trace = this.#trace({
      kind: "opening",
      at: now,
      userText: "",
      bubbles,
      system,
      reply,
      style: checkStyle(bubbles.join("\n"), { maxChars: this.settings.replyChars }),
      before,
      after: this.#emotionNow(now),
      recall: [],
    });
    return { opening: true, messages: her, traceId: trace.id, state: this.state() };
  }

  /* ───────────────────────── 记忆 ───────────────────────── */

  async #remember({ userText, reply, now }) {
    if (this.demo) {
      return this.#writeExtraction(demoExtract({ userText, now }), { now, reason: "demo 里这一轮聊出来的" });
    }
    try {
      const messages = buildExtractionMessages({
        userText,
        replyText: reply,
        recent: this.chat.recent(6),
        personaName: this.persona.name,
        now,
      });
      const result = await this.#complete(messages, {
        json: true,
        maxTokens: 520,
        temperature: 0.25,
        timeoutMs: 60_000,
        retries: 1,
      });
      const extracted = parseExtraction(result.text, { now, limit: "turn" });
      return this.#writeExtraction(extracted, { now, reason: "这一轮聊出来的" });
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), wrote: null };
    }
  }

  /** demo 没有模型，就把最近说过的话按关键词重新过一遍。 */
  #demoExtraction(now) {
    const out = { memories: [], growth: [], beliefs: [] };
    for (const row of this.chat.recent(60)) {
      if (row.role !== "user") continue;
      const part = demoExtract({ userText: row.text, now });
      out.memories.push(...part.memories);
      out.growth.push(...part.growth);
      out.beliefs.push(...part.beliefs);
    }
    // 同一件事会出现很多次，交给 store 的合并逻辑处理，这里不去重。
    return out;
  }

  /** 抽取结果 → 三个落盘的地方。返回「写了什么」，给透视和面板看。 */
  #writeExtraction(extracted, { now = Date.now(), reason = "" } = {}) {
    const memories = [];
    for (const item of extracted.memories ?? []) {
      const added = this.memories.add(item, { now });
      if (added) memories.push({ id: added.memory.id, text: added.memory.text, merged: added.merged });
    }
    const growth = this.growth.apply(extracted.growth ?? [], { now, reason });
    const beliefs = [];
    for (const item of extracted.beliefs ?? []) {
      const result = this.beliefs.record({ ...item, now });
      if (result?.belief) beliefs.push(result.belief.topic);
    }
    return {
      wrote: {
        memories,
        growth: growth.changed,
        growthSnapshot: growth.snapshot?.id ?? null,
        beliefs,
      },
      counts: { memories: memories.length, growth: growth.changed, beliefs: beliefs.length },
    };
  }

  listMemories({ q = "", kind = "", archived = false, limit = 200 } = {}) {
    const now = Date.now();
    const needle = String(q ?? "").trim().toLowerCase();
    const wantedKind = String(kind ?? "").trim();
    const items = this.memories
      .all()
      .filter((memory) => Boolean(memory.archived) === Boolean(archived))
      .filter((memory) => !wantedKind || memory.kind === wantedKind)
      .filter((memory) => {
        if (!needle) return true;
        const haystack = `${memory.text} ${(memory.evidence ?? []).join(" ")}`.toLowerCase();
        return haystack.includes(needle);
      })
      .sort(
        (a, b) =>
          Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
          Number(b.createdAt) - Number(a.createdAt),
      )
      .slice(0, Math.max(1, Math.min(500, Number(limit) || 200)))
      .map((memory) => ({ ...memory, retention: round(this.#retention(memory, now)) }));
    return {
      items,
      total: items.length,
      stats: this.memories.stats({ now }),
      forgotten: this.memories.forgotten({ limit: 12 }),
    };
  }

  addMemory({ text, kind = "fact", importance = 0.6 } = {}) {
    const added = this.memories.add({ text, kind, importance, source: "manual" });
    if (!added) throw new HttpError(400, "这条记忆是空的。", "EMPTY");
    return { memory: added.memory, merged: added.merged, memories: this.listMemories() };
  }

  updateMemory(id, patch) {
    const memory = this.memories.update(id, patch ?? {});
    if (!memory) throw new HttpError(404, "没有这条记忆。", "NOT_FOUND");
    return { memory, memories: this.listMemories() };
  }

  forgetMemory(id) {
    const record = this.memories.forget(id);
    if (!record) throw new HttpError(404, "没有这条记忆。", "NOT_FOUND");
    return { forgotten: record, memories: this.listMemories() };
  }

  /* ───────────────────────── 档案 / 关系 / 时间线 ───────────────────────── */

  growthState() {
    return {
      sections: this.growth.sections,
      stats: this.growth.stats(),
      snapshots: this.growth.snapshotList(12),
      beliefs: this.beliefs.beliefs,
    };
  }

  restoreGrowth(id) {
    const result = this.growth.restore(id);
    if (!result) throw new HttpError(404, "没有这份快照。", "NOT_FOUND");
    return { ...this.growthState(), restoredFrom: result.restoredFrom.id };
  }

  resetGrowth() {
    this.growth.reset();
    return this.growthState();
  }

  async reflect() {
    return this.#serial(async () => {
      if (this.chat.count < 2) throw new HttpError(400, "还没聊几句，暂时没什么可整理的。", "TOO_EARLY");
      const now = Date.now();
      if (this.demo) {
        const extracted = this.#demoExtraction(now);
        const written = this.#writeExtraction(extracted, { now, reason: "demo 里主动整理" });
        const trace = this.#trace({
          kind: "reflect",
          at: now,
          userText: "",
          bubbles: [],
          system: { text: "", sections: [] },
          reply: { text: "", model: "demo", latencyMs: 0, usage: null },
          style: { ok: true, issues: [] },
          before: this.#emotionNow(now),
          after: this.#emotionNow(now),
          recall: [],
          extraction: written,
        });
        return { ...written, traceId: trace.id, state: this.state() };
      }
      const messages = buildReflectionMessages({
        messages: this.chat.recent(60),
        memories: this.memories.all().filter((memory) => !memory.archived),
        growth: this.growth.sections,
        personaName: this.persona.name,
        now,
      });
      const result = await this.#complete(messages, {
        json: true,
        maxTokens: 700,
        temperature: 0.35,
        timeoutMs: 90_000,
      });
      const extracted = parseExtraction(result.text, { now, limit: "reflect" });
      const written = this.#writeExtraction(extracted, { now, reason: "主动整理" });
      const trace = this.#trace({
        kind: "reflect",
        at: now,
        userText: "",
        bubbles: [],
        system: { text: "", sections: [] },
        reply: result,
        style: { ok: true, issues: [] },
        before: this.#emotionNow(now),
        after: this.#emotionNow(now),
        recall: [],
        extraction: written,
      });
      return { ...written, traceId: trace.id, state: this.state() };
    });
  }

  timeline() {
    const now = Date.now();
    const rows = this.chat.all().filter((row) => row.role !== "note");
    const first = rows[0]?.at ?? this.bond.bond.since ?? now;
    const days = Math.max(1, Math.ceil((now - first) / 86_400_000));
    const all = this.memories.all().filter((memory) => !memory.archived);
    const firstOf = (predicate) =>
      [...all]
        .filter(predicate)
        .sort((a, b) => Number(a.createdAt) - Number(b.createdAt))[0]?.createdAt ?? 0;

    const events = this.bond.bond.events ?? [];
    const firsts = [
      { label: "第一次说话", at: rows[0]?.at ?? 0 },
      { label: "第一条记忆", at: firstOf(() => true) },
      { label: "第一个承诺", at: firstOf((memory) => memory.kind === "promise") },
      { label: "第一个时刻", at: firstOf((memory) => memory.kind === "moment") },
      { label: "第一次顶嘴", at: events.find((event) => event.kind === "conflict" || event.kind === "scold")?.at ?? 0 },
      { label: "第一次和好", at: events.find((event) => event.kind === "repair")?.at ?? 0 },
    ].filter((item) => item.at > 0);

    const milestones = [...all]
      .filter((memory) => memory.kind === "moment" || memory.kind === "promise" || Number(memory.importance) >= 0.8)
      .sort((a, b) => Number(b.importance) - Number(a.importance) || Number(b.createdAt) - Number(a.createdAt))
      .slice(0, 8)
      .map((memory) => ({
        id: memory.id,
        text: memory.text,
        kind: memory.kind,
        at: memory.createdAt,
        evidence: memory.evidence ?? [],
      }));

    return {
      days,
      since: first,
      turns: this.chat.count,
      messages: rows.length,
      memories: all.length,
      growth: total(this.growth.sections),
      beliefs: this.beliefs.beliefs.length,
      phase: phaseOf(this.bond.bond),
      firsts,
      milestones,
    };
  }

  /* ───────────────────────── 状态 / 设置 / 导出 / 重置 ───────────────────────── */

  state() {
    const now = Date.now();
    const emotion = this.#emotionNow(now);
    const bond = normalizeBond(this.bond.bond);
    const first = this.chat.all()[0]?.at ?? bond.since;
    const days = Math.max(1, Math.ceil((now - first) / 86_400_000));
    return {
      version: VERSION,
      demo: this.demo,
      hasKey: Boolean(apiKey()),
      keySource: keySource(),
      persona: {
        id: this.persona.id,
        name: this.persona.name,
        role: this.persona.role,
        summary: this.persona.summary,
        traits: this.persona.traits,
        beliefs: this.persona.beliefs,
        sections: this.persona.sections,
      },
      settings: this.settings,
      emotion: {
        background: emotion.backgroundLabel,
        primary: emotion.primaryLabel,
        social: emotion.socialLabel,
        mood: emotion.mood,
        advice: emotion.advice,
        divergent: Boolean(emotion.divergent),
        contrast: emotion.contrast ?? "",
        wounds: (emotion.wounds ?? []).slice(-3).map((wound) => ({ note: wound.note, at: wound.at })),
      },
      bond: {
        phase: bond.phase,
        axes: {
          closeness: round(bond.closeness),
          trust: round(bond.trust),
          security: round(bond.security),
          expression: round(bond.expression),
        },
        since: bond.since,
        days,
        line: bondBlock(bond, { days }),
        events: bond.events.slice(-6),
      },
      memory: this.memories.stats({ now }),
      growth: { stats: this.growth.stats(), total: total(this.growth.sections), sections: this.growth.sections },
      beliefs: this.beliefs.beliefs,
      timeline: this.timeline(),
      chat: { messages: this.chat.recent(120) },
      opening: this.chat.all().length === 0,
      traces: this.traces.recent(12),
    };
  }

  updateSettings(patch) {
    this.settings = writeSettings(patch, this.dir);
    return this.settings;
  }

  getTrace(id) {
    const trace = this.traces.get(id);
    if (!trace) throw new HttpError(404, "没有这一轮透视。", "NOT_FOUND");
    return trace;
  }

  traceList(limit = 20) {
    return this.traces.recent(limit);
  }

  exportAll() {
    const now = Date.now();
    return {
      app: "Project-Serene-Chatbot",
      version: VERSION,
      exportedAt: now,
      persona: { id: this.persona.id, name: this.persona.name },
      chat: this.chat.all(),
      memories: this.memories.all(),
      growth: this.growth.sections,
      beliefs: this.beliefs.beliefs,
      bond: this.bond.bond,
      emotion: this.#emotionNow(now),
      traces: this.traces.recent(TRACE_KEEP),
    };
  }

  /** 重置某一类：文件改名归档，不真删。 */
  reset(scope = "chat") {
    if (scope === "chat") {
      this.chat.clear();
    } else if (scope === "memories") {
      this.#renew("memories.jsonl", () => {
        this.memories = new MemoryStore({ dir: this.dir });
      });
    } else if (scope === "growth") {
      this.#renew("growth.json", () => this.growth.reset());
    } else if (scope === "beliefs") {
      this.#renew("beliefs.json", () => this.beliefs.reset());
    } else if (scope === "emotion") {
      this.#renew("emotion.json", () => this.emotion.reset());
      this.#renew("scars.json", () => {});
    } else if (scope === "bond") {
      this.#renew("bond.json", () => this.bond.reset());
    } else if (scope === "all") {
      this.chat.clear();
      this.#renew("memories.jsonl", () => {
        this.memories = new MemoryStore({ dir: this.dir });
      });
      this.#renew("growth.json", () => this.growth.reset());
      this.#renew("beliefs.json", () => this.beliefs.reset());
      this.#renew("emotion.json", () => this.emotion.reset());
      this.#renew("scars.json", () => {});
      this.#renew("bond.json", () => this.bond.reset());
    } else {
      throw new HttpError(400, `不认识要重置的东西：${scope}`, "BAD_SCOPE");
    }
    return this.state();
  }

  #renew(file, make) {
    try {
      renameSync(join(this.dir, file), join(this.dir, `${file}.${Date.now()}.bak`));
    } catch {
      // 文件可能本来就不存在。
    }
    make();
  }

  /* ───────────────────────── 内部 ───────────────────────── */

  #serial(fn) {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #system({ recall, after, crisis, now, opening = false }) {
    const since = Number(this.bond.bond.since) || now;
    const days = Math.max(1, Math.ceil((now - since) / 86_400_000));
    return buildChatSystem({
      persona: this.persona,
      emotion: after,
      memories: recall,
      growth: this.growth.sections,
      beliefs: this.beliefs.beliefs,
      bond: this.bond.bond,
      days,
      opening,
      crisis,
      now,
      depth: this.settings.depth,
      replyChars: this.settings.replyChars,
    });
  }

  #recall(text, snapshot, now) {
    try {
      return this.memories.recall(text, {
        limit: this.settings.recallLimit,
        now,
        mood: snapshot?.mood ?? 0,
      });
    } catch {
      return [];
    }
  }

  #emotionNow(now = Date.now()) {
    try {
      return this.emotion.snapshot({ now });
    } catch {
      return {
        backgroundLabel: "",
        primaryLabel: "",
        socialLabel: "",
        mood: 0,
        advice: "",
        wounds: [],
      };
    }
  }

  #retention(memory, now) {
    const ageDays = Math.max(0, (now - Number(memory.createdAt ?? now)) / 86_400_000);
    const stability = Math.max(0.5, Number(memory.stability) || 3);
    return (1 + ageDays / stability) ** -0.6;
  }

  /** 回复里真的用上了哪几条：按词重合判断，宁少不多。 */
  #usedMemories(recall, reply) {
    const replyTokens = new Set(tokenize(reply));
    if (!replyTokens.size) return [];
    const used = [];
    for (const memory of recall) {
      const memoryTokens = new Set(tokenize(`${memory.text} ${(memory.evidence ?? []).join(" ")}`));
      let hits = 0;
      for (const token of memoryTokens) if (replyTokens.has(token)) hits += 1;
      const threshold = memoryTokens.size <= 8 ? 1 : 2;
      if (hits >= threshold) used.push(memory.id);
    }
    return used;
  }

  async #complete(messages, { json = false, maxTokens = 360, temperature = 1, timeoutMs = 90_000, retries = 2 } = {}) {
    if (this.demo) {
      const reply = demoReply({ messages });
      return { ...reply, usage: null };
    }
    return complete({
      messages,
      apiKey: apiKey(),
      model: this.settings.model,
      baseUrl: this.settings.baseUrl,
      json,
      maxTokens,
      temperature,
      timeoutMs,
      retries,
    });
  }

  #trace({
    kind,
    at,
    userText,
    bubbles,
    system,
    reply,
    style,
    classified = null,
    crisis = null,
    before,
    after,
    recall,
    extraction = null,
  }) {
    const joined = bubbles.join("\n");
    const trace = {
      id: `t_${at.toString(36)}_${randomUUID().slice(0, 6)}`,
      kind,
      at,
      userText,
      bubbles,
      // prompt 只留结构，不留全文：全文在 data/traces.jsonl 里，太长了。
      prompt: { chars: system.text.length, sections: system.sections },
      reply: {
        text: joined,
        chars: joined.length,
        latencyMs: reply.latencyMs ?? 0,
        model: reply.model ?? this.settings.model,
        usage: reply.usage ?? null,
      },
      emotion: {
        before: pickEmotion(before),
        after: pickEmotion(after),
      },
      classified: classified ? { kind: classified.kind, note: classified.note ?? "" } : null,
      crisis: crisis ?? { level: "none" },
      recall: (recall ?? []).map((memory) => ({
        id: memory.id,
        text: memory.text,
        kind: memory.kind,
        score: memory.score ?? null,
        retention: memory.retention ?? null,
        evidence: memory.evidence ?? [],
      })),
      wrote: extraction?.wrote ?? null,
      extractionError: extraction?.error ?? null,
      extractionSkipped: extraction?.skipped ?? null,
      style,
    };
    return this.traces.add(trace);
  }
}

function pickEmotion(snapshot) {
  if (!snapshot) return null;
  return {
    background: snapshot.backgroundLabel ?? "",
    primary: snapshot.primaryLabel ?? "",
    social: snapshot.socialLabel ?? "",
    mood: snapshot.mood ?? 0,
    wounds: (snapshot.wounds ?? []).length,
  };
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}
