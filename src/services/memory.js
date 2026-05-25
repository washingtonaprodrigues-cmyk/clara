const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function getOrCreateUser(phone) {
  let user = await prisma.user.findUnique({
    where: { phone },
  });

  if (!user) {
    user = await prisma.user.create({
      data: { phone },
    });

    console.log(`👤 Nova usuária: ${phone}`);
  }

  return user;
}

async function saveMemory(userId, type, content, metadata = null) {
  return prisma.memory.create({
    data: {
      userId,
      type,
      content: String(content || ''),
      metadata: metadata ? JSON.stringify(metadata) : null,
    },
  });
}

async function getRecentMemories(userId, limit = 30) {
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
    await prisma.memory.deleteMany({
      where: {
        id: {
          in: msgs.slice(30).map((m) => m.id),
        },
      },
    });
  }
}

async function getConversationHistory(userId, limit = 8) {
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
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function saveUserPreference(userId, name, tom) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  let metadata = {};

  if (user?.metadata) {
    try {
      metadata = JSON.parse(user.metadata);
    } catch {
      metadata = {};
    }
  }

  if (tom) {
    metadata.tom = tom;
  }

  const data = {
    metadata: JSON.stringify(metadata),
  };

  if (name) {
    data.name = name;
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
    } catch {
      tom = 'carinhoso';
    }
  }

  return {
    name: user.name,
    tom,
  };
}

async function saveExpense(userId, data) {
  const valor = Number(data.valor) || 0;
  const categoria = data.categoria || 'outro';
  const descricao = data.descricao || '';

  const expense = await prisma.expense.create({
    data: {
      userId,
      value: valor,
      category: categoria,
      description: descricao,
    },
  });

  await saveMemory(userId, 'gasto', `R$ ${valor.toFixed(2)} em ${categoria}`, {
    expenseId: expense.id,
    valor,
    categoria,
    descricao,
  });

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

async function saveMedication(userId, data) {
  const nome = data.nome;
  const quantidade = Number(data.quantidade) || 0;
  const frequencia = Number(data.frequencia) || 1;
  const horarios = data.horarios || ['08:00'];

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
      totalPills: quantidade,
      remaining: quantidade,
      frequency: frequencia,
      times: JSON.stringify(horarios),
    },
  });

  await saveMemory(userId, 'remedio', `${nome} - ${frequencia}x por dia`, {
    medId: med.id,
    horarios,
  });

  return med;
}

async function getJornada(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      jornadaMinutos: true,
    },
  });

  return user?.jornadaMinutos || 480;
}

async function saveJornada(userId, minutos) {
  return prisma.user.update({
    where: { id: userId },
    data: {
      jornadaMinutos: minutos,
    },
  });
}

module.exports = {
  prisma,

  getOrCreateUser,

  saveMemory,
  getRecentMemories,

  saveConversationMessage,
  getConversationHistory,

  saveUserPreference,
  getUserPreference,

  saveExpense,
  getMonthExpenses,

  saveMedication,

  getJornada,
  saveJornada,
};
