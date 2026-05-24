const Groq = require('groq-sdk');
const { webSearch } = require('./search');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL_LEVE = 'llama-3.1-8b-instant';
const MODEL_FORTE = 'llama-3.3-70b-versatile';

const SYSTEM_PROMPT = `Você é a Clara, assistente pessoal.
Retorne APENAS JSON no formato correto.

TIPOS:
- ponto_multiplo: registrar entrada/saída trabalho
  {"tipo":"ponto_multiplo","acoes":[{"subtipo":"entrada","hora":"08:00"}]}
  
  SUBTIPOS ACEITOS (use exatamente assim):
  - "entrada" → chegou, entrei, cheguei
  - "saida_almoco" → saí pra almoçar, fui almoçar, saída almoço
  - "volta_almoco" → voltei do almoço, retornei do almoço
  - "saida" → saí do trabalho, fui embora, saída final
  
- busca: clima, farmácia, restaurante, loja, telefone, informações locais
  {"tipo":"busca","query":"texto da busca"}
  
- anotacao: guardar informação SEM horário
  {"tipo":"anotacao","titulo":"resumo","conteudo":"texto completo"}
  
- tarefa: compromisso COM horário/data
  {"tipo":"tarefa","titulo":"desc","data":"YYYY-MM-DD ou null","hora":"HH:MM ou null"}
  
- gasto: gastou dinheiro
  {"tipo":"gasto","valor":0.0,"categoria":"mercado/restaurante/saude/transporte/lazer/outro","descricao":"desc"}
  
- saudacao: oi, olá, bom dia
  {"tipo":"saudacao"}
  
- consulta: pergunta sobre algo guardado
  {"tipo":"consulta","sobre":"tema"}
  
- outro: qualquer outra coisa
  {"tipo":"outro"}

EXEMPLOS PONTO:
"entrei às 8:15, sai almoçar às 12:30, voltei do almoço às 14:10 e saí do trabalho às 18:05"
→ {"tipo":"ponto_multiplo","acoes":[
    {"subtipo":"entrada","hora":"08:15"},
    {"subtipo":"saida_almoco","hora":"12:30"},
    {"subtipo":"volta_almoco","hora":"14:10"},
    {"subtipo":"saida","hora":"18:05"}
  ]}

"cheguei às 8" → {"tipo":"ponto_multiplo","acoes":[{"subtipo":"entrada","hora":"08:00"}]}
"farmácia perto" → {"tipo":"busca","query":"farmácia próxima"}
"anote que o código é 123" → {"tipo":"anotacao","titulo":"código","conteudo":"o código é 123"}
"me lembra às 19h de buscar minha sogra" → {"tipo":"tarefa","titulo":"buscar sogra","data":null,"hora":"19:00"}
"gastei 50 no mercado" → {"tipo":"gasto","valor":50.0,"categoria":"mercado","descricao":"compras"}
"oi" → {"tipo":"saudacao"}
`;

async function classify(message) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODEL_LEVE,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: message }
      ],
      temperature: 0.2,
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
    const fullQuery = locationContext
      ? `${query} em ${locationContext}`
      : query;
    console.log(`🔎 Buscando: ${fullQuery}`);

    const data = await webSearch(fullQuery);

    if (!data || !data.results || data.results.length === 0) {
      return "Não encontrei informações atualizadas. Pode tentar de outra forma?";
    }

    let contexto = '';
    if (data.answer) contexto += `Resposta direta: ${data.answer}\n\n`;
    data.results.slice(0, 3).forEach((r) => {
      if (r.title) contexto += `Fonte: ${r.title}\n`;
      if (r.content) contexto += `${r.content.substring(0, 300)}\n\n`;
    });

    const completion = await groq.chat.completions.create({
      model: MODEL_LEVE,
      messages: [
        {
          role: 'system',
          content: `Você é a Clara, assistente pessoal simpática e direta.
Com base nas informações de busca, responda em português brasileiro de forma natural e amigável.
Não cite fontes, não repita a pergunta.

Para clima use emojis que representem o tempo:
☀️ sol | 🌤️ parcialmente nublado | ⛅ nublado | 🌧️ chuva | ⛈️ tempestade | 🌨️ frio/neve | 🌫️ névoa

Formato ideal para clima:
- Primeira linha: condição atual com emoji + temperatura agora
- Segunda linha: previsão dos próximos dias resumida (ex: Seg ☀️ 22° | Ter 🌧️ 18° | Qua ⛅ 20°)
- Terceira linha: dica rápida se necessário (ex: "Leva guarda-chuva!")

Para outros tipos de busca (telefone, endereço, etc): destaque a informação principal em no máximo 2 linhas.`,
        },
        {
          role: 'user',
          content: `Pergunta: ${query}\nLocalização: ${locationContext || 'não informada'}\n\nInformações encontradas:\n${contexto}`,
        },
      ],
      temperature: 0.4,
      max_tokens: 250,
    });

    return completion.choices[0].message.content.trim();
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
        { role: 'system', content: 'Você é a Clara. Seja útil, natural e direta.' },
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

async function generateMemorySummary(memories, question) {
  try {
    const memoriesText = memories
      .map((m) => `[${m.type}] ${m.content} (${new Date(m.createdAt).toLocaleDateString('pt-BR')})`)
      .join('\n');

    const completion = await groq.chat.completions.create({
      model: MODEL_LEVE,
      messages: [
        {
          role: 'system',
          content: `Você é a Clara, assistente com memória viva.
Fale em primeira pessoa: "Tenho aqui", "Guardei".
Seja concisa e natural.`,
        },
        {
          role: 'user',
          content: `Minhas memórias:\n${memoriesText}\n\nPergunta: ${question}`,
        },
      ],
      temperature: 0.5,
      max_tokens: 300,
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    return 'Deixa eu verificar...';
  }
}

module.exports = {
  classify,
  searchWeb,
  freeResponse,
  generateMemorySummary,
};
