const axios = require('axios');
const BASE_URL = process.env.UAZAPI_URL || 'https://claravirtual.uazapi.com';
const TOKEN    = process.env.UAZAPI_TOKEN;
const headers = {
  'token': TOKEN,
  'Content-Type': 'application/json',
};
async function sendMessage(phone, message, delay = 2000) {
  try {
    console.log(`📤 Enviando para ${phone}: ${String(message).slice(0, 60)}`);
    const response = await axios.post(
      `${BASE_URL}/send/text`,
      { number: phone, text: message, delay },
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

// ════════════════════════════════════════════════════════════
// TTS (Text-to-Speech) via ElevenLabs — mantido como extra, caso a
// ideia da Clara falar em áudio volte no futuro. Não é chamado por
// nenhum lugar do handler.js no momento desta correção — só fica
// disponível pra reconectar quando quiserem.
// ════════════════════════════════════════════════════════════
const ELEVENLABS_API_KEY  = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'hpp4J3VqNfWAUOO0d1Us';
const ELEVENLABS_URL = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;

// Limite de caracteres por áudio — ElevenLabs processa bem até ~500 chars.
const MAX_CHARS_AUDIO = 500;

function ttsDisponivel() {
  return !!ELEVENLABS_API_KEY;
}

function limparParaAudio(texto) {
  return texto
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/^[•\-\*]\s+/gm, '')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function gerarAudio(texto) {
  if (!ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY não configurada');
  const textoLimpo = limparParaAudio(texto);
  const response = await axios.post(
    ELEVENLABS_URL,
    {
      text: textoLimpo,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.45, similarity_boost: 0.80, style: 0.35, use_speaker_boost: true },
    },
    {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
      responseType: 'arraybuffer',
      timeout: 30000,
    }
  );
  return Buffer.from(response.data);
}

async function enviarAudioUazAPI(phone, audioBuffer) {
  const base64 = audioBuffer.toString('base64');
  const response = await axios.post(
    `${BASE_URL}/send/media`,
    { number: phone, type: 'ptt', file: `data:audio/mpeg;base64,${base64}`, delay: 500 },
    { headers, timeout: 30000 }
  );
  return response.data;
}

async function enviarRespostaComAudio(phone, texto) {
  if (!ttsDisponivel()) return false;
  if (texto.length > MAX_CHARS_AUDIO) return false;
  try {
    const audioBuffer = await gerarAudio(texto);
    await enviarAudioUazAPI(phone, audioBuffer);
    console.log(`[TTS] ✅ Áudio enviado para ${phone}`);
    return true;
  } catch (e) {
    console.error(`[TTS] Erro ao gerar/enviar áudio para ${phone}:`, e.message);
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
  ttsDisponivel,
  enviarRespostaComAudio,
  gerarAudio,
};
