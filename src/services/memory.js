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

  // ── FIX: só atualiza o nome se for uma string não vazia e não parecer apelido de contexto ──
  // Nunca sobrescreve com null — só atualiza se vier explicitamente
  if (name && typeof name === 'string' && name.trim().length > 0) {
    data.name = name.trim();
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  let meta = {};
  if (user?.metadata) { try { meta = JSON.parse(user.metadata); } catch {} }

  // ── FIX: só atualiza tom se vier explicitamente (não null, não undefined, não vazio) ──
  if (tom && typeof tom === 'string' && tom.trim().length > 0) {
    meta.tom = tom.trim();
  }

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

const PERSONAL_INFO_TYPE = 'info_pessoal';

// ── FIX: lista de chaves que NÃO devem ser salvas como nome no preference ──
const CHAVES_PROTEGIDAS_NOME = ['profissao', 'ocupacao', 'cargo', 'area', 'setor', 'empresa', 'trabalho'];

async function savePersonalInfo(userId, chave, valor, categoria = 'outro') {
  const existing = await prisma.memory.findFirst({
    where: {
      userId,
      type: PERSONAL_INFO_TYPE,
      metadata: { contains: `"chave":"${chave}"` },
    },
  });

  if (existing) {
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

async function buildPersonalContext(userId) {
  const infos = await getPersonalInfo(userId);

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

  // ── Assuntos em aberto — contexto conversacional contínuo ──
  // A Clara vê esses assuntos em TODO contexto (bom dia, lembretes,
  // conversa) e pode retomá-los naturalmente quando fizer sentido.
  const pendencias = await getPendenciasAbertas(userId);
  if (pendencias.length > 0) {
    const linhas = pendencias.slice(0, 3).map(p =>
      `• ${p.assunto}: ${p.contexto} → ${p.como_retomar}`
    ).join('\n');
    texto += `\n\n[ASSUNTOS EM ABERTO — retome naturalmente quando fizer sentido, sem forçar]\n${linhas}`;
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
  const mems = await prisma.memory.findMany({
    where: { userId, type: { not: 'conversa' } },
    orderBy: { createdAt: 'desc' },
    take: limit + 10, // folga pra compensar os locks internos filtrados abaixo
  });
  // Memórias internas de controle (locks de cron, dedup de webhook) usam
  // tipos com prefixo/sufixo "__" ou nomes técnicos — nunca devem entrar no
  // contexto que a Clara lê pra conversar. Filtra e respeita o limite real.
  return mems
    .filter(m => !/^__.*__$/.test(m.type) && !m.type.startsWith('lock_') && m.type !== 'webhook_msgid')
    .slice(0, limit);
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
  const { valor, categoria, descricao, createdAt } = data;
  const expenseData = {
    userId,
    value: parseFloat(valor) || 0,
    category: categoria || 'outro',
    description: descricao || '',
  };
  if (createdAt) expenseData.createdAt = createdAt;
  const expense = await prisma.expense.create({ data: expenseData });
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

// ====================== PENDÊNCIAS EMOCIONAIS ======================
// Ver extractPendenciaEmocional (groq.js) e o cron "PENDÊNCIAS EMOCIONAIS"
// (reminders.js) — isso é o que permite a Clara voltar a perguntar sobre
// algo passageiro (mal-estar, evento com resultado incerto) sem o usuário
// precisar trazer o assunto de volta.

async function savePendencia(userId, { categoria, resumo, horas = 4 }) {
  const checkInAt = new Date(Date.now() + horas * 60 * 60 * 1000);
  return prisma.pendencia.create({
    data: { userId, categoria, resumo, checkInAt },
  });
}

// ====================== CONTATOS ======================

async function saveContact(userId, { nome, phone, relation = null, notes = null }) {
  let phoneClean = phone.replace(/\D/g, '');
  if (!phoneClean.startsWith('55') && phoneClean.length <= 11) phoneClean = '55' + phoneClean;

  const existing = await prisma.contact.findFirst({
    where: { userId, phone: phoneClean }
  });

  if (existing) {
    return prisma.contact.update({
      where: { id: existing.id },
      data: { name: nome, relation, notes, updatedAt: new Date() }
    });
  }

  return prisma.contact.create({
    data: { userId, name: nome, phone: phoneClean, relation, notes }
  });
}

async function getContacts(userId) {
  return prisma.contact.findMany({
    where: { userId },
    orderBy: { name: 'asc' }
  });
}

async function findContactByName(userId, nome) {
  return prisma.contact.findMany({
    where: {
      userId,
      name: { contains: nome, mode: 'insensitive' }
    }
  });
}

// ====================== ASSUNTOS EM ABERTO (contexto conversacional) ======================
// Detecta automaticamente quando uma conversa gerou um assunto não resolvido
// (hospital, reunião, resultado esperado, conflito, plano futuro) e o salva
// pra Clara retomar naturalmente nas próximas interações — como uma amiga
// que genuinamente lembra do que ficou pendente entre vocês.

async function getPendenciasAbertas(userId) {
  const mems = await prisma.memory.findMany({
    where: { userId, type: 'pendencia_conversa' },
    orderBy: { createdAt: 'desc' },
    take: 10,
  }).catch(() => []);
  const agora = Date.now();
  const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
  return mems
    .map(m => { try { return { id: m.id, criadoEm: m.createdAt, ...JSON.parse(m.content) }; } catch { return null; } })
    .filter(Boolean)
    .filter(p => !p.encerrado && (agora - new Date(p.criadoEm).getTime()) < EXPIRY_MS);
}

async function salvarOuAtualizarPendencia(userId, { assunto, contexto, como_retomar }) {
  // Evita duplicatas: se já existe pendência aberta com o mesmo assunto, atualiza
  const existentes = await getPendenciasAbertas(userId);
  const mesmoAssunto = existentes.find(p =>
    p.assunto?.toLowerCase().includes(assunto?.toLowerCase()?.split(' ')[0]) ||
    assunto?.toLowerCase().includes(p.assunto?.toLowerCase()?.split(' ')[0])
  );
  if (mesmoAssunto) {
    await prisma.memory.update({
      where: { id: mesmoAssunto.id },
      data: { content: JSON.stringify({ assunto, contexto, como_retomar, encerrado: false }) }
    }).catch(() => {});
    return;
  }
  await prisma.memory.create({
    data: { userId, type: 'pendencia_conversa', content: JSON.stringify({ assunto, contexto, como_retomar, encerrado: false }) }
  }).catch(() => {});
  console.log(`[Pendência] Salva: "${assunto}"`);
}

async function fecharPendencia(userId, pendenciaId) {
  const mem = await prisma.memory.findUnique({ where: { id: pendenciaId } }).catch(() => null);
  if (!mem || mem.userId !== userId) return;
  try {
    const dados = JSON.parse(mem.content);
    await prisma.memory.update({
      where: { id: pendenciaId },
      data: { content: JSON.stringify({ ...dados, encerrado: true }) }
    });
    console.log(`[Pendência] Fechada: "${dados.assunto}"`);
  } catch {}
}

async function fecharPendenciasPorResolucao(userId, textoUsuario) {
  // Detecta sinais de que o usuário está encerrando um assunto em aberto
  const SINAIS = /\b(estou bem|tá bem|já passou|passou|deu certo|foi ótimo|foi bem|resolvido|resolveu|já fiz|normal|tranquilo|melhorei|melhor|alta|cheguei em casa|chegou|saiu|terminou|acabou|tudo certo|tudo bem|sem problema|não foi nada|era nada|nada grave|liberado)\b/i;
  if (!SINAIS.test(textoUsuario)) return;
  const pendencias = await getPendenciasAbertas(userId);
  if (!pendencias.length) return;
  // Fecha a pendência mais recente (última aberta = mais provável de ser o assunto atual)
  await fecharPendencia(userId, pendencias[0].id);
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
  saveContact, getContacts, findContactByName,
  savePendencia,
  getPendenciasAbertas, salvarOuAtualizarPendencia, fecharPendencia, fecharPendenciasPorResolucao,
};
