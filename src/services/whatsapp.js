const axios = require('axios');
const BASE_URL = process.env.UAZAPI_URL || 'https://claravirtual.uazapi.com';
const TOKEN    = process.env.UAZAPI_TOKEN;

const headers = {
  'token': TOKEN,
  'Content-Type': 'application/json',
};

// Tempo de "Digitando..." mostrado antes de entregar a mensagem — não é
// um endpoint separado de presença (a UazAPI não tem isso isolado);
// o próprio /send/text mostra "Digitando..." automaticamente durante o
// período definido em "delay" (ms), antes de entregar a mensagem.
// readchat marca a conversa como lida; readmessages marca as últimas
// mensagens recebidas como lidas — ambos no mesmo request, sem chamada extra.
const DELAY_DIGITANDO_MS = 1800;

async function sendMessage(phone, message, opts = {}) {
  try {
    console.log(`📤 Enviando para ${phone}: ${String(message).slice(0, 60)}`);
    const response = await axios.post(
      `${BASE_URL}/send/text`,
      {
        number: phone,
        text: message,
        delay: opts.delay ?? DELAY_DIGITANDO_MS,
        readchat: opts.readchat ?? true,
        readmessages: opts.readmessages ?? true,
      },
      { timeout: 15000, headers }
    );
    console.log(`✅ Enviado OK para ${phone}:`, response.data?.status || 'sem status');
    return response.data;
  } catch (error) {
    console.error(`❌ Erro sendMessage para ${phone}:`, error.response?.data || error.message);
    throw error;
  }
}

async function sendButtons(phone, message, buttons) {
  return sendMessage(phone, message);
}

async function sendMainMenu(phone) {
  const texto = `✨ *Clara online* 💜\n\nOi! Como posso ajudar no seu dia hoje? 😊\n\n⏰ Lembrete · 📝 Anotação · 💰 Gasto\n💊 Saúde · 📍 Ponto · 🔍 Pesquisa · 💬 Conversar`;
  return sendMessage(phone, texto);
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
