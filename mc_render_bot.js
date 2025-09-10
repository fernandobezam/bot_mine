/**
 * mc_render_bot.js (versão completa e corrigida)
 *
 * - Tradução robusta EN -> PT: Helsinki-NLP/opus-mt-en-pt
 * - Explicação de erros: facebook/bart-large-mnli (zero-shot-classification corrigido)
 * - Compatível com Hugging Face API gratuita
 */

require("dotenv").config({ path: __dirname + "/.env" });
const TelegramBot = require("node-telegram-bot-api");
const SftpClient = require("ssh2-sftp-client");
const path = require("path");
const { Rcon } = require("rcon-client");
const axios = require("axios");

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
const HF_TOKEN = process.env.HF_TOKEN;

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
const sftp = new SftpClient();
let rcon = null;

// === Função genérica Hugging Face ===
async function callHuggingFaceModel(model, input, parameters = {}, timeout = 20000) {
  try {
    const res = await axios.post(
      `https://api-inference.huggingface.co/models/${model}`,
      { inputs: input, parameters },
      {
        headers: {
          Authorization: `Bearer ${HF_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout,
      }
    );

    const data = res.data;
    if (!data) return null;

    if (typeof data === "string") return data;
    if (Array.isArray(data) && data.length > 0) {
      if (typeof data[0] === "string") return data[0];
      if (data[0].generated_text) return data[0].generated_text;
      return JSON.stringify(data[0]);
    }
    if (data.generated_text) return data.generated_text;
    return JSON.stringify(data);
  } catch (err) {
    console.error("Erro Hugging Face:", err.response?.data || err.message);
    return null;
  }
}

// === Tradução EN -> PT robusta (mantendo símbolos e emojis) ===
async function translateToPortugueseRobust(text) {
  if (!HF_TOKEN) return text;

  const cleanText = text.replace(/[\u0000-\u001F\u007F]/g, ""); // Remove caracteres de controle
  const model = "Helsinki-NLP/opus-mt-en-pt";
  const result = await callHuggingFaceModel(model, cleanText);

  if (!result) return text;

  // Escapar HTML básico para Telegram
  const escaped = result
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return escaped;
}

// === Explicar erro ===
async function explainErrorWithHF(text) {
  if (!HF_TOKEN) return `Erro: ${text}`;
  const model = "facebook/bart-large-mnli";
  const candidateLabels = ["Erro de servidor", "Erro de RCON", "Erro de SFTP", "Outro"];

  const result = await callHuggingFaceModel(
    model,
    text,
    { candidate_labels: candidateLabels, multi_label: false },
    25000
  );

  if (result && typeof result === "string") return result;

  try {
    const parsed = typeof result === "string" ? JSON.parse(result) : result;
    if (parsed?.labels && parsed?.scores) {
      return `Categoria provável: ${parsed.labels[0]} (confiança: ${Math.round(parsed.scores[0] * 100)}%)`;
    }
    return JSON.stringify(parsed);
  } catch {
    return result || `Erro: ${text}`;
  }
}

async function explainError(error) {
  const text = typeof error === "string" ? error : error?.message || String(error);
  return await explainErrorWithHF(text);
}

// === Conectar RCON ===
async function connectRcon() {
  try {
    rcon = new Rcon({
      host: RCON_HOST,
      port: RCON_PORT,
      password: RCON_PASSWORD,
      timeout: 5000,
    });

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
  if (!rcon) {
    await connectRcon();
    return;
  }

  try {
    const response = await rcon.send("list");
    const match = response.match(/: (.*)$/);
    if (!match || !match[1]) return;

    const players = match[1].split(", ").filter(Boolean);
    for (let player of players) {
      try {
        const pingResp = await rcon.send(`ping ${player}`);
        const pingMatch = pingResp.match(/(\d+)ms/);
        if (pingMatch) {
          sendTelegram(`📶 <b>${player}:</b> ${pingMatch[1]}ms`);
        }
      } catch (err) {
        console.error(`Erro ao pegar ping de ${player}:`, err.message);
      }
    }
  } catch (err) {
    console.error("Erro ao listar jogadores:", err.message);
    if (err.message.includes("connection") || err.message.includes("closed")) {
      await connectRcon();
    }
  }
}

// === Fila de envio Telegram ===
let telegramQueue = [];
let sending = false;
async function processTelegramQueue() {
  if (sending || telegramQueue.length === 0) return;
  sending = true;

  const msg = telegramQueue.shift();
  try {
    await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: "HTML" });
  } catch (err) {
    console.error("Erro Telegram:", err.message);
  }

  sending = false;
  if (telegramQueue.length > 0) setTimeout(processTelegramQueue, 1200);
}

function sendTelegram(msg) {
  telegramQueue.push(msg);
  processTelegramQueue();
}

// === Monitorar arquivos via SFTP ===
async function watchLogs() {
  try {
    await sftp.connect({
      host: SFTP_HOST,
      port: SFTP_PORT,
      username: SFTP_USER,
      password: SFTP_PASSWORD,
    });
    console.log("✅ SFTP conectado!");
    sendTelegram("🤖 Bot conectado ao servidor!");

    let lastLogSize = 0;
    let lastCrashCheck = Date.now();

    setInterval(async () => {
      try {
        const filesLogs = await sftp.list(MC_LOG_DIR);
        const latestLog = filesLogs.filter(f => f.name.endsWith(".log"))
          .sort((a, b) => b.modifyTime - a.modifyTime)[0];

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

                // Traduz a mensagem robustamente
                const translated = await translateToPortugueseRobust(messageOriginal);

                sendTelegram(`💬 <b>${playerName}:</b> ${translated}`);
              }
            }
          }
          lastLogSize = stats.size;
        }
      } catch (err) {
        console.error("Erro SFTP Logs:", err.message);
      }
    }, 5000);

    setInterval(async () => {
      try {
        const filesCrash = await sftp.list(MC_CRASH_DIR);
        if (filesCrash.length === 0) return;

        const latestCrash = filesCrash.sort((a, b) => b.modifyTime - a.modifyTime)[0];
        if (latestCrash.modifyTime * 1000 > lastCrashCheck) {
          const remotePath = path.posix.join(MC_CRASH_DIR, latestCrash.name);
          const content = (await sftp.get(remotePath)).toString("utf-8");
          sendTelegram(`💥 <b>Crash detectado!</b>\nArquivo: ${latestCrash.name}\n\n${content.substring(0, 500)}...`);
          lastCrashCheck = Date.now();
        }
      } catch (err) {
        console.error("Erro SFTP Crash Reports:", err.message);
      }
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

process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});
