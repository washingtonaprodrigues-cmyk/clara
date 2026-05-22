const express = require('express');
const router = express.Router();
const { handleMessage } = require('../services/handler');

router.post('/receive', async (req, res) => {
  try {
    const body = req.body;

    // Ignora mensagens da própria Clara
    if (body.fromMe) {
      return res.json({ ok: true });
    }

    // Ignora se não tiver texto
    if (!body.text?.message) {
      return res.json({ ok: true });
    }

    const phone = body.phone;
    const text = body.text.message;

    console.log(`📩 Mensagem de ${phone}: ${text}`);

    // Processa em background (não bloqueia o webhook)
    handleMessage(phone, text).catch(console.error);

    // Responde imediatamente pro Z-API
    res.json({ ok: true });
  } catch (error) {
    console.error('Erro no webhook:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.get('/test', (req, res) => {
  res.json({ status: 'Clara webhook funcionando ✅' });
});

module.exports = router;
