const memory = require('./memory');

// ============================================
// HANDLER PRINCIPAL
// ============================================

async function handleMessage({
  user,
  phone,
  message,
  classified,
  sendMessage,
}) {
  try {
    switch (classified.tipo) {

      // ============================================
      // ANOTAÇÕES
      // ============================================

      case 'anotacao':
        await handleNote(user, phone, classified, sendMessage);
        break;

      // ============================================
      // TAREFAS / LEMBRETES
      // ============================================

      case 'tarefa':
        await handleTask(user, phone, classified, sendMessage);
        break;

      // ============================================
      // GASTOS
      // ============================================

      case 'gasto':
        await handleExpense(user, phone, classified, sendMessage);
        break;

      // ============================================
      // CONSULTAS
      // ============================================

      case 'consulta':
        await handleQuery(user, phone, classified, sendMessage);
        break;

      // ============================================
      // SAUDAÇÕES
      // ============================================

      case 'saudacao':
        await sendMessage(phone, classified.resposta);
        break;

      // ============================================
      // OUTROS
      // ============================================

      default:
        await sendMessage(
          phone,
          classified.resposta || 'Entendi! ✓'
        );
    }

  } catch (error) {
    console.error('Erro handler:', error);

    await sendMessage(
      phone,
      'Tive um probleminha aqui 😅 Mas já continuo com você.'
    );
  }
}

// ============================================
// HANDLE NOTE
// ============================================

async function handleNote(
  user,
  phone,
  classified,
  sendMessage
) {
  try {

    await memory.saveMemory(
      user.id,
      'anotacao',
      classified.conteudo,
      {
        titulo: classified.titulo,
        createdAt: new Date().toISOString(),
      }
    );

    await sendMessage(
      phone,
      classified.resposta ||
      'Anotado! ✓ Guardei aqui comigo.'
    );

  } catch (error) {
    console.error('Erro handleNote:', error);

    await sendMessage(
      phone,
      'Tentei guardar isso aqui mas deu um probleminha 😕'
    );
  }
}

// ============================================
// HANDLE TASK
// ============================================

async function handleTask(
  user,
  phone,
  classified,
  sendMessage
) {
  try {

    await memory.saveMemory(
      user.id,
      'tarefa',
      classified.titulo,
      {
        data: classified.data,
        hora: classified.hora,
        createdAt: new Date().toISOString(),
      }
    );

    // Aqui você pode integrar futuramente:
    // - agenda
    // - cron
    // - notificações
    // - whatsapp reminders

    await sendMessage(
      phone,
      classified.resposta ||
      'Guardei aqui comigo 📅'
    );

  } catch (error) {
    console.error('Erro handleTask:', error);

    await sendMessage(
      phone,
      'Não consegui organizar isso agora 😕'
    );
  }
}

// ============================================
// HANDLE EXPENSE
// ============================================

async function handleExpense(
  user,
  phone,
  classified,
  sendMessage
) {
  try {

    await memory.saveMemory(
      user.id,
      'gasto',
      classified.descricao,
      {
        valor: classified.valor,
        categoria: classified.categoria,
        createdAt: new Date().toISOString(),
      }
    );

    await sendMessage(
      phone,
      classified.resposta ||
      'Registrado 💰'
    );

  } catch (error) {
    console.error('Erro handleExpense:', error);

    await sendMessage(
      phone,
      'Não consegui registrar esse gasto 😕'
    );
  }
}

// ============================================
// HANDLE QUERY
// ============================================

async function handleQuery(
  user,
  phone,
  classified,
  sendMessage
) {
  try {

    const memories = await memory.searchMemories(
      user.id,
      classified.sobre
    );

    if (!memories || memories.length === 0) {
      await sendMessage(
        phone,
        'Procurei aqui mas não encontrei nada sobre isso 🥲'
      );

      return;
    }

    const formatted = memories
      .slice(0, 5)
      .map((m, index) => {
        return `${index + 1}. ${m.content}`;
      })
      .join('\n');

    await sendMessage(
      phone,
      `Tenho isso guardado aqui:\n\n${formatted}`
    );

  } catch (error) {
    console.error('Erro handleQuery:', error);

    await sendMessage(
      phone,
      'Tive dificuldade pra procurar isso agora 😕'
    );
  }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  handleMessage,
  handleNote,
  handleTask,
  handleExpense,
  handleQuery,
};
