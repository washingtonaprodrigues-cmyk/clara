const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─────────────────────────────────────────────
// MODELOS
// ─────────────────────────────────────────────
const MODEL_LEVE = 'llama-3.1-8b-instant';
const MODEL_FORTE = 'llama-3.3-70b-versatile';

// ─────────────────────────────────────────────
// PROMPT DE CLASSIFICAÇÃO
// ─────────────────────────────────────────────
const SYSTEM_PROMPT = `Você é a Clara, assistente pessoal carinhosa e inteligente.
Analise a mensagem e retorne APENAS JSON válido.

PERSONALIDADE:
- Fale sempre em primeira pessoa
- Tom acolhedor, natural e humano
- Evite emojis exagerados

REGRAS IMPORTANTES:
- Título deve ser extraído literalmente do texto do usuário
- Se a mensagem tiver vários horários de trabalho, use "ponto_multiplo"

TIPOS DE MENSAGEM:

1. anotacao → Guardar informação
2. tarefa → Compromisso com data/hora
3. gasto → Gastou dinheiro
4. saudacao → Cumprimentos
5. consulta → Pergunta sobre memórias
6. ponto → Apenas UM registro simples ("cheguei", "saí", etc)
7. ponto_multiplo → Vários registros na mesma mensagem (ex: cheguei 8h, saí almoçar 12h, voltei 14h)
8. busca → Pesquisa na internet
9. outro → Qualquer outra coisa

Responda APENAS com JSON:

ponto_multiplo:
{"tipo":"ponto_multiplo","acoes":[{"subtipo":"entrada","hora":"08:15"},{"subtipo":"saida_almoco","hora":"12:30"},{"subtipo":"volta_almoco","hora":"14:10"}],"resposta":"Registrando seus pontos..."}

ponto:
{"tipo":"ponto","subtipo":"entrada|saida_almoco|volta_almoco|saida","resposta":"..."}

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

// (Mantive o resto das funções iguais que você já tinha)
async function searchWeb(query, userContext = '') { ... } // mantenha sua função atual
async function answerFromKnowledge(query) { ... }
async function generateMemorySummary(memories, question) { ... }
async function freeResponse(message, conversationHistory = []) { ... }
async function generateWorkSummary(logs, totalMinutes, extraMinutes) { ... }

module.exports = {
  classify,
  searchWeb,
  generateMemorySummary,
  freeResponse,
  generateWorkSummary,
};
