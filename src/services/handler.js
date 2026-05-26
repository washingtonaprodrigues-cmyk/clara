const { classify, searchWeb, freeResponse, generateMemorySummary } = require('./groq');
const { sendMessage, sendButtons, sendMainMenu, sendReminderWithButtons } = require('./whatsapp');
const memory = require('./memory');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const MENU_FOOTER = '\n\n_Digite *menu* para ver as opções 🏠_';

const BOAS_VINDAS_MODO = {
  'lembrete':  `⏰ *Lembretes*\n\nPosso te lembrar de uma reunião, uma tarefa ou qualquer compromisso que desejar!\n\nExemplos:\n• _"Me lembra às 19h de buscar minha filha"_\n• _"Lembrete amanhã às 8h de tomar remédio"_\n• _"Me lembra sexta às 18h da reunião"_\n\n_É só me dizer!_ 😊`,
  'anotacao':  `📝 *Anotações*\n\nGuardo qualquer informação pra você consultar quando quiser!\n\nExemplos:\n• _"Senha do Wi-Fi: 12345"_\n• _"Código do cliente: ABC123"_\n• _"Endereço da minha médica"_\n• _"Senha do cartão: 9010"_\n\n_O que quer guardar?_ 😊`,
  'gasto':     `💰 *Gastos*\n\nRegistro tudo e te mostro um resumo certinho do mês!\n\nExemplos:\n• _"Gastei 45 reais no mercado"_\n• _"Paguei 120 no restaurante"_\n• _"Quanto gastei esse mês?"_\n\n_Me conta seu gasto!_ 💸`,
  'saude':     `💊 *Saúde*\n\nVamos cadastrar um medicamento!\n\nQual o *nome do medicamento* que precisa de acompanhamento? 💊`,
  'ponto':     `📍 *Ponto Digital*\n\nRegistro sua jornada e calculo horas extras!\n\nExemplos:\n• _"Entrei às 8:15"_\n• _"Saí pra almoçar às 12:30"_\n• _"Voltei do almoço às 14:10"_\n• _"Saí do trabalho às 18:05"_\n\nOu tudo de uma vez:\n_"Entrei 8h, saí almoçar 12h, voltei 13h, saí 17h"_\n\n_Pode me dizer!_ 📍`,
  'pesquisar': `🔍 *Pesquisar*\n\nBusco qualquer coisa pra você na internet!\n\n☀️ _"Como está o tempo hoje?"_\n🔮 _"Horóscopo de Áries"_\n📞 _"Telefone da farmácia mais próxima"_\n📍 _"Endereço do Detran"_\n💵 _"Preço do dólar hoje"_\n\n_O que quer pesquisar?_ ✨`,
  'conversar': `💬 *Conversar*\n\nAdoro uma boa conversa! Pode falar à vontade sobre qualquer assunto 😄\n\n_Pode começar!_ 🥰`,
};

