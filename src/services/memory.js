// Clara memory v4.1

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function parseDateSafely(date) {
  if (!date) return null;

  const d = new Date(date);

  if (isNaN(d.getTime())) {
    return null;
  }

  return d;
}

// ====================== USER ======================

async function getOrCreateUser(phone) {
  let user = await prisma.user.findUnique({
    where: { phone }
  });

  if (!user) {
    user = await prisma.user.create({
      data: { phone }
    });

    console.log(`👤 Nova usuária: ${phone}`);
  }

  return user;
}

// ====================== JORNADA ======================

async function saveJornada(userId, minutos) {
  return prisma.user.update({
    where: { id: userId },
    data: {
      jornadaMinutos: minutos
    }
  });
}

async function getJornada(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      jornadaMinutos: true
    }
  });

  return user?.jornadaMinutos || 480;
}

// ====================== PREFERÊNCIAS ======================

async function saveUserPreference(userId, name, tom) {
  const data = {};

  if (name) {
    data.name = name;
  }

  if (tom) {
    data.metadata = JSON.stringify({ tom });
  }

  return prisma.user.update({
    where: { id: userId },
    data
  });
}

async function getUserPreference(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId }
  });

  if (!user) {
    return {
      name: null,
      tom: 'carinhoso'
    };
  }

  let tom = 'carinhoso';

  if (user.metadata) {
    try {
      tom = JSON.parse(user.metadata).tom || 'carinhoso';
    } catch {}
  }

  return {
    name: user.name,
    tom
  };
}

// ====================== MEMÓRIAS ======================

async function saveMemory(userId, type, content, metadata = null) {
  return prisma.memory.create({
    data: {
      userId,
      type,
      content,
      metadata: metadata
        ? JSON.stringify(metadata)
        : null,
    },
  });
}

async function getRecentMemories(userId, limit = 30) {
  return prisma.memory.findMany({
    where: {
      userId,
      type: {
        not: 'conversa'
      }
    },
    orderBy: {
      createdAt: 'desc'
    },
    take: limit,
  });
}

// ====================== CONVERSA ======================

async function saveConversationMessage(userId, role, content) {
  await prisma.memory.create({
    data: {
      userId,
      type: 'conversa',
      content: JSON.stringify({
        role,
        content,
        ts: Date.now()
      }),
    },
  });

  const msgs = await prisma.memory.findMany({
    where: {
      userId,
      type: 'conversa'
    },
    orderBy: {
      createdAt: 'desc'
    },
  });

  if (msgs.length > 30) {
    const toDelete = msgs
      .slice(30)
      .map((m) => m.id);

    await prisma.memory.deleteMany({
      where: {
        id: {
          in: toDelete
        }
      }
    });
  }
}

async function getConversationHistory(userId, limit = 8) {
  const msgs = await prisma.memory.findMany({
    where: {
      userId,
      type: 'conversa'
    },
    orderBy: {
      createdAt: 'desc'
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
          content: parsed.content
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ====================== MEDICAMENTOS ======================

async function saveMedication(userId, data) {
  const {
    nome,
    quantidade,
    frequencia,
    horarios
  } = data;

  await prisma.medication.updateMany({
    where: {
      userId,
      active: true,
      name: {
        contains: nome,
        mode: 'insensitive'
      }
    },
    data: {
      active: false
    },
  });

  const med = await prisma.medication.create({
    data: {
      userId,
      name: nome,
      totalPills: quantidade || 0,
      remaining: quantidade || 0,
      frequency: frequencia || 1,
      times: JSON.stringify(
        horarios || ['08:00']
      ),
    },
  });

  await saveMemory(
    userId,
    'remedio',
    `${nome} - ${frequencia}x por dia`,
    {
      medId: med.id
    }
  );

  return med;
}

// ====================== COMPRAS ======================

async function savePurchase(userId, item) {
  const existing =
    await prisma.purchase.findFirst({
      where: {
        userId,
        item: {
          contains: item,
          mode: 'insensitive'
        }
      },
    });

  if (existing) {
    const daysSinceLast = Math.floor(
      (
        Date.now() -
        existing.lastBought.getTime()
      ) /
      (1000 * 60 * 60 * 24)
    );

    const newAvg =
      existing.avgFrequency
        ? Math.round(
            (
              existing.avgFrequency +
              daysSinceLast
            ) / 2
          )
        : daysSinceLast;

    const updated =
      await prisma.purchase.update({
        where: {
          id: existing.id
        },
        data: {
          lastBought: new Date(),
          buyCount: existing.buyCount + 1,
          avgFrequency: newAvg,
          notified: false
        },
      });

    await saveMemory(
      userId,
      'compra',
      item
    );

    return {
      purchase: updated,
      isRecurring: true
    };
  }

  const purchase =
    await prisma.purchase.create({
      data: {
        userId,
        item
      }
    });

  await saveMemory(
    userId,
    'compra',
    item
  );

  return {
    purchase,
    isRecurring: false
  };
}

// ====================== TAREFAS ======================

async function saveTask(userId, data) {
  const {
    titulo,
    data: date,
    hora
  } = data;

  let dueDate = parseDateSafely(date);

  if (dueDate) {
    dueDate.setHours(12, 0, 0, 0);
  }

  const task = await prisma.task.create({
    data: {
      userId,
      title: titulo,
      dueDate,
      dueTime: hora || null,
    },
  });

  await saveMemory(
    userId,
    'compromisso',
    titulo,
    {
      taskId: task.id
    }
  );

  return task;
}

// ====================== GASTOS ======================

async function saveExpense(userId, data) {
  const {
    valor,
    categoria,
    descricao
  } = data;

  const expense =
    await prisma.expense.create({
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
        gte: start
      }
    },
    orderBy: {
      createdAt: 'desc'
    },
  });
}

module.exports = {
  getOrCreateUser,

  saveJornada,
  getJornada,

  saveUserPreference,
  getUserPreference,

  saveMemory,
  getRecentMemories,

  saveConversationMessage,
  getConversationHistory,

  saveMedication,
  savePurchase,
  saveTask,
  saveExpense,
  getMonthExpenses,

  prisma,
};
