/**
 * public/app.js — 前端全在这里，没有框架。
 *
 * 一条原则：界面上所有「她」的东西都从 /api/state 来，不写死。
 * 记忆、档案、关系、时间线都是可以点开看的——不让人看见的记忆系统，
 * 和没有记忆差不多。
 */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  data: null,
  tab: "memory",
  memories: null,
  growthFull: null,
  archivedOnly: false,
  busy: false,
  lastTrace: "",
  memoryQuery: "",
  memoryKind: "",
};

const KIND_LABEL = {
  fact: "事实",
  preference: "喜好",
  moment: "时刻",
  promise: "答应过",
  insight: "想明白的",
  self: "她自己",
};

const SECTION_LABEL = {
  traits: "你是什么样的人",
  self: "你怎么看自己",
  user: "你眼里的他",
  us: "你们之间",
  shadow: "你不肯承认的那部分",
  life: "你的日常",
};

const AXIS_LABEL = {
  closeness: "亲近",
  trust: "信任",
  security: "安心",
  expression: "自在",
};

/* ───────────────────────── 小工具 ───────────────────────── */

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style") {
      for (const [prop, val] of Object.entries(value)) {
        if (prop.startsWith("--")) node.style.setProperty(prop, val);
        else node.style[prop] = val;
      }
    }
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }
  for (const child of children.flat(3)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? `请求失败（${response.status}）`);
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}

let toastTimer = 0;
function toast(text) {
  const node = $("#toast");
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 3600);
}

function minute(ts) {
  if (!ts) return "—";
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function dayLabel(ts) {
  if (!ts) return "";
  const date = new Date(ts);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diff = Math.round((start - day) / 86_400_000);
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff < 7) return `${diff} 天前`;
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function ago(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function percent(value) {
  return `${Math.round(Number(value) * 100)}%`;
}

/* ───────────────────────── 启动 ───────────────────────── */

async function boot() {
  bind();
  try {
    state.data = await api("/api/state");
  } catch (error) {
    $("#status-line").textContent = "连不上服务端";
    toast(error.message);
    return;
  }
  renderAll();
  // demo 模式第一次打开不自动开口：先让人选「装入演示数据」还是「让她先开口」。
  if (state.data.opening && state.data.hasKey && !state.data.demo) {
    await requestOpening();
  }
}

async function requestOpening() {
  setBusy(true);
  showTyping();
  try {
    const result = await api("/api/open", { method: "POST" });
    if (result?.state) state.data = result.state;
    renderAll();
  } catch (error) {
    hideTyping();
    toast(error.message);
  } finally {
    setBusy(false);
    $("#input").focus();
  }
}

/* ───────────────────────── 绑定 ───────────────────────── */

function bind() {
  const input = $("#input");
  input.addEventListener("input", resizeInput);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  });

  $("#send").addEventListener("click", sendMessage);
  $("#btn-trace").addEventListener("click", () => openTrace());
  $("#btn-reflect").addEventListener("click", reflect);
  $("#btn-side").addEventListener("click", () => openSide(true));
  $("#close-side").addEventListener("click", () => openSide(false));
  $("#scrim").addEventListener("click", () => openSide(false));

  $("#tabs").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-tab]");
    if (!button) return;
    switchTab(button.dataset.tab);
  });

  $("#memory-search").addEventListener(
    "input",
    debounce(() => {
      state.memoryQuery = $("#memory-search").value.trim();
      loadMemories();
    }, 260),
  );
  $("#memory-kind").addEventListener("change", () => {
    state.memoryKind = $("#memory-kind").value;
    loadMemories();
  });
  $("#add-memory").addEventListener("submit", addMemory);
  window.addEventListener("resize", debounce(renderHeader, 200));

  $("#btn-growth-reset").addEventListener("click", () => resetScope("growth", "清空档案？快照会留着，可以退回来。"));
  $("#btn-reset-chat").addEventListener("click", () => resetScope("chat", "清空对话？记忆和档案会保留。"));
  $("#btn-reset-all").addEventListener("click", () => resetScope("all", "全部重置？对话、记忆、档案、关系都会归零。"));
  $("#settings-form").addEventListener("submit", saveSettings);
  $$("#settings-form input[name=temperature]").forEach((node) =>
    node.addEventListener("input", () => {
      $("#temp-value").textContent = Number(node.value).toFixed(2);
    }),
  );

  $("#modal-close").addEventListener("click", closeModal);
  $("#modal").addEventListener("click", (event) => {
    if (event.target === $("#modal")) closeModal();
  });

  $("#btn-seed")?.addEventListener("click", seedDemo);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!$("#modal").hidden) closeModal();
      else openSide(false);
    }
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 980) openSide(false);
  });
}

