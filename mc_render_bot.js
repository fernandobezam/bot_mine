/**
 * mc_render_bot.js - v2.1 FINAL E COMPLETO
 * Bot completo para gerenciamento e monitoramento em tempo real de servidor Minecraft.
 * INCLUI: Monitoramento de jogadores, espelho de chat, detecção de travamento/crash e comando /ping.
 */

// ==============================
//  Importações e Configuração Inicial
// ==============================
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const SftpClient = require("ssh2-sftp-client");
const path = require("path");
const fs = require("fs");
const { Rcon } = require("rcon-client");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const OpenAI = require("openai");
const Groq = require("groq-sdk");
const { spawn } = require("child_process");
const bestzip = require("bestzip");
const http = require("http");

// ==============================
//  Carregamento das Variáveis de Ambiente (.env)
// ==============================
const {
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    SFTP_HOST,
    SFTP_PORT = "22",
    SFTP_USER,
    SFTP_PASSWORD,
    MC_LOG_DIR,
    MC_CRASH_DIR,
    WORLD_DIR,
    BACKUP_DIR = "./backups",
    RCON_HOST,
    RCON_PORT = "25575",
    RCON_PASSWORD,
    GEMINI_API_KEY_1,
    GEMINI_API_KEY_2,
    OPENAI_API_KEY,
    DEEPSEEK_API_KEY,
    GROQ_API_KEY,
    STABILITY_API_KEY,
    SERVER_START_COMMAND,
    PORT = 4000
} = process.env;

const GEMINI_KEYS = [GEMINI_API_KEY_1, GEMINI_API_KEY_2].filter(Boolean);

// ==============================
//  Globais e Inicializações
// ==============================
const bot = TELEGRAM_BOT_TOKEN ? new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true }) : null;
let rcon = null;
let serverProcess = null;
let serverStartTime = Date.now();
let geminiIndex = 0;
let sentCrashes = new Set();
let rconConsecutiveFails = 0;
let isServerConsideredDown = false;

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
let genAI = GEMINI_KEYS.length ? new GoogleGenerativeAI(GEMINI_KEYS[0]) : null;

// ==============================
//  Funções Utilitárias
// ==============================
function escapeHtml(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ==============================
//  Sistema de Fila do Telegram (Anti-Flood)
// ==============================
const messageQueue = [];
let isProcessingQueue = false;
let lastMessageTime = 0;

function processQueue() {
    if (isProcessingQueue || messageQueue.length === 0) return;
    isProcessingQueue = true;
    const item = messageQueue.shift();
    const now = Date.now();
    const wait = Math.max(0, 1500 - (now - lastMessageTime));

    setTimeout(async () => {
        try {
            await bot.sendMessage(item.chatId, item.msg, item.options);
            lastMessageTime = Date.now();
            item.resolve();
        } catch (err) {
            console.error("Telegram API Error:", err.message);
            item.reject(err);
        } finally {
            isProcessingQueue = false;
            processQueue();
        }
    }, wait);
}

function sendTelegram(chatId, msg, options = { parse_mode: "HTML", disable_notification: true }) {
    if (!bot || !chatId) return Promise.resolve();
    return new Promise((resolve, reject) => {
        messageQueue.push({ chatId, msg, options, resolve, reject });
        processQueue();
    });
}

async function sendLongMessage(chatId, text, options = { parse_mode: "HTML", disable_notification: true }) {
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
        return sendTelegram(chatId, text, options);
    }
    const parts = text.match(new RegExp(`.{1,${MAX_LENGTH}}`, "gs")) || [];
    for (const part of parts) {
        await sendTelegram(chatId, part, options);
    }
}

// ==============================
//  Funções de Inteligência Artificial
// ==============================
const IA_SYSTEM_PROMPT = `Você é um especialista em Minecraft e no modpack Integrated MC. Seja direto, técnico e amigável.`;

