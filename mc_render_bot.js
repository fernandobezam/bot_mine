/**
 * mc_render_bot.js - Versão completa e revisada com correções
 *
 * Instruções:
 * - Coloque suas chaves e configurações no .env (OPENAI_API_KEY, GEMINI_API_KEY_1, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, etc.)
 * - node mc_render_bot.js
 */

require("dotenv").config({ path: __dirname + "/.env" });

const TelegramBot = require("node-telegram-bot-api");
const SftpClient = require("ssh2-sftp-client");
const path = require("path");
const fs = require("fs");
const { Rcon } = require("rcon-client");
const http = require("http");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const OpenAI = require("openai");
const Groq = require("groq-sdk");
const os = require("os");
const { spawn } = require("child_process");
const bestzip = require("bestzip");
const cron = require("node-cron");
const crypto = require("crypto");
const fetch = global.fetch || require("node-fetch");

// === Configurações do .env ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_BOT2_TOKEN = process.env.TELEGRAM_BOT2_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SFTP_HOST = process.env.SFTP_HOST;
const SFTP_PORT = parseInt(process.env.SFTP_PORT || "22", 10);
const SFTP_USER = process.env.SFTP_USER;
const SFTP_PASSWORD = process.env.SFTP_PASSWORD;
const MC_LOG_DIR = process.env.MC_LOG_DIR;
const MC_CRASH_DIR = process.env.MC_CRASH_DIR;
const MC_KUBEJS_DIR = process.env.MC_KUBEJS_DIR;
const WORLD_DIR = process.env.WORLD_DIR;
const BOT_LOG_DIR = process.env.BOT_LOG_DIR || "./bot_logs";
const BACKUP_DIR = process.env.BACKUP_DIR || "./backups";
const RCON_HOST = process.env.RCON_HOST;
const RCON_PORT = parseInt(process.env.RCON_PORT || "26255", 10);
const RCON_PASSWORD = process.env.RCON_PASSWORD;
const GEMINI_KEYS = [process.env.GEMINI_API_KEY_1, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3].filter(Boolean);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MEMORY_THRESHOLD = parseFloat(process.env.MEMORY_THRESHOLD || 0.8);
const TPS_THRESHOLD = parseFloat(process.env.TPS_THRESHOLD || 18);
const CRASH_COOLDOWN = parseInt(process.env.CRASH_COOLDOWN || 300000, 10);
const CHAT_FLOOD_COOLDOWN = parseInt(process.env.CHAT_FLOOD_COOLDOWN || 2000, 10);
const BACKUP_INTERVAL = parseInt(process.env.BACKUP_INTERVAL || 1440, 10); // minutes
const BACKUP_INCREMENTAL_INTERVAL = parseInt(process.env.BACKUP_INCREMENTAL_INTERVAL || 240, 10); // minutes
const PING_INTERVAL = parseInt(process.env.PING_INTERVAL || 60, 10);
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || 7, 10);
const PORT = process.env.PORT || 4000;
const SERVER_START_COMMAND = process.env.SERVER_START_COMMAND || "java -jar server.jar nogui";

// === Inicializações ===
require("events").defaultMaxListeners = 100;
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const bot2 = TELEGRAM_BOT2_TOKEN ? new TelegramBot(TELEGRAM_BOT2_TOKEN, { polling: true }) : null;
const sftp = new SftpClient();
let rcon = null;
let sentCrashes = new Set();
let lastChatTimes = {};
let playerKills = {};
let playerDeaths = {};
let playerPlaytime = {};
let serverStartTime = Date.now();
let lastBackupTime = 0;
let lastIncrementalBackupTime = 0;
let commandCooldowns = {};
let serverProcess = null;

// === Sistema de rate limiting para Telegram ===
let lastMessageTime = 0;
const MESSAGE_DELAY = 1500; // 1.5 segundos entre mensagens
let messageQueue = [];
let isProcessingQueue = false;
let lastSentMessages = new Set();
const MESSAGE_COOLDOWN = 30000; // 30 segundos

function processQueue() {
  if (isProcessingQueue || messageQueue.length === 0) return;
  
  isProcessingQueue = true;
  const { msg, resolve, reject } = messageQueue.shift();
  
  const now = Date.now();
  const timeToWait = Math.max(0, MESSAGE_DELAY - (now - lastMessageTime));
  
  setTimeout(() => {
    bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: "HTML" })
      .then(() => {
        lastMessageTime = Date.now();
        resolve();
      })
      .catch((error) => {
        console.error("sendTelegram error:", error.message);
        // Se for erro 429, esperar o tempo recomendado
        if (error.response && error.response.statusCode === 429) {
          const retryAfter = error.response.body.parameters?.retry_after || 5;
          console.log(`⏳ Rate limit atingido. Esperando ${retryAfter} segundos...`);
          setTimeout(() => {
            isProcessingQueue = false;
            processQueue();
          }, retryAfter * 1000);
        } else {
          reject(error);
          isProcessingQueue = false;
          processQueue();
        }
      })
     // ✅ CORRETO - use 'err' em vez de 'error'
.catch((error) => {
  console.error("sendTelegram error:", error.message);
  if (error.response && error.response.statusCode === 429) {
    const retryAfter = error.response.body.parameters?.retry_after || 5;
    console.log(`⏳ Rate limit atingido. Esperando ${retryAfter} segundos...`);
    setTimeout(() => {
      isProcessingQueue = false;
      processQueue();
    }, retryAfter * 1000);
  } else {
    reject(error);
    isProcessingQueue = false;
    processQueue();
  }
})
.finally(() => {
  isProcessingQueue = false;
  processQueue();
});
        
  }, timeToWait);
}

