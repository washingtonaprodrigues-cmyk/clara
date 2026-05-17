// Clara v1.5 - Groq classifica + GPT-4o mini responde
const Groq = require('groq-sdk');
const axios = require('axios');
const OpenAI = require('openai');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function getDatas() {
  const agora = new Date();
  const hoje = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const fmtBR = (d) => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  const hora = hoje.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const dias = ['domingo','segunda-feira','terca-feira','quarta-feira','quinta-feira','sexta-feira','sabado'];
  const proximos = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(hoje); d.setDate(hoje.getDate() + i);
    proximos.push(`${dias[d.getDay()]}=${fmt(d)}`);
  }
  const amanha = new Date(hoje); amanha.setDate(hoje.getDate() + 1);
  return { hoje: fmt(hoje), hojeOBR: fmtBR(hoje), amanha: fmt(amanha), amanhaOBR: fmtBR(amanha), hora, proximos: proximos.join(' | ') };
}

function buildClassifyPrompt(userName, tom, history) {
  const d = getDatas();
  let tomStr = tom === 'nome' ? `pelo nome ${userName || 'usuario'}` : tom === 'direto' ? 'direto sem carinho' : 'carinhoso';
  const historyStr = history.length > 0
    ? 'Historico recente:\n' + history.map(h => `${h.role === 'user' ? 'Usuario' : 'Clara'}: ${h.content}`).join('\n')
    : '';

  return `Voce e um classificador de mensagens para a assistente Clara (tom: ${tomStr}).
Hoje: ${d.hojeOBR} (${d.hoje}). Agora: ${d.hora}. Amanha: ${d.amanhaOBR} (${d.amanha}).
Proximos dias: ${d.proximos}

${historyStr}

Analise a mensagem e retorne SOMENTE um objeto JSON valido. Nada mais, nenhum texto fora do JSON.

Tipos possiveis:
- saudacao: oi, ola, bom dia, como vai
- reminder: lembrete com horario hoje ou daqui X minutos
- tarefa: compromisso em data futura
- remedio: remedio ou medicamento
- compra: item comprado
- gasto: dinheiro gasto
- segredo: guardar algo privado
- confirmacao: tomei, feito, ok, pronto
- preferencia_tom: quer mudar como Clara o trata
- consulta_memoria: pergunta sobre o que foi salvo
- pressao: pressao arterial
- glicemia: glicemia
- humor: como esta se sentindo
- busca: ideias, sugestoes, recomendacoes, dicas, precos, info atual, perguntas gerais
- outro: conversa geral

Formato por tipo:
saudacao: {"tipo":"saudacao","resposta":"[saudacao calorosa em portugues]"}
busca: {"tipo":"busca","query":"[termo de busca]","resposta":"vou pesquisar!"}
outro: {"tipo":"outro","resposta":"[resposta simples]"}
reminder: {"tipo":"reminder","mensagem":"[texto]","hora":"HH:MM","minutos_relativos":null,"resposta":"[confirmacao]"}
tarefa: {"tipo":"tarefa","titulo":"[titulo]","data":"YYYY-MM-DD","hora":"HH:MM","itens":null,"resposta":"[confirmacao com data DD/MM/YYYY]"}
remedio: {"tipo":"remedio","nome":"[nome]","quantidade":0,"frequencia":1,"horarios":["08:00"],"resposta":"[confirmacao]"}
compra: {"tipo":"compra","item":"[item]","resposta":"[confirmacao]"}
gasto: {"tipo":"gasto","valor":0.0,"categoria":"[cat]","descricao":"[desc]","resposta":"[confirmacao]"}
segredo: {"tipo":"segredo","categoria":"[cat]","label":"[label]","conteudo":"[conteudo]","resposta":"[confirmacao]"}
confirmacao: {"tipo":"confirmacao","resposta":"[confirmacao]"}
preferencia_tom: {"tipo":"preferencia_tom","tom":"carinhoso/nome/direto","nome":null,"resposta":"[confirmacao]"}
consulta_memoria: {"tipo":"consulta_memoria","sobre":"[tema]","resposta":"vou verificar..."}
pressao: {"tipo":"pressao","sistolica":0,"diastolica":0,"resposta":"[confirmacao]"}
glicemia: {"tipo":"glicemia","valor":0,"resposta":"[confirmacao]"}
humor: {"tipo":"humor","sentimento":"[sent]","resposta":"[empatico]"}

IMPORTANTE: Retorne APENAS o JSON. Sem explicacoes, sem texto antes ou depois.`;
}

