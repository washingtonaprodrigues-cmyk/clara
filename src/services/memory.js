// Clara memory v6 — com memória pessoal expandida

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// ====================== HELPERS ======================

function parseDateSafely(date) {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  return d;
}

// ====================== USER ======================

async function getOrCreateUser(phone) {
  let user = await prisma.user.findUnique({ where: { phone } });
  if (!user) {
    user = await prisma.user.create({ data: { phone } });
    console.log(`👤 Nova usuária: ${phone}`);
  }
  return user;
}

// ====================== JORNADA ======================

async function saveJornada(userId, minutos) {
  return prisma.user.update({ where: { id: userId }, data: { jornadaMinutos: minutos } });
}

async function getJornada(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { jornadaMinutos: true } });
  return user?.jornadaMinutos || 480;
}

// ====================== PREFERÊNCIAS ======================

async function saveUserPreference(userId, name, tom, saldo = null) {
  const data = {};
  if (name) data.name = name;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  let meta = {};
  if (user?.metadata) { try { meta = JSON.parse(user.metadata); } catch {} }

  if (tom) meta.tom = tom;
  if (saldo !== null && saldo !== undefined && !isNaN(saldo)) meta.saldo = parseFloat(saldo);

  data.metadata = JSON.stringify(meta);
  return prisma.user.update({ where: { id: userId }, data });
}

async function getUserPreference(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { name: null, tom: 'carinhoso', saldo: null };
  let tom = 'carinhoso', saldo = null;
  if (user.metadata) {
    try {
      const m = JSON.parse(user.metadata);
      tom = m.tom || 'carinhoso';
      saldo = m.saldo !== undefined ? m.saldo : null;
    } catch {}
  }
  return { name: user.name, tom, saldo };
}

// ====================== MEMÓRIA PESSOAL ======================
// Armazena informações pessoais extraídas das conversas
// Ex: filhos, pets, profissão, rotina, datas importantes, objetivos

const PERSONAL_INFO_TYPE = 'info_pessoal';

// Salva ou atualiza uma informação pessoal por chave
// chave: identificador único (ex: 'filho_nome_1', 'pet_thor', 'profissao')
// valor: string com a informação
// categoria: 'familia' | 'trabalho' | 'rotina' | 'saude' | 'objetivos' | 'datas' | 'outro'
async function savePersonalInfo(userId, chave, valor, categoria = 'outro') {
  // Verifica se já existe uma memória com essa chave
  const existing = await prisma.memory.findFirst({
    where: {
      userId,
      type: PERSONAL_INFO_TYPE,
      metadata: { contains: `"chave":"${chave}"` },
    },
  });

  if (existing) {
    // Atualiza só se o valor mudou
    if (existing.content === valor) return existing;
    return prisma.memory.update({
      where: { id: existing.id },
      data: {
        content: valor,
        metadata: JSON.stringify({ chave, categoria, updatedAt: new Date().toISOString() }),
      },
    });
  }

  return prisma.memory.create({
    data: {
      userId,
      type: PERSONAL_INFO_TYPE,
      content: valor,
      metadata: JSON.stringify({ chave, categoria, createdAt: new Date().toISOString() }),
    },
  });
}

// Retorna todas as infos pessoais do usuário, agrupadas por categoria
async function getPersonalInfo(userId, categoria = null) {
  const where = { userId, type: PERSONAL_INFO_TYPE };
  const mems = await prisma.memory.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });

  const result = {};
  for (const m of mems) {
    let meta = {};
    try { meta = JSON.parse(m.metadata || '{}'); } catch {}
    if (categoria && meta.categoria !== categoria) continue;
    result[meta.chave || m.id] = { valor: m.content, categoria: meta.categoria || 'outro' };
  }
  return result;
}

// Formata o perfil pessoal como texto para injetar no contexto da IA
async function buildPersonalContext(userId) {
  const infos = await getPersonalInfo(userId);
  if (Object.keys(infos).length === 0) return '';

  const grupos = {
    familia: [],
    trabalho: [],
    rotina: [],
    saude: [],
    objetivos: [],
    datas: [],
    outro: [],
  };

  for (const [chave, { valor, categoria }] of Object.entries(infos)) {
    const grupo = grupos[categoria] || grupos.outro;
    grupo.push(valor);
  }

  const labels = {
    familia: 'Família',
    trabalho: 'Trabalho',
    rotina: 'Rotina',
    saude: 'Saúde',
    objetivos: 'Objetivos',
    datas: 'Datas importantes',
    outro: 'Informações pessoais',
  };

  let texto = '';
  for (const [cat, items] of Object.entries(grupos)) {
    if (items.length === 0) continue;
    texto += `\n[${labels[cat]}]\n${items.map(i => `• ${i}`).join('\n')}`;
  }

  return texto ? `\n\n[PERFIL DO USUÁRIO — use para personalizar respostas e ser proativa]${texto}` : '';
}

