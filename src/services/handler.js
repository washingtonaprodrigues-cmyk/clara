}

async function salvarPonto(user, phone, acoes) {
  const hoje = dateBRT();

  for (const acao of acoes) {
    const tipo = acao.subtipo || 'entrada';
    const timestamp = acao.hora ? new Date(`${hoje}T${acao.hora}:00`) : nowBRT();

    await prisma.workLog.create({
      data: {
        userId: user.id,
        type: tipo,
        timestamp,
        date: hoje,
      },
    });
  }

  return listarPontoHoje(user, phone);
}

async function consultarMemoria(user, phone, question) {
  const memories = await memory.getRecentMemories(user.id, 30);

  if (!memories.length) {
    return sendMessage(phone, 'Ainda não guardei nada pra você.' + MENU_FOOTER);
  }

  const answer = await generateMemorySummary(memories, question);
  return sendMessage(phone, answer + MENU_FOOTER);
}

async function listarLembretes(user, phone) {
  const reminders = await prisma.reminder.findMany({
    where: {
      userId: user.id,
      sent: false,
      confirmed: false,
      scheduledAt: { gte: new Date() },
    },
    orderBy: { scheduledAt: 'asc' },
    take: 10,
  });

  if (!reminders.length) {
    return sendMessage(phone, '📋 *Seus lembretes*\n\nVocê não tem lembretes ativos no momento. 😊' + MENU_FOOTER);
  }

  const texto = reminders
    .map((r, i) => `${i + 1}. 📌 ${r.message}\n   🗓️ ${formatarDataHoraBR(r.scheduledAt)}`)
    .join('\n\n');

  return sendMessage(phone, `📋 *Seus lembretes ativos*\n\n${texto}` + MENU_FOOTER);
}

async function listarAnotacoes(user, phone) {
  const mems = await memory.getRecentMemories(user.id, 50);
  const notas = mems.filter((m) => m.type === 'anotacao').slice(0, 10);

  if (!notas.length) {
    return sendMessage(phone, '📝 *Suas anotações*\n\nVocê ainda não tem anotações salvas. 😊' + MENU_FOOTER);
  }

  const texto = notas.map((m) => `• ${m.content}`).join('\n');
  return sendMessage(phone, `📝 *Suas anotações*\n\n${texto}` + MENU_FOOTER);
}

async function listarGastos(user, phone) {
  const gastos = await memory.getMonthExpenses(user.id);
  const total = gastos.reduce((acc, gasto) => acc + gasto.value, 0);

  if (!gastos.length) {
    return sendMessage(phone, '💰 *Gastos do mês*\n\nNenhum gasto registrado este mês. 😊' + MENU_FOOTER);
  }

  const texto = gastos
    .map((gasto) => `• ${gasto.category}: R$ ${gasto.value.toFixed(2)}`)
    .join('\n');

  return sendMessage(phone, `💰 *Gastos do mês*\n\n${texto}\n\n💵 *Total: R$ ${total.toFixed(2)}*` + MENU_FOOTER);
}

async function listarPontoHoje(user, phone) {
  const pontos = await prisma.workLog.findMany({
    where: {
      userId: user.id,
      date: dateBRT(),
    },
    orderBy: { timestamp: 'asc' },
  });

  if (!pontos.length) {
    return sendMessage(phone, '📍 *Ponto de hoje*\n\nNenhum ponto registrado hoje.' + MENU_FOOTER);
  }

  const texto = pontos.map((p) => `• ${p.type}: ${horaStr(p.timestamp)}`).join('\n');
  return sendMessage(phone, `📍 *Ponto de hoje*\n\n${texto}` + MENU_FOOTER);
}

async function listarMedicamentos(user, phone) {
  const meds = await prisma.medication.findMany({
    where: {
      userId: user.id,
      active: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!meds.length) {
    return sendMessage(phone, '💊 *Medicamentos*\n\nNenhum medicamento cadastrado.' + MENU_FOOTER);
  }

  const texto = meds
    .map((m) => `• ${m.name}: ${JSON.parse(m.times || '[]').join(', ')}`)
    .join('\n');

  return sendMessage(phone, `💊 *Medicamentos*\n\n${texto}` + MENU_FOOTER);
}

module.exports = { handleMessage };
