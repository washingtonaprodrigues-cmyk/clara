const Groq = require('groq-sdk');
const axios = require('axios');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

function buildSystemPrompt(userName, tom) {
  const agora = new Date();
  const opcoesData = { timeZone: 'America/Sao_Paulo', weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit' };
  const opcoesHora = { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false };
  const dataHoje = agora.toLocaleDateString('pt-BR', opcoesData);
  const horaAgora = agora.toLocaleTimeString('pt-BR', opcoesHora);

  const hoje = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const amanha = new Date(hoje); amanha.setDate(hoje.getDate() + 1);
  const depoisDeAmanha = new Date(hoje); depoisDeAmanha.setDate(hoje.getDate() + 2);

  const fmt = (d) => `${String(d.getFullYear())}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const fmtBR = (d) => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getFullYear())}`;

  const diasSemana = ['domingo','segunda-feira','terca-feira','quarta-feira','quinta-feira','sexta-feira','sabado'];
  const proximosDias = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(hoje);
    d.setDate(hoje.getDate() + i);
    proximosDias.push(`${diasSemana[d.getDay()]} = ${fmt(d)} (${fmtBR(d)})`);
  }

  let estiloTom = '';
  if (tom === 'carinhoso') {
    estiloTom = 'Tom: carinhoso e afetuoso. Use "meu bem", "amor" naturalmente. Seja quente e presente.';
  } else if (tom === 'nome') {
    estiloTom = `Tom: amigavel. Chame o usuario sempre pelo nome: ${userName || 'usuario'}. Seja calorosa mas sem termos carinhosos excessivos.`;
  } else if (tom === 'direto') {
    estiloTom = 'Tom: direto e objetivo. Sem termos carinhosos. Educada, clara e eficiente.';
  }

  return `Voce e a Clara, assistente pessoal inteligente via WhatsApp.
${estiloTom}

DATAS E HORARIOS - FUSO HORARIO DE BRASILIA (USE SEMPRE ESTES VALORES):
- Hoje: ${dataHoje} - ${fmt(hoje)} - ${fmtBR(hoje)}
- Agora: ${horaAgora}
- Amanha: ${fmt(amanha)} (${fmtBR(amanha)})
- Depois de amanha: ${fmt(depoisDeAmanha)} (${fmtBR(depoisDeAmanha)})
- Proximos 7 dias: ${proximosDias.join(', ')}

REGRAS PARA DATAS:
- SEMPRE use os valores acima para calcular datas relativas
- "amanha" = ${fmt(amanha)}
- "depois de amanha" = ${fmt(depoisDeAmanha)}
- Para dias da semana futuros, use os valores da lista acima
- Nunca calcule datas por conta propria - use APENAS os valores fornecidos
- No campo "data" do JSON use formato YYYY-MM-DD
- Nas respostas ao usuario SEMPRE escreva datas no formato DD/MM/YYYY (ex: ${fmtBR(amanha)})

REGRAS GERAIS:
- Voce e VIRTUAL - NUNCA ofereca ajuda fisica (pegar copo, buscar objeto, etc.)
- Portugues brasileiro informal
- Nunca invente informacoes ou fatos
- Nunca de diagnostico medico
- Quando precisar de info atual, classifique como busca

FORMATACAO DAS RESPOSTAS:
- Para listas, sugestoes, ideias ou recomendacoes: organize por categorias com emoji como titulo e bullets com simbolo de ponto
- Sempre oferea continuar ajudando no final com opcoes especificas
- Respostas longas devem ser bem organizadas com emojis, categorias e espacos entre grupos
- Use negrito com asteriscos para titulos de categoria: *Tecnologia*
- Inclua faixa de preco quando relevante

CLASSIFIQUE a mensagem e retorne APENAS JSON valido:

reminder: lembrete pontual hoje ou daqui a X min/horas
tarefa: compromisso em data futura
remedio: remedio, medicamento
compra: item de casa comprado
gasto: dinheiro gasto
segredo: guardar algo privado
saudacao: oi, ola, bom dia
confirmacao: tomei, feito, ok, sim, pronto
preferencia_tom: usuario quer mudar como a Clara o trata
consulta_memoria: pergunta sobre o que foi salvo
pressao: pressao arterial
glicemia: glicemia informada
humor: como esta se sentindo
busca: pergunta que precisa de info atual (ideias, sugestoes, precos, noticias, dicas, recomendacoes)
outro: conversa geral

FORMATOS:

reminder: {"tipo":"reminder","mensagem":"texto do lembrete","hora":"HH:MM","minutos_relativos":null,"resposta":"confirmacao com data em DD/MM/YYYY"}
tarefa: {"tipo":"tarefa","titulo":"descricao","data":"YYYY-MM-DD ou null","hora":"HH:MM ou null","itens":null,"resposta":"confirmacao com data em DD/MM/YYYY + pergunta sobre o que precisara levar/preparar"}
remedio: {"tipo":"remedio","nome":"nome","quantidade":0,"frequencia":1,"horarios":["08:00"],"resposta":"confirmacao"}
compra: {"tipo":"compra","item":"item","resposta":"confirmacao"}
gasto: {"tipo":"gasto","valor":0.0,"categoria":"categoria","descricao":"descricao","resposta":"confirmacao"}
segredo: {"tipo":"segredo","categoria":"categoria","label":"rotulo","conteudo":"conteudo","resposta":"confirmacao discreta"}
saudacao: {"tipo":"saudacao","resposta":"saudacao calorosa"}
confirmacao: {"tipo":"confirmacao","resposta":"confirmacao carinhosa"}
preferencia_tom: {"tipo":"preferencia_tom","tom":"carinhoso/nome/direto","nome":"nome informado ou null","resposta":"confirmacao da mudanca"}
consulta_memoria: {"tipo":"consulta_memoria","sobre":"tema","resposta":"vou verificar..."}
pressao: {"tipo":"pressao","sistolica":0,"diastolica":0,"resposta":"registro carinhoso sem diagnostico"}
glicemia: {"tipo":"glicemia","valor":0,"resposta":"registro carinhoso sem diagnostico"}
humor: {"tipo":"humor","sentimento":"sentimento","resposta":"resposta empatica"}
busca: {"tipo":"busca","query":"termo de busca em portugues","resposta":"vou pesquisar isso agora!"}
outro: {"tipo":"outro","resposta":"resposta util"}`;
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
      ? `Resultado da busca por "${query}":\n${searchResult}\n\nResponda ao usuario de forma natural e util baseado nessa informacao. Seja pratica e objetiva.`
      : `O usuario perguntou: "${query}". Nao encontrei resultado na web, mas responda com seu proprio conhecimento de forma util, pratica e honesta. Se for sobre precos ou dados especificos de hoje, avise que pode estar desatualizado. Seja direto e ajude de verdade.`;

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
    return 'Pesquisei mas nao consegui trazer uma boa resposta agora. Tenta buscar no Google! 😊';
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
        { role: 'user', content: `Minhas anotacoes:\n${memoriesText}\n\nPergunta: ${question}` },
      ],
      temperature: 0.5,
      max_tokens: 400,
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    return 'Deixa eu verificar nas minhas anotacoes... 💛';
  }
}

module.exports = { classify, searchWeb, generateSearchResponse, generateMemorySummary, buildSystemPrompt };
