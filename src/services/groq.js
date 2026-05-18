// Clara v2.0 - Focada e economica
const Groq = require('groq-sdk');
const axios = require('axios');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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
  const tomStr = tom === 'nome' ? `pelo nome ${userName || 'usuario'}` : tom === 'direto' ? 'direto' : 'carinhoso';
  const historyStr = history.length > 0
    ? 'Historico:\n' + history.slice(-6).map(h => `${h.role === 'user' ? 'U' : 'C'}: ${h.content.substring(0, 100)}`).join('\n')
    : '';

  return `Classificador da assistente Clara (tom: ${tomStr}).
Hoje: ${d.hojeOBR} (${d.hoje}). Agora: ${d.hora}. Amanha: ${d.amanhaOBR} (${d.amanha}).
Proximos dias: ${d.proximos}
${historyStr}

Retorne SOMENTE JSON valido. Nenhum texto fora do JSON.

Tipos:
saudacao, reminder, tarefa, remedio, compra, gasto, segredo, confirmacao, preferencia_tom, consulta_memoria, pressao, glicemia, humor, busca, outro

Formatos:
saudacao: {"tipo":"saudacao","resposta":"[saudacao carinhosa curta]"}
reminder: {"tipo":"reminder","mensagem":"[texto]","hora":"HH:MM","minutos_relativos":null,"resposta":"[confirmacao curta]"}
tarefa: {"tipo":"tarefa","titulo":"[titulo]","data":"YYYY-MM-DD","hora":"HH:MM","itens":null,"resposta":"[confirmacao com data DD/MM/YYYY + pergunta sobre o que precisara]"}
remedio: {"tipo":"remedio","nome":"[nome]","quantidade":0,"frequencia":1,"horarios":["08:00"],"resposta":"[confirmacao curta]"}
compra: {"tipo":"compra","item":"[item]","resposta":"[confirmacao curta]"}
gasto: {"tipo":"gasto","valor":0.0,"categoria":"[cat]","descricao":"[desc]","resposta":"[confirmacao curta]"}
segredo: {"tipo":"segredo","categoria":"[cat]","label":"[label]","conteudo":"[conteudo]","resposta":"[confirmacao discreta]"}
confirmacao: {"tipo":"confirmacao","resposta":"[confirmacao carinhosa curta]"}
preferencia_tom: {"tipo":"preferencia_tom","tom":"carinhoso/nome/direto","nome":null,"resposta":"[confirmacao]"}
consulta_memoria: {"tipo":"consulta_memoria","sobre":"[tema]","resposta":"vou verificar..."}
pressao: {"tipo":"pressao","sistolica":0,"diastolica":0,"resposta":"[registro carinhoso sem diagnostico]"}
glicemia: {"tipo":"glicemia","valor":0,"resposta":"[registro carinhoso sem diagnostico]"}
humor: {"tipo":"humor","sentimento":"[sent]","resposta":"[resposta empatica curta]"}
busca: {"tipo":"busca","query":"[termo]","resposta":"[confirmacao curta]"}
outro: {"tipo":"outro","resposta":"[resposta util e carinhosa]"}

APENAS JSON. Sem explicacoes.`;
}

function buildSearchPrompt(userName, tom) {
  const d = getDatas();
  let tomStr = tom === 'carinhoso' ? 'Use tom carinhoso, pode usar "meu bem" e "amor".' : tom === 'nome' ? `Chame pelo nome ${userName}.` : 'Tom direto.';
  return `Voce e a Clara, assistente pessoal carinhosa. ${tomStr}
Hoje: ${d.hojeOBR}. Responda em portugues brasileiro informal.
Seja util, pratica e bem organizada. Use emojis por categoria em listas.
Nunca ofereca ajuda fisica. Nunca de diagnosticos medicos.`;
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
      max_tokens: 400,
    });
    const text = completion.choices[0].message.content.trim();
    const clean = text.replace(/^```json\s*/g, '').replace(/^```\s*/g, '').replace(/```\s*$/g, '').trim();
    return JSON.parse(clean);
  } catch (error) {
    console.error('Erro Groq classify:', error.message);
    return { tipo: 'outro', resposta: 'Estou aqui! Pode continuar.' };
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
  try {
    const systemPrompt = buildSearchPrompt(userName, tom);
    const contextMsg = searchResult
      ? `Pergunta: "${query}"\nResultado:\n${searchResult}\n\nResponda de forma util e organizada.`
      : `Pergunta: "${query}"\nNao encontrei na web. Responda com seu conhecimento de forma util e organizada com emojis e categorias. Ofereca continuar ajudando.`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: contextMsg },
      ],
      temperature: 0.7,
      max_tokens: 800,
    });
    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Erro generateSearchResponse:', error.message);
    return 'Nao consegui buscar agora. Tenta de novo!';
  }
}

async function generateMemorySummary(memories, question, userName, tom) {
  try {
    const memoriesText = memories
      .map((m) => `[${m.type}] ${m.content} (${m.createdAt.toLocaleDateString('pt-BR')})`)
      .join('\n');
    const systemPrompt = buildSearchPrompt(userName, tom);
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Minhas anotacoes:\n${memoriesText}\n\nPergunta: ${question}` },
      ],
      temperature: 0.5,
      max_tokens: 500,
    });
    return completion.choices[0].message.content.trim();
  } catch (error) {
    return 'Deixa eu verificar nas minhas anotacoes...';
  }
}

module.exports = { classify, searchWeb, generateSearchResponse, generateMemorySummary };
