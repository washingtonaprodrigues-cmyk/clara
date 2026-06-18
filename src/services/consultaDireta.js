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

// Padrões de mensagem reconhecidos como consulta direta. Deliberadamente
// conservador — só pega frases claramente de consulta de leitura, sem
// ambiguidade. Qualquer coisa fora desses padrões cai no fluxo normal.
const PADRAO_AGENDA_HOJE = /^(qual|quais)?\s*(é\s+)?(a\s+)?(minha\s+)?agenda\s*(pra|para|de)?\s*(hoje)?[\s?!.]*$/i;
const PADRAO_AGENDA_AMANHA = /^(qual|quais)?\s*(é\s+)?(a\s+)?(minha\s+)?agenda\s*(pra|para|de)?\s*amanh[ãa][\s?!.]*$/i;
const PADRAO_LEMBRETES = /^(quais|que)\s+(s[ãa]o\s+)?(os\s+)?(meus\s+)?lembretes(\s+(pendentes|de hoje|tenho))?[\s?!.]*$/i;
const PADRAO_SALDO = /^(qual|quanto)?\s*(é\s+|tenho\s+de\s+)?(o\s+)?(meu\s+)?saldo[\s?!.]*$/i;

function detectarTipoConsultaDireta(texto) {
  const t = (texto || '').trim();
  if (PADRAO_AGENDA_HOJE.test(t)) return 'agenda_hoje';
  if (PADRAO_AGENDA_AMANHA.test(t)) return 'agenda_amanha';
  if (PADRAO_LEMBRETES.test(t)) return 'lembretes_pendentes';
  if (PADRAO_SALDO.test(t)) return 'saldo';
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

  return `Sua agenda para ${label}:\n${linhas.join('\n')}`;
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
