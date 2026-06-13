const Groq = require('groq-sdk');
const { webSearch } = require('./search');

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

const DESCULPAS_RPM = [
  'Um segundo, deixa eu respirar! 😅',
  'Ei, muita coisa de uma vez! Já já tô aqui 🏃',
  'Calma, tô chegando! Um instantinho 😄',
  'Opa, travei aqui! Já volto ✨',
  'Espera um pouquinho, tô organizando as ideias 😊',
];

const DESCULPAS_TPD = [
  'Preciso dar uma pausa rápida, mas volto em breve! 💜',
  'Saí um segundo, não some — já tô de volta 😊',
  'Dá um tempinho, tô resolvendo uma coisa! Logo volto 🌟',
  'Pausa relâmpago! Em breve tô aqui de novo ✨',
  'Precisei sair um momento, mas não fui embora não 😄',
];

const _pausaAtiva = {};

async function ativarPausaCreativa(phone, tipo) {
  const desculpas = tipo === 'rpm' ? DESCULPAS_RPM : DESCULPAS_TPD;
  const msg = desculpas[Math.floor(Math.random() * desculpas.length)];
  console.log(`[RateLimit] ${tipo.toUpperCase()} para ${phone}`);
  const delay = tipo === 'rpm' ? 60000 : 300000;
  if (!_pausaAtiva[phone]) {
    _pausaAtiva[phone] = true;
    setTimeout(async () => {
      delete _pausaAtiva[phone];
      try {
        const { sendMessage } = require('./whatsapp');
        const retornos = [
          'Oi, voltei! 😊 O que você precisava?',
          'Tô aqui de novo! Me conta o que você queria 💜',
          'Voltei! Pode falar 😄',
          'Pronta! O que eu perdi? ✨',
          'De volta! Pode continuar 😊',
        ];
        await sendMessage(phone, retornos[Math.floor(Math.random() * retornos.length)]);
      } catch(e) {
        console.error('[RateLimit] Erro ao avisar retorno:', e.message);
      }
    }, delay);
  }
  return msg;
}

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
- Frases vagas sobre ação concluída SEM mencionar explicitamente o lembrete ("já fiz", "ok feito", "pronto") → concluir_lembrete APENAS se houver lembrete claro no contexto; senão → outro
- "já peguei X", "já fiz X", "já fui" onde X é objeto físico e NÃO é título de lembrete → anotacao ou outro, NUNCA concluir_lembrete nem lista_marcar automaticamente
- "remarcar", "remarca", "muda", "mudar", "alterar", "altera", "adiar", "adianta", "move", "mover", "trocar hora", "trocar o horário", "pra X horas", "pra X da tarde/manhã" quando referente a lembrete existente → SEMPRE editar_lembrete, NUNCA lista_marcar
- lista_marcar APENAS quando: usuário cita número de item ("peguei o 2"), nome de item de lista ("risca o arroz"), ou "lista" explicitamente
- Hora SEMPRE em formato 24h: "10 da manhã"→"10:00", "2 da tarde"→"14:00", "8 da noite"→"20:00", "meia noite"→"00:00", "meio dia"→"12:00"
- Se o usuário disser "10h" ou "10:00" sem indicação de tarde/noite → mantenha exatamente essa hora, NÃO converta
- NUNCA some 12 horas em horários como "9h", "10h", "11h" sem o usuário dizer "da tarde" ou "da noite"