// === Helper: enviar mensagens longas (usado apenas nas respostas da IA e análises) ===
function sendLongMessage(botInstance, chatId, text, options = {}) {
  const MAX_LENGTH = 4000;
  if (!text) text = "";
  if (text.length <= MAX_LENGTH) {
    return botInstance.sendMessage(chatId, text, options).catch((e) => console.error("sendLongMessage send error:", e.message));
  }
  const parts = text.match(new RegExp(`.{1,${MAX_LENGTH}}`, "gs"));
  // enviar sequencialmente para evitar flood
  (async () => {
    for (const part of parts) {
      try {
        await botInstance.sendMessage(chatId, part, options);
      } catch (err) {
        console.error("Erro ao enviar parte da mensagem:", err.message);
      }
      // pequena pausa para evitar limites
      await new Promise((r) => setTimeout(r, 200));
    }
  })();
}

// === Gemini + OpenAI + Groq clients ===
let geminiIndex = 0;
let genAI = GEMINI_KEYS.length ? new GoogleGenerativeAI(GEMINI_KEYS[0]) : null;
let openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null; // ✅ Mude const para let
const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

// === Prompt fixo da IA ===
const IA_SYSTEM_PROMPT = `
Você é um especialista em Minecraft, modpack Integrated MC.
Estilo:
- 🎮 Gamer divertido para dúvidas leves
- 📘 Guia técnico direto para dúvidas sérias
Funções:
- Explicar mods, otimização, comandos, bugs
- Responder perguntas técnicas detalhadas
- Dar dicas de manutenção do servidor
- Sugerir comandos úteis para problemas detectados
`;

// === Função principal de pergunta à IA ===
async function askAI(question, opts = {}) {
  const max_tokens = opts.max_tokens || 800;
  let lastError = "";
  let openaiDisabled = false; // Flag para controlar se OpenAI está desativada

  // 1) Tentar OpenAI (se configurado e não desativado)
  if (openai && !openaiDisabled) {
    try {
      const res = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: IA_SYSTEM_PROMPT },
          { role: "user", content: question }
        ],
        max_tokens
      });
      if (res?.choices?.[0]?.message?.content) return res.choices[0].message.content;
    } catch (err) {
      lastError = err.message || String(err);
      // Se for erro 429 (sem créditos), marcar OpenAI como desativada
      if (err.status === 429 || err.message.includes('quota') || err.message.includes('billing')) {
        console.warn("OpenAI sem créditos. Usando outras IAs...");
        openaiDisabled = true; // Apenas marca como desativada, não reatribui a variável
      } else {
        console.warn("OpenAI ask error:", lastError);
      }
    }
  }

  // 2) Tentar Groq (se configurado)
  if (groq) {
    try {
      const res = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: IA_SYSTEM_PROMPT },
          { role: "user", content: question }
        ],
        max_tokens
      });
      if (res?.choices?.[0]?.message?.content) return res.choices[0].message.content;
    } catch (err) {
      lastError = err.message || String(err);
      console.warn("Groq ask error:", lastError);
    }
  }

  // 3) Tentar DeepSeek (se configurado)
  if (DEEPSEEK_API_KEY) {
    try {
      const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [
            { role: "system", content: IA_SYSTEM_PROMPT },
            { role: "user", content: question }
          ],
          max_tokens
        })
      });
      const data = await res.json();
      if (data.choices?.[0]?.message?.content) return data.choices[0].message.content;
    } catch (err) {
      lastError = err.message || String(err);
      console.warn("DeepSeek ask error:", lastError);
    }
  }

  // 4) Tentar Gemini (rota as chaves)
  if (GEMINI_KEYS.length) {
    for (let i = 0; i < GEMINI_KEYS.length; i++) {
      try {
        genAI = new GoogleGenerativeAI(GEMINI_KEYS[geminiIndex]);
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const result = await model.generateContent([IA_SYSTEM_PROMPT, question]);
        geminiIndex = (geminiIndex + 1) % GEMINI_KEYS.length;
        if (result?.response?.text) return result.response.text();
        if (result?.response?.candidates?.[0]?.content?.[0]?.text) return result.response.candidates[0].content[0].text;
      } catch (err) {
        lastError = err.message || String(err);
        console.warn("Gemini ask error:", lastError);
        geminiIndex = (geminiIndex + 1) % GEMINI_KEYS.length;
      }
    }
  }

  return `⚠ Nenhuma IA pôde responder: ${lastError}`;
}

// === Função de geração de imagens ===
async function generateImage(prompt, size = "1024x1024") {
  // Verificar se OpenAI está configurada
  if (!openai) {
    return null;
  }
  
  try {
    const resp = await openai.images.generate({
      model: "dall-e-3",
      prompt: prompt,
      size: size,
      quality: "standard",
      n: 1
    });
    
    if (resp?.data?.[0]?.url) {
      return resp.data[0].url;
    }
    if (resp?.data?.[0]?.b64_json) {
      return `data:image/png;base64,${resp.data[0].b64_json}`;
    }
  } catch (err) {
    console.warn("OpenAI generateImage error:", err.message || err);
    return null;
  }
  
  return null;
}
// === Função para conectar RCON ===
async function connectRcon() {
  try {
    if (!RCON_HOST || !RCON_PASSWORD) {
      console.log("RCON não configurado (RCON_HOST/RCON_PASSWORD faltando).");
      return false;
    }
    rcon = new Rcon({ host: RCON_HOST, port: RCON_PORT, password: RCON_PASSWORD, timeout: 5000 });
    await rcon.connect();
    console.log("✅ RCON conectado!");
    if (TELEGRAM_CHAT_ID) sendTelegram("🔌 Conexão RCON estabelecida!");
    return true;
  } catch (err) {
    console.error("Erro RCON:", err.message || err);
    if (TELEGRAM_CHAT_ID) sendTelegram(`⚠️ Erro RCON: ${err.message || err}`);
    return false;
  }
}

async function runRconCommand(command) {
  if (!rcon) {
    const ok = await connectRcon();
    if (!ok) return `❌ RCON não conectado`;
  }
  try {
    const resp = await rcon.send(command);
    return resp;
  } catch (err) {
    console.error("runRconCommand error:", err.message || err);
    return `❌ Erro: ${err.message || err}`;
  }
}

