const express = require('express');
const router = express.Router();
const { processMessage } = require('../services/groq');
const memory = require('../services/memory');

router.post('/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Mensagem vazia' });

    const user = await memory.getOrCreateUser(phone);
    const history = await memory.getConversationHistory(user.id, 10);
    const response = await processMessage(message, history, {});

    await memory.saveConversationMessage(user.id, 'user', message);
    await memory.saveConversationMessage(user.id, 'assistant', response);

    res.json({ reply: response });
  } catch (e) {
    console.error('Erro chat:', e.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
