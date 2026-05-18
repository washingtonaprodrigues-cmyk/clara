const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ============================================
// HELPERS
// ============================================

function parseDateSafely(date) {
  if (!date) return null;

  const d = new Date(date);

  if (isNaN(d.getTime())) return null;

  return d;
}

function normalizeText(text = '') {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// ============================================
// USER
// ============================================

async function getOrCreateUser(phone) {
  let user = await prisma.user.findUnique({
    where: { phone },
  });

  if (!user) {
    user = await prisma.user.create({
      data: { phone },
    });

    console.log(`Nova usuária da Clara: ${phone}`);
  }

  return user;
}

async function saveUserPreference(userId, name, tom) {
  const data = {};

  if (name) data.name = name;

  if (tom) {
    data.metadata = JSON.stringify({ tom });
  }

  return prisma.user.update({
    where: { id: userId },
    data,
  });
}

async function getUserPreference(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    return {
      name: null,
      tom: 'carinhoso',
    };
  }

  let tom = 'carinhoso';

  if (user.metadata) {
    try {
      tom = JSON.parse(user.metadata).tom || 'carinhoso';
    } catch (e) {}
  }

  return {
    name: user.name,
    tom,
  };
}

// ============================================
// MEMORY
// ============================================

async function saveMemory(userId, type, content, metadata = null) {
  return prisma.memory.create({
    data: {
      userId,
      type,
      content,
      metadata: metadata ? JSON.stringify(metadata) : null,
    },
  });
}

async function getRecentMemories(userId, limit = 20) {
  return prisma.memory.findMany({
    where: {
      userId,
      type: {
        not: 'conversa',
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
    take: limit,
  });
}

// ============================================
// CONVERSAS
// ============================================

async function saveConversationMessage(userId, role, content) {
  await prisma.memory.create({
    data: {
      userId,
      type: 'conversa',
      content: JSON.stringify({
        role,
        content,
        ts: Date.now(),
      }),
    },
  });

  // Mantém somente últimas 30 mensagens
  const msgs = await prisma.memory.findMany({
    where: {
      userId,
      type: 'conversa',
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  if (msgs.length > 30) {
    const toDelete = msgs.slice(30).map((m) => m.id);

    await prisma.memory.deleteMany({
      where: {
        id: {
          in: toDelete,
        },
      },
    });
  }
}

async function getConversationHistory(userId, limit = 12) {
  const msgs = await prisma.memory.findMany({
    where: {
      userId,
      type: 'conversa',
    },
    orderBy: {
      createdAt: 'desc',
    },
    take: limit,
  });

  return msgs
    .reverse()
    .map((m) => {
      try {
        const parsed = JSON.parse(m.content);

        return {
          role: parsed.role,
          content: parsed.content,
        };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
}

// ============================================
// TASKS
// ============================================

async function saveTask(userId, data) {
  const {
    titulo,
    data: date,
    hora,
    itens,
  } = data;

  let dueDate = null;

  if (date && date !== 'null') {
    dueDate = parseDateSafely(date);

    if (dueDate) {
      // força meio-dia para evitar bug de timezone
      dueDate.setHours(12, 0, 0, 0);
    }
  }

  const task = await prisma.task.create({
    data: {
      userId,
      title: titulo,
      dueDate,
      dueTime:
        hora && hora !== 'null'
          ? hora
          : null,
      items:
        itens && itens !== 'null'
          ? itens
          : null,
    },
  });

  await saveMemory(
    userId,
    'compromisso',
    titulo,
    {
      taskId: task.id,
      date,
      hora,
      itens,
    }
  );

  return task;
}

// ============================================
// MEDICATIONS
// ============================================

async function saveMedication(userId, data) {
  const {
    nome,
    quantidade,
    frequencia,
    horarios,
  } = data;

  await prisma.medication.updateMany({
    where: {
      userId,
      active: true,
      name: {
        contains: nome,
        mode: 'insensitive',
      },
    },
    data: {
      active: false,
    },
  });

  const med = await prisma.medication.create({
    data: {
      userId,
      name: nome,
      totalPills: quantidade || 0,
      remaining: quantidade || 0,
      frequency: frequencia || 1,
      times: JSON.stringify(horarios || ['08:00']),
    },
  });

  await saveMemory(
    userId,
    'remedio',
    `${nome} - ${frequencia}x por dia`,
    {
      medId: med.id,
    }
  );

  return med;
}

// ============================================
// PURCHASES
// ============================================

async function savePurchase(userId, item) {
  const normalizedItem = normalizeText(item);

  const purchases = await prisma.purchase.findMany({
    where: { userId },
  });

  const existing = purchases.find((p) =>
    normalizeText(p.item).includes(normalizedItem)
  );

  if (existing) {
    const daysSinceLast = Math.floor(
      (Date.now() - existing.lastBought.getTime()) /
        (1000 * 60 * 60 * 24)
    );

    const newCount = existing.buyCount + 1;

    const newAvg = existing.avgFrequency
      ? Math.round(
          (existing.avgFrequency + daysSinceLast) / 2
        )
      : daysSinceLast;

    const updated = await prisma.purchase.update({
      where: {
        id: existing.id,
      },
      data: {
        lastBought: new Date(),
        buyCount: newCount,
        avgFrequency: newAvg,
        notified: false,
      },
    });

    await saveMemory(userId, 'compra', item);

    return {
      purchase: updated,
      isRecurring: true,
      daysSinceLast,
    };
  }

  const purchase = await prisma.purchase.create({
    data: {
      userId,
      item,
    },
  });

  await saveMemory(userId, 'compra', item);

  return {
    purchase,
    isRecurring: false,
    daysSinceLast: null,
  };
}

// ============================================
// EXPENSES
// ============================================

async function saveExpense(userId, data) {
  const {
    valor,
    categoria,
    descricao,
  } = data;

  const expense = await prisma.expense.create({
    data: {
      userId,
      value: parseFloat(valor) || 0,
      category: categoria || 'outro',
      description: descricao || '',
    },
  });

  await saveMemory(
    userId,
    'gasto',
    `R$ ${valor} em ${categoria}`
  );

  return expense;
}

async function getMonthExpenses(userId) {
  const start = new Date();

  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  return prisma.expense.findMany({
    where: {
      userId,
      createdAt: {
        gte: start,
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });
}

// ============================================
// SECRETS
// ============================================

async function saveSecret(userId, data) {
  const {
    categoria,
    label,
    conteudo,
  } = data;

  const secret = await prisma.secret.create({
    data: {
      userId,
      content: conteudo,
      category: categoria || 'outro',
      label: label || 'segredo',
    },
  });

  await saveMemory(
    userId,
    'segredo',
    `[${label || 'segredo'}] guardado`
  );

  return secret;
}

// ============================================
// HEALTH
// ============================================

async function saveHealthRecord(userId, type, data) {
  let content = '';

  if (type === 'pressao') {
    content = `Pressão: ${data.sistolica}/${data.diastolica} mmHg`;
  }

  else if (type === 'glicemia') {
    content = `Glicemia: ${data.valor} mg/dL`;
  }

  else if (type === 'humor') {
    content = `Humor: ${data.sentimento}`;
  }

  return saveMemory(
    userId,
    type,
    content,
    data
  );
}

module.exports = {
  getOrCreateUser,
  saveMemory,
  saveUserPreference,
  getUserPreference,
  saveConversationMessage,
  getConversationHistory,
  saveMedication,
  savePurchase,
  saveTask,
  saveExpense,
  saveSecret,
  saveHealthRecord,
  getRecentMemories,
  getMonthExpenses,
  prisma,
};
