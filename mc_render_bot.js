/**
 * mc_render_bot.js - Versão completa com todas as melhorias solicitadas
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
const { exec, spawn } = require("child_process");
const bestzip = require("bestzip");
const cron = require("node-cron");

// === Configurações do .env ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_BOT2_TOKEN = process.env.TELEGRAM_BOT2_TOKEN; // Novo bot para IA
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
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MEMORY_THRESHOLD = parseFloat(process.env.MEMORY_THRESHOLD || 0.8);
const TPS_THRESHOLD = parseFloat(process.env.TPS_THRESHOLD || 18);
const CRASH_COOLDOWN = parseInt(process.env.CRASH_COOLDOWN || 300000);
const CHAT_FLOOD_COOLDOWN = parseInt(process.env.CHAT_FLOOD_COOLDOWN || 2000);
const BACKUP_INTERVAL = parseInt(process.env.BACKUP_INTERVAL || 1440);
const BACKUP_INCREMENTAL_INTERVAL = parseInt(process.env.BACKUP_INCREMENTAL_INTERVAL || 240);
const PING_INTERVAL = parseInt(process.env.PING_INTERVAL || 60);
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || 7);
const PORT = process.env.PORT || 4000;
const SERVER_START_COMMAND = process.env.SERVER_START_COMMAND || "java -jar server.jar nogui";

// === Inicializações ===
require("events").defaultMaxListeners = 50;
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

// === Detecção de erros de mods específicos ===
const MOD_ERRORS = {
  'kubejs': ['kubejs error', 'script error', 'kubejs.exception'],
  'create': ['create mod error', 'contraption crash', 'create.network'],
  'jei': ['jei exception', 'recipe error', 'jei.config'],
  'tconstruct': ['tinkers', 'smeltery error', 'tconstruct'],
  'thermal': ['thermal', 'cofh', 'dynamo'],
  'mekanism': ['mekanism', 'chemical', 'gas'],
  'ftb': ['ftb', 'team', 'quest'],
  'ae2': ['applied energistics', 'ae2', 'me system']
};

// === Gemini + OpenAI + Groq ===
let geminiIndex = 0;
let genAI = GEMINI_KEYS.length ? new GoogleGenerativeAI(GEMINI_KEYS[0]) : null;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
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

// === Função IA ===
async function askAI(question) {
  let lastError = "";

  // 1️⃣ OpenAI
  if (openai) {
    try {
      const res = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: IA_SYSTEM_PROMPT },
          { role: "user", content: question }
        ],
        max_tokens: 300
      });
      return res.choices[0].message.content;
    } catch (err) {
      if (!err.message.includes("429")) lastError = err.message;
    }
  }

  // 2️⃣ Groq
  if (groq) {
    try {
      let res;
      try {
        res = await groq.chat.completions.create({
          model: "llama-3.3-70b-versatile",
          messages: [
            { role: "system", content: IA_SYSTEM_PROMPT },
            { role: "user", content: question }
          ],
          max_tokens: 300
        });
      } catch (err) {
        if (err.message.includes("model_decommissioned")) {
          res = await groq.chat.completions.create({
            model: "llama-3.3-8b-instant",
            messages: [
              { role: "system", content: IA_SYSTEM_PROMPT },
              { role: "user", content: question }
            ],
            max_tokens: 300
          });
        } else {
          throw err;
        }
      }
      return res.choices[0].message.content;
    } catch (err) {
      lastError = err.message;
    }
  }

  // 3️⃣ DeepSeek
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
          max_tokens: 300
        })
      });
      const data = await res.json();
      if (data.choices?.[0]?.message?.content) return data.choices[0].message.content;
    } catch (err) {
      if (!err.message.includes("429")) lastError = err.message;
    }
  }

  // 4️⃣ Gemini
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    try {
      genAI = new GoogleGenerativeAI(GEMINI_KEYS[geminiIndex]);
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      const result = await model.generateContent([IA_SYSTEM_PROMPT, question]);
      geminiIndex = (geminiIndex + 1) % GEMINI_KEYS.length;
      return result.response.text();
    } catch (err) {
      if (!err.message.includes("429")) lastError = err.message;
      geminiIndex = (geminiIndex + 1) % GEMINI_KEYS.length;
    }
  }

  return `⚠ Nenhuma IA pôde responder: ${lastError}`;
}

// === Função segura para enviar mensagens ===
function safeSend(chatId, text, opts = {}) {
  bot.sendMessage(chatId, text, opts).catch(err => {
    console.error("Erro Telegram:", err.message);
  });
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
async function createBackup(incremental = false) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupType = incremental ? 'incremental' : 'full';
    const backupFileName = `backup-${backupType}-${timestamp}.zip`;
    const backupPath = path.join(BACKUP_DIR, backupFileName);
    
    // Criar diretório de backup se não existir
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
    
    sendTelegram(`🔄 Iniciando backup ${backupType} do mundo...`);
    
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
    
    if (incremental) {
      lastIncrementalBackupTime = Date.now();
    } else {
      lastBackupTime = Date.now();
    }
    
    sendTelegram(`✅ Backup ${backupType} concluído: ${backupFileName}`);
    return true;
  } catch (err) {
    console.error("Erro no backup:", err);
    sendTelegram(`❌ Erro no backup ${incremental ? 'incremental' : 'completo'}: ${err.message}`);
    return false;
  }
}

// === Função para iniciar o servidor ===
async function startServer() {
  try {
    if (serverProcess) {
      return "❌ Servidor já está em execução";
    }
    
    sendTelegram("🔄 Iniciando servidor Minecraft...");
    
    serverProcess = spawn(SERVER_START_COMMAND, {
      shell: true,
      cwd: path.dirname(WORLD_DIR)
    });
    
    serverProcess.stdout.on('data', (data) => {
      console.log(`Servidor: ${data}`);
    });
    
    serverProcess.stderr.on('data', (data) => {
      console.error(`Servidor (erro): ${data}`);
    });
    
    serverProcess.on('close', (code) => {
      sendTelegram(`🔴 Servidor fechado com código: ${code}`);
      serverProcess = null;
    });
    
    // Aguardar um pouco para o servidor iniciar
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Reconectar RCON após iniciar o servidor
    await connectRcon();
    
    return "✅ Servidor iniciado com sucesso!";
  } catch (err) {
    return `❌ Erro ao iniciar servidor: ${err.message}`;
  }
}

// === Função para parar o servidor ===
async function stopServer() {
  try {
    if (!serverProcess) {
      const result = await runRconCommand("stop");
      return `✅ Comando de parada enviado: ${result}`;
    }
    
    sendTelegram("🔄 Parando servidor Minecraft...");
    serverProcess.kill('SIGINT');
    
    // Aguardar processo terminar
    await new Promise(resolve => {
      if (serverProcess) {
        serverProcess.on('close', resolve);
      } else {
        resolve();
      }
    });
    
    serverProcess = null;
    return "✅ Servidor parado com sucesso!";
  } catch (err) {
    return `❌ Erro ao parar servidor: ${err.message}`;
  }
}

// === Limpeza de logs ===
async function clearLogs() {
  try {
    await sftp.connect({ host: SFTP_HOST, port: SFTP_PORT, username: SFTP_USER, password: SFTP_PASSWORD });
    
    // Limpar logs do Minecraft
    const logs = await sftp.list(MC_LOG_DIR);
    const now = Date.now();
    const retentionTime = now - (LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    
    for (const file of logs) {
      if (file.name !== 'latest.log' && file.modifyTime < retentionTime) {
        await sftp.delete(path.posix.join(MC_LOG_DIR, file.name));
      }
    }
    
    // Limpar crash reports antigos
    const crashes = await sftp.list(MC_CRASH_DIR);
    for (const file of crashes) {
      if (file.name.endsWith('.txt') && file.modifyTime < retentionTime) {
        await sftp.delete(path.posix.join(MC_CRASH_DIR, file.name));
      }
    }
    
    await sftp.end();
    return `✅ Logs com mais de ${LOG_RETENTION_DAYS} dias foram limpos!`;
  } catch (err) {
    return `❌ Erro ao limpar logs: ${err.message}`;
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
          
          // Verificar chunks carregados se TPS estiver baixo
          const chunkResponse = await runRconCommand("forge chunk summary");
          if (chunkResponse && !chunkResponse.includes("Erro")) {
            sendTelegram(`📊 Chunks carregados:\n${chunkResponse.substring(0, 300)}`);
          }
        }
      }
      
      // Verificar uso de memória
      const freeMem = os.freemem();
      const totalMem = os.totalmem();
      const memUsage = 1 - (freeMem / totalMem);
      
      if (memUsage > MEMORY_THRESHOLD) {
        sendTelegram(`⚠️ Uso alto de memória: ${(memUsage * 100).toFixed(1)}%`);
        
        // Tentar limpar memória se estiver muito alta
        if (memUsage > 0.9) {
          await runRconCommand("forge gc");
          sendTelegram("🔄 Coleta de lixo forçada executada");
        }
      }
      
      // Verificar carga da CPU
      const loadAvg = os.loadavg()[0];
      const cpuCores = os.cpus().length;
      if (loadAvg > cpuCores * 0.8) {
        sendTelegram(`⚠️ Carga alta da CPU: ${loadAvg.toFixed(2)} (máx recomendado: ${(cpuCores * 0.8).toFixed(1)})`);
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
                const player = m[1];
                sendTelegram(`✅ <b>${player}</b> entrou no servidor`);
                playerPlaytime[player] = playerPlaytime[player] || { 
                  firstJoin: Date.now(), 
                  lastJoin: Date.now(), 
                  totalTime: 0 
                };
                playerPlaytime[player].lastJoin = Date.now();
              }
            } 
            // Jogador saiu
            else if (line.includes("left the game")) {
              const m = line.match(/(\w+) left the game/);
              if (m) {
                const player = m[1];
                sendTelegram(`❌ <b>${player}</b> saiu do servidor`);
                if (playerPlaytime[player]) {
                  const sessionTime = Date.now() - playerPlaytime[player].lastJoin;
                  playerPlaytime[player].totalTime += sessionTime;
                }
              }
            } 
            // Kill no jogo
            else if (line.includes("was slain by") || line.includes("was killed by")) {
              sendTelegram(`⚔️ ${line}`);
              
              // Contabilizar kills e deaths
              const killMatch = line.match(/(\w+) was (slain|killed) by (\w+)/);
              if (killMatch) {
                const victim = killMatch[1];
                const killer = killMatch[3];
                playerKills[killer] = (playerKills[killer] || 0) + 1;
                playerDeaths[victim] = (playerDeaths[victim] || 0) + 1;
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
            else if (line.toLowerCase().includes("error") || line.toLowerCase().includes("exception") || line.toLowerCase().includes("warn")) {
              if (line.length < 200) { // Não enviar logs muito longos
                // Verificar se é erro de mod específico
                let isModError = false;
                for (const [mod, keywords] of Object.entries(MOD_ERRORS)) {
                  for (const keyword of keywords) {
                    if (line.toLowerCase().includes(keyword)) {
                      sendTelegram(`🚨 <b>ERRO DE MOD [${mod.toUpperCase()}]:</b>\n${line}`);
                      isModError = true;
                      break;
                    }
                  }
                  if (isModError) break;
                }
                
                if (!isModError) {
                  sendTelegram(`⚠️ <b>Log importante:</b> ${line}`);
                }
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
                sendTelegram(`📜 [KubeJS/${file}] ${line.substring(0, 200)}`);
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
  // Backup completo
  setInterval(async () => {
    await createBackup(false);
  }, BACKUP_INTERVAL * 60 * 1000); // Converter minutos para ms
  
  // Backup incremental
  setInterval(async () => {
    await createBackup(true);
  }, BACKUP_INCREMENTAL_INTERVAL * 60 * 1000);
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
        bot.sendMessage(chatId, `
📖 <b>Comandos disponíveis:</b>

👥 <b>Informações:</b>
/status → <code>Status do servidor (memória, TPS, jogadores)</code>
/players → <code>Lista de jogadores online</code>
/ping → <code>Mostra ping do servidor</code>
/topkills → <code>Ranking de kills por jogador</code>
/topdeaths → <code>Ranking de mortes por jogador</code>
/topplaytime → <code>Ranking de tempo jogado</code>
/uptime → <code>Tempo de atividade do servidor</code>
/stats <code>jogador</code> → <code>Estatísticas de um jogador</code>

⚙️ <b>Controle:</b>
/run <code>comando</code> → <code>Executa comando no servidor</code>
/backup → <code>Cria backup completo do mundo</code>
/backup incremental → <code>Cria backup incremental</code>
/clearlogs → <code>Limpa logs antigos</code>
/stopserver → <code>Para o servidor</code>
/startserver → <code>Inicia o servidor</code>
/restartserver → <code>Reinicia o servidor</code>

❓ <b>Ajuda:</b>
/help → <code>Mostra esta ajuda</code>
/ask <code>pergunta</code> → <code>Pergunta à IA especialista</code>
        `, { parse_mode: "HTML" });
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
          const cpuCores = os.cpus().length;
          
          let statusMsg = `🖥️ <b>Status do Servidor</b>\n\n`;
          statusMsg += `⏰ <b>Uptime:</b> ${uptime}h\n`;
          statusMsg += `👥 <b>Jogadores:</b> ${playerList}\n`;
          statusMsg += `📊 <b>Memória:</b> ${memUsage}% usado (${(totalMem - freeMem).toFixed(1)}/${totalMem.toFixed(1)} GB)\n`;
          statusMsg += `🔧 <b>Load AVG:</b> ${loadAvg.toFixed(2)}/${cpuCores}\n`;
          statusMsg += `💥 <b>Crashes hoje:</b> ${sentCrashes.size}\n`;
          
          if (tpsInfo && !tpsInfo.includes("Erro")) {
            statusMsg += `⚡ <b>TPS:</b> ${tpsInfo}\n`;
          }
          
          if (lastBackupTime > 0) {
            const lastBackupHours = Math.floor((Date.now() - lastBackupTime) / 3600000);
            statusMsg += `💾 <b>Último backup:</b> ${lastBackupHours}h atrás\n`;
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
        
      case "/topdeaths":
        const topDeaths = Object.entries(playerDeaths)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([player, deaths], index) => `${index + 1}. ${player}: ${deaths} mortes`)
          .join("\n");
        
        bot.sendMessage(chatId, `💀 <b>Top 10 Mortes:</b>\n${topDeaths || "Nenhuma morte registrada ainda"}`, { parse_mode: "HTML" });
        break;
        
      case "/topplaytime":
        const topPlaytime = Object.entries(playerPlaytime)
          .sort((a, b) => b[1].totalTime - a[1].totalTime)
          .slice(0, 10)
          .map(([player, data], index) => {
            const hours = Math.floor(data.totalTime / 3600000);
            return `${index + 1}. ${player}: ${hours}h`;
          })
          .join("\n");
        
        bot.sendMessage(chatId, `⏰ <b>Top 10 Tempo Jogado:</b>\n${topPlaytime || "Nenhum dado de playtime ainda"}`, { parse_mode: "HTML" });
        break;
        
      case "/stats":
        if (!text.includes(" ")) {
          bot.sendMessage(chatId, "⚠️ Use: /stats <jogador>");
          break;
        }
        
        const playerName = text.substring(6).trim();
        const kills = playerKills[playerName] || 0;
        const deaths = playerDeaths[playerName] || 0;
        const kdRatio = deaths > 0 ? (kills / deaths).toFixed(2) : kills > 0 ? "∞" : "0";
        const playtimeData = playerPlaytime[playerName];
        const playtimeHours = playtimeData ? Math.floor(playtimeData.totalTime / 3600000) : 0;
        
        let statsMsg = `📊 <b>Estatísticas de ${playerName}:</b>\n\n`;
        statsMsg += `⚔️ <b>Kills:</b> ${kills}\n`;
        statsMsg += `💀 <b>Mortes:</b> ${deaths}\n`;
        statsMsg += `🎯 <b>K/D Ratio:</b> ${kdRatio}\n`;
        statsMsg += `⏰ <b>Tempo jogado:</b> ${playtimeHours}h\n`;
        
        if (playtimeData) {
          const firstJoin = new Date(playtimeData.firstJoin).toLocaleDateString();
          statsMsg += `📅 <b>Primeiro join:</b> ${firstJoin}\n`;
        }
        
        bot.sendMessage(chatId, statsMsg, { parse_mode: "HTML" });
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
        const isIncremental = text.includes("incremental");
        bot.sendMessage(chatId, `🔄 Iniciando backup ${isIncremental ? 'incremental' : 'completo'}...`);
        const backupResult = await createBackup(isIncremental);
        if (backupResult) {
          bot.sendMessage(chatId, `✅ Backup ${isIncremental ? 'incremental' : 'completo'} concluído com sucesso!`);
        }
        break;
        
      case "/clearlogs":
        bot.sendMessage(chatId, "🔄 Limpando logs antigos...");
        const clearResult = await clearLogs();
        bot.sendMessage(chatId, clearResult);
        break;
        
      case "/stopserver":
        const stopResult = await stopServer();
        bot.sendMessage(chatId, stopResult);
        break;
        
      case "/startserver":
        bot.sendMessage(chatId, "🔄 Iniciando servidor...");
        const startResult = await startServer();
        bot.sendMessage(chatId, startResult);
        break;
        
      case "/restartserver":
        bot.sendMessage(chatId, "🔄 Reiniciando servidor...");
        await stopServer();
        // Aguardar 10 segundos antes de iniciar
        await new Promise(resolve => setTimeout(resolve, 10000));
        const restartResult = await startServer();
        bot.sendMessage(chatId, restartResult);
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

// === Configurar bot2 (IA especialista) ===
if (bot2) {
  bot2.on("message", async (msg) => {
    const text = msg.text?.trim();
    if (!text) return;
    
    // Anti-flood para comandos
    const userId = msg.from.id.toString();
    const now = Date.now();
    if (commandCooldowns[userId] && now - commandCooldowns[userId] < 2000) {
      return bot2.sendMessage(msg.chat.id, "⏳ Aguarde um pouco antes de enviar outra pergunta.");
    }
    commandCooldowns[userId] = now;
    
    bot2.sendMessage(msg.chat.id, "🤖 Consultando especialista Minecraft...");
    const answer = await askAI(text);
    bot2.sendMessage(msg.chat.id, `🎮 <b>Especialista Minecraft:</b>\n${answer}`, { 
      parse_mode: "HTML" 
    });
  });
}

// === Relatório diário ===
function setupDailyReport() {
  // Agendar para enviar às 10h todo dia
  cron.schedule('0 10 * * *', async () => {
    await sendDailyReport();
  });
  
  // Enviar primeiro relatório agora
  setTimeout(sendDailyReport, 5000);
}

async function sendDailyReport() {
  try {
    const playerList = await runRconCommand("list");
    const uptimeHours = Math.floor((Date.now() - serverStartTime) / 3600000);
    
    // Top 5 killers
    const topKillers = Object.entries(playerKills)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([player, kills], index) => `${index + 1}. ${player}: ${kills} kills`)
      .join("\n");
    
    // Top 5 tempo jogado
    const topPlayers = Object.entries(playerPlaytime)
      .sort((a, b) => b[1].totalTime - a[1].totalTime)
      .slice(0, 5)
      .map(([player, data], index) => {
        const hours = Math.floor(data.totalTime / 3600000);
        return `${index + 1}. ${player}: ${hours}h`;
      })
      .join("\n");
    
    let report = `📊 <b>Relatório Diário do Servidor</b>\n\n`;
    report += `⏰ <b>Uptime:</b> ${uptimeHours} horas\n`;
    report += `👥 <b>Jogadores online:</b> ${playerList}\n`;
    report += `⚔️ <b>Top killers:</b>\n${topKillers || "Nenhum kill registrado"}\n`;
    report += `⏰ <b>Top tempo jogado:</b>\n${topPlayers || "Nenhum dado de playtime"}\n`;
    report += `💥 <b>Crashes hoje:</b> ${sentCrashes.size}\n`;
    report += `✅ <b>Último backup completo:</b> ${lastBackupTime ? new Date(lastBackupTime).toLocaleString() : "Nunca"}\n`;
    report += `🔄 <b>Último backup incremental:</b> ${lastIncrementalBackupTime ? new Date(lastIncrementalBackupTime).toLocaleString() : "Nunca"}`;
    
    sendTelegram(report);
  } catch (err) {
    console.error("Erro ao enviar relatório diário:", err);
  }
}

// === Relatório semanal ===
function setupWeeklyReport() {
  // Agendar para enviar às 10h todo domingo
  cron.schedule('0 10 * * 0', async () => {
    await sendWeeklyReport();
  });
}

async function sendWeeklyReport() {
  try {
    const uptimeHours = Math.floor((Date.now() - serverStartTime) / 3600000);
    
    // Top 10 killers da semana
    const weeklyKills = Object.entries(playerKills)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([player, kills], index) => `${index + 1}. ${player}: ${kills} kills`)
      .join("\n");
    
    // Top 10 tempo jogado da semana
    const weeklyPlaytime = Object.entries(playerPlaytime)
      .sort((a, b) => b[1].totalTime - a[1].totalTime)
      .slice(0, 10)
      .map(([player, data], index) => {
        const hours = Math.floor(data.totalTime / 3600000);
        return `${index + 1}. ${player}: ${hours}h`;
      })
      .join("\n");
    
    let report = `📈 <b>Relatório Semanal do Servidor</b>\n\n`;
    report += `⏰ <b>Uptime total:</b> ${uptimeHours} horas\n`;
    report += `⚔️ <b>Top killers da semana:</b>\n${weeklyKills || "Nenhum kill registrado"}\n`;
    report += `⏰ <b>Top tempo jogado da semana:</b>\n${weeklyPlaytime || "Nenhum dado de playtime"}\n`;
    report += `💥 <b>Total de crashes:</b> ${sentCrashes.size}\n`;
    report += `📅 <b>Período:</b> ${new Date().toLocaleDateString()}`;
    
    sendTelegram(report);
  } catch (err) {
    console.error("Erro ao enviar relatório semanal:", err);
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
    setupWeeklyReport();
    
    console.log("✅ mc_render_bot em execução!");
    if (bot2) {
      console.log("✅ Bot2 (IA) em execução!");
    }
    
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