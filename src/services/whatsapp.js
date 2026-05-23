const axios = require('axios');

const INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const TOKEN = process.env.ZAPI_TOKEN;
const CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;
const BASE_URL = `https://api.z-api.io/instances/${INSTANCE_ID}/token/${TOKEN}`;

const headers = {
  'Client-Token': CLIENT_TOKEN,
  'Content-Type': 'application/json',
};

// Mensagem simples
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

// Mensagem com botões (máximo 3 botões no WhatsApp)
// buttons: [{ id: 'string', label: 'Texto do botão' }]
async function sendButtons(phone, message, buttons) {
  try {
    const payload = {
      phone,
      message,
      buttonActions: buttons.map((b) => ({
        id: b.id,
        type: 'REPLY',
        title: b.label,
      })),
    };
    const response = await axios.post(`${BASE_URL}/send-button-actions`, payload, { headers });
    return response.data;
  } catch (error) {
    // Fallback: envia como texto simples se botões falharem
    console.error('Erro botões Z-API, fallback texto:', error.message);
    const opcoesTexto = buttons.map((b) => `• ${b.label}`).join('\n');
    return sendMessage(phone, `${message}\n\n${opcoesTexto}`);
  }
}

// Lista de opções (para menus com mais de 3 itens)
// sections: [{ title: 'Seção', rows: [{ id, title, description }] }]
async function sendList(phone, message, buttonLabel, sections) {
  try {
    const payload = {
      phone,
      message,
      buttonLabel,
      sections,
    };
    const response = await axios.post(`${BASE_URL}/send-list-message`, payload, { headers });
    return response.data;
  } catch (error) {
    console.error('Erro lista Z-API, fallback texto:', error.message);
    const texto = sections
      .flatMap((s) => s.rows.map((r) => `• ${r.title}${r.description ? ` — ${r.description}` : ''}`))
      .join('\n');
    return sendMessage(phone, `${message}\n\n${texto}`);
  }
}

module.exports = { sendMessage, sendButtons, sendList };
