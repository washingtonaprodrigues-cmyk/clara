const { classify, generateMemorySummary } = require('./groq');
const { sendMessage, sendButtons } = require('./whatsapp');
const memory = require('./memory');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ─────────────────────────────────────────────
// PARSE DE DATAS RELATIVAS — fuso Brasília
// ─────────────────────────────────────────────
function parseRelativeDate(text) {
  if (!text) return null;
  const t = text.toLowerCase().trim();

  const nowUTC = new Date();
  const nowBRT = new Date(nowUTC.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const today = new Date(nowBRT);
  today.setHours(12, 0, 0, 0);

  if (t.includes('hoje')) return today;
  if (t.includes('amanhã') || t.includes('amanha')) {
    const d = new Date(today); d.setDate(d.getDate() + 1); return d;
  }

  const dias = {
    'domingo': 0, 'segunda': 1, 'terça': 2, 'terca': 2,
    'quarta': 3, 'quinta': 4, 'sexta': 5, 'sábado': 6, 'sabado': 6,
  };
  for (const [nome, num] of Object.entries(dias)) {
    if (t.includes(nome)) {
      const d = new Date(today);
      let diff = num - d.getDay();
      if (diff <= 0) diff += 7;
      d.setDate(d.getDate() + diff);
      if (t.includes('semana que vem') || t.includes('próxima') || t.includes('proxima')) {
        d.setDate(d.getDate() + 7);
      }
      return d;
    }
  }

  if (t.includes('semana que vem')) {
    const d = new Date(today);
    const diff = (1 - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + diff);
    return d;
  }

  if (t.includes('próximo mês') || t.includes('proximo mes')) {
    const d = new Date(today); d.setDate(d.getDate() + 30); return d;
  }

  const emDias = t.match(/em (\d+) dias?/);
  if (emDias) {
    const d = new Date(today); d.setDate(d.getDate() + parseInt(emDias[1])); return d;
  }

  const diaSlash = t.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (diaSlash) {
    const dia = parseInt(diaSlash[1]);
    const mes = parseInt(diaSlash[2]) - 1;
    let ano = diaSlash[3] ? parseInt(diaSlash[3]) : nowBRT.getFullYear();
    if (ano < 100) ano += 2000;
    const d = new Date(ano, mes, dia, 12, 0, 0);
    return isNaN(d.getTime()) ? null : d;
  }

  const diaNum = t.match(/dia (\d{1,2})/);
  if (diaNum) {
    const dia = parseInt(diaNum[1]);
    const d = new Date(nowBRT.getFullYear(), nowBRT.getMonth(), dia, 12, 0, 0);
    if (d < nowBRT) d.setMonth(d.getMonth() + 1);
    return d;
  }

  return null;
}

function parseHora(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  let match;
  match = t.match(/(\d{1,2}):(\d{2})/);
  if (match) return `${match[1].padStart(2, '0')}:${match[2]}`;
  match = t.match(/(\d{1,2})h(\d{2})/);
  if (match) return `${match[1].padStart(2, '0')}:${match[2]}`;
  match = t.match(/(\d{1,2})\s*h(?:oras?)?(?!\d)/);
  if (match) return `${match[1].padStart(2, '0')}:00`;
  return null;
}

function formatDate(date) {
  if (!date) return null;
  return new Date(date).toLocaleDateString('pt-BR', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
    timeZone: 'America/Sao_Paulo',
  });
}

// Detecta ações por texto livre (para quando não há botões reais)
function detectarAcaoTexto(text) {
  const t = text.toLowerCase().trim();
  if (/^(excluir|deletar|apagar|remove|remover)$/i.test(t)) return 'excluir';
  if (/^(concluir|conclu[íi]do|feito|fiz|ok|done|✅)$/i.test(t)) return 'concluir';
  if (/^(confirmar|confirmado|sim|tomei|tomado)$/i.test(t)) return 'confirmar';
  return null;
}

