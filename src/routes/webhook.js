const express = require('express');
const router = express.Router();
const { handleMessage } = require('../services/handler');
const { sendMessage } = require('../services/whatsapp');

// UazAPI envia para /webhook (sem /receive)
router.post('/', async (req, res) => {
  try {
    const body = req.body;

    // Ignora mensagens enviadas pela própria Clara
    if (body.fromMe === true || body.key?.fromMe === true) return res.json({ ok: true });

    // Extrai phone e texto no formato UazAPI
    const phone = body.data?.key?.remoteJid?.replace('@s.whatsapp.net', '')
      || body.from
      || body.number;

    if (!phone) {
      console.log('⚠️ Webhook sem phone:', JSON.stringify(body).slice(0, 200));
      return res.json({ ok: true });
    }

    const text = body.data?.message?.conversation
      || body.data?.message?.extendedTextMessage?.text
      || body.text?.message
      || body.message?.text
      || '';

    console.log(`📨 WEBHOOK UazAPI: ${phone} — texto: ${text.slice(0, 80)}`);

    // TEXTO
    if (text) {
      handleMessage(phone, text).catch(console.error);
      return res.json({ ok: true });
    }

    // ÁUDIO
    if (body.data?.message?.audioMessage || body.audio) {
      sendMessage(phone, 'Por enquanto não consigo ouvir áudios, mas pode digitar que respondo na hora! 😊').catch(console.error);
      return res.json({ ok: true });
    }

    // IMAGEM, VÍDEO, DOCUMENTO
    if (body.data?.message?.imageMessage || body.data?.message?.videoMessage || body.data?.message?.documentMessage) {
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

// Mantém /receive para compatibilidade
router.post('/receive', (req, res) => res.json({ ok: true }));

router.get('/test', (req, res) => {
  res.json({ status: 'Clara funcionando ✅' });
});

module.exports = router;
