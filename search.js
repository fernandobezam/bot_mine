const { OpenAI } = require("openai");
require("dotenv").config();

const openai = new OpenAI({
  baseURL: process.env.DEEPSEEK_BASE_URL,
  apiKey: process.env.DEEPSEEK_API_KEY
});

async function semanticSearch(query) {
  try {
    const completion = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: "Você é um mecanismo de busca poderoso. Retorne respostas concisas e factuais." },
        { role: "user", content: query }
      ],
      temperature: 0.3,
      max_tokens: 150
    });
    return completion.choices[0].message.content;
  } catch (err) {
    console.error("Erro de busca:", err.message);
    return `Erro de busca: ${err.message}`;
  }
}

module.exports = { semanticSearch };
