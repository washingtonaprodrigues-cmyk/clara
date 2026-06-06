const express = require('express');
const router = express.Router();
const { handleMessage } = require('../services/handler');
const { sendMessage } = require('../services/whatsapp');

router.post('/', async (req, res) => {
  try {
    const body = req.body;

    // LOG COMPLETO para debug
    console.log('PAYLOAD:', JSON.stringify(body).slice(0, 600));

    // Ignora mensagens enviadas pela própria Clara
    if (body.fromMe === true) return res.json({ ok: true });
    if (body.wasSentByApi === true) return res.json({ ok: true });
    if (body.isGroup === true) return res.json({ ok: true });

    // Extrai phone — formato real do UazAPI: "5543920003604@s.whatsapp.net"
    const phone = (body.sender || body.owner || '')
      .replace('@s.whatsapp.net', '')
      .replace(/\D/g, '');

    if (!phone) {
      console.log('⚠️ Webhook sem phone:', JSON.stringify(body).slice(0, 300));
      return res.json({ ok: true });
    }

    // Extrai texto — campo "text" direto no payload
    const text = body.text || body.message?.text || body.message?.content?.text || '';

    console.log(`📨 WEBHOOK UazAPI: ${phone} — texto: ${text.slice(0, 80)}`);

    if (text) {
      handleMessage(phone, text).catch(console.error);
      return res.json({ ok: true });
    }

    // Áudio
    if (body.mediaType === 'audio' || body.messageType === 'audioMessage') {
      sendMessage(phone, 'Por enquanto não consigo ouvir áudios, mas pode digitar que respondo na hora! 😊').catch(console.error);
      return res.json({ ok: true });
    }

    // Imagem, vídeo, documento
    if (['image', 'video', 'document'].includes(body.mediaType) ||
        ['imageMessage', 'videoMessage', 'documentMessage'].includes(body.messageType)) {
      sendMessage(phone, 'Por enquanto não consigo ver fotos, vídeos ou arquivos — mas se escrever pra mim eu ajudo! 😊').catch(console.error);
      return res.json({ ok: true });
    }

    console.log('⚠️ Payload não reconhecido:', JSON.stringify(body).slice(0, 300));
    return res.json({ ok: true });

  } catch (error) {
    console.error('Erro webhook:', error);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

router.post('/receive', (req, res) => res.json({ ok: true }));
router.get('/test', (req, res) => res.json({ status: 'Clara funcionando ✅' }));

module.exports = router;
