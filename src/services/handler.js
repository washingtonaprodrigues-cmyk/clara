const { classify, classifyConversation, generateMemorySummary } = require('./groq');
const { sendMessage } = require('./whatsapp');
const memory = require('./memory');

async function handleMessage(phone, text) {
  try {
    const user = await memory.getOrCreateUser(phone);

    // Verifica se há conversa em andamento
    const conv = await memory.getConversation(user.id);
    if (conv) {
      return await handleConversationStep(user, phone, text, conv);
    }

    // Classifica nova mensagem
    const classified = await classify(text);
    console.log(`[${phone}] Tipo: ${classified.tipo}`);

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

async function handleConversationStep(user, phone, text, conv) {
  // Implementar se precisar de fluxos multi-etapas
  return;
}

async function handleNote(user, phone, classified) {
  await memory.saveMemory(user.id, 'anotacao', classified.conteudo, { 
    titulo: classified.titulo 
  });
  await sendMessage(phone, classified.resposta);
}

async function handleTask(user, phone, classified) {
  await memory.saveMemory(user.id, 'tarefa', classified.titulo, {
    data: classified.data,
    hora: classified.hora,
  });
  await sendMessage(phone, classified.resposta);
}

async function handleExpense(user, phone, classified) {
  await memory.saveMemory(user.id, 'gasto', classified.descricao, {
    valor: classified.valor,
    categoria: classified.categoria,
  });
  await sendMessage(phone, classified.resposta);
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

module.exports = { handleMessage };
