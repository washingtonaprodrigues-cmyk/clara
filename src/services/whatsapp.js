const axios = require('axios');

const INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const TOKEN = process.env.ZAPI_TOKEN;
const CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;

const BASE_URL = `https://api.z-api.io/instances/${INSTANCE_ID}/token/${TOKEN}`;

async function sendMessage(phone, message) {
  try {
    const response = await axios.post(
      `${BASE_URL}/send-text`,
      { phone, message },
      {
        timeout: 15000,
        headers: {
          'Client-Token': CLIENT_TOKEN,
          'Content-Type': 'application/json',
        },
      }
    );

    return response.data;

  } catch (error) {
    console.error(
      'Erro Z-API:',
      error.response?.data || error.message
    );

    throw error;
  }
}

async function sendLocationRequest(phone) {
  return sendMessage(
    phone,
    '📍 Me manda sua localização para buscas locais.'
  );
}

module.exports = {
  sendMessage,
  sendLocationRequest
};