// ─────────────────────────────────────────────
// HANDLER PRINCIPAL
// ─────────────────────────────────────────────
async function handleMessage(phone, text) {
  try {
    const user = await memory.getOrCreateUser(phone);

    // Resposta de botão real (Z-API)
    if (text.startsWith('__btn__')) {
      return await handleButtonAction(user, phone, text);
    }

    // Ação por texto livre ("excluir", "feito", etc.)
    const acaoTexto = detectarAcaoTexto(text);
    if (acaoTexto) {
      return await handleAcaoTexto(user, phone, acaoTexto);
    }

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
      case 'consulta':
        await handleQuery(user, phone, text);
        break;
      case 'saudacao':
        await sendMessage(phone, classified.resposta);
        break;
      default:
        await sendMessage(phone, classified.resposta || 'Entendi! ✓');
    }
  } catch (error) {
    console.error('Erro handleMessage:', error.message);
    console.error('Stack:', error.stack);
    await sendMessage(phone, 'Ops, tive um probleminha aqui. Pode repetir?');
  }
}

// ─────────────────────────────────────────────
// AÇÃO POR TEXTO LIVRE — age na última tarefa/lembrete
// ─────────────────────────────────────────────
async function handleAcaoTexto(user, phone, acao) {
  if (acao === 'excluir' || acao === 'concluir') {
    // Última tarefa não concluída
    const task = await prisma.task.findFirst({
      where: { userId: user.id, done: false },
      orderBy: { createdAt: 'desc' },
    });
    if (task) {
      await prisma.task.update({ where: { id: task.id }, data: { done: true } });
      const msg = acao === 'concluir'
        ? `✅ *${task.title}* marcada como concluída! Mandou bem.`
        : `🗑️ *${task.title}* removida!`;
      await sendMessage(phone, msg);
      return;
    }
  }

  if (acao === 'excluir') {
    // Último lembrete não enviado
    const reminder = await prisma.reminder.findFirst({
      where: { userId: user.id, sent: false },
      orderBy: { createdAt: 'desc' },
    });
    if (reminder) {
      await prisma.reminder.delete({ where: { id: reminder.id } });
      await sendMessage(phone, `🗑️ Lembrete removido!`);
      return;
    }
  }

  if (acao === 'confirmar') {
    const reminder = await prisma.reminder.findFirst({
      where: { userId: user.id, sent: true, confirmed: false },
      orderBy: { createdAt: 'desc' },
    });
    if (reminder) {
      await prisma.reminder.update({ where: { id: reminder.id }, data: { confirmed: true } });
      await sendMessage(phone, `✅ Ótimo! Marcado como feito.`);
      return;
    }
  }

  await sendMessage(phone, 'Não encontrei nada recente pra isso. Pode me dar mais detalhes?');
}

// ─────────────────────────────────────────────
// AÇÕES DE BOTÃO REAL
// ─────────────────────────────────────────────
async function handleButtonAction(user, phone, text) {
  const parts = text.split('__').filter(Boolean);
  const action = parts[1];
  const id = parts[2];

  if (action === 'excluir_reminder') {
    await prisma.reminder.delete({ where: { id } }).catch(() => {});
    await sendMessage(phone, '🗑️ Pronto, excluído!');
    return;
  }
  if (action === 'confirmar_reminder') {
    await prisma.reminder.update({ where: { id }, data: { confirmed: true, sent: true } }).catch(() => {});
    await sendMessage(phone, '✅ Marcado como feito!');
    return;
  }
  if (action === 'excluir_task') {
    await prisma.task.update({ where: { id }, data: { done: true } }).catch(() => {});
    await sendMessage(phone, '🗑️ Tarefa removida!');
    return;
  }
  if (action === 'concluir_task') {
    await prisma.task.update({ where: { id }, data: { done: true } }).catch(() => {});
    await sendMessage(phone, '✅ Tarefa concluída! Mandou bem.');
    return;
  }
  if (action === 'excluir_expense') {
    await prisma.expense.delete({ where: { id } }).catch(() => {});
    await sendMessage(phone, '🗑️ Gasto removido!');
    return;
  }
  if (action === 'recorrente_sim') {
    const reminder = await prisma.reminder.findUnique({ where: { id } }).catch(() => null);
    if (reminder) {
      await memory.saveMemory(user.id, 'lembrete_recorrente', reminder.message, {
        hora: reminder.scheduledAt ? new Date(reminder.scheduledAt).toTimeString().slice(0, 5) : null,
      });
      await sendMessage(phone, '🔁 Vou te lembrar disso todo dia no mesmo horário.');
    } else {
      await sendMessage(phone, 'Não encontrei esse lembrete. Pode repetir?');
    }
    return;
  }

  await sendMessage(phone, 'Não entendi essa ação. Pode repetir?');
}

