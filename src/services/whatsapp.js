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
      { headers }
    );
    return response.data;
  } catch (error) {
    console.error('Erro ao enviar mensagem Z-API:', error.message);
    throw error;
  }
}

// Stub compatível — envia como texto simples com opções listadas
async function sendButtons(phone, message, buttons) {
  const opcoes = buttons.map((b) => `• ${b.label}`).join('\n');
  return sendMessage(phone, `${message}\n\n${opcoes}`);
}

async function sendList(phone, message, buttonLabel, sections) {
  const texto = sections
    .flatMap((s) => s.rows.map((r) => `• ${r.title}${r.description ? ` — ${r.description}` : ''}`))
    .join('\n');
  return sendMessage(phone, `${message}\n\n${texto}`);
}

module.exports = { sendMessage, sendButtons, sendList };
