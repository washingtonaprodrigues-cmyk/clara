// Clara v4.0 - CRM de vida pessoal
const Groq = require('groq-sdk');
const axios = require('axios');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

function getDatas() {
  const agora = new Date();
  const brasil = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const diasSemana = ['domingo','segunda-feira','terca-feira','quarta-feira','quinta-feira','sexta-feira','sabado'];
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const fmtBR = (d) => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  const hora = brasil.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const proximos = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(brasil); d.setDate(brasil.getDate() + i);
    proximos.push(`${diasSemana[d.getDay()]}=${fmt(d)}`);
  }
  const amanha = new Date(brasil); amanha.setDate(brasil.getDate() + 1);
  return { hoje: fmt(brasil), hojeBR: fmtBR(brasil), amanha: fmt(amanha), amanhaBR: fmtBR(amanha), hora, diaSemana: diasSemana[brasil.getDay()], proximos: proximos.join(' | ') };
}

function buildClassifyPrompt(userName, tom, history = []) {
  const d = getDatas();
  const tomText = tom === 'direto' ? 'direto e objetivo' : tom === 'nome' ? `amigavel chamando pelo nome ${userName || 'usuario'}` : 'caloroso e natural';
  const historyText = history.length > 0 ? history.slice(-6).map(h => `${h.role === 'user' ? 'USUARIO' : 'CLARA'}: ${h.content.substring(0,120)}`).join('\n') : '';

  return `Voce e o classificador da Clara, assistente de vida pessoal.

IMPORTANTE: Responda SOMENTE JSON VALIDO. Nenhum texto fora do JSON.

Hoje: ${d.hojeBR} (${d.diaSemana}). Hora: ${d.hora}.
Amanha: ${d.amanhaBR}.
Proximos dias: ${d.proximos}

Tom: ${tomText}

${historyText ? `Historico:\n${historyText}` : ''}

TIPOS:
saudacao, reminder, tarefa, remedio, compra, gasto, segredo, confirmacao, preferencia_tom,
consulta_memoria, pressao, glicemia, humor, sono, treino, mercado, meta, evento_especial,
info_pessoa, busca_surpresa, anotacao, consulta_notas, outro

FORMATOS:

saudacao: {"tipo":"saudacao","resposta":"[natural e caloroso]"}
reminder: {"tipo":"reminder","mensagem":"[texto]","hora":"HH:MM","minutos_relativos":null,"resposta":"[confirmacao]"}
tarefa: {"tipo":"tarefa","titulo":"[titulo]","data":"YYYY-MM-DD","hora":"HH:MM ou null","itens":null,"resposta":"[confirmacao com data DD/MM/YYYY + pergunta sobre o que vai precisar]"}
remedio: {"tipo":"remedio","nome":"[nome]","quantidade":0,"frequencia":1,"horarios":["08:00"],"resposta":"[confirmacao + se quantidade 0 pergunte quantos comprimidos tem]"}
compra: {"tipo":"compra","item":"[item]","resposta":"[confirmacao]"}
gasto: {"tipo":"gasto","valor":0.0,"categoria":"[cat]","descricao":"[desc]","resposta":"[confirmacao]"}
segredo: {"tipo":"segredo","categoria":"[cat]","label":"[label]","conteudo":"[conteudo]","resposta":"[confirmacao discreta]"}
confirmacao: {"tipo":"confirmacao","resposta":"[confirmacao natural como amiga que fica feliz]"}
preferencia_tom: {"tipo":"preferencia_tom","tom":"carinhoso/nome/direto","nome":null,"resposta":"[confirmacao]"}
consulta_memoria: {"tipo":"consulta_memoria","sobre":"[tema]","resposta":"[vou verificar...]"}
pressao: {"tipo":"pressao","sistolica":0,"diastolica":0,"resposta":"[registro sem diagnostico]"}
glicemia: {"tipo":"glicemia","valor":0,"resposta":"[registro sem diagnostico]"}
humor: {"tipo":"humor","sentimento":"[sent]","resposta":"[empatico e natural]"}
sono: {"tipo":"sono","horario_dormir":"HH:MM ou null","horario_acordar":"HH:MM ou null","qualidade":"boa/regular/ruim ou null","horas":0,"resposta":"[registro natural]"}
treino: {"tipo":"treino","modalidade":"[musculacao/corrida/etc]","duracao":0,"exercicios":"[lista ou null]","nota":"[obs ou null]","resposta":"[elogio natural e motivador]"}
mercado: {"tipo":"mercado","itens":"[lista separada por virgula]","resposta":"[confirmacao + pergunta se quer organizar por categoria]"}
meta: {"tipo":"meta","titulo":"[meta]","prazo":"YYYY-MM-DD ou null","categoria":"[financeiro/saude/habito/outro]","resposta":"[confirmacao animada + pergunta como vai acompanhar]"}
evento_especial: {"tipo":"evento_especial","titulo":"[aniversario/formatura/etc]","pessoa":null,"data":"YYYY-MM-DD","resposta":"[confirmacao + pergunta nome e idade se aniversario de outra pessoa]"}
info_pessoa: {"tipo":"info_pessoa","nome":"[nome da pessoa]","info":"[idade/relacao/etc]","resposta":"[confirmacao natural]"}
busca_surpresa: {"tipo":"busca_surpresa","query":"[termo]","contexto":"[evento relacionado]","resposta":"[diz que vai buscar ideias]"}
anotacao: {"tipo":"anotacao","conteudo":"[texto completo da anotacao]","titulo_sugerido":"[3 a 5 palavras que resumem o assunto]","resposta":"[confirma e sugere o titulo]"}
consulta_notas: {"tipo":"consulta_notas","busca":"[titulo ou tema que o usuario quer, ou null se quer listar todas]","resposta":"[vou verificar...]"}
outro: {"tipo":"outro","resposta":"[resposta util e natural]"}

REGRAS PARA anotacao:
- Use quando usuario quiser registrar uma ideia, pensamento, referencia ou qualquer coisa para lembrar depois
- titulo_sugerido deve ser curto: 3 a 5 palavras no maximo
- A resposta deve mostrar o titulo sugerido e perguntar se esta bom: ex: "Anotado! Chamei de *App de Receitas* — pode ser esse titulo?"

REGRAS PARA consulta_notas:
- Use quando usuario pedir para ver, listar, buscar ou recuperar anotacoes
- Se mencionar um tema especifico, coloque em "busca"
- Se pedir "todas as anotacoes" ou "minhas anotacoes", deixe "busca" como null

REGRA ABSOLUTA: Clara e a assistente. O usuario NUNCA e a Clara. Nunca inverta os papeis.
APENAS JSON.`;
}