async function askAI(question) {
    const providers = [
        { name: "OpenAI", fn: () => openai?.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "system", content: IA_SYSTEM_PROMPT }, { role: "user", content: question }] }) },
        { name: "Groq", fn: () => groq?.chat.completions.create({ model: "llama-3.1-70b-versatile", messages: [{ role: "system", content: IA_SYSTEM_PROMPT }, { role: "user", content: question }] }) },
        { name: "Gemini", fn: async () => {
            if (!GEMINI_KEYS.length) return null;
            genAI = new GoogleGenerativeAI(GEMINI_KEYS[geminiIndex]);
            geminiIndex = (geminiIndex + 1) % GEMINI_KEYS.length;
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const result = await model.generateContent(question);
            return result.response;
        }}
    ];

    for (const provider of providers) {
        try {
            const res = await provider.fn();
            const content = res?.choices?.[0]?.message?.content || res?.text();
            if (content) {
                console.log(`IA Respondida por: ${provider.name}`);
                return content;
            }
        } catch (err) {
            console.warn(`Erro na IA (${provider.name}):`, err.message);
        }
    }
    return "Desculpe, nenhuma de minhas IAs conseguiu processar sua solicitação no momento.";
}

async function analyzeImage(chatId, imageUrl) {
    await sendLongMessage(chatId, "🔍 Analisando imagem, um momento...");
    const userPrompt = "Analise esta imagem do jogo Minecraft. Descreva o que você vê, o que o jogador provavelmente está fazendo e quais mods podem estar envolvidos.";
    
    if (openai) {
        try {
            const res = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: [{ type: "text", text: userPrompt }, { type: "image_url", image_url: { url: imageUrl } }] }],
                max_tokens: 500
            });
            if (res.choices[0].message.content) {
                return sendLongMessage(chatId, `️️️️️📷 <b>Análise (OpenAI):</b>\n${escapeHtml(res.choices[0].message.content)}`);
            }
        } catch (err) { console.warn("OpenAI Vision error:", err.message); }
    }

    if (GEMINI_KEYS.length) {
        try {
            console.log("Fallback: Tentando analisar com Gemini...");
            genAI = new GoogleGenerativeAI(GEMINI_KEYS[geminiIndex]);
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const response = await fetch(imageUrl);
            const arrayBuffer = await response.arrayBuffer();
            const imageBuffer = Buffer.from(arrayBuffer);
            const result = await model.generateContent([userPrompt, { inlineData: { data: imageBuffer.toString("base64"), mimeType: "image/jpeg" } }]);
            geminiIndex = (geminiIndex + 1) % GEMINI_KEYS.length;
            if (result.response.text()) {
                return sendLongMessage(chatId, `📷 <b>Análise (Gemini):</b>\n${escapeHtml(result.response.text())}`);
            }
        } catch (err) { 
            console.warn("Gemini Vision error:", err.message);
            geminiIndex = (geminiIndex + 1) % GEMINI_KEYS.length;
        }
    }

    return sendLongMessage(chatId, "❌ Nenhuma IA conseguiu analisar a imagem. Verifique suas cotas de API.");
}

async function generateImage(prompt) {
    if (openai) {
        try {
            console.log("Tentando gerar imagem com DALL-E 3...");
            const res = await openai.images.generate({ model: "dall-e-3", prompt, n: 1, size: "1024x1024" });
            if (res.data[0].url) return { source: "DALL-E 3", url: res.data[0].url };
        } catch (err) { console.warn("DALL-E 3 error:", err.message); }
    }
    
    if (STABILITY_API_KEY) {
        try {
            console.log("Fallback: Tentando gerar com Stability AI...");
            const response = await fetch("https://api.stability.ai/v2/stable-image/generate/sd3", {
                method: "POST",
                headers: { Authorization: `Bearer ${STABILITY_API_KEY}`, Accept: "image/*" },
                body: new URLSearchParams({ prompt, output_format: "png" })
            });
            if (!response.ok) throw new Error(`API retornou status ${response.status}`);
            const buffer = await response.buffer();
            return { source: "Stable Diffusion", url: `data:image/png;base64,${buffer.toString("base64")}` };
        } catch (err) { console.warn("Stability AI error:", err.message); }
    }
    return null;
}

