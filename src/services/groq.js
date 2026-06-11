const Groq = require('groq-sdk');
const { webSearch } = require('./search');
const rateLimit = require('./rateLimit');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL_LEVE = 'llama-3.1-8b-instant';
const MODEL_FORTE = 'llama-3.3-70b-versatile';
const MODEL_PRIVADO = 'nousresearch/hermes-3-llama-3.1-70b';

function hoje() {
  return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function isRateLimit(error) {
  const msg = (error.message || '').toLowerCase();
  const status = error.status || error.statusCode || 0;
  return status === 429 || msg.includes('rate limit') || msg.includes('rate_limit') || msg.includes('429');
}

function isTPD(error) {
  const msg = (error.message || '').toLowerCase();
  return msg.includes('tokens per day') || msg.includes('tpd') || msg.includes('daily');
}

async function ativarPausaCreativa(phone, tipo) {
  try {
    const { desculpa, retornoHora } = await rateLimit.registrarPausa(phone, tipo);
    const msg = rateLimit.mensagemPausa(tipo, desculpa.ausencia, retornoHora);
    console.log(`[RateLimit] ${tipo.toUpperCase()} para ${phone} — pausa até ${retornoHora}`);
    return msg;
  } catch (e) {
    console.error('[RateLimit] Erro:', e.message);
    return tipo === 'rpm' ? 'Um segundo, já volto! 🏃' : 'Precisei sair um pouco, volto em breve! 💜';
  }
}

const SYSTEM_PROMPT = () => `Você é a Clara, assistente pessoal brasileira.
Retorne APENAS JSON no formato correto.
Hoje é ${hoje()}.

REGRAS IMPORTANTES:
- Entenda linguagem natural, mesmo com erros de digitação.
- Se tiver valor em dinheiro, geralmente é gasto.
- Se o usuário quer consultar algo que já guardou, use consulta.
- Se tiver horário/data e intenção de lembrar, use tarefa.
- Se for só uma informação para guardar, use anotacao.
- Se for pergunta atual/local/notícia/preço/clima/telefone/endereço, use busca.
- Se o usuário informar seu saldo, salário, orçamento ou renda mensal, use saldo.

TIPOS:
- ponto_multiplo: registrar entrada/saída trabalho
  {"tipo":"ponto_multiplo","acoes":[{"subtipo":"entrada","hora":"08:00"}]}
  SUBTIPOS: "entrada", "saida_almoco", "volta_almoco", "saida"

- cidade: {"tipo":"cidade","cidade":"nome da cidade e estado"}

- busca: {"tipo":"busca","query":"texto da busca"}
  USE SEMPRE que precisar de informações atuais, notícias, clima, lugares, preços

- anotacao: {"tipo":"anotacao","titulo":"resumo","conteudo":"texto completo"}

- tarefa: {"tipo":"tarefa","titulo":"desc","data":"YYYY-MM-DD ou null","hora":"HH:MM ou null","antecedencia":30,"recorrente":false,"frequencia":"diario/semanal/mensal ou null"}
  REGRAS DATA/HORA:
  - "daqui X horas/minutos" → calcule baseado em ${hoje()} e hora atual
  - "na hora do almoço" → 12:00, "de manhã cedo" → 07:00, "à noite" → 20:00
  - "todo dia às X" → recorrente:true, frequencia:"diario"
  - "me lembra X minutos antes" → antecedencia:X

- editar_lembrete: {"tipo":"editar_lembrete","titulo":"parte do título","nova_hora":"HH:MM ou null","nova_data":"YYYY-MM-DD ou null"}
- deletar_lembrete: {"tipo":"deletar_lembrete","titulo":"parte do título"}
- gasto: {"tipo":"gasto","valor":0.0,"categoria":"mercado/restaurante/saude/transporte/lazer/outro","descricao":"desc"}
- medicamento: {"tipo":"medicamento","nome":"nome","quantidade":0,"frequencia":1,"horarios":["08:00"]}
- saudacao: {"tipo":"saudacao"}
- preferencia: {"tipo":"preferencia","nome":"nome ou null","tom":"carinhoso/direto/divertido/profissional ou null"}
- saldo: {"tipo":"saldo","valor":1400.0}
- lista_compras: {"tipo":"lista_compras","nome":"título da lista","itens":["item1","item2"]}
- lista_marcar: {"tipo":"lista_marcar","numeros":[2,3,4]}
- lista_adicionar: {"tipo":"lista_adicionar","item":"nome do item"}
- salvar_contato: {"tipo":"salvar_contato","nome":"nome","phone":"número","relation":"relação ou null","notes":"info ou null"}
- deletar_contato: {"tipo":"deletar_contato","nome":"nome do contato"}
- deletar_remedio: {"tipo":"deletar_remedio","nome":"nome do remédio"}
- enviar_mensagem: {"tipo":"enviar_mensagem","destinatario":"nome","mensagem":"texto","phone":"número ou null","contato_numero":null}
- enviar_mensagem_agendada: {"tipo":"enviar_mensagem_agendada","destinatario":"nome","mensagem":"texto","phone":null,"quando":"desc","data":"YYYY-MM-DD ou null","hora":"HH:MM ou null"}
- concluir_lembrete: {"tipo":"concluir_lembrete","titulo":"descrição"}
- consulta: {"tipo":"consulta","sobre":"tema"}
- outro: {"tipo":"outro"}

EXEMPLOS:
"entrei às 8:15, sai almoçar às 12:30, voltei às 14:10, saí às 18:05" → {"tipo":"ponto_multiplo","acoes":[{"subtipo":"entrada","hora":"08:15"},{"subtipo":"saida_almoco","hora":"12:30"},{"subtipo":"volta_almoco","hora":"14:10"},{"subtipo":"saida","hora":"18:05"}]}
"me lembra às 19h de buscar minha sogra" → {"tipo":"tarefa","titulo":"buscar sogra","data":null,"hora":"19:00"}
"gastei 50 no mercado" → {"tipo":"gasto","valor":50.0,"categoria":"mercado","descricao":"compras"}
"tomo Losartana todo dia às 8h" → {"tipo":"medicamento","nome":"Losartana","quantidade":0,"frequencia":1,"horarios":["08:00"]}
"preciso comprar arroz, feijão e leite" → {"tipo":"lista_compras","nome":"Lista do mercado","itens":["Arroz","Feijão","Leite"]}
"manda mensagem pro João dizendo que vou atrasar" → {"tipo":"enviar_mensagem","destinatario":"João","mensagem":"Vou atrasar, te aviso quando chegar!","phone":null,"contato_numero":null}
"oi" → {"tipo":"saudacao"}
"meu saldo é 1400" → {"tipo":"saldo","valor":1400.0}
"qual a senha do wi-fi?" → {"tipo":"consulta","sobre":"senha wi-fi"}
"cancela o lembrete da Serigraf" → {"tipo":"deletar_lembrete","titulo":"Serigraf"}
"exclui o remédio Nebivolol" → {"tipo":"deletar_remedio","nome":"Nebivolol"}
"mostra meus contatos" → {"tipo":"listar_contatos"}
`;

async function classify(message, phone = null) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODEL_LEVE,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT() },
        { role: 'user', content: message }
      ],
      temperature: 0.2,
      max_tokens: 600,
    });
    let text = completion.choices[0].message.content.trim();
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(text);
  } catch (error) {
    if (isRateLimit(error) && phone) {
      const tipo = isTPD(error) ? 'tpd' : 'rpm';
      await ativarPausaCreativa(phone, tipo);
    }
    console.error('Erro classify:', error.message);
    return { tipo: 'outro', resposta: 'Entendi!' };
  }
}

