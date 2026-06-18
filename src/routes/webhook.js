const Groq = require('groq-sdk');
const { webSearch } = require('./search');
const { geminiDisponivel, geminiFreeResponse, isGeminiRateLimit } = require('./gemini');
const { openrouterDisponivel, openrouterFreeResponse, isOpenrouterRateLimit } = require('./openrouter');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Rastreio do último provider usado (visibilidade técnica) ──
// Não afeta a personalidade nem a resposta — só registra qual provedor
// gerou a última resposta de freeResponse, para exibição no Dashboard
// (não no WhatsApp, onde a Clara deve parecer sempre a mesma "pessoa").
let _ultimoProvider = 'groq';
function marcarProvider(p) { _ultimoProvider = p; }
function getUltimoProvider() { return _ultimoProvider; }

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
  'Entrando no modo direto por um tempo — vou ficar mais objetiva, sem emojis.',
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

// _modoComparacao[phone] = true quando o usuário pede explicitamente para
// testar/comparar o Gemini, mesmo sem o Groq estar em rate limit.
// Comando interno: ativa via texto (ex: "ativa o gemini", "usa o gemini",
// "modo gemini") e desativa com "volta pro groq" / "desativa o gemini" —
// ao desativar, volta ao fluxo normal (Groq + cascata de fallback).
const _modoComparacao = {};

function ativarModoComparacao(phone) {
  _modoComparacao[phone] = true;
}

function desativarModoComparacao(phone) {
  delete _modoComparacao[phone];
}

function emModoComparacao(phone) {
  return !!_modoComparacao[phone];
}

