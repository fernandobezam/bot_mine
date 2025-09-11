/**
 * mc_render_bot.js - Versão completa 2025
 * Monitoramento, RCON, SFTP, backups, comandos Telegram, IA integrada
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
const os = require("os");
const { exec } = require("child_process");
const bestzip = require("bestzip");

// === Configurações do .env ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SFTP_HOST = process.env.SFTP_HOST;
const SFTP_PORT = parseInt(process.env.SFTP_PORT || "22");
const SFTP_USER = process.env.SFTP_USER;
const SFTP_PASSWORD = process.env.SFTP_PASSWORD;
const MC_LOG_DIR = process.env.MC_LOG_DIR;
const MC_CRASH_DIR = process.env.MC_CRASH_DIR;
const MC_KUBEJS_DIR = process.env.MC_KUBEJS_DIR;
const WORLD_DIR = process.env.WORLD_DIR;
const BOT_LOG_DIR = process.env.BOT_LOG_DIR || "./bot_logs";
const BACKUP_DIR = process.env.BACKUP_DIR || "./backups";
const RCON_HOST = process.env.RCON_HOST;
const RCON_PORT = parseInt(process.env.RCON_PORT || "26255");
const RCON_PASSWORD = process.env.RCON_PASSWORD;
const GEMINI_KEYS = [process.env.GEMINI_API_KEY_1, process.env.GEMINI_API_KEY_2].filter(Boolean);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MEMORY_THRESHOLD = parseFloat(process.env.MEMORY_THRESHOLD || 0.8);
const TPS_THRESHOLD = parseFloat(process.env.TPS_THRESHOLD || 18);
const CRASH_COOLDOWN = parseInt(process.env.CRASH_COOLDOWN || 300000);
const CHAT_FLOOD_COOLDOWN = parseInt(process.env.CHAT_FLOOD_COOLDOWN || 2000);
const BACKUP_INTERVAL = parseInt(process.env.BACKUP_INTERVAL || 1440);
const PING_INTERVAL = parseInt(process.env.PING_INTERVAL || 60);
const PORT = process.env.PORT || 4000;

// === Inicializações ===
require("events").defaultMaxListeners = 50;
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const sftp = new SftpClient();
let rcon = null;
let sentCrashes = new Set();
let lastChatTimes = {};
let playerKills = {};
let serverStartTime = Date.now();
let lastBackupTime = 0;
let commandCooldowns = {};

// === Gemini + OpenAI ===
let geminiIndex = 0;
let genAI = GEMINI_KEYS.length ? new GoogleGenerativeAI(GEMINI_KEYS[0]) : null;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

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

// === Função IA ===
async function askAI(question) {
  let lastError = "";
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    try {
      genAI = new GoogleGenerativeAI(GEMINI_KEYS[geminiIndex]);
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      const result = await model.generateContent([IA_SYSTEM_PROMPT, question]);
      geminiIndex = (geminiIndex + 1) % GEMINI_KEYS.length;
      return result.response.text();
    } catch (err) {
      lastError = err.message;
      geminiIndex = (geminiIndex + 1) % GEMINI_KEYS.length;
    }
  }
  if (openai) {
    try {
      const res = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: IA_SYSTEM_PROMPT },
          { role: "user", content: question },
        ],
        max_tokens: 300,
      });
      return res.choices[0].message.content;
    } catch (err) {
      lastError = err.message;
    }
  }
  return `⚠ Nenhuma IA pôde responder: ${lastError}`;
}

// === Função Telegram ===
function sendTelegram(msg) {
  bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: "HTML" }).catch(console.error);
}

// === Conexão RCON ===
async function connectRcon() {
  try {
    rcon = new Rcon({ host: RCON_HOST, port: RCON_PORT, password: RCON_PASSWORD, timeout: 5000 });
    await rcon.connect();
    console.log("✅ RCON conectado!");
    sendTelegram("🔌 Conexão RCON estabelecida!");
    return true;
  } catch (err) {
    console.error("Erro RCON:", err.message);
    sendTelegram(`⚠️ Erro RCON: ${err.message}`);
    return false;
  }
}

// === Função para executar comando RCON ===
async function runRconCommand(command) {
  if (!rcon) {
    const connected = await connectRcon();
    if (!connected) return "❌ RCON não conectado";
  }
  
  try {
    const response = await rcon.send(command);
    return response;
  } catch (err) {
    console.error("Erro ao executar comando RCON:", err.message);
    return `❌ Erro: ${err.message}`;
  }
}

// === Função de backup ===
async function createBackup() {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFileName = `backup-${timestamp}.zip`;
    const backupPath = path.join(BACKUP_DIR, backupFileName);
    
    // Criar diretório de backup se não existir
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
    
    sendTelegram("🔄 Iniciando backup do mundo...");
    
    // Compactar mundo
    await bestzip({
      source: WORLD_DIR,
      destination: backupPath,
      cwd: path.dirname(WORLD_DIR)
    });
    
    // Enviar via SFTP se configurado
    if (SFTP_HOST) {
      await sftp.connect({ host: SFTP_HOST, port: SFTP_PORT, username: SFTP_USER, password: SFTP_PASSWORD });
      await sftp.put(backupPath, `/backups/${backupFileName}`);
      await sftp.end();
    }
    
    lastBackupTime = Date.now();
    sendTelegram(`✅ Backup concluído: ${backupFileName}`);
    return true;
  } catch (err) {
    console.error("Erro no backup:", err);
    sendTelegram(`❌ Erro no backup: ${err.message}`);
    return false;
  }
}

// === Monitoramento de performance ===
async function monitorPerformance() {
  setInterval(async () => {
    try {
      // Verificar TPS (se disponível via RCON)
      const tpsResponse = await runRconCommand("forge tps");
      if (tpsResponse && !tpsResponse.includes("Erro")) {
        const tpsMatch = tpsResponse.match(/Overall: ([\d.]+)/);
        if (tpsMatch && parseFloat(tpsMatch[1]) < TPS_THRESHOLD) {
          sendTelegram(`⚠️ TPS baixo: ${tpsMatch[1]} (limite: ${TPS_THRESHOLD})`);
        }
      }
      
      // Verificar uso de memória
      const freeMem = os.freemem();
      const totalMem = os.totalmem();
      const memUsage = 1 - (freeMem / totalMem);
      
      if (memUsage > MEMORY_THRESHOLD) {
        sendTelegram(`⚠️ Uso alto de memória: ${(memUsage * 100).toFixed(1)}%`);
      }
    } catch (err) {
      console.error("Erro no monitoramento de performance:", err);
    }
  }, 60000); // Verificar a cada minuto
}

// === Monitoramento logs ===
async function monitorLogs() {
  try {
    await sftp.connect({ host: SFTP_HOST, port: SFTP_PORT, username: SFTP_USER, password: SFTP_PASSWORD });
    console.log("✅ SFTP conectado!");
    sendTelegram("🤖 Bot conectado ao servidor!");
    
    let lastSizes = {};

    setInterval(async () => {
      // 1️⃣ latest.log - eventos do servidor
      try {
        const latestFile = path.posix.join(MC_LOG_DIR, "latest.log");
        const stats = await sftp.stat(latestFile);
        if (!lastSizes[latestFile]) lastSizes[latestFile] = 0;
        if (stats.size > lastSizes[latestFile]) {
          const content = (await sftp.get(latestFile)).toString("utf-8");
          const lines = content.split("\n").slice(-20);
          
          for (const line of lines) {
            // Jogador entrou
            if (line.includes("joined the game")) {
              const m = line.match(/(\w+) joined the game/);
              if (m) {
                sendTelegram(`✅ <b>${m[1]}</b> entrou no servidor`);
              }
            } 
            // Jogador saiu
            else if (line.includes("left the game")) {
              const m = line.match(/(\w+) left the game/);
              if (m) {
                sendTelegram(`❌ <b>${m[1]}</b> saiu do servidor`);
              }
            } 
            // Kill no jogo
            else if (line.includes("was slain by") || line.includes("was killed by")) {
              sendTelegram(`⚔️ ${line}`);
              
              // Contabilizar kills
              const killMatch = line.match(/(\w+) was (slain|killed) by (\w+)/);
              if (killMatch) {
                const killer = killMatch[3];
                playerKills[killer] = (playerKills[killer] || 0) + 1;
              }
            } 
            // Chat do servidor
            else if (line.includes("[Server thread/INFO]: <")) {
              const chatMatch = line.match(/<([^>]+)> (.+)/);
              if (chatMatch) {
                const username = chatMatch[1];
                const message = chatMatch[2];
                const lastTime = lastChatTimes[username] || 0;
                
                if (Date.now() - lastTime > CHAT_FLOOD_COOLDOWN) {
                  sendTelegram(`💬 <b>${username}:</b> ${message}`);
                  lastChatTimes[username] = Date.now();
                }
              }
            }
            // Erros críticos
            else if (line.toLowerCase().includes("error") || line.toLowerCase().includes("exception")) {
              if (line.length < 100) { // Não enviar logs muito longos
                sendTelegram(`🚨 <b>Erro detectado:</b> ${line}`);
              }
            }
          }
          lastSizes[latestFile] = stats.size;
        }
      } catch (err) {
        console.error("Erro ao ler latest.log:", err.message);
      }

      // 2️⃣ kubejs logs
      const kubeFiles = ["server.log", "startup.log"];
      for (const file of kubeFiles) {
        try {
          const kubePath = path.posix.join(MC_KUBEJS_DIR, file);
          const stats = await sftp.stat(kubePath);
          if (!lastSizes[kubePath]) lastSizes[kubePath] = 0;
          if (stats.size > lastSizes[kubePath]) {
            const content = (await sftp.get(kubePath)).toString("utf-8");
            const lines = content.split("\n").slice(-10);
            for (const line of lines) {
              if (line.trim() && (line.toLowerCase().includes("error") || line.toLowerCase().includes("warn"))) {
                sendTelegram(`📜 [${file}] ${line.substring(0, 200)}`);
              }
            }
            lastSizes[kubePath] = stats.size;
          }
        } catch (err) {
          console.error(`Erro ao ler ${file}:`, err.message);
        }
      }

      // 3️⃣ Crash reports
      try {
        const crashFiles = await sftp.list(MC_CRASH_DIR);
        for (const f of crashFiles) {
          if (f.name.endsWith(".txt") && !sentCrashes.has(f.name)) {
            const filePath = path.posix.join(MC_CRASH_DIR, f.name);
            const content = (await sftp.get(filePath)).toString("utf-8");
            
            sendTelegram(`💥 <b>Crash detectado!</b>\nArquivo: ${f.name}\n\n${content.substring(0, 300)}...`);
            sentCrashes.add(f.name);
            
            // Analisar crash com IA
            const analysis = await askAI(`Analise este crash report do Minecraft e sugira soluções: ${content.substring(0, 500)}`);
            sendTelegram(`🤖 <b>Análise do crash:</b>\n${analysis}`);
            
            // Limpar crashes antigos
            if (sentCrashes.size > 50) {
              const oldest = Array.from(sentCrashes).slice(0, 10);
              oldest.forEach(crash => sentCrashes.delete(crash));
            }
          }
        }
      } catch (err) {
        console.error("Erro ao verificar crash reports:", err.message);
      }

    }, 5000); // Verificar a cada 5 segundos

  } catch (err) {
    console.error("Erro SFTP:", err.message);
    sendTelegram(`⚠️ Erro de conexão SFTP: ${err.message}`);
    setTimeout(monitorLogs, 30000);
  }
}

// === Backup automático ===
function setupAutoBackup() {
  setInterval(async () => {
    await createBackup();
  }, BACKUP_INTERVAL * 60 * 1000); // Converter minutos para ms
}

// === Comandos Telegram ===
bot.on("message", async msg => {
  const chatId = msg.chat.id.toString();
  const text = msg.text?.trim();
  const userId = msg.from.id.toString();
  
  if (!text || chatId !== TELEGRAM_CHAT_ID) return;
  
  // Anti-flood para comandos
  const now = Date.now();
  if (commandCooldowns[userId] && now - commandCooldowns[userId] < 2000) {
    return bot.sendMessage(chatId, "⏳ Aguarde um pouco antes de enviar outro comando.");
  }
  commandCooldowns[userId] = now;

  if (text.startsWith("/")) {
    const command = text.split(" ")[0];
    
    switch(command) {
      case "/help":
        bot.sendMessage(chatId, `📖 <b>Comandos disponíveis:</b>
        
👥 <b>Informações:</b>
/status → Status do servidor (memória, TPS, jogadores)
/players → Lista de jogadores online
/ping → Mostra ping do servidor
/topkills → Ranking de kills por jogador
/uptime → Tempo de atividade do servidor

⚙️ <b>Controle:</b>
/run <comando> → Executa comando no servidor
/backup → Cria backup do mundo
/clearlogs → Limpa logs antigos
/stopserver → Para o servidor
/startserver → Inicia o servidor

❓ <b>Ajuda:</b>
/help → Mostra esta ajuda
/ask <pergunta> → Pergunta à IA especialista`, { parse_mode: "HTML" });
        break;
        
      case "/status":
        try {
          // Obter informações do servidor
          const playerList = await runRconCommand("list");
          const tpsInfo = await runRconCommand("forge tps");
          const uptime = Math.floor((Date.now() - serverStartTime) / 3600000);
          
          // Informações de sistema
          const freeMem = os.freemem() / 1024 / 1024 / 1024;
          const totalMem = os.totalmem() / 1024 / 1024 / 1024;
          const memUsage = ((1 - (freeMem / totalMem)) * 100).toFixed(1);
          const loadAvg = os.loadavg()[0];
          
          let statusMsg = `🖥️ <b>Status do Servidor</b>\n\n`;
          statusMsg += `⏰ <b>Uptime:</b> ${uptime}h\n`;
          statusMsg += `👥 <b>Jogadores:</b> ${playerList}\n`;
          statusMsg += `📊 <b>Memória:</b> ${memUsage}% usado\n`;
          statusMsg += `🔧 <b>Load AVG:</b> ${loadAvg.toFixed(2)}\n`;
          
          if (tpsInfo && !tpsInfo.includes("Erro")) {
            statusMsg += `⚡ <b>TPS:</b> ${tpsInfo}\n`;
          }
          
          bot.sendMessage(chatId, statusMsg, { parse_mode: "HTML" });
        } catch (err) {
          bot.sendMessage(chatId, `❌ Erro ao obter status: ${err.message}`);
        }
        break;
        
      case "/players":
        const players = await runRconCommand("list");
        bot.sendMessage(chatId, `👥 <b>Jogadores online:</b>\n${players}`, { parse_mode: "HTML" });
        break;
        
      case "/ping":
        const ping = await runRconCommand("ping");
        bot.sendMessage(chatId, `🏓 <b>Ping:</b> ${ping}`, { parse_mode: "HTML" });
        break;
        
      case "/topkills":
        const topKills = Object.entries(playerKills)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([player, kills], index) => `${index + 1}. ${player}: ${kills} kills`)
          .join("\n");
        
        bot.sendMessage(chatId, `⚔️ <b>Top 10 Killers:</b>\n${topKills || "Nenhum kill registrado ainda"}`, { parse_mode: "HTML" });
        break;
        
      case "/uptime":
        const uptimeHours = Math.floor((Date.now() - serverStartTime) / 3600000);
        bot.sendMessage(chatId, `⏰ <b>Uptime:</b> ${uptimeHours} horas`, { parse_mode: "HTML" });
        break;
        
      case "/run":
        if (!text.includes(" ")) {
          bot.sendMessage(chatId, "⚠️ Use: /run <comando>");
          break;
        }
        
        const cmd = text.substring(5);
        const result = await runRconCommand(cmd);
        bot.sendMessage(chatId, `🔧 <b>Comando executado:</b> ${cmd}\n📋 <b>Resultado:</b>\n${result}`, { parse_mode: "HTML" });
        break;
        
      case "/backup":
        bot.sendMessage(chatId, "🔄 Iniciando backup...");
        const backupResult = await createBackup();
        if (backupResult) {
          bot.sendMessage(chatId, "✅ Backup concluído com sucesso!");
        }
        break;
        
      case "/clearlogs":
        // Implementar limpeza de logs
        bot.sendMessage(chatId, "📁 Limpeza de logs (implementação em desenvolvimento)");
        break;
        
      case "/stopserver":
        const stopConfirm = await runRconCommand("stop");
        bot.sendMessage(chatId, `🛑 <b>Parando servidor:</b>\n${stopConfirm}`, { parse_mode: "HTML" });
        break;
        
      case "/startserver":
        // Isso precisaria de integração com sistema de init do servidor
        bot.sendMessage(chatId, "⚠️ Comando /startserver precisa de configuração adicional");
        break;
        
      case "/ask":
        if (!text.includes(" ")) {
          bot.sendMessage(chatId, "⚠️ Use: /ask <sua pergunta>");
          break;
        }
        
        const question = text.substring(5);
        bot.sendMessage(chatId, "🤖 Consultando IA especialista...");
        const answer = await askAI(question);
        bot.sendMessage(chatId, `🤖 <b>Resposta da IA:</b>\n${answer}`, { parse_mode: "HTML" });
        break;
        
      default:
        bot.sendMessage(chatId, "❌ Comando não reconhecido. Use /help para ver os comandos disponíveis.");
    }
  } else {
    // Se não for comando, enviar para IA
    const aiRes = await askAI(text);
    bot.sendMessage(chatId, `🤖 <b>IA:</b> ${aiRes}`, { parse_mode: "HTML" });
  }
});

// === Relatório diário ===
function setupDailyReport() {
  // Agendar para enviar às 10h todo dia
  const now = new Date();
  const targetTime = new Date(now);
  targetTime.setHours(10, 0, 0, 0);
  
  if (now > targetTime) {
    targetTime.setDate(targetTime.getDate() + 1);
  }
  
  const timeUntilReport = targetTime - now;
  
  setTimeout(() => {
    sendDailyReport();
    // Agendar próximo relatório para o mesmo horário no dia seguinte
    setInterval(sendDailyReport, 24 * 60 * 60 * 1000);
  }, timeUntilReport);
}

async function sendDailyReport() {
  try {
    const playerList = await runRconCommand("list");
    const uptimeHours = Math.floor((Date.now() - serverStartTime) / 3600000);
    
    // Top 5 killers
    const topKillers = Object.entries(playerKills)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([player, kills]) => `${player}: ${kills} kills`)
      .join("\n");
    
    let report = `📊 <b>Relatório Diário do Servidor</b>\n\n`;
    report += `⏰ <b>Uptime:</b> ${uptimeHours} horas\n`;
    report += `👥 <b>Jogadores online:</b> ${playerList}\n`;
    report += `⚔️ <b>Top killers:</b>\n${topKillers || "Nenhum kill registrado"}\n`;
    report += `💥 <b>Crashes hoje:</b> ${sentCrashes.size}\n`;
    report += `✅ <b>Último backup:</b> ${lastBackupTime ? new Date(lastBackupTime).toLocaleString() : "Nunca"}`;
    
    sendTelegram(report);
  } catch (err) {
    console.error("Erro ao enviar relatório diário:", err);
  }
}

// === Inicialização ===
(async () => {
  console.log("🚀 Iniciando MC Render Bot...");
  
  // Criar diretórios necessários
  if (!fs.existsSync(BOT_LOG_DIR)) {
    fs.mkdirSync(BOT_LOG_DIR, { recursive: true });
  }
  
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  
  try {
    await connectRcon();
    await monitorLogs();
    monitorPerformance();
    setupAutoBackup();
    setupDailyReport();
    
    console.log("✅ mc_render_bot em execução!");
    sendTelegram("🤖 Bot iniciado com sucesso! Use /help para ver os comandos.");
  } catch (error) {
    console.error("Erro na inicialização:", error);
    sendTelegram(`❌ Erro na inicialização do bot: ${error.message}`);
  }
})();

// === Tratamento de erros ===
process.on("unhandledRejection", err => {
  console.error("Unhandled Rejection:", err);
  sendTelegram(`⚠️ Erro não tratado: ${err.message}`);
});

process.on("uncaughtException", err => {
  console.error("Uncaught Exception:", err);
  sendTelegram(`⚠️ Exceção não capturada: ${err.message}`);
});

// === HTTP server ===
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end("✅ MC Render Bot online\nUptime: " + Math.floor((Date.now() - serverStartTime) / 3600000) + " horas");
}).listen(PORT, () => {
  console.log(`🌐 HTTP server na porta ${PORT}`);
});