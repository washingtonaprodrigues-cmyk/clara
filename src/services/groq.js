const Groq = require('groq-sdk');
const axios = require('axios');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

function buildSystemPrompt(userName, tom) {
  const agora = new Date();
  const hoje = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const amanha = new Date(hoje); amanha.setDate(hoje.getDate() + 1);
  const depoisDeAmanha = new Date(hoje); depoisDeAmanha.setDate(hoje.getDate() + 2);

  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const fmtBR = (d) => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  const horaAgora = hoje.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const diasSemana = ['domingo','segunda-feira','terca-feira','quarta-feira','quinta-feira','sexta-feira','sabado'];

  const proximosDias = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(hoje);
    d.setDate(hoje.getDate() + i);
    proximosDias.push(`${diasSemana[d.getDay()]}=${fmt(d)}`);
  }

  let tomInstrucao = '';
  if (tom === 'carinhoso') {
    tomInstrucao = 'Tom carinhoso. Use "meu bem" e "amor" com naturalidade.';
  } else if (tom === 'nome') {
    tomInstrucao = `Tom amigavel. Chame sempre pelo nome: ${userName || 'usuario'}.`;
  } else if (tom === 'direto') {
    tomInstrucao = 'Tom direto e objetivo. Sem termos carinhosos.';
  }

  return `Voce e a Clara, assistente pessoal via WhatsApp. ${tomInstrucao}

DATAS ATUAIS (Brasilia):
Hoje: ${fmtBR(hoje)} = ${fmt(hoje)}
Agora: ${horaAgora}
Amanha: ${fmtBR(amanha)} = ${fmt(amanha)}
Depois de amanha: ${fmtBR(depoisDeAmanha)} = ${fmt(depoisDeAmanha)}
Proximos dias: ${proximosDias.join(', ')}

REGRAS:
1. Voce e virtual - nunca ofereca ajuda fisica
2. Nunca invente fatos ou diagnosticos medicos
3. Datas nas respostas: DD/MM/YYYY
4. Datas no campo data do JSON: YYYY-MM-DD
5. Para listas e sugestoes: organize com emojis por categoria, use bullet com ponto, ofereca continuar ajudando no final
6. Quando nao souber algo atual: classifique como busca

TIPOS - retorne APENAS JSON valido sem texto extra:
reminder = lembrete pontual hoje ou daqui X minutos
tarefa = compromisso em data futura
remedio = remedio ou medicamento
compra = item de casa comprado
gasto = dinheiro gasto
segredo = algo privado para guardar
saudacao = oi, ola, bom dia
confirmacao = tomei, feito, ok, sim, pronto
preferencia_tom = usuario quer mudar como Clara o trata
consulta_memoria = pergunta sobre o que foi salvo
pressao = pressao arterial informada
glicemia = glicemia informada
humor = como esta se sentindo
busca = precisa de info atual, ideias, sugestoes, recomendacoes, dicas, precos
outro = conversa geral

FORMATOS JSON:
reminder: {"tipo":"reminder","mensagem":"texto","hora":"HH:MM","minutos_relativos":null,"resposta":"confirmacao"}
tarefa: {"tipo":"tarefa","titulo":"descricao","data":"YYYY-MM-DD ou null","hora":"HH:MM ou null","itens":null,"resposta":"confirmacao com data DD/MM/YYYY e pergunta sobre o que precisara"}
remedio: {"tipo":"remedio","nome":"nome","quantidade":0,"frequencia":1,"horarios":["08:00"],"resposta":"confirmacao"}
compra: {"tipo":"compra","item":"item","resposta":"confirmacao"}
gasto: {"tipo":"gasto","valor":0.0,"categoria":"categoria","descricao":"descricao","resposta":"confirmacao"}
segredo: {"tipo":"segredo","categoria":"categoria","label":"rotulo","conteudo":"conteudo","resposta":"confirmacao discreta"}
saudacao: {"tipo":"saudacao","resposta":"saudacao calorosa"}
confirmacao: {"tipo":"confirmacao","resposta":"confirmacao carinhosa"}
preferencia_tom: {"tipo":"preferencia_tom","tom":"carinhoso/nome/direto","nome":"nome ou null","resposta":"confirmacao"}
consulta_memoria: {"tipo":"consulta_memoria","sobre":"tema","resposta":"vou verificar..."}
pressao: {"tipo":"pressao","sistolica":0,"diastolica":0,"resposta":"registro sem diagnostico"}
glicemia: {"tipo":"glicemia","valor":0,"resposta":"registro sem diagnostico"}
humor: {"tipo":"humor","sentimento":"sentimento","resposta":"resposta empatica"}
busca: {"tipo":"busca","query":"termo de busca","resposta":"vou pesquisar isso agora!"}
outro: {"tipo":"outro","resposta":"resposta util bem formatada com emojis e categorias se for lista"}`;
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
      max_tokens: 1000,
    });

    const text = completion.choices[0].message.content.trim();
    const clean = text.replace(/\`\`\`json\n?/g, '').replace(/\`\`\`\n?/g, '').trim();
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
    const systemPrompt = buildSystemPrompt(userName, tom);
    const contextMsg = searchResult
      ? `O usuario perguntou sobre: "${query}". Resultado encontrado:\n${searchResult}\n\nResponda de forma util e bem organizada com emojis e categorias se for lista.`
      : `O usuario perguntou: "${query}". Nao encontrei resultado na web. Responda com seu proprio conhecimento de forma util, pratica e bem organizada com emojis e categorias. Avise se dados forem muito especificos. Ofereca continuar ajudando no final.`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: contextMsg },
      ],
      temperature: 0.5,
      max_tokens: 1000,
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Erro generateSearchResponse:', error.message);
    return 'Nao consegui buscar agora. Tenta perguntar de outra forma!';
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
      max_tokens: 500,
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    return 'Deixa eu verificar nas minhas anotacoes...';
  }
}

module.exports = { classify, searchWeb, generateSearchResponse, generateMemorySummary, buildSystemPrompt };