function debounce(fn, wait) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function resizeInput() {
  const input = $("#input");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

function setBusy(busy) {
  state.busy = busy;
  $("#send").disabled = busy;
  $("#input").disabled = busy;
  $("#btn-reflect").disabled = busy;
}

function openSide(open) {
  $("#side").classList.toggle("open", open);
  $("#scrim").hidden = !open;
  $("#btn-side").setAttribute("aria-expanded", String(open));
}

/* ───────────────────────── 渲染：整体 ───────────────────────── */

function renderAll() {
  renderHeader();
  renderMessages();
  renderPanel(state.tab);
}

function renderHeader() {
  const { persona, bond, timeline, hasKey, demo } = state.data;
  $("#persona-name").textContent = persona.name;
  $("#mark").textContent = [...persona.name][0] ?? "·";
  document.title = `${persona.name} · 会记得你的聊天角色`;
  const bits = [`认识 ${timeline.days} 天`, bond.phase];
  if (window.innerWidth > 560) bits.push(`记得 ${state.data.memory.size} 件`);
  $("#status-line").textContent = bits.join(" · ");
  $("#status-line").title = `${bits.join(" · ")} · 记得 ${state.data.memory.size} 件`;
  $("#pulse").classList.toggle("off", !hasKey && !demo);

  $("#key-hint").textContent = demo ? "demo 模式" : hasKey ? "" : "还没有 API key";
  const seedButton = $("#btn-seed");
  if (seedButton) {
    seedButton.hidden = !demo || state.data.memory.size > 0 || state.data.chat.messages.length > 0;
  }
  $("#key-hint").style.cursor = "pointer";
  $("#key-hint").onclick = () => {
    switchTab("settings");
    openSide(true);
  };
  if (!demo && !hasKey) {
    $("#hint").textContent = "先把 DEEPSEEK_API_KEY 填进 .env，或者 npm run demo 先看看";
  } else {
    $("#hint").textContent = "Enter 发送 · Shift + Enter 换行";
  }
}

/* ───────────────────────── 渲染：消息 ───────────────────────── */

function renderMessages() {
  const node = $("#messages");
  const messages = state.data.chat?.messages ?? [];
  const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 160;
  node.textContent = "";

  if (!messages.length) {
    node.append(emptyState());
    return;
  }

  let lastDay = "";
  let lastRole = "";
  for (const message of messages) {
    const day = dayLabel(message.at);
    if (day && day !== lastDay) {
      node.append(h("div", { class: "day", text: day }));
      lastDay = day;
    }
    const isHer = message.role === "her";
    const showAvatar = isHer && lastRole !== "her";
    const bubble = h("div", { class: "bubble", text: message.text });
    const children = [];
    if (isHer) {
      children.push(h("div", { class: showAvatar ? "avatar" : "avatar blank", "aria-hidden": "true", text: showAvatar ? $("#mark").textContent : "" }));
    }
    children.push(h("div", {}, bubble, h("div", { class: "meta", text: minute(message.at) })));
    node.append(h("div", { class: `msg ${isHer ? "her" : "user"}` }, ...children));
    lastRole = message.role;
  }

  if (nearBottom || messages.length <= 4) scrollToBottom();
}

function emptyState() {
  const { hasKey, demo } = state.data;
  const canOpen = hasKey || demo;
  const actions = [];
  if (canOpen) {
    actions.push(h("button", { class: "ghost", style: { marginTop: "18px" }, text: "让她先开口", onclick: requestOpening }));
  } else {
    actions.push(
      h("div", {
        style: { marginTop: "16px", fontSize: "12px" },
        text: "还没有配 DEEPSEEK_API_KEY。填进 .env，或者 npm run demo 先看看。",
      }),
    );
  }
  if (demo) {
    actions.push(
      h("button", {
        class: "ghost",
        style: { marginTop: "10px" },
        text: "装入一段演示数据",
        onclick: seedDemo,
      }),
      h("div", {
        style: { marginTop: "10px", fontSize: "11.5px", opacity: "0.7" },
        text: "一段没聊完的对话、八条记忆、六个格子的档案，还有一张亮着的监测面板。",
      }),
    );
  }
  return h(
    "div",
    { class: "empty" },
    h("strong", { text: "她还什么都不记得。" }),
    h("div", { text: "你们还没说过话。第一句话会长出第一段记忆——之后她会忘、会记牢、会慢慢长成另一个样子。" }),
    ...actions,
  );
}

async function seedDemo() {
  setBusy(true);
  try {
    const result = await api("/api/demo/seed", { method: "POST" });
    if (result?.state) state.data = result.state;
    renderAll();
    toast(result?.seeded ? "装好了。去「监测」看看她此刻的样子。" : result?.reason ?? "已经有数据了。");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

function showTyping() {
  hideTyping();
  const node = $("#messages");
  node.append(
    h(
      "div",
      { class: "typing", id: "typing", "aria-label": "她正在想" },
      h("i"),
      h("i"),
      h("i"),
    ),
  );
  scrollToBottom();
}

function hideTyping() {
  $("#typing")?.remove();
}

function scrollToBottom() {
  const node = $("#messages");
  node.scrollTop = node.scrollHeight;
}

async function sendMessage() {
  const input = $("#input");
  const text = input.value.trim();
  if (!text || state.busy) return;
  input.value = "";
  resizeInput();
  closeKeyboardHints();

  state.data.chat.messages.push({ id: `tmp-${Date.now()}`, role: "user", text, at: Date.now() });
  renderMessages();
  setBusy(true);
  showTyping();

  try {
    const result = await api("/api/chat", { method: "POST", body: { text } });
    state.data = result.state;
    state.lastTrace = result.traceId;
    hideTyping();
    renderAll();
    if (!soundOff()) subtlePulse();
  } catch (error) {
    hideTyping();
    renderMessages();
    toast(error.message);
    if (error.code === "NO_KEY") {
      $("#input").value = text;
    }
  } finally {
    setBusy(false);
    $("#input").focus();
  }
}

function closeKeyboardHints() {
  if (window.innerWidth <= 980) openSide(false);
}

function subtlePulse() {
  const pulse = $("#pulse");
  pulse.style.transition = "none";
  pulse.style.transform = "scale(1.6)";
  requestAnimationFrame(() => {
    pulse.style.transition = "transform .5s ease";
    pulse.style.transform = "";
  });
}

function soundOff() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}

/* ───────────────────────── 渲染：面板路由 ───────────────────────── */

function switchTab(tab) {
  state.tab = tab;
  $$("#tabs button").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  $$(".panel").forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === tab));
  renderPanel(tab);
}

