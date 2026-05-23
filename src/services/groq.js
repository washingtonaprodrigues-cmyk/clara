const Groq = require('groq-sdk');
const { webSearch } = require('./search');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL_LEVE = 'llama-3.1-8b-instant';
const MODEL_FORTE = 'llama-3.3-70b-versatile';

const SYSTEM_PROMPT = `Você é a Clara, assistente pessoal útil e prática.
Analise a mensagem e retorne APENAS JSON válido.

Se a mensagem for sobre clima, farmácia, restaurante, telefone, loja ou qualquer busca local → use "busca".`;

async function classify(message) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODEL_LEVE,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: message }
      ],
      temperature: 0.1,
      max_tokens: 600,
    });

    let text = completion.choices[0].message.content.trim();
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(text);
  } catch (error) {
    console.error('Erro classify:', error.message);
    return { tipo: 'outro', resposta: 'Entendi!' };
  }
}

async function searchWeb(query, locationContext = '') {
  try {
    const fullQuery = locationContext ? `${query} em Fartura SP` : `${query} Fartura SP`;
    console.log(`🔎 Buscando Tavily: ${fullQuery}`);

    const results = await webSearch(fullQuery);

    if (!results || results.length === 0) {
      return "Não encontrei informações atualizadas agora. Pode tentar de outra forma?";
    }

    let resposta = `Aqui está o que encontrei sobre **${query}**:\n\n`;

    results.slice(0, 5).forEach((r, index) => {
      if (r.title) resposta += `${index + 1}. **${r.title}**\n`;
      if (r.content) resposta += `${r.content.substring(0, 180)}...\n\n`;
    });

    return resposta.trim();
  } catch (error) {
    console.error('Erro searchWeb:', error.message);
    return "Não consegui buscar essa informação agora.";
  }
}

async function freeResponse(message) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODEL_FORTE,
      messages: [
        { role: 'system', content: 'Você é a Clara. Seja útil, carinhosa e direta.' },
        { role: 'user', content: message }
      ],
      temperature: 0.7,
      max_tokens: 400,
    });
    return completion.choices[0].message.content.trim();
  } catch {
    return 'Entendi! Como posso te ajudar?';
  }
}

module.exports = {
  classify,
  searchWeb,
  freeResponse,
};
