const { classify, searchWeb, freeResponse, generateMemorySummary } = require('./groq');
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
async function handleMessage(phone, text, location = null) {
  try {
    const user = await memory.getOrCreateUser(phone);

    // ====================== LOCALIZAÇÃO ======================
    if (location && location.latitude) {
      await memory.saveMemory(user.id, 'localizacao', 
        JSON.stringify({
          latitude: location.latitude,
          longitude: location.longitude,
          updatedAt: new Date().toISOString()
        })
      );
      return await sendMessage(phone, '✅ Localização recebida! Agora posso te ajudar melhor com clima, farmácias e lojas próximas.');
    }

    // ====================== MENSAGEM DE TEXTO ======================
    if (!text) return;

    const classified = await classify(text);
    console.log(`[${phone}] Tipo: ${classified.tipo}`);

    switch (classified.tipo) {
      case 'ponto_multiplo':
        await handlePontoMultiplo(user, phone, classified.acoes, text);
        break;

      case 'busca':
        await handleBusca(user, phone, classified.query || text);
        break;

      case 'anotacao':
        await handleNote(user, phone, classified);
        break;

      case 'tarefa':
        await handleTask(user, phone, classified);
        break;

      case 'gasto':
        await handleExpense(user, phone, classified);
        break;

      case 'consulta':
        await handleQuery(user, phone, text);
        break;

      case 'saudacao':
        await sendMessage(phone, 'Oi! Tudo bem? Como posso te ajudar? 😊');
        break;

      default:
        const resp = await freeResponse(text);
        await sendMessage(phone, resp);
    }
  } catch (error) {
    console.error('Erro handleMessage:', error.message);
    await sendMessage(phone, 'Ops, tive um probleminha. Pode repetir?');
  }
}

// ====================== PONTO MÚLTIPLO ======================
async function handlePontoMultiplo(user, phone, acoes, originalText) {
  await sendMessage(phone, '📍 Registrando seus pontos...');

  const registros = [];

  for (const acao of acoes) {
    let subtipo = acao.subtipo.toLowerCase();

    if (subtipo.includes('cheg') || subtipo.includes('entrada')) subtipo = 'entrada';
    else if (subtipo.includes('saí') && subtipo.includes('almo')) subtipo = 'saida_almoco';
    else if (subtipo.includes('volt') && subtipo.includes('almo')) subtipo = 'volta_almoco';
    else if (subtipo.includes('saí') || subtipo.includes('saindo')) subtipo = 'saida';

    const horaUsada = acao.hora || 'agora';
    const timestamp = horaUsada !== 'agora' ? convertToDateWithTime(horaUsada) : nowBRT();

    await prisma.workLog.create({
      data: { userId: user.id, type: subtipo, timestamp, date: dateBRT() }
    });

    registros.push({ subtipo, hora: horaUsada });
  }

  const resumo = await gerarResumoBonito(registros);
  await sendMessage(phone, resumo);
}

function convertToDateWithTime(horaStr) {
  const [hora, min] = horaStr.split(':').map(Number);
  const date = nowBRT();
  date.setHours(hora, min || 0, 0, 0);
  return date;
}

async function gerarResumoBonito(registros) {
  let entrada = registros.find(r => r.subtipo === 'entrada')?.hora || '—';
  let saidaAlmoco = registros.find(r => r.subtipo === 'saida_almoco')?.hora || '—';
  let voltaAlmoco = registros.find(r => r.subtipo === 'volta_almoco')?.hora || '—';

  let tempoManha = '—';
  if (entrada !== '—' && saidaAlmoco !== '—') {
    const [h1, m1] = entrada.split(':').map(Number);
    const [h2, m2] = saidaAlmoco.split(':').map(Number);
    const minutos = (h2 * 60 + m2) - (h1 * 60 + m1);
    tempoManha = minutesToHours(minutos);
  }

  let texto = `✨ *Resumo do seu dia*\n\n`;
  texto += `🟢 Entrada: *${entrada}*\n`;
  texto += `🍽️ Saída almoço: *${saidaAlmoco}*\n`;
  texto += `⏱️ Manhã: *${tempoManha}*\n`;
  texto += `🔄 Volta almoço: *${voltaAlmoco}*\n\n`;
  texto += `💡 Me avisa quando sair!`;

  return texto;
}

// ====================== BUSCA ======================
async function handleBusca(user, phone, query) {
  await sendMessage(phone, '🔍 Buscando...');

  const lastLocationMem = await memory.getRecentMemories(user.id, 5);
  const locationMem = lastLocationMem.find(m => m.type === 'localizacao');

  let locationText = '';
  if (locationMem) {
    try {
      const loc = JSON.parse(locationMem.content);
      locationText = `${loc.latitude}, ${loc.longitude}`;
    } catch (e) {
      locationText = '';
    }
  }

  const resultado = await searchWeb(query, locationText);
  await sendMessage(phone, resultado);
}

// ====================== ANOTAÇÃO ======================
async function handleNote(user, phone, classified) {
  await memory.saveMemory(user.id, 'anotacao', classified.conteudo, { 
    titulo: classified.titulo 
  });
  await sendMessage(phone, 'Anotado! ✓ Guardei aqui comigo.');
}

// ====================== TAREFA ======================
async function handleTask(user, phone, classified) {
  await memory.saveMemory(user.id, 'tarefa', classified.titulo, {
    data: classified.data,
    hora: classified.hora,
  });
  
  let msg = 'Guardei! 📅';
  if (classified.hora) {
    msg = `Vou te lembrar às *${classified.hora}*. 📅`;
  }
  
  await sendMessage(phone, msg);
}

// ====================== GASTO ======================
async function handleExpense(user, phone, classified) {
  await memory.saveMemory(user.id, 'gasto', classified.descricao, {
    valor: classified.valor,
    categoria: classified.categoria,
  });
  
  await sendMessage(phone, `Registrado! R$ ${classified.valor.toFixed(2)} em ${classified.categoria}. 💰`);
}

// ====================== CONSULTA ======================
async function handleQuery(user, phone, question) {
  const memories = await memory.getRecentMemories(user.id, 30);

  if (memories.length === 0) {
    await sendMessage(phone, 'Ainda não guardei nada pra você. Me conta algo!');
    return;
  }

  const answer = await generateMemorySummary(memories, question);
  await sendMessage(phone, answer);
}

module.exports = { handleMessage };
