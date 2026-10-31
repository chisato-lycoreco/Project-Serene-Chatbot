/**
 * brain.js — 把她的记忆、档案、看法画成一张图。
 *
 * 没有图数据库，也没有力导向布局：节点位置由「属于哪一格 + 第几条」算出来，
 * 所以每次打开都在同一个地方。画布只读，点开一个节点才显示它的原文与证据。
 */

const $ = (selector) => document.querySelector(selector);

const COLORS = {
  accent: "#d8a86a",
  green: "#8fa596",
  rose: "#c98f82",
  violet: "#9a8fc0",
  teal: "#7fa8a0",
  muted: "#8d8677",
  text: "#e9e3d6",
  line: "#2b2822",
  root: "#d8a86a",
};

const KIND = {
  fact: ["事实", "#d8a86a"],
  preference: ["喜好", "#8fa596"],
  moment: ["时刻", "#c98f82"],
  promise: ["答应过", "#9a8fc0"],
  insight: ["想明白的", "#7fa8a0"],
  self: ["她自己", "#b9a58a"],
};

const GROWTH = [
  ["traits", "性格", 8],
  ["self", "自己", 8],
  ["user", "眼里", 10],
  ["us", "之间", 10],
  ["shadow", "暗处", 6],
  ["life", "日常", 8],
];

const MODE_DESC = {
  growth: "从对话里长出来的六个格子。点一个，看它凭什么长成这样。",
  memory: "每一颗都是她记得的一件事。越靠外，越新；越大，越重要。",
  belief: "她自己攒下来的看法。越靠近中心，她越有底气。",
};

const canvas = $("#brain-canvas");
const wrap = $(".brain-wrap");
const ctx = canvas.getContext("2d");
const tip = $("#brain-tip");
const detail = $("#brain-detail");

const store = {
  persona: { name: "知遥", summary: "" },
  growth: {},
  memories: [],
  beliefs: [],
  bond: null,
  days: 0,
  mode: "growth",
  nodes: [],
  edges: [],
  zoom: 1,
  pan: { x: 0, y: 0 },
  dragging: false,
  moved: 0,
  hover: null,
  selected: null,
  pointer: { x: 0, y: 0 },
  start: null,
  dpr: 1,
  width: 0,
  height: 0,
};

/* ───────────────────────── 数据 ───────────────────────── */

async function api(path) {
  const response = await fetch(path);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message ?? `请求失败（${response.status}）`);
  return data;
}

async function load() {
  try {
    const [state, memories] = await Promise.all([api("/api/state"), api("/api/memories")]);
    store.persona = state.persona ?? store.persona;
    store.growth = state.growth?.sections ?? {};
    store.beliefs = Array.isArray(state.beliefs) ? state.beliefs : [];
    store.bond = state.bond;
    store.days = state.timeline?.days ?? 1;
    store.memories = (memories.items ?? []).slice(0, 220);
    $("#conn").textContent = "本地数据";
    $("#brain-sub").textContent = `${store.persona.name} · 认识第 ${store.days} 天 · ${store.bond?.phase ?? "初识"}`;
    build();
    renderStats();
    draw();
  } catch (error) {
    $("#conn").textContent = "读不到";
    $("#brain-sub").textContent = error.message;
  }
}

