const { classify, searchWeb, freeResponse, generateMemorySummary } = require('./groq');
const { sendMessage, sendButtons } = require('./whatsapp');
const memory = require('./memory');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const MENU_FOOTER = '\n\n_Digite *menu* para ver as opções 🏠_';

const MENU = `✨ *Clara, sua assistente pessoal*

Escolha uma opção pelo número ou escreva do seu jeito:

*1* ⏰ Criar lembrete
*2* 📝 Salvar anotação
*3* 💰 Registrar gasto
*4* 💊 Cadastrar remédio
*5* 📍 Bater ponto
*6* 🔍 Pesquisar algo
*7* 💬 Conversar comigo

*Atalhos rápidos*
• _ver lembretes_
• _ver anotações_
• _ver gastos_
• _ver medicamentos_
• _ver horas hoje_

Exemplos:
_"me lembra de tomar remédio às 22h"_
_"vai chover hoje em Bauru?"_
_"gastei 42 reais no mercado"_`;

const MENU_BUTTONS = [
  { id: 'criar_lembrete', label: '⏰ Lembrete' },
  { id: 'nova_anotacao', label: '📝 Anotação' },
  { id: 'novo_gasto', label: '💰 Gasto' },
  { id: 'bater_ponto', label: '📍 Ponto' },
  { id: 'pesquisar', label: '🔍 Pesquisa' },
  { id: 'conversar', label: '💬 Conversar' },
];

const MODO_MSG = {
  lembrete: '⏰ *Vamos criar um lembrete*\n\nMe diga o compromisso e o horário.\n\nExemplo: _"amanhã às 8h tomar remédio"_',
  anotacao: '📝 *Vou guardar uma anotação pra você*\n\nPode mandar senha, código, endereço ou qualquer informação importante.',
  gasto: '💰 *Controle de gastos*\n\nMe conte o valor e onde foi.\n\nExemplo: _"gastei 45 reais no mercado"_',
  saude: '💊 *Cuidados de saúde*\n\nMe diga o remédio e os horários.\n\nExemplo: _"Losartana todo dia às 8h"_',
  ponto: '📍 *Ponto digital*\n\nExemplo: _"entrei 8h, saí almoço 12h, voltei 13h e saí 17h"_',
  pesquisar: '🔍 *Pesquisa rápida*\n\nMe diga o que quer saber.\n\nExemplo: _"vai chover hoje em Bauru?"_',
  conversar: '💬 *Estou aqui*\n\nPode falar comigo do seu jeito. 😊',
};

