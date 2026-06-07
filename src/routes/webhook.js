const express = require('express');
const router = express.Router();
const { handleMessage } = require('../services/handler');
const { sendMessage } = require('../services/whatsapp');

router.post('/', async (req, res) => {
  try {
    const body = req.body;

    // Ignora mensagens enviadas pela própria Clara
    if (body.message?.fromMe === true) return res.json({ ok: true });
    if (body.message?.wasSentByApi === true) return res.json({ ok: true });
    if (body.message?.isGroup === true) return res.json({ ok: true });

    // Extrai phone do remetente real: body.message.sender_pn
    const phone = (body.message?.sender_pn || '')
      .replace('@s.whatsapp.net', '')
      .replace(/\D/g, '');

    if (!phone) {
      console.log('⚠️ Webhook sem phone:', JSON.stringify(body).slice(0, 200));
      return res.json({ ok: true });
    }

    // Extrai texto
    const text = body.message?.text || body.message?.content?.text || '';

    console.log(`📨 WEBHOOK UazAPI: ${phone} — texto: ${text.slice(0, 80)}`);

    if (text) {
      handleMessage(phone, text).catch(console.error);
      return res.json({ ok: true });
    }

    // Áudio
    if (body.message?.mediaType === 'audio' || body.message?.messageType === 'audioMessage') {
      sendMessage(phone, 'Por enquanto não consigo ouvir áudios, mas pode digitar que respondo na hora! 😊').catch(console.error);
      return res.json({ ok: true });
    }

    // Imagem, vídeo, documento
    if (['image', 'video', 'document'].includes(body.message?.mediaType) ||
        ['imageMessage', 'videoMessage', 'documentMessage'].includes(body.message?.messageType)) {
      sendMessage(phone, 'Por enquanto não consigo ver fotos, vídeos ou arquivos — mas se escrever pra mim eu ajudo! 😊').catch(console.error);
      return res.json({ ok: true });
    }

    console.log('⚠️ Payload não reconhecido tipo:', body.message?.type || 'sem tipo');
    return res.json({ ok: true });

  } catch (error) {
    console.error('Erro webhook:', error);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

router.post('/receive', (req, res) => res.json({ ok: true }));
router.get('/test', (req, res) => res.json({ status: 'Clara funcionando ✅' }));

module.exports = router;
