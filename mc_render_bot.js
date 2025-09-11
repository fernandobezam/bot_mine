/**
 * mc_render_bot.js (versão final completa)
 *
 * - Gemini Pro + fallback OpenAI
 * - RCON 5.0.2, monitoramento de logs e crash do Minecraft
 * - Monitoramento KubeJS (server.log, startup.log)
 * - Backup automático do mundo
 * - Fake HTTP server para Render Web Service
 * - Telegram notifications / comandos
 */

require("dotenv").config({ path: __dirname + "/.env" });
const TelegramBot = require("node-telegram-bot-api");
const SftpClient = require("ssh2-sftp-client");
const path = require("path");
const { Rcon } = require("rcon-client");
const fs = require("fs");
const http = require("http");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const OpenAI = require("openai");
const os = require("os");

// === Configuração .env ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SFTP_HOST = process.env.SFTP_HOST;
const SFTP_PORT = parseInt(process.env.SFTP_PORT || "22");
const SFTP_USER = process.env.SFTP_USER;
const SFTP_PASSWORD = process.env.SFTP_PASSWORD;
const MC_LOG_DIR = process.env.MC_LOG_DIR;
const MC_CRASH_DIR = process.env.MC_CRASH_DIR;
const MC_KUBEJS_LOG_DIR = process.env.MC_KUBEJS_LOG_DIR;
const WORLD_DIR = process.env.WORLD_DIR;
const BOT_LOG_DIR = process.env.BOT_LOG_DIR;
const BACKUP_DIR = process.env.BACKUP_DIR;
const RCON_HOST = process.env.RCON_HOST;
const RCON_PORT = parseInt(process.env.RCON_PORT || "26255");
const RCON_PASSWORD = process.env.RCON_PASSWORD;
const GEMINI_API_KEY_1 = process.env.GEMINI_API_KEY_1;
const GEMINI_API_KEY_2 = process.env.GEMINI_API_KEY_2;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MEMORY_THRESHOLD = parseFloat(process.env.MEMORY_THRESHOLD || "0.8");
const TPS_THRESHOLD = parseFloat(process.env.TPS_THRESHOLD || "18");
const CRASH_COOLDOWN = parseInt(process.env.CRASH_COOLDOWN || "300000");
const CHAT_FLOOD_COOLDOWN = parseInt(process.env.CHAT_FLOOD_COOLDOWN || "2000");
const BACKUP_INTERVAL = parseInt(process.env.BACKUP_INTERVAL || "1440");
const PING_INTERVAL = parseInt(process.env.PING_INTERVAL || "60");
const PORT = parseInt(process.env.PORT || "4000");

require("events").defaultMaxListeners = 50;

// === Criação de diretórios se não existirem ===
[ BOT_LOG_DIR, BACKUP_DIR ].forEach(dir => { if(!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); });

// === Telegram ===
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// === SFTP ===
const sftp = new SftpClient();

// === RCON ===
let rcon = null;
let sentCrashes = new Set();

// === IA ===
const geminiKeys = [GEMINI_API_KEY_1, GEMINI_API_KEY_2].filter(Boolean);
let geminiIndex = 0;
let genAI = geminiKeys.length ? new GoogleGenerativeAI(geminiKeys[0]) : null;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const IA_SYSTEM_PROMPT = `Você é especialista em Minecraft, modpack Integrated MC. Responda de forma clara, curta ou técnica, use emojis.`;

async function askAI(question){
    let lastError="";
    for(let i=0;i<geminiKeys.length;i++){
        try{
            genAI=new GoogleGenerativeAI(geminiKeys[geminiIndex]);
            const model = genAI.getGenerativeModel({ model:"gemini-2.0-flash" });
            const result = await model.generateContent([IA_SYSTEM_PROMPT, question]);
            geminiIndex=(geminiIndex+1)%geminiKeys.length;
            return result.response.text();
        }catch(err){ lastError=err.message; geminiIndex=(geminiIndex+1)%geminiKeys.length; }
    }
    if(openai){
        try{
            const res=await openai.chat.completions.create({ model:"gpt-4o-mini", messages:[{role:"system",content:IA_SYSTEM_PROMPT},{role:"user",content:question}], max_tokens:300 });
            return res.choices[0].message.content;
        }catch(err){ return "⚠ Nenhuma IA pôde responder agora."; }
    }
    return `⚠ Erro IA: ${lastError}`;
}

function logBot(msg){
    const logFile=path.join(BOT_LOG_DIR,"bot.log");
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
    console.log(msg);
}

function sendTelegram(msg){ bot.sendMessage(TELEGRAM_CHAT_ID,msg,{parse_mode:"HTML"}).catch(console.error); }

