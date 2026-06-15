const axios = require('axios');
const BASE_URL = process.env.UAZAPI_URL || 'https://claravirtual.uazapi.com';
const TOKEN    = process.env.UAZAPI_TOKEN;
const headers = {
  'token': TOKEN,
  'Content-Type': 'application/json',
};

// Timeout do axios. Como o "delay" enviado no body é processado pela UazAPI
// antes do envio efetivo, o timeout precisa ser maior que delay + margem de
// rede/processamento. 30s dá folga suficiente mesmo em picos.
const AXIOS_TIMEOUT = 30000;

async function sendMessage(phone, message, delay = 800, _retry = false) {
  try {
    console.log(`📤 Enviando para ${phone}: ${String(message).slice(0, 60)}`);
    const response = await axios.post(
      `${BASE_URL}/send/text`,
      { number: phone, text: message, delay },
      { timeout: AXIOS_TIMEOUT, headers }
    );
    console.log(`✅ Enviado OK para ${phone}:`, response.data?.status || 'sem status');
    return response.data;
  } catch (error) {
    const isTimeout = error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '');
    console.error(`❌ Erro sendMessage para ${phone}:`, error.response?.data || error.message);

    // Em caso de timeout (não erro de validação/4xx), tenta uma vez mais —
    // costuma ser instabilidade momentânea da UazAPI, não um problema real.
    if (isTimeout && !_retry) {
      console.log(`🔁 Retentando envio para ${phone} após timeout...`);
      return sendMessage(phone, message, delay, true);
    }

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
