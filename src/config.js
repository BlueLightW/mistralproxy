import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Carrega .env (se existir) antes de ler as variáveis de ambiente.
try {
  const envPath = fileURLToPath(new URL("../.env", import.meta.url));
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim().replace(/\r$/, "").replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = val;
  }
} catch {
  // sem .env: usa apenas variáveis do shell
}

function parseNumber(val, fallback) {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// export const PORT = parseNumber(process.env.MIMO_PROXY_PORT, 8787);
// export const HOST = process.env.MIMO_PROXY_HOST || "0.0.0.0";
// export const REQUIRE_AUTH = process.env.MIMO_PROXY_REQUIRE_AUTH !== "false";
// export const MODE = (process.env.MIMO_PROXY_MODE || "raw").toLowerCase();
// export const WATCHDOG_MS = parseNumber(process.env.MIMO_PROXY_WATCHDOG_MS, 600_000);
export const config = {
  // Configurações existentes
  port: process.env.MIMO_PROXY_PORT || 8787,
  host: process.env.MIMO_PROXY_HOST || '0.0.0.0',
  token: process.env.MIMO_PROXY_TOKEN,
  requireAuth: process.env.MIMO_PROXY_REQUIRE_AUTH !== 'false',
  mode: process.env.MIMO_PROXY_MODE || 'raw',
  watchdogMs: parseInt(process.env.MIMO_PROXY_WATCHDOG_MS || '600000'),

  // ✅ NOVAS CONFIGURAÇÕES PARA MÚLTIPLAS CONTAS
  accounts: {
    // Lista de contas (será carregada do banco SQLite)
    enabled: process.env.MIMO_MULTI_ACCOUNT === 'true' || false,
    poolSize: parseInt(process.env.MIMO_ACCOUNT_POOL_SIZE || '5'), // Quantas contas ativas no pool
    cooldownMs: parseInt(process.env.MIMO_ACCOUNT_COOLDOWN_MS || '60000'), // 1 minuto de cooldown
    maxConcurrency: parseInt(process.env.MIMO_MAX_CONCURRENCY || '10'), // Máximo de requisições simultâneas
  },

  // Caminho para o banco de dados
  dbPath: process.env.MIMO_DB_PATH || './data/accounts.db',
};
export const RAW = config.mode !== "agent";
export const SERVER_URL = process.env.MIMO_SERVER_URL || "http://127.0.0.1:4096";
export const SERVER_PASSWORD = process.env.MIMO_SERVER_PASSWORD || "";
export const DEFAULT_MODEL = process.env.MIMO_PROXY_MODEL || "mimo-auto";
export const MAX_POOL_SIZE = parseNumber(process.env.MIMO_PROXY_POOL_SIZE, 2);
export const BODY_MAX_BYTES = 4 * 1024 * 1024; // ~1M tokens (~4 chars/token)
export const FALLBACK_MS = parseNumber(process.env.MIMO_PROXY_FALLBACK_MS, 500);
export const CORS_ORIGIN = process.env.MIMO_PROXY_CORS_ORIGIN || "*";

// const TOKEN = process.env.MIMO_PROXY_TOKEN;
if (config.requireAuth && !config.token) {
  throw new Error("MIMO_PROXY_TOKEN é obrigatório quando MIMO_PROXY_REQUIRE_AUTH != false");
}

export const upstream = new URL(SERVER_URL);
export const SERVER_AUTH = SERVER_PASSWORD
  ? "Basic " + Buffer.from("mimocode:" + SERVER_PASSWORD).toString("base64")
  : "";

export const mimoModels = [
  "glm-5-latest-short",
];



