const { classify, searchWeb, freeResponse } = require('./groq');
const { sendMessage } = require('./whatsapp');
const memory = require('./memory');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// ====================== UTILITÁRIOS ======================
function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function dateBRT() {
  const d = nowBRT();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function minutesToHours(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h${m > 0 ? m + 'min' : ''}`;
}

// ====================== HANDLER PRINCIPAL ======================
async function handleMessage(phone, text) {
  try {
    const user = await memory.getOrCreateUser(phone);

    const classified = await classify(text);
    console.log(`[${phone}] Tipo: ${classified.tipo}`);

    switch (classified.tipo) {
      case 'ponto_multiplo':
        await handlePontoMultiplo(user, phone, classified.acoes, text);
        break;

      case 'ponto':
        await handlePonto(user, phone, classified.subtipo);
        break;

      default:
        const resp = await freeResponse(text);
        await sendMessage(phone, resp);
    }
  } catch (error) {
    console.error('Erro:', error.message);
    await sendMessage(phone, 'Entendi! Pode repetir por favor?');
  }
}

// ====================== PONTO MÚLTIPLO - VERSÃO MELHORADA ======================
async function handlePontoMultiplo(user, phone, acoes, originalText) {
  await sendMessage(phone, '📍 Registrando seus pontos...');

  for (const acao of acoes) {
    let subtipo = acao.subtipo.toLowerCase();

    if (subtipo.includes('cheg') || subtipo.includes('entrada')) subtipo = 'entrada';
    else if (subtipo.includes('saí') && subtipo.includes('almo')) subtipo = 'saida_almoco';
    else if (subtipo.includes('volt') && subtipo.includes('almo')) subtipo = 'volta_almoco';
    else if (subtipo.includes('saí') || subtipo.includes('saindo')) subtipo = 'saida';

    const hora = acao.hora || 'agora';

    await prisma.workLog.create({
      data: {
        userId: user.id,
        type: subtipo,
        timestamp: nowBRT(),
        date: dateBRT(),
      },
    });

    await sendMessage(phone, `✅ *${subtipo.replace('_', ' ')}* registrada às *${hora}*`);
  }

  // Calcula horas trabalhadas até agora
  const resumo = await calcularHorasTrabalhadas(user.id);

  let mensagemFinal = `📊 *Resumo de hoje*\n\n`;
  mensagemFinal += `${resumo}\n\n`;
  mensagemFinal += `A que horas você pretende sair hoje? Me fala que eu calculo quanto tempo ainda falta. 😊`;

  await sendMessage(phone, mensagemFinal);
}

// ====================== CÁLCULO DE HORAS ======================
async function calcularHorasTrabalhadas(userId) {
  const hoje = dateBRT();
  const logs = await prisma.workLog.findMany({
    where: { userId, date: hoje },
    orderBy: { timestamp: 'asc' }
  });

  let entrada = null;
  let saidaAlmoco = null;
  let voltaAlmoco = null;
  let totalMin = 0;

  for (const log of logs) {
    const hora = new Date(log.timestamp).getHours() * 60 + new Date(log.timestamp).getMinutes();

    if (log.type === 'entrada') entrada = hora;
    if (log.type === 'saida_almoco') saidaAlmoco = hora;
    if (log.type === 'volta_almoco') voltaAlmoco = hora;
  }

  if (entrada && saidaAlmoco) {
    totalMin += saidaAlmoco - entrada;
  }
  if (voltaAlmoco) {
    // Se já voltou do almoço, consideramos até agora
    const agora = nowBRT().getHours() * 60 + nowBRT().getMinutes();
    totalMin += agora - voltaAlmoco;
  }

  return `Você já trabalhou **${minutesToHours(totalMin)}** hoje.`;
}

async function handlePonto(user, phone, subtipo) {
  const horaAtual = nowBRT().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  await prisma.workLog.create({
    data: { userId: user.id, type: subtipo, timestamp: nowBRT(), date: dateBRT() }
  });
  await sendMessage(phone, `✅ *${subtipo.replace('_', ' ')}* registrada às *${horaAtual}*`);
}

module.exports = { handleMessage };
