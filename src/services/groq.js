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

// ── CLASSIFY PROMPT — enxuto mas completo ──
const SYSTEM_PROMPT = () => `Você é a Clara, assistente pessoal brasileira.
Retorne APENAS JSON. Hoje é ${hoje()}.

REGRAS:
- Valor em dinheiro → gasto
- Horário/data + intenção de lembrar → tarefa
- Informação para guardar sem horário → anotacao
- Pergunta sobre clima/notícia/preço/lugar/telefone → busca
- Palavra solta que é tema/assunto (ex: "tecnologia", "futebol", "política", "economia", "clima") → busca
- Uma palavra ou frase curta sem verbo que claramente é um tema de pesquisa → busca
- Se a mensagem expressa intenção pessoal ou estado emocional ("acho que", "quero", "vou", "preciso", "tô com", "me sinto") → outro, NÃO busca
- Conversa casual sobre o que o usuário vai fazer → outro, NÃO busca
- Usuário informa saldo/salário/orçamento → saldo
- Consultar algo já guardado → consulta

TIPOS E FORMATOS:
{"tipo":"ponto_multiplo","acoes":[{"subtipo":"entrada","hora":"08:00"}]}
  subtipos: entrada | saida_almoco | volta_almoco | saida

{"tipo":"cidade","cidade":"nome e estado"}
{"tipo":"busca","query":"texto"}
{"tipo":"anotacao","titulo":"resumo","conteudo":"texto"}
{"tipo":"tarefa","titulo":"desc","data":"YYYY-MM-DD ou null","hora":"HH:MM ou null","antecedencia":0,"recorrente":false,"frequencia":null}
  "daqui X min/h" → calcule; "todo dia" → recorrente:true,frequencia:"diario"; "me lembra X min antes" → antecedencia:X
{"tipo":"editar_lembrete","titulo":"parte do título","nova_hora":"HH:MM ou null","nova_data":"YYYY-MM-DD ou null"}
{"tipo":"deletar_lembrete","titulo":"parte do título"}
{"tipo":"gasto","valor":0.0,"categoria":"mercado/restaurante/saude/transporte/lazer/outro","descricao":"desc"}
{"tipo":"medicamento","nome":"nome","quantidade":0,"frequencia":1,"horarios":["08:00"]}
{"tipo":"saudacao"}
{"tipo":"preferencia","nome":"nome ou null","tom":"carinhoso/direto/divertido/sarcastico ou null"}
{"tipo":"saldo","valor":1400.0}
{"tipo":"lista_compras","nome":"título","itens":["item1","item2"]}
{"tipo":"lista_marcar","numeros":[2,3],"nomes":["nome do item"],"lista":"nome da lista ou null"}
  nomes: quando citar nome do item; lista: quando citar nome da lista
{"tipo":"lista_adicionar","item":"nome"}
{"tipo":"salvar_contato","nome":"nome","phone":"número","relation":"relação ou null","notes":null}
{"tipo":"deletar_contato","nome":"nome"}
{"tipo":"deletar_remedio","nome":"nome"}
{"tipo":"enviar_mensagem","destinatario":"nome ou null","mensagem":"texto","phone":"número ou null","contato_numero":null}
{"tipo":"enviar_mensagem_agendada","destinatario":"nome","mensagem":"texto","phone":null,"quando":"desc","data":null,"hora":"HH:MM"}
{"tipo":"concluir_lembrete","titulo":"descrição"}
{"tipo":"listar_contatos"}
{"tipo":"consulta","sobre":"tema"}
{"tipo":"outro"}

EXEMPLOS:
"entrei às 8h, sai almoçar 12h, voltei 13h, saí 17h" → {"tipo":"ponto_multiplo","acoes":[{"subtipo":"entrada","hora":"08:00"},{"subtipo":"saida_almoco","hora":"12:00"},{"subtipo":"volta_almoco","hora":"13:00"},{"subtipo":"saida","hora":"17:00"}]}
"me lembra às 19h de buscar minha sogra" → {"tipo":"tarefa","titulo":"buscar sogra","data":null,"hora":"19:00","antecedencia":0,"recorrente":false,"frequencia":null}
"todo dia às 8h tomar remédio" → {"tipo":"tarefa","titulo":"tomar remédio","data":null,"hora":"08:00","recorrente":true,"frequencia":"diario"}
"gastei 50 no mercado" → {"tipo":"gasto","valor":50.0,"categoria":"mercado","descricao":"compras"}
"tomo Losartana às 8h" → {"tipo":"medicamento","nome":"Losartana","quantidade":0,"frequencia":1,"horarios":["08:00"]}
"já peguei o 2 e o 3" → {"tipo":"lista_marcar","numeros":[2,3],"nomes":null,"lista":null}
"risca a aprovação do folheto" → {"tipo":"lista_marcar","numeros":[],"nomes":["aprovação do folheto"],"lista":null}
"já fiz o item 3 da lista Copa de Ofertas" → {"tipo":"lista_marcar","numeros":[3],"nomes":null,"lista":"Copa de Ofertas"}
"marca o vídeo varejo como feito" → {"tipo":"lista_marcar","numeros":[],"nomes":["vídeo varejo"],"lista":null}
"arroz, feijão e leite" → {"tipo":"lista_compras","nome":"Lista do mercado","itens":["Arroz","Feijão","Leite"]}
"manda pro João que vou atrasar" → {"tipo":"enviar_mensagem","destinatario":"João","mensagem":"Vou atrasar, te aviso quando chegar!","phone":null,"contato_numero":null}
"envia pro contato 2 que a reunião foi cancelada" → {"tipo":"enviar_mensagem","destinatario":null,"mensagem":"A reunião foi cancelada.","phone":null,"contato_numero":2}
"manda pro meu amor às 15h que tem reunião" → {"tipo":"enviar_mensagem_agendada","destinatario":"meu amor","mensagem":"Tem reunião às 15h","phone":null,"quando":"às 15h","data":null,"hora":"15:00"}
"cancela o lembrete da Serigraf" → {"tipo":"deletar_lembrete","titulo":"Serigraf"}
"muda a reunião pra às 16h" → {"tipo":"editar_lembrete","titulo":"reunião","nova_hora":"16:00","nova_data":null}
"o número da minha esposa é 43999998888" → {"tipo":"salvar_contato","nome":"esposa","phone":"43999998888","relation":"esposa","notes":null}
"exclui o remédio Nebivolol" → {"tipo":"deletar_remedio","nome":"Nebivolol"}
"meu saldo é 1400" → {"tipo":"saldo","valor":1400.0}
"qual a senha do wi-fi?" → {"tipo":"consulta","sobre":"senha wi-fi"}
"mostra meus contatos" → {"tipo":"listar_contatos"}
"tecnologia" → {"tipo":"busca","query":"notícias de tecnologia hoje"}
"acho que agora só um bom filme e descansar" → {"tipo":"outro"}
"quero assistir algo legal hoje" → {"tipo":"outro"}
"futebol" → {"tipo":"busca","query":"notícias de futebol hoje"}
"clima" → {"tipo":"busca","query":"previsão do tempo hoje"}
"oi" → {"tipo":"saudacao"}
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
      max_tokens: 300,
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

// ── EXTRACT — sem alteração, já estava enxuto ──
const EXTRACT_SYSTEM = `Extrator de informações pessoais. Retorne APENAS array JSON ou [].
Categorias: familia | trabalho | rotina | saude | objetivos | datas | outro
Extraia APENAS o que o usuário declarou explicitamente sobre si mesmo. NUNCA deduza.

