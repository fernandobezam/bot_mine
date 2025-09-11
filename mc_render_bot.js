/**
 * mc_render_bot.js (final)
 *
 * - Monitora kubejs/server.log (chat, joins/leaves, kills)
 * - Monitora logs/latest.log para eventos gerais (opcional)
 * - Detecta crash reports sem flood
 * - Gemini Pro (2 chaves) + OpenAI fallback
 * - Comandos Telegram (/ping, /players, /kills, /log, /crash) - respostas via IA
 * - Envio Telegram com controle anti-flood leve
 * - Reconexão automática RCON / SFTP
 */

require("dotenv").config({ path: __dirname + "/.env" });

// Allow higher max listeners to avoid Node warnings if many sockets/listeners are attached
require("events").EventEmitter.defaultMaxListeners = 50;

const TelegramBot = require("node-telegram-bot-api");
const SftpClient = require("ssh2-sftp-client");
const path = require("path");
const { Rcon } = require("rcon-client");
const axios = require("axios");
const http = require("http");
const OpenAI = require("openai");

// === CONFIG from .env ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const SFTP_HOST = process.env.SFTP_HOST;
const SFTP_PORT = parseInt(process.env.SFTP_PORT || "22");
const SFTP_USER = process.env.SFTP_USER;
const SFTP_PASSWORD = process.env.SFTP_PASSWORD;

const MC_LOG_DIR = process.env.MC_LOG_DIR; // e.g. /167.114.35.185_26245/logs
const MC_CRASH_DIR = process.env.MC_CRASH_DIR;
const MC_KUBEJS_LOG = process.env.MC_KUBEJS_LOG; // full path to kubejs/server.log (recommended)

const RCON_HOST = process.env.RCON_HOST;
const RCON_PORT = parseInt(process.env.RCON_PORT || "26255");
const RCON_PASSWORD = process.env.RCON_PASSWORD;

const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_2
].filter(Boolean);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const PING_INTERVAL = Math.max(10, parseInt(process.env.PING_INTERVAL || "60")); // seconds
const PORT = parseInt(process.env.PORT || "4000");

// === clients ===
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const sftp = new SftpClient();
let rcon = null;
let openai = null;
if (OPENAI_API_KEY) openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// === Message send queue (simple rate limit to avoid flooding Telegram) ===
const tgQueue = [];
let tgSending = false;
const TG_SEND_INTERVAL_MS = 800;

function enqueueTelegram(text) {
  tgQueue.push(text);
  if (!tgSending) processTgQueue();
}

function processTgQueue() {
  if (tgQueue.length === 0) {
    tgSending = false;
    return;
  }
  tgSending = true;
  const msg = tgQueue.shift();
  bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: "HTML" }).catch(err => {
    console.error("Erro Telegram send:", err?.message || err);
  });
  setTimeout(processTgQueue, TG_SEND_INTERVAL_MS);
}

// === AI layer: Gemini first, fallback OpenAI ===
async function askGemini(text) {
  for (const key of GEMINI_KEYS) {
    if (!key) continue;
    try {
      const res = await axios.post(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
        { contents: [{ parts: [{ text }] }] },
        { headers: { "Content-Type": "application/json", "X-goog-api-key": key }, timeout: 20000 }
      );
      const candidate = res.data?.candidates?.[0];
      if (candidate?.content?.parts && Array.isArray(candidate.content.parts)) {
        return candidate.content.parts.map(p => p.text || "").join("\n");
      } else if (typeof candidate?.content === "string") {
        return candidate.content;
      } else if (candidate?.output) {
        return candidate.output;
      }
    } catch (err) {
      // If quota exceeded -> try next key; otherwise log
      if (err.response?.status === 429) {
        console.warn("Gemini key quota exceeded, trying next key...");
        continue;
      }
      console.error("Gemini error:", err?.message || err);
    }
  }
  return null; // indicate failure to allow fallback
}

async function askOpenAI(text) {
  if (!openai) return null;
  try {
    // use chat.completions.create style for new openai client
    const resp = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: text }],
      max_tokens: 300,
      temperature: 0.6
    });
    const content = resp?.choices?.[0]?.message?.content;
    return content || null;
  } catch (err) {
    console.error("OpenAI error:", err?.message || err);
    return null;
  }
}