// === Função de backup ===
async function createBackup(incremental = false) {
  try {
    if (!WORLD_DIR) throw new Error("WORLD_DIR não configurado no .env");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupType = incremental ? "incremental" : "full";
    const backupFileName = `backup-${backupType}-${timestamp}.zip`;
    const backupPath = path.join(BACKUP_DIR, backupFileName);

    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

    if (TELEGRAM_CHAT_ID) sendTelegram(`🔄 Iniciando backup ${backupType} do mundo...`);

    await bestzip({ source: WORLD_DIR, destination: backupPath, cwd: path.dirname(WORLD_DIR) });

    if (SFTP_HOST) {
      await sftp.connect({ host: SFTP_HOST, port: SFTP_PORT, username: SFTP_USER, password: SFTP_PASSWORD });
      await sftp.put(backupPath, `/backups/${backupFileName}`);
      await sftp.end();
    }

    if (incremental) lastIncrementalBackupTime = Date.now();
    else lastBackupTime = Date.now();

    if (TELEGRAM_CHAT_ID) sendTelegram(`✅ Backup ${backupType} concluído: ${backupFileName}`);
    return true;
  } catch (err) {
    console.error("Erro no backup:", err.message || err);
    if (TELEGRAM_CHAT_ID) sendTelegram(`❌ Erro no backup: ${err.message || err}`);
    return false;
  }
}

// === Start/Stop server helpers ===
async function startServer() {
  try {
    if (serverProcess) return "❌ Servidor já está em execução";
    if (!WORLD_DIR) return "❌ WORLD_DIR não configurado";

    if (TELEGRAM_CHAT_ID) sendTelegram("🔄 Iniciando servidor Minecraft...");
    serverProcess = spawn(SERVER_START_COMMAND, { shell: true, cwd: path.dirname(WORLD_DIR) });

    serverProcess.stdout.on("data", (data) => console.log("Servidor:", data.toString()));
    serverProcess.stderr.on("data", (data) => console.error("Servidor (err):", data.toString()));

    serverProcess.on("close", (code) => {
      sendTelegram(`🔴 Servidor fechado com código: ${code}`);
      serverProcess = null;
    });

    await new Promise((r) => setTimeout(r, 10000));
    await connectRcon();
    return "✅ Servidor iniciado com sucesso!";
  } catch (err) {
    console.error("startServer error:", err.message || err);
    return `❌ Erro ao iniciar servidor: ${err.message || err}`;
  }
}

async function stopServer() {
  try {
    if (!serverProcess) {
      const res = await runRconCommand("stop");
      return `✅ Comando de parada enviado: ${res}`;
    }
    if (TELEGRAM_CHAT_ID) sendTelegram("🔄 Parando servidor Minecraft...");
    serverProcess.kill("SIGINT");
    await new Promise((resolve) => {
      if (serverProcess) serverProcess.on("close", resolve);
      else resolve();
    });
    serverProcess = null;
    return "✅ Servidor parado com sucesso!";
  } catch (err) {
    console.error("stopServer error:", err.message || err);
    return `❌ Erro ao parar servidor: ${err.message || err}`;
  }
}

// === Limpeza de logs ===
async function clearLogs() {
  try {
    if (!SFTP_HOST) return `❌ SFTP não configurado`;
    await sftp.connect({ host: SFTP_HOST, port: SFTP_PORT, username: SFTP_USER, password: SFTP_PASSWORD });
    const logs = await sftp.list(MC_LOG_DIR);
    const now = Date.now();
    const retentionTime = now - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const file of logs) {
      if (file.name !== "latest.log" && file.modifyTime < retentionTime) {
        await sftp.delete(path.posix.join(MC_LOG_DIR, file.name));
      }
    }
    const crashes = await sftp.list(MC_CRASH_DIR);
    for (const file of crashes) {
      if (file.name.endsWith(".txt") && file.modifyTime < retentionTime) {
        await sftp.delete(path.posix.join(MC_CRASH_DIR, file.name));
      }
    }
    await sftp.end();
    return `✅ Logs com mais de ${LOG_RETENTION_DAYS} dias foram limpos!`;
  } catch (err) {
    console.error("clearLogs error:", err.message || err);
    return `❌ Erro ao limpar logs: ${err.message || err}`;
  }
}

// === Monitoramento de performance (simplificado) ===
function monitorPerformance() {
  setInterval(async () => {
    try {
      const tpsResponse = await runRconCommand("forge tps").catch(() => null);
      if (tpsResponse && !tpsResponse.includes("Erro")) {
        const match = tpsResponse.match(/Overall:\s*([\d.]+)/);
        if (match && parseFloat(match[1]) < TPS_THRESHOLD) {
          sendTelegram(`⚠️ TPS baixo: ${match[1]} (limite: ${TPS_THRESHOLD})`);
        }
      }

      const freeMem = os.freemem();
      const totalMem = os.totalmem();
      const memUsage = 1 - freeMem / totalMem;
      if (memUsage > MEMORY_THRESHOLD) {
        sendTelegram(`⚠️ Uso alto de memória: ${(memUsage * 100).toFixed(1)}%`);
        if (memUsage > 0.9) {
          await runRconCommand("forge gc").catch(() => null);
          sendTelegram("🔄 Coleta de lixo forçada executada");
        }
      }

      const loadAvg = os.loadavg()[0];
      const cpuCores = os.cpus().length;
      if (loadAvg > cpuCores * 0.8) {
        sendTelegram(`⚠️ Carga alta da CPU: ${loadAvg.toFixed(2)} (máx recomendado: ${(cpuCores * 0.8).toFixed(1)})`);
      }
    } catch (err) {
      console.error("monitorPerformance error:", err.message || err);
    }
  }, 60 * 1000);
}

