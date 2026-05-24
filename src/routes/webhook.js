const express = require('express');
const router = express.Router();
const { handleMessage } = require('../services/handler');

router.post('/receive', async (req, res) => {
  try {
    const body = req.body;

    if (body.fromMe) {
      return res.json({ ok: true });
    }

    if (!body.text?.message) {
      return res.json({ ok: true });
    }

    const phone = body.phone;
    const text = body.text.message;

    console.log(`📩 ${phone}: ${text}`);

    handleMessage(phone, text).catch(console.error);

    res.json({ ok: true });
  } catch (error) {
    console.error('Erro webhook:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.get('/test', (req, res) => {
  res.json({ status: 'Clara funcionando ✅' });
});

module.exports = router;