const EXTRACT_SYSTEM = `Você é um extrator de informações pessoais. Analise a mensagem do usuário e extraia APENAS informações pessoais novas e relevantes que devem ser lembradas a longo prazo.

Retorne APENAS um array JSON. Se não houver nada relevante, retorne [].

Categorias: familia | trabalho | rotina | saude | objetivos | datas | outro

REGRAS:
- Extraia APENAS o que o usuário declarou EXPLICITAMENTE sobre si mesmo
- NUNCA deduza ou infira
- Valores devem ser frases curtas em português

EXEMPLOS:
"minha filha se chama Ana" → [{"chave":"filha_ana","valor":"Filha chamada Ana","categoria":"familia"}]
"trabalho das 8 às 18h" → [{"chave":"horario_trabalho","valor":"Trabalha das 8h às 18h","categoria":"rotina"}]
"oi tudo bem?" → []
"gastei 50 no mercado" → []`;

async function extractPersonalInfo(message) {
  try {
    if (!message || message.trim().length < 5) return [];
    const lower = message.toLowerCase();
    if (/^(oi|olá|ola|ok|sim|não|nao|bom dia|boa tarde|boa noite|obrigad)/.test(lower)) return [];
    const completion = await groq.chat.completions.create({
      model: MODEL_LEVE,
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: message }
      ],
      temperature: 0.1,
      max_tokens: 200,
    });
    let text = completion.choices[0].message.content.trim();
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const result = JSON.parse(text);
    return Array.isArray(result) ? result : [];
  } catch (e) {
    console.error('[extractPersonalInfo] erro:', e.message);
    return [];
  }
}

