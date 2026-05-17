const Groq = require('groq-sdk');
const axios = require('axios');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

function buildSystemPrompt(userName, tom) {
  // Data e hora exatas de Brasília
  const agora = new Date();
  const opcoesData = { timeZone: 'America/Sao_Paulo', weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit' };
  const opcoesHora = { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false };
  const dataHoje = agora.toLocaleDateString('pt-BR', opcoesData);
  const horaAgora = agora.toLocaleTimeString('pt-BR', opcoesHora);

  // Calcula datas relativas em Brasília
  const hoje = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const amanha = new Date(hoje); amanha.setDate(hoje.getDate() + 1);
  const depoisDeAmanha = new Date(hoje); depoisDeAmanha.setDate(hoje.getDate() + 2);

  const fmt = (d) => `${String(d.getFullYear())}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

  const diasSemana = ['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
  const proximosDias = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(hoje);
    d.setDate(hoje.getDate() + i);
    proximosDias.push(`${diasSemana[d.getDay()]} = ${fmt(d)}`);
  }

  let estiloTom = '';
  if (tom === 'carinhoso') {
    estiloTom = `Tom: carinhoso e afetuoso. Use "meu bem", "amor" naturalmente. Seja quente e presente.`;
  } else if (tom === 'nome') {
    estiloTom = `Tom: amigável. Chame o usuário sempre pelo nome: ${userName || 'usuário'}. Seja calorosa mas sem termos carinhosos excessivos.`;
  } else if (tom === 'direto') {
    estiloTom = `Tom: direto e objetivo. Sem termos carinhosos. Educada, clara e eficiente.`;
  }

  return `Você é a Clara, assistente pessoal inteligente via WhatsApp.
${estiloTom}

DATAS E HORÁRIOS — FUSO HORÁRIO DE BRASÍLIA (USE SEMPRE ESTES VALORES):
- Hoje: ${dataHoje} → ${fmt(hoje)}
- Agora: ${horaAgora}
- Amanhã: ${fmt(amanha)}
- Depois de amanhã: ${fmt(depoisDeAmanha)}
- Próximos 7 dias: ${proximosDias.join(', ')}

REGRAS PARA DATAS:
- SEMPRE use os valores acima para calcular datas relativas
- "amanhã" = ${fmt(amanha)}
- "depois de amanhã" = ${fmt(depoisDeAmanha)}
- Para dias da semana futuros, use os valores da lista acima
- Nunca calcule datas por conta própria — use APENAS os valores fornecidos

REGRAS GERAIS:
- Você é VIRTUAL — NUNCA ofereça ajuda física (pegar copo, buscar objeto, etc.)
- Português brasileiro informal
- Nunca invente informações ou fatos
- Nunca dê diagnóstico médico
- Quando precisar de info atual, classifique como "busca"

CLASSIFIQUE a mensagem e retorne APENAS JSON válido:

reminder: lembrete pontual hoje ou daqui a X min/horas
tarefa: compromisso em data futura
remedio: remédio, medicamento
compra: item de casa comprado
gasto: dinheiro gasto
segredo: guardar algo privado
saudacao: oi, olá, bom dia
confirmacao: tomei, feito, ok, sim, pronto
preferencia_tom: usuário quer mudar como a Clara o trata
consulta_memoria: pergunta sobre o que foi salvo
pressao: pressão arterial
glicemia: glicemia informada
humor: como está se sentindo
busca: pergunta que precisa de info atual (ideias, sugestões, preços, notícias, dicas, recomendações)
outro: conversa geral

FORMATOS:

reminder: {"tipo":"reminder","mensagem":"texto do lembrete","hora":"HH:MM","minutos_relativos":null,"resposta":"confirmação"}
tarefa: {"tipo":"tarefa","titulo":"descrição","data":"YYYY-MM-DD ou null","hora":"HH:MM ou null","itens":null,"resposta":"confirmação + pergunta sobre o que precisará levar/preparar"}
remedio: {"tipo":"remedio","nome":"nome","quantidade":0,"frequencia":1,"horarios":["08:00"],"resposta":"confirmação"}
compra: {"tipo":"compra","item":"item","resposta":"confirmação"}
gasto: {"tipo":"gasto","valor":0.0,"categoria":"categoria","descricao":"descrição","resposta":"confirmação"}
segredo: {"tipo":"segredo","categoria":"categoria","label":"rótulo","conteudo":"conteúdo","resposta":"confirmação discreta"}
saudacao: {"tipo":"saudacao","resposta":"saudação calorosa"}
confirmacao: {"tipo":"confirmacao","resposta":"confirmação carinhosa"}
preferencia_tom: {"tipo":"preferencia_tom","tom":"carinhoso/nome/direto","nome":"nome informado ou null","resposta":"confirmação da mudança"}
consulta_memoria: {"tipo":"consulta_memoria","sobre":"tema","resposta":"vou verificar..."}
pressao: {"tipo":"pressao","sistolica":0,"diastolica":0,"resposta":"registro carinhoso sem diagnóstico"}
glicemia: {"tipo":"glicemia","valor":0,"resposta":"registro carinhoso sem diagnóstico"}
humor: {"tipo":"humor","sentimento":"sentimento","resposta":"resposta empática"}
busca: {"tipo":"busca","query":"termo de busca em português","resposta":"vou pesquisar isso agora!"}
outro: {"tipo":"outro","resposta":"resposta útil"}`;
}

async function classify(message, history = [], userName = null, tom = 'carinhoso') {
  try {
    const systemPrompt = buildSystemPrompt(userName, tom);
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: message },
    ];

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages,
      temperature: 0.3,
      max_tokens: 600,
    });

    const text = completion.choices[0].message.content.trim();
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch (error) {
    console.error('Erro Groq classify:', error.message);
    return { tipo: 'outro', resposta: 'Estou aqui! Pode continuar. 💛' };
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
      const topicos = data.RelatedTopics
        .slice(0, 3)
        .filter((t) => t.Text)
        .map((t) => t.Text)
        .join('\n');
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
    const systemPrompt = buildSystemPrompt(userName, tom);
    const contextMsg = searchResult
      ? `Resultado da busca por "${query}":\n${searchResult}\n\nResponda ao usuário de forma natural baseado nessa informação. Se não tiver info suficiente, diga honestamente e sugira onde buscar.`
      : `Não encontrei resultado específico para "${query}". Diga honestamente que não tem essa informação atualizada e sugira onde buscar.`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: contextMsg },
      ],
      temperature: 0.5,
      max_tokens: 500,
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    return 'Pesquisei mas não consegui trazer uma boa resposta agora. Tenta buscar no Google! 😊';
  }
}

async function generateMemorySummary(memories, question, userName, tom) {
  try {
    const memoriesText = memories
      .map((m) => `[${m.type}] ${m.content} (${m.createdAt.toLocaleDateString('pt-BR')})`)
      .join('\n');

    const systemPrompt = buildSystemPrompt(userName, tom);

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Minhas anotações:\n${memoriesText}\n\nPergunta: ${question}` },
      ],
      temperature: 0.5,
      max_tokens: 400,
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    return 'Deixa eu verificar nas minhas anotações... 💛';
  }
}

module.exports = { classify, searchWeb, generateSearchResponse, generateMemorySummary, buildSystemPrompt };
