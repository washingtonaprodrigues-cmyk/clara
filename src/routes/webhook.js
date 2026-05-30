const express = require('express');
const router = express.Router();
const { handleMessage } = require('../services/handler');

router.post('/receive', async (req, res) => {
  console.log('📨 WEBHOOK RECEBIDO:', JSON.stringify(req.body, null, 2));

  try {
    const body = req.body;

    if (body.fromMe) {
      return res.json({ ok: true });
    }

    const phone = body.phone;

    // TEXTO
    if (body.text?.message) {
      const text = body.text.message;
      console.log(`📩 ${phone}: ${text}`);
      handleMessage(phone, text).catch(console.error);
      return res.json({ ok: true });
    }

    // LOCALIZAÇÃO
    if (body.location) {
      console.log(`📍 Localização recebida de ${phone}`);
      handleMessage(phone, null, {
        latitude: body.location.latitude,
        longitude: body.location.longitude,
      }).catch(console.error);
      return res.json({ ok: true });
    }

    console.log('⚠️ Payload não reconhecido:', Object.keys(body));
    return res.json({ ok: true });

  } catch (error) {
    console.error('Erro webhook:', error);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

router.get('/test', (req, res) => {
  res.json({ status: 'Clara funcionando ✅' });
});

module.exports = router;
