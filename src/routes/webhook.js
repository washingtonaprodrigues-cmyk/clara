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

    if (body.text?.message) {
      const text = body.text.message;

      console.log(`📩 ${phone}: ${text}`);

      if (typeof handleMessage !== 'function') {
        console.error('handleMessage não foi carregado como função:', handlerModule);
        return res.status(500).json({ error: 'Handler inválido' });
      }

      handleMessage(phone, text).catch(console.error);

      return res.json({ ok: true });
    }

    if (body.location) {
      console.log(`📍 Localização recebida de ${phone}`);

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
