const { OpenAI } = require("openai");
require("dotenv").config();

const openai = new OpenAI({
  baseURL: process.env.DEEPSEEK_BASE_URL,
  apiKey: process.env.DEEPSEEK_API_KEY
});

async function analyzeData(text) {
  try {
    const completion = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: "Analise este texto em busca de sentimentos, tópicos principais e entidades nomeadas." },
        { role: "user", content: text }
      ],
      temperature: 0.1,
      max_tokens: 256
    });
    return JSON.parse(completion.choices[0].message.content);
  } catch (err) {
    console.error("Erro de análise:", err.message);
    return { error: err.message };
  }
}

module.exports = { analyzeData };
