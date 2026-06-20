// ── Consulta Direta (sem LLM) ──
// Para perguntas que são puramente "me mostra um dado que já existe no
// banco" (agenda de hoje/amanhã, lembretes pendentes, saldo financeiro),
// não há nada para "interpretar" — é só formatar e responder. Passar isso
// por classify + freeResponse (1-2 chamadas de IA) adiciona latência sem
// necessidade, e pior: cada fallback da cascata (Groq/Gemini/OpenRouter)
// pode formatar dados sutilmente diferente (foi a causa raiz de um bug
// real: horários divergindo em 3h entre Dashboard e WhatsApp por uma
// conversão de fuso horário feita só em um dos caminhos).
//
// Este módulo é compartilhado entre handler.js (WhatsApp) e chat.js
// (Dashboard) — mesma função, mesmo resultado, sempre. Se o padrão da
// mensagem não bater com nenhuma consulta direta conhecida, retorna null
// e o chamador segue o fluxo normal (classify + freeResponse).

function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function paraBRT(data) {
  return new Date(new Date(data).toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function pad(n) { return String(n).padStart(2, '0'); }

function dataISOBRT(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function horaBRT(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Padrões de detecção flexíveis — buscam palavras-chave centrais dentro
// da frase, em vez de exigir que a mensagem inteira seja só o padrão.
// A primeira versão usava ^...$ (início/fim exatos), que falhava com
// qualquer variação natural de fala ("Clara, qual minha agenda hoje?",
// "me mostra a agenda de hoje", "oi, mostra minha agenda") — cobrindo só
// a frase exata testada manualmente, não como as pessoas realmente
// escrevem. Esta versão é mais permissiva: detecta a intenção central
// (agenda/lembretes/saldo) em qualquer posição da frase, com proteções
// para não disparar em mensagens que claramente pedem outra coisa (ver
// EXCLUSOES abaixo).

// Se a mensagem contiver qualquer um desses termos, NÃO é consulta direta
// mesmo que mencione agenda/lembrete/saldo — são sinais de que o usuário
// quer fazer uma AÇÃO (criar, mudar, decidir), não só ler um dado pronto.
const EXCLUSOES = /\b(criar?|cria|adicion[ae]|marca|marque|remarca|remarque|muda|mude|altera|altere|cancela|cancele|exclui|exclua|deleta|delete|apaga|apague|conclui|conclua|vale a pena|devo|deveria|o que acha|me ajuda a decidir|compar[ae])\b/i;

// ── Data específica mencionada (dia X, X/Y, dia da semana, "semana que
// vem" etc.) ──
// Bug real corrigido aqui: "Clara, como está minha agenda pro dia 24 e
// 27" batia em RE_AGENDA, não batia em RE_AMANHA, e caía no fallback
// "agenda_hoje" — respondendo sobre HOJE quando a pergunta era sobre datas
// completamente diferentes. Esse módulo só sabe responder hoje/amanhã;
// qualquer outra data precisa do fluxo completo (classify com extração de
// data + busca real no banco, ver handler.js/groq.js), então quando esse
// padrão bate, retornamos null aqui para NUNCA interceptar — deixa passar
// para o fluxo normal em vez de arriscar responder sobre o dia errado.
const RE_DATA_ESPECIFICA = /\bdia\s+\d{1,2}\b|\b\d{1,2}\/\d{1,2}\b|\b(segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo)(-feira)?\b|semana que vem|pr[óo]xima semana|m[êe]s que vem/i;

const RE_AGENDA = /\bagenda\b/i;
const RE_HOJE = /\bhoje\b/i;
const RE_AMANHA = /\bamanh[ãa]/i;
const RE_LEMBRETES = /\blembretes?\s+(pendentes?)?\b|\bquais?\s+(s[ãa]o\s+)?(meus\s+)?lembretes\b/i;
const RE_SALDO = /\bsaldo\b|\bquanto\s+(eu\s+)?tenho\b|\bor[çc]amento\b/i;

function detectarTipoConsultaDireta(texto) {
  const t = (texto || '').trim();
  if (!t || t.length > 80) return null; // mensagens muito longas raramente são consulta simples
  if (EXCLUSOES.test(t)) return null; // sinal de ação/decisão, não leitura pura
  if (RE_DATA_ESPECIFICA.test(t) && !RE_HOJE.test(t)) return null; // data específica que não é "hoje" — deixa pro fluxo completo

  const temAgenda = RE_AGENDA.test(t);
  const temSaldo = RE_SALDO.test(t);
  const temLembretes = RE_LEMBRETES.test(t);

  if (temAgenda && RE_AMANHA.test(t)) return 'agenda_amanha';
  if (temAgenda) return 'agenda_hoje'; // "agenda" sem "amanhã" especificado = hoje (padrão mais comum)
  if (temLembretes) return 'lembretes_pendentes';
  if (temSaldo) return 'saldo';
  return null;
}

// Formata a lista de lembretes de um dia específico (hoje ou amanhã).
// userId, prisma e memory são passados pelo chamador (evita import
// circular — cada arquivo já tem suas próprias instâncias).
async function responderAgenda(prisma, userId, dia) {
  const now = nowBRT();
  const base = new Date(now);
  if (dia === 'amanha') base.setDate(base.getDate() + 1);
  const diaStr = dataISOBRT(base);
  const inicio = new Date(`${diaStr}T00:00:00-03:00`);
  const fim = new Date(`${diaStr}T23:59:59-03:00`);

  const lembretes = await prisma.reminder.findMany({
    where: { userId, sent: false, confirmed: false, scheduledAt: { gte: inicio, lte: fim } },
    orderBy: { scheduledAt: 'asc' },
    take: 20,
  });

  const label = dia === 'amanha' ? 'amanhã' : 'hoje';
  if (!lembretes.length) {
    return `Você não tem nenhum compromisso agendado para ${label}. 😊`;
  }

  const linhas = lembretes.map(r => {
    const dLocal = paraBRT(r.scheduledAt);
    return `• ${horaBRT(dLocal)} — ${r.message}`;
  });

  // ── Linha de fechamento ──
  // Antes a resposta só despejava a lista e parava, sem responder a
  // pergunta implícita por trás de "minha agenda hoje acabou?" — alguém
  // perguntando isso quer um sim/não, não só os dados crus. Para "hoje",
  // fecha deixando claro quanto ainda falta; para "amanhã" não faz tanto
  // sentido falar em "restar", então só varia a frase de fechamento.
  let fechamento;
  if (dia === 'amanha') {
    fechamento = lembretes.length === 1 ? 'Só isso por enquanto.' : `${lembretes.length} compromissos no total.`;
  } else {
    fechamento = lembretes.length === 1
      ? 'Ainda falta só isso aí pra hoje! 😊'
      : `Ainda restam ${lembretes.length} compromissos hoje.`;
  }

  return `Sua agenda para ${label}:\n${linhas.join('\n')}\n\n${fechamento}`;
}

// Formata todos os lembretes pendentes (não só hoje/amanhã) — útil para
// "quais são meus lembretes?" sem especificar dia.
async function responderLembretesPendentes(prisma, userId) {
  const now = nowBRT();
  const lembretes = await prisma.reminder.findMany({
    where: { userId, sent: false, confirmed: false, scheduledAt: { gte: now } },
    orderBy: { scheduledAt: 'asc' },
    take: 20,
  });

  if (!lembretes.length) {
    return 'Você não tem lembretes pendentes agora. 😊';
  }

  const hojeStr = dataISOBRT(now);
  const linhas = lembretes.map(r => {
    const dLocal = paraBRT(r.scheduledAt);
    const dStr = dataISOBRT(dLocal) === hojeStr ? 'Hoje' : dLocal.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    return `• ${dStr} às ${horaBRT(dLocal)} — ${r.message}`;
  });

  return `Seus lembretes pendentes:\n${linhas.join('\n')}`;
}

// Formata o saldo financeiro do mês atual (orçamento - gastos).
async function responderSaldo(prisma, memory, userId) {
  const preferences = await memory.getUserPreference(userId);
  if (preferences.saldo == null) {
    return 'Você ainda não definiu um orçamento mensal. Pode me dizer, por exemplo: "meu orçamento é 3500".';
  }

  const now = nowBRT();
  const inicioMes = new Date(now.getFullYear(), now.getMonth(), 1);
  const gastos = await prisma.expense.findMany({ where: { userId, createdAt: { gte: inicioMes } } });
  const totalGasto = gastos.reduce((a, g) => a + g.value, 0);
  const restante = preferences.saldo - totalGasto;

  const fmtBRL = v => `R$ ${v.toFixed(2).replace('.', ',')}`;
  return `Orçamento do mês: ${fmtBRL(preferences.saldo)}\nGasto até agora: ${fmtBRL(totalGasto)}\nSaldo restante: ${fmtBRL(restante)}`;
}

// Ponto de entrada principal. Retorna a resposta formatada (string), ou
// null se a mensagem não corresponder a nenhum padrão de consulta direta
// conhecido — nesse caso o chamador deve seguir o fluxo normal.
async function tentarConsultaDireta(texto, { prisma, memory, userId }) {
  const tipo = detectarTipoConsultaDireta(texto);
  if (!tipo) return null;

  try {
    switch (tipo) {
      case 'agenda_hoje':
        return await responderAgenda(prisma, userId, 'hoje');
      case 'agenda_amanha':
        return await responderAgenda(prisma, userId, 'amanha');
      case 'lembretes_pendentes':
        return await responderLembretesPendentes(prisma, userId);
      case 'saldo':
        return await responderSaldo(prisma, memory, userId);
      default:
        return null;
    }
  } catch (e) {
    console.error(`[ConsultaDireta] Erro ao responder tipo "${tipo}":`, e.message);
    return null; // Falha silenciosa — cai no fluxo normal (classify + freeResponse)
  }
}

module.exports = {
  tentarConsultaDireta,
  detectarTipoConsultaDireta,
};
