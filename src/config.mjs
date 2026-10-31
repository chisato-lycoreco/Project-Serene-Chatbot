/**
 * src/config.mjs — 路径、密钥、可调参数。
 *
 * 只有一个原则：**所有可以改的东西都在文件里，不在代码里。**
 * 人格在 personas/，设置和记忆在 data/，密钥在环境变量或 .env。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const VERSION = readVersion();

/** 读 .env（只补没有的环境变量，不覆盖已有的）。 */
export function loadEnvFile(file = join(ROOT, ".env")) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const eq = text.indexOf("=");
    if (eq <= 0) continue;
    const key = text.slice(0, eq).trim();
    let value = text.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function dataDir() {
  const raw = process.env.SERENE_DATA_DIR;
  if (!raw) return join(ROOT, "data");
  return isAbsolute(raw) ? raw : resolve(ROOT, raw);
}

export function personaDir() {
  const raw = process.env.SERENE_PERSONA;
  if (!raw) return join(ROOT, "personas", "serene");
  return isAbsolute(raw) ? raw : resolve(ROOT, raw);
}

export function apiKey() {
  return String(process.env.DEEPSEEK_API_KEY ?? "").trim();
}

export function keySource() {
  if (process.env.DEEPSEEK_API_KEY?.trim()) return "环境变量 DEEPSEEK_API_KEY";
  return "没有找到 key";
}

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  model: "deepseek-chat",
  baseUrl: "https://api.deepseek.com",
  temperature: 1.05,
  maxTokens: 360,
  depth: "normal",
  remember: true,
  recallLimit: 5,
  historyMessages: 18,
  replyChars: 120,
});

const SENSITIVE = new Set(["apiKey", "key"]);

/** 读设置：不在文件里的字段回落到默认值；非法值不抛，回落到默认值。 */
export function readSettings(dir = dataDir()) {
  const file = join(dir, "settings.json");
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    raw = {};
  }
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (key in raw) settings[key] = raw[key];
  }
  settings.model = cleanModel(settings.model);
  settings.baseUrl = String(settings.baseUrl || DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, "");
  settings.temperature = clamp(Number(settings.temperature), 0, 2, DEFAULT_SETTINGS.temperature);
  settings.maxTokens = Math.round(clamp(Number(settings.maxTokens), 64, 2048, DEFAULT_SETTINGS.maxTokens));
  settings.recallLimit = Math.round(clamp(Number(settings.recallLimit), 0, 8, DEFAULT_SETTINGS.recallLimit));
  settings.historyMessages = Math.round(clamp(Number(settings.historyMessages), 4, 40, DEFAULT_SETTINGS.historyMessages));
  settings.replyChars = Math.round(clamp(Number(settings.replyChars), 40, 400, DEFAULT_SETTINGS.replyChars));
  settings.depth = ["short", "normal", "deep"].includes(settings.depth) ? settings.depth : "normal";
  settings.remember = settings.remember !== false;
  return settings;
}

/** 只允许改这几个字段；其它一律忽略。 */
export function writeSettings(patch, dir = dataDir()) {
  const current = readSettings(dir);
  const next = { ...current };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (SENSITIVE.has(key)) continue;
    if (!(key in DEFAULT_SETTINGS)) continue;
    next[key] = value;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return readSettings(dir);
}

function cleanModel(value) {
  const text = String(value ?? "").trim();
  return text || DEFAULT_SETTINGS.model;
}

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function readVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