// === Monitoramento de logs e crash reports ===
async function monitorLogs() {
  try {
    if (!SFTP_HOST) {
      console.log("SFTP não configurado — monitorLogs desabilitado.");
      return;
    }
    await sftp.connect({ host: SFTP_HOST, port: SFTP_PORT, username: SFTP_USER, password: SFTP_PASSWORD });
    console.log("✅ SFTP conectado!");
    if (TELEGRAM_CHAT_ID) sendTelegram("🤖 Bot conectado ao servidor!");

    let lastSizes = {};

    setInterval(async () => {
      // latest.log
      try {
        const latestFile = path.posix.join(MC_LOG_DIR, "latest.log");
        const stats = await sftp.stat(latestFile);
        if (!lastSizes[latestFile]) lastSizes[latestFile] = 0;
        if (stats.size > lastSizes[latestFile]) {
          const content = (await sftp.get(latestFile)).toString("utf-8");
          const lines = content.split("\n").slice(-40);
          for (const line of lines) {
            if (!line) continue;

            if (line.includes("joined the game")) {
              const m = line.match(/(\w+) joined the game/);
              if (m) {
                const player = m[1];
                const message = `✅ <b>${player}</b> entrou no servidor`;
                const messageHash = crypto.createHash('md5').update(message).digest('hex');
                if (!lastSentMessages.has(messageHash)) {
                  lastSentMessages.add(messageHash);
                  sendTelegram(message);
                  setTimeout(() => lastSentMessages.delete(messageHash), 300000);
                }
                playerPlaytime[player] = playerPlaytime[player] || { firstJoin: Date.now(), lastJoin: Date.now(), totalTime: 0 };
                playerPlaytime[player].lastJoin = Date.now();
              }
            } else if (line.includes("left the game")) {
              const m = line.match(/(\w+) left the game/);
              if (m) {
                const player = m[1];
                const message = `❌ <b>${player}</b> saiu do servidor`;
                const messageHash = crypto.createHash('md5').update(message).digest('hex');
                if (!lastSentMessages.has(messageHash)) {
                  lastSentMessages.add(messageHash);
                  sendTelegram(message);
                  setTimeout(() => lastSentMessages.delete(messageHash), 300000);
                }
                if (playerPlaytime[player]) {
                  const sessionTime = Date.now() - playerPlaytime[player].lastJoin;
                  playerPlaytime[player].totalTime += sessionTime;
                }
              }
            } else if (line.includes("was slain by") || line.includes("was killed by")) {
              const message = `⚔️ ${line}`;
              const messageHash = crypto.createHash('md5').update(message).digest('hex');
              if (!lastSentMessages.has(messageHash)) {
                lastSentMessages.add(messageHash);
                sendTelegram(message);
                setTimeout(() => lastSentMessages.delete(messageHash), 300000);
              }
              const killMatch = line.match(/(\w+) was (slain|killed) by (\w+)/);
              if (killMatch) {
                const victim = killMatch[1];
                const killer = killMatch[3];
                playerKills[killer] = (playerKills[killer] || 0) + 1;
                playerDeaths[victim] = (playerDeaths[victim] || 0) + 1;
              }
            } else if (line.includes("[Server thread/INFO]: <")) {
              const chatMatch = line.match(/<([^>]+)> (.+)/);
              if (chatMatch) {
                const username = chatMatch[1];
                const messageText = chatMatch[2];
                const lastTime = lastChatTimes[username] || 0;
                if (Date.now() - lastTime > CHAT_FLOOD_COOLDOWN) {
                  const message = `💬 <b>${username}:</b> ${messageText}`;
                  const messageHash = crypto.createHash('md5').update(message).digest('hex');
                  if (!lastSentMessages.has(messageHash)) {
                    lastSentMessages.add(messageHash);
                    sendTelegram(message);
                    setTimeout(() => lastSentMessages.delete(messageHash), 300000);
                  }
                  lastChatTimes[username] = Date.now();
                }
              }
            } else if (/error|exception|warn/i.test(line)) {
              if (line.length < 400) {
                // identificar mod
                let isModError = false;
                const MOD_ERRORS = {
                  kubejs: ["kubejs", "kubejs.exception"],
                  create: ["create", "contraption"],
                  tconstruct: ["tconstruct", "tinkers"],
                  mekanism: ["mekanism"],
                  ftb: ["ftb"],
                  ae2: ["applied energistics", "ae2"]
                };
                for (const [mod, keywords] of Object.entries(MOD_ERRORS)) {
                  for (const kw of keywords) {
                    if (line.toLowerCase().includes(kw)) {
                      const message = `🚨 <b>ERRO DE MOD [${mod.toUpperCase()}]:</b>\n${line}`;
                      const messageHash = crypto.createHash('md5').update(message).digest('hex');
                      if (!lastSentMessages.has(messageHash)) {
                        lastSentMessages.add(messageHash);
                        sendTelegram(message);
                        setTimeout(() => lastSentMessages.delete(messageHash), 300000);
                      }
                      isModError = true;
                      break;
                    }
                  }
                  if (isModError) break;
                }
                if (!isModError) {
                  const message = `⚠️ <b>Log importante:</b> ${line}`;
                  const messageHash = crypto.createHash('md5').update(message).digest('hex');
                  if (!lastSentMessages.has(messageHash)) {
                    lastSentMessages.add(messageHash);
                    sendTelegram(message);
                    setTimeout(() => lastSentMessages.delete(messageHash), 300000);
                  }
                }
              }
            }
          }
          lastSizes[latestFile] = stats.size;
        }
      } catch (err) {
        // console.error("Erro ao ler latest.log:", err.message || err);
      }

      // kubejs logs
      const kubeFiles = ["server.log", "startup.log"];
      for (const file of kubeFiles) {
        try {
          const kubePath = path.posix.join(MC_KUBEJS_DIR, file);
          const stats = await sftp.stat(kubePath);
          if (!lastSizes[kubePath]) lastSizes[kubePath] = 0;
          if (stats.size > lastSizes[kubePath]) {
            const content = (await sftp.get(kubePath)).toString("utf-8");
            const lines = content.split("\n").slice(-20);
            for (const line of lines) {
              if (line.trim() && /error|warn/i.test(line)) {
                const message = `📜 [KubeJS/${file}] ${line.substring(0, 300)}`;
                const messageHash = crypto.createHash('md5').update(message).digest('hex');
                if (!lastSentMessages.has(messageHash)) {
                  lastSentMessages.add(messageHash);
                  sendTelegram(message);
                  setTimeout(() => lastSentMessages.delete(messageHash), 300000);
                }
              }
            }
            lastSizes[kubePath] = stats.size;
          }
        } catch (err) {
          // ignore
        }
      }

      // Crash reports
      try {
        const crashFiles = await sftp.list(MC_CRASH_DIR);
        for (const f of crashFiles) {
          if (f.name.endsWith(".txt") && !sentCrashes.has(f.name)) {
            const filePath = path.posix.join(MC_CRASH_DIR, f.name);
            const content = (await sftp.get(filePath)).toString("utf-8");
            const message = `💥 <b>Crash detectado!</b>\nArquivo: ${f.name}\n\n${content.substring(0, 400)}...`;
            const messageHash = crypto.createHash('md5').update(message).digest('hex');
            if (!lastSentMessages.has(messageHash)) {
              lastSentMessages.add(messageHash);
              sendTelegram(message);
              setTimeout(() => lastSentMessages.delete(messageHash), 300000);
            }
            sentCrashes.add(f.name);

            // Analisar crash com IA (usar sendLongMessage)
            const analysis = await askAI(`Analise este crash report do Minecraft e sugira soluções:\n\n${content.substring(0, 1000)}`, { max_tokens: 500 });
            sendLongMessage(bot, TELEGRAM_CHAT_ID, `🤖 <b>Análise do crash:</b>\n${analysis}`, { parse_mode: "HTML" });

            if (sentCrashes.size > 100) {
              // manter tamanho do set
              const arr = Array.from(sentCrashes);
              for (let i = 0; i < 20; i++) sentCrashes.delete(arr[i]);
            }
          }
        }
      } catch (err) {
        // ignore
      }
    }, 15000); // 15 segundos em vez de 5
  } catch (err) {
    console.error("monitorLogs error:", err.message || err);
    if (TELEGRAM_CHAT_ID) sendTelegram(`⚠️ Erro de conexão SFTP: ${err.message || err}`);
    setTimeout(monitorLogs, 30000);
  }
}