// ==============================
//  Funções de Gerenciamento do Servidor
// ==============================
async function connectRcon() {
    if (!RCON_HOST || !RCON_PASSWORD) return false;
    try {
        if (rcon) await rcon.end();
        rcon = new Rcon({ host: RCON_HOST, port: parseInt(RCON_PORT), password: RCON_PASSWORD, timeout: 10000 });
        await rcon.connect();
        console.log("✅ RCON conectado!");
        return true;
    } catch (err) {
        console.error("Erro ao conectar RCON:", err.message);
        rcon = null;
        return false;
    }
}

async function runRconCommand(cmd) {
    if (!rcon || !rcon.socket.writable) {
        if (!await connectRcon()) {
            throw new Error("RCON não está conectado.");
        }
    }
    try {
        return await rcon.send(cmd);
    } catch (err) {
        console.error(`Erro ao executar RCON '${cmd}':`, err.message);
        throw err;
    }
}

async function startServer() {
    if (serverProcess) return "❌ O servidor já está em execução.";
    if (!SERVER_START_COMMAND) return "❌ O comando de inicialização não foi definido no .env.";
    await sendLongMessage(TELEGRAM_CHAT_ID, "🔄 Iniciando o servidor Minecraft...");
    const [command, ...args] = SERVER_START_COMMAND.split(" ");
    serverProcess = spawn(command, args, { cwd: path.dirname(WORLD_DIR || '.'), shell: true });
    serverProcess.on('close', code => {
        sendLongMessage(TELEGRAM_CHAT_ID, `🔴 Servidor parado com código ${code}.`);
        serverProcess = null;
    });
    return "✅ Comando de inicialização enviado. O servidor deve estar online em alguns minutos.";
}

async function stopServer() {
    await sendLongMessage(TELEGRAM_CHAT_ID, "🔄 Enviando comando para parar o servidor...");
    const response = await runRconCommand("stop");
    return `✅ Resposta do servidor: ${response}`;
}

async function createBackup() {
    await sendLongMessage(TELEGRAM_CHAT_ID, "🔄 Iniciando backup completo do mundo...");
    try {
        if (!WORLD_DIR) throw new Error("WORLD_DIR não está definido no .env");
        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const fileName = `backup-${timestamp}.zip`;
        const filePath = path.join(BACKUP_DIR, fileName);
        await bestzip({ source: path.basename(WORLD_DIR), destination: filePath, cwd: path.dirname(WORLD_DIR) });
        await sendLongMessage(TELEGRAM_CHAT_ID, `✅ Backup concluído com sucesso: ${fileName}`);
    } catch (err) {
        console.error("Erro no backup:", err);
        await sendLongMessage(TELEGRAM_CHAT_ID, `❌ Falha no backup: ${err.message}`);
    }
}