async function askAI(text, { short = true } = {}) {
  // Add guidance for brevity if requested
  const prompt = short ? `${text}\nResponda de forma curta e direta.` : text;
  // try Gemini
  const gem = await askGemini(prompt);
  if (gem) return gem.length > 800 ? gem.slice(0, 800) + "..." : gem;
  // fallback OpenAI
  const oa = await askOpenAI(prompt);
  if (oa) return oa.length > 800 ? oa.slice(0, 800) + "..." : oa;
  return "⚠️ Todas as IAs indisponíveis no momento.";
}

// === RCON connect with reconnection ===
async function connectRcon() {
  if (!RCON_HOST || !RCON_PASSWORD) return false;
  try {
    if (rcon) {
      try { await rcon.end(); } catch {}
      rcon = null;
    }
    rcon = new Rcon({ host: RCON_HOST, port: RCON_PORT, password: RCON_PASSWORD, timeout: 5000 });
    await rcon.connect();
    console.log("✅ RCON conectado");
    enqueueTelegram("🔌 Conexão RCON estabelecida!");
    return true;
  } catch (err) {
    console.error("Erro RCON conectar:", err?.message || err);
    enqueueTelegram(`⚠️ Erro RCON: ${err?.message || err}`);
    rcon = null;
    return false;
  }
}

// === Utility: read remote file as utf8 string ===
async function sftpReadFile(remotePath) {
  // sftp.get can return a Buffer when remote is a file
  const data = await sftp.get(remotePath);
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  // if stream, read it
  return new Promise((resolve, reject) => {
    const chunks = [];
    data.on("data", c => chunks.push(c));
    data.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    data.on("error", reject);
  });
}

// === Monitor files state ===
let kubejsLastSize = 0;
let latestLogLastSize = 0;
const sentCrashes = new Set();
const notifiedPlayers = new Set(); // track currently online players according to events (best-effort)

// === watch kubejs/server.log (chat, joins/leaves, kills) ===
async function monitorKubejsLog() {
  if (!MC_KUBEJS_LOG) {
    console.warn("MC_KUBEJS_LOG not set, kubejs monitoring disabled.");
    return;
  }

  try {
    // ensure connected
    if (!sftp.sftp) {
      await sftp.connect({ host: SFTP_HOST, port: SFTP_PORT, username: SFTP_USER, password: SFTP_PASSWORD });
      console.log("SFTP conectado para kubejs monitor.");
    }
  } catch (err) {
    console.error("Erro SFTP conectar (kubejs):", err?.message || err);
    return;
  }

  setInterval(async () => {
    try {
      const stats = await sftp.stat(MC_KUBEJS_LOG);
      // rotated/truncated
      if (stats.size < kubejsLastSize) kubejsLastSize = 0;
      if (stats.size === kubejsLastSize) return; // nothing new
      const content = await sftpReadFile(MC_KUBEJS_LOG);
      const lines = content.split("\n");
      // compute new lines from previous last size: use bytes approach -> easier to use lines length
      // We'll map last size (bytes) to last line count: keep lastLineCount instead for accuracy
      // Simpler: use lastLineCount approach:
    } catch (err) {
      console.error("Erro lendo kubejs log stat:", err?.message || err);
    }
  }, 3000);

  // Instead of byte-tracking, implement line-based tracking (more robust across sftp.get)
  let lastLineCount = 0;
  setInterval(async () => {
    try {
      const content = await sftpReadFile(MC_KUBEJS_LOG);
      const lines = content.split("\n");
      if (lines.length <= lastLineCount) {
        // no new lines (or truncated)
        if (lines.length < lastLineCount) lastLineCount = 0;
        return;
      }
      const newLines = lines.slice(lastLineCount);
      lastLineCount = lines.length;

      for (const line of newLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Player joined
        let m = trimmed.match(/(\w+) joined the game/);
        if (m) {
          const player = m[1];
          notifiedPlayers.add(player);
          enqueueTelegram(`✅ <b>${escapeHtml(player)}</b> entrou no servidor`);
          continue;
        }

        // Player left
        m = trimmed.match(/(\w+) left the game/);
        if (m) {
          const player = m[1];
          notifiedPlayers.delete(player);
          enqueueTelegram(`❌ <b>${escapeHtml(player)}</b> saiu do servidor`);
          continue;
        }

        // Chat message (kubejs logs often have: [INFO] [me.something]: <player> message)
        m = trimmed.match(/<([^>]+)>\s*(.+)$/);
        if (m) {
          const player = m[1];
          const messageOriginal = m[2];
          // Send raw chat first (user asked to see chat content)
          enqueueTelegram(`💬 <b>${escapeHtml(player)}:</b> ${escapeHtml(messageOriginal)}`);
          continue;
        }

        // Kills (various formats) -> try common patterns
        // ex: Player was slain by Zombie OR Player was slain by OtherPlayer
        m = trimmed.match(/(\w+)\s+was slain by\s+(.+)/i) || trimmed.match(/(.+)\s+killed\s+(.+)/i);
        if (m) {
          // crude formatting
          enqueueTelegram(`⚔️ ${escapeHtml(trimmed)}`);
          continue;
        }

        // Optionally other events can be parsed here
      }
    } catch (err) {
      console.error("Erro monitor kubejs log:", err?.message || err);
    }
  }, 3000);
}