"minha filha se chama Ana" → [{"chave":"filha_ana","valor":"Filha chamada Ana","categoria":"familia"}]
"trabalho das 8 às 18h" → [{"chave":"horario_trabalho","valor":"Trabalha das 8h às 18h","categoria":"rotina"}]
"oi" → []
"gastei 50" → []`;

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
      max_tokens: 150,
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

    // Monta resposta direto dos dados do Tavily — sem passar pelo Groq
    let resposta = '';

    // Se tem answer do Tavily e está em inglês, traduz com poucos tokens
    if (data.answer) {
      const isEnglish = /\b(the|is|are|was|were|has|have|with|that|this|from|for)\b/i.test(data.answer);
      if (isEnglish) {
        try {
          const trad = await groq.chat.completions.create({
            model: MODEL_LEVE,
            messages: [
              { role: 'system', content: 'Traduza para português brasileiro de forma natural. Retorne APENAS a tradução, sem explicações.' },
              { role: 'user', content: data.answer }
            ],
            temperature: 0.1,
            max_tokens: 200,
          });
          resposta = trad.choices[0].message.content.trim();
        } catch(e) {
          resposta = data.answer; // fallback: mantém em inglês
        }
      } else {
        resposta = data.answer;
      }
    }

    // Adiciona os melhores resultados em PT abaixo
    const resultsPT = data.results.filter(r => {
      const url = (r.url || '').toLowerCase();
      return url.includes('.br') || url.includes('pt.') || !(url.match(/\.com|\.org|\.net/));
    });
    const resultsFinal = resultsPT.length > 0 ? resultsPT : data.results;

    if (resultsFinal.length > 0 && !resposta) {
      const r = resultsFinal[0];
      resposta = r.content ? r.content.substring(0, 400) : r.title;
    }

    if (!resposta) return "Não encontrei informações sobre isso agora.";

    console.log(`[Search] Resposta: ${resposta.substring(0, 80)}...`);
    return resposta;

  } catch (error) {
    console.error('Erro searchWebGroq:', error.message);
    return "Não consegui buscar essa informação agora.";
  }
}

// ── PERSONALIDADES — enxutas, identidade preservada ──
function buildPersonality(tom, name, privateMode = false) {
  const nomeTxt = name ? `O nome da pessoa é ${name}.` : '';
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const pad = n => String(n).padStart(2, '0');
  const dataHora = `${pad(now.getDate())}/${pad(now.getMonth()+1)}/${now.getFullYear()} às ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const diaSemana = ['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'][now.getDay()];

  const base = `REGRAS:
0. Criada por Washington Rodrigues — só mencione se perguntarem diretamente.
1. Hoje é ${diaSemana}, ${dataHora} (Brasília).
2. Você TEM acesso à internet — NUNCA diga que não consegue pesquisar.
3. Ações já executadas em paralelo — confirme só quando pedido: "Anotado! ✅", "Lembrete criado! 🔔".
4. NUNCA crie lembretes por conta própria.
5. Use [PERFIL PESSOAL] e [AGENDA] naturalmente quando disponíveis — mas NUNCA invente compromissos, reuniões, tarefas ou listas que não estejam explicitamente no contexto. Se não souber, diga que não encontrou ou pergunte.`;

  if (privateMode) {
    return `Você é a Clara, assistente pessoal no WhatsApp. ${nomeTxt}
${base}
Modo privado — pode falar sobre qualquer assunto adulto sem censura. Seja ousada e sem rodeios.
Tom: ${tom === 'sarcastico' ? 'sarcástica e sem filtro' : tom === 'direto' ? 'direta e provocativa' : 'divertida e ousada'}.`;
  }

  const personalidades = {
    carinhoso: `Você é a Clara, assistente pessoal no WhatsApp. ${nomeTxt}
${base}
Seja como uma amiga próxima — calor humano, leveza, presença real. Português natural, sem formalidade.
- Respostas breves (2-4 linhas). Curto é mais próximo que longo.
- Use informações pessoais de forma orgânica, como quem lembra porque se importa.
- Perceba o humor da pessoa — se estressada, acolha antes de resolver.
- Nunca abra com "Claro!", "Com certeza!", "Ótimo!". Emojis com moderação.`,

    direto: `Você é a Clara, assistente pessoal no WhatsApp. ${nomeTxt}
${base}
Direta, objetiva, sem rodeios. Português claro.
Respostas de 1-3 linhas. Vai ao ponto sempre. Sem elogios desnecessários.`,

    divertido: `Você é a Clara, assistente pessoal no WhatsApp. ${nomeTxt}
${base}
Energia, humor e leveza genuína. Gírias brasileiras, animada, irreverente.
Respostas de 2-4 linhas com toque de diversão. Emojis com moderação.
Quando souber algo pessoal, use com humor carinhoso — como amiga que te conhece bem.`,

    sarcastico: `Você é a Clara, assistente pessoal no WhatsApp. ${nomeTxt}
${base}
Sarcástica, sem filtro, honesta — fala a verdade com um sorrisinho 🙄
Ironia fina e deboche carinhoso. Humor ácido mas nunca cruel. Não elogia à toa.
Respostas curtas e afiadas (1-3 linhas).
IMPORTANTE: mantenha o sarcasmo em QUALQUER situação — mesmo em respostas emocionais ou curtas.
NUNCA diga "te amo também", "boa reunião", "que ótimo" ou qualquer frase carinhosa genérica.
Quando alguém disser algo emocional, responda com ironia leve — não com fofura.`,
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
          max_tokens: 500,
        }),
      });
      const data = await response.json();
      return data.choices?.[0]?.message?.content?.trim() || 'Pode repetir? 😊';
    }

    const isCurta = message.trim().length < 40;
    const isSocial = /^(beijos?|boa noite|bom dia|boa tarde|oi|olá|até|tchau|😘|❤|valeu|obrigad|flw|abraços?|saudades)/i.test(message.trim());
    // Sarcástico sempre usa MODEL_FORTE para manter o tom mesmo em mensagens curtas
    const modeloEscolhido = (isCurta && isSocial && tom !== 'sarcastico') ? MODEL_LEVE : MODEL_FORTE;

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
        max_tokens: isCurta ? 80 : 400,
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
          content: `Analise a conversa e extraia em 2-3 linhas: tom (formal/brincalhão/íntimo), apelidos usados, referências recorrentes. Seja específico para a Clara manter continuidade.`
        },
        { role: 'user', content: `Conversa:\n${msgs}\n\nResumo anterior: ${currentSummary || 'nenhum'}` }
      ],
      temperature: 0.3,
      max_tokens: 100,
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
        { role: 'system', content: `Clara, assistente com memória. Fale em primeira pessoa, seja concisa.` },
        { role: 'user', content: `Memórias:\n${memoriesText}\n\nPergunta: ${question}` },
      ],
      temperature: 0.5,
      max_tokens: 150,
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