function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function dateBRT() {
  const d = nowBRT();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function normalizar(text) {
  return (text || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function horaStr(date) {
  if (!date) return '--:--';
  const d = new Date(date);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatarDataHoraBR(date) {
  const d = new Date(date);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} às ${horaStr(d)}`;
}

async function enviarMenu(phone) {
  return sendButtons(phone, MENU, MENU_BUTTONS);
}

async function setModo(userId, modo) {
  await memory.saveMemory(userId, 'modo_atual', modo || '');
}

async function getModo(userId) {
  const mems = await memory.getRecentMemories(userId, 10);
  return mems.find((m) => m.type === 'modo_atual')?.content || '';
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
      await memory.saveMemory(user.id, 'localizacao', JSON.stringify({
        latitude: location.latitude,
        longitude: location.longitude,
        updatedAt: new Date().toISOString(),
      }));
      return sendMessage(phone, '✅ Localização recebida! Agora posso te ajudar melhor com clima e locais próximos.' + MENU_FOOTER);
    }

    if (!text) return;

    let msg = normalizar(text);
    const numeroMap = {
      '1': 'criar_lembrete',
      '2': 'nova_anotacao',
      '3': 'novo_gasto',
      '4': 'novo_remedio',
      '5': 'bater_ponto',
      '6': 'pesquisar',
      '7': 'conversar',
    };
    msg = numeroMap[msg] || msg;

    if (['menu', 'inicio', 'voltar', 'ajuda', 'opcoes'].includes(msg)) {
      await setModo(user.id, '');
      return enviarMenu(phone);
    }

    if (['ver lembretes', 'ver_lembretes'].includes(msg)) return listarLembretes(user, phone);
    if (['ver anotacoes', 'ver_anotacoes'].includes(msg)) return listarAnotacoes(user, phone);
    if (['ver gastos', 'ver_gastos', 'resumo_mes'].includes(msg)) return listarGastos(user, phone);
    if (['ver horas hoje', 'ver_horas_hoje'].includes(msg)) return listarPontoHoje(user, phone);
    if (['ver medicamentos', 'ver_medicamentos'].includes(msg)) return listarMedicamentos(user, phone);

    const modoMap = {
      criar_lembrete: 'lembrete',
      lembrete: 'lembrete',
      lembretes: 'lembrete',
      nova_anotacao: 'anotacao',
      anotacao: 'anotacao',
      anotacoes: 'anotacao',
      novo_gasto: 'gasto',
      gasto: 'gasto',
      gastos: 'gasto',
      novo_remedio: 'saude',
      saude: 'saude',
      bater_ponto: 'ponto',
      ponto: 'ponto',
      pesquisar: 'pesquisar',
      pesquisa: 'pesquisar',
      conversar: 'conversar',
    };

    if (modoMap[msg]) {
      const modo = modoMap[msg];
      await setModo(user.id, modo);
      return sendMessage(phone, MODO_MSG[modo] + MENU_FOOTER);
    }

    const modoAtual = await getModo(user.id);

    if (modoAtual === 'anotacao') {
      return salvarAnotacao(user, phone, text);
    }

    const classified = await classify(text);
    console.log(`[${phone}] Tipo: ${classified.tipo}`);

    if (classified.tipo === 'saudacao') return enviarMenu(phone);
    if (classified.tipo === 'cidade') return salvarCidade(user, phone, classified.cidade);
    if (classified.tipo === 'busca') return buscar(user, phone, classified.query || text);
    if (classified.tipo === 'anotacao') return salvarAnotacao(user, phone, classified.conteudo || classified.titulo || text);
    if (classified.tipo === 'tarefa') return salvarLembrete(user, phone, classified);
    if (classified.tipo === 'gasto') return salvarGasto(user, phone, classified);
    if (classified.tipo === 'medicamento') return salvarMedicamento(user, phone, classified);
    if (classified.tipo === 'ponto_multiplo') return salvarPonto(user, phone, classified.acoes || []);
    if (classified.tipo === 'consulta') return consultarMemoria(user, phone, text);
    if (classified.tipo === 'preferencia') return salvarPreferencia(user, phone, classified);

    return responderLivre(user, phone, text);
  } catch (error) {
    console.error('Erro handleMessage:', error);
    return sendMessage(phone, 'Ops, tive um probleminha. Pode repetir?');
  }
}

async function salvarCidade(user, phone, cidade) {
  await memory.saveMemory(user.id, 'cidade', cidade);
  return sendMessage(phone, `📍 Anotei! Vou usar *${cidade}* para clima e buscas locais.` + MENU_FOOTER);
}

async function salvarPreferencia(user, phone, classified) {
  await memory.saveUserPreference(user.id, classified.nome, classified.tom);
  return sendMessage(phone, 'Combinado, vou lembrar dessa preferência. 😊' + MENU_FOOTER);
}

async function buscar(user, phone, query) {
  await sendMessage(phone, '✨ _Clareando ideias..._');

  const mems = await memory.getRecentMemories(user.id, 20);
  let locationText = '';

  const locMem = mems.find((m) => m.type === 'localizacao');
  if (locMem) {
    try {
      const loc = JSON.parse(locMem.content);
      locationText = `${loc.latitude}, ${loc.longitude}`;
    } catch {}
  }

  if (!locationText) {
    locationText = mems.find((m) => m.type === 'cidade')?.content || '';
  }

  const resultado = await searchWeb(query, locationText);
  return sendMessage(phone, resultado + MENU_FOOTER);
}

async function salvarAnotacao(user, phone, conteudo) {
  await memory.saveMemory(user.id, 'anotacao', conteudo, { titulo: String(conteudo).substring(0, 50) });
  return sendButtons(phone, `📝 *Anotação salva!*\n\n_"${conteudo}"_`, [
    { id: 'ver_anotacoes', label: '📋 Ver anotações' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function salvarLembrete(user, phone, classified) {
  const titulo = classified.titulo || 'lembrete';
  await memory.saveMemory(user.id, 'tarefa', titulo, {
    data: classified.data,
    hora: classified.hora,
  });

  let linhaHorario = '';

  if (classified.hora) {
    const dataBase = classified.data || dateBRT();
    const [h, m] = classified.hora.split(':').map(Number);
    const scheduledAt = new Date(`${dataBase}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`);

    if (!classified.data && scheduledAt < nowBRT()) {
      scheduledAt.setDate(scheduledAt.getDate() + 1);
    }

    await prisma.reminder.create({
      data: {
        userId: user.id,
        phone,
        message: titulo,
        scheduledAt,
      },
    });

    linhaHorario = `\n🗓️ ${formatarDataHoraBR(scheduledAt)}`;
  }

  return sendButtons(phone, `🔔 *Lembrete criado!*\n\n📌 ${titulo}${linhaHorario}`, [
    { id: 'ver_lembretes', label: '📋 Ver lembretes' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function salvarGasto(user, phone, classified) {
  const valor = Number(classified.valor) || 0;
  const categoria = classified.categoria || 'outro';
  const descricao = classified.descricao || categoria;

  await memory.saveExpense(user.id, { valor, categoria, descricao });

  return sendButtons(phone, `💰 *Gasto registrado!*\n\n📌 ${categoria}\n💵 R$ ${valor.toFixed(2)}`, [
    { id: 'ver_gastos', label: '📋 Ver gastos' },
    { id: 'resumo_mes', label: '📊 Resumo do mês' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function salvarMedicamento(user, phone, classified) {
  const nome = classified.nome || classified.name || classified.titulo;
  const horarios = Array.isArray(classified.horarios) && classified.horarios.length
    ? classified.horarios
    : ['08:00'];

  if (!nome) {
    return sendMessage(phone, 'Me diz o nome do remédio e o horário? Exemplo: _"Losartana todo dia às 8h"_' + MENU_FOOTER);
  }

  await memory.saveMedication(user.id, {
    nome,
    quantidade: Number(classified.quantidade) || 0,
    frequencia: Number(classified.frequencia) || horarios.length || 1,
    horarios,
  });

  return sendButtons(phone, `💊 *Medicamento cadastrado!*\n\n${nome}\n⏰ ${horarios.join(', ')}`, [
    { id: 'ver_medicamentos', label: '📋 Ver medicamentos' },
    { id: 'novo_remedio', label: '➕ Novo remédio' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
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
