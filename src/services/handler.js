const { classify, searchWeb, generateMemorySummary, freeResponse, generateWorkSummary } = require('./groq');
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

function minutesToHours(min) {
  const h = Math.floor(Math.abs(min) / 60);
  const m = Math.abs(min) % 60;
  return `${h}h${m > 0 ? m + 'min' : ''}`;
}

// ====================== HANDLER PRINCIPAL ======================
async function handleMessage(phone, text) {
  try {
    const user = await memory.getOrCreateUser(phone);

    const classified = await classify(text);
    console.log(`[${phone}] Tipo detectado: ${classified.tipo}`);

    switch (classified.tipo) {
      case 'anotacao':
        await handleNote(user, phone, classified);
        break;

      case 'tarefa':
        await handleTask(user, phone, classified);
        break;

      case 'gasto':
        await handleExpense(user, phone, classified);
        break;

      case 'ponto':
        await handlePonto(user, phone, classified.subtipo);
        break;

      case 'ponto_multiplo':
        await handlePontoMultiplo(user, phone, classified.acoes || []);
        break;

      case 'busca':
        await handleBusca(user, phone, text);
        break;

      case 'consulta':
        await handleQuery(user, phone, text);
        break;

      case 'saudacao':
        await sendMessage(phone, 'Oi! Tudo bem? Como posso te ajudar hoje? 😊');
        break;

      default:
        const resposta = await freeResponse(text);
        await sendMessage(phone, resposta);
    }
  } catch (error) {
    console.error('Erro no handleMessage:', error.message);
    await sendMessage(phone, 'Ops, tive um probleminha aqui... Pode repetir por favor?');
  }
}

// ====================== FUNÇÕES DE PONTO ======================
async function handlePonto(user, phone, subtipo) {
  const horaAtual = nowBRT().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  await prisma.workLog.create({
    data: {
      userId: user.id,
      type: subtipo,
      timestamp: nowBRT(),
      date: dateBRT(),
    },
  });

  const msgs = {
    entrada: `✅ Chegada registrada às *${horaAtual}*.`,
    saida_almoco: `🍽️ Saída para almoço registrada às *${horaAtual}*.`,
    volta_almoco: `✅ Retorno do almoço às *${horaAtual}*.`,
    saida: `🏁 Saída registrada às *${horaAtual}*.`,
  };

  await sendMessage(phone, msgs[subtipo] || `✅ Ponto registrado (${subtipo}).`);
}

async function handlePontoMultiplo(user, phone, acoes) {
  await sendMessage(phone, '📍 Registrando seus pontos...');

  for (const acao of acoes) {
    let subtipo = acao.subtipo.toLowerCase();
    if (subtipo.includes('cheg') || subtipo.includes('entrada')) subtipo = 'entrada';
    else if ((subtipo.includes('saí') || subtipo.includes('sai')) && subtipo.includes('almo')) subtipo = 'saida_almoco';
    else if (subtipo.includes('volt') && subtipo.includes('almo')) subtipo = 'volta_almoco';
    else if (subtipo.includes('saí') || subtipo.includes('saindo')) subtipo = 'saida';

    await prisma.workLog.create({
      data: {
        userId: user.id,
        type: subtipo,
        timestamp: nowBRT(),
        date: dateBRT(),
      },
    });

    await sendMessage(phone, `✅ *${subtipo.replace('_', ' ')}* registrado.`);
  }

  await gerarResumoDia(user, phone);
}

async function gerarResumoDia(user, phone) {
  const logs = await prisma.workLog.findMany({
    where: { userId: user.id, date: dateBRT() },
    orderBy: { timestamp: 'asc' },
  });

  const jornadaMinutos = await memory.getJornada(user.id);
  // Cálculo básico por enquanto
  const resumo = await generateWorkSummary(logs, 480, 0); // temporário

  await sendMessage(phone, `📊 Resumo do dia:\n${resumo}`);
}

// ====================== OUTROS HANDLERS ======================
async function handleNote(user, phone, classified) {
  await memory.saveMemory(user.id, 'anotacao', classified.conteudo || classified.titulo);
  await sendMessage(phone, `📝 Anotei: *${classified.titulo || 'informação'}*`);
}

async function handleTask(user, phone, classified) {
  await sendMessage(phone, classified.resposta || '✅ Tarefa guardada!');
}

async function handleExpense(user, phone, classified) {
  await sendMessage(phone, `💰 Gasto de R$ ${classified.valor} registrado.`);
}

async function handleBusca(user, phone, text) {
  await sendMessage(phone, '🔍 Pesquisando pra você...');
  const resultado = await searchWeb(text);
  await sendMessage(phone, resultado);
}

async function handleQuery(user, phone, text) {
  const memories = await memory.getRecentMemories(user.id, 15);
  if (memories.length === 0) {
    return await sendMessage(phone, 'Ainda não guardei nada seu. Me conta algo importante!');
  }
  const resposta = await generateMemorySummary(memories, text);
  await sendMessage(phone, resposta);
}

module.exports = { handleMessage };