// === RCON connect ===
async function connectRcon(){
    try{
        rcon=new Rcon({host:RCON_HOST,port:RCON_PORT,password:RCON_PASSWORD,timeout:5000});
        await rcon.connect();
        logBot("✅ RCON conectado!");
        sendTelegram("🔌 Conexão RCON estabelecida!");
    }catch(err){ logBot(`Erro RCON: ${err.message}`); sendTelegram(`⚠️ Erro RCON: ${err.message}`); }
}

// === Monitoramento logs Minecraft via SFTP ===
async function watchLogs(){
    try{
        await sftp.connect({ host:SFTP_HOST, port:SFTP_PORT, username:SFTP_USER, password:SFTP_PASSWORD });
        logBot("✅ SFTP conectado!");
        sendTelegram("🤖 Bot conectado ao servidor!");

        let lastLogSize=0;

        setInterval(async()=>{
            try{
                const files=await sftp.list(MC_LOG_DIR);
                const latest=files.filter(f=>f.name.endsWith(".log")&&!f.name.includes("debug")).sort((a,b)=>b.modifyTime-a.modifyTime)[0];
                if(!latest) return;
                const remotePath=path.posix.join(MC_LOG_DIR,latest.name);
                const stats=await sftp.stat(remotePath);
                if(stats.size>lastLogSize){
                    const content=(await sftp.get(remotePath)).toString();
                    const lines=content.split("\n").slice(-15);
                    for(let line of lines){
                        if(line.includes("joined the game")){ const m=line.match(/(\w+) joined the game/); if(m) sendTelegram(`✅ <b>${m[1]}</b> entrou`); }
                        else if(line.includes("left the game")){ const m=line.match(/(\w+) left the game/); if(m) sendTelegram(`❌ <b>${m[1]}</b> saiu`); }
                        else if(line.includes("killed")) sendTelegram(`⚔️ ${line}`);
                        else if(line.includes("[Server thread/INFO]: <")){ const m=line.match(/<([^>]+)> (.+)/); if(m) sendTelegram(`💬 <b>${m[1]}:</b> ${m[2]}`); }
                    }
                    lastLogSize=stats.size;
                }
            }catch(err){ logBot(`Erro monitorando latest.log: ${err.message}`); }
        },5000);

        // Crash monitor
        setInterval(async()=>{
            try{
                const files=await sftp.list(MC_CRASH_DIR);
                if(files.length===0) return;
                const latest=files.sort((a,b)=>b.modifyTime-a.modifyTime)[0];
                if(!sentCrashes.has(latest.name)){
                    const remotePath=path.posix.join(MC_CRASH_DIR,latest.name);
                    const content=(await sftp.get(remotePath)).toString();
                    sendTelegram(`💥 Crash detectado!\nArquivo: ${latest.name}\n
${content.substring(0,400)}...`);
                    sentCrashes.add(latest.name);
                }
            }catch{}
        },10000);

        // KubeJS logs monitor
        const KUBEJS_LOGS=["server.log","startup.log"];
        KUBEJS_LOGS.forEach(file=>{
            const logFile=path.posix.join(MC_KUBEJS_LOG_DIR,file);
            if(!fs.existsSync(logFile)){ logBot(`⚠️ ${logFile} não encontrado. Aguardando criação.`); return; }
            fs.watchFile(logFile,{interval:1000},()=>{
                const data=fs.readFileSync(logFile,"utf8");
                if(data.toLowerCase().includes("error")) sendTelegram(`⚠️ Erro no KubeJS (${file}) detectado.`);
            });
        });

    }catch(err){ logBot(`Erro SFTP: ${err.message}`); sendTelegram(`⚠️ Erro SFTP: ${err.message}`); }
}

// === Backup automático do mundo ===
setInterval(()=>{
    const timestamp=new Date().toISOString().replace(/[:.]/g,"-");
    const backupName=`backup-${timestamp}.zip`;
    const backupPath=path.join(BACKUP_DIR,backupName);
    const { exec } = require("child_process");
    exec(`zip -r ${backupPath} ${WORLD_DIR}`,(err)=>{ if(err) logBot(`Erro backup: ${err.message}`); else sendTelegram(`💾 Backup criado: ${backupName}`); });
}, BACKUP_INTERVAL*60*1000);

// === Comandos Telegram ===
bot.on("message",async(msg)=>{
    const chatId=msg.chat.id.toString();
    const text=msg.text?.trim();
    if(!text||chatId!==TELEGRAM_CHAT_ID) return;

    if(text.startsWith("/")){
        if(text=="/ping") return;
        if(text=="/players"&&rcon){ const list=await rcon.send("list").catch(()=>"Erro"); return sendTelegram(`👥 Jogadores: ${list}`); }
        if(text=="/kills") return sendTelegram("⚔️ Função de kills ativas nos logs.");
        if(text.startsWith("/log")){ const n=parseInt(text.split(" ")[1]||"10"); return sendTelegram(`📜 Últimas ${n} linhas disponíveis`); }
        if(text=="/crash"){ if(sentCrashes.size===0) return sendTelegram("✅ Nenhum crash recente.