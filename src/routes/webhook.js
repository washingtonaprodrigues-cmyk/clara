const express = require('express');
const router = express.Router();

const handlerModule = require('../services/handler');
const handleMessage = handlerModule.handleMessage || handlerModule;

router.post('/receive', async (req, res) => {
  try {
    const body = req.body;

    if (body.fromMe) {
      return res.json({ ok: true });
    }

    const phone = body.phone;

    if (typeof handleMessage !== 'function') {
      console.error('handleMessage nao foi carregado como funcao:', handlerModule);
      return res.status(500).json({ error: 'Handler invalido' });
    }

    if (body.text?.message) {
      const text = body.text.message;

      console.log(`📩 ${phone}: ${text}`);

      handleMessage(phone, text).catch(console.error);

      return res.json({ ok: true });
    }

    if (body.location) {
      console.log(`📍 Localizacao recebida de ${phone}`);

      handleMessage(phone, null, {
        latitude: body.location.latitude,
        longitude: body.location.longitude,
      }).catch(console.error);

      return res.json({ ok: true });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error('Erro no webhook:', error);

    return res.status(500).json({
      error: 'Erro interno',
    });
  }
});

router.get('/test', (req, res) => {
  res.json({
    status: 'Clara funcionando ✅',
  });
});

module.exports = router;