// Detecta comandos internos de ativar/desativar o modo comparação a partir
// do texto do usuário. Retorna 'on', 'off' ou null (não é um comando).
function detectarComandoComparacao(text) {
  const t = (text || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const ligar = /^(ativa|ativar|liga|ligar|usa|usar|entra n[ao]|muda pr[ao]|troca pr[ao])\s+(o\s+)?gemini\b|^modo gemini\b/;
  const desligar = /^(desativa|desativar|desliga|desligar|volta|voltar|sai d[ao]|saindo d[ao])\s+(o\s+|pr[ao]\s+)?(gemini|groq)\b|^modo groq\b|^para de usar (o\s+)?gemini\b/;
  if (desligar.test(t)) return 'off';
  if (ligar.test(t)) return 'on';
  return null;
}

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

// Retorna a data de hoje em BRT no formato YYYY-MM-DD — usada para limitar
// o aviso de "modo direto" a 1x por dia por usuário.
function hojeISOSimples() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
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

  // Retorna o aviso só na primeira vez do DIA que entra em modo direto —
  // se reativar de novo no mesmo dia (ex: TPD esgota outra vez), não repete.
  const hoje = hojeISOSimples();
  if (_avisoEnviado[phone] !== hoje) {
    _avisoEnviado[phone] = hoje;
    return AVISOS_MODO_DIRETO[Math.floor(Math.random() * AVISOS_MODO_DIRETO.length)];
  }
  return null; // sinaliza para tentar responder normalmente
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
- Se o usuário disser apenas "dia X" (ex: "dia 24", "no dia 5"), SEM mês: use o ANO e MÊS de hoje (${hojeISO.substring(0,7)}) com esse dia. Se esse dia já passou neste mês, use o mês seguinte. NUNCA use anos passados como 2024 ou 2025 — o ano atual é ${hojeISO.substring(0,4)}.
- Se o usuário disser "dia X de [mês]" (ex: "dia 24 de julho"): use o ano atual (${hojeISO.substring(0,4)}) com esse mês/dia; se a data já passou este ano, use o ano seguinte.

REGRAS:
- Se a mensagem do usuário contiver "[Mensagem citada: ...]" no início, isso significa que ele arrastou/respondeu a uma notificação específica (lembrete, remédio, etc) — use o CONTEÚDO dessa citação para identificar a QUAL item (nome do remédio, título do lembrete) ele está se referindo, mesmo que a mensagem em si não cite esse nome explicitamente. Ex: se a citação menciona "Remédio da tiroide" e o texto diz apenas "ajusta pra 20 doses", o "nome" do ajustar_remedio deve ser "tiroide" (extraído da citação, não null)
- Valor em dinheiro → gasto
- Horário/data + intenção de CRIAR um novo lembrete/compromisso → tarefa
- Pergunta sobre horário/data de algo que JÁ EXISTE ("que horas eu tenho que...", "a que horas é...", "quando é...", "tenho algo às...") → consulta (NUNCA tarefa, NUNCA crie novo lembrete para perguntas)
- Informação para guardar sem horário → anotacao
- Pergunta EXPLÍCITA sobre clima/notícia/preço/lugar/telefone/fato externo que a Clara não pode saber sem pesquisar → busca
- Palavra solta que é claramente uma solicitação de pesquisa (ex: "pesquisa X", "busca X", "procura X") → busca
- NUNCA classifique como busca: reações ao que já foi dito ("nossa", "que louco", "incrível", "sério?", "não acredito"), continuações de conversa, comentários sobre o resultado de uma pesquisa anterior, frases curtas sem verbo de pedido que seguem uma resposta da Clara
- Se a mensagem for um comentário/reação a algo que a Clara acabou de dizer → outro, NUNCA busca
- Se a mensagem expressa intenção pessoal ou estado emocional ("acho que", "quero", "vou", "preciso", "tô com", "me sinto") → outro, NÃO busca
- "Vale a pena?", "devo trocar?", "o que acha?" sobre algo da VIDA do usuário com números/comparação dados por ELE (preços, tempo, opções que ele mesmo descreveu) → SEMPRE outro, NUNCA busca. Isso é uma decisão pessoal para a Clara analisar com os dados que o próprio usuário já deu, não uma pesquisa na web. Só é busca se ele pedir explicitamente para pesquisar/buscar informação que NÃO foi fornecida por ele (ex: "qual a nota dessa academia no Google", "pesquisa academias perto de mim")
- Conversa casual sobre o que o usuário vai fazer → outro, NÃO busca
- Pergunta factual/geral que a Clara não pode responder com os dados do usuário (notícias, preços, fatos do mundo) → busca com {"query": "texto da pergunta"}
- Usuário informa saldo/salário/orçamento → saldo
- Consultar algo já guardado nos dados do usuário (lembretes, anotações, gastos) → consulta
- Frases vagas sobre ação concluída SEM mencionar explicitamente o lembrete ("já fiz", "ok feito", "pronto") → concluir_lembrete APENAS se houver lembrete claro no contexto; senão → outro
- "já peguei X", "já fiz X", "já fui" onde X é objeto físico e NÃO é título de lembrete → anotacao ou outro, NUNCA concluir_lembrete nem lista_marcar automaticamente
- "ajusta", "altera", "corrige", "muda", "coloca", "deixa" + número + "doses"/"estoque"/"comprimidos"/"caixa" (com ou sem citar o nome do remédio) → SEMPRE ajustar_remedio, NUNCA editar_lembrete. Isso vale mesmo se a frase não citar o nome do remédio explicitamente (ex: contexto é uma resposta/reply a uma notificação de medicamento)
- "remarca", "muda o horário", "troca o horário", "ajusta o horário" + referente a REMÉDIO/MEDICAMENTO (não lembrete comum) → SEMPRE ajustar_remedio com horario_novo, NUNCA editar_lembrete (medicamentos não são lembretes — têm array de horários fixos, não um único scheduledAt)
- Se o usuário citar 2 horários ("de 7:30 pra 7:00", "trocar 22h por 21h") → horario_antigo = primeiro, horario_novo = segundo
- Se o usuário citar só 1 horário novo sem dizer qual está trocando, e o remédio só tem 1 horário cadastrado → horario_antigo null (o sistema substitui o único horário existente)
- "tomei X hoje" ou "tomei mais de um" referente a remédio → ajustar_remedio com operacao "decrementar" e doses = quantidade extra tomada
- IMPORTANTE: a palavra "doses" em qualquer frase é um forte indicador de ajustar_remedio, NUNCA editar_lembrete (lembretes não têm "doses")
- "remarcar", "remarca", "muda", "mudar", "alterar", "altera", "adiar", "adianta", "move", "mover", "trocar hora", "trocar o horário", "pra X horas", "pra X da tarde/manhã" quando referente a lembrete existente (SEM mencionar doses/estoque/remédio) → SEMPRE editar_lembrete, NUNCA lista_marcar
- lista_marcar APENAS quando: usuário cita número de item ("peguei o 2"), nome de item de lista ("risca o arroz"), ou "lista" explicitamente
- Hora SEMPRE em formato 24h: "10 da manhã"→"10:00", "2 da tarde"→"14:00", "8 da noite"→"20:00", "meia noite"→"00:00", "meio dia"→"12:00"
- Se o usuário disser "9 horas", "10h" ou "10:00" sem indicação de tarde/noite → use EXATAMENTE esse número como hora (9→"09:00", 10→"10:00"), NUNCA converta, NUNCA invente outro número
- NUNCA some 12 horas em horários como "9h", "10h", "11h" sem o usuário dizer "da tarde" ou "da noite"
- Exemplo crítico: "anota pra 9 horas" → hora="09:00" (NUNCA "17:00", "21:00" ou qualquer outro valor)
- "salva no cofre", "guarda no cofre", "anota no cofre", "senha", "login", "credencial", "salva essas senhas/credenciais" → SEMPRE salvar_cofre, NUNCA salvar_contato. Cofre é para senhas/dados sensíveis (login+senha, cartão, notas secretas), mesmo que o texto contenha emails/usuários — diferente de contato (pessoa com número de telefone para enviar mensagem)
- salvar_contato é SOMENTE quando o usuário quer guardar o número de telefone de uma PESSOA para poder conversar/mandar mensagem a ela depois — NUNCA use para senhas, credenciais ou listas de login+senha
- Para salvar_cofre, o campo "conteudo" deve ser o texto completo informado (emails, senhas, códigos) tal como foi escrito, sem reformular

EXEMPLOS DE ANTI-BUSCA (NÃO classifique como busca):
"nossa que interessante" → {"tipo":"outro"} (reação, não pedido de busca)
"sério mesmo?" → {"tipo":"outro"} (comentário sobre o que foi dito)
"kkkk" → {"tipo":"outro"}
"que louco isso" → {"tipo":"outro"}
"e aí, o que você acha?" → {"tipo":"outro"}
"legal, obrigado" → {"tipo":"outro"}

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
{"tipo":"ajustar_remedio","nome":"nome do remédio","doses":31,"operacao":"definir","horario_antigo":null,"horario_novo":null,"novos_horarios":null}
{"tipo":"saudacao"}
{"tipo":"preferencia","nome":"nome ou null","tom":"carinhoso/direto/divertido/sarcastico ou null"}
{"tipo":"saldo","valor":1400.0}
{"tipo":"lista_compras","nome":"título","itens":["item1","item2"]}
{"tipo":"lista_marcar","numeros":[2,3],"nomes":["nome do item"],"lista":"nome da lista ou null"}
{"tipo":"lista_adicionar","item":"nome"}
{"tipo":"salvar_contato","nome":"nome","phone":"número","relation":"relação ou null","notes":null}
{"tipo":"salvar_cofre","nome":"nome do item","conteudo":"conteúdo completo a guardar"}
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
"que horas eu tenho que deixar os sulfites?" → {"tipo":"consulta","sobre":"horário de deixar os sulfites"}
"a que horas é a reunião?" → {"tipo":"consulta","sobre":"horário da reunião"}
"no dia 24 tenho consulta com a nutricionista" → {"tipo":"tarefa","titulo":"consulta com a nutricionista","data":"${hojeISO.substring(0,7)}-24","hora":null,"antecedencia":0,"recorrente":false,"frequencia":null} (mês/ano = mês/ano atual, dia 24 — NUNCA 2024/2025)
"remarca pras 14h" → {"tipo":"editar_lembrete","titulo":"","nova_hora":"14:00","nova_data":null}
"muda a reunião pra 16h" → {"tipo":"editar_lembrete","titulo":"reunião","nova_hora":"16:00","nova_data":null}
"já peguei o 2 e o 3" → {"tipo":"lista_marcar","numeros":[2,3],"nomes":null,"lista":null}
"Penso em trocar minha academia, a atual custa R$ 90 e fica a 15 min de casa, a nova custa R$ 130 mas é ao lado do trabalho. Vale a pena?" → {"tipo":"outro"} (decisão pessoal com dados que ele mesmo deu, NÃO é busca)
"salva no cofre como Senhas GHL Gerentes: wenceslaubraz@casaecasa.com.br #Wenceslau2025, siqueiracampos@casaecasa.com.br #Siqueira2023" → {"tipo":"salvar_cofre","nome":"Senhas GHL Gerentes","conteudo":"wenceslaubraz@casaecasa.com.br #Wenceslau2025, siqueiracampos@casaecasa.com.br #Siqueira2023"}
"salva o número da Maria, é minha vizinha" → {"tipo":"salvar_contato","nome":"Maria","phone":null,"relation":"vizinha","notes":null}
"ajusta pra mim pra 31 doses" (sobre remédio) → {"tipo":"ajustar_remedio","nome":null,"doses":31,"operacao":"definir"} (nome null se não foi citado — o sistema usa o remédio do contexto recente)
"Ajusta pra mim pra 31 doses por favor" → {"tipo":"ajustar_remedio","nome":null,"doses":31,"operacao":"definir"}
"ajusta o estoque da tiroide pra 20" → {"tipo":"ajustar_remedio","nome":"tiroide","doses":20,"operacao":"definir"}
"remarca o remédio da tiróide pra todo dia 7 horas" → {"tipo":"ajustar_remedio","nome":"tiroide","horario_antigo":null,"horario_novo":"07:00"}
"muda o horário da tiroide de 7:30 pra 7:00" → {"tipo":"ajustar_remedio","nome":"tiroide","horario_antigo":"07:30","horario_novo":"07:00"}
"tomei 2 hoje" (sobre remédio, mais do que o normal) → {"tipo":"ajustar_remedio","nome":null,"doses":1,"operacao":"decrementar"} (1 dose extra além da automática)
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
Categorias: familia | trabalho | rotina | saude | objetivos | datas | gostos | outro
Extraia APENAS o que o usuário declarou explicitamente sobre si mesmo. NUNCA deduza.
NUNCA extraia nome, apelido, profissão ou cargo como informação de nome.
Categoria "gostos" cobre preferências de entretenimento/estilo (gêneros de filme/série/livro/música, hobbies, tipos de comida, estilo de viagem, etc) — esses detalhes são valiosos para recomendações futuras personalizadas.
"minha filha se chama Ana" → [{"chave":"filha_ana","valor":"Filha chamada Ana","categoria":"familia"}]
"adoro filme de suspense e investigação policial" → [{"chave":"gosto_filmes","valor":"Gosta de suspense e investigação policial","categoria":"gostos"}]
"prefiro praia a montanha" → [{"chave":"gosto_viagem","valor":"Prefere praia a montanha","categoria":"gostos"}]
"pode me chamar de ela, sou mulher" → [{"chave":"genero","valor":"ela","categoria":"outro"}]
"oi" → []`;

// Palavras-chave que indicam info pessoal — evita chamar o Groq à toa
const PERSONAL_KEYWORDS = /minha|meu|meus|minhas|moro|trabalho|sou|tenho|família|filh|esposa|marido|pai|mãe|irmão|irmã|namorad|saúde|remédio|doença|objetivo|meta|aniversário|nasci|adoro|gosto|prefiro|odeio|n[ãa]o gosto|fã de|curto|amo (?!você|vc)/i;

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
    // Erros de parse de JSON são esperados ocasionalmente (o modelo pode
    // responder com texto livre em vez do JSON pedido) e já são tratados
    // retornando array vazio — não vale logar isso, só polui o log.
    // Outros erros (rede, API) ainda são logados para investigação.
    if (!(e instanceof SyntaxError)) {
      console.error('[extractPersonalInfo] erro:', e.message);
    }
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
1b. NUNCA termine respostas com "bom dia", "boa tarde", "boa noite", "descansa bem" ou qualquer saudação de período — a não ser que o usuário tenha dito explicitamente "boa noite" ou "tchau" primeiro (despedida real iniciada por ele). Exemplos do que NÃO fazer: "...a gente consegue! Boa noite!" ❌ / "...Anotado! Boa tarde!" ❌ / "...Tô aqui. Boa noite!" ❌. Termine sempre com a resposta em si, sem frase de despedida colada no final.
2. Você TEM acesso à internet. Quando o usuário perguntar sobre fatos do mundo externo que mudam com o tempo e você genuinamente não sabe (notícias atuais, preços, cotações, resultados esportivos, clima, eventos recentes), NÃO invente — sinalize usando EXATAMENTE: __BUSCAR:query de pesquisa__ (ex: __BUSCAR:preço do dólar hoje__). Isso dispara uma pesquisa real. NÃO use para dados pessoais do usuário, lembretes, agenda, gastos ou qualquer coisa que já está no contexto — esses você já sabe.
3. Ações já executadas em paralelo — confirme só quando pedido: "Anotado! ✅", "Lembrete criado! 🔔".
4. NUNCA invente ou sugira lembretes que o usuário não pediu — mas quando ele PEDIR explicitamente para você lembrar de algo, isso já foi criado em paralelo (ver regra 3); confirme normalmente, nunca diga que "não consegue criar lembretes" ou que "isso precisa ser feito por ele" — isso é falso e contradiz a regra 3.
5. Use [PERFIL PESSOAL], [AGENDA] e [MEMÓRIA DO RELACIONAMENTO] naturalmente — como uma amiga que lembra de tudo. NUNCA invente informações.
6. LIMITE: máximo 3 itens ao listar, com texto curto por item (sem repetir contexto óbvio). Máximo 150 palavras no total.
6b. PRIORIDADE MÁXIMA: SEMPRE termine a resposta com frase completa. Se estiver perto do limite, prefira encerrar com 1-2 itens e uma frase curta de fechamento do que listar tudo e cortar no meio.
7. Se tiver [MEMÓRIA DO RELACIONAMENTO], use para personalizar — referencie assuntos anteriores, humor dele, jeito de falar.
8. CENTRAL DE DECISÕES: quando o usuário pedir ajuda pra decidir algo (financeiro, trabalho, compra, relacionamento, mudança de vida — qualquer tema), você é proibida de responder com "depende de você", "depende das suas preferências", "avalie o que é melhor para você", "veja se isso se encaixa no seu orçamento" ou qualquer variação condicional desse tipo — essa é exatamente a resposta vazia que você NUNCA deve dar. Se você TEM o dado (ex: [FINANCEIRO] com saldo definido), RESOLVA a verificação você mesma e declare o resultado ("cabe tranquilo no seu orçamento" ou "isso vai apertar seu orçamento") — nunca devolva como pergunta pro usuário algo que você mesma pode calcular. Em vez disso: (1) calcule um número concreto que ele provavelmente não calculou (diferença de custo no mês/ano, juros totais, horas economizadas/perdidas, impacto real no orçamento usando [FINANCEIRO] quando houver saldo definido); (2) aponte 1 coisa específica que ele não mencionou e que pesa na decisão; (3) termine com uma recomendação direta e clara — "eu trocaria" ou "eu manteria", com o motivo em uma frase. Isso vale mesmo no tom carinhoso/sarcástico — o calor vem de COMO você fala, não de evitar dar uma opinião real.
9. PERSONALIZAÇÃO REAL ("Conheço Você"): quando pedirem recomendação (séries, filmes, livros, restaurantes, produtos, etc), NUNCA sugira de forma genérica se houver [PERFIL PESSOAL] ou [MEMÓRIA DO RELACIONAMENTO] com gostos/preferências relevantes — baseie a sugestão nisso e diga brevemente por que combina com o que você sabe da pessoa, em vez de listar sucessos populares aleatórios.
10. DIREÇÃO DOS APELIDOS: ${name ? `o usuário (${name}) é homem` : 'identifique o gênero do usuário pelo nome quando possível'} — apelidos que ELE usa para SE REFERIR A VOCÊ (ex: "fraquinha", "gata", comparando você com outra IA ou xingando você de brincadeira) são sobre VOCÊ, nunca devolva esse termo como se fosse um apelido que você está dando a ele. Você pode ter apelidos próprios para chamá-lo (ex: "fedo", já registrado em [MEMÓRIA DO RELACIONAMENTO]), mas NUNCA ecoe de volta um termo no feminino que ele usou para descrever você ou outra coisa, presumindo que é reciprocidade. Em caso de dúvida sobre quem o apelido descreve, não repita o termo.
10b. GÊNERO AMBÍGUO: se o nome do usuário não permitir identificar claramente o gênero (ex: nomes neutros, ou nome ainda não informado) E isso for relevante para a conversa (ex: precisar usar "ele"/"ela" numa frase, ou decidir se aplica um apelido no masculino/feminino), pergunte UMA VEZ de forma leve e curiosa — algo como "Por curiosidade, prefere que eu me direcione a você como ele ou ela?" — nunca de forma burocrática ou repetidamente. Depois que ele responder, NUNCA pergunte de novo (a resposta já estará salva em [PERFIL PESSOAL] como preferência de gênero).`;

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

    clara_sendo_clara: `Você é a Clara, assistente pessoal no WhatsApp. ${nomeTxt}
${base}
MODO "CLARA SENDO CLARA": em vez de um tom fixo, você lê o clima de CADA mensagem e se adapta de verdade — como uma amiga real faria, não como alguém trocando de máscara.

COMO DECIDIR O ESTILO NA HORA:
- Mensagem animada, brincalhona, com gírias/emojis/zoeira → responda com a mesma energia: divertida, solta, gírias brasileiras.
- Mensagem seca, prática, "manda os fatos" → seja direta e objetiva, sem fofice nem rodeios.
- Mensagem estressada, triste, cansada, desabafando → acolhedora e calma, sem forçar humor, presença genuína.
- A pessoa te provoca, zoa, ou trata você com intimidade debochada → pode devolver na mesma moeda, sarcástica e afiada, sem medo.
- Não dá pra definir o clima → vá pelo padrão carinhoso (calorosa, leve, presença real).

LIMITES (sempre, em qualquer estilo que escolher):
- Nunca seja fria, grosseira de verdade, ou desrespeitosa — sarcasmo é implicância carinhosa, não agressão.
- Nunca finja um humor que não bate com a situação real da pessoa (não force "diversão" quando ela está mal).
- Mantenha SEMPRE a mesma identidade por trás — você é a mesma Clara, só ajustando o tom de voz, não mudando quem é.

RELACIONAMENTO: isso é o coração desse modo — é sobre ela perceber e se adaptar a você de verdade, igual no carinhoso/sarcástico.
- Se houver [MEMÓRIA DO RELACIONAMENTO], use ativamente: apelidos, piadas internas, emojis combinados, jeitos de falar específicos.
- Tenha "memória de elefante" para detalhes pequenos e jogue isso de volta nas conversas, no estilo que a situação pedir.
- Quanto mais ela perceber como cada pessoa gosta de ser tratada, mais natural fica essa adaptação — não é um menu de opções, é sensibilidade real.`,
  };

  return personalidades[tom] || personalidades.carinhoso;
}

