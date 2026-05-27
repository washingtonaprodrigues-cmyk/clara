const { classify, searchWeb, freeResponse, generateMemorySummary } = require('./groq');
const { sendMessage, sendButtons, sendMainMenu, sendReminderWithButtons } = require('./whatsapp');
const memory = require('./memory');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const BASE_URL = 'https://clara-production-8128.up.railway.app';
const MENU_FOOTER = '\n\n_Digite *menu* a qualquer momento 🏠_';

// ====================== MENSAGEM DE BOAS-VINDAS ======================
const PRIMEIRA_MENSAGEM = `✨ Clara online 💜

Oi! Como posso te ajudar hoje? 😊

Posso cuidar dos seus:
🔔 lembretes
💊 horários de remédios
⏰ registro de ponto
💰 gastos
📅 rotina do dia

Digite *menu* a qualquer momento para ver tudo o que posso fazer.`;

const BOAS_VINDAS_MODO = {
  'lembrete': (phone) =>
    `⏰ *Lembretes*\n\nEscolha como prefere criar:\n\n` +
    `📋 Pelo formulário: ${BASE_URL}/forms/lembrete/${phone}\n\n` +
    `_Ou me diga diretamente, por exemplo:_\n` +
    `_"me lembra de pagar a conta amanhã"_`,

  'anotacao': () =>
    `📝 *Anotações*\n\nMe diga o que quer guardar.\n\n` +
    `_Exemplos: senha do Wi-Fi, endereço, código..._`,

  'gasto': () =>
    `💰 *Gastos*\n\nMe conta o que gastou.\n\n` +
    `_Exemplo: "gastei 45 reais no mercado"_`,

  'saude': (phone) =>
    `💊 *Remédios*\n\nEscolha como prefere cadastrar:\n\n` +
    `📋 Pelo formulário: ${BASE_URL}/forms/remedio/${phone}\n\n` +
    `_Ou me diga diretamente:_\n` +
    `_"Amoxicilina 8h e 20h por 7 dias"_`,

  'ponto': (phone) =>
    `📍 *Ponto Digital*\n\nEscolha como prefere registrar:\n\n` +
    `📋 Pelo formulário: ${BASE_URL}/forms/ponto/${phone}\n\n` +
    `_Ou me diga diretamente:_\n` +
    `_"entrei às 8h"_ ou _"saí do trabalho"_`,

  'pesquisar': () =>
    `🔍 *Pesquisar*\n\nO que quer buscar?\n\n` +
    `_Clima, telefones, endereços, notícias..._`,

  'conversar': () =>
    `💬 Pode falar à vontade 😊`,
};

