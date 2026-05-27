const Groq = require('groq-sdk');
const { webSearch } = require('./search');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL_LEVE = 'llama-3.1-8b-instant';
const MODEL_FORTE = 'llama-3.3-70b-versatile';

function hojeFormatado() {
  return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

const SYSTEM_PROMPT = `Você é a Clara, assistente pessoal brasileira.
Retorne APENAS JSON no formato correto.
Hoje é ${hojeFormatado()}.

REGRAS IMPORTANTES:
- Entenda linguagem natural, mesmo com erros de digitação.
- Se tiver valor em dinheiro, geralmente é gasto.
- Se o usuário quer consultar algo que já guardou, use consulta.
- TAREFA: quando o usuário quer FAZER algo ou ser LEMBRADO de algo. Mesmo sem horário → use tarefa (hora null).
- ANOTACAO: apenas quando é uma INFORMAÇÃO para guardar e consultar depois. Não tem intenção de ação.
- Se for pergunta atual/local/notícia/preço/clima/telefone/endereço, use busca.

DIFERENÇA IMPORTANTE:
- "me lembra de pagar a conta" → tarefa (ação futura)
- "me lembra do remédio" → tarefa (ação futura)
- "anota que a senha é 123" → anotacao (informação)
- "guarda o endereço da médica" → anotacao (informação)

TIPOS:
- ponto_multiplo: registrar entrada/saída trabalho
  {"tipo":"ponto_multiplo","acoes":[{"subtipo":"entrada","hora":"08:00"}]}
  
  SUBTIPOS ACEITOS:
  - "entrada" → chegou, entrei, cheguei
  - "saida_almoco" → saí pra almoçar, fui almoçar
  - "volta_almoco" → voltei do almoço, retornei
  - "saida" → saí do trabalho, fui embora, saída final

- cidade: quando informa sua cidade
  {"tipo":"cidade","cidade":"nome da cidade e estado"}

- busca: clima, farmácia, restaurante, loja, telefone, informações locais
  {"tipo":"busca","query":"texto da busca"}
  
- anotacao: INFORMAÇÃO para guardar (não é ação)
  {"tipo":"anotacao","titulo":"resumo","conteudo":"texto completo"}
  
- tarefa: ação futura OU lembrete, COM ou SEM horário
  {"tipo":"tarefa","titulo":"desc","data":"YYYY-MM-DD ou null","hora":"HH:MM ou null"}
  
- gasto: gastou dinheiro
  {"tipo":"gasto","valor":0.0,"categoria":"mercado/restaurante/saude/transporte/lazer/outro","descricao":"desc"}

- medicamento: remédio, vitamina ou tratamento recorrente
  {"tipo":"medicamento","nome":"nome","quantidade":0,"frequencia":1,"horarios":["08:00"]}
  
- saudacao: oi, olá, bom dia
  {"tipo":"saudacao"}

- preferencia: nome do usuário ou jeito que prefere ser atendido
  {"tipo":"preferencia","nome":"nome ou null","tom":"carinhoso/direto/divertido/profissional ou null"}
  
- onboarding: usuário respondendo nome e/ou horário de trabalho no cadastro inicial
  {"tipo":"onboarding","nome":"nome ou null","jornada":"entrada-almoco_inicio-almoco_fim-saida ou null"}

- consulta: pergunta sobre algo guardado
  {"tipo":"consulta","sobre":"tema"}
  
- outro: qualquer outra coisa
  {"tipo":"outro"}

EXEMPLOS:
"entrei às 8:15, sai almoçar às 12:30, voltei do almoço às 14:10 e saí às 18:05"
→ {"tipo":"ponto_multiplo","acoes":[{"subtipo":"entrada","hora":"08:15"},{"subtipo":"saida_almoco","hora":"12:30"},{"subtipo":"volta_almoco","hora":"14:10"},{"subtipo":"saida","hora":"18:05"}]}
"me lembra de pagar a internet" → {"tipo":"tarefa","titulo":"pagar a internet","data":null,"hora":null}
"me lembra do remédio às 22h" → {"tipo":"tarefa","titulo":"remédio","data":null,"hora":"22:00"}
"anota que a senha do wifi é 12345" → {"tipo":"anotacao","titulo":"senha wifi","conteudo":"senha do wifi é 12345"}
"gastei 50 no mercado" → {"tipo":"gasto","valor":50.0,"categoria":"mercado","descricao":"compras"}
"tomo Losartana todo dia às 8h" → {"tipo":"medicamento","nome":"Losartana","quantidade":0,"frequencia":1,"horarios":["08:00"]}
"me chamo Ana" → {"tipo":"onboarding","nome":"Ana","jornada":null}
"entro 8h saio 17h almoço 12 a 13" → {"tipo":"onboarding","nome":null,"jornada":"08:00-12:00-13:00-17:00"}
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
    return { tipo: 'outro' };
  }
}

async function searchWeb(query, locationContext = '') {
  try {
    const fullQuery = locationContext ? `${query} em ${locationContext}` : query;
    console.log(`🔎 Buscando: ${fullQuery}`);

    const data = await webSearch(fullQuery);

    if (!data || !data.results || data.results.length === 0) {
      return { text: "Não encontrei informações atualizadas. Pode tentar de outra forma?", sourceUrl: null };
    }

    let contexto = '';
    if (data.answer) contexto += `Resposta direta: ${data.answer}\n\n`;
    data.results.slice(0, 3).forEach((r) => {
      if (r.title) contexto += `Fonte: ${r.title}\n`;
      if (r.content) contexto += `${r.content.substring(0, 300)}\n\n`;
    });

    const sourceUrl = data.results[0]?.url || null;

    const isClima = /clima|tempo|chuva|temperatura|previsão|chover|calor|frio/i.test(query);
    const isTelefone = /telefone|contato|whatsapp|ligar/i.test(query);
    const isEndereco = /endereço|onde fica|localização|como chegar/i.test(query);

    let formatInstrucao = '';
    if (isClima) {
      formatInstrucao = `Para clima:
- Linha 1: emoji + cidade + temperatura atual
- Linha 2: previsão curta dos próximos dias (ex: Seg ☀️ 22° | Ter 🌧️ 18°)
- Linha 3: dica rápida se necessário`;
    } else if (isTelefone) {
      formatInstrucao = `Para telefone: nome em negrito + 📞 número. Máximo 2 linhas.`;
    } else if (isEndereco) {
      formatInstrucao = `Para endereço: nome em negrito + 📍 endereço. Máximo 2 linhas.`;
    } else {
      formatInstrucao = `Resposta direta em máximo 3 linhas. Destaque o essencial.`;
    }

    const completion = await groq.chat.completions.create({
      model: MODEL_LEVE,
      messages: [
        {
          role: 'system',
          content: `Você é a Clara, assistente pessoal direta e simpática.
Responda em português brasileiro, natural e curto.
Sem citar fontes, sem repetir a pergunta, sem markdown excessivo.
Emojis de clima: ☀️ sol | 🌤️ parcialmente nublado | ⛅ nublado | 🌧️ chuva | ⛈️ tempestade | 🌨️ frio
${formatInstrucao}`,
        },
        {
          role: 'user',
          content: `Pergunta: ${query}\nLocalização: ${locationContext || 'não informada'}\n\nInformações:\n${contexto}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 200,
    });

    return { text: completion.choices[0].message.content.trim(), sourceUrl };
  } catch (error) {
    console.error('Erro searchWeb:', error.message);
    return { text: "Não consegui buscar essa informação agora.", sourceUrl: null };
  }
}