// === Auto backups ===
function setupAutoBackup() {
  setInterval(async () => {
    await createBackup(false);
  }, BACKUP_INTERVAL * 60 * 1000);

  setInterval(async () => {
    await createBackup(true);
  }, BACKUP_INCREMENTAL_INTERVAL * 60 * 1000);
}

// === Reports (daily/weekly) ===
async function sendDailyReport() {
  try {
    const playerList = await runRconCommand("list").catch(() => "não disponível");
    const uptimeHours = Math.floor((Date.now() - serverStartTime) / 3600000);

    const topKillers = Object.entries(playerKills)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([player, kills], i) => `${i + 1}. ${player}: ${kills} kills`)
      .join("\n") || "Nenhum kill registrado";

    const topPlayers = Object.entries(playerPlaytime)
      .sort((a, b) => b[1].totalTime - a[1].totalTime)
      .slice(0, 5)
      .map(([player, data], i) => `${i + 1}. ${player}: ${Math.floor(data.totalTime / 3600000)}h`)
      .join("\n") || "Nenhum dado de playtime";

    let report = `📊 <b>Relatório Diário do Servidor</b>\n\n`;
    report += `⏰ <b>Uptime:</b> ${uptimeHours} horas\n`;
    report += `👥 <b>Jogadores online:</b> ${playerList}\n`;
    report += `⚔️ <b>Top killers:</b>\n${topKillers}\n`;
    report += `⏰ <b>Top tempo jogado:</b>\n${topPlayers}\n`;
    report += `💥 <b>Crashes hoje:</b> ${sentCrashes.size}\n`;
    report += `✅ <b>Último backup completo:</b> ${lastBackupTime ? new Date(lastBackupTime).toLocaleString() : "Nunca"}\n`;
    report += `🔄 <b>Último backup incremental:</b> ${lastIncrementalBackupTime ? new Date(lastIncrementalBackupTime).toLocaleString() : "Nunca"}`;

    sendLongMessage(bot, TELEGRAM_CHAT_ID, report, { parse_mode: "HTML" });
  } catch (err) {
    console.error("sendDailyReport error:", err.message || err);
  }
}

async function sendWeeklyReport() {
  try {
    const uptimeHours = Math.floor((Date.now() - serverStartTime) / 3600000);
    const weeklyKills = Object.entries(playerKills)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([player, kills], i) => `${i + 1}. ${player}: ${kills} kills`)
      .join("\n") || "Nenhum kill registrado";

    const weeklyPlaytime = Object.entries(playerPlaytime)
      .sort((a, b) => b[1].totalTime - a[1].totalTime)
      .slice(0, 10)
      .map(([player, data], i) => `${i + 1}. ${player}: ${Math.floor(data.totalTime / 3600000)}h`)
      .join("\n") || "Nenhum dado de playtime";

    let report = `📈 <b>Relatório Semanal do Servidor</b>\n\n`;
    report += `⏰ <b>Uptime total:</b> ${uptimeHours} horas\n`;
    report += `⚔️ <b>Top killers da semana:</b>\n${weeklyKills}\n`;
    report += `⏰ <b>Top tempo jogado da semana:</b>\n${weeklyPlaytime}\n`;
    report += `💥 <b>Total de crashes:</b> ${sentCrashes.size}\n`;
    report += `📅 <b>Período:</b> ${new Date().toLocaleDateString()}`;

    sendLongMessage(bot, TELEGRAM_CHAT_ID, report, { parse_mode: "HTML" });
  } catch (err) {
    console.error("sendWeeklyReport error:", err.message || err);
  }
}

// schedule
function setupDailyAndWeeklyReports() {
  cron.schedule("0 10 * * *", async () => {
    await sendDailyReport();
  });
  cron.schedule("0 10 * * 0", async () => {
    await sendWeeklyReport();
  });
  // enviar primeiro relatório em 5s para debug/checar
  setTimeout(sendDailyReport, 5000);
}

