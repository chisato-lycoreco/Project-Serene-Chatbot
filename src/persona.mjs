/**
 * src/persona.mjs — 人格是数据，不是代码。
 *
 * 一个人格包是一个目录：
 *   persona.json   结构化字段（名字、关系、性格词、说话方式、底线、初始看法）
 *   identity.md    她是谁（长文）
 *   voice.md       她怎么说话（长文）
 *   tastes.md      她喜欢什么、讨厌什么
 *   life.md        她自己的那点生活
 *   boundaries.md  她不会做的事
 *   opening.md     第一次见面时的那几句约束
 *
 * .md 都是可选的；只写 persona.json 也能跑。换人格只要换一个目录，
 * 不用改一行代码——这是「白纸版」的意思：纸给你，字自己写。
 */

import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { normalizeBeliefs } from "./core/beliefs.js";
import { BASELINE, normalizeLayer } from "./core/emotion.js";

export const PERSONA_SECTIONS = Object.freeze(["identity", "voice", "life", "tastes", "boundaries", "opening"]);
const PROMPT_SECTIONS = Object.freeze(["identity", "voice", "life", "tastes", "boundaries"]);

export function loadPersona(source, { root = process.cwd() } = {}) {
  const path = resolvePersonaPath(source, root);
  const stat = statSync(path);
  const dir = stat.isDirectory() ? path : null;
  const file = dir ? join(dir, "persona.json") : path;
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return definePersona(raw, { path: file, dir });
}

export function definePersona(raw, { path = "", dir = null } = {}) {
  const name = String(raw?.name ?? "").trim();
  if (!name) throw new Error(`人格档案缺少 name：${path || "(inline)"}`);

  const list = (value) =>
    Array.isArray(value)
      ? value.map((item) => String(item).trim()).filter(Boolean)
      : [];

  const sections = {};
  for (const key of PERSONA_SECTIONS) {
    const text = dir ? readOptional(join(dir, `${key}.md`)) : "";
    if (text) sections[key] = text;
  }

  const id = String(raw?.id ?? "").trim() || (dir ? basename(dir) : basename(path, ".json")) || "persona";
  return {
    id,
    name,
    path,
    dir,
    role: String(raw?.role ?? "").trim(),
    summary: String(raw?.summary ?? "").trim(),
    traits: list(raw?.traits),
    speech: list(raw?.speech),
    boundaries: list(raw?.boundaries),
    sections,
    beliefs: normalizeBeliefs(raw?.beliefs),
    baseline: {
      background: normalizeLayer(raw?.baseline?.background, BASELINE.background),
      primary: normalizeLayer(raw?.baseline?.primary, BASELINE.primary),
      social: normalizeLayer(raw?.baseline?.social, BASELINE.social),
    },
  };
}

function resolvePersonaPath(source, root) {
  const value = String(source ?? "").trim();
  if (!value) throw new Error("没有指定人格档案");
  const base = isAbsolute(value) ? value : resolve(root, value);
  if (isDirectory(base)) return base;
  if (isFile(base)) return base;
  const withJson = base.endsWith(".json") ? base : `${base}.json`;
  if (isFile(withJson)) return withJson;
  throw new Error(`读不到人格档案：${withJson}`);
}

/**
 * 人格 → 一段可以进 system prompt 的文本。
 *
 * 只写「她是谁」，不写「她此刻怎么样」——后者是情感层的活。
 * 人格块每一轮都一样，模型的 prefix cache 才命中得了。
 */
export function buildPersonaBlock(persona) {
  const clause = (text) => String(text ?? "").trim().replace(/[。.！!；;，,、\s]+$/, "");
  const lines = [`你叫${persona.name}。`];
  if (persona.role) lines.push(`你和对方的关系：${clause(persona.role)}。`);
  if (persona.summary) lines.push(clause(persona.summary) + "。");
  if (persona.traits.length) lines.push(`你的性格：${clause(persona.traits.join("、"))}。`);
  if (persona.speech.length) lines.push(`你说话的方式：${clause(persona.speech.join("；"))}。`);
  if (persona.boundaries.length) lines.push(`你不会做的事：${clause(persona.boundaries.join("；"))}。`);

  for (const key of PROMPT_SECTIONS) {
    const text = persona.sections?.[key];
    if (text) lines.push("", text);
  }

  lines.push("", "保持这个身份说话；不要自称 AI、助手或模型，也不要解释这套设定。");
  return lines.join("\n");
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readOptional(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}
