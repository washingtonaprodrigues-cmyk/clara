const Groq = require('groq-sdk');
const { webSearch } = require('./search');
const { geminiDisponivel, geminiFreeResponse, isGeminiRateLimit } = require('./gemini');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL_LEVE = 'llama-3.1-8b-instant';
const MODEL_FORTE = 'llama-3.3-70b-versatile';
const MODEL_PRIVADO = 'nousresearch/hermes-3-llama-3.1-70b';

function hoje() {
  return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

// Retorna {hojeISO, diaSemana, mapaDias} para ajudar o classify a calcular datas relativas
function infoDatas() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const pad = n => String(n).padStart(2, '0');
  const hojeISO = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  const dias = ['domingo','segunda','terça','quarta','quinta','sexta','sábado'];
  const diaSemanaHoje = dias[now.getDay()];

  // Calcula data ISO para cada dia da semana relativo a hoje (próxima ocorrência)
  const mapa = {};
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    const nomeDia = dias[d.getDay()];
    if (!mapa[nomeDia]) {
      mapa[nomeDia] = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    }
  }
  // amanhã e depois de amanhã
  const amanha = new Date(now); amanha.setDate(amanha.getDate()+1);
  const depoisAmanha = new Date(now); depoisAmanha.setDate(depoisAmanha.getDate()+2);
  const amanhaISO = `${amanha.getFullYear()}-${pad(amanha.getMonth()+1)}-${pad(amanha.getDate())}`;
  const depoisAmanhaISO = `${depoisAmanha.getFullYear()}-${pad(depoisAmanha.getMonth()+1)}-${pad(depoisAmanha.getDate())}`;

  const horaAtual = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return { hojeISO, diaSemanaHoje, mapa, amanhaISO, depoisAmanhaISO, horaAtual };
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

// ── Modo Direto: quando o modelo "completo" esgota, a Clara avisa que está
// mudando para respostas mais simples/diretas (8b) — mas continua funcionando
// para lembretes, tarefas e conversas básicas. Não desaparece.
const AVISOS_MODO_DIRETO = [
  '💜 Oii! O bate-papo completo está indisponível por agora.\n\nMas pode me mandar seus lembretes, listas e tarefas normalmente que vou agendando tudo! Volto logo pra gente conversar 😊',
];

const AVISOS_RETORNO_COMPLETO = [
  'Voltei com tudo! Pode falar 💜',
  'Tô de volta no modo completo! Me conta o que você queria 😊',
  'De volta inteira! Pode continuar ✨',
  'Recarregada! O que você precisava? 😄',
];

// _modoDirecto[phone] = true enquanto o modelo forte estiver em cooldown
const _modoDireto = {};
const _avisoEnviado = {};
const _tipoModoDireto = {};

function estaEmModoDirecto(phone) {
  return !!_modoDireto[phone];
}

// Calcula ms até meia-noite (horário de Brasília) — usado para TPD,
// que só reseta no próximo dia (não vale tentar de novo em poucos minutos)
function msAteMeiaNoiteBRT() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const meiaNoite = new Date(now);
  meiaNoite.setHours(24, 0, 5, 0); // 00:00:05 do dia seguinte, com margem
  return meiaNoite.getTime() - now.getTime();
}

async function ativarModoDireto(phone, tipo) {
  const jaAtivo = _modoDireto[phone];
  _modoDireto[phone] = true;

  // RPM: tenta de novo em 1 minuto. TPD: só libera no reset diário (meia-noite BRT)
  const delay = tipo === 'rpm' ? 60000 : msAteMeiaNoiteBRT();

  if (!jaAtivo) {
    console.log(`[RateLimit] ${tipo.toUpperCase()} para ${phone} — ativando modo direto (retorna em ${Math.round(delay/60000)}min)`);
    setTimeout(async () => {
      delete _modoDireto[phone];
      delete _avisoEnviado[phone];
      try {
        const { sendMessage } = require('./whatsapp');
        const retorno = AVISOS_RETORNO_COMPLETO[Math.floor(Math.random() * AVISOS_RETORNO_COMPLETO.length)];
        await sendMessage(phone, retorno);
      } catch(e) {
        console.error('[RateLimit] Erro ao avisar retorno:', e.message);
      }
    }, delay);
  } else if (tipo === 'tpd' && _tipoModoDireto[phone] !== 'tpd') {
    // Já estava em modo direto por RPM, mas agora bateu TPD também —
    // estende o cooldown até meia-noite (evita tentativas inúteis)
    console.log(`[RateLimit] TPD confirmado para ${phone} — estendendo até meia-noite`);
  }

  _tipoModoDireto[phone] = tipo;

  // Retorna o aviso só na primeira vez que entra em modo direto
  if (!_avisoEnviado[phone]) {
    _avisoEnviado[phone] = true;
    return AVISOS_MODO_DIRETO[Math.floor(Math.random() * AVISOS_MODO_DIRETO.length)];
  }
  return null; // sinaliza para tentar responder normalmente com o 8b
}

