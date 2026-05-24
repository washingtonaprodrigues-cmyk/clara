const { classify, searchWeb, freeResponse, generateMemorySummary } = require('./groq');
const { sendMessage, sendMainMenu, sendButtons } = require('./whatsapp');
const memory = require('./memory');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const MENU_FOOTER = '\n\n_Digite *menu* a qualquer momento para voltar ao início_ 🏠';

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

// ====================== HANDLER PRINCIPAL ======================
async function handleMessage(phone, text, location = null) {
  try {
    const user = await memory.getOrCreateUser(phone);

    // LOCALIZAÇÃO
    if (location && location.latitude) {
      await memory.saveMemory(user.id, 'localizacao',
        JSON.stringify({ latitude: location.latitude, longitude: location.longitude, updatedAt: new Date().toISOString() })
      );
      return await sendMessage(phone, '✅ Localização recebida! Agora posso te ajudar melhor com clima, farmácias e lojas próximas.' + MENU_FOOTER);
    }

    if (!text) return;

    const textLower = text.trim().toLowerCase();

    // MENU sempre que digitar "menu"
    if (textLower === 'menu' || textLower === 'início' || textLower === 'inicio') {
      return await sendMainMenu(phone);
    }

    // RESPOSTAS DE OPÇÕES DO MENU
    if (textLower.startsWith('menu_') || text.startsWith('menu_')) {
      return await handleMenuOption(phone, text.toLowerCase().trim());
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
      case 'consulta':
        await handleQuery(user, phone, text);
        break;
      case 'saudacao':
        await handleSaudacao(user, phone);
        break;
      default:
        const resp = await freeResponse(text);
        await sendMessage(phone, resp + MENU_FOOTER);
    }
  } catch (error) {
    console.error('Erro handleMessage:', error.message);
    await sendMessage(phone, 'Ops, tive um probleminha. Pode repetir?');
  }
}

// ====================== OPÇÕES DO MENU ======================
async function handleMenuOption(phone, option) {
  const respostas = {
    menu_lembrete: `⏰ *Lembretes*\n\nMe diz o que e quando, que eu te aviso na hora certa!\n\nExemplos:\n• _"Me lembra às 19h de buscar minha filha"_\n• _"Lembrete amanhã às 8h de tomar remédio"_\n• _"Me lembra sexta às 18h da reunião"_`,

    menu_anotacao: `📝 *Anotações*\n\nGuardo qualquer informação pra você consultar depois!\n\nExemplos:\n• _"Anota que a senha do wifi é 12345"_\n• _"Guarda o código do cliente: ABC123"_\n• _"Anota que preciso ligar pro médico"_`,

    menu_gastos: `💰 *Gastos*\n\nRegistro seus gastos e te mostro um resumo do mês!\n\nExemplos:\n• _"Gastei 45 reais no mercado"_\n• _"Paguei 120 no restaurante"_\n• _"Gastei 30 no transporte"_\n\nPara consultar: _"Quanto gastei esse mês?"_`,

    menu_saude: `💊 *Saúde*\n\nCuido dos seus lembretes de medicamentos!\n\nExemplos:\n• _"Tomo Losartana todo dia às 8h"_\n• _"Preciso tomar 2 comprimidos de vitamina C por dia às 9h e 21h"_\n\nTe aviso na hora certa e controlo o estoque! 💊`,

    menu_ponto: `🕐 *Ponto Digital*\n\nRegistro sua jornada de trabalho!\n\nExemplos:\n• _"Entrei às 8:15"_\n• _"Saí pra almoçar às 12:30"_\n• _"Voltei do almoço às 14:10"_\n• _"Saí do trabalho às 18:05"_\n\nOu tudo de uma vez:\n_"Entrei 8h, saí almoçar 12h, voltei 13h, saí 17h"_`,

    menu_horoscopo: `🔮 *Horóscopo*\n\nQual é o seu signo? Te conto o horóscopo do dia!\n\nExemplos:\n• _"Horóscopo de Áries"_\n• _"Meu signo é Escorpião, como está meu dia?"_`,

    menu_busca: `🔍 *Buscar na internet*\n\nBusco qualquer informação pra você!\n\nExemplos:\n• _"Como está o tempo hoje?"_\n• _"Telefone da farmácia mais próxima"_\n• _"Endereço do Detran"_\n• _"Preço do dólar hoje"_`,

    menu_papo: `💬 *Bater papo*\n\nPode falar à vontade! Estou aqui pra conversar sobre qualquer assunto 😊`,
  };

  const resposta = respostas[option] || 'Opção não encontrada. Digite *menu* para ver as opções.';
  await sendMessage(phone, resposta + MENU_FOOTER);
}

// ====================== SAUDAÇÃO ======================
async function handleSaudacao(user, phone) {
  const cidade = await getCidadeUsuario(user.id);
  if (!cidade) {
    await sendMainMenu(phone);
    await sendMessage(phone, '📍 Dica: me diz sua cidade para eu buscar clima e locais pra você!');
  } else {
    await sendMainMenu(phone);
  }
}

async function getCidadeUsuario(userId) {
  const mems = await memory.getRecentMemories(userId, 50);
  const cidadeMem = mems.find(m => m.type === 'cidade');
  return cidadeMem ? cidadeMem.content : null;
}

// ====================== CIDADE ======================
async function handleCidade(user, phone, cidade) {
  await memory.saveMemory(user.id, 'cidade', cidade);
  await sendMessage(phone, `Anotei! 📍 Vou usar *${cidade}* para buscas locais.` + MENU_FOOTER);
}

// ====================== PONTO MÚLTIPLO ======================
async function handlePontoMultiplo(
