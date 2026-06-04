const express = require('express');
const router = express.Router();
const { freeResponse } = require('../services/groq');
const memory = require('../services/memory');

router.post('/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const { message, privateMode } = req.body;
    if (!message) return res.status(400).json({ error: 'Mensagem vazia' });

    const user = await memory.getOrCreateUser(phone);
    const limit = privateMode ? 100 : 10;
    const history = await memory.getConversationHistory(user.id, limit);
    const preferences = await memory.getUserPreference(user.id);
    const response = await freeResponse(message, history, preferences, privateMode);

    await memory.saveConversationMessage(user.id, 'user', message, privateMode);
    await memory.saveConversationMessage(user.id, 'assistant', response, privateMode);

    res.json({ reply: response });
  } catch (e) {
    console.error('Erro chat:', e.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