// ====================== UTILITÁRIOS ======================
function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function dateBRT() {
  const d = nowBRT();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function amanhaBRT() {
  const d = nowBRT();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function minutesToHours(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h${m > 0 ? m + 'min' : ''}`;
}

function horaStr(date) {
  if (!date) return '—';
  const d = new Date(date);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function formatarDataBR(date) {
  if (!date) return '—';
  const d = new Date(date);
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}

function formatarDataHoraBR(date) {
  if (!date) return '—';
  const d = new Date(date);
  const hoje = nowBRT();
  const amanha = new Date(hoje);
  amanha.setDate(amanha.getDate() + 1);
  const hStr = horaStr(d);
  if (d.toDateString() === hoje.toDateString()) return `hoje às ${hStr}`;
  if (d.toDateString() === amanha.toDateString()) return `amanhã às ${hStr}`;
  const dias = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  return `${dias[d.getDay()]} ${d.getDate()}/${d.getMonth()+1} às ${hStr}`;
}

function criarDataBRT(dataStr, horaStr) {
  const isoStr = `${dataStr}T${horaStr.padStart(5,'0')}:00-03:00`;
  return new Date(isoStr);
}

async function getModoAtual(userId) {
  const mems = await memory.getRecentMemories(userId, 10);
  return mems.find(m => m.type === 'modo_atual')?.content || null;
}

async function getCadastroMed(userId) {
  const mems = await memory.getRecentMemories(userId, 10);
  const m = mems.find(m => m.type === 'cadastro_med');
  if (!m || !m.content) return null;
  try { return JSON.parse(m.content); } catch { return null; }
}

async function salvarCadastroMed(userId, dados) {
  await memory.saveMemory(userId, 'cadastro_med', JSON.stringify(dados));
}

function normalizar(text) {
  return (text || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

async function responderLivre(user, phone, text) {
  const history = await memory.getConversationHistory(user.id, 10);
  const preferences = await memory.getUserPreference(user.id);
  const resp = await freeResponse(text, history, preferences);
  await memory.saveConversationMessage(user.id, 'user', text);
  await memory.saveConversationMessage(user.id, 'assistant', resp);
  return sendMessage(phone, resp + MENU_FOOTER);
}

// ====================== HANDLER PRINCIPAL ======================
async function handleMessage(phone, text, location = null) {
  try {
    const user = await memory.getOrCreateUser(phone);

    // LOCALIZAÇÃO
    if (location && location.latitude) {
      await memory.saveMemory(user.id, 'localizacao',
        JSON.stringify({ latitude: location.latitude, longitude: location.longitude, updatedAt: new Date().toISOString() })
      );
      return await sendMessage(phone, '📍 Localização recebida! Agora posso te ajudar com buscas locais.' + MENU_FOOTER);
    }

    if (!text) return;

    // PRIMEIRA VEZ — onboarding
    const mems = await memory.getRecentMemories(user.id, 100);
    const isNovo = mems.length === 0 && !user.name;
    if (isNovo) {
      await memory.saveMemory(user.id, 'modo_atual', 'onboarding');
      await sendMessage(phone, PRIMEIRA_MENSAGEM);
      setTimeout(async () => {
        await sendMessage(phone,
          `✨ Antes de começarmos...\n\nPra te ajudar melhor, me conta rapidinho:\n\n👤 Como você prefere que eu te chame?\n\n⏰ Qual seu horário de trabalho?\n_Exemplo: "Entro 08:00, almoço 12:00 até 13:00 e saio 17:00"_`
        );
      }, 1500);
      return;
    }

    const textLower = normalizar(text);

    // MENU
    if (['menu', 'inicio', 'voltar', 'ajuda', 'opcoes'].includes(textLower)) {
      await memory.saveMemory(user.id, 'modo_atual', '');
      await memory.saveMemory(user.id, 'cadastro_med', '');
      return await sendMainMenu(phone);
    }

    // COMANDOS RÁPIDOS
    if (['ver lembretes','ver_lembretes'].includes(textLower)) return await listarLembretes(user, phone);
    if (['ver anotacoes','ver_anotacoes'].includes(textLower)) return await listarAnotacoes(user, phone);
    if (['ver gastos','ver_gastos','resumo_mes'].includes(textLower)) return await listarGastos(user, phone);
    if (['ver horas hoje','ver_horas_hoje'].includes(textLower)) return await listarPontoHoje(user, phone);
    if (['ver medicamentos','ver_medicamentos'].includes(textLower)) return await listarMedicamentos(user, phone);

    // ESCOLHA DO MODO
    const modoMap = {
      'lembretes': 'lembrete', 'lembrete': 'lembrete', 'criar_lembrete': 'lembrete',
      'anotacoes': 'anotacao', 'anotacao': 'anotacao', 'nova_anotacao': 'anotacao',
      'gastos': 'gasto', 'gasto': 'gasto', 'novo_gasto': 'gasto',
      'saude': 'saude', 'novo_remedio': 'saude', 'remedios': 'saude',
      'ponto digital': 'ponto', 'ponto': 'ponto', 'bater_ponto': 'ponto',
      'pesquisar': 'pesquisar', 'pesquisa': 'pesquisar',
      'conversar': 'conversar', 'bater papo': 'conversar',
    };

    if (modoMap[textLower]) {
      const modo = modoMap[textLower];
      await memory.saveMemory(user.id, 'modo_atual', modo);
      if (modo === 'saude') {
        await memory.saveMemory(user.id, 'cadastro_med', JSON.stringify({ etapa: 'nome' }));
      }
      const msgFn = BOAS_VINDAS_MODO[modo];
      const msg = typeof msgFn === 'function' ? msgFn(phone) : msgFn;
      return await sendMessage(phone, msg + MENU_FOOTER);
    }

    // MODO ATUAL
    const modoAtual = await getModoAtual(user.id);

    // ONBOARDING
    if (modoAtual === 'onboarding') {
      return await handleOnboarding(user, phone, text);
    }

    // ANOTAÇÃO
    if (modoAtual === 'anotacao') {
      await memory.saveMemory(user.id, 'anotacao', text, { titulo: text.substring(0, 50) });
      await memory.saveMemory(user.id, 'modo_atual', '');
      return await sendMessage(phone, `Anotado 📝\n\n_"${text}"_\n\nGuardei aqui com segurança.` + MENU_FOOTER);
    }

    // CONVERSAR
    if (modoAtual === 'conversar') {
      return await responderLivre(user, phone, text);
    }

    // SAÚDE
    if (modoAtual === 'saude') {
      return await handleCadastroMedGuiado(user, phone, text);
    }

    // PESQUISAR
    if (modoAtual === 'pesquisar') {
      const isClima = /clima|tempo|chuva|temperatura|chover|calor|frio/i.test(text);
      if (isClima) {
        const ms = await memory.getRecentMemories(user.id, 20);
        const temCidade = ms.find(m => m.type === 'cidade' || m.type === 'localizacao');
        if (!temCidade) {
          await memory.saveMemory(user.id, 'aguardando_cidade_busca', text);
          return await sendMessage(phone, 'De qual cidade você quer saber o clima? 🌍');
        }
      }
      const ms = await memory.getRecentMemories(user.id, 10);
      const aguardando = ms.find(m => m.type === 'aguardando_cidade_busca');
      if (aguardando) {
        await memory.saveMemory(user.id, 'cidade', text);
        return await handleBusca(user, phone, aguardando.content, text);
      }
    }

    const classified = await classify(text);
    console.log(`[${phone}] Tipo: ${classified.tipo}`);

    switch (classified.tipo) {
      case 'onboarding':
        await handleOnboarding(user, phone, text, classified);
        break;
      case 'ponto_multiplo':
        await handlePontoMultiplo(user, phone, classified.acoes);
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
        if (text.length < 3) return;
        await responderLivre(user, phone, text);
    }
  } catch (error) {
    console.error('Erro handleMessage:', error.message);
    await sendMessage(phone, 'Ops, tive um probleminha. Pode repetir?');
  }
}

// ====================== ONBOARDING ======================
async function handleOnboarding(user, phone, text, classified = null) {
  const data = classified || {};

  // Extrai nome e jornada do texto se não vier classificado
  let nome = data.nome || null;
  let jornada = data.jornada || null;

  // Tenta extrair nome se não veio classificado
  if (!nome) {
    const matchNome = text.match(/(?:me chamo|meu nome é|pode me chamar de|sou o|sou a)\s+(\w+)/i);
    if (matchNome) nome = matchNome[1];
    else if (text.split(' ').length <= 3 && !/\d/.test(text)) nome = text.trim().split(' ')[0];
  }

  if (nome) {
    await memory.saveUserPreference(user.id, nome, null);
  }

  if (jornada) {
    const partes = jornada.split('-');
    if (partes.length === 4) {
      const [entrada, almocoIni, almocoFim, saida] = partes;
      const toMin = h => { const [hh, mm] = h.split(':').map(Number); return hh * 60 + mm; };
      const manha = toMin(almocoIni) - toMin(entrada);
      const tarde = toMin(saida) - toMin(almocoFim);
      await memory.saveJornada(user.id, manha + tarde);
    }
  }

  // Finaliza onboarding
  await memory.saveMemory(user.id, 'modo_atual', '');

  const nomeAtual = nome || user.name;
  if (nomeAtual) {
    await sendMainMenu(phone);
    setTimeout(async () => {
      await sendMessage(phone, `Prazer, ${nomeAtual}! 😊 Pode me chamar quando precisar de qualquer coisa.`);
    }, 1000);
  } else {
    await sendMainMenu(phone);
  }
}

// ====================== SAUDAÇÃO ======================
async function handleSaudacao(user, phone) {
  const cidade = await getCidadeUsuario(user.id);
  await sendMainMenu(phone);
  if (!cidade) {
    setTimeout(async () => {
      await sendMessage(phone, '📍 Me diz sua cidade e busco clima e locais pra você!');
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
  await sendMessage(phone, `📍 Anotei! Vou usar ${cidade} para buscas locais.` + MENU_FOOTER);
}

// ====================== PREFERÊNCIA ======================
async function handlePreferencia(user, phone, classified) {
  await memory.saveUserPreference(user.id, classified.nome, classified.tom);
  const partes = [];
  if (classified.nome) partes.push(`vou te chamar de ${classified.nome}`);
  if (classified.tom) partes.push(`tom ${classified.tom}`);
  await sendMessage(phone, `Combinado${partes.length ? ', ' + partes.join(' e ') : ''}! 😊` + MENU_FOOTER);
}

// ====================== CADASTRO MEDICAMENTO GUIADO ======================
async function handleCadastroMedGuiado(user, phone, text) {
  let cadastro = await getCadastroMed(user.id) || { etapa: 'nome' };

  switch (cadastro.etapa) {
    case 'nome':
      cadastro.nome = text.trim();
      cadastro.etapa = 'dose';
      await salvarCadastroMed(user.id, cadastro);
      return await sendMessage(phone, `💊 ${cadastro.nome}\n\nQual a dose de cada vez?\n_Exemplos: 1 comprimido, 2,5ml, 500mg_`);

    case 'dose':
      cadastro.dose = text.trim();
      cadastro.etapa = 'intervalo';
      await salvarCadastroMed(user.id, cadastro);
      return await sendMessage(phone, `De quantas em quantas horas?\n_Exemplos: 6, 8, 12, 24_`);

    case 'intervalo': {
      cadastro.intervaloHoras = parseInt(text.replace(/[^0-9]/g, '')) || 8;
      cadastro.frequenciaDia = Math.round(24 / cadastro.intervaloHoras);
      cadastro.etapa = 'dias';
      await salvarCadastroMed(user.id, cadastro);
      return await sendMessage(phone, `Por quantos dias?\n_Exemplos: 5, 7, 10, 30_`);
    }

    case 'dias': {
      cadastro.dias = parseInt(text.replace(/[^0-9]/g, '')) || 7;
      cadastro.etapa = 'horario_inicio';
      await salvarCadastroMed(user.id, cadastro);
      return await sendMessage(phone, `Qual o horário da primeira dose?\n_Exemplo: 08:00, 19:00_`);
    }

    case 'horario_inicio': {
      const match = text.match(/(\d{1,2})[:\s]?(\d{0,2})/);
      const hora = match ? parseInt(match[1]) : 8;
      const min = match && match[2] ? parseInt(match[2]) : 0;

      const horarios = [];
      for (let i = 0; i < cadastro.frequenciaDia; i++) {
        const h = (hora + i * cadastro.intervaloHoras) % 24;
        horarios.push(`${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`);
      }

      const totalDoses = cadastro.dias * cadastro.frequenciaDia;
      const termina = new Date(nowBRT());
      termina.setDate(termina.getDate() + cadastro.dias);

      await memory.saveMedication(user.id, {
        nome: cadastro.nome,
        quantidade: totalDoses,
        frequencia: cadastro.frequenciaDia,
        horarios,
      });

      await memory.saveMemory(user.id, 'cadastro_med', '');
      await memory.saveMemory(user.id, 'modo_atual', '');

      return await sendButtons(phone,
        `✅ Remédio anotado!\n\n💊 ${cadastro.nome}\n💊 Dose: ${cadastro.dose}\n🕒 ${horarios.join(', ')}\n📅 ${cadastro.dias} dias · ${totalDoses} doses · até ${formatarDataBR(termina)}\n\nVou te lembrar nos horários certinhos.`,
        [
          { id: 'ver_medicamentos', label: '💊 Ver remédios' },
          { id: 'novo_remedio', label: '➕ Novo remédio' },
          { id: 'menu', label: '🏠 Menu' },
        ]
      );
    }

    default:
      cadastro = { etapa: 'nome' };
      await salvarCadastroMed(user.id, cadastro);
      return await sendMessage(phone, `💊 Qual o nome do medicamento?`);
  }
}

// ====================== PONTO MÚLTIPLO ======================
async function handlePontoMultiplo(user, phone, acoes) {
  const hoje = dateBRT();

  for (const acao of acoes) {
    let subtipo = (acao.subtipo || '').toLowerCase().trim();
    if (subtipo === 'entrada' || subtipo.includes('cheg') || subtipo.includes('entrei')) subtipo = 'entrada';
    else if (subtipo === 'saida_almoco' || (subtipo.includes('almo') && (subtipo.includes('sai') || subtipo.includes('saí')))) subtipo = 'saida_almoco';
    else if (subtipo === 'volta_almoco' || (subtipo.includes('almo') && (subtipo.includes('volt') || subtipo.includes('retorn')))) subtipo = 'volta_almoco';
    else if (subtipo === 'saida' || subtipo.includes('saí') || subtipo.includes('sai') || subtipo.includes('saida')) subtipo = 'saida';

    const horaUsada = acao.hora || 'agora';
    // Usa ISO com offset BRT para garantir fuso correto
    let timestamp;
    if (horaUsada !== 'agora') {
      const isoStr = `${hoje}T${horaUsada.padStart(5,'0')}:00-03:00`;
      timestamp = new Date(isoStr);
    } else {
      timestamp = nowBRT();
    }

    const existing = await prisma.workLog.findFirst({ where: { userId: user.id, type: subtipo, date: hoje } });
    if (existing) {
      await prisma.workLog.update({ where: { id: existing.id }, data: { timestamp } });
    } else {
      await prisma.workLog.create({ data: { userId: user.id, type: subtipo, timestamp, date: hoje } });
    }
  }

  const pontosHoje = await prisma.workLog.findMany({ where: { userId: user.id, date: hoje }, orderBy: { timestamp: 'asc' } });
  const msg = await gerarMensagemPonto(pontosHoje, user.id);

  await sendButtons(phone, msg, [
    { id: 'ver_horas_hoje', label: '📋 Ver horas hoje' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function gerarMensagemPonto(pontos, userId) {
  const get = tipo => pontos.find(p => p.type === tipo);
  const entrada = get('entrada');
  const saidaAlmoco = get('saida_almoco');
  const voltaAlmoco = get('volta_almoco');
  const saida = get('saida');
  const jornada = await memory.getJornada(userId);

  // Mensagem específica por tipo de registro
  if (entrada && !saidaAlmoco && !saida) {
    return `✅ Entrada registrada\n\n⏰ ${horaStr(entrada.timestamp)}\n\nTenha um ótimo trabalho hoje 😊`;
  }

  if (saidaAlmoco && !saida) {
    const manha = entrada ? (new Date(saidaAlmoco.timestamp) - new Date(entrada.timestamp)) / 60000 : null;
    return `🍽️ Saída para almoço registrada\n\n⏰ ${horaStr(saidaAlmoco.timestamp)}${manha ? '\n\nVocê trabalhou ' + minutesToHours(manha) + ' esta manhã.' : ''}\n\nBom descanso 😊`;
  }

  if (voltaAlmoco && !saida) {
    return `🔄 Retorno do almoço registrado\n\n⏰ ${horaStr(voltaAlmoco.timestamp)}\n\nBom trabalho 😊`;
  }

  if (saida) {
    let manha = null, tarde = null, total = null, extras = null;
    if (entrada && saidaAlmoco) manha = (new Date(saidaAlmoco.timestamp) - new Date(entrada.timestamp)) / 60000;
    if (voltaAlmoco && saida) tarde = (new Date(saida.timestamp) - new Date(voltaAlmoco.timestamp)) / 60000;
    if (manha !== null && tarde !== null) { total = manha + tarde; extras = total - jornada; }

    let msg = `🏁 Saída registrada\n\n⏰ ${horaStr(saida.timestamp)}\n\n📊 Resumo do dia:\n`;
    msg += `• Total trabalhado: ${total !== null ? minutesToHours(total) : '—'}\n`;
    if (extras !== null) {
      if (extras > 0) msg += `• Horas extras: ${minutesToHours(extras)}`;
      else if (extras < 0) msg += `• Faltaram: ${minutesToHours(Math.abs(extras))}`;
      else msg += `• Jornada completa ✅`;
    }
    msg += `\n\nBom descanso 💜`;
    return msg;
  }

  // Resumo geral
  let texto = `✨ Resumo do seu dia\n\n`;
  texto += `🟢 Entrada: ${horaStr(entrada?.timestamp)}\n`;
  if (saidaAlmoco) texto += `🍽️ Saída almoço: ${horaStr(saidaAlmoco.timestamp)}\n`;
  if (voltaAlmoco) texto += `🔄 Volta almoço: ${horaStr(voltaAlmoco.timestamp)}\n`;
  if (saida) texto += `🔴 Saída: ${horaStr(saida.timestamp)}\n`;
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
      .replace(/\baqui\b/gi, locationText)
      .replace(/perto de mim/gi, `perto de ${locationText}`);
  }

  const resultado = await searchWeb(queryFinal, locationText);
  let mensagem = resultado.text;
  if (resultado.sourceUrl) mensagem += `\n\n🔗 ${resultado.sourceUrl}`;

  await sendButtons(phone, mensagem, [
    { id: 'pesquisar', label: '🔍 Nova pesquisa' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

// ====================== ANOTAÇÃO ======================
async function handleNote(user, phone, classified) {
  const conteudo = classified.conteudo || classified.titulo || '';
  await memory.saveMemory(user.id, 'anotacao', conteudo, { titulo: classified.titulo });
  await sendMessage(phone, `Anotado 📝\n\n_"${conteudo}"_\n\nGuardei aqui com segurança.` + MENU_FOOTER);
}

// ====================== TAREFA ======================
async function handleTask(user, phone, classified) {
  await memory.saveMemory(user.id, 'tarefa', classified.titulo, { data: classified.data, hora: classified.hora });

  // Sem horário → agenda para amanhã às 07:00
  let hora = classified.hora;
  let data = classified.data;

  if (!hora) {
    hora = '07:00';
    data = amanhaBRT();
  }

  try {
    const scheduledAt = criarDataBRT(data || dateBRT(), hora);

    // Se a hora já passou hoje e não tem data específica → amanhã
    if (!classified.data && !classified.hora && scheduledAt < nowBRT()) {
      scheduledAt.setDate(scheduledAt.getDate() + 1);
    }

    await prisma.reminder.create({ data: { userId: user.id, phone, message: classified.titulo, scheduledAt } });

    const dataFormatada = formatarDataHoraBR(scheduledAt);
    const semHorario = !classified.hora;

    await sendMessage(phone,
      `Perfeito 😊\n\nVou te lembrar ${dataFormatada}${semHorario ? ' (defini às 7h da manhã)' : ''}.` + MENU_FOOTER
    );
  } catch (e) {
    console.error('Erro criar reminder:', e.message);
    await sendMessage(phone, `Guardei! Vou te lembrar${hora ? ' às ' + hora : ''}.` + MENU_FOOTER);
  }
}

// ====================== GASTO ======================
async function handleExpense(user, phone, classified) {
  const valor = Number(classified.valor) || 0;
  const categoria = classified.categoria || 'outro';
  await memory.saveExpense(user.id, { valor, categoria, descricao: classified.descricao || categoria });

  const icons = { mercado: '🛒', restaurante: '🍽️', saude: '💊', transporte: '🚗', lazer: '🎉', outro: '📦' };

  await sendMessage(phone,
    `💰 Gasto anotado!\n\n${icons[categoria] || '📦'} ${categoria.charAt(0).toUpperCase() + categoria.slice(1)}\n💵 R$ ${valor.toFixed(2)}` + MENU_FOOTER
  );
}

// ====================== CONSULTA ======================
async function handleQuery(user, phone, question) {
  await sendMessage(phone, '_Deixa eu ver..._');
  const memories = await memory.getRecentMemories(user.id, 30);
  if (memories.length === 0) {
    return await sendMessage(phone, 'Ainda não guardei nada pra você.' + MENU_FOOTER);
  }
  const answer = await generateMemorySummary(memories, question);
  await sendMessage(phone, answer + MENU_FOOTER);
}

// ====================== LISTAGENS ======================
async function listarLembretes(user, phone) {
  const agora = nowBRT();
  const reminders = await prisma.reminder.findMany({
    where: { userId: user.id, sent: false, confirmed: false, scheduledAt: { gte: agora } },
    orderBy: { scheduledAt: 'asc' }, take: 10,
  });

  if (reminders.length === 0) {
    return await sendButtons(phone, `Nenhum lembrete ativo no momento 😊`,
      [{ id: 'lembrete', label: '➕ Criar lembrete' }, { id: 'menu', label: '🏠 Menu' }]
    );
  }

  const numeros = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
  let texto = `📋 Seus lembretes\n\n`;
  reminders.forEach((r, i) => {
    texto += `${numeros[i] || `${i+1}.`} ${r.message}\n    ${formatarDataHoraBR(r.scheduledAt)}\n\n`;
  });

  await sendButtons(phone, texto, [
    { id: 'criar_lembrete', label: '➕ Criar lembrete' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function listarAnotacoes(user, phone) {
  const mems = await memory.getRecentMemories(user.id, 50);
  const anotacoes = mems.filter(m => m.type === 'anotacao').slice(0, 10);

  if (anotacoes.length === 0) {
    return await sendButtons(phone, `Nenhuma anotação salva ainda 😊`,
      [{ id: 'anotacao', label: '➕ Nova anotação' }, { id: 'menu', label: '🏠 Menu' }]
    );
  }

  let texto = `📝 Suas anotações\n\n`;
  anotacoes.forEach(a => { texto += `• _"${a.content}"_\n  ${formatarDataBR(a.createdAt)}\n\n`; });

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
    return await sendButtons(phone, `Nenhum gasto registrado este mês 😊`,
      [{ id: 'gasto', label: '➕ Registrar gasto' }, { id: 'menu', label: '🏠 Menu' }]
    );
  }

  const total = gastos.reduce((acc, g) => acc + g.value, 0);
  const icons = { mercado: '🛒', restaurante: '🍽️', saude: '💊', transporte: '🚗', lazer: '🎉', outro: '📦' };
  let texto = `💰 Gastos do mês\n\n`;
  gastos.forEach(g => { texto += `${icons[g.category] || '📦'} ${g.category} — R$ ${g.value.toFixed(2)}\n  ${formatarDataBR(g.createdAt)}\n\n`; });
  texto += `Total: R$ ${total.toFixed(2)}`;

  await sendButtons(phone, texto, [
    { id: 'novo_gasto', label: '➕ Novo gasto' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function listarPontoHoje(user, phone) {
  const hoje = dateBRT();
  const pontos = await prisma.workLog.findMany({ where: { userId: user.id, date: hoje }, orderBy: { timestamp: 'asc' } });

  if (pontos.length === 0) {
    return await sendButtons(phone, `Nenhum registro de ponto hoje ainda 😊`,
      [{ id: 'ponto', label: '📍 Registrar ponto' }, { id: 'menu', label: '🏠 Menu' }]
    );
  }

  const msg = await gerarMensagemPonto(pontos, user.id);
  await sendButtons(phone, msg, [
    { id: 'bater_ponto', label: '📍 Registrar ponto' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function listarMedicamentos(user, phone) {
  const meds = await prisma.medication.findMany({ where: { userId: user.id, active: true }, orderBy: { createdAt: 'desc' } });

  if (meds.length === 0) {
    return await sendButtons(phone, `Nenhum medicamento cadastrado ainda 😊`,
      [{ id: 'saude', label: '➕ Cadastrar remédio' }, { id: 'menu', label: '🏠 Menu' }]
    );
  }

  let texto = `💊 Seus remédios\n\n`;
  meds.forEach(m => {
    const horarios = JSON.parse(m.times || '[]').join(', ');
    texto += `💊 ${m.name}\n  ⏰ ${horarios} · ${m.remaining} dose${m.remaining !== 1 ? 's' : ''} restante${m.remaining !== 1 ? 's' : ''}\n\n`;
  });

  await sendButtons(phone, texto, [
    { id: 'novo_remedio', label: '➕ Novo remédio' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

module.exports = { handleMessage };
