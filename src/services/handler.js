const { classify, generateMemorySummary } = require('../services/groq');
const { sendMessage } = require('../services/whatsapp');
const memory = require('../services/memory');

async function handleMessage(phone, text) {
  try {
    const user = await memory.getOrCreateUser(phone);
    const classified = await classify(text);
    console.log(`[${phone}] Tipo: ${classified.tipo}`, classified);

    switch (classified.tipo) {
      case 'reminder':
        await handleReminder(user, phone, classified);
        break;
      case 'remedio':
        await handleMedication(user, phone, classified);
        break;
      case 'compra':
        await handlePurchase(user, phone, classified);
        break;
      case 'tarefa':
        await handleTask(user, phone, classified);
        break;
      case 'gasto':
        await handleExpense(user, phone, classified);
        break;
      case 'segredo':
        await handleSecret(user, phone, classified);
        break;
      case 'consulta_memoria':
        await handleMemoryQuery(user, phone, text);
        break;
      case 'pressao':
      case 'glicemia':
      case 'humor':
        await handleHealth(user, phone, classified);
        break;
      case 'confirmacao':
        await handleConfirmacao(user, phone, classified);
        break;
      case 'saudacao':
        await sendMessage(phone, classified.resposta);
        break;
      default:
        await sendMessage(phone, classified.resposta || 'Estou aqui! 💛');
    }
  } catch (error) {
    console.error('Erro handleMessage:', error);
    await sendMessage(phone, 'Ops, tive um probleminha aqui. Pode repetir, meu bem? 💛');
  }
}

async function handleReminder(user, phone, data) {
  try {
    let scheduledAt;

    if (data.minutos_relativos && data.minutos_relativos > 0) {
      // Daqui a X minutos
      scheduledAt = new Date(Date.now() + data.minutos_relativos * 60000);
    } else if (data.hora) {
      // Horário específico hoje
      const [horas, minutos] = data.hora.split(':').map(Number);
      scheduledAt = new Date();
      scheduledAt.setHours(horas, minutos, 0, 0);

      // Se o horário já passou hoje, agenda pro dia seguinte
      if (scheduledAt < new Date()) {
        scheduledAt.setDate(scheduledAt.getDate() + 1);
      }
    } else {
      // Fallback: 5 minutos
      scheduledAt = new Date(Date.now() + 5 * 60000);
    }

    await memory.prisma.reminder.create({
      data: {
        userId: user.id,
        phone,
        message: `⏰ Lembrete: *${data.mensagem}*\n\nJá fez isso? Me confirma aqui! 💛`,
        scheduledAt,
        attempts: 0,
      },
    });

    const horarioStr = scheduledAt.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    });

    await sendMessage(phone, `${data.resposta}\n\n⏰ Vou te avisar às ${horarioStr}! 💛`);
    console.log(`⏰ Reminder criado para ${phone} às ${scheduledAt}`);
  } catch (error) {
    console.error('Erro handleReminder:', error);
    await sendMessage(phone, 'Anoetei o lembrete, meu bem! 💛');
  }
}

async function handleConfirmacao(user, phone, data) {
  try {
    // Marca reminders pendentes como confirmados
    await memory.prisma.reminder.updateMany({
      where: {
        userId: user.id,
        confirmed: false,
        sent: false,
      },
      data: { confirmed: true, sent: true },
    });
    await sendMessage(phone, data.resposta);
  } catch (error) {
    await sendMessage(phone, data.resposta);
  }
}

async function handleMedication(user, phone, data) {
  const med = await memory.saveMedication(user.id, data);
  const daysTotal = Math.floor((data.quantidade || 0) / (data.frequencia || 1));
  const horariosText = (data.horarios || ['08:00']).join(' e ');

  let msg = `${data.resposta}\n\n💊 *${data.nome}*\n• ${data.frequencia}x por dia — ${horariosText}\n• ${data.quantidade} comprimidos — acaba em ~${daysTotal} dias\n\nVou te lembrar nos horários certinhos! 💛`;
  await sendMessage(phone, msg);
}

async function handlePurchase(user, phone, data) {
  const result = await memory.savePurchase(user.id, data.item);
  let msg = data.resposta;
  if (result.isRecurring && result.daysSinceLast) {
    msg += `\n\n🔄 É a ${result.purchase.buyCount}ª vez que você compra ${data.item}.`;
  }
  await sendMessage(phone, msg);
}

async function handleTask(user, phone, data) {
  const task = await memory.saveTask(user.id, data);
  let msg = data.resposta;

  if (task.dueDate) {
    const dateStr = new Date(task.dueDate).toLocaleDateString('pt-BR');
    const timeStr = task.dueTime ? ` às ${task.dueTime}` : '';
    msg += `\n\n📅 *${data.titulo}*\n• ${dateStr}${timeStr}`;
    if (task.items) msg += `\n• Levar: ${task.items}`;
    msg += `\n\nVou te lembrar antes! 💛`;
  }

  await sendMessage(phone, msg);
}

async function handleExpense(user, phone, data) {
  await memory.saveExpense(user.id, data);
  const expenses = await memory.getMonthExpenses(user.id);
  const total = expenses.reduce((sum, e) => sum + e.value, 0);
  let msg = data.resposta;
  msg += `\n\n💰 Total gasto este mês: *R$ ${total.toFixed(2)}*`;
  await sendMessage(phone, msg);
}

async function handleSecret(user, phone, data) {
  await memory.saveSecret(user.id, data);
  const msg = `${data.resposta}\n\n🔒 Guardado com carinho. Só você tem acesso.`;
  await sendMessage(phone, msg);
}

async function handleHealth(user, phone, data) {
  await memory.saveHealthRecord(user.id, data.tipo, data);
  await sendMessage(phone, data.resposta);
}

async function handleMemoryQuery(user, phone, question) {
  const memories = await memory.getRecentMemories(user.id, 30);
  if (memories.length === 0) {
    await sendMessage(phone, 'Ainda não guardei nada pra você, meu bem. Me conta algo! 💛');
    return;
  }
  const answer = await generateMemorySummary(memories, question);
  await sendMessage(phone, answer);
}

module.exports = { handleMessage };
