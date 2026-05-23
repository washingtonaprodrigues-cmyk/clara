const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL_LEVE = 'llama-3.1-8b-instant';
const MODEL_FORTE = 'llama-3.3-70b-versatile';

const SYSTEM_PROMPT = `Você é a Clara, assistente pessoal prática e inteligente.
Analise a mensagem e retorne APENAS JSON.

Se a mensagem for sobre clima, farmácia, restaurante, loja, telefone, horário de funcionamento → use "busca" com query otimizada.

Exemplo:
Usuário: "qual o tempo hoje" → {"tipo":"busca","query":"clima atual em Fartura SP","resposta":"Vou verificar o clima pra você"}

Responda apenas com JSON.`;

async function classify(message) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODEL_LEVE,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: message }],
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

async function searchWeb(query, location = '') {
  try {
    const context = location ? `Localização do usuário: ${location}` : '';
    
    const completion = await groq.chat.completions.create({
      model: MODEL_FORTE,
      messages: [
        { role: 'system', content: `Você é a Clara. Responda de forma útil, prática e natural. Use o contexto de localização quando disponível. Máximo 5 linhas.` },
        { role: 'user', content: `${context}\n\n${query}` }
      ],
      temperature: 0.4,
      max_tokens: 600,
    });
    return completion.choices[0].message.content.trim();
  } catch (error) {
    return 'Não consegui buscar agora, mas posso tentar de outra forma.';
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