function build() {
  const nodes = [];
  const edges = [];
  const root = {
    id: "root",
    type: "root",
    label: store.persona.name,
    sub: "白纸版",
    x: 0,
    y: 0,
    r: 58,
  };
  nodes.push(root);

  if (store.mode === "growth") {
    GROWTH.forEach(([key, label, cap], index) => {
      const angle = -Math.PI / 2 + (index / GROWTH.length) * Math.PI * 2;
      const items = Array.isArray(store.growth[key]) ? store.growth[key] : [];
      const anchor = {
        id: `sec_${key}`,
        type: "section",
        section: key,
        label,
        count: items.length,
        cap,
        angle,
        x: Math.cos(angle) * 172,
        y: Math.sin(angle) * 172,
        r: 27,
        color: COLORS.accent,
      };
      nodes.push(anchor);
      edges.push({ from: root, to: anchor, color: "rgba(216,168,106,0.26)" });
      items.forEach((item, i) => {
        const n = items.length;
        const spread = n === 1 ? 0 : Math.min(1.02, 0.26 + n * 0.075);
        const itemAngle = angle + (n === 1 ? 0 : (i / (n - 1) - 0.5) * spread);
        const ring = 286 + (i % 2) * 34;
        const node = {
          id: item.id ?? `g_${key}_${i}`,
          type: "growth",
          section: key,
          sectionLabel: label,
          label: item.text,
          text: item.text,
          evidence: item.evidence ?? [],
          weight: Number(item.weight ?? 1),
          createdAt: item.createdAt,
          x: Math.cos(itemAngle) * ring,
          y: Math.sin(itemAngle) * ring,
          r: 7 + Math.min(7, Number(item.weight ?? 1) * 1.6),
          color: COLORS.accent,
        };
        nodes.push(node);
        edges.push({ from: anchor, to: node, color: "rgba(216,168,106,0.14)" });
      });
    });
  }

  if (store.mode === "memory") {
    const groups = new Map(Object.keys(KIND).map((key) => [key, []]));
    for (const memory of store.memories) {
      if (!groups.has(memory.kind)) groups.set(memory.kind, []);
      groups.get(memory.kind).push(memory);
    }
    const entries = [...groups.entries()];
    entries.forEach(([kind, items], index) => {
      if (!items.length) return;
      const angle = -Math.PI / 2 + (index / entries.length) * Math.PI * 2;
      const [label, color] = KIND[kind] ?? [kind, COLORS.muted];
      const anchor = {
        id: `kind_${kind}`,
        type: "section",
        section: kind,
        label,
        count: items.length,
        cap: null,
        angle,
        x: Math.cos(angle) * 164,
        y: Math.sin(angle) * 164,
        r: 24,
        color,
      };
      nodes.push(anchor);
      edges.push({ from: root, to: anchor, color: `${color}55` });
      const sorted = [...items].sort((a, b) => Number(b.importance ?? 0) - Number(a.importance ?? 0));
      sorted.forEach((memory, i) => {
        const n = sorted.length;
        const spread = n === 1 ? 0 : Math.min(1.5, 0.2 + n * 0.12);
        const itemAngle = angle + (n === 1 ? 0 : (i / (n - 1) - 0.5) * spread);
        const ring = 270 + (i % 4) * 26;
        const node = {
          id: memory.id,
          type: "memory",
          kind: memory.kind,
          section: kind,
          sectionLabel: label,
          label: memory.text,
          text: memory.text,
          evidence: memory.evidence ?? [],
          importance: Number(memory.importance ?? 0.5),
          createdAt: memory.createdAt,
          x: Math.cos(itemAngle) * ring,
          y: Math.sin(itemAngle) * ring,
          r: 5 + Number(memory.importance ?? 0.5) * 8,
          color,
        };
        nodes.push(node);
        edges.push({ from: anchor, to: node, color: `${color}33` });
      });
    });
  }

  if (store.mode === "belief") {
    store.beliefs.forEach((belief, i) => {
      const confidence = Math.max(0, Math.min(1, Number(belief.confidence ?? 0.3)));
      const angle = -Math.PI / 2 + i * 2.39996;
      const ring = 300 - confidence * 112;
      const node = {
        id: `belief_${i}`,
        type: "belief",
        label: belief.topic,
        text: belief.topic,
        confidence,
        stance: Number(belief.stance ?? 0),
        evidenceCount: Number(belief.evidence ?? 0),
        updatedAt: belief.updatedAt,
        x: Math.cos(angle) * ring,
        y: Math.sin(angle) * ring,
        r: 9 + confidence * 9,
        color: COLORS.violet,
      };
      nodes.push(node);
      edges.push({ from: root, to: node, color: "rgba(154,143,192,0.24)" });
    });
  }

  store.nodes = nodes;
  store.edges = edges;
  store.selected = null;
  detail.hidden = true;
  updateEmpty();
}

function updateEmpty() {
  const empty = $("#brain-empty");
  const count =
    store.mode === "growth"
      ? GROWTH.reduce((sum, [key]) => sum + (store.growth[key]?.length ?? 0), 0)
      : store.mode === "memory"
        ? store.memories.length
        : store.beliefs.length;
  empty.hidden = count > 0;
  if (count === 0) {
    $("#brain-empty-text").textContent =
      store.mode === "growth"
        ? "还没有长出档案。聊几轮，让她自己形成看法。"
        : store.mode === "memory"
          ? "还没有记住任何事。说一句，她就有第一颗了。"
          : "还没有自己的看法。她不会凭空有立场。";
  }
}