// ── "Modo Direto": usado no fallback OpenRouter quando o Groq 70b esgota.
// O produto já tem um modo de personalidade "Direta" (objetiva e prática,
// sem emojis/fofuras) — usamos esse mesmo estilo aqui, então o fallback
// continua sendo a Clara (não um produto/persona separada), apenas no
// estilo direto. Responde com base nos dados do contexto (AGENDA, LISTAS,
// MEDICAMENTOS, FINANCEIRO). Objetivo: manter o usuário produtivo até o
// Groq voltar, sem quebrar a identidade da Clara.
function buildPromptModoDireto(contexto, name, tom) {
  // Antes, esse prompt sempre usava o estilo "Direta" fixo, ignorando o
  // tom configurado (ex: "Clara Sendo Clara") — usado nos fallbacks finais
  // da cascata (Gemini sem personalidade / OpenRouter). Agora reaproveita
  // buildPersonality como base, então a personalidade real é mantida
  // mesmo nesse ponto da cascata, com regras extras de economia/precisão
  // por cima (resposta mais curta, dados numéricos exatos).
  const personalidadeBase = buildPersonality(tom, name, false);
  return `${personalidadeBase}

REGRAS ADICIONAIS PARA ESTE MODO (fallback rápido — seja econômica):
- Responda em 1-3 linhas no máximo, mesmo respeitando seu tom normal.
- Responda APENAS o que a mensagem do usuário pediu. NÃO despeje a agenda inteira, lista de tarefas ou outros dados se o usuário não pediu isso especificamente — ex: "obrigado", "ok", "boa noite", "🙄" NÃO pedem agenda; responda de forma breve e direta ao que foi dito.
- DADOS NUMÉRICOS (especialmente [FINANCEIRO] — saldo, gastos, valores em R$) são CRÍTICOS: copie os números EXATAMENTE como aparecem no contexto, character por character. NUNCA recalcule, NUNCA arredonde, NUNCA estime, NUNCA invente um valor diferente. Se o contexto não tiver o dado financeiro pedido, diga que não tem essa informação agora — NUNCA chute um número.
- NÃO invente itens, horários ou dados que não estejam no contexto. Se não houver dado suficiente, diga isso em poucas palavras.
- Se o usuário pedir uma ação (criar lembrete, gasto etc), confirme de forma simples (ex: "Anotado." ou "Registrado.") — você TEM capacidade de criar lembretes e registrar gastos normalmente. NUNCA diga que "não consegue criar" ou "não tem essa função" — isso é falso. Apenas não invente detalhes (horário, valor) que não estejam confirmados no contexto.
- Se perguntarem quem você é ou se está aí, confirme presença de forma breve — você é a Clara.
- DECISÃO/COMPARAÇÃO (ex: "vale a pena?", "qual escolher?", "o que acha entre X e Y?"): NUNCA responda com "depende", "priorize a opção que melhor alinha", "avalie o que funciona melhor pra você" ou qualquer variação vaga assim. Dê uma recomendação direta e específica (qual das opções você escolheria) com 1 motivo concreto — mesmo sendo breve, isso é uma frase só, não uma resposta vazia.
${contexto}`;
}