// ==============================
//  Monitoramento em Tempo Real
// ==============================
async function monitorLogs() {
    if (!SFTP_HOST) {
        console.log("SFTP não configurado, monitoramento de logs desabilitado.");
        return;
    }
    const sftp = new SftpClient();
    try {
        await sftp.connect({ host: SFTP_HOST, port: parseInt(SFTP_PORT), username: SFTP_USER, password: SFTP_PASSWORD });
        console.log("✅ SFTP conectado para monitoramento de logs!");

        let logSize = (await sftp.stat(path.posix.join(MC_LOG_DIR, "latest.log"))).size;
        let crashFiles = new Set( (await sftp.list(MC_CRASH_DIR)).map(f => f.name) );

        setInterval(async () => {
            try {
                const stats = await sftp.stat(path.posix.join(MC_LOG_DIR, "latest.log"));
                if (stats.size < logSize) logSize = 0; // Log resetou
                if (stats.size > logSize) {
                    const stream = sftp.createReadStream(path.posix.join(MC_LOG_DIR, "latest.log"), { start: logSize });
                    let newData = '';
                    stream.on('data', (chunk) => newData += chunk.toString('utf-8'));
                    stream.on('end', () => {
                        newData.trim().split('\n').forEach(line => {
                            if (line.includes("joined the game")) sendTelegram(TELEGRAM_CHAT_ID, `✅ ${escapeHtml(line.split("]: ")[1])}`);
                            else if (line.includes("left the game")) sendTelegram(TELEGRAM_CHAT_ID, `❌ ${escapeHtml(line.split("]: ")[1])}`);
                            else if (line.includes("]: <")) {
                                const chatMatch = line.match(/<([^>]+)> (.*)/);
                                if (chatMatch) sendTelegram(TELEGRAM_CHAT_ID, `💬 <b>${escapeHtml(chatMatch[1])}:</b> ${escapeHtml(chatMatch[2])}`);
                            }
                        });
                    });
                    logSize = stats.size;
                }
            } catch (err) { /* Ignora erros de leitura */ }

            try {
                const currentCrashFiles = await sftp.list(MC_CRASH_DIR);
                for (const file of currentCrashFiles) {
                    if (file.name.endsWith('.txt') && !sentCrashes.has(file.name)) {
                        const content = await sftp.get(path.posix.join(MC_CRASH_DIR, file.name));
                        await sendLongMessage(TELEGRAM_CHAT_ID, `💥 <b>CRASH DETECTADO!</b>\nArquivo: ${file.name}\n\n${escapeHtml(content.toString('utf-8').substring(0, 500))}...`, {disable_notification: false});
                        sentCrashes.add(file.name);
                    }
                }
            } catch(err) { console.warn("Não foi possível checar a pasta de crash reports."); }

        }, 7000); // Verifica a cada 7 segundos

    } catch (err) {
        console.error("Falha crítica na conexão SFTP para monitoramento:", err.message);
    }
}

async function monitorServerHealth() {
    setInterval(async () => {
        try {
            await runRconCommand('list');
            if (isServerConsideredDown) {
                await sendTelegram(TELEGRAM_CHAT_ID, "✅ **RECUPERADO:** O servidor voltou a responder!", {disable_notification: false});
                isServerConsideredDown = false;
            }
            rconConsecutiveFails = 0;
        } catch (error) {
            rconConsecutiveFails++;
            if (rconConsecutiveFails >= 3 && !isServerConsideredDown) {
                await sendTelegram(TELEGRAM_CHAT_ID, "⚠️ **ALERTA CRÍTICO:** O servidor não está respondendo aos comandos RCON! Ele pode ter travado ou caído.", {disable_notification: false});
                isServerConsideredDown = true;
            }
        }
    }, 2 * 60 * 1000); // A cada 2 minutos
}

