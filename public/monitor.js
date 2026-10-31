/**
 * monitor.js — 实时监测面板。
 *
 * 每 2.5 秒拉一次 /api/live。只读，不写任何东西。
 * 所有动态文本都走 textContent；画布只画数值，不画用户输入。
 */

const $ = (selector, root = document) => root.querySelector(selector);

const COLORS = {
  accent: "#d8a86a",
  green: "#8fa596",
  rose: "#c98f82",
  violet: "#9a8fc0",
  teal: "#7fa8a0",
  muted: "#8d8677",
  text: "#e9e3d6",
  line: "#2b2822",
};

const KIND_LABEL = {
  fact: "事实",
  preference: "喜好",
  moment: "时刻",
  promise: "答应过",
  insight: "想明白的",
  self: "她自己",
};

const KIND_COLOR = {
  fact: "#d8a86a",
  preference: "#8fa596",
  moment: "#c98f82",
  promise: "#9a8fc0",
  insight: "#7fa8a0",
  self: "#b9a58a",
};

const BOND_LABEL = {
  chat: "说上话",
  question: "提问",
  share: "分享",
  disclose: "坦白",
  address: "叫了一声",
  affection: "亲近",
  intimacy: "更近",
  kiss: "亲了一下",
  tease: "逗他",
  care: "关心",
  humor: "一起笑",
  goodnight: "晚安",
  coax: "哄",
  repair: "和好",
  conflict: "争执",
  scold: "凶了一下",
  rejection: "被推开",
  neglect: "冷落",
  ignored: "被忽略",
};

const GROWTH = [
  ["traits", "性格", 8],
  ["self", "自己", 8],
  ["user", "眼里", 10],
  ["us", "之间", 10],
  ["shadow", "暗处", 6],
  ["life", "日常", 8],
];

const view = {
  live: null,
  paused: false,
  timer: 0,
  lastFetch: 0,
  feedKeys: new Set(),
  traceId: "",
  prompt: null,
  clockTimer: 0,
};

/* ───────────────────────── 工具 ───────────────────────── */