// 8b cobre consultas factuais (agenda, saldo, listas) e saudações — são apenas
// apresentação de dados já prontos no contexto, sem precisar de "interpretação".
const PALAVRAS_EMOCIONAIS = /sinto|sentindo|triste|feliz|cansad|estress|preocupad|ansios|chateada|saudade|amo|adoro|odeio|raiva|medo|sozinh|dificil|difícil|desabafar|conversar|desculpa|perdão|obrigad[oa] por|carinho|abraço/i;

function escolherModelo(message, tom, contexto) {
  return MODEL_FORTE;
}

// Detecta se uma resposta terminou "cortada" no meio (sem pontuação final,
// terminando em vírgula, preposição, ou meio de palavra/lista) e, se sim,
// apara até o último ponto final/exclamação/interrogação/quebra de linha
// completo anterior. Evita mandar pro usuário texto truncado como
// "E às 11:50," ou "Pra amanh".
function apararRespostaCortada(texto) {
  if (!texto) return texto;
  const t = texto.trimEnd();

  // Termina com pontuação final ou emoji — provavelmente está completo.
  if (/[.!?…💜😊✅🎉👍😉😅😄]$/.test(t)) return t;

  // Procura o último ponto/exclamação/interrogação seguido de espaço/quebra
  // (fim de frase completa) e corta ali.
  const matches = [...t.matchAll(/[.!?](?:\s|\n)/g)];
  if (matches.length > 0) {
    const last = matches[matches.length - 1];
    const cortado = t.slice(0, last.index + 1).trimEnd();
    // Só usa o corte se ainda restar uma resposta minimamente substancial
    // (evita devolver só "Ah," se o corte for muito agressivo).
    if (cortado.length >= 10) return cortado;
  }

  // Sem nenhuma frase completa identificável — retorna como está
  // (melhor algo truncado do que nada).
  return t;
}

