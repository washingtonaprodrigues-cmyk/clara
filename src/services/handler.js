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

      case 'anotacao':
        await handleNote(user, phone, classified);
        break;

      case 'busca':
        await handleBusca(user, phone, text);
        break;

      case 'consulta':
        await handleQuery(user, phone, text);
        break;

      case 'saudacao':
        await sendMessage(phone, 'Oi! Tudo bem por aí? 😊');
        break;

      default:
        const resp = await freeResponse(text);
        await sendMessage(phone, resp);
    }
  } catch (error) {
    console.error('Erro handleMessage:', error.message);
    await sendMessage(phone, 'Entendi! Pode repetir por favor?');
  }
}

// ====================== PONTO MÚLTIPLO - MELHORADO ======================
async function handlePontoMultiplo(user, phone, acoes, originalText) {
  if (!acoes || acoes.length === 0) {
    return await sendMessage(phone, 'Não consegui entender os horários. Pode repetir?');
  }

  await sendMessage(phone, '📍 Registrando seus pontos...');

  for (const acao of acoes) {
    let subtipo = acao.subtipo.toLowerCase().trim();
    
    if (subtipo.includes('cheg') || subtipo.includes('entrada')) subtipo = 'entrada';
    else if (subtipo.includes('saí') && subtipo.includes('almo')) subtipo = 'saida_almoco';
    else if (subtipo.includes('volt') && subtipo.includes('almo')) subtipo = 'volta_almoco';
    else if (subtipo.includes('saí') || subtipo.includes('fui embora')) subtipo = 'saida';

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

  // Resumo final
  await sendMessage(phone, `✅ Todos os pontos foram registrados com sucesso!\n\nQuer que eu calcule quantas horas você já trabalhou hoje?`);
}

// ====================== OUTROS HANDLERS ======================
async function handlePonto(user, phone, subtipo) {
  const horaAtual = nowBRT().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  await prisma.workLog.create({
    data: { userId: user.id, type: subtipo, timestamp: nowBRT(), date: dateBRT() }
  });
  await sendMessage(phone, `✅ *${subtipo.replace('_', ' ')}* registrada às *${horaAtual}*`);
}

async function handleNote(user, phone, classified) {
  await memory.saveMemory(user.id, 'anotacao', classified.conteudo || classified.titulo);
  await sendMessage(phone, `📝 Anotei: *${classified.titulo || 'informação'}*`);
}

async function handleBusca(user, phone, text) {
  await sendMessage(phone, '🔍 Pesquisando...');
  const result = await searchWeb(text);
  await sendMessage(phone, result);
}

async function handleQuery(user, phone, text) {
  const memories = await memory.getRecentMemories(user.id, 20);
  if (memories.length === 0) return await sendMessage(phone, 'Ainda não tenho registros seus.');
  // Temporário
  await sendMessage(phone, 'Deixa eu verificar suas memórias...');
}

module.exports = { handleMessage };
