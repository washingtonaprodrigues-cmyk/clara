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
    const opcoes = buttons.map(b => `• ${b.label}`).join('\n');
    return sendMessage(phone, `${message}\n\n${opcoes}`);
  }
}

async function sendReminderWithButtons(phone, message, reminderId) {
  return sendButtons(phone, `⏰ *Lembrete*\n\n${message}`, [
    { id: `confirm_${reminderId}`, label: '✅ Feito!' },
    { id: `snooze_${reminderId}`,  label: '⏰ +10 minutos' },
    { id: `cancel_${reminderId}`,  label: '❌ Cancelar' },
  ]);
}

async function sendLocationRequest(phone) {
  return sendMessage(phone, '📍 Me manda sua localização para buscas locais.');
}

module.exports = {
  sendMessage,
  sendButtons,
  sendReminderWithButtons,
  sendLocationRequest,
};