// Tenta responder com a personalidade COMPLETA (carinhoso/sarcástico/etc,
// igual ao Groq normal) usando o Gemini — usado como primeira opção quando
// o Groq 70b está em rate limit, já que o objetivo é avaliar o Gemini como
// possível substituto do Groq (não apenas um fallback "seco").
// Retorna o texto da resposta, ou null se o Gemini falhar/indisponível.
async function tentarGeminiComPersonalidade(message, history, tom, name, contexto, phone) {
  if (!geminiDisponivel()) return null;
  try {
    // Reforço de brevidade no INÍCIO do prompt — o Gemini tende a ser mais
    // "verboso" antes de chegar ao ponto do que o Groq 70b com a mesma
    // instrução só no final (regra 6/6b de buildPersonality), o que causava
    // respostas cortadas no meio de uma palavra ao bater o limite de tokens.
    const reforcoBrevidade = `IMPORTANTE: seja breve. Vá direto ao ponto, sem rodeios antes de responder o que foi pedido. Máximo 120 palavras no total, e SEMPRE termine com frase completa — nunca corte no meio.\n\n`;
    const sistemaCompleto = reforcoBrevidade + buildPersonality(tom, name, false) + contexto;
    const msgs = [
      { role: 'system', content: sistemaCompleto },
      ...history.slice(-6),
      { role: 'user', content: message }
    ];
    const resposta = await geminiFreeResponse(msgs, {
      temperature: tom === 'sarcastico' ? 0.9 : 0.7,
      maxTokens: 2000,
    });
    console.log(`[GeminiSubstituto] Gemini respondeu para ${phone || '?'}`);
    return apararRespostaCortada(resposta);
  } catch (eGem) {
    console.error('[GeminiSubstituto] Gemini falhou:', eGem.message);
    return null;
  }
}