function renderPanel(tab) {
  if (tab === "memory") {
    renderMemoryStats();
    if (!state.memories) loadMemories();
    else renderMemoryList();
  } else if (tab === "growth") {
    if (!state.growthFull) loadGrowth();
    else renderGrowth();
  } else if (tab === "bond") {
    renderBond();
  } else if (tab === "timeline") {
    renderTimeline();
  } else if (tab === "settings") {
    renderSettings();
  }
}

/* ───────────────────────── 记忆 ───────────────────────── */

async function loadMemories() {
  const params = new URLSearchParams();
  if (state.memoryQuery) params.set("q", state.memoryQuery);
  if (state.memoryKind) params.set("kind", state.memoryKind);
  if (state.archivedOnly) params.set("archived", "1");
  try {
    state.memories = await api(`/api/memories?${params}`);
  } catch (error) {
    toast(error.message);
    return;
  }
  renderMemoryStats();
  renderMemoryList();
}

function renderMemoryStats() {
  const stats = state.memories?.stats ?? state.data.memory;
  const forgotten = Number(stats.forgotten) || 0;
  $("#memory-stats").textContent = "";
  $("#memory-stats").append(
    h("span", {}, "记得 ", h("b", { text: String(stats.size) }), " 件"),
    h("span", {}, "容量 ", h("b", { text: String(stats.capacity) })),
    h("span", {}, "平均留存 ", h("b", { text: percent(stats.averageRetention) })),
    h("span", {}, state.archivedOnly ? "看的是归档" : `忘掉 ${stats.forgotten} 次`),
  );
  $("#side-sub").textContent = state.archivedOnly ? "已经归档的记忆" : `她记得 ${stats.size} 件，忘掉 ${stats.forgotten} 次`;
}

