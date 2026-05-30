const axios = require('axios');

const INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const TOKEN = process.env.ZAPI_TOKEN;
const CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;

const BASE_URL = `https://api.z-api.io/instances/${INSTANCE_ID}/token/${TOKEN}`;

const headers = {
  'Client-Token': CLIENT_TOKEN,
  'Content-Type': 'application/json',
};

async function sendMessage(phone, message) {
  try {
    const response = await axios.post(
      `${BASE_URL}/send-text`,
      { phone, message },
      { timeout: 15000, headers }
    );
    return response.data;
  } catch (error) {
    console.error('Erro Z-API sendMessage:', error.response?.data || error.message);
    throw error;
  }
}

async function sendButtons(phone, message, buttons) {
  try {
    const body = {
      phone,
      message,
      buttons: buttons.map((b, i) => ({
        id: b.id || `btn_${i}`,
        label: b.label
      }))
    };
    const response = await axios.post(
      `${BASE_URL}/send-button-actions`,
      body,
      { timeout: 15000, headers }
    );
    return response.data;
  } catch (error) {
    console.error('Erro Z-API sendButtons:', error.response?.data || error.message);
    return sendMessage(phone, message);
  }
}

async function sendMainMenu(phone) {
  try {
    const body = {
      phone,
      message: `✨ *Clara online* 💜\n\nOi! Como posso ajudar no seu dia hoje? 😊\nPosso cuidar de várias coisas pra você, é só escolher uma opção no menu ✨`,
      optionList: {
        title: 'O que posso fazer por você',
        buttonLabel: '📋 Ver opções',
        options: [
          { id: 'lembrete',  title: '⏰ Lembrete',    description: 'Criar lembretes e compromissos' },
          { id: 'anotacao',  title: '📝 Anotação',     description: 'Guardar informações importantes' },
          { id: 'gasto',     title: '💰 Gasto',        description: 'Registrar e consultar gastos' },
          { id: 'saude',     title: '💊 Saúde',        description: 'Medicamentos e bem-estar' },
          { id: 'ponto',     title: '📍 Ponto',        description: 'Registrar entrada e saída' },
          { id: 'pesquisar', title: '🔍 Pesquisa',     description: 'Clima, telefones, endereços...' },
          { id: 'conversar', title: '💬 Conversar',    description: 'Bater papo livremente' },
        ]
      }
    };
    const response = await axios.post(
      `${BASE_URL}/send-option-list`,
      body,
      { timeout: 15000, headers }
    );
    return response.data;
  } catch (error) {
    console.error('Erro Z-API sendMainMenu:', error.response?.data || error.message);
    return sendMessage(phone,
      `✨ *Clara online* 💜\n\nOi! Como posso ajudar? 😊\n\n⏰ Lembrete · 📝 Anotação · 💰 Gasto\n💊 Saúde · 📍 Ponto · 🔍 Pesquisa · 💬 Conversar`
    );
  }
}

async function sendReminderHumano(phone, message) {
  const frases = [
    `Ei, não esquece: ${message} 😊`,
    `Oi! Só passando pra lembrar: ${message}`,
    `Lembrete rápido: ${message} 👋`,
    `Não esquece não: ${message} 😉`,
    `Psiu! ${message} — era isso 😊`,
  ];
  const texto = frases[Math.floor(Math.random() * frases.length)];
  return sendMessage(phone, texto);
}

async function sendReminderInsistencia(phone, message) {
  const frases = [
    `Ainda sobre "${message}" — já conseguiu? 😊`,
    `Oi! Ainda não esqueceu de ${message}, né?`,
    `Só conferindo: ${message} — tudo certo? 😉`,
  ];
  const texto = frases[Math.floor(Math.random() * frases.length)];
  return sendMessage(phone, texto);
}

async function sendReminderWithButtons(phone, message, reminderId) {
  return sendReminderHumano(phone, message);
}

async function sendLocationRequest(phone) {
  return sendMessage(phone, '📍 Me manda sua localização para buscas locais.');
}

module.exports = {
  sendMessage,
  sendButtons,
  sendMainMenu,
  sendReminderWithButtons,
  sendReminderHumano,
  sendReminderInsistencia,
  sendLocationRequest,
};
