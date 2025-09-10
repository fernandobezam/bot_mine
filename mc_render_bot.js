/**
 * mc_render_bot.js (versão final para Gemini Pro)
 *
 * - Gemini Pro para respostas no Telegram
 * - RCON, SFTP, monitoramento de logs e crash do Minecraft
 * - Fake HTTP server para Render Web Service
 */

require("dotenv").config({ path: __dirname + "/.env" });
const TelegramBot = require("node-telegram-bot-api");
const SftpClient = require("ssh2-sftp-client");
const path = require("path");
const { Rcon } = require("rcon-client");
const axios = require("axios");
const http = require("http");

// === Configurações do .env ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SFTP_HOST = process.env.SFTP_HOST;
const SFTP_PORT = parseInt(process.env.SFTP_PORT || "22");
const SFTP_USER = process.env.SFTP_USER;
const SFTP_PASSWORD = process.env.SFTP_PASSWORD;
const MC_LOG_DIR = process.env.MC_LOG_DIR;
const MC_CRASH_DIR = process.env.MC_CRASH_DIR;
const RCON_HOST = process.env.RCON_HOST;
const RCON_PORT = parseInt(process.env.RCON_PORT || "26255");
const RCON_PASSWORD = process.env.RCON_PASSWORD;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const sftp = new SftpClient();
let rcon = null;

// === Gemini Pro segura com timeout 30s e log detalhado ===
async function askGeminiPro(question) {
  if (!GEMINI_API_KEY) return "⚠️ Gemini Pro não configurada.";

  try {
    const res = await axios.post(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
      { contents: [{ parts: [{ text: question }] }] },
      {
        headers: {
          "Content-Type": "application/json",
          "X-goog-api-key": GEMINI_API_KEY
        },
        timeout: 30000
      }
    );

    console.log("Resposta Gemini Pro:", JSON.stringify(res.data, null, 2));

    const candidate = res.data?.candidates?.[0];
    let reply = "";

    // Extrair corretamente o texto de content.parts
    if (candidate?.content?.parts && Array.isArray(candidate.content.parts)) {
      reply = candidate.content.parts.map(p => p.text || "").join("\n");
    } else if (typeof candidate?.content === "string") {
      reply = candidate.content;
    } else if (candidate?.output) {
      reply = candidate.output;
    }

    return reply || "⚠️ Sem resposta da Gemini Pro.";
  } catch (err) {
    console.error("Erro Gemini Pro:", err.message, err.response?.data || "");
    return "⚠️ Erro ao se comunicar com Gemini Pro.";
  }
}
// === Tradução EN -> PT via Gemini Pro ===
async function translateToPortugueseRobust(text) {
  return await askGeminiPro(`Traduza para português mantendo emojis e símbolos: "${text}"`);
}

// === Explicar erro via Gemini Pro ===
async function explainError(error) {
  const text = typeof error === "string" ? error : error?.message || String(error);
  return await askGeminiPro(`Explique este erro do servidor Minecraft de forma simples: "${text}"`);
}

// === Conectar RCON ===
async function connectRcon() {
  try {
    rcon = new Rcon({ host: RCON_HOST, port: RCON_PORT, password: RCON_PASSWORD, timeout: 5000 });
    await rcon.connect();
    console.log("✅ RCON conectado!");
    sendTelegram("🔌 Conexão RCON estabelecida!");
    return true;
  } catch (err) {
    const explanation = await explainError(err);
    console.error("Erro RCON:", err.message);
    sendTelegram(`⚠️ <b>Erro RCON:</b>\n${explanation}`);
    return false;
  }
}

// === Ping dos jogadores ===
async function getPlayersPing() {
  if (!rcon) await connectRcon();
  try {
    const response = await rcon.send("list");
    const match = response.match(/: (.*)$/);
    if (!match || !match[1]) return;
    const players = match[1].split(", ").filter(Boolean);
    for (let player of players) {
      try {
        const pingResp = await rcon.send(`ping ${player}`);
        const pingMatch = pingResp.match(/(\d+)ms/);
        if (pingMatch) sendTelegram(`📶 <b>${player}:</b> ${pingMatch[1]}ms`);
      } catch (err) {
        console.error(`Erro ao pegar ping de ${player}:`, err.message);
      }
    }
  } catch (err) {
    console.error("Erro ao listar jogadores:", err.message);
    if (err.message.includes("connection") || err.message.includes("closed")) await connectRcon();
  }
}