// ==============================
//  Manipuladores de Comandos do Telegram
// ==============================
const commandHandlers = {
    '/help': (chatId) => sendLongMessage(chatId,
        `📖 <b>Comandos Disponíveis:</b>\n\n` +
        `▶️  /status - Ver status do servidor\n` +
        `▶️  /players - Listar jogadores online\n` +
        `▶️  /ping - Medir latência do bot\n` +
        `▶️  /backup - Iniciar um backup completo\n` +
        `▶️  /restartserver - Reiniciar o servidor\n\n` +
        `🧠  /ask &lt;pergunta&gt; - Falar com a IA\n` +
        `🎨  /image &lt;descrição&gt; - Gerar uma imagem`
    ),
    '/status': async (chatId) => {
        const players = await runRconCommand("list");
        const tps = await runRconCommand("forge tps");
        const uptime = Math.floor((Date.now() - serverStartTime) / 3600 / 1000);
        const status = `🖥️ <b>Status do Servidor</b>\n\n` +
            `<b>Uptime do Bot:</b> ${uptime} horas\n` +
            `<b>Jogadores:</b> ${escapeHtml(players)}\n` +
            `<b>TPS:</b> ${escapeHtml(tps)}`;
        await sendLongMessage(chatId, status);
    },
    '/players': async (chatId) => {
        const players = await runRconCommand("list");
        await sendLongMessage(chatId, `👥 <b>Jogadores Online:</b>\n${escapeHtml(players)}`);
    },
    '/ping': async (chatId) => {
        const startTime = Date.now();
        await runRconCommand('list');
        const endTime = Date.now();
        await sendLongMessage(chatId, `🏓 Pong! A latência do bot para o servidor é de <b>${endTime - startTime}ms</b>.`);
    },
    '/backup': (chatId) => createBackup(),
    '/restartserver': async (chatId) => {
        await sendLongMessage(chatId, "🔄 Reiniciando o servidor... Isso pode levar alguns minutos.");
        await stopServer();
        await new Promise(resolve => setTimeout(resolve, 15000));
        await startServer();
    },
    '/ask': async (chatId, args) => {
        if (!args) return sendLongMessage(chatId, "Por favor, digite sua pergunta após o comando. Ex: `/ask Como fazer uma fornalha?`");
        const answer = await askAI(args);
        await sendLongMessage(chatId, `🤖 <b>IA:</b>\n${escapeHtml(answer)}`);
    },
    '/image': async (chatId, args) => {
        if (!args) return sendLongMessage(chatId, "Por favor, descreva a imagem. Ex: `/image Um dragão voando`");
        await sendLongMessage(chatId, "🎨 Gerando sua imagem, aguarde um pouco...");
        const result = await generateImage(args);
        if (result) {
            const photoData = result.url.startsWith('data:') ? Buffer.from(result.url.split(',')[1], 'base64') : result.url;
            await bot.sendPhoto(chatId, photoData, { caption: `Gerado por: <b>${result.source}</b>`, parse_mode: 'HTML' });
        } else {
            await sendLongMessage(chatId, "❌ Desculpe, nenhuma IA conseguiu gerar sua imagem. Verifique as cotas de API.");
        }
    }
};

// ==============================
//  Lógica Principal do Bot
// ==============================
if (bot) {
    bot.on('message', async (msg) => {
        const chatId = msg.chat.id.toString();
        const text = msg.text || "";

        if (TELEGRAM_CHAT_ID && chatId !== TELEGRAM_CHAT_ID) return;

        const [command, ...args] = text.trim().split(" ");
        const handler = commandHandlers[command.toLowerCase()];

        try {
            if (handler) {
                await handler(chatId, args.join(" "));
            } else if (!text.startsWith('/')) {
                // Se não for um comando, trata como uma pergunta para a IA
                const answer = await askAI(text);
                await sendLongMessage(chatId, `🤖 <b>IA:</b>\n${escapeHtml(answer)}`);
            }
        } catch (err) {
            console.error(`Erro ao processar mensagem:`, err);
            await sendLongMessage(chatId, "😕 Ocorreu um erro ao processar sua solicitação.");
        }
    });

    bot.on('photo', async (msg) => {
        const chatId = msg.chat.id.toString();
        if (TELEGRAM_CHAT_ID && chatId !== TELEGRAM_CHAT_ID) return;
        try {
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            const file = await bot.getFile(fileId);
            const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
            await analyzeImage(chatId, url);
        } catch (err) {
            console.error("Erro ao processar foto:", err);
        }
    });

    bot.on('polling_error', console.error);
}

// ==============================
//  Servidor Web (Health Check)
// ==============================
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('MC Render Bot is running.');
}).listen(PORT, () => {
    console.log(`🌐 Servidor de Health Check rodando na porta ${PORT}`);
});

// ==============================
//  Inicialização
// ==============================
(async () => {
    if (!bot) {
        return console.error("Token do Telegram não fornecido. O bot não pode iniciar.");
    }
    await connectRcon();
    monitorLogs();
    monitorServerHealth();
    console.log("✅ Bot iniciado com sucesso e monitorando o servidor!");
    await sendTelegram(TELEGRAM_CHAT_ID, "🚀 **Bot reiniciado e online!**\nMonitoramento em tempo real ativado.", {disable_notification: false});
})();