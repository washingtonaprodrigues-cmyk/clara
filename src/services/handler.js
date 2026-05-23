const { classify, searchWeb, freeResponse } = require('./groq');
const { sendMessage } = require('./whatsapp');
const memory = require('./memory');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

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

// Função para extrair horário do texto (ex: 8:15, 12:30)
function parseTimeFromText(text) {
  const match = text.match(/(\d{1,2})[:h](\d{2})?/);
  if (!match) return null;
  let hora = parseInt(match[1]);
  let min = match[2] ? parseInt(match[2]) : 0;
  if (hora > 23) hora = 23;
  if (min > 59) min = 59;
  return `${hora.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`;
}

// ====================== HANDLER PRINCIPAL ======================
async function handleMessage(phone, text) {
  try {
    const user = await memory.getOrCreateUser(phone);

    const classified = await classify(text);
    console.log(`[${phone}] Tipo: ${classified.tipo}`);

    switch (classified.tipo) {
      case 'ponto_multiplo':
        await handlePontoMultiplo(user, phone, classified.acoes, text);
        break;

      case 'ponto':
        await handlePonto(user, phone, classified.subtipo, text);
        break;

      default:
        const resp = await freeResponse(text);
        await sendMessage(phone, resp);
    }
  } catch (error) {
    console.error('Erro:', error.message);
    await sendMessage(phone, 'Entendi! Pode repetir?');
  }
}

// ====================== PONTO MÚLTIPLO ======================
async function handlePontoMultiplo(user, phone, acoes, originalText) {
  await sendMessage(phone, '📍 Registrando seus pontos...');

  for (const acao of acoes) {
    let subtipo = acao.subtipo.toLowerCase();

    if (subtipo.includes('cheg') || subtipo.includes('entrada')) subtipo = 'entrada';
    else if (subtipo.includes('saí') && subtipo.includes('almo')) subtipo = 'saida_almoco';
    else if (subtipo.includes('volt') && subtipo.includes('almo')) subtipo = 'volta_almoco';
    else if (subtipo.includes('saí') || subtipo.includes('saindo')) subtipo = 'saida';

    // Prioriza horário informado pelo usuário
    const horaInformada = acao.hora || parseTimeFromText(originalText);
    const timestamp = horaInformada ? convertToDateWithTime(horaInformada) : nowBRT();

    await prisma.workLog.create({
      data: {
        userId: user.id,
        type: subtipo,
        timestamp: timestamp,
        date: dateBRT(),
      },
    });

    await sendMessage(phone, `✅ *${subtipo.replace('_', ' ')}* registrada às *${horaInformada || 'agora'}*`);
  }

  const resumo = await gerarResumoBonito(user.id);
  await sendMessage(phone, resumo);
}

// Converte "08:15" em Date válido
function convertToDateWithTime(horaStr) {
  const [hora, min] = horaStr.split(':').map(Number);
  const date = nowBRT();
  date.setHours(hora, min, 0, 0);
  return date;
}

// ====================== RESUMO BONITO ======================
async function gerarResumoBonito(userId) {
  const hoje = dateBRT();
  const logs = await prisma.workLog.findMany({
    where: { userId, date: hoje },
    orderBy: { timestamp: 'asc' }
  });

  let entrada = null, saidaAlmoco = null, voltaAlmoco = null;

  logs.forEach(log => {
    const hora = log.timestamp.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    if (log.type === 'entrada') entrada = hora;
    if (log.type === 'saida_almoco') saidaAlmoco = hora;
    if (log.type === 'volta_almoco') voltaAlmoco = hora;
  });

  let tempoManha = '—';
  if (entrada && saidaAlmoco) {
    const [h1, m1] = entrada.split(':').map(Number);
    const [h2, m2] = saidaAlmoco.split(':').map(Number);
    const minutos = (h2*60 + m2) - (h1*60 + m1);
    tempoManha = minutesToHours(minutos);
  }

  let texto = `✨ *Resumo do seu dia até agora*\n\n`;
  if (entrada) texto += `🟢 Entrada: *${entrada}*\n`;
  if (saidaAlmoco) texto += `🍽️ Saída para almoço: *${saidaAlmoco}*\n`;
  if (tempoManha !== '—') texto += `⏱️ Tempo trabalhado pela manhã → *${tempoManha}*\n`;
  if (voltaAlmoco) texto += `🔄 Retorno do almoço: *${voltaAlmoco}*\n\n`;

  texto += `📌 Desde que você voltou, estou acompanhando normalmente.\n\n`;
  texto += `💡 Me avisa quando for sair que eu te mostro o total do dia!`;

  return texto;
}

async function handlePonto(user, phone, subtipo, originalText) {
  const hora = parseTimeFromText(originalText) || nowBRT().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  await prisma.workLog.create({
    data: { userId: user.id, type: subtipo, timestamp: nowBRT(), date: dateBRT() }
  });
  await sendMessage(phone, `✅ *${subtipo.replace('_', ' ')}* registrada às *${hora}*`);
}

module.exports = { handleMessage };