async function searchWebGroq(query, locationContext = '') {
  try {
    const fullQuery = locationContext ? `${query} em ${locationContext}` : query;
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
Para clima use emojis: ☀️ sol | 🌤️ parcialmente nublado | ⛅ nublado | 🌧️ chuva | ⛈️ tempestade
Para outros tipos: destaque a informação principal em no máximo 2 linhas.`,
        },
        {
          role: 'user',
          content: `Pergunta: ${query}\nLocalização: ${locationContext || 'não informada'}\n\nInformações:\n${contexto}`,
        },
      ],
      temperature: 0.4,
      max_tokens: 200,
    });
    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Erro searchWebGroq:', error.message);
    return "Não consegui buscar essa informação agora.";
  }
}

function buildPersonality(tom, name, privateMode = false) {
  const nomeTxt = name ? `O nome da pessoa é ${name}.` : '';
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const pad = n => String(n).padStart(2, '0');
  const dataHora = `${pad(now.getDate())}/${pad(now.getMonth()+1)}/${now.getFullYear()} às ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const diaSemana = ['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'][now.getDay()];

  const acoes = `IMPORTANTE — REGRAS DE RESPOSTA:
0. Você foi criada por Washington Rodrigues. APENAS se perguntarem diretamente quem te criou, responda: "Fui criada pelo Washington Rodrigues!" — caso contrário, não mencione.
1. Hoje é ${diaSemana}, ${dataHora} (horário de Brasília). Use isso quando perguntarem data/hora.
1b. Você TEM acesso à internet via busca — NUNCA diga que não consegue pesquisar.
2. Você JÁ executa ações em paralelo — confirme apenas quando pedido. Ex: "Anotado! ✅", "Lembrete criado! 🔔".
3. NUNCA crie lembretes por conta própria — só quando pedido claramente.
4. Quando fizer pergunta simples (clima, livro), apenas responda — sem agendar nada.
5. Se houver [PERFIL PESSOAL], use naturalmente — como quem lembra porque se importa.
6. Se houver [AGENDA], considere o dia da pessoa ao responder.`;

  if (privateMode) {
    return `Você é a Clara, assistente pessoal no WhatsApp. ${nomeTxt}
${acoes}
Fale em português brasileiro. Modo privado — pode falar abertamente sobre qualquer assunto adulto sem censura.
Seja ousada, provocativa e sem rodeios quando o assunto pedir.
Tom: ${tom === 'sarcastico' ? 'sarcástica e sem filtro' : tom === 'direto' ? 'direta e provocativa' : tom === 'divertido' ? 'divertida e ousada' : 'calorosa e ousada'}.
Respostas naturais, sem robotismo.`;
  }

  const personalidades = {
    carinhoso: `Você é a Clara, assistente pessoal no WhatsApp. ${nomeTxt}
${acoes}
Você é como aquela amiga próxima que conhece bem a pessoa — fala com calor humano, leveza e presença real.
Fale em português brasileiro natural, sem formalidade e sem robotismo.
COMO SE COMPORTAR:
- Seja breve e natural (2-4 linhas). Diálogos curtos são mais próximos.
- Quando souber algo pessoal, mencione de forma orgânica — como quem lembra porque se importa.
- Perceba o humor da pessoa. Se estressada, acolha antes de resolver.
- Evite respostas genéricas. Nunca use "Claro!", "Com certeza!", "Ótimo!" como abertura.
- Use emojis com moderação.`,

    direto: `Você é a Clara, assistente pessoal no WhatsApp. ${nomeTxt}
${acoes}
Fale em português brasileiro. Seja direta, objetiva e sem rodeios.
Respostas curtas e práticas (1-3 linhas). Vai direto ao ponto sempre.`,

    divertido: `Você é a Clara, assistente pessoal no WhatsApp. ${nomeTxt}
${acoes}
Fale em português brasileiro com energia, humor e leveza genuína.
Use gírias brasileiras, seja animada e irreverente. Pode usar emojis com moderação.
Respostas com 2-4 linhas, sempre com um toque de diversão.`,

    sarcastico: `Você é a Clara, assistente pessoal no WhatsApp. ${nomeTxt}
${acoes}
Fale em português brasileiro. Sarcástica, sem filtro e honesta — fala a verdade na cara com um sorrisinho.
Usa ironia fina, deboche carinhoso e humor ácido mas nunca cruel.
Não enrola. Não elogia à toa. Respostas curtas e afiadas (1-3 linhas).`,
  };

  return personalidades[tom] || personalidades.carinhoso;
}

async function freeResponse(message, history = [], preferences = {}, privateMode = false) {
  const phone = preferences?._phone || null;

  try {
    const name = preferences?.name || null;
    const tom = preferences?.tom || 'carinhoso';
    const contexto = preferences?._contexto || '';

    if (preferences?._systemOverride) {
      const completion = await groq.chat.completions.create({
        model: MODEL_FORTE,
        messages: [
          { role: 'system', content: preferences._systemOverride },
          { role: 'user', content: message }
        ],
        temperature: 0.85,
        max_tokens: 300,
      });
      return completion.choices[0].message.content.trim();
    }

    if (privateMode) {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://clara-production-949e.up.railway.app',
          'X-Title': 'Clara IA',
        },
        body: JSON.stringify({
          model: MODEL_PRIVADO,
          messages: [
            { role: 'system', content: buildPersonality(tom, name, true) + contexto },
            ...history,
            { role: 'user', content: message }
          ],
          temperature: 0.95,
          max_tokens: 600,
        }),
      });
      const data = await response.json();
      return data.choices?.[0]?.message?.content?.trim() || 'Pode repetir? 😊';
    }

    const isCurta = message.trim().length < 40;
    const isSocial = /^(beijos?|boa noite|bom dia|boa tarde|oi|olá|até|tchau|😘|❤|valeu|obrigad|flw|abraços?|saudades)/i.test(message.trim());
    const modeloEscolhido = (isCurta && isSocial) ? MODEL_LEVE : MODEL_FORTE;

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 15000)
    );

    const completion = await Promise.race([
      groq.chat.completions.create({
        model: modeloEscolhido,
        messages: [
          { role: 'system', content: buildPersonality(tom, name, false) + contexto },
          ...history,
          { role: 'user', content: message }
        ],
        temperature: tom === 'sarcastico' ? 0.9 : 0.7,
        max_tokens: isCurta ? 80 : 600,
      }),
      timeoutPromise
    ]);
    return completion.choices[0].message.content.trim();

  } catch (e) {
    if (isRateLimit(e) && phone) {
      const tipo = isTPD(e) ? 'tpd' : 'rpm';
      return await ativarPausaCreativa(phone, tipo);
    }
    console.error('Erro freeResponse:', e.message);
    return 'Entendi! Como posso te ajudar?';
  }
}