// === Fila de envio Telegram ===
let telegramQueue = [];
let sending = false;
async function processTelegramQueue() {
  if (sending || telegramQueue.length === 0) return;
  sending = true;
  const msg = telegramQueue.shift();
  try { await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: "HTML" }); } 
  catch (err) { console.error("Erro Telegram:", err.message); }
  sending = false;
  if (telegramQueue.length > 0) setTimeout(processTelegramQueue, 1200);
}
function sendTelegram(msg) { telegramQueue.push(msg); processTelegramQueue(); }

// === Listener Telegram para responder perguntas via Gemini Pro ===
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || msg.from.is_bot) return;
  if (chatId.toString() !== TELEGRAM_CHAT_ID) return;
  const response = await askGeminiPro(text);
  sendTelegram(`🤖 <b>Gemini Pro:</b> ${response}`);
});

// === Monitorar arquivos via SFTP ===
async function watchLogs() {
  try {
    await sftp.connect({ host: SFTP_HOST, port: SFTP_PORT, username: SFTP_USER, password: SFTP_PASSWORD });
    console.log("✅ SFTP conectado!");
    sendTelegram("🤖 Bot conectado ao servidor!");

    let lastLogSize = 0;
    let lastCrashCheck = Date.now();

    setInterval(async () => {
      try {
        const filesLogs = await sftp.list(MC_LOG_DIR);
        const latestLog = filesLogs.filter(f => f.name.endsWith(".log")).sort((a,b)=>b.modifyTime-a.modifyTime)[0];
        if (!latestLog) return;
        const remotePath = path.posix.join(MC_LOG_DIR, latestLog.name);
        const stats = await sftp.stat(remotePath);

        if (stats.size > lastLogSize) {
          const content = (await sftp.get(remotePath)).toString("utf-8");
          const lines = content.split("\n").slice(-10);
          for (let line of lines) {
            if (line.includes("joined the game")) {
              const player = line.match(/(\w+) joined the game/);
              if (player) sendTelegram(`✅ <b>${player[1]}</b> entrou no servidor`);
            } else if (line.includes("left the game")) {
              const player = line.match(/(\w+) left the game/);
              if (player) sendTelegram(`❌ <b>${player[1]}</b> saiu do servidor`);
            } else if (line.includes("[Server thread/INFO]: <")) {
              const chatMatch = line.match(/<([^>]+)> (.+)/);
              if (chatMatch) {
                const playerName = chatMatch[1];
                const messageOriginal = chatMatch[2];
                const translated = await translateToPortugueseRobust(messageOriginal);
                sendTelegram(`💬 <b>${playerName}:</b> ${translated}`);
              }
            }
          }
          lastLogSize = stats.size;
        }
      } catch (err) { console.error("Erro SFTP Logs:", err.message); }
    }, 5000);

    setInterval(async () => {
      try {
        const filesCrash = await sftp.list(MC_CRASH_DIR);
        if (filesCrash.length === 0) return;
        const latestCrash = filesCrash.sort((a,b)=>b.modifyTime-a.modifyTime)[0];
        if (latestCrash.modifyTime * 1000 > lastCrashCheck) {
          const remotePath = path.posix.join(MC_CRASH_DIR, latestCrash.name);
          const content = (await sftp.get(remotePath)).toString("utf-8");
          sendTelegram(`💥 <b>Crash detectado!</b>\nArquivo: ${latestCrash.name}\n\n${content.substring(0, 500)}...`);
          lastCrashCheck = Date.now();
        }
      } catch (err) { console.error("Erro SFTP Crash Reports:", err.message); }
    }, 10000);

    setInterval(getPlayersPing, 30000);

  } catch (err) {
    const explanation = await explainError(err);
    console.error("Erro geral SFTP:", explanation);
    sendTelegram(`⚠️ Erro de conexão SFTP:\n${explanation}`);
  }
}

// === Inicialização ===
(async () => {
  console.log("Iniciando mc_render_bot...");
  await connectRcon();
  await watchLogs();
  console.log("mc_render_bot em execução!");
})();

process.on("unhandledRejection", err => console.error("Unhandled Rejection:", err));
process.on("uncaughtException", err => console.error("Uncaught Exception:", err));

// === Fake HTTP server para Render Web Service ===
const port = process.env.PORT || 3000;
const server = http.createServer((req,res)=>res.end("Bot online ✅"));
server.listen(port, ()=>console.log(`Fake HTTP server running on port ${port}`));
