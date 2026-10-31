/**
 * mechanisms.js — 机制说明页。
 *
 * 数据都从本机的 /api 拉：没有一条是写死在页面上的示例（除了还没有数据时的示意）。
 * 这里不渲染任何用户输入成 HTML，全部走 textContent。
 */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const COLORS = {
  accent: "#d8a86a",
  green: "#8fa596",
  rose: "#c98f82",
  violet: "#9a8fc0",
  teal: "#7fa8a0",
  line: "#2b2822",
  muted: "#8d8677",
  text: "#e9e3d6",
};

const GROWTH_SECTIONS = [
  ["traits", "她是什么样的人", 8],
  ["self", "她怎么看自己", 8],
  ["user", "她眼里的你", 10],
  ["us", "你们之间", 10],
  ["shadow", "她不肯说的", 6],
  ["life", "她一个人的生活", 8],
];

const KIND_LABEL = {
  fact: "事实",
  preference: "喜好",
  moment: "时刻",
  promise: "答应过",
  insight: "想明白的",
  self: "她自己",
};

/* ───────────────────────── 一轮对话的十个站点 ───────────────────────── */

const STAGES = [
  {
    name: "危机识别",
    where: "core/crisis.js · 永远第一步",
    desc: "先分清「她该怎么回」和「这个人现在安不安全」。出现自伤、暴力、失控的迹象时，人设让位，先给出一句稳的话和可用的求助方向。",
    note: "这一层不参与调情，也不参与角色扮演。它只做一件事：确认没有人在危险里。",
    code: "if (crisis.level > 0) { … 先安全，再说话 }",
  },
  {
    name: "载入人格",
    where: "persona.mjs · personas/&lt;name&gt;/",
    desc: "读 persona.json 和六个 Markdown。她是谁、怎么说话、喜欢什么、底线在哪，都在文件里；不是模型参数，也不藏在代码里。",
    note: "换一个目录就是换一个人。演示人格在 personas/zhiyao-demo/，温柔、母性、有点腹黑，白纸开局。",
    code: "loadPersona(\"personas/zhiyao-demo\")",
  },
  {
    name: "照亮此刻",
    where: "runtime.mjs · 此刻",
    desc: "现在几点、今天星期几、上次说话隔了多久、是不是深夜。同样一句「在吗」，凌晨三点和下午三点的分量不一样。",
    note: "「此刻」是唯一每轮都会变的一块背景，也是她不会把昨天当成今天的原因。",
    code: "此刻 = 时间 + 间隔 + 天气（可选）",
  },
  {
    name: "召回记忆",
    where: "core/recall.js · 最多 6 条",
    desc: "先按话题找相关的，再乘上保留率、重要性和当前心情的偏置。允许一条都想不起来——那她就会老实说「我有点忘了」。",
    note: "只有真的被说出口的记忆才会被加固。存在库里但从不提起的事，会慢慢沉下去。",
    code: "score = 相关度 × 保留率 × 重要性 × 心情偏置",
  },
  {
    name: "算情绪",
    where: "core/emotion.js · 三层",
    desc: "背景、当下、社交三层各自按自己的半衰期退潮，再叠成「这会儿」的她。一次小事能推动当下，但推不动整个背景。",
    note: "情绪不是装饰：它决定句子多长、要不要开玩笑、愿不愿意示弱。",
    code: "background 20–96h · primary 0.4–1h · social 3.5–6h",
  },
  {
    name: "读关系",
    where: "bond.mjs · 四个方向",
    desc: "亲近、信任、安全感、表达欲。没有总分，也不拿一个数字概括你们。四个方向决定她能开什么玩笑、能不能说重话。",
    note: "三天不说话，关系会自己往回退一点。不是惩罚，是太久没见真的会生疏。",
    code: "closeness / trust / security / expression",
  },
  {
    name: "拼背景",
    where: "prompt.mjs · 七块",
    desc: "人格、此刻、记得的、眼里的、相信的、怎么记、怎么说，最后压一条底线。按「少 / 正常 / 多」裁剪，不把所有东西一次塞满。",
    note: "顺序有讲究：人格在最前，底线在最后。越靠后的规则，越像临出门前又被叮嘱了一遍。",
    code: "buildChatSystem({ persona, emotion, memories, growth, bond })",
  },
  {
    name: "说话",
    where: "model.mjs · deepseek-chat",
    desc: "把背景和最近 18 条对话交给模型。温度 1.05，一次最多 360 token——留一点即兴，但不让她写成一篇作文。",
    note: "没有 Key 也能跑：demo 模式会走本地假模型，把整条链路走通，只是话比较笨。",
    code: "temperature 1.05 · max_tokens 360",
  },
  {
    name: "拆成气泡",
    where: "text.mjs · 1–3 句",
    desc: "清掉 AI 腔和括号动作，再按句子拆成一到三条。真人不会把一段话一次说完，也不会每句都带省略号。",
    note: "如果拆完太不像她，风格规则会拦一次，让她重说；再不过就接受，不无限重试。",
    code: "cleanReply → splitBubbles → style.check",
  },
  {
    name: "写回",
    where: "extract.mjs · 一轮之后",
    desc: "从这一轮里抽记忆、档案、看法，推一下情绪和关系。只写她听见的，带原话做证据；写不进就不写，不硬编。",
    note: "每一笔写回都会进「透视」：为什么记住、为什么长档案、为什么情绪变了，事后都能查。",
    code: "extract → memories / growth / beliefs / bond / emotion",
  },
];

