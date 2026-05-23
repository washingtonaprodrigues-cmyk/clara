const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// MODELOS
const MODEL_LEVE = 'llama-3.1-8b-instant';
const MODEL_FORTE = 'llama-3.3-70b-versatile';

// PROMPT DE CLASSIFICAÇÃO
const SYSTEM_PROMPT = `Você é a Clara, assistente pessoal carinhosa e inteligente.
Analise a mensagem e retorne APENAS JSON válido.

PERSONALIDADE: Fale em primeira pessoa, tom acolhedor e natural.

TIPOS:
- anotacao
- tarefa
- gasto
- saudacao
- consulta
- ponto
- ponto_multiplo (quando tiver vários horários)
- busca
- outro

Hoje: ${new Date().toLocaleDateString('pt-BR')}`;

async function classify(message) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODEL_LEVE,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: message },
      ],
      temperature: 0.1,
      max_tokens: 600,
    });

    let text = completion.choices[0].message.content.trim();
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(text);
  } catch (error) {
    console.error('Erro classify:', error.message);
    return { tipo: 'outro', resposta: 'Entendi! Pode continuar.' };
  }
}

async function searchWeb(query) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODEL_FORTE,
      messages: [
        { role: 'system', content: 'Você é a Clara. Responda de forma útil e natural.' },
        { role: 'user', content: `Pesquise sobre: ${query}` },
      ],
      temperature: 0.4,
      max_tokens: 500,
    });
    return completion.choices[0].message.content.trim();
  } catch (error) {
    return 'Não consegui pesquisar agora.';
  }
}

async function generateMemorySummary(memories, question) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODEL_FORTE,
      messages: [
        { role: 'system', content: 'Você é a Clara. Responda de forma natural.' },
        { role: 'user', content: `Memórias:\n${memories.map(m => m.content).join('\n')}\n\nPergunta: ${question}` },
      ],
      temperature: 0.4,
      max_tokens: 400,
    });
    return completion.choices[0].message.content.trim();
  } catch {
    return 'Deixa eu verificar...';
  }
}

async function freeResponse(message) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODEL_FORTE,
      messages: [
        { role: 'system', content: 'Você é a Clara, uma amiga inteligente e carinhosa.' },
        { role: 'user', content: message },
      ],
      temperature: 0.7,
      max_tokens: 400,
    });
    return completion.choices[0].message.content.trim();
  } catch {
    return 'Entendi! Como posso te ajudar?';
  }
}

async function generateWorkSummary(logs, totalMinutes, extraMinutes) {
  const horas = Math.floor(totalMinutes / 60);
  const min = totalMinutes % 60;
  const horasStr = `${horas}h${min > 0 ? min + 'min' : ''}`;
  return `Hoje você trabalhou ${horasStr}.`;
}

module.exports = {
  classify,
  searchWeb,
  generateMemorySummary,
  freeResponse,
  generateWorkSummary,
};
