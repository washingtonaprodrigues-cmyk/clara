const axios = require('axios');
const BASE_URL = process.env.UAZAPI_URL || 'https://claravirtual.uazapi.com';
const TOKEN    = process.env.UAZAPI_TOKEN;

const headers = {
  'token': TOKEN,
  'Content-Type': 'application/json',
};

async function sendMessage(phone, message) {
  try {
    console.log(`📤 Enviando para ${phone}: ${String(message).slice(0, 60)}`);
    const response = await axios.post(
      `${BASE_URL}/send/text`,
      { number: phone, text: message },
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

// ── Presença: "digitando..." ──
// Mostra o indicador de "digitando" no WhatsApp do usuário antes de
// responder — dá a sensação de que a Clara "viu" a mensagem e está
// processando, em vez de silêncio total durante a espera (especialmente
// útil quando a resposta passa por fallback Gemini/OpenRouter, que pode
// levar alguns segundos extras).
//
// IMPORTANTE: o endpoint/payload exato de presença não foi confirmado na
// documentação da UazAPI durante o desenvolvimento — escrito de forma
// best-effort. Se o endpoint estiver incorreto para esta instância, a
// chamada falha silenciosamente (não quebra o envio normal de mensagem),
// só loga um aviso. Se aparecer no log "[WhatsApp] Presença não
// disponível", ajuste o endpoint/payload abaixo conforme a documentação
// oficial da instância (provavelmente em algo como /chat/presence ou
// /send/presence — varia entre provedores que usam Baileys por baixo).
async function enviarPresenca(phone, status = 'composing') {
  try {
    await axios.post(
      `${BASE_URL}/chat/presence`,
      { number: phone, presence: status }, // status: "composing" | "paused" | "available"
      { headers, timeout: 10000 }
    );
    return true;
  } catch (error) {
    console.warn('[WhatsApp] Presença não disponível (endpoint pode divergir nesta instância):', error.response?.data || error.message);
    return false;
  }
}

// Atalho: mostra "digitando..." e para automaticamente depois de
// duracaoMs. Uso típico: chamar antes de processar uma resposta que pode
// demorar (ex: fallback de IA), sem precisar lembrar de "parar" depois.
async function mostrarDigitando(phone, duracaoMs = 8000) {
  const iniciou = await enviarPresenca(phone, 'composing');
  if (!iniciou) return;
  setTimeout(() => {
    enviarPresenca(phone, 'paused').catch(() => {});
  }, duracaoMs);
}

// ── Marcar mensagem(ns) como lida ──
// messageIds: string ou array de strings (IDs disponíveis no payload do
// webhook ao receber a mensagem). Mesma observação de "best-effort" da
// função de presença acima.
async function marcarComoLida(phone, messageIds) {
  try {
    const ids = Array.isArray(messageIds) ? messageIds : [messageIds];
    await axios.post(
      `${BASE_URL}/chat/read`,
      { number: phone, id: ids },
      { headers, timeout: 10000 }
    );
    return true;
  } catch (error) {
    console.warn('[WhatsApp] Marcar como lida não disponível (endpoint pode divergir nesta instância):', error.response?.data || error.message);
    return false;
  }
}

module.exports = {
  sendMessage,
  sendButtons,
  sendMainMenu,
  sendReminderWithButtons,
  sendReminderHumano,
  sendReminderInsistencia,
  sendLocationRequest,
  enviarPresenca,
  mostrarDigitando,
  marcarComoLida,
};