// === Monitor latest.log for general lines (optional) ===
async function monitorLatestLog() {
  if (!MC_LOG_DIR) return;
  try {
    if (!sftp.sftp) {
      await sftp.connect({ host: SFTP_HOST, port: SFTP_PORT, username: SFTP_USER, password: SFTP_PASSWORD });
      console.log("SFTP conectado para latest.log monitor.");
    }
  } catch (err) {
    console.error("Erro SFTP conectar (latest):", err?.message || err);
    return;
  }

  let lastLineCount = 0;
  setInterval(async () => {
    try {
      // find latest .log excluding debug.log
      const files = await sftp.list(MC_LOG_DIR);
      const logFiles = files.filter(f => f.name.endsWith(".log") && !f.name.includes("debug"));
      if (!logFiles.length) return;
      const latest = logFiles.sort((a,b)=>b.modifyTime - a.modifyTime)[0];
      const remotePath = path.posix.join(MC_LOG_DIR, latest.name);
      const content = await sftpReadFile(remotePath);
      const lines = content.split("\n");
      if (lines.length <= lastLineCount) {
        if (lines.length < lastLineCount) lastLineCount = 0;
        return;
      }
      const newLines = lines.slice(lastLineCount);
      lastLineCount = lines.length;

      for (const line of newLines) {
        // similar to kubejs parsing but less custom
        const t = line.trim();
        if (!t) continue;
        // joined/left
        const mJoin = t.match(/(\w+) joined the game/);
        if (mJoin) {
          const player = mJoin[1];
          notifiedPlayers.add(player);
          enqueueTelegram(`✅ <b>${escapeHtml(player)}</b> entrou (logs)`);
          continue;
        }
        const mLeft = t.match(/(\w+) left the game/);
        if (mLeft) {
          const player = mLeft[1];
          notifiedPlayers.delete(player);
          enqueueTelegram(`❌ <b>${escapeHtml(player)}</b> saiu (logs)`);
          continue;
        }
        // other lines ignored here
      }
    } catch (err) {
      console.error("Erro monitor latest.log:", err?.message || err);
    }
  }, 5000);
}

// === Monitor crash-reports (no flood) ===
async function monitorCrashes() {
  if (!MC_CRASH_DIR) return;
  try {
    if (!sftp.sftp) {
      await sftp.connect({ host: SFTP_HOST, port: SFTP_PORT, username: SFTP_USER, password: SFTP_PASSWORD });
      console.log("SFTP conectado para crash monitor.");
    }
  } catch (err) {
    console.error("Erro SFTP conectar (crash):", err?.message || err);
    return;
  }

  setInterval(async () => {
    try {
      const files = await sftp.list(MC_CRASH_DIR);
      if (!files.length) return;
      const sorted = files.sort((a,b)=>b.modifyTime - a.modifyTime);
      const latest = sorted[0];
      if (!latest) return;
      if (sentCrashes.has(latest.name)) return; // already sent
      const remotePath = path.posix.join(MC_CRASH_DIR, latest.name);
      const content = await sftpReadFile(remotePath);
      const snippet = content.substring(0, 800);
      enqueueTelegram(`💥 <b>Crash detectado!</b>\nArquivo: ${escapeHtml(latest.name)}\n\n<pre>${escapeHtml(snippet)}</pre>`);
      sentCrashes.add(latest.name);
      // keep set bounded
      if (sentCrashes.size > 200) {
        // drop oldest
        const it = sentCrashes.values();
        sentCrashes.delete(it.next().value);
      }
    } catch (err) {
      console.error("Erro monitor crashes:", err?.message || err);
    }
  }, 10000);
}