// ====================== UTILITÁRIOS ======================
function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function dateBRT() {
  const d = nowBRT();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function minutesToHours(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h${m > 0 ? m + 'min' : ''}`;
}

function horaStr(date) {
  if (!date) return '—';
  const d = new Date(date);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatarDataBR(date) {
  if (!date) return '—';
  const d = new Date(date);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function formatarDataHoraBR(date) {
  if (!date) return '—';
  const d = new Date(date);
  const hoje = nowBRT();
  const amanha = new Date(hoje);
  amanha.setDate(amanha.getDate() + 1);
  const dStr = `${d.getDate()}/${d.getMonth() + 1}`;
  const hStr = horaStr(d);
  if (d.toDateString() === hoje.toDateString()) return `Hoje às ${hStr}`;
  if (d.toDateString() === amanha.toDateString()) return `Amanhã às ${hStr}`;
  const dias = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  return `${dias[d.getDay()]} ${dStr} às ${hStr}`;
}

function criarDataBRT(dataStr, horaStr) {
  const [ano, mes, dia] = dataStr.split('-').map(Number);
  const [hora, min] = horaStr.split(':').map(Number);
  const d = new Date();
  d.setFullYear(ano, mes - 1, dia);
  d.setHours(hora, min, 0, 0);
  return new Date(d.getTime() + (d.getTimezoneOffset() + 180) * -60000);
}

async function getModoAtual(userId) {
  const mems = await memory.getRecentMemories(userId, 10);
  return mems.find(m => m.type === 'modo_atual')?.content || null;
}

async function getCadastroMed(userId) {
  const mems = await memory.getRecentMemories(userId, 10);
  const m = mems.find(m => m.type === 'cadastro_med');
  if (!m) return null;
  try { return JSON.parse(m.content); } catch { return null; }
}

async function salvarCadastroMed(userId, dados) {
  await memory.saveMemory(userId, 'cadastro_med', JSON.stringify(dados));
}

function normalizar(text) {
  return (text || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

async function responderLivre(user, phone, text) {
  const history = await memory.getConversationHistory(user.id, 10);
  const preferences = await memory.getUserPreference(user.id);
  const resp = await freeResponse(text, history, preferences);
  await memory.saveConversationMessage(user.id, 'user', text);
  await memory.saveConversationMessage(user.id, 'assistant', resp);
  return sendMessage(phone, resp + MENU_FOOTER);
}

async function responderNaoEntendi(phone) {
  return sendButtons(phone,
    `Entendi a ideia, mas preciso de um detalhe para fazer certinho.\n\nVocê pode escrever, por exemplo:\n• _"me lembra amanhã às 8h de ligar para Ana"_\n• _"gastei 35 reais no almoço"_\n• _"anota senha do Wi-Fi 12345"_`,
    [
      { id: 'criar_lembrete', label: '⏰ Criar lembrete' },
      { id: 'nova_anotacao', label: '📝 Salvar nota' },
      { id: 'menu', label: '🏠 Menu' },
    ]
  );
}

// ====================== HANDLER PRINCIPAL ======================
async function handleMessage(phone, text, location = null) {
  try {
    const user = await memory.getOrCreateUser(phone);

    if (location && location.latitude) {
      await memory.saveMemory(user.id, 'localizacao',
        JSON.stringify({ latitude: location.latitude, longitude: location.longitude, updatedAt: new Date().toISOString() })
      );
      return await sendMessage(phone, '✅ Localização recebida! Agora posso te ajudar melhor com clima, farmácias e lojas próximas.' + MENU_FOOTER);
    }

    if (!text) return;

    const textLower = normalizar(text);

    // MENU
    if (['menu', 'inicio', 'voltar', 'comeco', 'ajuda', 'opcoes'].includes(textLower)) {
      await memory.saveMemory(user.id, 'modo_atual', '');
      await memory.saveMemory(user.id, 'cadastro_med', '');
      return await sendMainMenu(phone);
    }

    // COMANDOS RÁPIDOS
    if (['ver lembretes', 'ver_lembretes'].includes(textLower)) return await listarLembretes(user, phone);
    if (['ver anotacoes', 'ver_anotacoes'].includes(textLower)) return await listarAnotacoes(user, phone);
    if (['ver gastos', 'ver_gastos', 'resumo_mes'].includes(textLower)) return await listarGastos(user, phone);
    if (['ver horas hoje', 'ver_horas_hoje'].includes(textLower)) return await listarPontoHoje(user, phone);
    if (['ver medicamentos', 'ver_medicamentos'].includes(textLower)) return await listarMedicamentos(user, phone);

    // ESCOLHA DO MODO
    const modoMap = {
      'lembretes': 'lembrete', 'lembrete': 'lembrete', 'criar_lembrete': 'lembrete',
      'anotacoes': 'anotacao', 'anotacao': 'anotacao', 'nova_anotacao': 'anotacao',
      'gastos': 'gasto', 'gasto': 'gasto', 'novo_gasto': 'gasto',
      'saude': 'saude', 'novo_remedio': 'saude',
      'ponto digital': 'ponto', 'ponto': 'ponto', 'bater_ponto': 'ponto',
      'pesquisar algo': 'pesquisar', 'pesquisar': 'pesquisar', 'pesquisa': 'pesquisar',
      'conversar': 'conversar', 'bater papo': 'conversar',
    };

    if (modoMap[textLower]) {
      const modo = modoMap[textLower];
      await memory.saveMemory(user.id, 'modo_atual', modo);
      if (modo === 'saude') {
        await memory.saveMemory(user.id, 'cadastro_med', JSON.stringify({ etapa: 'nome' }));
      }
      return await sendMessage(phone, BOAS_VINDAS_MODO[modo] + MENU_FOOTER);
    }

    // VERIFICA MODO ATUAL
    const modoAtual = await getModoAtual(user.id);

    // MODO ANOTAÇÃO
    if (modoAtual === 'anotacao') {
      await memory.saveMemory(user.id, 'anotacao', text, { titulo: text.substring(0, 50) });
      return await sendButtons(phone,
        `📝 *Anotação salva!*\n\n_"${text}"_\n\nGuardei isso aqui com segurança 💜`,
        [
          { id: 'ver_anotacoes', label: '📋 Ver anotações' },
          { id: 'menu', label: '🏠 Menu' },
        ]
      );
    }

    // MODO CONVERSAR
    if (modoAtual === 'conversar') {
      return await responderLivre(user, phone, text);
    }

    // MODO SAÚDE → fluxo guiado
    if (modoAtual === 'saude') {
      return await handleCadastroMedGuiado(user, phone, text);
    }

    // MODO PESQUISAR
    if (modoAtual === 'pesquisar') {
      const isClima = /clima|tempo|chuva|temperatura|previsão|chover|calor|frio/i.test(text);
      if (isClima) {
        const mems = await memory.getRecentMemories(user.id, 20);
        const temCidade = mems.find(m => m.type === 'cidade' || m.type === 'localizacao');
        if (!temCidade) {
          await memory.saveMemory(user.id, 'aguardando_cidade_busca', text);
          return await sendMessage(phone, '🌍 De qual cidade você quer saber o clima? 😊');
        }
      }
      const mems = await memory.getRecentMemories(user.id, 10);
      const aguardando = mems.find(m => m.type === 'aguardando_cidade_busca');
      if (aguardando) {
        await memory.saveMemory(user.id, 'cidade', text);
        return await handleBusca(user, phone, aguardando.content, text);
      }
    }

    const classified = await classify(text);
    console.log(`[${phone}] Tipo: ${classified.tipo}`);

    switch (classified.tipo) {
      case 'ponto_multiplo':
        await handlePontoMultiplo(user, phone, classified.acoes, text);
        break;
      case 'cidade':
        await handleCidade(user, phone, classified.cidade);
        break;
      case 'busca':
        await handleBusca(user, phone, classified.query || text);
        break;
      case 'anotacao':
        await handleNote(user, phone, classified);
        break;
      case 'tarefa':
        await handleTask(user, phone, classified);
        break;
      case 'gasto':
        await handleExpense(user, phone, classified);
        break;
      case 'medicamento':
        await handleCadastroMedGuiado(user, phone, text);
        break;
      case 'consulta':
        await handleQuery(user, phone, text);
        break;
      case 'saudacao':
        await handleSaudacao(user, phone);
        break;
      case 'preferencia':
        await handlePreferencia(user, phone, classified);
        break;
      default:
        if (text.length < 4) return await responderNaoEntendi(phone);
        await responderLivre(user, phone, text);
    }
  } catch (error) {
    console.error('Erro handleMessage:', error.message);
    await sendMessage(phone, 'Ops, tive um probleminha. Pode repetir?');
  }
}

// ====================== CADASTRO MEDICAMENTO GUIADO ======================
async function handleCadastroMedGuiado(user, phone, text) {
  let cadastro = await getCadastroMed(user.id) || { etapa: 'nome' };

  switch (cadastro.etapa) {
    case 'nome':
      cadastro.nome = text.trim();
      cadastro.etapa = 'dose';
      await salvarCadastroMed(user.id, cadastro);
      return await sendMessage(phone,
        `💊 *${cadastro.nome}*\n\nQual a *dose* de cada vez?\n\n_Exemplos: 1 comprimido, 2,5ml, 500mg_ 😊`
      );

    case 'dose':
      cadastro.dose = text.trim();
      cadastro.etapa = 'intervalo';
      await salvarCadastroMed(user.id, cadastro);
      return await sendMessage(phone,
        `⏱️ De *quantas em quantas horas* deve tomar?\n\n_Exemplos: 6, 8, 12, 24_ 😊`
      );

    case 'intervalo': {
      const horas = parseInt(text.replace(/[^0-9]/g, '')) || 8;
      cadastro.intervaloHoras = horas;
      cadastro.frequenciaDia = Math.round(24 / horas);
      cadastro.etapa = 'dias';
      await salvarCadastroMed(user.id, cadastro);
      return await sendMessage(phone,
        `📅 Por *quantos dias* vai usar?\n\n_Exemplos: 5, 7, 10, 30_ 😊`
      );
    }

    case 'dias': {
      const dias = parseInt(text.replace(/[^0-9]/g, '')) || 7;
      cadastro.dias = dias;
      cadastro.etapa = 'horario_inicio';
      await salvarCadastroMed(user.id, cadastro);
      return await sendMessage(phone,
        `🕐 Qual o *horário da primeira dose*?\n\n_Exemplo: 08:00, 19:00_ 😊`
      );
    }

    case 'horario_inicio': {
      // Extrai hora do texto
      const match = text.match(/(\d{1,2})[:\s]?(\d{0,2})/);
      const hora = match ? parseInt(match[1]) : 8;
      const min = match && match[2] ? parseInt(match[2]) : 0;

      // Calcula todos os horários baseado no intervalo
      const horarios = [];
      for (let i = 0; i < cadastro.frequenciaDia; i++) {
        const h = (hora + (i * cadastro.intervaloHoras)) % 24;
        horarios.push(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`);
      }

      const totalDoses = cadastro.dias * cadastro.frequenciaDia;
      const termina = new Date(nowBRT());
      termina.setDate(termina.getDate() + cadastro.dias);

      // Salva no banco
      await memory.saveMedication(user.id, {
        nome: cadastro.nome,
        quantidade: totalDoses,
        frequencia: cadastro.frequenciaDia,
        horarios,
      });

      // Limpa cadastro
      await memory.saveMemory(user.id, 'cadastro_med', '');
      await memory.saveMemory(user.id, 'modo_atual', '');

      const resumo =
        `💊 *Medicamento cadastrado!*\n\n` +
        `📋 *${cadastro.nome}*\n` +
        `💊 Dose: ${cadastro.dose}\n` +
        `⏱️ A cada ${cadastro.intervaloHoras}h\n` +
        `⏰ Horários: ${horarios.join(', ')}\n` +
        `🔄 ${cadastro.frequenciaDia}x por dia\n` +
        `📅 Duração: ${cadastro.dias} dias\n` +
        `💊 Total de doses: ${totalDoses}\n` +
        `🏁 Termina em: ${formatarDataBR(termina)}\n\n` +
        `Vou te lembrar em todos os horários! 😊`;

      return await sendButtons(phone, resumo, [
        { id: 'ver_medicamentos', label: '📋 Ver medicamentos' },
        { id: 'novo_remedio', label: '➕ Novo remédio' },
        { id: 'menu', label: '🏠 Menu' },
      ]);
    }

    default:
      cadastro = { etapa: 'nome' };
      await salvarCadastroMed(user.id, cadastro);
      return await sendMessage(phone,
        `💊 Vamos cadastrar um medicamento!\n\nQual o *nome do medicamento*? 😊`
      );
  }
}

