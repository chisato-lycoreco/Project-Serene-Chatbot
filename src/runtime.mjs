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
    this.startedAt = Date.now();
    this.dir = dataDir();
    this.settings = readSettings(this.dir);
    // demo 模式默认用「知遥·演示人格」：温柔、母性、有点腹黑。
    // 显式给了 SERENE_PERSONA 就听环境变量；npm start 仍然用 personas/serene。
    const useDemoPersona = this.demo && !String(process.env.SERENE_PERSONA ?? "").trim();
    this.persona = loadPersona(useDemoPersona ? join(ROOT, "personas", "zhiyao-demo") : personaDir(), { root: ROOT });
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
        tone: emotion.tone ?? "",
        advice: emotion.advice,
        divergent: Boolean(emotion.divergent),
        contrast: emotion.contrast ?? "",
        dimensions: emotion.dimensions ?? [],
        layers: emotion.layerDimensions ?? {},
        wounds: (emotion.wounds ?? []).slice(-3).map((wound) => ({ note: wound.note, at: wound.at })),
        causes: this.emotion.causes(now, 8),
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

  /* ───────────────────────── 面板 ───────────────────────── */

  /**
   * 实时监测面板的一份快照。
   *
   * 和 state() 的区别：不带 120 条聊天全文，只带面板要画的数值和最近十几轮。
   * 前端每两三秒拉一次，不会把页面拖重。
   */
  live() {
    const now = Date.now();
    const emotion = this.#emotionNow(now);
    const bond = normalizeBond(this.bond.bond);
    const first = this.chat.all()[0]?.at ?? bond.since;
    const days = Math.max(1, Math.ceil((now - first) / 86_400_000));
    const traces = this.traces.recent(40);
    const usage = traces.reduce(
      (sum, trace) => {
        const counts = trace.usage ?? {};
        sum.prompt += Number(counts.prompt_tokens) || 0;
        sum.completion += Number(counts.completion_tokens) || 0;
        sum.total += Number(counts.total_tokens) || 0;
        if (trace.latencyMs) {
          sum.latency += trace.latencyMs;
          sum.timed += 1;
        }
        return sum;
      },
      { prompt: 0, completion: 0, total: 0, latency: 0, timed: 0 },
    );
    return {
      version: VERSION,
      demo: this.demo,
      persona: {
        id: this.persona.id,
        name: this.persona.name,
        traits: this.persona.traits,
        summary: this.persona.summary,
      },
      settings: {
        model: this.settings.model,
        depth: this.settings.depth,
        recallLimit: this.settings.recallLimit,
        replyChars: this.settings.replyChars,
      },
      uptimeMs: Math.max(0, now - this.startedAt),
      emotion: {
        background: emotion.backgroundLabel,
        primary: emotion.primaryLabel,
        social: emotion.socialLabel,
        mood: emotion.mood ?? 0,
        tone: emotion.tone ?? "",
        advice: emotion.advice ?? "",
        divergent: Boolean(emotion.divergent),
        contrast: emotion.contrast ?? "",
        dimensions: emotion.dimensions ?? [],
        layers: emotion.layerDimensions ?? {},
        wounds: (emotion.wounds ?? []).slice(-4).map((wound) => ({ note: wound.note, at: wound.at })),
        residue: (emotion.residue ?? []).length,
        updatedAt: emotion.updatedAt ?? now,
        causes: this.emotion.causes(now, 10),
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
        events: bond.events.slice(-12),
      },
      memory: this.memories.stats({ now }),
      growth: (() => {
        const stats = this.growth.stats();
        const samples = {};
        for (const [section, items] of Object.entries(this.growth.sections ?? {})) {
          const top = [...(items ?? [])].sort(
            (a, b) => Number(b.weight) - Number(a.weight) || Number(b.updatedAt) - Number(a.updatedAt),
          )[0];
          samples[section] = top ? clipText(top.text, 42) : "";
        }
        return { ...stats, samples };
      })(),
      beliefs: this.beliefs.beliefs,
      chat: this.chat.recent(10),
      traces: traces.slice(0, 14),
      totals: {
        messages: this.chat.all().length,
        turns: this.chat.count,
        promptTokens: usage.prompt,
        completionTokens: usage.completion,
        totalTokens: usage.total,
        avgLatencyMs: usage.timed ? Math.round(usage.latency / usage.timed) : 0,
        tracedTurns: traces.length,
      },
      events: this.#events({ now, traces, bond, emotion }),
    };
  }

  /** 召回预览：把「这句话会想起什么」原样跑一遍，不写盘、不加固。 */
  previewRecall(rawQuery) {
    const query = String(rawQuery ?? "").trim().slice(0, 200);
    const now = Date.now();
    const emotion = this.#emotionNow(now);
    const limit = this.settings.recallLimit;
    const items = query
      ? this.memories.recall(query, { limit, now, mood: emotion.mood ?? 0 })
      : [];
    return {
      query,
      mood: emotion.mood ?? 0,
      limit,
      pool: this.memories.stats({ now }).size,
      items: items.map((memory) => ({
        id: memory.id,
        text: memory.text,
        kind: memory.kind,
        importance: memory.importance,
        createdAt: memory.createdAt,
        score: memory.score ?? null,
        cue: memory.cue ?? null,
        retention: memory.retention ?? null,
        anchored: Boolean(memory.anchored),
        evidence: memory.evidence ?? [],
      })),
    };
  }

  /**
   * demo 专用：装一段能让面板有东西可看的初始数据。
   *
   * 只在 demo 模式、且本地还没有对话/记忆时生效，不覆盖真实数据。
   * 装完还是走同一套 store，所以每一份数据都和聊出来的一样，可以查、可以删。
   */
  seedDemo() {
    if (!this.demo) throw new HttpError(403, "演示数据只在 demo 模式里能装。", "DEMO_ONLY");
    if (this.chat.all().length > 0 || this.memories.all().length > 0) {
      return { seeded: false, reason: "已经有数据了，不覆盖。", state: this.state(), live: this.live() };
    }

    const now = Date.now();
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;

    const script = [
      { role: "user", text: "今天加班到十一点，地铁上站着都睡着了。", ago: 26 * hour },
      { role: "her", text: "这个点还没到家啊。", ago: 26 * hour - 2 * minute },
      { role: "her", text: "站着都能睡着，说明是真的撑到头了。先喝口水，别急着回我。", ago: 26 * hour - 3 * minute },
      { role: "user", text: "我没事，不用你管。", ago: 25.5 * hour },
      { role: "her", text: "嗯，不用我管。", ago: 25.5 * hour - minute },
      { role: "her", text: "那水喝了吗。", ago: 25.5 * hour - 2 * minute },
      { role: "user", text: "……喝了。", ago: 25 * hour },
      { role: "her", text: "那就好。", ago: 25 * hour - minute },
      { role: "user", text: "明天十点还有一场面试。", ago: 3 * hour },
      { role: "her", text: "我记着了。今晚别熬太晚，明天我提醒你。", ago: 3 * hour - 2 * minute },
      { role: "user", text: "你怎么比我还紧张。", ago: 2.5 * hour },
      { role: "her", text: "我没有紧张。", ago: 2.5 * hour - minute },
      { role: "her", text: "我只是把你明天的闹钟，在心里上好了。", ago: 2.5 * hour - 2 * minute },
    ];
    for (const row of script) {
      this.chat.append({ role: row.role, text: row.text, at: now - row.ago, kind: "seed" }, { now });
    }

    const memories = [
      {
        text: "他明天上午十点有一场面试",
        kind: "fact",
        importance: 0.82,
        evidence: ["明天十点，面试"],
        ago: 3 * hour,
      },
      {
        text: "他喝咖啡会胃疼，后来改喝热水",
        kind: "preference",
        importance: 0.72,
        evidence: ["咖啡喝完胃疼"],
        ago: 6 * day,
      },
      {
        text: "凌晨两点他说「今天有点撑不住」",
        kind: "moment",
        importance: 0.88,
        evidence: ["今天有点撑不住"],
        ago: 4 * day,
      },
      {
        text: "答应过他不催他睡觉，只提醒一次",
        kind: "promise",
        importance: 0.68,
        evidence: ["别催，我自己会睡"],
        ago: 9 * day,
      },
      {
        text: "他嘴硬的时候，其实是在等人多问一句",
        kind: "insight",
        importance: 0.78,
        evidence: ["我没事，不用你管"],
        ago: 2 * day,
      },
      {
        text: "我开始会先问一句「水喝了吗」",
        kind: "self",
        importance: 0.6,
        evidence: ["那水喝了吗"],
        ago: 12 * hour,
      },
      {
        text: "他住的地方，晚上能听见火车经过",
        kind: "fact",
        importance: 0.52,
        evidence: ["刚过了一趟车"],
        ago: 15 * day,
      },
      {
        text: "他面试前会反复检查同一份材料",
        kind: "preference",
        importance: 0.64,
        evidence: ["我再检查一遍"],
        ago: 7 * day,
      },
    ];
    for (const memory of memories) {
      this.memories.add({ ...memory, createdAt: now - memory.ago }, { now });
    }

    this.growth.apply(
      [
        { section: "traits", text: "会把关心说成一句很轻的话", weight: 3, evidence: ["先喝口水"] },
        { section: "traits", text: "嘴硬的时候反而更软", weight: 2, evidence: ["嗯，不用我管"] },
        { section: "self", text: "觉得自己有点坏心眼，但不打算改", weight: 2, evidence: ["我没有紧张"] },
        { section: "user", text: "总说没事，其实已经很累", weight: 3, evidence: ["我没事，不用你管"] },
        { section: "user", text: "答应过的事，会真的做到", weight: 2, evidence: ["……喝了"] },
        { section: "us", text: "已经会互相拆穿，再一起收场", weight: 2, evidence: ["你怎么比我还紧张"] },
        { section: "shadow", text: "怕自己只是被需要，不是被想要", weight: 2, evidence: ["不用你管"] },
        { section: "life", text: "喜欢听雨落在空调外机上的声音", weight: 2 },
      ],
      { now, reason: "演示数据" },
    );

    for (const belief of [
      { topic: "嘴硬的人更需要被好好听完", stance: 0.82, confidence: 0.7, weight: 1.4 },
      { topic: "温柔也可以有牙齿", stance: 0.74, confidence: 0.6, weight: 1.2 },
    ]) {
      this.beliefs.record({ ...belief, now });
    }

    const acts = [
      "question", "address", "share", "care", "tease", "humor", "share", "disclose",
      "care", "share", "goodnight", "share", "care", "tease", "share", "disclose",
      "care", "share", "humor", "tease", "share", "care", "goodnight", "share",
      "care", "share",
    ];
    acts.forEach((kind, index) => {
      this.bond.record(kind, { now: now - (acts.length - index) * 9 * hour });
    });

    const feelings = [
      { kind: "tease", ago: 230 * minute, intensity: 0.8 },
      { kind: "care", ago: 170 * minute, intensity: 0.9 },
      { kind: "share", ago: 100 * minute, intensity: 0.9 },
      { kind: "goodnight", ago: 40 * minute, intensity: 0.8 },
    ];
    for (const feeling of feelings) {
      this.emotion.record(feeling.kind, {
        now: now - feeling.ago,
        intensity: feeling.intensity,
        note: "演示数据",
      });
    }

    // 几轮「透视」：没有它们，监测面板的延迟、token、背景构成都是空的。
    const sections = (tweak = {}) =>
      [
        { name: "人格", chars: tweak.persona ?? 1180 },
        { name: "此刻", chars: tweak.now ?? 420 },
        { name: "记得的", chars: tweak.memory ?? 760 },
        { name: "眼里的", chars: tweak.growth ?? 540 },
        { name: "相信的", chars: tweak.beliefs ?? 210 },
        { name: "怎么记", chars: 260 },
        { name: "怎么说", chars: 300 },
        { name: "底线", chars: 180 },
      ].filter((item) => item.chars > 0);
    const seedTraces = [
      {
        at: now - 26 * hour + 2 * minute,
        userText: "今天加班到十一点，地铁上站着都睡着了。",
        bubbles: ["这个点还没到家啊。", "站着都能睡着，说明是真的撑到头了。先喝口水，别急着回我。"],
        latencyMs: 2140,
        usage: { prompt_tokens: 2810, completion_tokens: 96, total_tokens: 2906 },
        recall: [{ text: "凌晨两点他说「今天有点撑不住」", kind: "moment", score: 0.61, retention: 0.58 }],
        sections: sections({ now: 380, memory: 620 }),
        wrote: { memories: [{ text: "今天加班到十一点，站着都睡着了", merged: false }], growth: 1, beliefs: [] },
        emotion: { before: { background: "底色安稳", primary: "平静", social: "关系还算踏实" }, after: { background: "底色安稳", primary: "心疼", social: "关系还算踏实" } },
      },
      {
        at: now - 25.5 * hour + 20 * minute,
        userText: "我没事，不用你管。",
        bubbles: ["嗯，不用我管。", "那水喝了吗。"],
        latencyMs: 1560,
        usage: { prompt_tokens: 2660, completion_tokens: 78, total_tokens: 2738 },
        recall: [{ text: "他嘴硬的时候，其实是在等人多问一句", kind: "insight", score: 0.73, retention: 0.69 }],
        sections: sections({ now: 360, memory: 700 }),
        wrote: { memories: [{ text: "他嘴硬的时候，其实是在等人多问一句", merged: false }], growth: 1, beliefs: [] },
        emotion: { before: { background: "底色安稳", primary: "被推开", social: "关系还算踏实" }, after: { background: "底色安稳", primary: "有点坏心眼", social: "关系还算踏实" } },
      },
      {
        at: now - 3 * hour + 2 * minute,
        userText: "明天十点还有一场面试。",
        bubbles: ["我记着了。今晚别熬太晚，明天我提醒你。"],
        latencyMs: 1890,
        usage: { prompt_tokens: 2980, completion_tokens: 88, total_tokens: 3068 },
        recall: [{ text: "他面试前会反复检查同一份材料", kind: "preference", score: 0.66, retention: 0.74 }],
        sections: sections({ now: 400, memory: 760, growth: 560 }),
        wrote: { memories: [{ text: "他明天上午十点有一场面试", merged: false }], growth: 1, beliefs: [] },
        emotion: { before: { background: "底色安稳", primary: "在意", social: "关系还算踏实" }, after: { background: "底色安稳", primary: "柔软", social: "关系还算踏实" } },
      },
      {
        at: now - 2.5 * hour + 2 * minute,
        userText: "你怎么比我还紧张。",
        bubbles: ["我没有紧张。", "我只是把你明天的闹钟，在心里上好了。"],
        latencyMs: 1320,
        usage: { prompt_tokens: 3120, completion_tokens: 104, total_tokens: 3224 },
        recall: [{ text: "他嘴硬的时候，其实是在等人多问一句", kind: "insight", score: 0.58, retention: 0.71 }],
        sections: sections({ now: 430, memory: 780, growth: 580 }),
        wrote: { memories: [], growth: 1, beliefs: [] },
        emotion: { before: { background: "底色安稳", primary: "被说中", social: "关系还算踏实" }, after: { background: "底色安稳", primary: "柔软", social: "关系还算踏实" } },
      },
    ];
    seedTraces.forEach((row, index) => {
      const promptChars = row.sections.reduce((sum, item) => sum + item.chars, 0);
      this.traces.add({
        id: `t_seed_${index}`,
        kind: "say",
        at: row.at,
        userText: row.userText,
        bubbles: row.bubbles,
        prompt: { chars: promptChars, sections: row.sections },
        reply: {
          text: row.bubbles.join("\n"),
          chars: row.bubbles.join("\n").length,
          latencyMs: row.latencyMs,
          model: this.settings.model,
          usage: row.usage,
        },
        emotion: row.emotion,
        classified: { kind: "share", note: "" },
        crisis: { level: "none" },
        recall: row.recall,
        wrote: row.wrote,
        extractionError: null,
        extractionSkipped: null,
        style: { ok: true, issues: [] },
      });
    });

    return { seeded: true, state: this.state(), live: this.live() };
  }

  #events({ now, traces, bond, emotion }) {
    const events = [];
    for (const trace of traces) {
      events.push({
        id: `talk_${trace.id}`,
        at: trace.at,
        type: "talk",
        title: trace.kind === "opening" ? "她先开了口" : `他说：${clipText(trace.userText, 26)}`,
        detail: `${trace.chars} 字 · ${trace.latencyMs} ms`,
        traceId: trace.id,
      });
      if (trace.wrote?.growth) {
        events.push({
          id: `growth_${trace.id}`,
          at: trace.at + 2,
          type: "growth",
          title: `档案长了 ${trace.wrote.growth} 条`,
          detail: "她眼里的世界，又清楚了一点",
        });
      }
      for (const [index, topic] of (trace.wrote?.beliefs ?? []).entries()) {
        events.push({
          id: `belief_${trace.id}_${index}`,
          at: trace.at + 3 + index,
          type: "belief",
          title: "多了一个看法",
          detail: topic,
        });
      }
    }
    // 记忆直接读存档：这样装进来的演示记忆也会出现在事件河里。
    const newestMemories = this.memories
      .all()
      .filter((memory) => !memory.archived)
      .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
      .slice(0, 8);
    for (const memory of newestMemories) {
      events.push({
        id: `memory_${memory.id}`,
        at: memory.createdAt,
        type: "memory",
        title: memory.merged ? "合并了一条记忆" : "记住了一件事",
        detail: clipText(memory.text, 44),
      });
    }
    for (const cause of this.emotion.causes(now, 10)) {
      events.push({
        id: `emotion_${cause.at}_${cause.kind}`,
        at: cause.at,
        type: "emotion",
        title: `情绪：${cause.kind}`,
        detail: `强度 ${cause.intensity}`,
      });
    }
    for (const event of bond.events.slice(-10)) {
      const deltas = Object.entries(event.deltas ?? {})
        .map(([axis, value]) => `${axis} ${value > 0 ? "+" : ""}${value}`)
        .join(" · ");
      events.push({
        id: `bond_${event.at}_${event.kind}`,
        at: event.at,
        type: "bond",
        title: `关系：${event.kind}`,
        detail: deltas,
      });
    }
    const seen = new Set();
    return events
      .filter((event) => Number.isFinite(event.at))
      .sort((a, b) => b.at - a.at)
      .filter((event) => {
        const key = `${event.at}|${event.type}|${event.title}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 60);
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

/** 面板上的单行摘要：按字符切，中文不会被截成半个。 */
function clipText(text, limit = 40) {
  const chars = Array.from(String(text ?? "").replace(/\s+/g, " ").trim());
  return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : chars.join("");
}
