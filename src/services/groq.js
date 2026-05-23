const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─────────────────────────────────────────────
// MODELOS
// leve  → classificação rápida (JSON simples)
// forte → conversa, busca, resumo, emoção
// ─────────────────────────────────────────────
const MODEL_LEVE  = 'llama-3.1-8b-instant';
const MODEL_FORTE = 'llama-3.3-70b-versatile';

// ─────────────────────────────────────────────
// PROMPT DE CLASSIFICAÇÃO
// ─────────────────────────────────────────────
const SYSTEM_PROMPT = `Você é a Clara, assistente pessoal com memória viva.
Analise mensagens e retorne JSON estruturado.

PERSONALIDADE:
- Fale SEMPRE em primeira pessoa: "Vou te lembrar", "Guardei aqui", "Deixa comigo"
- NUNCA diga "lembre de", "não esqueça", "você precisa"
- Tom acolhedor, curto, humano

REGRA CRÍTICA — TÍTULO:
- O título DEVE ser extraído LITERALMENTE do texto do usuário
- NUNCA resuma, parafraseie ou reescreva o que o usuário disse
- PROIBIDO trocar verbos: não mude "cobrar" para "ligar", "mandar" para "enviar"

TIPOS DE MENSAGEM:

1. **anotacao**: Guardar informação SEM horário/data
2. **tarefa**: Compromisso COM horário/data — SEMPRE tem horário OU data
3. **gasto**: Gastou dinheiro — "Gastei X", "Paguei X", "Comprei X por R$"
4. **saudacao**: Oi, olá, bom dia, tá ai
5. **consulta**: Pergunta sobre algo guardado
6. **ponto**: Registro de jornada de trabalho
   - "cheguei", "cheguei no trabalho", "to no trabalho" → entrada
   - "saí pro almoço", "fui almoçar", "saindo pro almoço" → saida_almoco
   - "voltei do almoço", "voltei", "to de volta" → volta_almoco
   - "fui embora", "saí", "indo embora", "saindo" → saida
7. **busca**: Usuário quer pesquisar algo na internet
   - "pesquisa X", "busca X", "qual o telefone de", "farmácia de plantão",
     "restaurante perto", "clima hoje", "notícia sobre", "quanto custa"
8. **outro**: Qualquer outra coisa

Retorne APENAS JSON válido:

anotacao:
{"tipo":"anotacao","titulo":"texto literal","conteudo":"texto completo","resposta":"Anotado! ✓"}

tarefa:
{"tipo":"tarefa","titulo":"texto literal sem data/hora","data":"YYYY-MM-DD ou null","hora":"HH:MM ou null","resposta":"Guardei! 📅"}

gasto:
{"tipo":"gasto","valor":0.0,"categoria":"mercado/restaurante/saude/transporte/lazer/outro","descricao":"desc literal","resposta":"Registrado! 💰"}

saudacao:
{"tipo":"saudacao","resposta":"Oi! Como posso ajudar? 😊"}

consulta:
{"tipo":"consulta","sobre":"tema","resposta":"Deixa eu verificar..."}

ponto:
{"tipo":"ponto","subtipo":"entrada|saida_almoco|volta_almoco|saida","resposta":""}

busca:
{"tipo":"busca","query":"termo de busca otimizado para pesquisa","resposta":""}

outro:
{"tipo":"outro","resposta":"Entendi! Posso te ajudar com algo?"}

Hoje: ${new Date().toLocaleDateString('pt-BR')}`;

// ─────────────────────────────────────────────
// CLASSIFY — modelo leve
// ─────────────────────────────────────────────
async function classify(message) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODEL_LEVE,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: message },
      ],
      temperature: 0.1,
      max_tokens: 500,
    });
    const text = completion.choices[0].message.content.trim();
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch (error) {
    console.error('Erro Groq classify:', error.message);
    return { tipo: 'outro', resposta: 'Entendi! Pode continuar.' };
  }
}

// ─────────────────────────────────────────────
// BUSCA WEB — modelo forte com tool calling
// ─────────────────────────────────────────────
async function searchWeb(query, userContext = '') {
  try {
    const systemPrompt = `Você é a Clara, assistente pessoal inteligente no WhatsApp.
Você tem acesso à internet e acabou de pesquisar sobre o que o usuário pediu.
Responda de forma HUMANA e NATURAL — como uma amiga inteligente que pesquisou pra você.

REGRAS:
- Seja direta e útil — vá direto ao que o usuário precisa
- Use linguagem natural, não técnica
- Inclua informações práticas (horários, telefones, endereços quando relevante)
- Máximo 4-5 linhas
- Se for algo local (farmácia, restaurante), priorize praticidade
- NÃO liste links — resuma o que encontrou

Contexto do usuário: ${userContext || 'não disponível'}`;

    const completion = await groq.chat.completions.create({
      model: MODEL_FORTE,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Pesquise e responda: ${query}` },
      ],
      temperature: 0.4,
      max_tokens: 600,
      tools: [
        {
          type: 'function',
          function: {
            name: 'web_search',
            description: 'Busca informações atualizadas na internet',
            parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'Termo de busca',
                },
              },
              required: ['query'],
            },
          },
        },
      ],
      tool_choice: 'auto',
    });

    const msg = completion.choices[0].message;

    // Se usou tool calling, processa o resultado
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const toolCall = msg.tool_calls[0];
      const searchQuery = JSON.parse(toolCall.function.arguments).query;

      // Segunda chamada com resultado da busca (simulado — Groq não executa a busca,
      // mas o modelo já tem conhecimento suficiente para responder)
      const followUp = await groq.chat.completions.create({
        model: MODEL_FORTE,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Pesquise e responda: ${query}` },
          { role: 'assistant', content: null, tool_calls: msg.tool_calls },
          {
            role: 'tool',
            tool_call_id: toolCall.id,
            content: `Resultados de busca para: ${searchQuery}. Use seu conhecimento atualizado para responder.`,
          },
        ],
        temperature: 0.4,
        max_tokens: 600,
      });
      return followUp.choices[0].message.content.trim();
    }

    return msg.content?.trim() || 'Não consegui encontrar essa informação agora.';
  } catch (error) {
    console.error('Erro searchWeb:', error.message);
    // Fallback: responde só com conhecimento do modelo
    return await answerFromKnowledge(query);
  }
}

