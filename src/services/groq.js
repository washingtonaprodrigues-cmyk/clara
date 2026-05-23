const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// MODELOS
const MODEL_LEVE = 'llama-3.1-8b-instant';
const MODEL_FORTE = 'llama-3.3-70b-versatile';

// PROMPT MELHORADO - FOCO EM PONTO MÚLTIPLO
const SYSTEM_PROMPT = `Você é a Clara, assistente pessoal prática e direta.

Analise a mensagem e retorne APENAS JSON válido.

REGRAS IMPORTANTES:
- Se a mensagem falar de "cheguei", "saí almoçar", "voltei do almoço", "saí", "fui embora" com horários → use "ponto_multiplo"
- Seja muito sensível a frases de registro de ponto de trabalho.

Exemplos:
Usuário: "Hoje cheguei 8:15, sai almoçar 12:30 e voltei 14:10"
Resposta: {"tipo":"ponto_multiplo","acoes":[{"subtipo":"entrada","hora":"08:15"},{"subtipo":"saida_almoco","hora":"12:30"},{"subtipo":"volta_almoco","hora":"14:10"}],"resposta":"Registrando seus pontos..."}

Use sempre "ponto_multiplo" quando tiver 2 ou mais horários de trabalho.

Outros tipos normais: anotacao, tarefa, gasto, busca, consulta, saudacao, outro.

Responda SOMENTE com JSON.`;

async function classify(message) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODEL_LEVE,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: message },
      ],
      temperature: 0.1,
      max_tokens: 700,
    });

    let text = completion.choices[0].message.content.trim();
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(text);
  } catch (error) {
    console.error('Erro classify:', error.message);
    return { tipo: 'outro', resposta: 'Entendi!' };
  }
}

// Funções simplificadas
async function searchWeb(query) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODEL_FORTE,
      messages: [{ role: 'user', content: `Pesquise de forma prática: ${query}` }],
      temperature: 0.4,
      max_tokens: 500,
    });
    return completion.choices[0].message.content.trim();
  } catch {
    return 'Não consegui pesquisar agora.';
  }
}

async function freeResponse(message) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODEL_FORTE,
      messages: [
        { role: 'system', content: 'Você é a Clara, assistente carinhosa e prática. Responda de forma curta e útil.' },
        { role: 'user', content: message }
      ],
      temperature: 0.7,
      max_tokens: 400,
    });
    return completion.choices[0].message.content.trim();
  } catch {
    return 'Entendi! Como posso ajudar?';
  }
}

async function generateWorkSummary(logs, totalMinutes, extraMinutes) {
  return `Hoje você trabalhou ${Math.floor(totalMinutes/60)}h${totalMinutes%60 > 0 ? totalMinutes%60 + 'min' : ''}.`;
}

module.exports = {
  classify,
  searchWeb,
  freeResponse,
  generateWorkSummary,
};