async function api(path, options) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message ?? `请求失败（${response.status}）`);
  return data;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function pct(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function clock(ts) {
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function ago(ts) {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function duration(ms) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

/* ───────────────────────── 雷达 ───────────────────────── */

function drawRadar(layers) {
  const canvas = $("#radar");
  if (!canvas) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.clientWidth || 320;
  const height = canvas.clientHeight || 240;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.34;
  const axes = layers?.background ?? [];
  const count = axes.length || 6;
  const angle = (index) => -Math.PI / 2 + (index / count) * Math.PI * 2;

  for (let ring = 1; ring <= 4; ring += 1) {
    ctx.beginPath();
    for (let i = 0; i < count; i += 1) {
      const r = (radius * ring) / 4;
      const x = cx + Math.cos(angle(i)) * r;
      const y = cy + Math.sin(angle(i)) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = `rgba(233,227,214,${ring === 4 ? 0.13 : 0.06})`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  for (let i = 0; i < count; i += 1) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle(i)) * radius, cy + Math.sin(angle(i)) * radius);
    ctx.strokeStyle = "rgba(233,227,214,0.06)";
    ctx.stroke();
  }

  const series = [
    ["background", "rgba(216,168,106,0.6)", "rgba(216,168,106,0.09)"],
    ["primary", "rgba(201,143,130,0.72)", "rgba(201,143,130,0.1)"],
    ["social", "rgba(143,165,150,0.68)", "rgba(143,165,150,0.07)"],
  ];
  for (const [key, stroke, fill] of series) {
    const values = layers?.[key] ?? [];
    if (!values.length) continue;
    ctx.beginPath();
    values.forEach((item, i) => {
      const value = Math.max(0.06, Math.min(1, Number(item.value) / 100));
      const x = cx + Math.cos(angle(i)) * radius * value;
      const y = cy + Math.sin(angle(i)) * radius * value;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  ctx.font = "10px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.fillStyle = COLORS.muted;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  axes.forEach((item, i) => {
    ctx.fillText(item.label, cx + Math.cos(angle(i)) * (radius + 20), cy + Math.sin(angle(i)) * (radius + 18));
  });
}

/* ───────────────────────── 记忆环 ───────────────────────── */

function drawDonut(memory) {
  const canvas = $("#mem-donut");
  if (!canvas) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const size = canvas.clientWidth || 128;
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const kinds = memory?.kinds ?? {};
  const entries = Object.entries(kinds).filter(([, count]) => Number(count) > 0);
  const total = entries.reduce((sum, [, count]) => sum + Number(count), 0);
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.38;
  const width = Math.max(10, size * 0.1);

  if (!total) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = width;
    ctx.stroke();
  } else {
    let start = -Math.PI / 2;
    for (const [kind, count] of entries) {
      const sweep = (Number(count) / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, start + 0.02, start + sweep - 0.02);
      ctx.strokeStyle = KIND_COLOR[kind] ?? COLORS.muted;
      ctx.lineWidth = width;
      ctx.lineCap = "butt";
      ctx.stroke();
      start += sweep;
    }
  }

  ctx.fillStyle = COLORS.text;
  ctx.font = "500 22px 'Iowan Old Style', 'Songti SC', serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(memory?.size ?? 0), cx, cy - 4);
  ctx.fillStyle = COLORS.muted;
  ctx.font = "9px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillText(`/ ${memory?.capacity ?? 500}`, cx, cy + 14);
}

/* ───────────────────────── 延迟小图 ───────────────────────── */

function drawSpark(traces) {
  const canvas = $("#latency-spark");
  if (!canvas) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.clientWidth || 300;
  const height = canvas.clientHeight || 56;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const values = [...traces].reverse().map((trace) => Number(trace.latencyMs) || 0).slice(-30);
  if (!values.length) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = "10px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("还没有一轮完整对话", width / 2, height / 2);
    return;
  }

  const max = Math.max(1, ...values);
  const step = width / Math.max(1, values.length - 1);
  const y = (value) => height - 6 - (value / max) * (height - 14);

  ctx.beginPath();
  values.forEach((value, index) => {
    const x = index * step;
    if (index === 0) ctx.moveTo(x, y(value));
    else ctx.lineTo(x, y(value));
  });
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = COLORS.green;
  ctx.stroke();

  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.closePath();
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "rgba(143,165,150,0.2)");
  gradient.addColorStop(1, "rgba(143,165,150,0)");
  ctx.fillStyle = gradient;
  ctx.fill();

  const last = values[values.length - 1];
  ctx.beginPath();
  ctx.arc((values.length - 1) * step, y(last), 2.4, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.accent;
  ctx.fill();
}

/* ───────────────────────── 渲染 ───────────────────────── */

function render(live) {
  view.live = live;
  view.lastFetch = Date.now();
  const emotion = live.emotion ?? {};

  $("#persona-name").textContent = live.persona?.name ?? "她";
  const sub = [
    `认识第 ${live.bond?.days ?? 1} 天`,
    live.bond?.phase ?? "初识",
    `记得 ${live.memory?.size ?? 0} 件`,
    live.demo ? "demo 模式" : "真实数据",
  ];
  $("#mon-sub").textContent = sub.join(" · ");
  $("#model-name").textContent = live.settings?.model ?? "—";

  const empty = !live.totals?.messages && !live.memory?.size;
  const banner = $("#demo-banner");
  banner.hidden = !empty;
  $("#seed").hidden = !live.demo;

  $("#mood-value").textContent = `心情 ${Number(emotion.mood ?? 0).toFixed(2)}`;
  $("#tone-line").textContent = emotion.tone || "她这会儿没有特别想说什么。";

  const stack = $("#layer-stack");
  stack.replaceChildren();
  const layers = emotion.layers ?? {};
  const meta = [
    ["背景", "background", "退得最慢，几十小时"],
    ["当下", "primary", "退得最快，几十分钟"],
    ["社交", "social", "只对你，几小时"],
  ];
  for (const [label, key, hint] of meta) {
    const values = layers[key] ?? [];
    const top = [...values].sort((a, b) => Number(b.value) - Number(a.value)).slice(0, 2);
    const row = el("div", "layer-row");
    const main = el("div", "layer-main");
    main.append(
      el("b", "", emotion[key] || "—"),
      el("small", "", top.length ? `${top.map((item) => `${item.label} ${Math.round(item.value)}`).join(" · ")} · ${hint}` : hint),
    );
    row.append(el("span", "layer-name", label), main, el("span", "layer-value", String(top[0] ? Math.round(top[0].value) : "—")));
    stack.append(row);
  }

  drawRadar(layers);
  $("#advice-line").textContent = emotion.advice ? `她会怎么表现：${emotion.advice}` : "";

  const causes = $("#cause-list");
  causes.replaceChildren();
  for (const cause of (emotion.causes ?? []).slice(0, 5)) {
    const chip = el("span", "cause-chip");
    chip.append(el("b", "", `${cause.kind} ${Number(cause.intensity ?? 0).toFixed(1)}`), document.createTextNode(`${cause.ageMinutes} 分钟前`));
    causes.append(chip);
  }

  const totals = live.totals ?? {};
  const vitals = $("#vitals");
  vitals.replaceChildren();
  const items = [
    ["回合", String(totals.turns ?? 0), `最近 ${totals.tracedTurns ?? 0} 轮有记录`, "gold"],
    ["消息", String(totals.messages ?? 0), `运行 ${duration(live.uptimeMs ?? 0)}`, ""],
    ["token", totals.totalTokens ? `${Math.round(totals.totalTokens / 1000 * 10) / 10}k` : "—", `${totals.promptTokens ?? 0} 进 / ${totals.completionTokens ?? 0} 出`, "green"],
    ["延迟", totals.avgLatencyMs ? `${totals.avgLatencyMs}ms` : "—", "最近 40 轮平均", ""],
  ];
  for (const [label, value, hint, tone] of items) {
    const tile = el("div", `vital ${tone}`.trim());
    tile.append(el("span", "", label), el("b", "", value), el("small", "", hint));
    vitals.append(tile);
  }

  drawSpark(live.traces ?? []);

  const bond = live.bond ?? {};
  $("#bond-phase").textContent = bond.phase ?? "—";
  $("#bond-days").textContent = bond.days ? `第 ${bond.days} 天` : "";
  $("#bond-line").textContent = bond.line ?? "";
  const bars = $("#bond-bars");
  bars.replaceChildren();
  const axisNames = { closeness: "亲近", trust: "信任", security: "安心", expression: "自在" };
  for (const [key, name] of Object.entries(axisNames)) {
    const value = Number(bond.axes?.[key] ?? 0);
    const row = el("div", "bond-bar");
    const track = el("div", "track");
    const fill = el("div", "fill");
    fill.style.width = `${pct(value)}%`;
    track.append(fill);
    row.append(el("span", "name", name), track, el("span", "num", String(Math.round(value))));
    bars.append(row);
  }

  const bondEvents = $("#bond-events");
  bondEvents.replaceChildren();
  for (const event of (bond.events ?? []).slice(-6).reverse()) {
    const chip = el("span", "bond-event");
    const delta = Object.values(event.deltas ?? {}).reduce((sum, value) => sum + Number(value), 0);
    chip.append(el("b", "", `${delta > 0 ? "+" : ""}${delta.toFixed(1)}`), document.createTextNode(` ${BOND_LABEL[event.kind] ?? event.kind}`));
    bondEvents.append(chip);
  }

  drawDonut(live.memory);
  $("#mem-cap").textContent = `${live.memory?.size ?? 0} / ${live.memory?.capacity ?? 500}`;
  const kindsBox = $("#mem-kinds");
  kindsBox.replaceChildren();
  const kinds = live.memory?.kinds ?? {};
  for (const [key, label] of Object.entries(KIND_LABEL)) {
    const row = el("div", "mem-kind");
    const dot = el("i");
    dot.style.background = KIND_COLOR[key];
    row.append(dot, el("span", "", label), el("b", "", String(kinds[key] ?? 0)));
    kindsBox.append(row);
  }
  const stats = $("#mem-stats");
  stats.replaceChildren();
  const statItems = [
    ["归档", String(live.memory?.archived ?? 0)],
    ["遗忘", String(live.memory?.forgotten ?? 0)],
    ["平均保留", `${Math.round(Number(live.memory?.averageRetention ?? 0) * 100)}%`],
    ["稳定度", Number(live.memory?.averageStability ?? 0).toFixed(1)],
  ];
  for (const [label, value] of statItems) {
    const tile = el("div", "mem-stat");
    tile.append(el("b", "", value), el("span", "", label));
    stats.append(tile);
  }

  $("#growth-total").textContent = `${live.growth?.total ?? 0} 条`;
  const growth = $("#growth-mini");
  growth.replaceChildren();
  const sections = live.growth?.sections ?? {};
  for (const [key, label, cap] of GROWTH) {
    const count = Number(sections[key] ?? 0);
    const row = el("div", "growth-row");
    const track = el("div", "track");
    const fill = el("div", "fill");
    fill.style.width = `${pct((count / cap) * 100)}%`;
    track.append(fill);
    row.append(el("span", "", label), track, el("b", "", `${count}/${cap}`));
    growth.append(row);
  }

  renderTurns(live.traces ?? []);
  renderFeed(live.events ?? []);
  renderChat(live.chat ?? []);
  renderBeliefs(live.beliefs ?? []);
  loadPrompt(live.traces ?? []);

  $("#updated").textContent = "刚刚更新";
}

function renderTurns(traces) {
  const table = $("#turn-table");
  table.replaceChildren();
  if (!traces.length) {
    table.append(el("div", "empty-note", "还没有一轮完整的对话。"));
    return;
  }
  const max = Math.max(1, ...traces.map((trace) => Number(trace.latencyMs) || 0));
  for (const trace of traces.slice(0, 10)) {
    const row = el("div", "turn");
    const said = el("span", "said", trace.userText || (trace.kind === "opening" ? "（她先开的口）" : "—"));
    said.title = trace.userText ?? "";
    const lat = el("div", "lat");
    const track = el("div", "track");
    const fill = el("div", "fill");
    fill.style.width = `${pct(((Number(trace.latencyMs) || 0) / max) * 100)}%`;
    track.append(fill);
    lat.append(track, el("b", "", `${trace.latencyMs ?? 0}ms`));
    row.append(
      el("time", "", clock(trace.at)),
      said,
      el("span", "chars", `${trace.chars ?? 0}字`),
      lat,
      el("span", `ok${trace.styleOk === false ? " bad" : ""}`, trace.styleOk === false ? "拦过" : "通过"),
    );
    table.append(row);
  }
}

function renderFeed(events) {
  const feed = $("#feed");
  if (!events.length) {
    feed.replaceChildren(el("div", "empty-note", "还没有事件。"));
    return;
  }
  if (!view.feedKeys.size) {
    feed.replaceChildren();
    for (const event of events.slice(0, 40)) {
      const key = eventKey(event);
      view.feedKeys.add(key);
      feed.append(feedNode(event, key));
    }
    return;
  }

  const known = new Set(events.map(eventKey));
  for (const key of [...view.feedKeys]) {
    if (!known.has(key)) view.feedKeys.delete(key);
  }
  const fresh = [];
  for (const event of events) {
    const key = eventKey(event);
    if (view.feedKeys.has(key)) continue;
    view.feedKeys.add(key);
    fresh.push({ event, key });
  }
  for (const item of fresh.reverse()) {
    feed.prepend(feedNode(item.event, item.key));
  }
  while (feed.children.length > 60) feed.lastElementChild?.remove();
}

function eventKey(event) {
  return event.id ?? `${event.at}|${event.type}|${event.title}`;
}

function feedNode(event, key) {
  const item = el("div", "feed-item");
  item.dataset.key = key;
  item.dataset.type = event.type ?? "";
  item.append(
    el("span", "feed-dot"),
    el("span", "feed-title", event.title ?? ""),
    el("span", "feed-detail", event.detail ?? ""),
    el("span", "feed-time", ago(event.at)),
  );
  return item;
}

function renderChat(chat) {
  const box = $("#chat-mini");
  box.replaceChildren();
  const messages = chat.slice(-8);
  $("#chat-count").textContent = `${messages.length} 条`;
  if (!messages.length) {
    box.append(el("div", "empty-note", "还没有说过话。"));
    return;
  }
  for (const message of messages) {
    const line = el("div", `chat-line ${message.role === "user" ? "user" : ""}`.trim(), message.text);
    line.append(el("small", "", clock(message.at)));
    box.append(line);
  }
  box.scrollTop = box.scrollHeight;
}

function renderBeliefs(beliefs) {
  const box = $("#belief-list");
  box.replaceChildren();
  $("#belief-count").textContent = `${beliefs.length} 条`;
  if (!beliefs.length) {
    box.append(el("div", "empty-note", "还没有自己的看法。"));
    return;
  }
  for (const belief of beliefs) {
    const chip = el("div", "belief");
    chip.append(document.createTextNode(belief.topic));
    chip.append(el("b", "", `${Math.round(Number(belief.confidence ?? 0) * 100)}%`));
    box.append(chip);
  }
}

async function loadPrompt(traces) {
  const latest = traces[0];
  if (!latest) {
    $("#prompt-total").textContent = "—";
    $("#prompt-blocks").replaceChildren(el("div", "empty-note", "聊过一轮之后，这里会显示真实的背景分块。"));
    $("#prompt-foot").textContent = "";
    return;
  }
  if (view.traceId === latest.id && view.prompt) {
    paintPrompt(view.prompt);
    return;
  }
  try {
    const trace = await api(`/api/traces/${encodeURIComponent(latest.id)}`);
    view.traceId = latest.id;
    view.prompt = trace;
    paintPrompt(trace);
  } catch {
    // 这一轮读不到就算了，不打断面板。
  }
}

function paintPrompt(trace) {
  const sections = trace?.prompt?.sections ?? [];
  const total = sections.reduce((sum, item) => sum + Number(item.chars ?? 0), 0);
  $("#prompt-total").textContent = `${total} 字`;
  const box = $("#prompt-blocks");
  box.replaceChildren();
  const max = Math.max(1, ...sections.map((item) => Number(item.chars ?? 0)));
  for (const section of sections) {
    const row = el("div", "prompt-block");
    const track = el("div", "track");
    const fill = el("div", "fill");
    fill.style.width = `${Math.max(2, (Number(section.chars ?? 0) / max) * 100)}%`;
    track.append(fill);
    row.append(el("span", "name", section.name), track, el("span", "chars", String(section.chars ?? 0)));
    box.append(row);
  }
  $("#prompt-foot").textContent = `最近一轮 · ${ago(trace.at)} · ${trace.reply?.latencyMs ?? 0} ms`;
}

/* ───────────────────────── 轮询 ───────────────────────── */

async function refresh() {
  if (view.paused) return;
  try {
    const live = await api("/api/live");
    $("#conn-state").textContent = "实时";
    render(live);
  } catch {
    $("#conn-state").textContent = "断开了";
  }
}

function startPolling() {
  clearInterval(view.timer);
  view.timer = setInterval(refresh, 2500);
}

function bind() {
  $("#pause").addEventListener("click", () => {
    view.paused = !view.paused;
    const button = $("#pause");
    button.textContent = view.paused ? "继续刷新" : "暂停刷新";
    button.classList.toggle("paused", view.paused);
  });

  $("#seed").addEventListener("click", async () => {
    try {
      const result = await api("/api/demo/seed", { method: "POST" });
      if (result?.state) render(result.live ?? view.live);
      await refresh();
    } catch (error) {
      $("#mon-sub").textContent = error.message;
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearInterval(view.timer);
    else if (!view.paused) {
      refresh();
      startPolling();
    }
  });

  window.addEventListener("resize", () => {
    if (!view.live) return;
    drawRadar(view.live.emotion?.layers);
    drawDonut(view.live.memory);
    drawSpark(view.live.traces ?? []);
  });
}

function tickClock() {
  const now = new Date();
  $("#clock").textContent = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  $("#today").textContent = now.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });
  if (view.lastFetch) {
    const seconds = Math.floor((Date.now() - view.lastFetch) / 1000);
    $("#updated").textContent = seconds <= 1 ? "刚刚更新" : `${seconds} 秒前更新`;
  }
}

async function boot() {
  bind();
  tickClock();
  view.clockTimer = setInterval(tickClock, 1000);
  await refresh();
  startPolling();
}

boot();