// === Listener de fotos (análise multimodal) ===
bot.on("photo", async (msg) => {
  try {
    const chatId = msg.chat.id.toString();
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const file = await bot.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    sendLongMessage(bot, chatId, "🔍 Analisando imagem...");

    // Tentar Gemini Vision
    if (GEMINI_KEYS.length) {
      try {
        genAI = new GoogleGenerativeAI(GEMINI_KEYS[geminiIndex]);
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-pro-vision" });
        // A API do SDK pode receber "inlineData" / "image_url" - fazemos uma tentativa
        const result = await model.generateContent([IA_SYSTEM_PROMPT, `Analise esta imagem: ${url}\nDescreva o que vê e possíveis problemas relacionados ao servidor/mods.`]);
        geminiIndex = (geminiIndex + 1) % GEMINI_KEYS.length;
        if (result?.response?.text) {
          return sendLongMessage(bot, chatId, `📷 Análise (Gemini):\n${result.response.text()}`, { parse_mode: "HTML" });
        }
      } catch (err) {
        console.warn("Gemini vision error:", err.message || err);
        geminiIndex = (geminiIndex + 1) % GEMINI_KEYS.length;
      }
    }

    // Fallback OpenAI Vision (gpt-4o-mini)
    if (openai) {
      try {
        const res = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: IA_SYSTEM_PROMPT },
            { role: "user", content: `O que você vê nesta imagem? ${url}` }
          ],
          max_tokens: 800
        });
        const text = res?.choices?.[0]?.message?.content || "Nenhuma resposta da OpenAI.";
        return sendLongMessage(bot, chatId, `📷 Análise (OpenAI):\n${text}`, { parse_mode: "HTML" });
      } catch (err) {
        console.warn("OpenAI vision error:", err.message || err);
      }
    }

    return sendLongMessage(bot, chatId, "❌ Não foi possível analisar a imagem com as IAs configuradas.");
  } catch (err) {
    console.error("photo handler error:", err.message || err);
  }
});