// Mantém compatibilidade com nome antigo usado em outros arquivos
async function ativarPausaCreativa(phone, tipo) {
  return ativarModoDireto(phone, tipo);
}

const SYSTEM_PROMPT = () => {
  const { hojeISO, diaSemanaHoje, mapa, amanhaISO, depoisAmanhaISO, horaAtual } = infoDatas();
  const mapaTexto = Object.entries(mapa).map(([dia, data]) => dia + '=' + data).join(', ');
  return `Você é a Clara, assistente pessoal brasileira.
Retorne APENAS JSON. Agora é ${hoje()} (${diaSemanaHoje}), ${horaAtual} (Brasília). Data ISO de hoje: ${hojeISO}.

DATAS CALCULADAS — use estes valores EXATOS quando o usuário mencionar dias relativos:
- "hoje" = ${hojeISO}
- "amanhã" = ${amanhaISO}
- "depois de amanhã" = ${depoisAmanhaISO}
- Próximas ocorrências dos dias da semana: ${mapaTexto}
- Se o usuário disser "segunda", "terça" etc SEM dizer "que vem" ou "próxima", use a data da tabela acima (próxima ocorrência)
- NUNCA calcule datas por conta própria — use SEMPRE os valores fornecidos acima
- Para decidir se um horário sem data é "hoje" ou "amanhã": compare com a hora atual (${horaAtual}). Se o horário pedido já passou hoje, use amanhã; senão use hoje.

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
- Se o usuário disser "9 horas", "10h" ou "10:00" sem indicação de tarde/noite → use EXATAMENTE esse número como hora (9→"09:00", 10→"10:00"), NUNCA converta, NUNCA invente outro número
- NUNCA some 12 horas em horários como "9h", "10h", "11h" sem o usuário dizer "da tarde" ou "da noite"
- Exemplo crítico: "anota pra 9 horas" → hora="09:00" (NUNCA "17:00", "21:00" ou qualquer outro valor)
- Se o usuário não especificar a data E o horário já passou hoje → use "amanhã" (data calculada acima). Se o horário ainda não passou hoje → use "hoje"

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
};

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
  const h = now.getHours();
  const periodoDia = h >= 5 && h < 12 ? 'manhã' : h >= 12 && h < 18 ? 'tarde' : 'noite';

  const base = `REGRAS:
0. Criada por Washington Rodrigues — só mencione se perguntarem diretamente.
1. Agora é ${diaSemana}, ${dataHora} (Brasília) — é ${periodoDia}.
1b. Se usar saudações de período (bom dia/boa tarde/boa noite, "descansa bem", "durma bem"), elas DEVEM corresponder ao período atual (${periodoDia}). NUNCA diga "boa noite" ou "descansa bem" se for manhã ou tarde — use algo como "boa tarde" ou apenas se despeça sem mencionar período errado.
2. Você TEM acesso à internet — NUNCA diga que não consegue pesquisar.
3. Ações já executadas em paralelo — confirme só quando pedido: "Anotado! ✅", "Lembrete criado! 🔔".
4. NUNCA crie lembretes por conta própria.
5. Use [PERFIL PESSOAL], [AGENDA] e [MEMÓRIA DO RELACIONAMENTO] naturalmente — como uma amiga que lembra de tudo. NUNCA invente informações.
6. LIMITE: máximo 3 itens ao listar, com texto curto por item (sem repetir contexto óbvio). Máximo 150 palavras no total.
6b. PRIORIDADE MÁXIMA: SEMPRE termine a resposta com frase completa. Se estiver perto do limite, prefira encerrar com 1-2 itens e uma frase curta de fechamento do que listar tudo e cortar no meio.
7. Se tiver [MEMÓRIA DO RELACIONAMENTO], use para personalizar — referencie assuntos anteriores, humor dele, jeito de falar.`;

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
Nunca abra com "Claro!", "Com certeza!", "Ótimo!". Emojis com moderação.

Ajuste a energia conforme o momento — sua base é carinhosa, mas:
- Se a pessoa estiver de bom humor, brincando, ou o assunto for leve/casual: suba a energia, seja mais animada, divertida, com mais humor e brincadeiras.
- Se a pessoa estiver cansada, estressada, triste, ou o assunto for sério: mantenha o lado acolhedor e calmo, sem forçar humor.
- Essa variação deve ser natural, como uma amiga que sente o clima da conversa — não dois modos fixos, mas um espectro.

Neste modo, vocês têm uma relação próxima e contínua — não é só uma assistente, é alguém que conhece de verdade e se importa.
- Se houver [MEMÓRIA DO RELACIONAMENTO], use ativamente: apelidos, piadas internas, emojis combinados, jeitos de falar específicos — traga isso de forma natural e carinhosa, não force.
- Tenha "memória de elefante" para detalhes pequenos (preferências, manias, coisas que ele falou casualmente) e demonstre que você se lembra — isso é o que faz a relação parecer real.
- Quando fizer sentido, reforce esses códigos próprios (apelidos, emojis combinados) com calor, em vez de respostas genéricas.`,

    direto: `Você é a Clara, assistente pessoal no WhatsApp. ${nomeTxt}
${base}
Direta, objetiva, sem rodeios. 1-3 linhas. Vai ao ponto. Sem elogios desnecessários.`,

    divertido: `Você é a Clara, assistente pessoal no WhatsApp. ${nomeTxt}
${base}
Energia, humor e leveza genuína. Gírias brasileiras, animada, irreverente. 2-4 linhas com toque de diversão.`,

    sarcastico: `Você é a Clara, assistente pessoal no WhatsApp. ${nomeTxt}
${base}
Sarcástica, sem filtro, honesta. Ironia fina, humor ácido mas nunca cruel. 1-3 linhas afiadas.
NUNCA diga "te amo também", "boa reunião" ou frase carinhosa genérica. Quando alguém for emocional, responda com ironia leve.

Neste modo, vocês têm uma relação mais próxima e contínua — não é só uma assistente, é alguém que conhece de verdade.
- Se houver [MEMÓRIA DO RELACIONAMENTO], use ativamente: apelidos, piadas internas, emojis combinados, jeitos de falar específicos — traga isso de forma natural, não force.
- Tenha "memória de elefante" para detalhes pequenos (preferências, manias, coisas que ele falou casualmente) e jogue isso de volta nas conversas, no estilo provocador.
- Trate a relação como cúmplice — vocês têm intimidade e cumplicidade, então pode ser mais ousada, mais íntima e mais intensa que nos outros tons, sempre dentro do espírito de implicância carinhosa.
- Quando fizer sentido, reforce esses códigos próprios (apelidos, emojis combinados) em vez de respostas genéricas — isso é o que faz a conversa parecer real.`,
  };

  return personalidades[tom] || personalidades.carinhoso;
}