/* ───────────────────────── 基础 ───────────────────────── */

async function api(path, options) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message ?? `请求失败（${response.status}）`);
  return data;
}

function setText(node, text) {
  if (node) node.textContent = text ?? "";
}

function pct(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function retention(ageDays, stability) {
  return Math.pow(1 + Math.max(0, ageDays) / Math.max(0.5, stability), -0.6);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ───────────────────────── 流水线 ───────────────────────── */

function renderPipeline() {
  const list = $("#pipeline-list");
  if (!list) return;
  STAGES.forEach((stage, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `stage${index === 0 ? " on" : ""}`;
    button.dataset.index = String(index);
    const badge = el("span", "stage-index", String(index + 1).padStart(2, "0"));
    const text = el("span", "stage-text");
    text.append(el("b", "", stage.name), el("small", "", stage.where.replace(/&lt;[^&]*&gt;/g, "")));
    button.append(badge, text);
    button.addEventListener("click", () => selectStage(index));
    item.append(button);
    list.append(item);
  });
  selectStage(0);
}

function selectStage(index) {
  const stage = STAGES[index];
  if (!stage) return;
  $$(".stage").forEach((node) => node.classList.toggle("on", node.dataset.index === String(index)));
  const detail = $("#stage-detail");
  detail.replaceChildren();
  detail.append(
    el("div", "num", `STEP ${String(index + 1).padStart(2, "0")} / ${String(STAGES.length).padStart(2, "0")}`),
    el("h3", "", stage.name),
    el("div", "where", stage.where.replace(/&lt;/g, "<").replace(/&gt;/g, ">")),
    el("p", "", stage.desc),
    el("div", "note", stage.note),
    el("code", "code-line", stage.code),
  );
}

/* ───────────────────────── 衰减曲线 ───────────────────────── */

function drawDecay() {
  const canvas = $("#decay-canvas");
  if (!canvas) return;
  const age = Number($("#age-range")?.value ?? 30);
  const stability = Number($("#stability-range")?.value ?? 12);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.clientWidth || 600;
  const height = canvas.clientHeight || 260;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const pad = { top: 12, right: 18, bottom: 26, left: 36 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const maxDays = 180;

  ctx.font = "10px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i += 1) {
    const value = i / 4;
    const y = pad.top + plotH * (1 - value);
    ctx.strokeStyle = "rgba(233,227,214,0.07)";
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(`${Math.round(value * 100)}%`, pad.left - 8, y);
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const days of [0, 30, 60, 90, 120, 150, 180]) {
    const x = pad.left + (days / maxDays) * plotW;
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(days === 0 ? "今天" : `${days}天`, x, height - pad.bottom + 8);
  }

  const curves = [
    { stability: 3, color: "rgba(154,143,192,0.5)", width: 1.2 },
    { stability: 12, color: "rgba(143,165,150,0.55)", width: 1.2 },
    { stability: 40, color: "rgba(216,168,106,0.5)", width: 1.2 },
    { stability, color: COLORS.accent, width: 2 },
  ];

  for (const curve of curves) {
    ctx.beginPath();
    for (let step = 0; step <= 180; step += 1) {
      const x = pad.left + (step / maxDays) * plotW;
      const y = pad.top + plotH * (1 - retention(step, curve.stability));
      if (step === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = curve.color;
    ctx.lineWidth = curve.width;
    ctx.stroke();
  }

  const value = retention(age, stability);
  const x = pad.left + (age / maxDays) * plotW;
  const y = pad.top + plotH * (1 - value);
  ctx.strokeStyle = "rgba(216,168,106,0.4)";
  ctx.setLineDash([3, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, pad.top);
  ctx.lineTo(x, pad.top + plotH);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = COLORS.accent;
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(18,17,15,0.8)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = COLORS.accent;
  ctx.font = "600 11px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillText(`${Math.round(value * 100)}%`, Math.min(x + 8, width - 42), y - 6);

  setText($("#curve-value"), `${Math.round(value * 100)}`);
  if ($("#curve-value")) {
    $("#curve-value").append(el("small", "", "%"));
  }
  setText($("#age-label"), String(age));
  setText($("#stability-label"), String(stability));
}

/* ───────────────────────── 召回预览 ───────────────────────── */

async function runRecall(query) {
  const list = $("#recall-list");
  const meta = $("#recall-meta");
  if (!list) return;
  const text = String(query ?? "").trim();
  if (!text) {
    list.replaceChildren(el("div", "empty-note", "先写一句话，再让她想。"));
    setText(meta, "");
    return;
  }
  list.replaceChildren(el("div", "empty-note", "她在想…"));
  try {
    const result = await api("/api/recall-preview", {
      method: "POST",
      body: JSON.stringify({ query: text }),
    });
    meta.replaceChildren(
      el("span", "", "候选池 "),
      el("b", "", `${result.pool} 条`),
      el("span", "", "上限 "),
      el("b", "", `${result.limit} 条`),
      el("span", "", "当前心情 "),
      el("b", "", Number(result.mood).toFixed(2)),
      el("span", "", "允许一条都想不起来"),
    );
    list.replaceChildren();
    if (!result.items.length) {
      list.append(
        el("div", "empty-note", "这次她一条都没想起来。不是坏了——记忆本来就会淡，也允许对不上。"),
      );
      return;
    }
    for (const item of result.items) {
      const card = el("div", "recall-item");
      const top = el("div", "recall-item-top");
      const body = el("div");
      body.append(el("p", "", item.text));
      const chips = el("div", "recall-meta");
      chips.style.margin = "6px 0 0";
      chips.append(
        el("span", "kind-chip", KIND_LABEL[item.kind] ?? item.kind),
        el("span", "", item.anchored ? "被加固过" : "没再被提起"),
      );
      body.append(chips);
      top.append(body, el("span", "score", Number(item.score ?? 0).toFixed(3)));
      card.append(top);

      const bars = el("div", "recall-bars");
      const rows = [
        ["相关度", item.cue ?? 0, "gold"],
        ["保留率", item.retention ?? 0, ""],
        ["重要性", item.importance ?? 0, "violet"],
      ];
      for (const [name, value, tone] of rows) {
        const bar = el("div", "mini-bar");
        const label = el("span", "", `${name} ${(Number(value) * 100).toFixed(0)}%`);
        const track = el("div", "track");
        const fill = el("div", `fill ${tone}`.trim());
        fill.style.width = `${pct(Number(value) * 100)}%`;
        track.append(fill);
        bar.append(label, track);
        bars.append(bar);
      }
      card.append(bars);
      list.append(card);
    }
  } catch (error) {
    list.replaceChildren(el("div", "empty-note", `没跑起来：${error.message}`));
  }
}

/* ───────────────────────── 情绪雷达 ───────────────────────── */

function drawRadar(layers) {
  const canvas = $("#radar");
  if (!canvas) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.clientWidth || 380;
  const height = canvas.clientHeight || 380;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const cx = width / 2;
  const cy = height / 2 + 4;
  const radius = Math.min(width, height) * 0.32;
  const axes = layers?.background ?? [];
  const count = axes.length || 6;
  const angle = (index) => -Math.PI / 2 + (index / count) * Math.PI * 2;

  ctx.lineWidth = 1;
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
    ctx.strokeStyle = `rgba(233,227,214,${ring === 4 ? 0.14 : 0.07})`;
    ctx.stroke();
  }

  for (let i = 0; i < count; i += 1) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle(i)) * radius, cy + Math.sin(angle(i)) * radius);
    ctx.strokeStyle = "rgba(233,227,214,0.07)";
    ctx.stroke();
  }

  const series = [
    ["background", "rgba(216,168,106,0.62)", "rgba(216,168,106,0.1)"],
    ["primary", "rgba(201,143,130,0.72)", "rgba(201,143,130,0.1)"],
    ["social", "rgba(143,165,150,0.7)", "rgba(143,165,150,0.08)"],
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
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  ctx.font = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.fillStyle = COLORS.muted;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  axes.forEach((item, i) => {
    const x = cx + Math.cos(angle(i)) * (radius + 26);
    const y = cy + Math.sin(angle(i)) * (radius + 24);
    ctx.fillText(item.label, x, y);
  });

  ctx.fillStyle = COLORS.muted;
  ctx.font = "10px 'SFMono-Regular', Consolas, monospace";
  ctx.fillText("0", cx, cy + 12);
}

/* ───────────────────────── 面板渲染 ───────────────────────── */

function renderLive(live) {
  setText($("#version-badge"), `v${live.version}`);
  setText($("#stat-memories"), String(live.memory?.size ?? 0));
  setText($("#stat-growth"), String(live.growth?.total ?? 0));
  setText($("#stat-days"), String(live.bond?.days ?? 0));
  setText($("#stat-turns"), String(live.totals?.turns ?? 0));

  const emotion = live.emotion ?? {};
  setText($("#emotion-title"), `${live.persona?.name ?? "她"}此刻`);
  const layerList = $("#layer-list");
  if (layerList) {
    layerList.replaceChildren();
    const rows = [
      ["背景", emotion.background, "退得最慢：几十小时"],
      ["当下", emotion.primary, "退得最快：几十分钟"],
      ["社交", emotion.social, "几小时：只对你有"],
    ];
    for (const [name, value, hint] of rows) {
      const row = el("div", "layer-row");
      row.append(el("span", "label", name), el("span", "text", `${value || "—"} · ${hint}`));
      layerList.append(row);
    }
  }
  setText($("#emotion-advice"), emotion.advice ? `她会怎么表现：${emotion.advice}` : "");
  drawRadar(emotion.layers);

  const bond = live.bond ?? {};
  setText($("#bond-phase"), bond.phase ?? "—");
  setText($("#bond-days"), bond.days ? `认识第 ${bond.days} 天` : "");
  const bars = $("#bond-bars");
  if (bars) {
    bars.replaceChildren();
    const names = { closeness: "亲近", trust: "信任", security: "安全感", expression: "表达欲" };
    for (const [key, name] of Object.entries(names)) {
      const value = Number(bond.axes?.[key] ?? 0);
      const row = el("div", "bond-bar");
      const track = el("div", "track");
      const fill = el("div", "fill");
      fill.style.width = `${pct(value)}%`;
      track.append(fill);
      row.append(el("span", "name", name), track, el("span", "num", String(Math.round(value))));
      bars.append(row);
    }
  }
  setText($("#bond-line"), bond.line ?? "");

  const grid = $("#growth-grid");
  if (grid) {
    grid.replaceChildren();
    const counts = live.growth?.sections ?? {};
    const samples = live.growth?.samples ?? {};
    for (const [key, label, cap] of GROWTH_SECTIONS) {
      const count = Number(counts[key] ?? 0);
      const cell = el("div", "growth-cell");
      cell.append(el("div", "name", label));
      cell.append(el("p", "sample", samples[key] || "还没有长出来。"));
      const countRow = el("div", "count");
      countRow.append(el("b", "", String(count)), el("span", "", `/ ${cap}`));
      const track = el("div", "track");
      const fill = el("div", "fill");
      fill.style.width = `${pct((count / cap) * 100)}%`;
      track.append(fill);
      cell.append(countRow, track);
      grid.append(cell);
    }
  }

  const beliefs = $("#belief-list");
  if (beliefs) {
    beliefs.replaceChildren();
    const list = Array.isArray(live.beliefs) ? live.beliefs : [];
    if (!list.length) {
      beliefs.append(el("span", "hint", "还没有自己的看法。聊得够多，她才会慢慢有立场。"));
    }
    for (const belief of list) {
      const chip = el("span", "belief");
      chip.append(document.createTextNode(belief.topic));
      const confidence = Math.round(Number(belief.confidence ?? 0) * 100);
      chip.append(el("b", "", `${confidence}%`));
      beliefs.append(chip);
    }
  }
}

/* ───────────────────────── Prompt 分块 ───────────────────────── */

const FALLBACK_SECTIONS = [
  { name: "人格", chars: 1480 },
  { name: "此刻", chars: 120 },
  { name: "记得的", chars: 420 },
  { name: "眼里的", chars: 260 },
  { name: "相信的", chars: 180 },
  { name: "怎么记", chars: 90 },
  { name: "怎么说", chars: 160 },
  { name: "底线", chars: 70 },
];

function renderPrompt(trace) {
  const sections = trace?.prompt?.sections?.length ? trace.prompt.sections : FALLBACK_SECTIONS;
  const totalChar = sections.reduce((sum, item) => sum + Number(item.chars ?? 0), 0);
  setText($("#prompt-total"), trace ? `${totalChar} 字 · 来自最近一轮` : "示意图");
  setText(
    $("#prompt-note"),
    trace
      ? "这是她上一次开口时实际拿到的背景。字数越多，不等于越有用。"
      : "聊过一轮之后，这里会显示真实的 prompt 分块；现在先看结构。",
  );
  const box = $("#prompt-blocks");
  if (!box) return;
  box.replaceChildren();
  const max = Math.max(...sections.map((item) => Number(item.chars ?? 0)), 1);
  for (const section of sections) {
    const row = el("div", "prompt-block");
    const name = el("span", "name", section.name);
    const track = el("div", "track");
    const fill = el("div", "fill");
    fill.style.width = `${Math.max(2, (Number(section.chars ?? 0) / max) * 100)}%`;
    track.append(fill);
    row.append(name, track, el("span", "chars", `${section.chars ?? 0} 字`));
    box.append(row);
  }
  const flow = $("#prompt-flow");
  if (flow) {
    flow.replaceChildren();
    flow.append(
      el("span", "", "人格"),
      el("i", "", "→"),
      el("span", "", "此刻"),
      el("i", "", "→"),
      el("span", "", "记忆"),
      el("i", "", "→"),
      el("span", "", "档案"),
      el("i", "", "→"),
      el("span", "", "看法"),
      el("i", "", "→"),
      el("span", "", "写法"),
      el("i", "", "→"),
      el("span", "", "底线"),
    );
  }
}

async function loadPrompt() {
  try {
    const result = await api("/api/traces");
    const first = result.items?.[0];
    if (!first) return renderPrompt(null);
    const trace = await api(`/api/traces/${encodeURIComponent(first.id)}`);
    renderPrompt(trace);
  } catch {
    renderPrompt(null);
  }
}

/* ───────────────────────── 最近一轮透视 ───────────────────────── */

function renderTrace(trace) {
  const card = $("#trace-card");
  if (!card) return;
  card.replaceChildren();
  if (!trace) {
    card.append(el("div", "empty-note", "还没有透视。去聊一句，再回来。"));
    return;
  }
  const head = el("div", "trace-meta");
  head.append(
    el("span", "", `最近一轮 · ${new Date(trace.at).toLocaleString("zh-CN", { hour12: false })}`),
    el("span", "", "耗时 "),
    el("b", "", `${trace.reply?.latencyMs ?? 0} ms`),
    el("span", "", "背景 "),
    el("b", "", `${trace.prompt?.chars ?? 0} 字`),
    el("span", "", `回复 ${trace.reply?.chars ?? 0} 字`),
  );
  card.append(head);

  const said = el("div", "trace-recall");
  const userLine = el("div", "item");
  userLine.append(el("b", "", "他说的"), document.createTextNode(trace.userText || "（她先开的口）"));
  said.append(userLine);
  for (const bubble of trace.bubbles ?? []) {
    const line = el("div", "item");
    line.append(el("b", "", "她回的"), document.createTextNode(bubble));
    said.append(line);
  }
  card.append(said);

  const wrote = trace.wrote ?? {};
  const flow = el("div", "trace-flow");
  const bits = [
    ["想起", `${(trace.recall ?? []).length} 条`],
    ["记住", `${(wrote.memories ?? []).length} 条`],
    ["档案", `${wrote.growth ?? 0} 条`],
    ["情绪", trace.emotion?.before?.primary ? `${trace.emotion.before.primary} → ${trace.emotion.after?.primary ?? "—"}` : "—"],
  ];
  for (const [label, value] of bits) {
    flow.append(el("span", "", `${label}：${value}`));
  }
  card.append(flow);

  if ((trace.recall ?? []).length) {
    const list = el("div", "trace-recall");
    for (const memory of trace.recall) {
      const item = el("div", "item");
      item.append(el("b", "", memory.text ?? ""));
      item.append(
        document.createTextNode(
          `相关 ${Number(memory.score ?? 0).toFixed(2)} · 保留 ${(Number(memory.retention ?? 0) * 100).toFixed(0)}%`,
        ),
      );
      list.append(item);
    }
    card.append(list);
  }
}

async function loadTrace() {
  try {
    const result = await api("/api/traces");
    const first = result.items?.[0];
    if (!first) return renderTrace(null);
    renderTrace(await api(`/api/traces/${encodeURIComponent(first.id)}`));
  } catch {
    renderTrace(null);
  }
}

/* ───────────────────────── 启动 ───────────────────────── */

function bindControls() {
  $("#age-range")?.addEventListener("input", drawDecay);
  $("#stability-range")?.addEventListener("input", drawDecay);
  $("#recall-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    runRecall($("#recall-input")?.value);
  });
  window.addEventListener("resize", () => {
    drawDecay();
  });
}

async function boot() {
  renderPipeline();
  bindControls();
  drawDecay();

  try {
    const live = await api("/api/live");
    renderLive(live);
  } catch {
    // 服务端没起来时，页面仍然可读。
  }

  loadPrompt();
  loadTrace();

  setInterval(async () => {
    try {
      renderLive(await api("/api/live"));
    } catch {
      // 断线不打扰阅读。
    }
  }, 5000);

  const reveal = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          reveal.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.08 },
  );
  $$(".reveal").forEach((node) => reveal.observe(node));
}

boot();
