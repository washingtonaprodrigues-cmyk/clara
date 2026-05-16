const { classify, generateMemorySummary } = require('../services/groq');
const { sendMessage } = require('../services/whatsapp');
const memory = require('../services/memory');

async function handleMessage(phone, text) {
  try {
    const user = await memory.getOrCreateUser(phone);
    const classified = await classify(text);
    console.log(`[${phone}] Tipo: ${classified.tipo}`, classified);

    switch (classified.tipo) {
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
        await sendMessage(phone, classified.resposta);
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

    if (task.items) {
      msg += `\n• Levar: ${task.items}`;
    }

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
