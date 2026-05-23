const { classify, searchWeb, generateMemorySummary, freeResponse, generateWorkSummary } = require('./groq');
const { sendMessage, sendButtons } = require('./whatsapp');
const memory = require('./memory');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const JORNADA_PADRAO = 480; // 8 horas em minutos

// ─────────────────────────────────────────────
// UTILITÁRIOS DE DATA/HORA
// ─────────────────────────────────────────────
function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function dateBRT() {
  const d = nowBRT();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseHora(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  const match = t.match(/(\d{1,2})[:h](\d{2})?/);
  if (match) {
    const hora = match[1].padStart(2, '0');
    const min = match[2] ? match[2] : '00';
    return `${hora}:${min}`;
  }
  return null;
}

function minutesToHours(min) {
  const h = Math.floor(Math.abs(min) / 60);
  const m = Math.abs(min) % 60;
  return `${h}h${m > 0 ? m + 'min' : ''}`;
}

// ─────────────────────────────────────────────
// HANDLER PRINCIPAL
// ─────────────────────────────────────────────
async function handleMessage(phone, text) {
  try {
    const user = await memory.getOrCreateUser(phone);

    const classified = await classify(text);
    console.log(`[${phone}] Tipo: ${classified.tipo}`);

    switch (classified.tipo) {
      case 'anotacao':
        await handleNote(user, phone, classified);
        break;
      case 'tarefa':
        await handleTask(user, phone, classified, text);
        break;
      case 'gasto':
        await handleExpense(user, phone, classified);
        break;
      case 'ponto':
        await handlePonto(user, phone, classified.subtipo);
        break;
      case 'ponto_multiplo':
        await handlePontoMultiplo(user, phone, classified.acoes);
        break;
      case 'busca':
        await handleBusca(user, phone, classified.query || text);
        break;
      case 'consulta':
        await handleQuery(user, phone, text);
        break;
      case 'saudacao':
        await sendMessage(phone, classified.resposta || 'Oi! Como posso te ajudar hoje? 😊');
        break;
      default:
        const resp = await freeResponse(text);
        await sendMessage(phone, resp);
    }
  } catch (error) {
    console.error('Erro handleMessage:', error.message);
    await sendMessage(phone, 'Ops, tive um probleminha. Pode repetir por favor?');
  }
}

// ─────────────────────────────────────────────
// PONTO SIMPLES
// ─────────────────────────────────────────────
async function handlePonto(user, phone, subtipo) {
  const hoje = dateBRT();
  const agora = nowBRT();
  const horaAtual = `${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;

  await prisma.workLog.create({
    data: {
      userId: user.id,
      type: subtipo,
      timestamp: agora,
      date: hoje,
    },
  });

  const mensagens = {
    entrada: `✅ Chegada registrada às *${horaAtual}*.`,
    saida_almoco: `🍽️ Saída para almoço registrada às *${horaAtual}*.`,
    volta_almoco: `✅ Retorno do almoço registrado às *${horaAtual}*.`,
    saida: `🏁 Saída registrada às *${horaAtual}*.`,
  };

  await sendMessage(phone, mensagens[subtipo] || `✅ Ponto (${subtipo}) registrado.`);
}

// ─────────────────────────────────────────────
// PONTO MÚLTIPLO (Nova funcionalidade)
// ─────────────────────────────────────────────
async function handlePontoMultiplo(user, phone, acoes) {
  await sendMessage(phone, '📍 Registrando seus pontos...');

  for (const acao of acoes) {
    let subtipo = acao.subtipo.toLowerCase();

    if (subtipo.includes('cheg') || subtipo.includes('entrada')) subtipo = 'entrada';
    else if (subtipo.includes('saí') && subtipo.includes('almo')) subtipo = 'saida_almoco';
    else if (subtipo.includes('volt') && subtipo.includes('almo')) subtipo = 'volta_almoco';
    else if (subtipo.includes('saí') || subtipo.includes('saindo')) subtipo = 'saida';

    const hora = acao.hora || null;

    await prisma.workLog.create({
      data: {
        userId: user.id,
        type: subtipo,
        timestamp: nowBRT(),
        date: dateBRT(),
      },
    });

    await sendMessage(phone, `✅ *${subtipo.replace('_', ' ')}* registrado${hora ? ` às ${hora}` : ''}.`);
  }

  // Calcula resumo do dia
  await gerarResumoDia(user, phone);
}

// ─────────────────────────────────────────────
// RESUMO DO DIA (com jornada configurável)
// ─────────────────────────────────────────────
async function gerarResumoDia(user, phone) {
  const hoje = dateBRT();
  const logsHoje = await prisma.workLog.findMany({
    where: { userId: user.id, date: hoje },
    orderBy: { timestamp: 'asc' },
  });

  if (logsHoje.length === 0) return;

  const jornadaMinutos = await memory.getJornada(user.id);

  // Cálculo simples de tempo trabalhado
  let totalMin = 0;
  let entrada = null;

  for (const log of logsHoje) {
    if (log.type === 'entrada') entrada = new Date(log.timestamp);
    if (log.type === 'saida' && entrada) {
      const diff = (new Date(log.timestamp) - entrada) / 60000;
      totalMin += diff;
    }
  }

  const extraMin = totalMin - jornadaMinutos;
  const resumo = await generateWorkSummary(logsHoje, totalMin, extraMin);

  let msg = `📊 *Resumo do dia*\n\n`;
  msg += `⏱️ Trabalhado: *${minutesToHours(totalMin)}*\n`;
  msg += `🎯 Jornada: ${minutesToHours(jornadaMinutos)}\n`;

  if (extraMin > 0) msg += `📈 +${minutesToHours(extraMin)} de hora extra\n`;
  if (extraMin < 0) msg += `📉 ${minutesToHours(extraMin)} a menos\n`;

  msg += `\n${resumo}`;

  await sendMessage(phone, msg);
}

// ─────────────────────────────────────────────
// OUTROS HANDLERS (mantidos simples)
// ─────────────────────────────────────────────
async function handleNote(user, phone, classified) {
  await memory.saveMemory(user.id, 'anotacao', classified.conteudo, { titulo: classified.titulo });
  await sendMessage(phone, `📝 Anotei: *${classified.titulo}*`);
}

async function handleTask(user, phone, classified, originalText) {
  // ... (você pode manter sua lógica anterior ou simplificar por enquanto)
  await sendMessage(phone, classified.resposta || '✅ Tarefa anotada!');
}

async function handleExpense(user, phone, classified) {
  await memory.saveExpense(user.id, classified); // ajuste se necessário
  await sendMessage(phone, `💰 Gasto registrado: R$ ${classified.valor}`);
}

async function handleBusca(user, phone, query) {
  await sendMessage(phone, '🔍 Pesquisando...');
  const result = await searchWeb(query);
  await sendMessage(phone, result);
}

async function handleQuery(user, phone, question) {
  const memories = await memory.getRecentMemories(user.id, 20);
  if (memories.length === 0) {
    return await sendMessage(phone, 'Ainda não tenho memórias suas. Me conta algo!');
  }
  const answer = await generateMemorySummary(memories, question);
  await sendMessage(phone, answer);
}

module.exports = { handleMessage };