// ====================== MEMÓRIAS ======================

async function saveMemory(userId, type, content, metadata = null) {
  return prisma.memory.create({
    data: {
      userId, type, content,
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

// ====================== CONTEXTO TEMPORÁRIO ======================

async function setTemporaryContext(userId, context, minutes = 10) {
  const expiresAt = Date.now() + (minutes * 60 * 1000);
  await saveMemory(userId, 'contexto_temp', JSON.stringify({ context, expiresAt }));
}

async function getTemporaryContext(userId) {
  const mems = await getRecentMemories(userId, 20);
  const ctx = mems.find(m => m.type === 'contexto_temp');
  if (!ctx) return null;
  try {
    const parsed = JSON.parse(ctx.content);
    if (Date.now() > parsed.expiresAt) return null;
    return parsed.context;
  } catch { return null; }
}

async function clearTemporaryContext(userId) {
  await saveMemory(userId, 'contexto_temp', '');
}

// ====================== CONVERSA ======================

async function saveConversationMessage(userId, role, content, privateMode = false) {
  if (privateMode) return;

  await prisma.memory.create({
    data: {
      userId,
      type: 'conversa',
      content: JSON.stringify({ role, content, ts: Date.now() }),
    },
  });

  const msgs = await prisma.memory.findMany({
    where: { userId, type: 'conversa' },
    orderBy: { createdAt: 'desc' },
  });

  if (msgs.length > 40) {
    const toDelete = msgs.slice(40).map((m) => m.id);
    await prisma.memory.deleteMany({ where: { id: { in: toDelete } } });
  }
}

async function getConversationHistory(userId, limit = 10) {
  const msgs = await prisma.memory.findMany({
    where: { userId, type: 'conversa' },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return msgs.reverse().map((m) => {
    try {
      const parsed = JSON.parse(m.content);
      return { role: parsed.role, content: parsed.content };
    } catch { return null; }
  }).filter(Boolean);
}

// ====================== MEDICAMENTOS ======================

async function saveMedication(userId, data) {
  const { nome, quantidade, frequencia, horarios } = data;
  await prisma.medication.updateMany({
    where: { userId, active: true, name: { contains: nome, mode: 'insensitive' } },
    data: { active: false },
  });
  const med = await prisma.medication.create({
    data: {
      userId, name: nome,
      totalPills: quantidade || 0,
      remaining: quantidade || 0,
      frequency: frequencia || 1,
      times: JSON.stringify(horarios || ['08:00']),
    },
  });
  await saveMemory(userId, 'remedio', `${nome} - ${frequencia}x por dia`, { medId: med.id });
  return med;
}

// ====================== TAREFAS ======================

async function saveTask(userId, data) {
  const { titulo, data: date, hora } = data;
  let dueDate = parseDateSafely(date);
  if (dueDate) dueDate.setHours(12, 0, 0, 0);
  const task = await prisma.task.create({
    data: { userId, title: titulo, dueDate, dueTime: hora || null },
  });
  await saveMemory(userId, 'compromisso', titulo, { taskId: task.id });
  return task;
}

// ====================== GASTOS ======================

async function saveExpense(userId, data) {
  const { valor, categoria, descricao } = data;
  const expense = await prisma.expense.create({
    data: {
      userId,
      value: parseFloat(valor) || 0,
      category: categoria || 'outro',
      description: descricao || '',
    },
  });
  await saveMemory(userId, 'gasto', `R$ ${valor} em ${categoria}`);
  return expense;
}

async function getMonthExpenses(userId) {
  const start = new Date();
  start.setDate(1); start.setHours(0, 0, 0, 0);
  return prisma.expense.findMany({
    where: { userId, createdAt: { gte: start } },
    orderBy: { createdAt: 'desc' },
  });
}

// ====================== EXPORTS ======================

module.exports = {
  prisma,
  getOrCreateUser,
  saveJornada, getJornada,
  saveUserPreference, getUserPreference,
  savePersonalInfo, getPersonalInfo, buildPersonalContext,
  saveMemory, getRecentMemories,
  setTemporaryContext, getTemporaryContext, clearTemporaryContext,
  saveConversationMessage, getConversationHistory,
  saveMedication, saveTask,
  saveExpense, getMonthExpenses,
};
