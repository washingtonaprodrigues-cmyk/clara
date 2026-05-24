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

async function sendReminderWithButtons(phone, message, reminderId) {
  try {
    const body = {
      phone,
      message: `⏰ *Lembrete*\n\n${message}`,
      buttons: [
        { id: `confirm_${reminderId}`, label: '✅ Feito!' },
        { id: `snooze_${reminderId}`,  label: '⏰ +10 minutos' },
        { id: `cancel_${reminderId}`,  label: '❌ Cancelar' },
      ]
    };
    const response = await axios.post(
      `${BASE_URL}/send-button-actions`,
      body,
      { timeout: 15000, headers }
    );
    return response.data;
  } catch (error) {
    console.error('Erro Z-API sendReminderWithButtons:', error.response?.data || error.message);
    return sendMessage(phone, `⏰ *Lembrete*\n\n${message}\n\nResponda: *feito*, *+10min* ou *cancelar*`);
  }
}

async function sendLocationRequest(phone) {
  return sendMessage(phone, '📍 Me manda sua localização para buscas locais.');
}

module.exports = {
  sendMessage,
  sendReminderWithButtons,
  sendLocationRequest,
};