function renderMemoryList() {
  const list = $("#memory-list");
  const items = state.memories?.items ?? [];
  list.textContent = "";

  if (!items.length) {
    list.append(
      h("div", {
        class: "empty-line",
        text: state.archivedOnly
          ? "没有归档的。手动忘掉的只在下面留个痕迹。"
          : state.memoryQuery
            ? "没找到。她可能真的忘了。"
            : "还没有记忆。聊几句，她会自己捡。",
      }),
    );
  }

  for (const item of items) {
    const text = h("div", { class: "text", text: item.text });
    const actions = h("div", { class: "actions" });
    if (!item.archived) {
      actions.append(
        h("button", {
          class: "link",
          text: item.pinned ? "取消钉住" : "钉住",
          onclick: () => patchMemory(item.id, { pinned: !item.pinned }),
        }),
        h("button", { class: "link", text: "改", onclick: () => editMemory(item, text) }),
        h("button", {
          class: "link danger",
          text: "忘掉",
          onclick: async () => {
            if (!confirm(`让她忘掉「${item.text}」？\n会留一条「忘掉过」的痕迹。`)) return;
            try {
              state.memories = (await api(`/api/memories/${encodeURIComponent(item.id)}`, { method: "DELETE" })).memories;
              renderMemoryStats();
              renderMemoryList();
              toast("忘了。");
            } catch (error) {
              toast(error.message);
            }
          },
        }),
      );
    } else {
      actions.append(
        h("button", {
          class: "link",
          text: "恢复",
          onclick: () => patchMemory(item.id, { archived: false }),
        }),
      );
    }

    const retention = Number(item.retention) || 0;
    list.append(
      h(
        "div",
        { class: "memory-item" },
        h(
          "div",
          { class: "top" },
          h("span", { class: `kind ${item.kind}`, text: KIND_LABEL[item.kind] ?? item.kind }),
          h("span", { class: "age", text: item.pinned ? "钉住" : ago(item.createdAt) }),
        ),
        text,
        (item.evidence ?? []).length ? h("div", { class: "evidence", text: `「${item.evidence[0]}」` }) : null,
        h("div", { class: "bar" }, h("i", { style: { width: `${Math.max(6, retention * 100)}%` } })),
        actions,
      ),
    );
  }

  const forgotten = state.memories?.forgotten ?? [];
  if (state.archivedOnly && forgotten.length) {
    list.append(h("div", { class: "sub-head" }, h("span", { text: "已经忘掉的" })));
    for (const item of forgotten) {
      list.append(
        h(
          "div",
          { class: "memory-item forgotten" },
          h(
            "div",
            { class: "top" },
            h("span", { class: `kind ${item.kind}`, text: KIND_LABEL[item.kind] ?? item.kind }),
            h("span", { class: "age", text: `${ago(item.at)} · ${forgetReason(item.reason)}` }),
          ),
          h("div", { class: "text", text: item.text }),
        ),
      );
    }
  }

  const toggle = h("button", {
    class: "link",
    style: { display: "block", margin: "14px auto 0" },
    text: state.archivedOnly ? "回到记得的" : "看看忘掉的 / 归档的",
    onclick: () => {
      state.archivedOnly = !state.archivedOnly;
      loadMemories();
    },
  });
  list.append(toggle);
}

function forgetReason(reason) {
  const labels = { manual: "你让她忘的", expired: "放太久了", capacity: "位置不够了" };
  return labels[reason] ?? reason ?? "忘了";
}