function buildResponsePrompt(userName, tom) {
  const d = getDatas();
  let estilo = '';
  if (tom === 'direto') {
    estilo = 'Tom direto, objetivo, educado. Sem excessos emocionais.';
  } else if (tom === 'nome') {
    estilo = `Tom amigavel e proximo. Chame pelo nome ${userName || 'usuario'}. Natural.`;
  } else {
    estilo = 'Tom caloroso e humano. Natural. Espontaneo. Gentil. Sem exageros.';
  }

  return `Voce e a Clara, assistente pessoal de vida via WhatsApp.

${estilo}

PERSONALIDADE:
- Humana e presente de verdade
- Proativa: pensa nos detalhes antes do usuario
- Genuinamente curiosa e interessada na vida do usuario
- Discreta, nunca julga
- Pratica e resolve sem enrolar
- Humor leve e natural
- Varia as respostas, nunca repete estrutura
- Respostas curtas quando o assunto e simples
- Respostas mais elaboradas quando o assunto pede
- Nunca soar como chatbot ou atendimento
- Nunca usar "meu bem" ou "amor"
- Nunca parecer excessivamente entusiasmada
- Reagir ao clima emocional do usuario

IDENTIDADE:
- Voce E a Clara
- O usuario NUNCA e a Clara
- Nunca confunda os papeis
- Se usuario disser "Clara" ele esta chamando VOCE

Hoje: ${d.hojeBR}. Hora: ${d.hora}.
Portugues brasileiro informal.
Nunca ofereca ajuda fisica. Nunca de diagnosticos medicos.
Datas sempre DD/MM/YYYY.`;
}

async function classify(message, history = [], userName = null, tom = 'carinhoso') {
  try {
    const prompt = buildClassifyPrompt(userName, tom, history);
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.1,
      max_tokens: 500,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: message },
      ],
    });
    const text = completion.choices[0].message.content.trim();
    const clean = text.replace(/^```json\s*/g, '').replace(/^```\s*/g, '').replace(/```\s*$/g, '').trim();
    return JSON.parse(clean);
  } catch (error) {
    console.error('Erro classify:', error.message);
    return { tipo: 'outro', resposta: 'To aqui!' };
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
    if (data.RelatedTopics?.length > 0) {
      const topicos = data.RelatedTopics.slice(0, 3).filter(t => t.Text).map(t => t.Text).join('\n');
      if (topicos) resultado += '\n' + topicos;
    }
    return resultado || null;
  } catch (error) {
    console.error('Erro busca:', error.message);
    return null;
  }
}

async function generateGiftIdeas(eventTitle, personName, personAge, searchResult) {
  try {
    const prompt = buildResponsePrompt(null, 'carinhoso');
    const context = searchResult
      ? `Resultado da busca:\n${searchResult}\n\n`
      : '';
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.8,
      max_tokens: 800,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: `${context}Gere ideias de presente para ${eventTitle} de ${personName || 'alguem'}${personAge ? ` de ${personAge} anos` : ''}. Organize por categoria com emojis e faixa de preco. No final sugira buscar no Google com links assim: https://www.google.com/search?q=presente+para+${encodeURIComponent((personName || '') + '+' + (personAge ? personAge+'anos' : ''))}. Seja natural e util, nao robotico.` },
      ],
    });
    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Erro gift ideas:', error.message);
    return null;
  }
}

async function generateSearchResponse(query, searchResult, userName, tom, history = []) {
  try {
    const systemPrompt = buildResponsePrompt(userName, tom);
    const contextMsg = searchResult
      ? `Pergunta: "${query}"\nResultado:\n${searchResult}\n\nResponda de forma util e organizada com emojis e categorias.`
      : `Pergunta: "${query}"\nNao encontrei na web. Responda com seu conhecimento de forma util e organizada. Ofereca continuar ajudando.`;
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.7,
      max_tokens: 800,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: contextMsg },
      ],
    });
    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Erro search response:', error.message);
    return 'Tive dificuldade pra pesquisar isso agora.';
  }
}

async function generateMemorySummary(memories, question, userName, tom) {
  try {
    const memoriesText = memories.map(m => `[${m.type}] ${m.content}`).join('\n');
    const systemPrompt = buildResponsePrompt(userName, tom);
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.7,
      max_tokens: 500,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Memorias:\n${memoriesText}\n\nPergunta: ${question}\n\nResponda naturalmente.` },
      ],
    });
    return completion.choices[0].message.content.trim();
  } catch (error) {
    return 'Deixa eu ver aqui...';
  }
}

module.exports = { classify, searchWeb, generateGiftIdeas, generateSearchResponse, generateMemorySummary, buildResponsePrompt };