// ─────────────────────────────────────────────
// FALLBACK — responde sem busca quando falha
// ─────────────────────────────────────────────
async function answerFromKnowledge(query) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODEL_FORTE,
      messages: [
        {
          role: 'system',
          content: `Você é a Clara, assistente pessoal no WhatsApp.
Responda de forma humana e natural, como uma amiga inteligente.
Se não souber algo específico (como telefone local), diga que não encontrou agora e sugira como o usuário pode encontrar.
Máximo 4 linhas.`,
        },
        { role: 'user', content: query },
      ],
      temperature: 0.4,
      max_tokens: 400,
    });
    return completion.choices[0].message.content.trim();
  } catch (e) {
    return 'Não consegui pesquisar isso agora. Tenta no Google? 😅';
  }
}

// ─────────────────────────────────────────────
// RESUMO DE MEMÓRIAS — modelo forte
// ─────────────────────────────────────────────
async function generateMemorySummary(memories, question) {
  try {
    const memoriesText = memories
      .map((m) => `[${m.type}] ${m.content} (${new Date(m.createdAt).toLocaleDateString('pt-BR')})`)
      .join('\n');

    const completion = await groq.chat.completions.create({
      model: MODEL_FORTE,
      messages: [
        {
          role: 'system',
          content: `Você é a Clara, assistente com memória viva.
Fale em primeira pessoa: "Tenho aqui", "Guardei".
Seja concisa e natural. Máximo 5 linhas.`,
        },
        {
          role: 'user',
          content: `Minhas memórias:\n${memoriesText}\n\nPergunta: ${question}`,
        },
      ],
      temperature: 0.4,
      max_tokens: 400,
    });
    return completion.choices[0].message.content.trim();
  } catch (error) {
    return 'Deixa eu verificar...';
  }
}

// ─────────────────────────────────────────────
// RESPOSTA LIVRE — modelo forte (conversa aberta)
// ─────────────────────────────────────────────
async function freeResponse(message, conversationHistory = []) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODEL_FORTE,
      messages: [
        {
          role: 'system',
          content: `Você é a Clara, assistente pessoal e amiga inteligente no WhatsApp.
Fale de forma humana, natural e acolhedora — como uma amiga de verdade.
Seja curiosa, observe padrões, faça perguntas leves quando pertinente.
Máximo 4 linhas por resposta. Sem emojis em excesso.`,
        },
        ...conversationHistory,
        { role: 'user', content: message },
      ],
      temperature: 0.6,
      max_tokens: 400,
    });
    return completion.choices[0].message.content.trim();
  } catch (error) {
    return 'Entendi! Como posso te ajudar?';
  }
}

// ─────────────────────────────────────────────
// RESUMO DE PONTO — modelo forte
// ─────────────────────────────────────────────
async function generateWorkSummary(logs, totalMinutes, extraMinutes) {
  const horas = Math.floor(totalMinutes / 60);
  const min = totalMinutes % 60;
  const horasStr = `${horas}h${min > 0 ? min + 'min' : ''}`;

  let extraStr = '';
  if (extraMinutes > 0) {
    const eh = Math.floor(extraMinutes / 60);
    const em = extraMinutes % 60;
    extraStr = `+${eh}h${em > 0 ? em + 'min' : ''} de hora extra`;
  } else if (extraMinutes < 0) {
    const fh = Math.floor(Math.abs(extraMinutes) / 60);
    const fm = Math.abs(extraMinutes) % 60;
    extraStr = `-${fh}h${fm > 0 ? fm + 'min' : ''} (saiu mais cedo)`;
  }

  try {
    const completion = await groq.chat.completions.create({
      model: MODEL_FORTE,
      messages: [
        {
          role: 'system',
          content: `Você é a Clara, assistente pessoal no WhatsApp.
Comente o fim do expediente de forma HUMANA e natural — como uma amiga observadora.
Use linguagem informal. Máximo 3 linhas. Inclua os dados fornecidos.`,
        },
        {
          role: 'user',
          content: `Hoje trabalhei ${horasStr}. ${extraStr}. Faça um comentário natural sobre isso.`,
        },
      ],
      temperature: 0.6,
      max_tokens: 200,
    });
    return completion.choices[0].message.content.trim();
  } catch {
    return `Hoje você trabalhou *${horasStr}*${extraStr ? ` — ${extraStr}` : ''}. 💪`;
  }
}

module.exports = {
  classify,
  searchWeb,
  generateMemorySummary,
  freeResponse,
  generateWorkSummary,
};