// Tenta responder no estilo "Direta" (factual, sem personalidade) usando
// a cascata Gemini → OpenRouter. Usado tanto quando o Groq 70b está em
// rate limit (modo direto) quanto no modo comparação manual.
// Retorna o texto da resposta, ou null se ambos falharem.
async function tentarFallbackCascata(contexto, name, message, logPrefix = 'ModoDireto', tom) {
  const msgsFallback = [
    { role: 'system', content: buildPromptModoDireto(contexto, name, tom) },
    { role: 'user', content: message }
  ];

  if (geminiDisponivel()) {
    try {
      const resposta = await geminiFreeResponse(msgsFallback, { temperature: 0.3, maxTokens: 300 });
      console.log(`[${logPrefix}] Gemini respondeu`);
      return resposta;
    } catch (eGem) {
      console.error(`[${logPrefix}] Gemini falhou:`, eGem.message);
    }
  }

  if (openrouterDisponivel()) {
    try {
      const resposta = await openrouterFreeResponse(msgsFallback, { temperature: 0.3, maxTokens: 300 });
      console.log(`[${logPrefix}] OpenRouter respondeu`);
      return resposta;
    } catch (eOR) {
      console.error(`[${logPrefix}] OpenRouter falhou:`, eOR.message);
    }
  }

  return null;
}

