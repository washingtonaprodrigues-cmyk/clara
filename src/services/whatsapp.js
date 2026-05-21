const axios = require('axios');

const INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const TOKEN = process.env.ZAPI_TOKEN;
const CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;
const BASE_URL = `https://api.z-api.io/instances/${INSTANCE_ID}/token/${TOKEN}`;

// Filtro de saída — remove termos de gênero que o modelo insiste em usar
function sanitizarMensagem(msg) {
  if (!msg) return msg;
  return msg
    .replace(/\bquerida\b/gi, '')
    .replace(/\bquerido\b/gi, '')
    .replace(/\blinda\b/gi, '')
    .replace(/\blindo\b/gi, '')
    .replace(/\bamada\b/gi, '')
    .replace(/\bamado\b/gi, '')
    .replace(/\bmeu bem\b/gi, '')
    .replace(/\bamor\b/gi, '')
    // limpa espacos duplos ou virgulas soltas que ficam depois da remocao
    .replace(/,\s*,/g, ',')
    .replace(/!\s*,/g, '!')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[,\s]+/, '')
    .trim();
}

async function sendMessage(phone, message) {
  try {
    const mensagemFinal = sanitizarMensagem(message);
    const response = await axios.post(
      `${BASE_URL}/send-text`,
      { phone, message: mensagemFinal },
      {
        headers: {
          'Client-Token': CLIENT_TOKEN,
          'Content-Type': 'application/json',
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error('Erro ao enviar mensagem Z-API:', error.message);
    throw error;
  }
}

module.exports = { sendMessage };
