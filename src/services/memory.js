// Clara memory v4.0
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
    console.log(`Nova usuaria da Clara: ${phone}`);
  }
  return user;
}

async function saveUserPreference(userId, name, tom) {
  const data = {};
  if (name) data.name = name;
  if (tom) data.metadata = JSON.stringify({ tom });
  return prisma.user.update({ where: { id: userId }, data });
}

async function getUserPreference(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { name: null, tom: 'carinhoso' };
  let tom = 'carinhoso';
  if (user.metadata) {
    try { tom = JSON.parse(user.metadata).tom || 'carinhoso'; } catch (e) {}
  }
  return { name: user.name, tom };
}

async function saveMemory(userId, type, content, metadata = null) {
  return prisma.memory.create({
    data: { userId, type, content, metadata: metadata ? JSON.stringify(metadata) : null },
  });
}

async function getRecentMemories(userId, limit = 30) {
  return prisma.memory.findMany({
    where: { userId, type: { not: 'conversa' } },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

async function saveConversationMessage(userId, role, content) {
  await prisma.memory.create({
    data: { userId, type: 'conversa', content: JSON.stringify({ role, content, ts: Date.now() }) },
  });
  const msgs = await prisma.memory.findMany({
    where: { userId, type: 'conversa' },
    orderBy: { createdAt: 'desc' },
  });
  if (msgs.length > 30) {
    const toDelete = msgs.slice(30).map(m => m.id);
    await prisma.memory.deleteMany({ where: { id: { in: toDelete } } });
  }
}

async function getConversationHistory(userId, limit = 8) {
  const msgs = await prisma.memory.findMany({
    where: { userId, type: 'conversa' },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return msgs.reverse().map(m => {
    try { const p = JSON.parse(m.content); return { role: p.role, content: p.content }; }
    catch (e) { return null; }
  }).filter(Boolean);
}

async function saveMedication(userId, data) {
  const { nome, quantidade, frequencia, horarios } = data;
  await prisma.medication.updateMany({
    where: { userId, active: true, name: { contains: nome, mode: 'insensitive' } },
    data: { active: false },
  });
  const med = await prisma.medication.create({
    data: { userId, name: nome, totalPills: quantidade || 0, remaining: quantidade || 0, frequency: frequencia || 1, times: JSON.stringify(horarios || ['08:00']) },
  });
  await saveMemory(userId, 'remedio', `${nome} - ${frequencia}x por dia`, { medId: med.id });
  return med;
}

async function savePurchase(userId, item) {
  const existing = await prisma.purchase.findFirst({ where: { userId, item: { contains: item, mode: 'insensitive' } } });
  if (existing) {
    const daysSinceLast = Math.floor((Date.now() - existing.lastBought.getTime()) / (1000 * 60 * 60 * 24));
    const newAvg = existing.avgFrequency ? Math.round((existing.avgFrequency + daysSinceLast) / 2) : daysSinceLast;
    const updated = await prisma.purchase.update({
      where: { id: existing.id },
      data: { lastBought: new Date(), buyCount: existing.buyCount + 1, avgFrequency: newAvg, notified: false },
    });
    await saveMemory(userId, 'compra', item);
    return { purchase: updated, isRecurring: true, daysSinceLast };
  }
  const purchase = await prisma.purchase.create({ data: { userId, item } });
  await saveMemory(userId, 'compra', item);
  return { purchase, isRecurring: false, daysSinceLast: null };
}

async function saveTask(userId, data) {
  const { titulo, data: date, hora, itens } = data;
  let dueDate = parseDateSafely(date);
  if (dueDate) dueDate.setHours(12, 0, 0, 0);
  const task = await prisma.task.create({
    data: { userId, title: titulo, dueDate, dueTime: hora && hora !== 'null' ? hora : null, items: itens && itens !== 'null' ? itens : null },
  });
  await saveMemory(userId, 'compromisso', titulo, { taskId: task.id, date, hora, itens });
  return task;
}

async function saveExpense(userId, data) {
  const { valor, categoria, descricao } = data;
  const expense = await prisma.expense.create({
    data: { userId, value: parseFloat(valor) || 0, category: categoria || 'outro', description: descricao || '' },
  });
  await saveMemory(userId, 'gasto', `R$ ${valor} em ${categoria}`);
  return expense;
}

async function getMonthExpenses(userId) {
  const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
  return prisma.expense.findMany({ where: { userId, createdAt: { gte: start } }, orderBy: { createdAt: 'desc' } });
}

async function saveSecret(userId, data) {
  const { categoria, label, conteudo } = data;
  const secret = await prisma.secret.create({
    data: { userId, content: conteudo, category: categoria || 'outro', label: label || 'segredo' },
  });
  await saveMemory(userId, 'segredo', `[${label || 'segredo'}] guardado`);
  return secret;
}

async function saveHealthRecord(userId, type, data) {
  let content = '';
  if (type === 'pressao') content = `Pressao: ${data.sistolica}/${data.diastolica} mmHg`;
  else if (type === 'glicemia') content = `Glicemia: ${data.valor} mg/dL`;
  else if (type === 'humor') content = `Humor: ${data.sentimento}`;
  return saveMemory(userId, type, content, data);
}

async function saveSleepLog(userId, data) {
  const { horario_dormir, horario_acordar, qualidade, horas } = data;
  const log = await prisma.sleepLog.create({
    data: { userId, bedtime: horario_dormir || null, wakeTime: horario_acordar || null, quality: qualidade || null, hours: horas || null },
  });
  await saveMemory(userId, 'sono', `Dormiu ${horas || '?'}h - qualidade: ${qualidade || 'nao informado'}`);
  return log;
}

async function saveWorkout(userId, data) {
  const { modalidade, duracao, exercicios, nota } = data;
  const workout = await prisma.workout.create({
    data: { userId, type: modalidade, duration: duracao || null, exercises: exercicios || null, note: nota || null },
  });
  await saveMemory(userId, 'treino', `${modalidade}${duracao ? ` - ${duracao}min` : ''}`, { workoutId: workout.id });
  return workout;
}

async function saveGroceryList(userId, items) {
  const list = await prisma.groceryList.create({ data: { userId, items } });
  await saveMemory(userId, 'mercado', `Lista: ${items.substring(0, 80)}`);
  return list;
}

async function getLastGroceryList(userId) {
  return prisma.groceryList.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
}

async function saveEvent(userId, data) {
  const { titulo, pessoa, data: date, type } = data;
  let eventDate = parseDateSafely(date);
  if (eventDate) eventDate.setHours(12, 0, 0, 0);
  const event = await prisma.event.create({
    data: { userId, title: titulo, personName: pessoa || null, date: eventDate || new Date(), type: type || 'outro' },
  });
  await saveMemory(userId, 'evento', `${titulo}${pessoa ? ` - ${pessoa}` : ''}`, { eventId: event.id });
  return event;
}

async function updateEventPerson(userId, eventId, personName, personAge) {
  return prisma.event.update({
    where: { id: eventId },
    data: { personName, personAge: personAge || null },
  });
}

async function getUpcomingEvents(userId, days = 7) {
  const now = new Date();
  const future = new Date(); future.setDate(future.getDate() + days);
  return prisma.event.findMany({
    where: { userId, date: { gte: now, lte: future }, notified: false },
    orderBy: { date: 'asc' },
  });
}

async function getRecentWorkouts(userId, days = 7) {
  const since = new Date(); since.setDate(since.getDate() - days);
  return prisma.workout.findMany({ where: { userId, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' } });
}

// ── NOTAS ──────────────────────────────────────────────────────────────────────

async function saveNote(userId, title, content) {
  const note = await prisma.note.create({
    data: { userId, title, content },
  });
  await saveMemory(userId, 'anotacao', `[${title}] ${content.substring(0, 80)}`);
  return note;
}

async function getNotes(userId) {
  return prisma.note.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
}

async function getNoteByTitle(userId, titulo) {
  // Busca exata primeiro, depois parcial
  const exact = await prisma.note.findFirst({
    where: { userId, title: { equals: titulo, mode: 'insensitive' } },
    orderBy: { createdAt: 'desc' },
  });
  if (exact) return exact;
  return prisma.note.findFirst({
    where: { userId, title: { contains: titulo, mode: 'insensitive' } },
    orderBy: { createdAt: 'desc' },
  });
}

module.exports = {
  getOrCreateUser, saveUserPreference, getUserPreference,
  saveMemory, getRecentMemories,
  saveConversationMessage, getConversationHistory,
  saveMedication, savePurchase, saveTask,
  saveExpense, getMonthExpenses,
  saveSecret, saveHealthRecord,
  saveSleepLog, saveWorkout,
  saveGroceryList, getLastGroceryList,
  saveEvent, updateEventPerson, getUpcomingEvents,
  getRecentWorkouts,
  saveNote, getNotes, getNoteByTitle,
  prisma,
};