async function freeResponse(message, history = [], preferences = {}) {
  try {
    const name = preferences?.name ? `O nome da pessoa é ${preferences.name}.` : '';
    const tom = preferences?.tom || 'carinhoso';

    const completion = await groq.chat.completions.create({
      model: MODEL_FORTE,
      messages: [
        {
          role: 'system',
          content: `Você é a Clara, assistente pessoal no WhatsApp.
Fale em português brasileiro, natural e humano.
Tom: ${tom}. ${name}
- Seja breve: 1 a 3 linhas normalmente.
- Nunca pareça atendimento automático.
- Não invente ações que não foram executadas.
- Sem listas longas, sem excesso de emojis.
- Transmita presença e cuidado.`,
        },
        ...history,
        { role: 'user', content: message }
      ],
      temperature: 0.7,
      max_tokens: 300,
    });
    return completion.choices[0].message.content.trim();
  } catch {
    return 'Entendi! Como posso te ajudar?';
  }
}

async function generateMemorySummary(memories, question) {
  try {
    const memoriesText = memories
      .filter(m => ['anotacao', 'tarefa', 'gasto', 'compra', 'compromisso'].includes(m.type))
      .map((m) => `[${m.type}] ${m.content} (${new Date(m.createdAt).toLocaleDateString('pt-BR')})`)
      .join('\n');

    const completion = await groq.chat.completions.create({
      model: MODEL_LEVE,
      messages: [
        {
          role: 'system',
          content: `Você é a Clara. Responda de forma natural e direta.
Use "Tenho aqui", "Guardei", "Anotei".
Seja concisa, máximo 3 linhas.`,
        },
        {
          role: 'user',
          content: `Minhas memórias:\n${memoriesText}\n\nPergunta: ${question}`,
        },
      ],
      temperature: 0.5,
      max_tokens: 200,
    });

    return completion.choices[0].message.content.trim();
  } catch {
    return 'Deixa eu verificar...';
  }
}

module.exports = { classify, searchWeb, freeResponse, generateMemorySummary };
