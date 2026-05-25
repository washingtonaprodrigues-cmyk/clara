const { classify, searchWeb, freeResponse, generateMemorySummary } = require('./groq');
const { sendMessage, sendButtons } = require('./whatsapp');
const memory = require('./memory');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const MENU = `✨ *Oi, eu sou a Clara.*

Posso cuidar de lembretes, anotações, gastos, saúde, ponto e pesquisas rápidas.

Você pode tocar em uma opção ou escrever do seu jeito:
• _"me lembra de tomar remédio às 22h"_
• _"gastei 42 reais no mercado"_
• _"cheguei às 9h no trabalho"_
• _"qual foi a senha do Wi-Fi?"_`;

const MENU_FOOTER = '\n\n_Digite *menu* para ver as opções 🏠_';
const MENU_BUTTONS = [
  { id: 'criar_lembrete', label: '⏰ Lembrete' },
  { id: 'nova_anotacao', label: '📝 Anotação' },
  { id: 'novo_gasto', label: '💰 Gasto' },
  { id: 'bater_ponto', label: '📍 Ponto' },
  { id: 'pesquisar', label: '🔍 Pesquisa' },
  { id: 'conversar', label: '💬 Conversar' },
];

function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function dateBRT() {
  const d = nowBRT();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function norm(text) {
  return (text || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function horaStr(date) {
  if (!date) return '—';
  const d = new Date(date);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function menu(phone) {
  return sendButtons(phone, MENU, MENU_BUTTONS);
}

async function getModoAtual(userId) {
  const mems = await memory.getRecentMemories(userId, 10);
  return mems.find((m) => m.type === 'modo_atual')?.content || null;
}

async function responderLivre(user, phone, text) {
  const history = await memory.getConversationHistory(user.id, 10);
  const preferences = await memory.getUserPreference(user.id);
  const resp = await freeResponse(text, history, preferences);
  await memory.saveConversationMessage(user.id, 'user', text);
  await memory.saveConversationMessage(user.id, 'assistant', resp);
  return sendMessage(phone, resp + MENU_FOOTER);
}

async function handleMessage(phone, text, location = null) {
  try {
    const user = await memory.getOrCreateUser(phone);

    if (location?.latitude) {
      await memory.saveMemory(user.id, 'localizacao', JSON.stringify(location));
      return sendMessage(phone, '✅ Localização recebida! Agora posso te ajudar melhor.' + MENU_FOOTER);
    }

    if (!text) return;
    const t = norm(text);

    if (['menu', 'inicio', 'voltar', 'ajuda', 'opcoes'].includes(t)) {
      await memory.saveMemory(user.id, 'modo_atual', '');
      return menu(phone);
    }

    if (['ver lembretes', 'ver_lembretes'].includes(t)) return listarLembretes(user, phone);
    if (['ver anotacoes', 'ver_anotacoes'].includes(t)) return listarAnotacoes(user, phone);
    if (['ver gastos', 'ver_gastos', 'resumo_mes'].includes(t)) return listarGastos(user, phone);
    if (['ver horas hoje', 'ver_horas_hoje'].includes(t)) return listarPontoHoje(user, phone);
    if (['ver medicamentos', 'ver_medicamentos'].includes(t)) return listarMedicamentos(user, phone);

    const modos = {
      lembrete: 'lembrete', lembretes: 'lembrete', criar_lembrete: 'lembrete',
      anotacao: 'anotacao', anotacoes: 'anotacao', nova_anotacao: 'anotacao',
      gasto: 'gasto', gastos: 'gasto', novo_gasto: 'gasto',
      saude: 'saude', novo_remedio: 'saude',
      ponto: 'ponto', bater_ponto: 'ponto',
      pesquisar: 'pesquisar', pesquisa: 'pesquisar',
      conversar: 'conversar',
    };

    if (modos[t]) {
      await memory.saveMemory(user.id, 'modo_atual', modos[t]);
      return sendMessage(phone, `Certo! Me diga o que você quer fazer em *${modos[t]}*.` + MENU_FOOTER);
    }

    const modoAtual = await getModoAtual(user.id);
    if (modoAtual === 'anotacao') return salvarAnotacao(user, phone, text);
    if (modoAtual === 'conversar') return responderLivre(user, phone, text);

    const c = await classify(text);
    if (c.tipo === 'saudacao') return menu(phone);
    if (c.tipo === 'cidade') return salvarCidade(user, phone, c.cidade);
    if (c.tipo === 'busca') return buscar(user, phone, c.query || text);
    if (c.tipo === 'anotacao') return salvarAnotacao(user, phone, c.conteudo || c.titulo || text);
    if (c.tipo === 'tarefa') return salvarLembrete(user, phone, c);
    if (c.tipo === 'gasto') return salvarGasto(user, phone, c);
    if (c.tipo === 'medicamento') return salvarMedicamento(user, phone, c);
    if (c.tipo === 'consulta') return consultar(user, phone, text);
    if (c.tipo === 'preferencia') return salvarPreferencia(user, phone, c);
    if (c.tipo === 'ponto_multiplo') return salvarPonto(user, phone, c.acoes || []);

    return responderLivre(user, phone, text);
  } catch (error) {
    console.error('Erro handleMessage:', error.message);
    return sendMessage(phone, 'Ops, tive um probleminha. Pode repetir?');
  }
}

async function salvarCidade(user, phone, cidade) {
  await memory.saveMemory(user.id, 'cidade', cidade);
  return sendMessage(phone, `Anotei! 📍 Vou usar *${cidade}* para buscas locais.` + MENU_FOOTER);
}

async function salvarPreferencia(user, phone, c) {
  await memory.saveUserPreference(user.id, c.nome, c.tom);
  return sendMessage(phone, 'Combinado, vou lembrar dessa preferência. 😊' + MENU_FOOTER);
}

async function buscar(user, phone, query) {
  await sendMessage(phone, '✨ _Clareando ideias..._');
  const mems = await memory.getRecentMemories(user.id, 20);
  const cidade = mems.find((m) => m.type === 'cidade')?.content || '';
  const resultado = await searchWeb(query, cidade);
  return sendMessage(phone, resultado + MENU_FOOTER);
}

async function salvarAnotacao(user, phone, conteudo) {
  await memory.saveMemory(user.id, 'anotacao', conteudo, { titulo: conteudo.substring(0, 50) });
  return sendButtons(phone, `📝 *Anotação salva!*\n\n_"${conteudo}"_`, [
    { id: 'ver_anotacoes', label: '📋 Ver anotações' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function salvarLembrete(user, phone, c) {
  await memory.saveMemory(user.id, 'tarefa', c.titulo, { data: c.data, hora: c.hora });
  if (c.hora) {
    const data = c.data || dateBRT();
    const [h, m] = c.hora.split(':').map(Number);
    const scheduledAt = new Date(`${data}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`);
    if (!c.data && scheduledAt < nowBRT()) scheduledAt.setDate(scheduledAt.getDate() + 1);
    await prisma.reminder.create({ data: { userId: user.id, phone, message: c.titulo, scheduledAt } });
  }
  return sendButtons(phone, `🔔 *Lembrete criado!*\n\n📌 ${c.titulo}`, [
    { id: 'ver_lembretes', label: '📋 Ver lembretes' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function salvarGasto(user, phone, c) {
  const valor = Number(c.valor) || 0;
  const categoria = c.categoria || 'outro';
  await memory.saveExpense(user.id, { valor, categoria, descricao: c.descricao || categoria });
  return sendButtons(phone, `💰 *Gasto registrado!*\n\n${categoria}\nR$ ${valor.toFixed(2)}`, [
    { id: 'ver_gastos', label: '📋 Ver gastos' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function salvarMedicamento(user, phone, c) {
  const nome = c.nome || c.titulo || c.name;
  const horarios = Array.isArray(c.horarios) && c.horarios.length ? c.horarios : ['08:00'];
  if (!nome) return sendMessage(phone, 'Me diz o nome do remédio e o horário?' + MENU_FOOTER);
  await memory.saveMedication(user.id, { nome, quantidade: Number(c.quantidade) || 0, frequencia: Number(c.frequencia) || horarios.length || 1, horarios });
  return sendButtons(phone, `💊 *Medicamento cadastrado!*\n\n${nome}\n⏰ ${horarios.join(', ')}`, [
    { id: 'ver_medicamentos', label: '📋 Ver medicamentos' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function salvarPonto(user, phone, acoes) {
  const hoje = dateBRT();
  for (const acao of acoes) {
    const tipo = acao.subtipo || 'entrada';
    const timestamp = acao.hora ? new Date(`${hoje}T${acao.hora}:00`) : nowBRT();
    await prisma.workLog.create({ data: { userId: user.id, type: tipo, timestamp, date: hoje } });
  }
  return listarPontoHoje(user, phone);
}

async function consultar(user, phone, pergunta) {
  const memories = await memory.getRecentMemories(user.id, 30);
  if (!memories.length) return sendMessage(phone, 'Ainda não guardei nada pra você.' + MENU_FOOTER);
  const answer = await generateMemorySummary(memories, pergunta);
  return sendMessage(phone, answer + MENU_FOOTER);
}

async function listarLembretes(user, phone) {
  const reminders = await prisma.reminder.findMany({ where: { userId: user.id, sent: false, confirmed: false }, orderBy: { scheduledAt: 'asc' }, take: 10 });
  const texto = reminders.length ? reminders.map((r, i) => `${i + 1}. ${r.message} - ${horaStr(r.scheduledAt)}`).join('\n') : 'Você não tem lembretes ativos.';
  return sendMessage(phone, `📋 *Seus lembretes*\n\n${texto}` + MENU_FOOTER);
}

async function listarAnotacoes(user, phone) {
  const mems = await memory.getRecentMemories(user.id, 50);
  const notas = mems.filter((m) => m.type === 'anotacao').slice(0, 10);
  const texto = notas.length ? notas.map((m) => `• ${m.content}`).join('\n') : 'Você ainda não tem anotações.';
  return sendMessage(phone, `📝 *Suas anotações*\n\n${texto}` + MENU_FOOTER);
}

async function listarGastos(user, phone) {
  const gastos = await memory.getMonthExpenses(user.id);
  const total = gastos.reduce((acc, g) => acc + g.value, 0);
  const texto = gastos.length ? gastos.map((g) => `• ${g.category}: R$ ${g.value.toFixed(2)}`).join('\n') : 'Nenhum gasto registrado este mês.';
  return sendMessage(phone, `💰 *Gastos do mês*\n\n${texto}\n\nTotal: R$ ${total.toFixed(2)}` + MENU_FOOTER);
}

async function listarPontoHoje(user, phone) {
  const pontos = await prisma.workLog.findMany({ where: { userId: user.id, date: dateBRT() }, orderBy: { timestamp: 'asc' } });
  const texto = pontos.length ? pontos.map((p) => `• ${p.type}: ${horaStr(p.timestamp)}`).join('\n') : 'Nenhum ponto registrado hoje.';
  return sendMessage(phone, `📍 *Ponto de hoje*\n\n${texto}` + MENU_FOOTER);
}

async function listarMedicamentos(user, phone) {
  const meds = await prisma.medication.findMany({ where: { userId: user.id, active: true } });
  const texto = meds.length ? meds.map((m) => `• ${m.name}: ${JSON.parse(m.times || '[]').join(', ')}`).join('\n') : 'Nenhum medicamento cadastrado.';
  return sendMessage(phone, `💊 *Medicamentos*\n\n${texto}` + MENU_FOOTER);
}

module.exports = { handleMessage };