function editMemory(item, textNode) {
  const input = h("input", { class: "inline-edit", value: item.text, maxlength: 80 });
  input.style.cssText =
    "width:100%;background:var(--bg-2);border:1px solid var(--line);border-radius:7px;padding:5px 8px;font-size:13px;outline:0;color:var(--text)";
  textNode.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async () => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (!value || value === item.text) {
      input.replaceWith(h("div", { class: "text", text: item.text }));
      return;
    }
    try {
      state.memories = (await api(`/api/memories/${encodeURIComponent(item.id)}`, { method: "PATCH", body: { text: value } }))
        .memories;
      renderMemoryList();
      toast("改了。");
    } catch (error) {
      toast(error.message);
      input.replaceWith(h("div", { class: "text", text: item.text }));
    }
  };
  input.addEventListener("blur", finish);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") input.blur();
    if (event.key === "Escape") {
      input.value = item.text;
      input.blur();
    }
  });
}

async function patchMemory(id, patch) {
  try {
    const result = await api(`/api/memories/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
    state.memories = result.memories;
    renderMemoryStats();
    renderMemoryList();
  } catch (error) {
    toast(error.message);
  }
}

async function addMemory(event) {
  event.preventDefault();
  const input = $("#new-memory-text");
  const text = input.value.trim();
  if (!text) return;
  try {
    const result = await api("/api/memories", {
      method: "POST",
      body: { text, kind: $("#new-memory-kind").value, importance: 0.65 },
    });
    state.memories = result.memories;
    input.value = "";
    renderMemoryStats();
    renderMemoryList();
    toast(result.merged ? "这件事她本来就知道，变牢了一点。" : "记住了。");
  } catch (error) {
    toast(error.message);
  }
}

/* ───────────────────────── 档案 ───────────────────────── */

async function loadGrowth() {
  try {
    state.growthFull = await api("/api/growth");
    renderGrowth();
  } catch (error) {
    toast(error.message);
  }
}

function renderGrowth() {
  const data = state.growthFull ?? { sections: state.data.growth.sections, snapshots: [] };
  const box = $("#growth-list");
  box.textContent = "";

  for (const [key, label] of Object.entries(SECTION_LABEL)) {
    const items = data.sections?.[key] ?? [];
    if (!items.length) continue;
    const section = h(
      "div",
      { class: "growth-section" },
      h("h3", {}, label, h("small", { text: `${items.length} 条` })),
    );
    for (const item of items) {
      section.append(
        h(
          "div",
          { class: "growth-item", style: { "--w": String(item.weight ?? 1) } },
          item.text,
          (item.evidence ?? []).length ? h("span", { class: "ev", text: `「${item.evidence[0]}」` }) : null,
        ),
      );
    }
    box.append(section);
  }

  if (!box.children.length) {
    box.append(h("div", { class: "empty-line", text: "档案还空着。它只从对话里长，不预置。" }));
  }

  const list = $("#snapshot-list");
  list.textContent = "";
  const snapshots = data.snapshots ?? [];
  if (!snapshots.length) {
    list.append(h("div", { class: "empty-line", text: "还没有快照。长第一条的时候会自动存。" }));
  }
  for (const snapshot of snapshots) {
    list.append(
      h(
        "div",
        { class: "snapshot" },
        h("b", { text: ago(snapshot.at) }),
        h("span", { text: snapshot.reason || "改动" }),
        h("span", { text: `${snapshot.count} 条` }),
        h("button", {
          class: "link",
          text: "退回",
          onclick: () => restoreGrowth(snapshot.id),
        }),
      ),
    );
  }
}

async function restoreGrowth(id) {
  if (!confirm("退回这一份？现在的档案会被替换，但会先存一份快照。")) return;
  try {
    state.growthFull = await api("/api/growth/restore", { method: "POST", body: { id } });
    state.data = await api("/api/state");
    renderGrowth();
    toast("退回来了。");
  } catch (error) {
    toast(error.message);
  }
}

async function resetScope(scope, question) {
  if (!confirm(question)) return;
  try {
    state.data = await api("/api/reset", { method: "POST", body: { scope } });
    state.memories = null;
    state.growthFull = null;
    renderAll();
    toast("重置了。文件已经归档，没有真删。");
  } catch (error) {
    toast(error.message);
  }
}

/* ───────────────────────── 关系 ───────────────────────── */

function renderBond() {
  const { bond, beliefs, timeline } = state.data;
  const seeds = state.data.persona?.beliefs ?? [];
  const grown = new Set((beliefs ?? []).map((item) => item.topic));
  const allBeliefs = [...seeds.filter((item) => !grown.has(item.topic)), ...(beliefs ?? [])];
  const box = $("#bond-view");
  box.textContent = "";

  box.append(
    h("div", { class: "phase", text: bond.phase }),
    h("div", { class: "phase-sub", text: `认识 ${timeline.days} 天 · 说过 ${timeline.turns} 轮` }),
  );

  for (const [axis, label] of Object.entries(AXIS_LABEL)) {
    const value = Number(bond.axes[axis]) || 0;
    box.append(
      h(
        "div",
        { class: "axis" },
        h("div", { class: "label" }, h("span", { text: label }), h("b", { text: String(Math.round(value)) })),
        h("div", { class: "track" }, h("i", { style: { width: `${value}%` } })),
      ),
    );
  }

  if (bond.line) box.append(h("div", { class: "bond-line", text: bond.line }));

  if (allBeliefs.length) {
    box.append(h("div", { class: "sub-head" }, h("span", { text: "她相信的" })));
    for (const belief of allBeliefs.slice(0, 8)) {
      box.append(
        h(
          "div",
          { class: "belief" },
          belief.topic,
          h("span", { class: "stance", text: `倾向 ${Math.round((Number(belief.stance) || 0) * 100)}` }),
        ),
      );
    }
  }

  if (bond.events?.length) {
    box.append(h("div", { class: "sub-head" }, h("span", { text: "最近发生的事" })));
    const line = bond.events
      .slice(-6)
      .reverse()
      .map((event) => `${ago(event.at)} · ${eventLabel(event.kind)}`)
      .join("\n");
    box.append(h("div", { class: "bond-line", text: line }));
  }
}

function eventLabel(kind) {
  const labels = {
    chat: "说了一会儿话",
    affection: "被靠近了一点",
    address: "叫了她一声",
    care: "被关心了",
    humor: "笑了一下",
    share: "听了一件事",
    question: "被问了一句",
    goodnight: "道了晚安",
    repair: "和好了",
    conflict: "顶了一句",
    scold: "被凶了",
    rejection: "被推开了",
    neglect: "被晾着",
    intimacy: "靠得很近",
  };
  return labels[kind] ?? "有点动静";
}

/* ───────────────────────── 时间线 ───────────────────────── */

function renderTimeline() {
  const { timeline, bond } = state.data;
  const box = $("#timeline-view");
  box.textContent = "";

  box.append(
    h("div", { class: "tl-hero" }, h("b", { text: String(timeline.days) }), h("span", { text: "天" })),
    h("div", { class: "phase-sub", text: `${bond.phase} · 从 ${new Date(timeline.since).toLocaleDateString("zh-CN")} 开始` }),
    h(
      "div",
      { class: "tl-stats" },
      stat(String(timeline.turns), "轮对话"),
      stat(String(timeline.memories), "条记忆"),
      stat(String(timeline.growth), "条档案"),
    ),
  );

  if (timeline.firsts?.length) {
    box.append(h("div", { class: "sub-head" }, h("span", { text: "第一次" })));
    const list = h("div", { class: "tl-list" });
    for (const item of timeline.firsts) {
      list.append(h("div", { class: "tl-item" }, item.label, h("time", { text: new Date(item.at).toLocaleString("zh-CN") })));
    }
    box.append(list);
  }

  if (timeline.milestones?.length) {
    box.append(h("div", { class: "sub-head" }, h("span", { text: "她还留着的" })));
    const list = h("div", { class: "tl-list" });
    for (const item of timeline.milestones) {
      list.append(
        h("div", { class: "tl-item" }, item.text, h("time", { text: `${KIND_LABEL[item.kind] ?? item.kind} · ${ago(item.at)}` })),
      );
    }
    box.append(list);
  }
}

function stat(value, label) {
  return h("div", { class: "tl-stat" }, h("b", { text: value }), h("span", { text: label }));
}

/* ───────────────────────── 设置 ───────────────────────── */

function renderSettings() {
  const settings = state.data.settings;
  const form = $("#settings-form");
  form.model.value = settings.model;
  form.temperature.value = settings.temperature;
  form.replyChars.value = settings.replyChars;
  form.recallLimit.value = settings.recallLimit;
  form.remember.checked = Boolean(settings.remember);
  form.depth.value = settings.depth;
  $("#temp-value").textContent = Number(settings.temperature).toFixed(2);

  const key = $("#key-state");
  key.classList.toggle("warn", !state.data.hasKey && !state.data.demo);
  if (state.data.demo) {
    key.textContent = "现在跑在 demo 模式：回话是预置的，但记忆、档案、关系都是真走流程。填上 key 再用 npm start，就是真模型。";
  } else if (state.data.hasKey) {
    key.textContent = `API key 已配置（来源：${state.data.keySource === "env" ? "环境变量" : ".env 文件"}）。它不会出现在页面或导出文件里。`;
  } else {
    key.textContent = "没有找到 DEEPSEEK_API_KEY。在仓库根目录复制 .env.example 为 .env，填上 key 再重启。";
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const result = await api("/api/settings", {
      method: "PUT",
      body: {
        model: form.model.value.trim(),
        temperature: Number(form.temperature.value),
        replyChars: Number(form.replyChars.value),
        recallLimit: Number(form.recallLimit.value),
        remember: form.remember.checked,
        depth: form.depth.value,
      },
    });
    state.data.settings = result.settings;
    toast("保存了。下一轮就生效。");
  } catch (error) {
    toast(error.message);
  }
}

/* ───────────────────────── 整理 / 透视 ───────────────────────── */

async function reflect() {
  if (state.busy) return;
  const button = $("#btn-reflect");
  button.disabled = true;
  button.textContent = "整理中…";
  try {
    const result = await api("/api/reflect", { method: "POST" });
    state.data = result.state;
    state.memories = null;
    state.growthFull = null;
    state.lastTrace = result.traceId;
    renderAll();
    const counts = result.counts ?? { memories: 0, growth: 0, beliefs: 0 };
    toast(`整理完了：记忆 +${counts.memories}，档案 +${counts.growth}，看法 +${counts.beliefs}。`);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "整理记忆";
  }
}

async function openTrace(id) {
  const traceId = id || state.lastTrace || state.data.traces?.[0]?.id;
  if (!traceId) {
    toast("还没有可以透视的一轮。先说句话。");
    return;
  }
  try {
    const trace = await api(`/api/traces/${encodeURIComponent(traceId)}`);
    renderTrace(trace);
    $("#modal").hidden = false;
  } catch (error) {
    toast(error.message);
  }
}

function renderTrace(trace) {
  $("#modal-title").textContent = `透视 · ${trace.kind === "opening" ? "她先开口" : trace.kind === "reflect" ? "整理" : "这一轮"}`;
  const body = $("#modal-body");
  body.textContent = "";

  const select = h(
    "select",
    {
      style: { marginBottom: "16px", width: "100%" },
      onchange: (event) => openTrace(event.target.value),
    },
    ...(state.data.traces ?? []).map((item) =>
      h(
        "option",
        { value: item.id, selected: item.id === trace.id },
        `${new Date(item.at).toLocaleString("zh-CN")} · ${item.userText || "（她开口）"}`,
      ),
    ),
  );
  body.append(select);

  body.append(
    block(
      "这一轮",
      trace.userText ? h("div", { class: "trace-quote", text: trace.userText }) : h("div", { class: "ok-line", text: "她没有等对方说话。" }),
      h(
        "div",
        { class: "kv", style: { marginTop: "10px" } },
        h("dt", { text: "回话" }),
        h("dd", { text: trace.bubbles.join(" / ") || "—" }),
        h("dt", { text: "耗时" }),
        h("dd", { text: `${trace.reply.latencyMs} ms · ${trace.reply.model}` }),
        h("dt", { text: "字数" }),
        h("dd", { text: String(trace.reply.chars) }),
      ),
    ),
  );

  const before = trace.emotion.before ?? {};
  const after = trace.emotion.after ?? {};
  body.append(
    block(
      "情绪",
      h(
        "div",
        { class: "kv" },
        h("dt", { text: "说之前" }),
        h("dd", { text: `${before.background} / ${before.primary} / ${before.social}` }),
        h("dt", { text: "说之后" }),
        h("dd", { text: `${after.background} / ${after.primary} / ${after.social}` }),
        h("dt", { text: "解读" }),
        h("dd", { text: trace.classified?.kind ? eventLabel(trace.classified.kind) : "没读出明显偏向" }),
      ),
    ),
  );

  body.append(
    block(
      `想起了 ${trace.recall.length} 条`,
      trace.recall.length
        ? h(
            "div",
            {},
            ...trace.recall.map((item) =>
              h(
                "div",
                { class: "trace-recall" },
                h("span", { class: "score", text: Number(item.score ?? 0).toFixed(2) }),
                item.text,
                item.evidence?.length ? h("div", { class: "ev", text: `「${item.evidence[0]}」` }) : null,
              ),
            ),
          )
        : h("div", { class: "ok-line", text: "这一轮没有哪条记忆被想起来。这是允许的。" }),
    ),
  );

  if (trace.prompt?.sections?.length) {
    const max = Math.max(...trace.prompt.sections.map((section) => section.chars), 1);
    const list = h("div", {});
    for (const section of trace.prompt.sections) {
      list.append(
        h(
          "details",
          { style: { marginBottom: "6px" } },
          h(
            "summary",
            { style: { cursor: "pointer", fontSize: "12px", color: "var(--text-dim)" } },
            `${section.name} · ${section.chars} 字`,
          ),
          h("div", {
            style: {
              fontSize: "11.5px",
              color: "var(--muted)",
              whiteSpace: "pre-wrap",
              marginTop: "6px",
              borderLeft: "2px solid var(--line)",
              paddingLeft: "8px",
              lineHeight: "1.8",
            },
            text: section.text,
          }),
          h("div", { class: "section-bar" }, h("span", { text: "" }), h("div", { class: "fill" }, h("i", { style: { width: `${(section.chars / max) * 100}%` } }))),
        ),
      );
    }
    body.append(block(`prompt 共 ${trace.prompt.chars} 字`, list));
  }

  const wrote = trace.wrote;
  body.append(
    block(
      "写进去了",
      wrote
        ? h(
            "div",
            {},
            wrote.memories?.length
              ? h("div", { style: { fontSize: "12.5px" } }, `记忆 +${wrote.memories.length}`, h("div", { class: "ev", text: wrote.memories.map((m) => m.text).join("；") }))
              : null,
            wrote.growth?.length ? h("div", { style: { fontSize: "12.5px", marginTop: "6px" } }, `档案 +${wrote.growth.length}`) : null,
            wrote.beliefs?.length ? h("div", { style: { fontSize: "12.5px", marginTop: "6px" } }, `看法：${wrote.beliefs.join("、")}`) : null,
            !wrote.memories?.length && !wrote.growth?.length && !wrote.beliefs?.length
              ? h("div", { class: "ok-line", text: "这一轮没有值得长期留下的东西。" })
              : null,
          )
        : h("div", { class: "ok-line", text: trace.extractionSkipped || "这一轮不做抽取。" }),
      trace.extractionError ? h("div", { class: "issue", text: `抽取失败：${trace.extractionError}` }) : null,
    ),
  );

  const style = trace.style ?? {};
  body.append(
    block(
      "像不像她",
      style.ok
        ? h("div", { class: "ok-line", text: "这一句在允许的范围里：长度、问句、自称都正常。" })
        : h(
            "div",
            {},
            ...(style.issues ?? []).map((issue) => h("div", { class: "issue", text: issueText(issue) })),
          ),
    ),
  );
}

function issueText(issue) {
  const labels = {
    too_long: "太长了，像在写说明",
    too_many_sentences: "句子太多",
    too_many_questions: "一次问了不止一个",
    assistant: "露出了「助手」的口吻",
    list: "用了列表",
    self_explain: "解释了自己是什么",
    markdown: "用了 Markdown",
  };
  return labels[issue] ?? String(issue);
}

function block(title, ...children) {
  return h("section", { class: "trace-block" }, h("h3", { text: title }), ...children);
}

function closeModal() {
  $("#modal").hidden = true;
}

/* ───────────────────────── 启动 ───────────────────────── */

boot();