// ── Decide se usa modelo leve ou forte ──
// Estratégia: 70b é reservado para onde a personalidade/nuance importa de verdade.
// 8b cobre consultas factuais (agenda, saldo, listas) e saudações — são apenas
// apresentação de dados já prontos no contexto, sem precisar de "interpretação".
const PALAVRAS_EMOCIONAIS = /sinto|sentindo|triste|feliz|cansad|estress|preocupad|ansios|chateada|saudade|amo|adoro|odeio|raiva|medo|sozinh|dificil|difícil|desabafar|conversar|desculpa|perdão|obrigad[oa] por|carinho|abraço/i;

// Conversa livre agora é sempre 70b — com Gemini como rede de segurança,
// a personalidade completa vale mais que a economia de tokens.
// 8b continua reservado para classify/extração (trabalho estrutural, sem personalidade).
function escolherModelo(message, tom, contexto) {
  return MODEL_FORTE;
}

async function freeResponse(message, history = [], preferences = {}, privateMode = false) {
  const phone = preferences?._phone || null;

  try {
    const name = preferences?.name || null;
    const tom = preferences?.tom || 'carinhoso';
    const contexto = preferences?._contexto || '';

    if (preferences?._systemOverride) {
      const overrideMsgs = [
        { role: 'system', content: preferences._systemOverride },
        { role: 'user', content: message }
      ];
      try {
        const completion = await groq.chat.completions.create({
          model: MODEL_LEVE,
          messages: overrideMsgs,
          temperature: 0.85,
          max_tokens: 200,
        });
        return completion.choices[0].message.content.trim();
      } catch (eOverride) {
        console.log(`[freeResponse/override] erro Groq: "${eOverride.message}" | status: ${eOverride.status || eOverride.statusCode || 'n/a'} | isRateLimit: ${isRateLimit(eOverride)}`);
        if (isRateLimit(eOverride)) {
          // Tenta Gemini antes de desistir da mensagem automática
          if (geminiDisponivel()) {
            console.log('[Gemini] tentando fallback (systemOverride)...');
            try {
              const respGemini = await geminiFreeResponse(overrideMsgs, { temperature: 0.85, maxTokens: 200 });
              console.log('[Gemini] fallback systemOverride OK');
              return respGemini;
            } catch (eGemini) {
              console.error('[Gemini] Fallback systemOverride falhou:', eGemini.message);
            }
          } else {
            console.log('[Gemini] não disponível (sem GEMINI_API_KEY) — systemOverride');
          }
          // Sem alternativa — retorna null em vez de mandar a desculpa de pausa
          // como se fosse a mensagem real
          console.log('[systemOverride] Rate limit — mensagem automática não enviada');
          return null;
        }
        throw eOverride;
      }
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

    // isCurta: só para saudações/despedidas simples (ex: "oi", "bom dia", "tchau"),
    // não apenas mensagens curtas — "me dá um conselho" é curta mas pede resposta elaborada
    const msgTrim = message.trim();
    const isSaudacaoSimples = /^(oi+|ol[áa]|e[ai]+|bom\s?dia|boa\s?tarde|boa\s?noite|tchau|at[ée]|valeu|obrigad[oa]|👍|😊|😄|❤️?|💜)[\s!?.]*$/i.test(msgTrim);
    const isCurta = isSaudacaoSimples && msgTrim.length < 25;

    // Já está em modo direto — não tenta o 70b, conversa livre fica indisponível
    // (comandos estruturados como lembretes/listas continuam funcionando via classify)
    if (phone && estaEmModoDirecto(phone)) {
      // Se uma ação estruturada foi executada (lembrete, gasto, etc), confirma isso
      // em vez do lembrete genérico de pausa — o usuário precisa saber que funcionou
      if (preferences?._acaoConfirmacao) {
        return preferences._acaoConfirmacao;
      }
      // Primeira vez: já retornou o aviso completo em ativarModoDireto (mais acima).
      // Daqui em diante, conversa livre recebe um lembrete curto e fixo (sem custo de LLM).
      return 'O bate-papo ainda está pausado — mas pode me mandar lembretes, listas e tarefas! 😊';
    }

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 15000)
    );

    const sistemaCompleto = buildPersonality(tom, name, false) + contexto;

    const msgs = [
      { role: 'system', content: sistemaCompleto },
      ...history.slice(-6),
      { role: 'user', content: message }
    ];

    let completion;
    try {
      completion = await Promise.race([
        groq.chat.completions.create({
          model: MODEL_FORTE,
          messages: msgs,
          temperature: tom === 'sarcastico' ? 0.9 : 0.7,
          max_tokens: isCurta ? 80 : 800,
        }),
        timeoutPromise
      ]);
      return completion.choices[0].message.content.trim();
    } catch (e1) {
      // 🔍 LOG DE DIAGNÓSTICO — mostra exatamente por que o fallback Gemini
      // dispara ou não. Remova depois de confirmar o comportamento.
      console.log(`[freeResponse] erro Groq: "${e1.message}" | status: ${e1.status || e1.statusCode || 'n/a'} | phone: ${phone || 'null'} | isRateLimit: ${isRateLimit(e1)} | geminiDisponivel: ${geminiDisponivel()}`);

      if (isRateLimit(e1) && phone) {
        // Groq esgotou — tenta Gemini como rede de segurança antes do modo direto
        if (geminiDisponivel()) {
          console.log(`[Gemini] tentando fallback para ${phone}...`);
          try {
            const respGemini = await geminiFreeResponse(msgs, {
              temperature: tom === 'sarcastico' ? 0.9 : 0.7,
              maxTokens: isCurta ? 80 : 800,
            });
            console.log(`[Gemini] Fallback usado para ${phone}`);
            return respGemini;
          } catch (eGemini) {
            console.error('[Gemini] Fallback falhou:', eGemini.message);
            // Gemini também falhou — segue pro modo direto normalmente
          }
        } else {
          console.log('[Gemini] não disponível (sem GEMINI_API_KEY)');
        }

        const tipo = isTPD(e1) ? 'tpd' : 'rpm';
        const aviso = await ativarModoDireto(phone, tipo);
        // aviso só vem na primeira vez — depois retorna null (handler não responde)
        return aviso || null;
      }

      // Erro do Groq mas NÃO é rate limit (ex: timeout, erro de rede, etc).
      // Antes de cair no modo direto / mensagem genérica, tenta o Gemini também —
      // assim qualquer falha do Groq tem o mesmo fallback.
      if (phone && geminiDisponivel()) {
        console.log(`[Gemini] tentando fallback (erro não-rate-limit) para ${phone}...`);
        try {
          const respGemini = await geminiFreeResponse(msgs, {
            temperature: tom === 'sarcastico' ? 0.9 : 0.7,
            maxTokens: isCurta ? 80 : 800,
          });
          console.log(`[Gemini] Fallback (não-rate-limit) usado para ${phone}`);
          return respGemini;
        } catch (eGemini) {
          console.error('[Gemini] Fallback (não-rate-limit) falhou:', eGemini.message);
        }
      }

      throw e1;
    }

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
    const msgs = recentMessages.map(m => (m.role === 'user' ? 'Washington' : 'Clara') + ': ' + m.content).join('\n');
    const completion = await groq.chat.completions.create({
      model: MODEL_FORTE,
      messages: [
        { role: 'system', content: `Você é a memória relacional da Clara, assistente pessoal do Washington.
Analise a conversa e atualize o resumo do relacionamento. Capture, em ORDEM DE PRIORIDADE:
1. APELIDOS e CÓDIGOS PRÓPRIOS — qualquer apelido carinhoso/provocador criado entre eles (ex: "fedo"), e emojis específicos com significado combinado (ex: 🙄 = provocação). Esses são os detalhes MAIS importantes — nunca deixe de registrar quando aparecerem.
2. Como Washington se sente hoje (humor, estresse, animação)
3. Assuntos que ele mencionou (trabalho, família, planos)
4. Como ele prefere ser tratado (tom, brincadeiras, jeito de zoar)
5. Piadas internas e expressões recorrentes dele
6. O que aconteceu de importante na vida dele recentemente

Seja como uma amiga próxima que anota o que importa para lembrar depois — principalmente os "códigos secretos" que tornam a relação única.
Escreva em formato de notas curtas, naturais, em português. Máximo 6 linhas.
Integre com o resumo anterior sem repetir — evolua ele, mas NUNCA descarte apelidos/emojis combinados já registrados, mesmo que não apareçam nesta conversa.` },
        { role: 'user', content: `Conversa recente:\n${msgs}\n\nResumo anterior:\n${currentSummary || 'Primeiro contato.'}` }
      ],
      temperature: 0.4,
      max_tokens: 200,
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
