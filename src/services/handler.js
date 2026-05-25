
  if (!classified.hora) {
    return sendButtons(phone, `🔔 *Lembrete criado!*\n\n📌 ${classified.titulo}\n\nGuardei aqui pra você 😊`, [
      { id: 'ver_lembretes', label: '📋 Ver lembretes' },
      { id: 'menu', label: '🏠 Menu' },
    ]);
  }

  const dataBase = classified.data || dateBRT();
  const [h, m] = classified.hora.split(':').map(Number);
  const scheduledAt = new Date(`${dataBase}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`);
  if (!classified.data && scheduledAt < nowBRT()) scheduledAt.setDate(scheduledAt.getDate() + 1);

  await prisma.reminder.create({
    data: { userId: user.id, phone, message: classified.titulo, scheduledAt },
  });

  return sendButtons(phone, `🔔 *Lembrete criado com sucesso!*\n\n📌 ${classified.titulo}\n🗓️ ${formatarDataHoraBR(scheduledAt)}\n\nVou te avisar no horário certinho 😊`, [
    { id: 'ver_lembretes', label: '📋 Ver lembretes' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function handleExpense(user, phone, classified) {
  const valor = Number(classified.valor) || 0;
  const categoria = classified.categoria || 'outro';
  const descricao = classified.descricao || categoria;
  await memory.saveExpense(user.id, { valor, categoria, descricao });

  const icons = { mercado: '🛒', restaurante: '🍽️', saude: '💊', transporte: '🚗', lazer: '🎉', outro: '📦' };
  const icon = icons[categoria] || '📦';
  return sendButtons(phone, `💰 *Gasto registrado!*\n\n${icon} *${categoria.charAt(0).toUpperCase() + categoria.slice(1)}*\n💵 R$ ${valor.toFixed(2)}\n\nSeu gasto foi salvo no controle financeiro 😊`, [
    { id: 'ver_gastos', label: '📋 Ver gastos' },
    { id: 'resumo_mes', label: '📊 Resumo do mês' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function handleMedication(user, phone, classified) {
  const nome = classified.nome || classified.name || classified.titulo;
  const horarios = Array.isArray(classified.horarios) && classified.horarios.length ? classified.horarios : ['08:00'];
  if (!nome) return sendMessage(phone, 'Me diz o nome do remédio e o horário? Exemplo: _"Losartana todo dia às 8h"_' + MENU_FOOTER);

  await memory.saveMedication(user.id, {
    nome,
    quantidade: Number(classified.quantidade) || 0,
    frequencia: Number(classified.frequencia) || horarios.length || 1,
    horarios,
  });

  return sendButtons(phone, `💊 *Medicamento cadastrado!*\n\n${nome}\n⏰ ${horarios.join(', ')}\n\nVou te lembrar nos horários combinados 😊`, [
    { id: 'ver_medicamentos', label: '📋 Ver medicamentos' },
    { id: 'novo_remedio', label: '➕ Novo remédio' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function handleQuery(user, phone, question) {
  await sendMessage(phone, '💭 _Deixa eu ver isso pra você..._');
  const memories = await memory.getRecentMemories(user.id, 30);
  if (!memories.length) return sendMessage(phone, 'Ainda não guardei nada pra você. Me conta algo!' + MENU_FOOTER);
  const answer = await generateMemorySummary(memories, question);
  return sendMessage(phone, answer + MENU_FOOTER);
}

async function listarLembretes(user, phone) {
  const reminders = await prisma.reminder.findMany({
    where: { userId: user.id, sent: false, confirmed: false, scheduledAt: { gte: new Date() } },
    orderBy: { scheduledAt: 'asc' },
    take: 10,
  });
  if (!reminders.length) return sendButtons(phone, `📋 *Seus lembretes*\n\nVocê não tem lembretes ativos no momento 😊`, [
    { id: 'lembrete', label: '➕ Criar lembrete' },
    { id: 'menu', label: '🏠 Menu' },
  ]);

  let texto = `📋 *Seus lembretes ativos*\n\n`;
  reminders.forEach((r, i) => {
    texto += `${i + 1}. 📌 ${r.message}\n   🗓️ ${formatarDataHoraBR(r.scheduledAt)}\n\n`;
  });
  return sendButtons(phone, texto, [
    { id: 'criar_lembrete', label: '➕ Criar lembrete' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function listarAnotacoes(user, phone) {
  const mems = await memory.getRecentMemories(user.id, 50);
  const anotacoes = mems.filter((m) => m.type === 'anotacao').slice(0, 10);
  if (!anotacoes.length) return sendButtons(phone, `📝 *Suas anotações*\n\nVocê ainda não tem anotações salvas 😊`, [
    { id: 'anotacao', label: '➕ Nova anotação' },
    { id: 'menu', label: '🏠 Menu' },
  ]);

  let texto = `📝 *Suas anotações*\n\n`;
  anotacoes.forEach((a) => {
    texto += `📌 _"${a.content}"_\n🗓️ ${formatarDataBR(a.createdAt)}\n\n`;
  });
  return sendButtons(phone, texto, [
    { id: 'nova_anotacao', label: '➕ Nova anotação' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function listarGastos(user, phone) {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const gastos = await prisma.expense.findMany({
    where: { userId: user.id, createdAt: { gte: start } },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  if (!gastos.length) return sendButtons(phone, `💰 *Seus gastos*\n\nNenhum gasto registrado este mês 😊`, [
    { id: 'gasto', label: '➕ Registrar gasto' },
    { id: 'menu', label: '🏠 Menu' },
  ]);

  const icons = { mercado: '🛒', restaurante: '🍽️', saude: '💊', transporte: '🚗', lazer: '🎉', outro: '📦' };
  const total = gastos.reduce((acc, g) => acc + g.value, 0);
  let texto = `💰 *Gastos do mês*\n\n`;
  gastos.forEach((g) => {
    texto += `${icons[g.category] || '📦'} *${g.category}* — R$ ${g.value.toFixed(2)}\n🗓️ ${formatarDataBR(g.createdAt)}\n\n`;
  });
  texto += `───────────────\n💵 *Total: R$ ${total.toFixed(2)}*`;
  return sendButtons(phone, texto, [
    { id: 'novo_gasto', label: '➕ Novo gasto' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function listarPontoHoje(user, phone) {
  const pontos = await prisma.workLog.findMany({
    where: { userId: user.id, date: dateBRT() },
    orderBy: { timestamp: 'asc' },
  });
  if (!pontos.length) return sendButtons(phone, `📍 *Ponto de hoje*\n\nNenhum registro de ponto hoje ainda 😊`, [
    { id: 'ponto', label: '📍 Bater ponto' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
  const resumo = await gerarResumoDoBanco(pontos, user.id);
  return sendButtons(phone, resumo, [
    { id: 'bater_ponto', label: '📍 Bater ponto' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function listarMedicamentos(user, phone) {
  const meds = await prisma.medication.findMany({
    where: { userId: user.id, active: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!meds.length) return sendButtons(phone, `💊 *Seus medicamentos*\n\nNenhum medicamento cadastrado ainda 😊`, [
    { id: 'saude', label: '➕ Cadastrar remédio' },
    { id: 'menu', label: '🏠 Menu' },
  ]);

  let texto = `💊 *Seus medicamentos ativos*\n\n`;
  meds.forEach((m) => {
    texto += `💊 *${m.name}*\n⏰ ${JSON.parse(m.times || '[]').join(', ')} — ${m.frequency}x por dia\n💊 Restam: ${m.remaining} comprimidos\n\n`;
  });
  return sendButtons(phone, texto, [
    { id: 'novo_remedio', label: '➕ Novo remédio' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

module.exports = { handleMessage };