// === Commands: /ping, /players, /kills, /log, /crash (these use AI for formatting) ===
bot.onText(/\/ping/, async (msg) => {
  try {
    enqueueTelegram("⌛ Buscando pings...");
    if (!rcon) await connectRcon();
    if (!rcon) return enqueueTelegram("⚠️ RCON indisponível.");
    const listResp = await rcon.send("list");
    const match = listResp.match(/: (.*)$/);
    const players = match?.[1] ? match[1].split(", ").filter(Boolean) : [];
    if (!players.length) return enqueueTelegram("Nenhum jogador online.");
    // build ping report by querying ping for each
    const results = [];
    for (const p of players) {
      try {
        const pingResp = await rcon.send(`ping ${p}`);
        const m = pingResp.match(/(\d+)ms/);
        results.push(`${p}: ${m ? m[1] + "ms" : "N/A"}`);
      } catch {
        results.push(`${p}: N/A`);
      }
    }
    const aiResp = await askAI(`Mostre de forma resumida o ping dos jogadores:\n${results.join("\n")}`, { short: true });
    enqueueTelegram(`📶 <b>Ping</b>:\n${escapeHtml(aiResp)}`);
  } catch (err) {
    console.error("/ping error:", err);
    enqueueTelegram("⚠️ Erro ao executar /ping.");
  }
});

bot.onText(/\/players/, async () => {
  try {
    enqueueTelegram("⌛ Buscando jogadores...");
    if (!rcon) await connectRcon();
    if (!rcon) return enqueueTelegram("⚠️ RCON indisponível.");
    const listResp = await rcon.send("list");
    const match = listResp.match(/: (.*)$/);
    const players = match?.[1] ? match[1].split(", ").filter(Boolean) : [];
    const aiResp = await askAI(`Resuma a lista de jogadores online: ${players.join(", ") || "Nenhum"}`, { short: true });
    enqueueTelegram(`<b>Jogadores:</b>\n${escapeHtml(aiResp)}`);
  } catch (err) {
    console.error("/players err:", err);
    enqueueTelegram("⚠️ Erro ao executar /players.");
  }
});

bot.onText(/\/kills/, async () => {
  try {
    enqueueTelegram("⌛ Buscando kills (últimas)...");
    // Try to parse kills from kubejs or latest log: read last 500 lines for pattern
    let content = "";
    if (MC_KUBEJS_LOG) {
      content = await sftpReadFile(MC_KUBEJS_LOG).catch(()=>"");
    }
    if (!content && MC_LOG_DIR) {
      // fallback latest.log
      const files = await sftp.list(MC_LOG_DIR);
      const logFiles = files.filter(f => f.name.endsWith(".log") && !f.name.includes("debug"));
      if (logFiles.length) {
        const latest = logFiles.sort((a,b)=>b.modifyTime - a.modifyTime)[0];
        content = await sftpReadFile(path.posix.join(MC_LOG_DIR, latest.name)).catch(()=>"");
      }
    }
    if (!content) return enqueueTelegram("Nenhum log disponível para extrair kills.");
    const lines = content.split("\n").slice(-500);
    const kills = lines.filter(l => /was slain by|killed|was shot by/i.test(l)).slice(-20);
    const aiResp = await askAI(`Liste resumidamente as últimas mortes/kills encontradas:\n${kills.join("\n")}`, { short: true });
    enqueueTelegram(`<b>Kills recentes:</b>\n${escapeHtml(aiResp)}`);
  } catch (err) {
    console.error("/kills err:", err);
    enqueueTelegram("⚠️ Erro ao executar /kills.");
  }
});

