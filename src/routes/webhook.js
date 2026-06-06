const express = require('express');
const router = express.Router();
const { handleMessage } = require('../services/handler');
const { sendMessage } = require('../services/whatsapp');

router.post('/', async (req, res) => {
  try {
    const body = req.body;

    // Log completo para debug
    console.log('📦 PAYLOAD COMPLETO:', JSON.stringify(body, null, 2));

    // Ignora mensagens enviadas pela própria Clara
    if (body.fromMe === true || body.key?.fromMe === true) return res.json({ ok: true });
    if (body.wasSentByApi === true) return res.json({ ok: true });

    // Formato UazAPI pago
    const phone =
      body.message?.key?.remoteJid?.replace('@s.whatsapp.net', '') ||
      body.message?.key?.remoteJid?.replace('@g.us', '') ||
      body.data?.key?.remoteJid?.replace('@s.whatsapp.net', '') ||
      body.from ||
      body.number;

    if (!phone) {
      console.log('⚠️ Webhook sem phone:', JSON.stringify(body));
      return res.json({ ok: true });
    }

    // Ignora grupos
    if (phone.includes('@g.us') || phone.endsWith('@g.us')) return res.json({ ok: true });

    const text =
      body.message?.message?.conversation ||
      body.message?.message?.extendedTextMessage?.text ||
      body.data?.message?.conversation ||
      body.data?.message?.extendedTextMessage?.text ||
      body.text?.message ||
      body.message?.text ||
      '';

    console.log(`📨 WEBHOOK UazAPI: ${phone} — texto: ${text.slice(0, 80)}`);

    // TEXTO
    if (text) {
      handleMessage(phone, text).catch(console.error);
      return res.json({ ok: true });
    }

    // ÁUDIO
    if (body.message?.message?.audioMessage || body.data?.message?.audioMessage) {
      sendMessage(phone, 'Por enquanto não consigo ouvir áudios, mas pode digitar que respondo na hora! 😊').catch(console.error);
      return res.json({ ok: true });
    }

    // IMAGEM, VÍDEO, DOCUMENTO
    if (
      body.message?.message?.imageMessage ||
      body.message?.message?.videoMessage ||
      body.message?.message?.documentMessage ||
      body.data?.message?.imageMessage
    ) {
      sendMessage(phone, 'Por enquanto não consigo ver fotos, vídeos ou arquivos — mas se escrever pra mim eu ajudo! 😊').catch(console.error);
      return res.json({ ok: true });
    }

    console.log('⚠️ Payload não reconhecido:', JSON.stringify(body));
    return res.json({ ok: true });

  } catch (error) {
    console.error('Erro webhook:', error);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

router.post('/receive', (req, res) => res.json({ ok: true }));
router.get('/test', (req, res) => {
  res.json({ status: 'Clara funcionando ✅' });
});

module.exports = router;