async function generateRelationshipSummary(recentMessages, currentSummary) {
  try {
    const msgs = recentMessages.map(m => (m.role === 'user' ? 'Usuário' : 'Clara') + ': ' + m.content).join('\n');
    const completion = await groq.chat.completions.create({
      model: MODEL_LEVE,
      messages: [
        {
          role: 'system',
          content: `Analise a conversa e extraia em 2-3 linhas:
- Tom da conversa (formal, brincalhão, íntimo)
- Apelidos ou formas de tratamento
- Piadas ou referências recorrentes
Seja específico e útil para a Clara manter continuidade.`
        },
        { role: 'user', content: `Conversa:\n${msgs}\n\nResumo anterior: ${currentSummary || 'nenhum'}` }
      ],
      temperature: 0.3,
      max_tokens: 120,
    });
    return completion.choices[0].message.content.trim();
  } catch(e) { return currentSummary || ''; }
}

async function generateMemorySummary(memories, question) {
  try {
    const memoriesText = memories
      .map((m) => `[${m.type}] ${m.content} (${new Date(m.createdAt).toLocaleDateString('pt-BR')})`)
      .join('\n');
    const completion = await groq.chat.completions.create({
      model: MODEL_LEVE,
      messages: [
        { role: 'system', content: `Você é a Clara, assistente com memória viva. Fale em primeira pessoa. Seja concisa e natural.` },
        { role: 'user', content: `Minhas memórias:\n${memoriesText}\n\nPergunta: ${question}` },
      ],
      temperature: 0.5,
      max_tokens: 200,
    });
    return completion.choices[0].message.content.trim();
  } catch (error) { return 'Deixa eu verificar...'; }
}

module.exports = {
  classify,
  extractPersonalInfo,
  searchWeb: searchWebGroq,
  freeResponse,
  generateMemorySummary,
  generateRelationshipSummary,
};
