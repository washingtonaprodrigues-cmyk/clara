const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL_LEVE = 'llama-3.1-8b-instant';
const MODEL_FORTE = 'llama-3.3-70b-versatile';

const SYSTEM_PROMPT = `Você é a Clara, assistente pessoal útil e prática.

Analise a mensagem e retorne APENAS JSON.

- Se for sobre clima, farmácia, restaurante, loja, telefone, horário → use "busca"
- Sempre inclua a cidade "Fartura SP" na query quando for busca local.

Exemplo:
{"tipo":"busca","query":"clima atual em Fartura SP hoje","resposta":"Vou verificar o clima pra você"}
{"tipo":"busca","query":"farmácias de plantão perto de Fartura SP","resposta":"Buscando farmácias próximas..."}

Responda somente com JSON.`;

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
    return { tipo: 'outro', resposta: 'Entendi!' };
  }
}

async function searchWeb(query, locationContext = '') {
  try {
    const fullQuery = locationContext ? `${query} em Fartura SP` : query;

    const completion = await groq.chat.completions.create({
      model: MODEL_FORTE,
      messages: [
        { 
          role: 'system', 
          content: `Você é a Clara. Seja direta, prática e útil. Use informações atualizadas. Responda em português de forma natural. Máximo 6 linhas.` 
        },
        { role: 'user', content: fullQuery }
      ],
      temperature: 0.5,
      max_tokens: 700,
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    return 'Não consegui buscar essa informação agora. Tenta perguntar de outra forma?';
  }
}

async function freeResponse(message) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODEL_FORTE,
      messages: [
        { role: 'system', content: 'Você é a Clara, assistente carinhosa e prática.' },
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
