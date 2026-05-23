// Clara memory v4.0 - Atualizado
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function parseDateSafely(date) {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  return d;
}

async function getOrCreateUser(phone) {
  let user = await prisma.user.findUnique({ where: { phone } });
  if (!user) {
    user = await prisma.user.create({ data: { phone } });
    console.log(`Nova usuária da Clara: ${phone}`);
  }
  return user;
}

// ====================== JORNADA CONFIGURÁVEL ======================
async function saveJornada(userId, minutos) {
  return prisma.user.update({
    where: { id: userId },
    data: { jornadaMinutos: minutos }
  });
}

async function getJornada(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { jornadaMinutos: true }
  });
  return user?.jornadaMinutos || 480; // 8h padrão
}

// ====================== OUTRAS FUNÇÕES ======================
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

async function getRecentMemories(userId, limit = 30) {
  return prisma.memory.findMany({
    where: { userId, type: { not: 'conversa' } },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

async function saveConversationMessage(userId, role, content) { ... } // mantenha suas funções originais aqui
// (copie todas as outras funções que você já tinha no memory.js)

module.exports = {
  getOrCreateUser,
  saveJornada,
  getJornada,
  saveMemory,
  getRecentMemories,
  saveConversationMessage,
  getConversationHistory,
  saveMedication,
  savePurchase,
  saveTask,
  saveExpense,
  getMonthExpenses,
  saveSecret,
  saveHealthRecord,
  saveSleepLog,
  saveWorkout,
  saveGroceryList,
  getLastGroceryList,
  saveEvent,
  updateEventPerson,
  getUpcomingEvents,
  getRecentWorkouts,
  saveNote,
  getNotes,
  getNoteByTitle,
  prisma,
};
