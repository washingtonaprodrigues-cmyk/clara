// ── TTS (Text-to-Speech) via ElevenLabs ──
// Converte a resposta da Clara em áudio e envia como mensagem de voz
// (PTT — push-to-talk) no WhatsApp via UazAPI.
//
// Fluxo: texto → ElevenLabs API → buffer mp3 → base64 → UazAPI /send/media
//
// Variáveis de ambiente necessárias:
//   ELEVENLABS_API_KEY  — chave da API do ElevenLabs
//   ELEVENLABS_VOICE_ID — ID da voz escolhida (padrão: Roberta)
//   UAZAPI_URL          — URL da instância UazAPI
//   UAZAPI_TOKEN        — token de autenticação UazAPI

const axios = require('axios');

const ELEVENLABS_API_KEY  = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'RGymW84CSmfVugnA5tvA';
const BASE_URL            = process.env.UAZAPI_URL || 'https://claravirtual.uazapi.com';
const UAZAPI_TOKEN        = process.env.UAZAPI_TOKEN;

const ELEVENLABS_URL = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;

// Limite de caracteres por áudio — ElevenLabs processa bem até ~500 chars.
// Respostas maiores são enviadas só como texto (sem áudio) pra não cortar.
const MAX_CHARS_AUDIO = 500;

// Verifica se o TTS está disponível (chave configurada).
function ttsDisponivel() {
  return !!ELEVENLABS_API_KEY;
}

// Remove formatação Markdown que soa estranha em áudio:
// negrito (*texto*), itálico (_texto_), código (`texto`), bullets, etc.
function limparParaAudio(texto) {
  return texto
    .replace(/\*\*(.*?)\*\*/g, '$1')   // **negrito**
    .replace(/\*(.*?)\*/g, '$1')        // *negrito* ou *itálico*
    .replace(/_(.*?)_/g, '$1')          // _itálico_
    .replace(/`(.*?)`/g, '$1')          // `código`
    .replace(/^[•\-\*]\s+/gm, '')       // bullets no início de linha
    .replace(/#{1,6}\s+/g, '')          // headers markdown
    .replace(/\n{3,}/g, '\n\n')         // múltiplas quebras
    .trim();
}

// Gera áudio via ElevenLabs e retorna o Buffer com o mp3.
// Lança erro se a API falhar.
async function gerarAudio(texto) {
  if (!ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY não configurada');

  const textoLimpo = limparParaAudio(texto);

  const response = await axios.post(
    ELEVENLABS_URL,
    {
      text: textoLimpo,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.80,
        style: 0.35,
        use_speaker_boost: true,
      },
    },
    {
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      responseType: 'arraybuffer',
      timeout: 30000,
    }
  );

  return Buffer.from(response.data);
}

// Envia um buffer de áudio como mensagem de voz (PTT) via UazAPI.
// type "ptt" = push-to-talk (aparece como áudio gravado no WhatsApp).
async function enviarAudioUazAPI(phone, audioBuffer) {
  const base64 = audioBuffer.toString('base64');

  const response = await axios.post(
    `${BASE_URL}/send/media`,
    {
      number: phone,
      type: 'ptt',                        // push-to-talk (voz gravada)
      media: `data:audio/mpeg;base64,${base64}`,
      delay: 500,
    },
    {
      headers: { token: UAZAPI_TOKEN, 'Content-Type': 'application/json' },
      timeout: 30000,
    }
  );

  return response.data;
}

// Função principal: gera TTS e envia como áudio de voz.
// Retorna true se enviou, false se pulou (texto longo, TTS indisponível, erro).
async function enviarRespostaComAudio(phone, texto) {
  if (!ttsDisponivel()) {
    console.log('[TTS] ElevenLabs não configurado — pulando áudio');
    return false;
  }

  // Respostas muito longas: só texto, sem áudio (evita cortar no meio)
  if (texto.length > MAX_CHARS_AUDIO) {
    console.log(`[TTS] Texto longo (${texto.length} chars) — só texto, sem áudio`);
    return false;
  }

  try {
    console.log(`[TTS] Gerando áudio para ${phone} (${texto.length} chars)...`);
    const audioBuffer = await gerarAudio(texto);
    await enviarAudioUazAPI(phone, audioBuffer);
    console.log(`[TTS] ✅ Áudio enviado para ${phone}`);
    return true;
  } catch (e) {
    console.error(`[TTS] Erro ao gerar/enviar áudio para ${phone}:`, e.message);
    // ── Log detalhado para diagnóstico ──
    // axios coloca o corpo da resposta de erro em e.response.data — como
    // a chamada usa responseType 'arraybuffer', o corpo de erro também
    // vem como buffer e precisa ser decodificado para string antes de logar.
    if (e.response) {
      console.error(`[TTS] Status HTTP: ${e.response.status}`);
      try {
        const corpoErro = Buffer.isBuffer(e.response.data)
          ? e.response.data.toString('utf-8')
          : JSON.stringify(e.response.data);
        console.error(`[TTS] Corpo do erro: ${corpoErro}`);
      } catch (eLog) {
        console.error(`[TTS] Não foi possível decodificar corpo do erro:`, eLog.message);
      }
    }
    // Falha silenciosa — o texto já foi enviado, o áudio é bônus
    return false;
  }
}

module.exports = {
  ttsDisponivel,
  enviarRespostaComAudio,
  gerarAudio,
};
