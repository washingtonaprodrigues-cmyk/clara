// ── Integração WhatsApp via UazAPI ──
// Migrado da Z-API para UazAPI. Este arquivo concentra as funções base de
// envio (texto, botões) e, agora, também presença ("digitando...") e
// confirmação de leitura — usadas para dar a sensação de que a Clara
// "viu" a mensagem e está "respondendo", reduzindo a percepção de espera
// quando a resposta depende de fallback (Gemini/OpenRouter).
//
// Variáveis de ambiente necessárias:
//   UAZAPI_URL   — URL base da instância UazAPI
//   UAZAPI_TOKEN — token de autenticação da instância

const axios = require('axios');

const BASE_URL = process.env.UAZAPI_URL || 'https://claravirtual.uazapi.com';
const UAZAPI_TOKEN = process.env.UAZAPI_TOKEN;

function headers() {
  return { token: UAZAPI_TOKEN, 'Content-Type': 'application/json' };
}

// ── Envio de texto ──
async function sendMessage(phone, message, delay) {
  try {
    const response = await axios.post(
      `${BASE_URL}/send/text`,
      { number: phone, text: message, delay: delay || 800 },
      { headers: headers(), timeout: 30000 }
    );
    return response.data;
  } catch (error) {
    console.error('[WhatsApp] Erro sendMessage:', error.message);
    throw error;
  }
}

// ── Envio de mensagem com botões ──
// buttons: array de { id, label }
async function sendButtons(phone, message, buttons) {
  try {
    const response = await axios.post(
      `${BASE_URL}/send/button`,
      {
        number: phone,
        text: message,
        choices: (buttons || []).map(b => b.label || b.id),
      },
      { headers: headers(), timeout: 30000 }
    );
    return response.data;
  } catch (error) {
    console.error('[WhatsApp] Erro sendButtons:', error.message);
    // Fallback: se botões falharem (ex: número não suporta), manda como texto simples
    try {
      const listaOpcoes = (buttons || []).map(b => `• ${b.label || b.id}`).join('\n');
      return await sendMessage(phone, `${message}\n\n${listaOpcoes}`);
    } catch (e2) {
      console.error('[WhatsApp] Erro no fallback de sendButtons:', e2.message);
      throw e2;
    }
  }
}

// ── Presença: "digitando..." ──
// Mostra o indicador de "digitando" no WhatsApp do usuário, dando a
// sensação de que a Clara está processando/respondendo, em vez de
// silêncio total durante o tempo de espera (especialmente útil quando a
// resposta passa por fallback Gemini/OpenRouter, que pode levar alguns
// segundos extras).
//
// IMPORTANTE: o endpoint exato de presença da UazAPI não foi confirmado
// na documentação durante o desenvolvimento — esta função foi escrita de
// forma defensiva (best-effort). Se o endpoint/payload estiver incorreto
// para a sua instância, a chamada falha silenciosamente (não quebra o
// fluxo principal de envio de mensagem) e só registra um aviso no log.
// Se não funcionar à primeira, verifique o log por
// "[WhatsApp] Presença não disponível" e ajuste o endpoint/payload
// conforme a documentação oficial da sua instância UazAPI.
async function enviarPresenca(phone, status = 'composing') {
  try {
    await axios.post(
      `${BASE_URL}/chat/presence`,
      { number: phone, presence: status }, // status: "composing" | "paused" | "available"
      { headers: headers(), timeout: 10000 }
    );
    return true;
  } catch (error) {
    console.warn('[WhatsApp] Presença não disponível (endpoint pode divergir nesta instância):', error.message);
    return false;
  }
}

// Atalho: mostra "digitando..." por um tempo (ms), depois para automaticamente.
// Uso típico: chamar antes de processar uma resposta que pode demorar
// (ex: fallback de IA), sem precisar lembrar de "parar" manualmente depois.
async function mostrarDigitando(phone, duracaoMs = 8000) {
  const iniciou = await enviarPresenca(phone, 'composing');
  if (!iniciou) return;
  setTimeout(() => {
    enviarPresenca(phone, 'paused').catch(() => {});
  }, duracaoMs);
}

// ── Marcar mensagem(ns) como lida ──
// messageIds: string ou array de strings (IDs das mensagens recebidas,
// disponíveis no payload do webhook). Mesma observação de "best-effort"
// da função de presença acima — endpoint não confirmado na documentação.
async function marcarComoLida(phone, messageIds) {
  try {
    const ids = Array.isArray(messageIds) ? messageIds : [messageIds];
    await axios.post(
      `${BASE_URL}/chat/read`,
      { number: phone, id: ids },
      { headers: headers(), timeout: 10000 }
    );
    return true;
  } catch (error) {
    console.warn('[WhatsApp] Marcar como lida não disponível (endpoint pode divergir nesta instância):', error.message);
    return false;
  }
}

module.exports = {
  sendMessage,
  sendButtons,
  enviarPresenca,
  mostrarDigitando,
  marcarComoLida,
};