function renderStats() {
  const box = $("#brain-stats");
  const growthTotal = GROWTH.reduce((sum, [key]) => sum + (store.growth[key]?.length ?? 0), 0);
  const rows = [
    ["记忆", `${store.memories.length} 条`, ""],
    ["档案", `${growthTotal} 条`, "gold"],
    ["看法", `${store.beliefs.length} 条`, ""],
    ["关系", store.bond?.phase ?? "初识", ""],
  ];
  box.replaceChildren();
  for (const [label, value, tone] of rows) {
    const row = document.createElement("div");
    row.className = `brain-stat ${tone}`.trim();
    const b = document.createElement("b");
    b.textContent = value;
    const span = document.createElement("span");
    span.textContent = label;
    row.append(span, b);
    box.append(row);
  }
}

/* ───────────────────────── 投影 ───────────────────────── */

function viewport() {
  const rect = wrap.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

function baseScale() {
  const { width, height } = viewport();
  return Math.min(width, height) / 780;
}

function project(node) {
  const { width, height } = viewport();
  const scale = baseScale() * store.zoom;
  return {
    x: width / 2 + store.pan.x + node.x * scale,
    y: height / 2 + store.pan.y + node.y * scale,
    r: Math.max(2.5, node.r * scale),
    scale,
  };
}

function findNode(x, y) {
  for (let i = store.nodes.length - 1; i >= 0; i -= 1) {
    const node = store.nodes[i];
    const p = project(node);
    const padding = node.type === "root" ? 0 : 5;
    if ((x - p.x) ** 2 + (y - p.y) ** 2 <= (p.r + padding) ** 2) return node;
  }
  return null;
}

/* ───────────────────────── 画 ───────────────────────── */

function resize() {
  const { width, height } = viewport();
  store.width = width;
  store.height = height;
  store.dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * store.dpr);
  canvas.height = Math.round(height * store.dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
}

function draw() {
  const time = performance.now();
  const { width, height } = viewport();
  const compact = width < 620;
  if (width !== store.width || height !== store.height) resize();
  const dpr = store.dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // 关系线
  for (const edge of store.edges) {
    const a = project(edge.from);
    const b = project(edge.to);
    const gradient = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    gradient.addColorStop(0, edge.color);
    gradient.addColorStop(1, "rgba(233,227,214,0.03)");
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  for (const node of store.nodes) {
    const p = project(node);
    const hovered = store.hover?.id === node.id;
    const selected = store.selected?.id === node.id;
    const pulse = 1 + Math.sin(time / 1700 + (node.angle ?? 0)) * 0.018;

    if (node.type === "root") {
      const radius = p.r * pulse;
      const glow = ctx.createRadialGradient(p.x, p.y, radius * 0.2, p.x, p.y, radius * 2.4);
      glow.addColorStop(0, "rgba(216,168,106,0.18)");
      glow.addColorStop(1, "rgba(216,168,106,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * 2.4, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      const fill = ctx.createRadialGradient(p.x - radius * 0.3, p.y - radius * 0.35, 4, p.x, p.y, radius);
      fill.addColorStop(0, "rgba(216,168,106,0.18)");
      fill.addColorStop(1, "rgba(23,22,19,0.98)");
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = "rgba(216,168,106,0.5)";
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = COLORS.text;
      ctx.font = `500 ${Math.max(15, 23 * p.scale)}px "Iowan Old Style", "Songti SC", serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(node.label, p.x, p.y - 4);
      ctx.fillStyle = COLORS.muted;
      ctx.font = `${Math.max(7, 9 * p.scale)}px -apple-system, sans-serif`;
      ctx.fillText(node.sub, p.x, p.y + Math.max(10, 14 * p.scale));
      continue;
    }

    if (node.type === "section") {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (hovered ? 1.12 : 1), 0, Math.PI * 2);
      ctx.fillStyle = "rgba(23,22,19,0.92)";
      ctx.fill();
      ctx.strokeStyle = hovered || selected ? node.color : `${node.color}88`;
      ctx.lineWidth = hovered || selected ? 1.6 : 1;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1.5, 2.2 * p.scale), 0, Math.PI * 2);
      ctx.fillStyle = node.color;
      ctx.fill();

      ctx.fillStyle = hovered ? COLORS.text : "rgba(233,227,214,0.78)";
      ctx.font = `500 ${Math.max(9, 11.5 * p.scale)}px -apple-system, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(node.label, p.x, p.y + p.r + 5);
      ctx.fillStyle = COLORS.muted;
      ctx.font = `${Math.max(8, 9 * p.scale)}px "SFMono-Regular", monospace`;
      ctx.fillText(String(node.count), p.x, p.y - p.r - 12);
      continue;
    }

    // 普通节点
    const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 2.2);
    glow.addColorStop(0, `${node.color}33`);
    glow.addColorStop(1, `${node.color}00`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * 2.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * (hovered ? 1.3 : 1), 0, Math.PI * 2);
    ctx.fillStyle = hovered ? node.color : `${node.color}cc`;
    ctx.fill();
    if (selected) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.text;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 窄屏默认只标大类，细节点靠点开右侧卡片看全文，避免文字互相压住。
    const alwaysLabel = !compact && (store.zoom > 1.35 || store.nodes.length <= 22);
    const showLabel = hovered || selected || alwaysLabel || node.type === "section" || node.type === "root";
    if (showLabel) {
      ctx.fillStyle = hovered ? COLORS.text : "rgba(233,227,214,0.68)";
      ctx.font = `${Math.max(9, 10.5 * p.scale)}px -apple-system, sans-serif`;
      const limit = compact ? 9 : 16;
      const label = node.label.length > limit ? `${[...node.label].slice(0, limit).join("")}…` : node.label;
      if (compact) {
        // 窄屏把标签收回节点内侧，避免贴边被裁掉。
        ctx.textBaseline = "middle";
        if (p.x > width * 0.62) {
          ctx.textAlign = "right";
          ctx.fillText(label, p.x - p.r - 4, p.y);
        } else if (p.x < width * 0.38) {
          ctx.textAlign = "left";
          ctx.fillText(label, p.x + p.r + 4, p.y);
        } else {
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText(label, p.x, p.y + p.r + 4);
        }
      } else {
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(label, p.x + p.r + 6, p.y);
      }
    }
  }

  requestAnimationFrame(draw);
}

/* ───────────────────────── 交互 ───────────────────────── */

function pointerPosition(event) {
  const rect = wrap.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function showTip(node) {
  if (!node) {
    tip.hidden = true;
    return;
  }
  const label = node.type === "section" ? `${node.label} · ${node.count} 条` : node.label;
  tip.textContent = label.length > 42 ? `${[...label].slice(0, 42).join("")}…` : label;
  tip.hidden = false;
  const { x, y } = store.pointer;
  tip.style.left = `${Math.min(x + 14, store.width - 240)}px`;
  tip.style.top = `${Math.max(8, y - 34)}px`;
}

function setHover(node) {
  if (store.hover?.id === node?.id) return;
  store.hover = node;
  canvas.style.cursor = node ? "pointer" : "grab";
  showTip(node);
}

function openDetail(node) {
  if (!node) {
    detail.hidden = true;
    store.selected = null;
    return;
  }
  store.selected = node;
  detail.hidden = false;
  const kind = $("#detail-kind");
  const title = $("#detail-title");
  const text = $("#detail-text");
  const meta = $("#detail-meta");
  const evidence = $("#detail-evidence");
  meta.replaceChildren();
  evidence.replaceChildren();
  evidence.hidden = true;

  if (node.type === "root") {
    kind.textContent = "人格";
    title.textContent = store.persona.name ?? "她";
    text.textContent = store.persona.summary || store.persona.role || "她是谁，写在一个可以打开的文件里。";
    for (const trait of store.persona.traits ?? []) {
      const tag = document.createElement("span");
      tag.textContent = trait;
      meta.append(tag);
    }
    return;
  }

  if (node.type === "section") {
    kind.textContent = store.mode === "growth" ? "档案 · 一格" : "记忆 · 一类";
    title.textContent = `${node.label} · ${node.count} 条`;
    text.textContent =
      store.mode === "growth"
        ? "这一格里的话，是她从对话里慢慢认下来的。写满之后，新的一句要挤掉旧的一条。"
        : "同一类的记忆放在一起。它们各自的保留率不一样，常被说起的会留下。";
    const items =
      store.mode === "growth"
        ? (store.growth[node.section] ?? []).map((item) => item.text)
        : store.memories.filter((memory) => memory.kind === node.section).map((memory) => memory.text);
    if (items.length) {
      evidence.hidden = false;
      for (const line of items.slice(0, 6)) {
        const quote = document.createElement("blockquote");
        quote.textContent = line;
        evidence.append(quote);
      }
    }
    return;
  }

  if (node.type === "growth") {
    kind.textContent = "档案";
    title.textContent = node.text;
    text.textContent = "她认下来的关于你、关于自己、关于你们之间的一句话。";
    for (const [label, value] of [
      ["格子", node.sectionLabel],
      ["权重", String(node.weight)],
      ["日期", node.createdAt ? new Date(node.createdAt).toLocaleDateString("zh-CN") : "—"],
    ]) {
      const tag = document.createElement("span");
      tag.textContent = `${label} ${value}`;
      meta.append(tag);
    }
    if (node.evidence.length) {
      evidence.hidden = false;
      for (const line of node.evidence) {
        const quote = document.createElement("blockquote");
        quote.textContent = `他说过：「${line}」`;
        evidence.append(quote);
      }
    }
    return;
  }

  if (node.type === "memory") {
    kind.textContent = `记忆 · ${KIND[node.kind]?.[0] ?? node.kind}`;
    title.textContent = node.text;
    text.textContent = "这是她记住的一件事。只有真的被说出来，它才会被再加固一次。";
    for (const [label, value] of [
      ["重要性", Number(node.importance).toFixed(2)],
      ["日期", node.createdAt ? new Date(node.createdAt).toLocaleDateString("zh-CN") : "—"],
    ]) {
      const tag = document.createElement("span");
      tag.textContent = `${label} ${value}`;
      meta.append(tag);
    }
    if (node.evidence.length) {
      evidence.hidden = false;
      for (const line of node.evidence) {
        const quote = document.createElement("blockquote");
        quote.textContent = `原话：「${line}」`;
        evidence.append(quote);
      }
    }
    return;
  }

  kind.textContent = "看法";
  title.textContent = node.text;
  text.textContent = "她自己的立场。听得越多、被印证得越多，底气才越足。";
  for (const [label, value] of [
    ["底气", `${Math.round(node.confidence * 100)}%`],
    ["立场", node.stance.toFixed(2)],
    ["听过", `${node.evidenceCount} 次`],
  ]) {
    const tag = document.createElement("span");
    tag.textContent = `${label} ${value}`;
    meta.append(tag);
  }
}

function bind() {
  canvas.addEventListener("pointerdown", (event) => {
    store.dragging = true;
    store.moved = 0;
    const point = pointerPosition(event);
    store.start = { x: point.x, y: point.y, pan: { ...store.pan } };
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add("dragging");
  });

  canvas.addEventListener("pointermove", (event) => {
    const point = pointerPosition(event);
    store.pointer = point;
    if (store.dragging && store.start) {
      const dx = point.x - store.start.x;
      const dy = point.y - store.start.y;
      store.moved = Math.max(store.moved, Math.hypot(dx, dy));
      store.pan = { x: store.start.pan.x + dx, y: store.start.pan.y + dy };
      tip.hidden = true;
      return;
    }
    const node = findNode(point.x, point.y);
    setHover(node);
  });

  canvas.addEventListener("pointerup", (event) => {
    const point = pointerPosition(event);
    if (store.moved < 6) {
      const node = findNode(point.x, point.y);
      if (node) openDetail(node);
      else {
        store.selected = null;
        detail.hidden = true;
      }
    }
    store.dragging = false;
    store.start = null;
    canvas.classList.remove("dragging");
    setHover(findNode(point.x, point.y));
  });

  canvas.addEventListener("pointerleave", () => {
    store.dragging = false;
    setHover(null);
    tip.hidden = true;
  });

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0012);
      store.zoom = Math.max(0.55, Math.min(2.8, store.zoom * factor));
    },
    { passive: false },
  );

  $("#zoom-in").addEventListener("click", () => {
    store.zoom = Math.min(2.8, store.zoom * 1.2);
  });
  $("#zoom-out").addEventListener("click", () => {
    store.zoom = Math.max(0.55, store.zoom / 1.2);
  });
  $("#zoom-reset").addEventListener("click", () => {
    store.zoom = 1;
    store.pan = { x: 0, y: 0 };
  });

  $("#detail-close").addEventListener("click", () => {
    detail.hidden = true;
    store.selected = null;
  });

  document.querySelectorAll(".brain-modes button").forEach((button) => {
    button.addEventListener("click", () => {
      if (store.mode === button.dataset.mode) return;
      store.mode = button.dataset.mode;
      document.querySelectorAll(".brain-modes button").forEach((node) => {
        node.classList.toggle("on", node === button);
      });
      $("#mode-desc").textContent = MODE_DESC[store.mode];
      store.zoom = 1;
      store.pan = { x: 0, y: 0 };
      build();
      renderStats();
    });
  });

  window.addEventListener("resize", resize);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) load();
  });
}

bind();
load();
requestAnimationFrame(draw);