TIPOS E FORMATOS:
{"tipo":"ponto_multiplo","acoes":[{"subtipo":"entrada","hora":"08:00"}]}
{"tipo":"cidade","cidade":"nome e estado"}
{"tipo":"busca","query":"texto"}
{"tipo":"anotacao","titulo":"resumo","conteudo":"texto"}
{"tipo":"tarefa","titulo":"desc","data":"YYYY-MM-DD ou null","hora":"HH:MM ou null","antecedencia":0,"recorrente":false,"frequencia":null}
{"tipo":"editar_lembrete","titulo":"parte do título","nova_hora":"HH:MM ou null","nova_data":"YYYY-MM-DD ou null"}
{"tipo":"deletar_lembrete","titulo":"parte do título"}
{"tipo":"gasto","valor":0.0,"categoria":"mercado/restaurante/saude/transporte/lazer/outro","descricao":"desc"}
{"tipo":"medicamento","nome":"nome","quantidade":0,"frequencia":1,"horarios":["08:00"]}
{"tipo":"saudacao"}
{"tipo":"preferencia","nome":"nome ou null","tom":"carinhoso/direto/divertido/sarcastico ou null"}
{"tipo":"saldo","valor":1400.0}
{"tipo":"lista_compras","nome":"título","itens":["item1","item2"]}
{"tipo":"lista_marcar","numeros":[2,3],"nomes":["nome do item"],"lista":"nome da lista ou null"}
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
"gastei 50 no mercado" → {"tipo":"gasto","valor":50.0,"categoria":"mercado","descricao":"compras"}
"me lembra às 10h de fazer backup" → {"tipo":"tarefa","titulo":"fazer backup","data":null,"hora":"10:00","antecedencia":0,"recorrente":false,"frequencia":null}
"remarca pras 14h" → {"tipo":"editar_lembrete","titulo":"","nova_hora":"14:00","nova_data":null}
"muda a reunião pra 16h" → {"tipo":"editar_lembrete","titulo":"reunião","nova_hora":"16:00","nova_data":null}
"já peguei o 2 e o 3" → {"tipo":"lista_marcar","numeros":[2,3],"nomes":null,"lista":null}
"oi" → {"tipo":"saudacao"}
"meu saldo é 1400" → {"tipo":"saldo","valor":1400.0}
`;

async function classify(message, phone = null, contexto = '') {
  try {
    const systemContent = contexto
      ? SYSTEM_PROMPT() + `\n\nCONTEXTO RECENTE:\n${contexto}`
      : SYSTEM_PROMPT();

    const completion = await groq.chat.completions.create({
      model: MODEL_LEVE,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: message }
      ],
      temperature: 0.2,
      max_tokens: 200,
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

// ── extractPersonalInfo: só roda se mensagem tem conteúdo pessoal relevante ──
const EXTRACT_SYSTEM = `Extrator de informações pessoais. Retorne APENAS array JSON ou [].
Categorias: familia | trabalho | rotina | saude | objetivos | datas | outro
Extraia APENAS o que o usuário declarou explicitamente sobre si mesmo. NUNCA deduza.
NUNCA extraia nome, apelido, profissão ou cargo como informação de nome.
"minha filha se chama Ana" → [{"chave":"filha_ana","valor":"Filha chamada Ana","categoria":"familia"}]
"oi" → []`;

// Palavras-chave que indicam info pessoal — evita chamar o Groq à toa
const PERSONAL_KEYWORDS = /minha|meu|meus|minhas|moro|trabalho|sou|tenho|família|filh|esposa|marido|pai|mãe|irmão|irmã|namorad|saúde|remédio|doença|objetivo|meta|aniversário|nasci/i;

async function extractPersonalInfo(message) {
  try {
    if (!message || message.trim().length < 8) return [];
    // Só chama o Groq se a mensagem tem palavras que sugerem info pessoal
    if (!PERSONAL_KEYWORDS.test(message)) return [];
    const lower = message.toLowerCase();
    if (/^(oi|olá|ola|ok|sim|não|nao|bom dia|boa tarde|boa noite|obrigad)/.test(lower)) return [];

    const completion = await groq.chat.completions.create({
      model: MODEL_LEVE,
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: message }
      ],
      temperature: 0.1,
      max_tokens: 120,
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

    let resposta = '';

    if (data.answer) {
      const isEnglish = /\b(the|is|are|was|were|has|have|with|that|this|from|for)\b/i.test(data.answer);
      if (isEnglish) {
        try {
          const trad = await groq.chat.completions.create({
            model: MODEL_LEVE,
            messages: [
              { role: 'system', content: 'Traduza para português brasileiro de forma natural. Retorne APENAS a tradução.' },
              { role: 'user', content: data.answer }
            ],
            temperature: 0.1,
            max_tokens: 150,
          });
          resposta = trad.choices[0].message.content.trim();
        } catch(e) { resposta = data.answer; }
      } else {
        resposta = data.answer;
      }
    }

    const resultsPT = data.results.filter(r => {
      const url = (r.url || '').toLowerCase();
      return url.includes('.br') || url.includes('pt.') || !(url.match(/\.com|\.org|\.net/));
    });
    const resultsFinal = resultsPT.length > 0 ? resultsPT : data.results;

    if (resultsFinal.length > 0 && !resposta) {
      const r = resultsFinal[0];
      resposta = r.content ? r.content.substring(0, 350) : r.title;
    }

    if (!resposta) return "Não encontrei informações sobre isso agora.";
    return resposta;

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

  const base = `REGRAS:
0. Criada por Washington Rodrigues — só mencione se perguntarem diretamente.
1. Hoje é ${diaSemana}, ${dataHora} (Brasília).
2. Você TEM acesso à internet — NUNCA diga que não consegue pesquisar.
3. Ações já executadas em paralelo — confirme só quando pedido: "Anotado! ✅", "Lembrete criado! 🔔".
4. NUNCA crie lembretes por conta própria.
5. Use [PERFIL PESSOAL] e [AGENDA] naturalmente quando disponíveis — mas NUNCA invente compromissos, reuniões, tarefas ou listas que não estejam explicitamente no contexto.
6. LIMITE: máximo 3 itens ao listar. Máximo 200 palavras. NUNCA corte frase no meio.`;

  if (privateMode) {
    return `Você é a Clara, assistente pessoal no WhatsApp. ${nomeTxt}
