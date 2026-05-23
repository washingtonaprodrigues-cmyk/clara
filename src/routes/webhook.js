const express = require('express');
const router = express.Router();
const { handleMessage } = require('../services/handler');

router.post('/receive', async (req, res) => {
  try {
    const body = req.body;

    // Ignora mensagens enviadas pela própria Clara
    if (body.fromMe) {
      return res.json({ ok: true });
    }

    const phone = body.phone || body.from;

    // ====================== TRATAMENTO DE LOCALIZAÇÃO ======================
    if (body.location || body.latitude || body.longitude) {
      const latitude = body.location?.latitude || body.latitude;
      const longitude = body.location?.longitude || body.longitude;
      const address = body.location?.address || body.address || null;

      console.log(`📍 Localização recebida de ${phone}: ${latitude}, ${longitude}`);

      // Envia para o handler com localização
      handleMessage(phone, null, { latitude, longitude, address }).catch(console.error);
      
      return res.json({ ok: true });
    }

    // ====================== TRATAMENTO DE TEXTO ======================
    if (body.text?.message) {
      const text = body.text.message;
      console.log(`📩 Mensagem de ${phone}: ${text}`);

      handleMessage(phone, text, null).catch(console.error);
      return res.json({ ok: true });
    }

    // Outros tipos de mensagem (áudio, imagem, etc) - por enquanto ignoramos
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
