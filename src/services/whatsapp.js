const axios = require('axios');

const INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const TOKEN = process.env.ZAPI_TOKEN;
const CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;

const BASE_URL = `https://api.z-api.io/instances/${INSTANCE_ID}/token/${TOKEN}`;

const headers = {
  'Client-Token': CLIENT_TOKEN,
  'Content-Type': 'application/json',
};

// ====================== TEXTO SIMPLES ======================
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

// ====================== MENU PRINCIPAL (LISTA) ======================
async function sendMainMenu(phone) {
  try {
    const body = {
      phone,
      message: 'Olá! 😊 Estou aqui pra te ajudar!\nO que deseja fazer?',
      optionList: {
        title: 'O que posso fazer por você',
        buttonLabel: '📋 Ver opções',
        options: [
          { id: 'menu_lembrete',  title: '⏰ Lembrete',           description: 'Criar lembretes e compromissos' },
          { id: 'menu_anotacao',  title: '📝 Anotações',          description: 'Guardar informações importantes' },
          { id: 'menu_gastos',    title: '💰 Gastos',             description: 'Registrar e consultar gastos' },
          { id: 'menu_saude',     title: '💊 Saúde',              description: 'Medicamentos e bem-estar' },
          { id: 'menu_ponto',     title: '🕐 Ponto digital',      description: 'Registrar entrada e saída' },
          { id: 'menu_horoscopo', title: '🔮 Horóscopo',          description: 'Seu horóscopo do dia' },
          { id: 'menu_busca',     title: '🔍 Buscar na internet',  description: 'Clima, telefones, endereços...' },
          { id: 'menu_papo',      title: '💬 Bater papo',         description: 'Conversar livremente' },
        ]
      }
    };

    const response = await axios.post(
      `${BASE_URL}/send-option-list`,
      body,
      { timeout: 15000, headers }
    );
    return response.data;
  } catch (error) {
    console.error('Erro Z-API sendMainMenu:', error.response?.data || error.message);
    return sendMessage(phone, 'Olá! 😊 O que deseja fazer?\n\n1️⃣ Lembrete\n2️⃣ Anotações\n3️⃣ Gastos\n4️⃣ Saúde\n5️⃣ Ponto digital\n6️⃣ Horóscopo\n7️⃣ Buscar na internet\n8️⃣ Bater papo\n\nDigite o número ou me diga o que precisa 😊');
  }
}

// ====================== BOTÕES RÁPIDOS ======================
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

// ====================== LEMBRETE COM BOTÕES ======================
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
  sendMainMenu,
  sendButtons,
  sendReminderWithButtons,
  sendLocationRequest,
};