// ====================== SAUDAÇÃO ======================
async function handleSaudacao(user, phone) {
  const cidade = await getCidadeUsuario(user.id);
  await sendMainMenu(phone);
  if (!cidade) {
    setTimeout(async () => {
      await sendMessage(phone, '📍 _Dica: me diz sua cidade e vou buscar clima e locais pra você!_');
    }, 1500);
  }
}

async function getCidadeUsuario(userId) {
  const mems = await memory.getRecentMemories(userId, 50);
  return mems.find(m => m.type === 'cidade')?.content || null;
}

// ====================== CIDADE ======================
async function handleCidade(user, phone, cidade) {
  await memory.saveMemory(user.id, 'cidade', cidade);
  await sendMessage(phone, `Anotei! 📍 Vou usar *${cidade}* para buscas locais.` + MENU_FOOTER);
}

// ====================== PREFERÊNCIA ======================
async function handlePreferencia(user, phone, classified) {
  await memory.saveUserPreference(user.id, classified.nome, classified.tom);
  const partes = [];
  if (classified.nome) partes.push(`vou te chamar de *${classified.nome}*`);
  if (classified.tom) partes.push(`vou usar um tom mais *${classified.tom}*`);
  const msg = partes.length ? `Combinado, ${partes.join(' e ')}.` : 'Combinado!';
  await sendMessage(phone, `${msg} 😊` + MENU_FOOTER);
}