function buildResponsePrompt(userName, tom) {
  const d = getDatas();
  let tomStr = '';
  if (tom === 'carinhoso') {
    tomStr = `Tom: carinhoso, afetuoso e presente. Use "meu bem", "amor", "querido/a" com naturalidade, como uma amiga proxima faria. Seja quente, humana e genuinamente preocupada com o usuario. Nunca seja fria ou robotica.`;
  } else if (tom === 'nome') {
    tomStr = `Tom: amigavel e proximo. Chame sempre pelo nome ${userName || 'usuario'}. Seja calorosa mas sem exagerar nos termos carinhosos.`;
  } else {
    tomStr = 'Tom: direto e objetivo. Educada e eficiente. Sem termos carinhosos.';
  }

  return `Voce e a Clara, assistente pessoal via WhatsApp com personalidade unica.
${tomStr}

PERSONALIDADE DA CLARA:
- Proativa: pensa nos detalhes antes do usuario pensar
- Curiosa: pergunta o que precisa pra ajudar melhor  
- Discreta: nunca julga, nunca comenta o que nao foi pedido
- Pratica: resolve, nao enrola
- Usa humor leve e afetuoso quando apropriado
- Fala como alguem que realmente quer bem, nao como um assistente corporativo

Hoje: ${d.hojeOBR}. Hora: ${d.hora}.
Responda em portugues brasileiro informal de forma util e bem organizada.
Para listas e sugestoes: use emojis por categoria, bullets com ponto, ofereca continuar ajudando no final.
Nunca ofereca ajuda fisica (pegar copo, buscar objeto, etc). Nunca de diagnosticos medicos.
Datas sempre no formato DD/MM/YYYY.`;
}

async function classify(message, history = [], userName = null, tom = 'carinhoso') {
  try {
    const prompt = buildClassifyPrompt(userName, tom, history);
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: message },
      ],
      temperature: 0.1,
      max_tokens: 500,
    });

    const text = completion.choices[0].message.content.trim();
    const clean = text.replace(/^```json\s*/g, '').replace(/^```\s*/g, '').replace(/```\s*$/g, '').trim();
    return JSON.parse(clean);
  } catch (error) {
    console.error('Erro Groq classify:', error.message);
    return { tipo: 'outro', resposta: 'Estou aqui! Pode continuar.' };
  }
}

async function generateElaborateResponse(userMessage, context, userName, tom, history = []) {
  try {
    const systemPrompt = buildResponsePrompt(userName, tom);
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: context || userMessage },
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      temperature: 0.7,
      max_tokens: 1000,
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Erro GPT-4o mini:', error.message);
    // Fallback pro Groq se GPT falhar
    try {
      const completion = await groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: buildResponsePrompt(userName, tom) },
          ...history,
          { role: 'user', content: context || userMessage },
        ],
        temperature: 0.7,
        max_tokens: 1000,
      });
      return completion.choices[0].message.content.trim();
    } catch (e) {
      return 'Nao consegui responder agora. Tenta de novo!';
    }
  }
}

async function searchWeb(query) {
  try {
    const response = await axios.get('https://api.duckduckgo.com/', {
      params: { q: query, format: 'json', no_html: 1, skip_disambig: 1 },
      timeout: 8000,
    });
    const data = response.data;
    let resultado = '';
    if (data.AbstractText) resultado += data.AbstractText;
    if (data.RelatedTopics && data.RelatedTopics.length > 0) {
      const topicos = data.RelatedTopics.slice(0, 3).filter((t) => t.Text).map((t) => t.Text).join('\n');
      if (topicos) resultado += '\n\n' + topicos;
    }
    return resultado || null;
  } catch (error) {
    console.error('Erro busca web:', error.message);
    return null;
  }
}

async function generateSearchResponse(query, searchResult, userName, tom, history = []) {
  const contextMsg = searchResult
    ? `Usuario perguntou: "${query}"\nResultado encontrado:\n${searchResult}\n\nResponda de forma util e organizada com emojis e categorias.`
    : `Usuario perguntou: "${query}"\nNao encontrei na web. Responda com seu proprio conhecimento de forma util, pratica e organizada com emojis e categorias. Se dados forem muito especificos avise. Ofereca continuar ajudando.`;

  return generateElaborateResponse(query, contextMsg, userName, tom, history);
}

async function generateMemorySummary(memories, question, userName, tom) {
  try {
    const memoriesText = memories
      .map((m) => `[${m.type}] ${m.content} (${m.createdAt.toLocaleDateString('pt-BR')})`)
      .join('\n');

    return generateElaborateResponse(
      question,
      `Minhas anotacoes:\n${memoriesText}\n\nPergunta: ${question}`,
      userName,
      tom
    );
  } catch (error) {
    return 'Deixa eu verificar nas minhas anotacoes...';
  }
}

module.exports = { classify, searchWeb, generateElaborateResponse, generateSearchResponse, generateMemorySummary, buildResponsePrompt };
