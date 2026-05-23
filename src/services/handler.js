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
    await sendMessage(phone, 'Entendi! Pode repetir?');
  }
}

// ====================== PONTO MÚLTIPLO - RESUMO BONITO ======================
async function handlePontoMultiplo(user, phone, acoes, originalText) {
  await sendMessage(phone, '📍 Registrando seus pontos...');

  const registros = [];

  for (const acao of acoes) {
    let subtipo = acao.subtipo.toLowerCase();

    if (subtipo.includes('cheg') || subtipo.includes('entrada')) {
      subtipo = 'entrada';
      registros.push({ tipo: 'entrada', hora: acao.hora });
    }
    else if (subtipo.includes('saí') && subtipo.includes('almo')) {
      subtipo = 'saida_almoco';
      registros.push({ tipo: 'saida_almoco', hora: acao.hora });
    }
    else if (subtipo.includes('volt') && subtipo.includes('almo')) {
      subtipo = 'volta_almoco';
      registros.push({ tipo: 'volta_almoco', hora: acao.hora });
    }
    else if (subtipo.includes('saí') || subtipo.includes('saindo')) {
      subtipo = 'saida';
      registros.push({ tipo: 'saida', hora: acao.hora });
    }

    await prisma.workLog.create({
      data: {
        userId: user.id,
        type: subtipo,
        timestamp: nowBRT(),
        date: dateBRT(),
      },
    });
  }

  // Gera resumo bonito
  const resumo = await gerarResumoBonito(user.id, registros);
  await sendMessage(phone, resumo);
}

// ====================== RESUMO BONITO ======================
async function gerarResumoBonito(userId, registros) {
  const hoje = dateBRT();
  const logs = await prisma.workLog.findMany({
    where: { userId, date: hoje },
    orderBy: { timestamp: 'asc' }
  });

  let entrada = null;
  let saidaAlmoco = null;
  let voltaAlmoco = null;

  logs.forEach(log => {
    const hora = log.timestamp.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    if (log.type === 'entrada') entrada = hora;
    if (log.type === 'saida_almoco') saidaAlmoco = hora;
    if (log.type === 'volta_almoco') voltaAlmoco = hora;
  });

  let tempoManha = '—';
  if (entrada && saidaAlmoco) {
    const [h1, m1] = entrada.split(':').map(Number);
    const [h2, m2] = saidaAlmoco.split(':').map(Number);
    const minutos = (h2 * 60 + m2) - (h1 * 60 + m1);
    tempoManha = minutesToHours(minutos);
  }

  let texto = `✨ *Resumo do seu dia até agora*\n\n`;
  if (entrada) texto += `🟢 Entrada: *${entrada}*\n`;
  if (saidaAlmoco) texto += `🍽️ Saída para almoço: *${saidaAlmoco}*\n`;
  if (tempoManha !== '—') texto += `⏱️ Tempo trabalhado pela manhã → *${tempoManha}*\n`;
  if (voltaAlmoco) texto += `🔄 Retorno do almoço: *${voltaAlmoco}*\n\n`;

  texto += `📌 Desde que você voltou, estou acompanhando normalmente.\n\n`;
  texto += `💡 Me avisa quando for sair do trabalho que eu te mostro:\n`;
  texto += `• Total trabalhado hoje\n`;
  texto += `• Horas extras\n`;
  texto += `• Resumo completo do expediente`;

  return texto;
}

async function handlePonto(user, phone, subtipo) {
  const horaAtual = nowBRT().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  await prisma.workLog.create({
    data: { userId: user.id, type: subtipo, timestamp: nowBRT(), date: dateBRT() }
  });
  await sendMessage(phone, `✅ *${subtipo.replace('_', ' ')}* registrada às *${horaAtual}*`);
}

module.exports = { handleMessage };