// === Mensagens e comandos principais ===
bot.on("message", async (msg) => {
  try {
    const chatId = msg.chat.id.toString();
    const text = (msg.text || "").trim();
    const userId = msg.from?.id?.toString();

    // only accept commands in configured TELEGRAM_CHAT_ID
    if (!text || (TELEGRAM_CHAT_ID && chatId !== TELEGRAM_CHAT_ID)) {
      // ignore messages not from the configured chat
      return;
    }

    // Anti-flood básico
    const now = Date.now();
    if (userId) {
      if (commandCooldowns[userId] && now - commandCooldowns[userId] < 800) {
        return bot.sendMessage(chatId, "⏳ Aguarde um pouco antes de enviar outro comando.");
      }
      commandCooldowns[userId] = now;
    }

    if (text.startsWith("/")) {
      const commandFull = text.split(" ");
      const command = commandFull[0];

      switch (command) {
        case "/help":
          bot.sendMessage(chatId, `
📖 <b>Comandos disponíveis:</b>

👥 Informações:
/status → Status do servidor
/players → Lista de jogadores online
/ping → Ping do servidor
/topkills → Ranking de kills
/topdeaths → Ranking de mortes
/topplaytime → Ranking de tempo jogado
/uptime → Tempo de atividade
/stats <jogador> → Estatísticas de um jogador

⚙️ Controle:
/run <comando> → Executa comando no servidor
/backup → Cria backup completo
/backup incremental → Cria backup incremental
/clearlogs → Limpa logs antigos
/stopserver → Para o servidor
/startserver → Inicia o servidor
/restartserver → Reinicia o servidor

🧠 IA:
/ask <pergunta> → Pergunta à IA especialista
/image <descrição> → Gera imagem (OpenAI DALL-E 3)
          `, { parse_mode: "HTML" });
          break;

        case "/status":
          try {
            const playerList = await runRconCommand("list").catch(() => "não disponível");
            const tpsInfo = await runRconCommand("forge tps").catch(() => null);
            const uptimeHours = Math.floor((Date.now() - serverStartTime) / 3600000);
            const freeMem = os.freemem() / 1024 / 1024 / 1024;
            const totalMem = os.totalmem() / 1024 / 1024 / 1024;
            const memUsage = ((1 - freeMem / totalMem) * 100).toFixed(1);
            const loadAvg = os.loadavg()[0];
            const cpuCores = os.cpus().length;

            let statusMsg = `🖥️ <b>Status do Servidor</b>\n\n`;
            statusMsg += `⏰ <b>Uptime:</b> ${uptimeHours}h\n`;
            statusMsg += `👥 <b>Jogadores:</b> ${playerList}\n`;
            statusMsg += `📊 <b>Memória:</b> ${memUsage}% usado (${(totalMem - freeMem).toFixed(1)}/${totalMem.toFixed(1)} GB)\n`;
            statusMsg += `🔧 <b>Load AVG:</b> ${loadAvg.toFixed(2)}/${cpuCores}\n`;
            statusMsg += `💥 <b>Crashes hoje:</b> ${sentCrashes.size}\n`;
            if (tpsInfo) statusMsg += `⚡ <b>TPS:</b> ${tpsInfo}\n`;
            if (lastBackupTime) {
              statusMsg += `💾 <b>Último backup:</b> ${Math.floor((Date.now() - lastBackupTime) / 3600000)}h atrás\n`;
            }

            bot.sendMessage(chatId, statusMsg, { parse_mode: "HTML" });
          } catch (err) {
            bot.sendMessage(chatId, `❌ Erro ao obter status: ${err.message || err}`);
          }
          break;

        case "/players": {
          const players = await runRconCommand("list").catch(() => "não disponível");
          bot.sendMessage(chatId, `👥 <b>Jogadores online:</b>\n${players}`, { parse_mode: "HTML" });
          break;
        }

        case "/ping": {
          const ping = await runRconCommand("ping").catch(() => "não disponível");
          bot.sendMessage(chatId, `🏓 <b>Ping:</b> ${ping}`, { parse_mode: "HTML" });
          break;
        }

        case "/topkills": {
          const topKills = Object.entries(playerKills)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([p, k], i) => `${i + 1}. ${p}: ${k} kills`)
            .join("\n") || "Nenhum kill registrado";
          bot.sendMessage(chatId, `⚔️ <b>Top 10 Killers:</b>\n${topKills}`, { parse_mode: "HTML" });
          break;
        }

        case "/topdeaths": {
          const topDeaths = Object.entries(playerDeaths)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([p, d], i) => `${i + 1}. ${p}: ${d} mortes`)
            .join("\n") || "Nenhuma morte registrada";
          bot.sendMessage(chatId, `💀 <b>Top 10 Mortes:</b>\n${topDeaths}`, { parse_mode: "HTML" });
          break;
        }

        case "/topplaytime": {
          const topPlaytime = Object.entries(playerPlaytime)
            .sort((a, b) => b[1].totalTime - a[1].totalTime)
            .slice(0, 10)
            .map(([p, d], i) => `${i + 1}. ${p}: ${Math.floor(d.totalTime / 3600000)}h`)
            .join("\n") || "Nenhum dado de playtime";
          bot.sendMessage(chatId, `⏰ <b>Top 10 Tempo Jogado:</b>\n${topPlaytime}`, { parse_mode: "HTML" });
          break;
        }

        case "/stats": {
          if (!text.includes(" ")) {
            bot.sendMessage(chatId, "⚠️ Use: /stats <jogador>");
            break;
          }
          const playerName = text.substring(7).trim();
          const kills = playerKills[playerName] || 0;
          const deaths = playerDeaths[playerName] || 0;
          const kdRatio = deaths > 0 ? (kills / deaths).toFixed(2) : kills > 0 ? "∞" : "0";
          const playtime = playerPlaytime[playerName] ? Math.floor(playerPlaytime[playerName].totalTime / 3600000) : 0;
          let statsMsg = `📊 <b>Estatísticas de ${playerName}:</b>\n\n`;
          statsMsg += `⚔️ <b>Kills:</b> ${kills}\n`;
          statsMsg += `💀 <b>Mortes:</b> ${deaths}\n`;
          statsMsg += `🎯 <b>K/D Ratio:</b> ${kdRatio}\n`;
          statsMsg += `⏰ <b>Tempo jogado:</b> ${playtime}h\n`;
          if (playerPlaytime[playerName]) statsMsg += `📅 <b>Primeiro join:</b> ${new Date(playerPlaytime[playerName].firstJoin).toLocaleDateString()}\n`;
          bot.sendMessage(chatId, statsMsg, { parse_mode: "HTML" });
          break;
        }

        case "/uptime": {
          const uptimeHours = Math.floor((Date.now() - serverStartTime) / 3600000);
          bot.sendMessage(chatId, `⏰ <b>Uptime:</b> ${uptimeHours} horas`, { parse_mode: "HTML" });
          break;
        }

        case "/run": {
          if (!text.includes(" ")) {
            bot.sendMessage(chatId, "⚠️ Use: /run <comando>");
            break;
          }
          const cmd = text.substring(5);
          const result = await runRconCommand(cmd);
          bot.sendMessage(chatId, `🔧 <b>Comando executado:</b> ${cmd}\n📋 <b>Resultado:</b>\n${result}`, { parse_mode: "HTML" });
          break;
        }

        case "/backup": {
          const isIncremental = text.includes("incremental");
          bot.sendMessage(chatId, `🔄 Iniciando backup ${isIncremental ? "incremental" : "completo"}...`);
          const res = await createBackup(isIncremental);
          if (res) bot.sendMessage(chatId, `✅ Backup ${isIncremental ? "incremental" : "completo"} concluído com sucesso!`);
          break;
        }

        case "/clearlogs": {
          bot.sendMessage(chatId, "🔄 Limpando logs antigos...");
          const res = await clearLogs();
          bot.sendMessage(chatId, res);
          break;
        }

        case "/stopserver": {
          const res = await stopServer();
          bot.sendMessage(chatId, res);
          break;
        }

        case "/startserver": {
          bot.sendMessage(chatId, "🔄 Iniciando servidor...");
          const res = await startServer();
          bot.sendMessage(chatId, res);
          break;
        }

        case "/restartserver": {
          bot.sendMessage(chatId, "🔄 Reiniciando servidor...");
          await stopServer();
          await new Promise((r) => setTimeout(r, 10000));
          const res = await startServer();
          bot.sendMessage(chatId, res);
          break;
        }

        case "/ask": {
          if (!text.includes(" ")) {
            sendLongMessage(bot, chatId, "⚠️ Use: /ask <sua pergunta>");
            break;
          }
          const question = text.substring(5).trim();
          sendLongMessage(bot, chatId, "🤖 Consultando IA especialista...");
          const answer = await askAI(question, { max_tokens: 1000 });
          sendLongMessage(bot, chatId, `🤖 <b>Resposta da IA:</b>\n${answer}`, { parse_mode: "HTML" });
          break;
        }

       case "/image": {
  if (!text.includes(" ")) {
    sendLongMessage(bot, chatId, "⚠️ Use: /image <descrição>");
    break;
  }
  const prompt = text.substring(7).trim();
  
  // Verificar se OpenAI está disponível
  if (!openai) {
    sendLongMessage(bot, chatId, "❌ Geração de imagens temporariamente indisponível. OpenAI sem créditos.");
    break;
  }
  
  sendLongMessage(bot, chatId, "🎨 Gerando imagem...");
  const url = await generateImage(prompt, "1024x1024");
  
  if (url) {
    try {
      if (url.startsWith("data:")) {
        const base64 = url.split(",")[1];
        const buf = Buffer.from(base64, "base64");
        const tmpPath = path.join(os.tmpdir(), `img_${Date.now()}.png`);
        fs.writeFileSync(tmpPath, buf);
        await bot.sendPhoto(chatId, tmpPath, { caption: "🖼️ Sua imagem gerada" });
        fs.unlinkSync(tmpPath);
      } else {
        await bot.sendPhoto(chatId, url, { caption: "🖼️ Sua imagem gerada" });
      }
    } catch (err) {
      console.warn("Erro ao enviar imagem:", err.message || err);
      sendLongMessage(bot, chatId, `🖼️ Imagem gerada: ${url}`);
    }
  } else {
    sendLongMessage(bot, chatId, "❌ Erro ao gerar imagem. OpenAI sem créditos ou serviço indisponível.");
  }
  break;
}
        default:
          bot.sendMessage(chatId, "❌ Comando não reconhecido. Use /help para ver os comandos disponíveis.");
      } // end switch
    } else {
      // mensagem normal (não comando) -> encaminhar para IA
      // se mensagem for do chat configurado, enviar para IA e responder
      const aiRes = await askAI(text, { max_tokens: 800 });
      sendLongMessage(bot, chatId, `🤖 <b>IA:</b> ${aiRes}`, { parse_mode: "HTML" });
    }
  } catch (err) {
    console.error("message handler error:", err.message || err);
  }
});

