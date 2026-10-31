/**
 * src/demo.mjs — 没配 key 也能把整套记忆走一遍。
 *
 * 它不是「假装模型」：回话是写死的，抽取是按关键词写死的，只看最近一句。
 * 这样 demo 里长出来的记忆是真实走完「抽取 → 归一化 → 去重 → 召回」的，
 * 不是提前塞好的假数据。想看真模型，把 DEEPSEEK_API_KEY 填上就行。
 */

const REPLIES = [
  {
    match: /加班|累|困|下班|通勤|地铁/,
    text: "这个点还没到家啊。\n站着都能睡着，说明今天是真的撑到头了。先喝口水，别急着回我。",
  },
  {
    match: /不喜欢|讨厌|人多|吵/,
    text: "人多的地方是挺耗人的。不是不合群，就是得一直绷着。\n你是在哪种场合最明显？",
  },
  {
    match: /面试|工作|辞职|换工作/,
    text: "面试啊。你准备到哪一步了？\n不用一下子说完，想到哪讲到哪。",
  },
  {
    match: /猫|狗|宠物/,
    text: "猫好。它不哄你，但它会过来挨着你坐。\n你的是哪种脾气？",
  },
  {
    match: /睡不着|失眠|夜里/,
    text: "这个点还醒着。\n不用硬睡，我陪你坐一会儿。",
  },
  {
    match: /你好|在吗|hi|hello/i,
    text: "在。\n你说。",
  },
];

const FALLBACK = [
  "嗯，我在听。",
  "这句我记下了。\n你接着说。",
  "听起来不像随口一提。\n是最近才这样的吗？",
];

let fallbackIndex = 0;

/** demo 的回话：只看最近一句，命中关键词就说那一句。 */
export function demoReply({ messages = [] } = {}) {
  const last = [...messages].reverse().find((message) => message.role === "user");
  const text = String(last?.content ?? "");
  for (const item of REPLIES) {
    if (item.match.test(text)) return { text: item.text, model: "demo", latencyMs: 0, usage: null };
  }
  const reply = FALLBACK[fallbackIndex % FALLBACK.length];
  fallbackIndex += 1;
  return { text: reply, model: "demo", latencyMs: 0, usage: null };
}

/**
 * demo 的抽取：按关键词决定这一轮记住什么。
 * 故意做得笨——它展示的是管道，不是模型能力。
 */
export function demoExtract({ userText = "", now = Date.now() } = {}) {
  const text = String(userText);
  const memories = [];
  const growth = [];
  const beliefs = [];

  if (/加班|下班|通勤|地铁|上班/.test(text)) {
    memories.push({
      text: "他工作很忙，经常加班到很晚",
      kind: "fact",
      importance: 0.72,
      evidence: [clip(text, 24)],
      createdAt: now,
    });
    growth.push({ section: "user", text: "他累的时候不太会主动说，得问", evidence: [clip(text, 24)] });
  }
  if (/不喜欢|讨厌|人多|吵/.test(text)) {
    memories.push({
      text: "他不喜欢人多、吵闹的地方",
      kind: "preference",
      importance: 0.62,
      evidence: [clip(text, 24)],
      createdAt: now,
    });
  }
  if (/面试|辞职|换工作/.test(text)) {
    memories.push({
      text: "他最近在准备面试、想换工作",
      kind: "fact",
      importance: 0.8,
      evidence: [clip(text, 24)],
      createdAt: now,
    });
    growth.push({ section: "user", text: "他对工作的事想得比说出来的多", evidence: [clip(text, 24)] });
  }
  if (/猫|狗|宠物/.test(text)) {
    memories.push({
      text: "他养了一只猫",
      kind: "fact",
      importance: 0.7,
      evidence: [clip(text, 24)],
      createdAt: now,
    });
  }
  if (/睡不着|失眠/.test(text)) {
    memories.push({
      text: "他夜里容易睡不着",
      kind: "fact",
      importance: 0.68,
      evidence: [clip(text, 24)],
      createdAt: now,
    });
  }
  if (/答应|说好|下次|以后/.test(text)) {
    memories.push({
      text: "他答应过一件事，还没做",
      kind: "promise",
      importance: 0.75,
      evidence: [clip(text, 24)],
      createdAt: now,
    });
  }

  if (/至少|其实|说到底|我觉得/.test(text) && beliefs.length === 0) {
    beliefs.push({ topic: "把话说清楚比猜来猜去好", stance: 0.6, weight: 1 });
  }

  return { memories, growth, beliefs };
}

function clip(text, max) {
  const chars = Array.from(String(text ?? "").replace(/\s+/g, " ").trim());
  return chars.length > max ? chars.slice(0, max).join("") : chars.join("");
}