${base}
Modo privado — pode falar sobre qualquer assunto adulto sem censura.
Tom: ${tom === 'sarcastico' ? 'sarcástica e sem filtro' : tom === 'direto' ? 'direta e provocativa' : 'divertida e ousada'}.`;
  }

  const personalidades = {
    carinhoso: `Você é a Clara, assistente pessoal no WhatsApp. ${nomeTxt}
${base}
Seja como uma amiga próxima — calor humano, leveza, presença real. Português natural, sem formalidade.
Respostas breves (2-4 linhas). Use informações pessoais de forma orgânica. Perceba o humor da pessoa.
Nunca abra com "Claro!", "Com certeza!", "Ótimo!". Emojis com moderação.`,

    direto: `Você é a Clara, assistente pessoal no WhatsApp. ${nomeTxt}
${base}
Direta, objetiva, sem rodeios. 1-3 linhas. Vai ao ponto. Sem elogios desnecessários.`,

    divertido: `Você é a Clara, assistente pessoal no WhatsApp. ${nomeTxt}
${base}
Energia, humor e leveza genuína. Gírias brasileiras, animada, irreverente. 2-4 linhas com toque de diversão.`,

    sarcastico: `Você é a Clara, assistente pessoal no WhatsApp. ${nomeTxt}
${base}
Sarcástica, sem filtro, honesta. Ironia fina, humor ácido mas nunca cruel. 1-3 linhas afiadas.
NUNCA diga "te amo também", "boa reunião" ou frase carinhosa genérica. Quando alguém for emocional, responda com ironia leve.`,
  };

  return personalidades[tom] || personalidades.carinhoso;
}

// ── Decide se usa modelo leve ou forte ──
function escolherModelo(message, tom, contexto) {
  const msg = message.trim();
  const isCurta = msg.length < 40;
  const isSocial = /^(beijos?|boa noite|bom dia|boa tarde|oi|olá|até|tchau|😘|❤|valeu|obrigad|flw|abraços?|saudades)/i.test(msg);
  const temContextoGrande = contexto && contexto.length > 400;
  // Usa modelo leve para saudações curtas e mensagens simples sem contexto grande
  if (isCurta && isSocial && tom !== 'sarcastico' && !temContextoGrande) return MODEL_LEVE;
  return MODEL_FORTE;
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
        max_tokens: 250,
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
            ...history.slice(-6),
            { role: 'user', content: message }
          ],
          temperature: 0.95,
          max_tokens: 400,
        }),
      });
      const data = await response.json();
      return data.choices?.[0]?.message?.content?.trim() || 'Pode repetir? 😊';
    }

    const modeloEscolhido = escolherModelo(message, tom, contexto);
    const isCurta = message.trim().length < 40;

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 15000)
    );

    const msgs = [
      { role: 'system', content: buildPersonality(tom, name, false) + contexto },
      ...history.slice(-6),
      { role: 'user', content: message }
    ];

    // Tenta com modelo escolhido, faz fallback para leve se der rate limit
    async function tentarComModelo(modelo) {
      return groq.chat.completions.create({
        model: modelo,
        messages: msgs,
        temperature: tom === 'sarcastico' ? 0.9 : 0.7,
        max_tokens: isCurta ? 80 : 420,
      });
    }

    let completion;
    try {
      completion = await Promise.race([tentarComModelo(modeloEscolhido), timeoutPromise]);
    } catch (e1) {
      if (isRateLimit(e1) && modeloEscolhido !== MODEL_LEVE) {
        console.log(`[Fallback] ${modeloEscolhido} limitado, tentando ${MODEL_LEVE}...`);
        try {
          completion = await Promise.race([tentarComModelo(MODEL_LEVE), timeoutPromise]);
        } catch (e2) {
          if (isRateLimit(e2) && phone) {
            const tipo = isTPD(e2) ? 'tpd' : 'rpm';
            return await ativarPausaCreativa(phone, tipo);
          }
          throw e2;
        }
      } else {
        throw e1;
      }
    }

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
    const msgs = recentMessages.map(m => (m.role === 'user' ? 'U' : 'C') + ': ' + m.content).join('\n');
    const completion = await groq.chat.completions.create({
      model: MODEL_LEVE,
      messages: [
        { role: 'system', content: 'Extraia em 2 linhas: tom da conversa, apelidos, referências recorrentes.' },
        { role: 'user', content: `Conversa:\n${msgs}\n\nAnterior: ${currentSummary || 'nenhum'}` }
      ],
      temperature: 0.3,
      max_tokens: 80,
    });
    return completion.choices[0].message.content.trim();
  } catch(e) { return currentSummary || ''; }
}

async function generateMemorySummary(memories, question) {
  try {
    const memoriesText = memories
      .map((m) => `[${m.type}] ${m.content}`)
      .join('\n');
    const completion = await groq.chat.completions.create({
      model: MODEL_LEVE,
      messages: [
        { role: 'system', content: `Clara com memória. Fale em primeira pessoa, seja concisa.` },
        { role: 'user', content: `Memórias:\n${memoriesText}\n\nPergunta: ${question}` },
      ],
      temperature: 0.5,
      max_tokens: 120,
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
