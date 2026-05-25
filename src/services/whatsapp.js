const axios = require('axios');

const INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const TOKEN = process.env.ZAPI_TOKEN;
const CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;

const BASE_URL = `https://api.z-api.io/instances/${INSTANCE_ID}/token/${TOKEN}`;

const headers = {
  'Client-Token': CLIENT_TOKEN,
  'Content-Type': 'application/json',
};

function withTextOptions(message, buttons = []) {
  if (!buttons.length) return message;

  const options = buttons
    .map((button, index) => `*${index + 1}* - ${button.label}`)
    .join('\n');

  return `${message}\n\n━━━━━━━━━━━━━━\n*Opções rápidas*\n${options}\n\n_Responda com o número ou toque em uma opção, se aparecer._`;
}

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

async function sendButtons(phone, message, buttons = []) {
  const messageWithOptions = withTextOptions(message, buttons);

  try {
    await axios.post(
      `${BASE_URL}/send-button-actions`,
      {
        phone,
        message: messageWithOptions,
        buttons: buttons.map((button, index) => ({
          id: button.id || `btn_${index}`,
          label: button.label,
        })),
      },
      { timeout: 15000, headers }
    );
  } catch (error) {
    console.error('Erro Z-API sendButtons:', error.response?.data || error.message);
    return sendMessage(phone, messageWithOptions);
  }
}

async function sendReminderWithButtons(phone, message, reminderId) {
  return sendButtons(phone, `⏰ *Lembrete*\n\n${message}`, [
    { id: `confirm_${reminderId}`, label: '✅ Feito' },
    { id: `snooze_${reminderId}`, label: '⏰ +10 min' },
    { id: `cancel_${reminderId}`, label: '❌ Cancelar' },
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
