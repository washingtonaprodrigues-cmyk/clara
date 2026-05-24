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

function horaStr(date) {
  if (!date) return '—';
  const d = new Date(date);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ====================== HANDLER PRINCIPAL ======================
async function handleMessage(phone, text, location = null) {
  try {
    const user = await memory.getOrCreateUser(phone);

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

    if (!text) return;

    const classified = await classify(text);
    console.log(`[${phone}] Tipo: ${classified.tipo}`);

    switch (classified.tipo) {
      case 'ponto_multiplo':
        await handlePontoMultiplo(user, phone, classified.acoes, text);
        break;
      case 'cidade':
        await handleCidade(user, phone, classified.cidade);
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
        await handleSaudacao(user, phone);
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

// ====================== SAUDAÇÃO ======================
async function handleSaudacao(user, phone) {
  const cidade = await getCidadeUsuario(user.id);
  if (!cidade) {
    await sendMessage(phone, 'Oi! 😊 Para te ajudar melhor com clima e buscas locais, qual é a sua cidade?');
  } else {
    await sendMessage(phone, 'Oi! Tudo bem? Como posso te ajudar? 😊');
  }
}

async function getCidadeUsuario(userId) {
  const mems = await memory.getRecentMemories(userId, 50);
  const cidadeMem = mems.find(m => m.type === 'cidade');
  return cidadeMem ? cidadeMem.content : null;
}

// ====================== CIDADE ======================
async function handleCidade(user, phone, cidade) {
  await memory.saveMemory(user.id, 'cidade', cidade);
  await sendMessage(phone, `Anotei! 📍 Vou usar *${cidade}* para buscas locais.`);
}

// ====================== PONTO MÚLTIPLO ======================
async function handlePontoMultiplo(user, phone, acoes, originalText) {
  await sendMessage(phone, '📍 Registrando seus pontos...');

  const hoje = dateBRT();

  for (const acao of acoes) {
    let subtipo = (acao.subtipo || '').toLowerCase().trim();

    if (subtipo === 'entrada' || subtipo.includes('cheg') || subtipo.includes('entrei')) {
      subtipo = 'entrada';
    } else if (subtipo === 'saida_almoco' || subtipo.includes('saida_almoco') ||
      (subtipo.includes('almo') && (subtipo.includes('sai') || subtipo.includes('saí')))) {
      subtipo = 'saida_almoco';
    } else if (subtipo === 'volta_almoco' || subtipo.includes('volta_almoco') ||
      (subtipo.includes('almo') && (subtipo.includes('volt') || subtipo.includes('retorn')))) {
      subtipo = 'volta_almoco';
    } else if (subtipo === 'saida' || subtipo.includes('saí') || subtipo.includes('sai') || subtipo.includes('saida')) {
      subtipo = 'saida';
    }

    const horaUsada = acao.hora || 'agora';
    const timestamp = horaUsada !== 'agora' ? convertToDateWithTime(horaUsada) : nowBRT();

    const existing = await prisma.workLog.findFirst({
      where: { userId: user.id, type: subtipo, date: hoje }
    });

    if (existing) {
      await prisma.workLog.update({
        where: { id: existing.id },
        data: { timestamp }
      });
    } else {
      await prisma.workLog.create({
        data: { userId: user.id, type: subtipo, timestamp, date: hoje }
      });
    }
  }

  const pontosHoje = await prisma.workLog.findMany({
    where: { userId: user.id, date: hoje },
    orderBy: { timestamp: 'asc' }
  });

  const resumo = await gerarResumoDoBanco(pontosHoje, user.id);
  await sendMessage(phone, resumo);
}

function convertToDateWithTime(horaStr) {
  const [hora, min] = horaStr.split(':').map(Number);
  const date = nowBRT();
  date.setHours(hora, min || 0, 0, 0);
  return date;
}

async function gerarResumoDoBanco(pontos, userId) {
  const get = (tipo) => pontos.find(p => p.type === tipo);

  const entrada     = get('entrada');
  const saidaAlmoco = get('saida_almoco');
  const voltaAlmoco = get('volta_almoco');
  const saida       = get('saida');

  const jornada = await memory.getJornada(userId);

  let tempoManha = null;
  let tempoTarde = null;
  let totalTrabalhado = null;
  let horasExtras = null;

  if (entrada && saidaAlmoco) {
    tempoManha = (new Date(saidaAlmoco.timestamp) - new Date(entrada.timestamp)) / 60000;
  }

  if (voltaAlmoco && saida) {
    tempoTarde = (new Date(saida.timestamp) - new Date(voltaAlmoco.timestamp)) / 60000;
  }

  if (tempoManha !== null && tempoTarde !== null) {
    totalTrabalhado = tempoManha + tempoTarde;
    horasExtras = totalTrabalhado - jornada;
  }

  let texto = `✨ *Resumo do seu dia*\n\n`;
  texto += `🟢 Entrada: *${horaStr(entrada?.timestamp)}*\n`;
  texto += `🍽️ Saída almoço: *${horaStr(saidaAlmoco?.timestamp)}*\n`;

  if (tempoManha !== null) {
    texto += `⏱️ Manhã: *${minutesToHours(tempoManha)}*\n`;
  }

  texto += `🔄 Volta almoço: *${horaStr(voltaAlmoco?.timestamp)}*\n`;

  if (saida) {
    texto += `🔴 Saída: *${horaStr(saida.timestamp)}*\n`;
  }

  if (tempoTarde !== null) {
    texto += `⏱️ Tarde: *${minutesToHours(tempoTarde)}*\n`;
  }

  if (totalTrabalhado !== null) {
    texto += `\n📊 Total: *${minutesToHours(totalTrabalhado)}*\n`;
    if (horasExtras > 0) {
      texto += `⭐ Horas extras: *${minutesToHours(horasExtras)}*\n`;
    } else if (horasExtras < 0) {
      texto += `⚠️ Faltam: *${minutesToHours(Math.abs(horasExtras))}*\n`;
    } else {
      texto += `✅ Jornada completa!\n`;
    }
  }

  if (!saida) {
    texto += `\n💡 Me avisa quando sair!`;
  }

  return texto;
}

// ====================== BUSCA ======================
async function handleBusca(user, phone, query) {
  await sendMessage(phone, '🔍 Buscando...');

  const mems = await memory.getRecentMemories(user.id, 20);

  let locationText = '';

  // Tenta GPS primeiro
  const locationMem = mems.find(m => m.type === 'localizacao');
  if (locationMem) {
    try {
      const loc = JSON.parse(locationMem.content);
      locationText = `${loc.latitude}, ${loc.longitude}`;
    } catch (e) {}
  }

  // Se não tem GPS, usa cidade salva
  if (!locationText) {
    const cidadeMem = mems.find(m => m.type === 'cidade');
    if (cidadeMem) locationText = cidadeMem.content;
  }

  // Substitui referências vagas pela localização real
  let queryFinal = query;
  if (locationText) {
    queryFinal = query
      .replace(/minha cidade/gi, locationText)
      .replace(/aqui/gi, locationText)
      .replace(/perto de mim/gi, `perto de ${locationText}`)
      .replace(/próximo a mim/gi, `próximo a ${locationText}`);
  }

  const resultado = await searchWeb(queryFinal, locationText);
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
