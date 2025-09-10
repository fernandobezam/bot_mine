require("dotenv").config();
const axios = require("axios");

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";

async function deepSeekAnalysis(text, context = "minecraft") {
  if (!DEEPSEEK_API_KEY) {
    console.error("Erro DeepSeek: DEEPSEEK_API_KEY não definido");
    return text;
  }

  try {
    let prompt;
    if (context === "minecraft") {
      prompt = `Analise este log do Minecraft, traduza para português e explique de forma clara: "${text}"`;
    } else if (context === "error") {
      prompt = `Analise este erro, traduza para português e explique de forma simples: "${text}"`;
    } else {
      prompt = `Traduza para português e explique de forma clara: "${text}"`;
    }

    const res = await axios.post(
      `${DEEPSEEK_BASE_URL}/chat/completions`,
      {
        model: "deepseek-chat",
        messages: [
          { role: "system", content: "Você é um assistente especializado em Minecraft e análise de logs. Responda em português." },
          { role: "user", content: prompt }
        ],
        max_tokens: 500,
        temperature: 0.3
      },
      {
        headers: {
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return res.data.choices[0].message.content;
  } catch (err) {
    console.error("Erro DeepSeek:", err.message);
    return `Erro ao processar com DeepSeek: ${err.message}`;
  }
}

// Exporta a função para uso em CommonJS
module.exports = { deepSeekAnalysis };