// ─────────────────────────────────────────────
// HANDLERS DE TIPO
// ─────────────────────────────────────────────
async function handleNote(user, phone, classified) {
  await memory.saveMemory(user.id, 'anotacao', classified.conteudo, { titulo: classified.titulo });
  const msg = `📝 *Anotado aqui comigo!*\n\n*${classified.titulo}*\n${classified.conteudo}`;
  await sendButtons(phone, msg, [
    { id: `__btn__excluir_note__${user.id}`, label: '🗑️ Excluir' },
  ]);
}

async function handleTask(user, phone, classified, originalText) {
  // Data: tenta texto original primeiro (mais confiável), fallback Groq com correção de ano
  let dueDate = parseRelativeDate(originalText);

  if (!dueDate && classified.data && classified.data !== 'null') {
    const parsed = new Date(classified.data);
    if (!isNaN(parsed.getTime())) {
      const nowBRT = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
      if (parsed.getFullYear() < nowBRT.getFullYear()) {
        parsed.setFullYear(nowBRT.getFullYear());
      }
      dueDate = parsed;
    }
  }

  if (dueDate) dueDate.setHours(12, 0, 0, 0);

  // Hora: texto original primeiro, fallback Groq
  let horaFinal = parseHora(originalText);
  if (!horaFinal && classified.hora && classified.hora !== 'null') {
    horaFinal = classified.hora;
  }

  const task = await prisma.task.create({
    data: {
      userId: user.id,
      title: classified.titulo,
      dueDate: dueDate || null,
      dueTime: horaFinal || null,
    },
  });

  // Cria Reminder para o job disparar
  if (dueDate && horaFinal) {
    const [h, m] = horaFinal.split(':').map(Number);
    const scheduledAt = new Date(dueDate);
    scheduledAt.setHours(h, m, 0, 0);
    if (scheduledAt > new Date()) {
      await prisma.reminder.create({
        data: {
          userId: user.id,
          phone: user.phone,
          message: classified.titulo,
          scheduledAt,
          sent: false,
          confirmed: false,
          attempts: 0,
        },
      });
    }
  }

  let msg = `✅ *Tarefa criada!*\n\n`;
  msg += `📋 ${classified.titulo}\n`;
  if (dueDate) msg += `📅 ${formatDate(dueDate)}\n`;
  if (horaFinal) msg += `🕐 ${horaFinal}\n`;
  msg += `\nVou te avisar na hora certa! 📣`;

  await sendButtons(phone, msg, [
    { id: `__btn__concluir_task__${task.id}`, label: '✅ Concluir' },
    { id: `__btn__excluir_task__${task.id}`, label: '🗑️ Excluir' },
  ]);
}

async function handleExpense(user, phone, classified) {
  const expense = await prisma.expense.create({
    data: {
      userId: user.id,
      value: parseFloat(classified.valor) || 0,
      category: classified.categoria || 'outro',
      description: classified.descricao || '',
    },
  });
  await memory.saveMemory(user.id, 'gasto', classified.descricao, {
    valor: classified.valor,
    categoria: classified.categoria,
  });

  const valorFormatado = Number(classified.valor).toLocaleString('pt-BR', {
    style: 'currency', currency: 'BRL',
  });
  const msg =
    `💰 *Saída registrada!*\n\n` +
    `📝 ${classified.descricao}\n` +
    `💵 ${valorFormatado}\n` +
    `📂 Categoria: ${classified.categoria}\n` +
    `📅 ${new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}\n\n` +
    `Quer lançar mais algum gasto?`;

  await sendButtons(phone, msg, [
    { id: `__btn__excluir_expense__${expense.id}`, label: '🗑️ Excluir' },
  ]);
}

async function handleQuery(user, phone, question) {
  const memories = await memory.getRecentMemories(user.id, 30);
  if (memories.length === 0) {
    await sendMessage(phone, 'Ainda não guardei nada pra você. Me conta algo!');
    return;
  }
  const answer = await generateMemorySummary(memories, question);
  await sendMessage(phone, answer);
}

async function sendReminderWithButtons(phone, message, reminderId) {
  const msg = `🔔 *Lembrete!*\n\n${message}`;
  await sendButtons(phone, msg, [
    { id: `__btn__confirmar_reminder__${reminderId}`, label: '✅ Feito!' },
    { id: `__btn__excluir_reminder__${reminderId}`, label: '🗑️ Excluir' },
  ]);
}

module.exports = { handleMessage, sendReminderWithButtons };