// === Bot2 (opcional) - IA dedicada ===
if (bot2) {
  bot2.on("message", async (msg) => {
    try {
      const chatId = msg.chat.id.toString();
      const text = (msg.text || "").trim();
      
      // Só responder se a mensagem NÃO começar com / e for para o bot2 especificamente
      if (!text || text.startsWith('/')) return;
      
      // Verificar se a mensagem foi enviada no chat do BOT2 (não no chat principal)
      if (TELEGRAM_CHAT_ID && chatId === TELEGRAM_CHAT_ID) {
        // Se for o mesmo chat, não responder para evitar duplicação
        return;
      }
      
      bot2.sendMessage(chatId, "🤖 Consultando especialista Minecraft...");
      const answer = await askAI(text, { max_tokens: 800 });
      sendLongMessage(bot2, chatId, `🎮 <b>Especialista Minecraft:</b>\n${answer}`, { parse_mode: "HTML" });
    } catch (err) {
      console.error("bot2 message error:", err.message || err);
    }
  });
  
  // Comandos específicos do bot2
  bot2.onText(/\/ask(.+)?/, async (msg, match) => {
    try {
      const chatId = msg.chat.id.toString();
      const text = match[1] ? match[1].trim() : '';
      
      if (!text) {
        return bot2.sendMessage(chatId, "⚠️ Use: /ask <sua pergunta>");
      }
      
      bot2.sendMessage(chatId, "🤖 Consultando IA especialista...");
      const answer = await askAI(text, { max_tokens: 1000 });
      sendLongMessage(bot2, chatId, `🤖 <b>Resposta da IA:</b>\n${answer}`, { parse_mode: "HTML" });
    } catch (err) {
      console.error("bot2 /ask error:", err.message || err);
    }
  });
  
  bot2.onText(/\/image(.+)?/, async (msg, match) => {
    try {
      const chatId = msg.chat.id.toString();
      const prompt = match[1] ? match[1].trim() : '';
      
      if (!prompt) {
        return sendLongMessage(bot2, chatId, "⚠️ Use: /image <descrição>");
      }
      
      sendLongMessage(bot2, chatId, "🎨 Gerando imagem...");
      const url = await generateImage(prompt, "1024x1024");
      
      if (url) {
        try {
          if (url.startsWith("data:")) {
            const base64 = url.split(",")[1];
            const buf = Buffer.from(base64, "base64");
            const tmpPath = path.join(os.tmpdir(), `img_${Date.now()}.png`);
            fs.writeFileSync(tmpPath, buf);
            await bot2.sendPhoto(chatId, tmpPath, { caption: "🖼️ Sua imagem gerada" });
            fs.unlinkSync(tmpPath);
          } else {
            await bot2.sendPhoto(chatId, url, { caption: "🖼️ Sua imagem gerada" });
          }
        } catch (err) {
          console.warn("Erro ao enviar imagem:", err.message || err);
          sendLongMessage(bot2, chatId, `🖼️ Imagem gerada: ${url}`);
        }
      } else {
        sendLongMessage(bot2, chatId, "❌ Erro ao gerar imagem. Verifique se a API da OpenAI está configurada.");
      }
    } catch (err) {
      console.error("bot2 /image error:", err.message || err);
    }
  });
}

// === HTTP server para health check ===
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("✅ MC Render Bot online\nUptime: " + Math.floor((Date.now() - serverStartTime) / 3600000) + " horas");
}).listen(PORT, () => {
  console.log(`🌐 HTTP server na porta ${PORT}`);
});

// === Inicialização principal ===
(async () => {
  try {
    if (!fs.existsSync(BOT_LOG_DIR)) fs.mkdirSync(BOT_LOG_DIR, { recursive: true });
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

    // tentativa de conectar rcon se configurado
    await connectRcon();

    // iniciar monitoramentos
    monitorPerformance();
    setupAutoBackup();
    setupDailyAndWeeklyReports();

    // iniciar monitorLogs somente se SFTP configurado
    if (SFTP_HOST) await monitorLogs();

    console.log("✅ mc_render_bot em execução!");
    if (bot2) console.log("✅ Bot2 (IA) em execução!");
    if (TELEGRAM_CHAT_ID) sendTelegram("🤖 Bot iniciado com sucesso! Use /help para ver os comandos.");
  } catch (err) {
    console.error("Erro na inicialização:", err.message || err);
    if (TELEGRAM_CHAT_ID) sendTelegram(`❌ Erro na inicialização do bot: ${err.message || err}`);
  }
})();

// === Tratamento de erros globais ===
process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
  if (TELEGRAM_CHAT_ID) sendTelegram(`⚠️ Erro não tratado: ${err.message || String(err)}`);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  if (TELEGRAM_CHAT_ID) sendTelegram(`⚠️ Exceção não capturada: ${err.message || String(err)}`);
});

// Helper de envio padrão para o chat principal (com rate limiting)
function sendTelegram(msg) {
  if (!TELEGRAM_CHAT_ID) return;
  
  // Usar o sistema de fila para rate limiting
  new Promise((resolve, reject) => {
    messageQueue.push({ msg, resolve, reject });
    processQueue();
  }).catch((e) => console.error("sendTelegram error:", e.message));
}