const axios = require('axios');
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function transcribeAudio(audioUrl) {
  try {
    // Baixa o arquivo de áudio
    const response = await axios.get(audioUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data);

    // Manda para o Whisper do Groq
    const file = new File([buffer], 'audio.ogg', { type: 'audio/ogg' });

    const transcription = await groq.audio.transcriptions.create({
      file,
      model: 'whisper-large-v3',
      language: 'pt',
    });

    return transcription.text;
  } catch (error) {
    console.error('Erro transcrição áudio:', error.message);
    return null;
  }
}

module.exports = { transcribeAudio };