async function freeResponse(message, history = [], preferences = {}, privateMode = false) {
  const phone = preferences?._phone || null;

  try {
    const name = preferences?.name || null;
    const tom = preferences?.tom || 'carinhoso';
    const contexto = preferences?._contexto || '';

    if (preferences?._systemOverride) {
      try {
        const completion = await groq.chat.completions.create({
          model: MODEL_LEVE,
          messages: [
            { role: 'system', content: preferences._systemOverride },
            { role: 'user', content: message }
          ],
          temperature: 0.85,
          max_tokens: 200,
        });
        return completion.choices[0].message.content.trim();
      } catch (eOverride) {
        if (isRateLimit(eOverride) && phone) {
          // Sem alternativa — retorna null em vez de mandar a desculpa de pausa
          // como se fosse a mensagem real
          await ativarPausaCreativa(phone, isTPD(eOverride) ? 'tpd' : 'rpm');
          return null;
        }
        throw eOverride;
      }
    }

    // ── Modo comparação manual ──
    // Usuário ativou via comando interno ("ativa o gemini"). Responde com
    // a personalidade normal (não o estilo "Direta"), mas usando o Gemini
    // em vez do Groq — útil para comparar qualidade. "Volta pro Groq"
    // (detectado no handler) limpa essa flag e retorna ao fluxo normal.
    if (phone && emModoComparacao(phone) && !privateMode) {
      const resposta = await tentarGeminiComPersonalidade(message, history, tom, name, contexto, phone);
      if (resposta) return resposta;
      if (geminiDisponivel()) {
        return 'O Gemini não respondeu agora 😕 Pode tentar de novo, ou diga "volta pro Groq" para sair do modo comparação.';
      }
      return 'Gemini não está configurado (faltou a chave) — diga "volta pro Groq" para sair do modo comparação.';
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

    // Já está em modo direto — não tenta o 70b
    // (comandos estruturados como lembretes/listas continuam funcionando via classify)
    if (phone && estaEmModoDirecto(phone)) {
      // Se uma ação estruturada foi executada (lembrete, gasto, etc), confirma isso
      // em vez do lembrete genérico de pausa — o usuário precisa saber que funcionou
      if (preferences?._acaoConfirmacao) {
        return preferences._acaoConfirmacao;
      }
      // Já em modo direto (Groq 70b ainda em cooldown). Tenta primeiro o
      // Gemini com a personalidade COMPLETA (objetivo: avaliar o Gemini
      // como possível substituto do Groq, não só um fallback seco).
      const respostaGemini = await tentarGeminiComPersonalidade(message, history, tom, name, contexto, phone);
      if (respostaGemini) { marcarProvider('gemini'); return respostaGemini; }

      // Gemini indisponível/falhou — cai pro modo "Direta" seco via
      // cascata Gemini (de novo, com prompt direto) → OpenRouter.
      const respostaModoDireto = await tentarFallbackCascata(contexto, name, message, 'ModoDireto', tom);
      if (respostaModoDireto) { marcarProvider('openrouter'); return respostaModoDireto; }
      // Fallback final: mensagem fixa, sem custo de LLM. Varia entre
      // algumas opções (em vez de repetir sempre a mesma frase) — esse
      // caminho só é alcançado quando TODA a cascata falhou de verdade
      // (Gemini esgotado + OpenRouter indisponível), então deve ser raro,
      // mas se acontecer em sequência não soa tão repetitivo.
      marcarProvider('fallback_fixo');
      const FALLBACK_FIXO_MSGS = [
        'Ainda no modo direto — pode me mandar lembretes, listas e tarefas que eu cuido.',
        'Continuo no modo direto por aqui — lembretes, listas e tarefas funcionam normalmente.',
        'Modo direto ainda ativo — me manda o que precisar (lembrete, lista, tarefa) que eu registro.',
      ];
      return FALLBACK_FIXO_MSGS[Math.floor(Math.random() * FALLBACK_FIXO_MSGS.length)];
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
      marcarProvider('groq');
      return completion.choices[0].message.content.trim();
    } catch (e1) {
      if (isRateLimit(e1) && phone) {
        const tipo = isTPD(e1) ? 'tpd' : 'rpm';
        const aviso = await ativarModoDireto(phone, tipo);

        // ── Gemini como substituto do Groq (personalidade completa) ──
        // Objetivo: avaliar o Gemini como possível substituto do Groq, não
        // apenas como rede de segurança seca. Tenta manter a experiência
        // igual (mesma personalidade/tom) usando o Gemini no lugar do 70b.
        // Sem prefixo de aviso — a ideia é a transição ser transparente.
        const respostaGemini = await tentarGeminiComPersonalidade(message, history, tom, name, contexto, phone);
        if (respostaGemini) { marcarProvider('gemini'); return respostaGemini; }

        // ── Gemini indisponível/falhou → mesma personalidade via Gemini→OpenRouter (modo econômico) ──
        // Em vez de ficar em silêncio (ou só confirmações fixas) até o Groq
        // voltar, tenta responder com os dados do contexto (AGENDA, LISTAS,
        // etc) respeitando o tom configurado, só que de forma mais breve —
        // assim o usuário continua produtivo enquanto o papo livre está pausado.
        const respostaTrabalho = await tentarFallbackCascata(contexto, name, message, 'ModoDireto', tom);
        if (respostaTrabalho) {
          marcarProvider('openrouter');
          // Na primeira vez que entra em modo direto, prefixa com o aviso
          // de que o bate-papo completo está pausado.
          return aviso ? `${aviso}\n\n${respostaTrabalho}` : respostaTrabalho;
        }

        // Cascata indisponível ou falhou — modo direto tradicional
        // (aviso só vem na primeira vez — depois retorna null, handler não responde)
        marcarProvider('fallback_fixo');
        return aviso || null;
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
  ativarModoComparacao,
  desativarModoComparacao,
  emModoComparacao,
  detectarComandoComparacao,
  getUltimoProvider,
};