bot.onText(/\/log\s*(\d+)?/, async (msg, match) => {
  try {
    const n = parseInt(match?.[1] || "20");
    enqueueTelegram(`⌛ Carregando últimas ${n} linhas do log...`);
    let content = "";
    if (MC_KUBEJS_LOG) {
      content = await sftpReadFile(MC_KUBEJS_LOG).catch(()=>"");
    }
    if (!content && MC_LOG_DIR) {
      const files = await sftp.list(MC_LOG_DIR);
      const logFiles = files.filter(f => f.name.endsWith(".log") && !f.name.includes("debug"));
      if (logFiles.length) {
        const latest = logFiles.sort((a,b)=>b.modifyTime - a.modifyTime)[0];
        content = await sftpReadFile(path.posix.join(MC_LOG_DIR, latest.name)).catch(()=>"");
      }
    }
    if (!content) return enqueueTelegram("Nenhum log disponível.");
    const lines = content.split("\n").slice(-n).join("\n");
    const aiResp = await askAI(`Resuma estas últimas ${n} linhas do log de forma curta:\n${lines}`, { short: true });
    enqueueTelegram(`<b>Log resumo:</b>\n${escapeHtml(aiResp)}`);
  } catch (err) {
    console.error("/log err:", err);
    enqueueTelegram("⚠️ Erro ao executar /log.");
  }
});

bot.onText(/\/crash/, async () => {
  try {
    enqueueTelegram("⌛ Buscando último crash...");
    if (!MC_CRASH_DIR) return enqueueTelegram("Nenhum diretório de crash configurado.");
    const files = await sftp.list(MC_CRASH_DIR);
    if (!files.length) return enqueueTelegram("Nenhum crash report encontrado.");
    const latest = files.sort((a,b)=>b.modifyTime - a.modifyTime)[0];
    const content = await sftpReadFile(path.posix.join(MC_CRASH_DIR, latest.name));
    const aiResp = await askAI(`Explique resumidamente este crash (arquivo: ${latest.name}):\n${content.substring(0,1200)}`, { short: true });
    enqueueTelegram(`<b>Crash:</b> ${escapeHtml(latest.name)}\n${escapeHtml(aiResp)}`);
  } catch (err) {
    console.error("/crash err:", err);
    enqueueTelegram("⚠️ Erro ao executar /crash.");
  }
});

// === Messages: normal chat in Telegram -> AI responds ===
bot.on("message", async (msg) => {
  try {
    if (!msg || !msg.text) return;
    if (msg.from?.is_bot) return;
    const chatIdStr = String(msg.chat?.id);
    if (chatIdStr !== String(TELEGRAM_CHAT_ID)) return; // ignore other chats
    // ignore commands (they are handled separately)
    if (msg.text.startsWith("/")) return;

    // pass through AI (Gemini first, OpenAI fallback)
    enqueueTelegram("⌛ Processando IA...");
    const response = await askAI(msg.text, { short: true });
    enqueueTelegram(`🤖 <b>IA:</b> ${escapeHtml(response)}`);
  } catch (err) {
    console.error("bot.on message error:", err);
  }
});

// === helpers ===
function escapeHtml(str) {
  if (!str && str !== 0) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// === startup ===
(async function init() {
  console.log("Iniciando MC Render Bot...");
  // connect RCON if available
  await connectRcon().catch(()=>{});
  // connect SFTP once (monitorers will reuse)
  try {
    await sftp.connect({ host: SFTP_HOST, port: SFTP_PORT, username: SFTP_USER, password: SFTP_PASSWORD });
    console.log("✅ SFTP conectado (startup).");
  } catch (err) {
    console.warn("Aviso: não foi possível conectar SFTP no startup:", err?.message || err);
  }

  // start monitors
  if (MC_KUBEJS_LOG) await monitorKubejsLog();
  await monitorLatestLog(); // optional, will no-op if MC_LOG_DIR not set
  await monitorCrashes();

  // ensure periodic ping
  setInterval(async () => {
    try { await getPlayersPing(); } catch (err) { /* ignore */ }
  }, PING_INTERVAL * 1000);

  // fake server for Render
  http.createServer((req,res)=>res.end("Bot online ✅")).listen(PORT, ()=>console.log(`Fake HTTP server na porta ${PORT}`));
})();

// catch global errors
process.on("unhandledRejection", (err) => console.error("UnhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("UncaughtException:", err));
