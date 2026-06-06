// Rotas de push — adicionar no forms.js ou criar routes/push.js

const express = require('express');
const router = express.Router();
const memory = require('../services/memory');
const { saveSubscription } = require('../services/push');

// POST /push/subscribe/:phone — salva subscription do browser
router.post('/subscribe/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const { subscription } = req.body;
    if (!subscription) return res.status(400).json({ error: 'Sem subscription' });
    const user = await memory.getOrCreateUser(phone);
    await saveSubscription(user.id, subscription);
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro push subscribe:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /push/vapid-public — retorna chave pública para o browser
router.get('/vapid-public', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || '' });
});

module.exports = router;
