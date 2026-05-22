const express = require('express');
const router = express.Router();

const { handleMessage } = require('../services/handler');
const { classify } = require('../services/groq');

// IMPORTANTE:
// ajuste o caminho se seu sendMessage estiver em outro arquivo
const { sendMessage } = require('../services/whatsapp');

router.post('/receive', async (req, res) => {
try {
const body = req.body;

```
// ignora mensagens da própria Clara
if (body.fromMe) {
  return res.json({ ok: true });
}

// ignora mensagens vazias
if (!body.text?.message) {
  return res.json({ ok: true });
}

const phone = body.phone;
const message = body.text.message;

console.log(`💛 Clara recebeu de ${phone}: ${message}`);

// usuário
const user = {
  id: phone,
};

// classificação IA
const classified = await classify(message);

console.log('🧠 Resultado classify:', classified);

// proteção extra
if (!classified || !classified.tipo) {
  console.log('⚠️ classify retornou inválido');

  await sendMessage(
    phone,
    'Tive dificuldade pra entender isso 😅'
  );

  return res.json({ ok: true });
}

// handler principal
await handleMessage({
  user,
  phone,
  message,
  classified,
  sendMessage,
});

res.json({ ok: true });
```

} catch (error) {
console.error('Erro no webhook:', error);

```
res.status(500).json({
  error: 'Erro interno',
});
```

}
});

router.get('/test', (req, res) => {
res.json({
status: 'Clara webhook funcionando 💛',
});
});

module.exports = router;
