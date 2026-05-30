const { processMessage, searchWeb } = require('./groq');
const { sendMessage, sendButtons, sendMainMenu } = require('./whatsapp');
const memory = require('./memory');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function dateBRT() {
  const d = nowBRT();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function amanhaBRT() {
  const d = nowBRT();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function criarDataBRT(dataStr, horaStr) {
  return new Date(`${dataStr}T${horaStr.padStart(5,'0')}:00-03:00`);
}

function horaStr(date) {
  if (!date) return '—';
  const d = new Date(date);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function minutesToHours(min) {
  const h = Math.floor(min/60), m = min%60;
  return `${h}h${m > 0 ? m+'min' : ''}`;
}

function formatarDataBR(date) {
  if (!date) return '—';
  const d = new Date(date);
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}

async function handleMessage(phone, text, location = null) {
  try {
    const user = await memory.getOrCreateUser(phone);

    if (location && location.latitude) {
      await memory.saveMemory(user.id, 'localizacao',
        JSON.stringify({ latitude: location.latitude, longitude: location.longitude })
      );
      await memory.saveConversationMessage(user.id, 'user', '📍 [compartilhou localização]');
      await memory.saveConversationMessage(user.id, 'assistant', 'Localização recebida! Agora posso te ajudar com buscas locais 😊');
      return await sendMessage(phone, 'Localização recebida! Agora posso te ajudar com buscas locais 😊');
    }

    if (!text) return;

    const textLower = text.trim().toLowerCase();
    if (['menu', 'ajuda', 'opcoes', 'opções'].includes(textLower)) {
      return await sendMainMenu(phone);
    }

    const context = await buildContext(user);
    const history = await memory.getConversationHistory(user.id, 12);
    const response = await processMessage(text, history, context);
    const { cleanResponse, actions } = parseActions(response);

    for (const action of actions) {
      await executeAction(user, phone, action).catch(e =>
        console.error('Erro action:', action.type, e.message)
      );
    }

    let finalResponse = cleanResponse;
    const buscaAction = actions.find(a => a.type === 'BUSCA');
    if (buscaAction) {
      const locationText = context.cidade || '';
      const resultado = await searchWeb(buscaAction.data, locationText);
      finalResponse = cleanResponse.replace(/\[buscando.*?\]/gi, resultado.text);
      if (!finalResponse.includes(resultado.text)) {
        finalResponse = resultado.text;
      }
      if (resultado.sourceUrl) finalResponse += `\n\n🔗 ${resultado.sourceUrl}`;
    }

    await memory.saveConversationMessage(user.id, 'user', text);
    await memory.saveConversationMessage(user.id, 'assistant', finalResponse);
    await sendMessage(phone, finalResponse);

  } catch (error) {
    console.error('Erro handleMessage:', error.message);
    await sendMessage(phone, 'Tive um probleminha aqui. Pode repetir? 😊');
  }
}

async function buildContext(user) {
  try {
    const agora = nowBRT();
    const mems = await memory.getRecentMemories(user.id, 30);

    const cidadeMem = mems.find(m => m.type === 'cidade');
    const locMem = mems.find(m => m.type === 'localizacao');
    let cidade = cidadeMem?.content || '';
    if (!cidade && locMem) {
      try {
        const loc = JSON.parse(locMem.content);
        cidade = `${loc.latitude},${loc.longitude}`;
      } catch {}
    }

    const lembretes = await prisma.reminder.findMany({
      where: { userId: user.id, sent: false, confirmed: false, scheduledAt: { gte: agora } },
      orderBy: { scheduledAt: 'asc' },
      take: 5,
    });

    const medicamentos = await prisma.medication.findMany({
      where: { userId: user.id, active: true, remaining: { gt: 0 } },
      take: 5,
    });

    const anotacoes = mems.filter(m => m.type === 'anotacao').slice(0, 5);

    const inicioMes = new Date(agora.getFullYear(), agora.getMonth(), 1);
    const gastos = await prisma.expense.findMany({
      where: { userId: user.id, createdAt: { gte: inicioMes } }
    });
    const gastosMes = gastos.reduce((acc, g) => acc + g.value, 0);

    return {
      nome: user.name || null,
      cidade,
      lembretes,
      medicamentos,
      anotacoes,
      gastosMes: gastosMes > 0 ? gastosMes : null,
    };
  } catch (e) {
    console.error('Erro buildContext:', e.message);
    return {};
  }
}

const TIPOS = ['LEMBRETE', 'PONTO', 'ANOTACAO', 'GASTO', 'MEDICAMENTO', 'BUSCA', 'CIDADE'];

function parseActions(response) {
  const actions = [];
  const actionRegex = /<action>([\s\S]*?)<\/action>/gi;
  let match;

  while ((match = actionRegex.exec(response)) !== null) {
    const content = match[1].trim();
    if (!content) continue;
    const pipeIdx = content.indexOf('|');
    if (pipeIdx === -1) continue;
    const type = content.substring(0, pipeIdx).trim().toUpperCase();
    const data = content.substring(pipeIdx + 1).trim();
    if (type && data) actions.push({ type, data });
  }

  // Captura formato cru que modelos menores cospe: PONTO|dados::dados
  const rawRegex = new RegExp(`(${TIPOS.join('|')})\\|([^\\n<]+)`, 'gi');
  let rawMatch;
  while ((rawMatch = rawRegex.exec(response)) !== null) {
    const type = rawMatch[1].toUpperCase();
    const data = rawMatch[2].trim();
    const jaTem = actions.some(a => a.type === type && a.data === data);
    if (!jaTem) actions.push({ type, data });
  }

  let cleanResponse = response
    .replace(/<action>[\s\S]*?<\/action>/gi, '')
    .replace(/<action>[\s\S]*/gi, '')
    .replace(new RegExp(`(${TIPOS.join('|')})\\|[^\\n]+`, 'gi'), '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '')
    .trim();

  return { cleanResponse, actions };
}

async function executeAction(user, phone, action) {
  const { type, data } = action;

  switch (type) {
    case 'LEMBRETE': {
      const parts = data.split('::');
      const titulo = parts[0];
      const hora = parts[1] || '07:00';
      const dataStr = parts[2] || amanhaBRT();
      const scheduledAt = criarDataBRT(dataStr, hora);
      await prisma.reminder.create({
        data: { userId: user.id, phone, message: titulo, scheduledAt }
      });
      await memory.saveMemory(user.id, 'tarefa', titulo, { hora, data: dataStr });
      break;
    }

    case 'PONTO': {
      const parts = data.split('::');
      const subtipo = parts[0];
      const hora = parts[1] || horaStr(nowBRT());
      const hoje = dateBRT();
      const timestamp = new Date(`${hoje}T${hora.padStart(5,'0')}:00-03:00`);
      const existing = await prisma.workLog.findFirst({
        where: { userId: user.id, type: subtipo, date: hoje }
      });
      if (existing) {
        await prisma.workLog.update({ where: { id: existing.id }, data: { timestamp } });
      } else {
        await prisma.workLog.create({ data: { userId: user.id, type: subtipo, timestamp, date: hoje } });
      }
      break;
    }

    case 'ANOTACAO': {
      await memory.saveMemory(user.id, 'anotacao', data, { titulo: data.substring(0, 50) });
      break;
    }

    case 'GASTO': {
      const parts = data.split('::');
      const valor = parseFloat(parts[0]) || 0;
      const categoria = parts[1] || 'outro';
      const descricao = parts[2] || categoria;
      await memory.saveExpense(user.id, { valor, categoria, descricao });
      break;
    }

    case 'MEDICAMENTO': {
      const parts = data.split('::');
      const nome = parts[0];
      const dose = parts[1] || '1 comprimido';
      const intervalo = parseInt(parts[2]) || 8;
      const dias = parseInt(parts[3]) || 7;
      const horaInicio = parts[4] || '08:00';
      const freqDia = Math.round(24 / intervalo);
      const [h, m] = horaInicio.split(':').map(Number);
      const horarios = [];
      for (let i = 0; i < freqDia; i++) {
        const hh = (h + i * intervalo) % 24;
        horarios.push(`${String(hh).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
      }
      const totalDoses = dias * freqDia;
      await memory.saveMedication(user.id, {
        nome, quantidade: totalDoses, frequencia: freqDia, horarios
      });
      break;
    }

    case 'CIDADE': {
      await memory.saveMemory(user.id, 'cidade', data);
      break;
    }

    case 'BUSCA':
      break;
  }
}

module.exports = { handleMessage };