// ====================== PONTO MÚLTIPLO ======================
async function handlePontoMultiplo(user, phone, acoes, originalText) {
  await sendMessage(phone, '📍 Registrando seus pontos...');
  const hoje = dateBRT();

  for (const acao of acoes) {
    let subtipo = (acao.subtipo || '').toLowerCase().trim();
    if (subtipo === 'entrada' || subtipo.includes('cheg') || subtipo.includes('entrei')) subtipo = 'entrada';
    else if (subtipo === 'saida_almoco' || subtipo.includes('saida_almoco') || (subtipo.includes('almo') && (subtipo.includes('sai') || subtipo.includes('saí')))) subtipo = 'saida_almoco';
    else if (subtipo === 'volta_almoco' || subtipo.includes('volta_almoco') || (subtipo.includes('almo') && (subtipo.includes('volt') || subtipo.includes('retorn')))) subtipo = 'volta_almoco';
    else if (subtipo === 'saida' || subtipo.includes('saí') || subtipo.includes('sai') || subtipo.includes('saida')) subtipo = 'saida';

    const horaUsada = acao.hora || 'agora';
    const timestamp = horaUsada !== 'agora' ? convertToDateWithTime(horaUsada) : nowBRT();

    const existing = await prisma.workLog.findFirst({ where: { userId: user.id, type: subtipo, date: hoje } });
    if (existing) {
      await prisma.workLog.update({ where: { id: existing.id }, data: { timestamp } });
    } else {
      await prisma.workLog.create({ data: { userId: user.id, type: subtipo, timestamp, date: hoje } });
    }
  }

  const pontosHoje = await prisma.workLog.findMany({ where: { userId: user.id, date: hoje }, orderBy: { timestamp: 'asc' } });
  const resumo = await gerarResumoDoBanco(pontosHoje, user.id);
  await sendButtons(phone, resumo, [
    { id: 'ver_horas_hoje', label: '📋 Ver horas hoje' },
    { id: 'bater_ponto', label: '📍 Bater ponto' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

function convertToDateWithTime(horaStr) {
  const [hora, min] = horaStr.split(':').map(Number);
  const date = nowBRT();
  date.setHours(hora, min || 0, 0, 0);
  return date;
}

async function gerarResumoDoBanco(pontos, userId) {
  const get = (tipo) => pontos.find(p => p.type === tipo);
  const entrada = get('entrada');
  const saidaAlmoco = get('saida_almoco');
  const voltaAlmoco = get('volta_almoco');
  const saida = get('saida');
  const jornada = await memory.getJornada(userId);

  let tempoManha = null, tempoTarde = null, totalTrabalhado = null, horasExtras = null;
  if (entrada && saidaAlmoco) tempoManha = (new Date(saidaAlmoco.timestamp) - new Date(entrada.timestamp)) / 60000;
  if (voltaAlmoco && saida) tempoTarde = (new Date(saida.timestamp) - new Date(voltaAlmoco.timestamp)) / 60000;
  if (tempoManha !== null && tempoTarde !== null) { totalTrabalhado = tempoManha + tempoTarde; horasExtras = totalTrabalhado - jornada; }

  let texto = entrada && !saida
    ? `📍 *Entrada registrada!*\n\n🕘 Você iniciou seu expediente às *${horaStr(entrada.timestamp)}*.\n\nTenha um ótimo trabalho hoje 💜\n\n`
    : `✨ *Resumo do seu dia*\n\n`;

  texto += `🟢 Entrada: *${horaStr(entrada?.timestamp)}*\n`;
  texto += `🍽️ Saída almoço: *${horaStr(saidaAlmoco?.timestamp)}*\n`;
  if (tempoManha !== null) texto += `⏱️ Manhã: *${minutesToHours(tempoManha)}*\n`;
  texto += `🔄 Volta almoço: *${horaStr(voltaAlmoco?.timestamp)}*\n`;
  if (saida) texto += `🔴 Saída: *${horaStr(saida.timestamp)}*\n`;
  if (tempoTarde !== null) texto += `⏱️ Tarde: *${minutesToHours(tempoTarde)}*\n`;
  if (totalTrabalhado !== null) {
    texto += `\n📊 Total: *${minutesToHours(totalTrabalhado)}*\n`;
    if (horasExtras > 0) texto += `⭐ Horas extras: *${minutesToHours(horasExtras)}*\n`;
    else if (horasExtras < 0) texto += `⚠️ Faltam: *${minutesToHours(Math.abs(horasExtras))}*\n`;
    else texto += `✅ Jornada completa!\n`;
  }
  if (!saida) texto += `\n💡 Me avisa quando sair!`;
  return texto;
}

// ====================== BUSCA ======================
async function handleBusca(user, phone, query, cidadeOverride = null) {
  await sendMessage(phone, '✨ _Clareando ideias..._');
  const mems = await memory.getRecentMemories(user.id, 20);
  let locationText = cidadeOverride || '';

  if (!locationText) {
    const locationMem = mems.find(m => m.type === 'localizacao');
    if (locationMem) { try { const loc = JSON.parse(locationMem.content); locationText = `${loc.latitude}, ${loc.longitude}`; } catch (e) {} }
  }
  if (!locationText) {
    const cidadeMem = mems.find(m => m.type === 'cidade');
    if (cidadeMem) locationText = cidadeMem.content;
  }

  let queryFinal = query;
  if (locationText) {
    queryFinal = query
      .replace(/minha cidade/gi, locationText)
      .replace(/aqui/gi, locationText)
      .replace(/perto de mim/gi, `perto de ${locationText}`)
      .replace(/próximo a mim/gi, `próximo a ${locationText}`);
  }

  const resultado = await searchWeb(queryFinal, locationText);
  let mensagem = resultado.text;
  if (resultado.sourceUrl) mensagem += `\n\n🔗 _${resultado.sourceUrl}_`;

  await sendButtons(phone, mensagem, [
    { id: 'pesquisar', label: '🔍 Nova pesquisa' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

// ====================== ANOTAÇÃO ======================
async function handleNote(user, phone, classified) {
  const conteudo = classified.conteudo || classified.titulo || '';
  await memory.saveMemory(user.id, 'anotacao', conteudo, { titulo: classified.titulo });
  await sendButtons(phone,
    `📝 *Anotação salva!*\n\n_"${conteudo}"_\n\nGuardei isso aqui com segurança 💜`,
    [
      { id: 'ver_anotacoes', label: '📋 Ver anotações' },
      { id: 'menu', label: '🏠 Menu' },
    ]
  );
}

// ====================== TAREFA ======================
async function handleTask(user, phone, classified) {
  await memory.saveMemory(user.id, 'tarefa', classified.titulo, { data: classified.data, hora: classified.hora });

  if (classified.hora) {
    try {
      const hoje = classified.data || dateBRT();
      const scheduledAt = criarDataBRT(hoje, classified.hora);
      if (!classified.data && scheduledAt < nowBRT()) scheduledAt.setDate(scheduledAt.getDate() + 1);

      await prisma.reminder.create({ data: { userId: user.id, phone, message: classified.titulo, scheduledAt } });

      await sendButtons(phone,
        `🔔 *Lembrete criado com sucesso!*\n\n📌 ${classified.titulo}\n🗓️ ${formatarDataHoraBR(scheduledAt)}\n\nVou te avisar no horário certinho 😊`,
        [
          { id: 'ver_lembretes', label: '📋 Ver lembretes' },
          { id: 'menu', label: '🏠 Menu' },
        ]
      );
    } catch (e) {
      console.error('Erro criar reminder:', e.message);
      await sendMessage(phone, `Guardei! Vou te lembrar às *${classified.hora}*. ⏰` + MENU_FOOTER);
    }
  } else {
    await sendButtons(phone,
      `🔔 *Lembrete criado!*\n\n📌 ${classified.titulo}\n\nGuardei aqui pra você 😊`,
      [
        { id: 'ver_lembretes', label: '📋 Ver lembretes' },
        { id: 'menu', label: '🏠 Menu' },
      ]
    );
  }
}

// ====================== GASTO ======================
async function handleExpense(user, phone, classified) {
  const valor = Number(classified.valor) || 0;
  const categoria = classified.categoria || 'outro';
  await memory.saveExpense(user.id, { valor, categoria, descricao: classified.descricao || categoria });

  const icons = { mercado: '🛒', restaurante: '🍽️', saude: '💊', transporte: '🚗', lazer: '🎉', outro: '📦' };

  await sendButtons(phone,
    `💰 *Gasto registrado!*\n\n${icons[categoria] || '📦'} *${categoria.charAt(0).toUpperCase() + categoria.slice(1)}*\n💵 R$ ${valor.toFixed(2)}\n\nSeu gasto foi salvo no controle financeiro 😊`,
    [
      { id: 'ver_gastos', label: '📋 Ver gastos' },
      { id: 'resumo_mes', label: '📊 Resumo do mês' },
      { id: 'menu', label: '🏠 Menu' },
    ]
  );
}

// ====================== CONSULTA ======================
async function handleQuery(user, phone, question) {
  await sendMessage(phone, '💭 _Deixa eu ver isso pra você..._');
  const memories = await memory.getRecentMemories(user.id, 30);
  if (memories.length === 0) {
    return await sendButtons(phone, 'Ainda não guardei nada pra você. Me conta algo!',
      [{ id: 'menu', label: '🏠 Menu' }]
    );
  }
  const answer = await generateMemorySummary(memories, question);
  await sendButtons(phone, answer, [{ id: 'menu', label: '🏠 Menu' }]);
}

// ====================== LISTAGENS ======================
async function listarLembretes(user, phone) {
  const agora = nowBRT();
  const reminders = await prisma.reminder.findMany({
    where: { userId: user.id, sent: false, confirmed: false, scheduledAt: { gte: agora } },
    orderBy: { scheduledAt: 'asc' }, take: 10,
  });

  if (reminders.length === 0) {
    return await sendButtons(phone, `📋 *Seus lembretes*\n\nVocê não tem lembretes ativos no momento 😊`,
      [{ id: 'lembrete', label: '➕ Criar lembrete' }, { id: 'menu', label: '🏠 Menu' }]
    );
  }

  const numeros = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
  let texto = `📋 *Seus lembretes ativos*\n\n`;
  reminders.forEach((r, i) => {
    texto += `${numeros[i] || `${i+1}.`} 📌 ${r.message}\n    🗓️ ${formatarDataHoraBR(r.scheduledAt)}\n\n`;
  });
  texto += `_${reminders.length} lembrete${reminders.length > 1 ? 's' : ''} ativo${reminders.length > 1 ? 's' : ''}_ ✨`;

  await sendButtons(phone, texto, [
    { id: 'criar_lembrete', label: '➕ Criar lembrete' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function listarAnotacoes(user, phone) {
  const mems = await memory.getRecentMemories(user.id, 50);
  const anotacoes = mems.filter(m => m.type === 'anotacao').slice(0, 10);

  if (anotacoes.length === 0) {
    return await sendButtons(phone, `📝 *Suas anotações*\n\nVocê ainda não tem anotações salvas 😊`,
      [{ id: 'anotacao', label: '➕ Nova anotação' }, { id: 'menu', label: '🏠 Menu' }]
    );
  }

  let texto = `📝 *Suas anotações*\n\n`;
  anotacoes.forEach(a => { texto += `📌 _"${a.content}"_\n🗓️ ${formatarDataBR(a.createdAt)}\n\n`; });
  texto += `_${anotacoes.length} anotaç${anotacoes.length > 1 ? 'ões' : 'ão'} salva${anotacoes.length > 1 ? 's' : ''}_ 💜`;

  await sendButtons(phone, texto, [
    { id: 'nova_anotacao', label: '➕ Nova anotação' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function listarGastos(user, phone) {
  const start = nowBRT();
  start.setDate(1); start.setHours(0, 0, 0, 0);

  const gastos = await prisma.expense.findMany({
    where: { userId: user.id, createdAt: { gte: start } },
    orderBy: { createdAt: 'desc' }, take: 10,
  });

  if (gastos.length === 0) {
    return await sendButtons(phone, `💰 *Seus gastos*\n\nNenhum gasto registrado este mês 😊`,
      [{ id: 'gasto', label: '➕ Registrar gasto' }, { id: 'menu', label: '🏠 Menu' }]
    );
  }

  const total = gastos.reduce((acc, g) => acc + g.value, 0);
  const icons = { mercado: '🛒', restaurante: '🍽️', saude: '💊', transporte: '🚗', lazer: '🎉', outro: '📦' };
  let texto = `💰 *Gastos do mês*\n\n`;
  gastos.forEach(g => { texto += `${icons[g.category] || '📦'} *${g.category}* — R$ ${g.value.toFixed(2)}\n🗓️ ${formatarDataBR(g.createdAt)}\n\n`; });
  texto += `───────────────\n💵 *Total: R$ ${total.toFixed(2)}*`;

  await sendButtons(phone, texto, [
    { id: 'novo_gasto', label: '➕ Novo gasto' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function listarPontoHoje(user, phone) {
  const hoje = dateBRT();
  const pontos = await prisma.workLog.findMany({ where: { userId: user.id, date: hoje }, orderBy: { timestamp: 'asc' } });

  if (pontos.length === 0) {
    return await sendButtons(phone, `📍 *Ponto de hoje*\n\nNenhum registro de ponto hoje ainda 😊`,
      [{ id: 'ponto', label: '📍 Bater ponto' }, { id: 'menu', label: '🏠 Menu' }]
    );
  }

  const resumo = await gerarResumoDoBanco(pontos, user.id);
  await sendButtons(phone, resumo, [
    { id: 'bater_ponto', label: '📍 Bater ponto' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function listarMedicamentos(user, phone) {
  const meds = await prisma.medication.findMany({ where: { userId: user.id, active: true }, orderBy: { createdAt: 'desc' } });

  if (meds.length === 0) {
    return await sendButtons(phone, `💊 *Seus medicamentos*\n\nNenhum medicamento cadastrado ainda 😊`,
      [{ id: 'saude', label: '➕ Cadastrar remédio' }, { id: 'menu', label: '🏠 Menu' }]
    );
  }

  let texto = `💊 *Seus medicamentos ativos*\n\n`;
  meds.forEach(m => {
    const horarios = JSON.parse(m.times || '[]').join(', ');
    texto += `💊 *${m.name}*\n⏰ ${horarios} — ${m.frequency}x por dia\n💊 Restam: ${m.remaining} comprimido${m.remaining !== 1 ? 's' : ''}\n\n`;
  });

  await sendButtons(phone, texto, [
    { id: 'novo_remedio', label: '➕ Novo remédio' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

module.exports = { handleMessage };
