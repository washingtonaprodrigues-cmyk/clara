const express = require('express');
const router = express.Router();

const { handleMessage } = require('../services/handler');
const { classify } = require('../services/groq');

// AJUSTE O CAMINHO SE NECESSÁRIO
const { sendMessage } = require('../services/whatsapp');

router.post('/receive', async (req, res) => {

try {

```
console.log('REQ BODY:', JSON.stringify(req.body, null, 2));

const body = req.body;

// ignora mensagens da própria Clara
if (body.fromMe) {
  return res.json({ ok: true });
}

// ignora mensagens vazias
if (!body.text || !body.text.message) {
  return res.json({ ok: true });
}

const phone = body.phone;
const message = body.text.message;

console.log('PHONE:', phone);
console.log('MESSAGE:', message);

// usuário
const user = {
  id: phone,
};

console.log('ANTES CLASSIFY');

// IA classifica
const classified = await classify(message);

console.log('CLASSIFIED:', classified);

// proteção
if (!classified || !classified.tipo) {

  console.log('CLASSIFY INVALIDO');

  await sendMessage(
    phone,
    'Tive dificuldade pra entender isso 😅'
  );

  return res.json({ ok: true });
}

console.log('ANTES HANDLER');

// envia pro handler
await handleMessage({
  user,
  phone,
  message,
  classified,
  sendMessage,
});

console.log('FINALIZOU');

res.json({ ok: true });
```

} catch (error) {

```
console.error('ERRO COMPLETO:', error);

res.status(500).json({
  error: error.message,
  stack: error.stack,
});
```

}
});

router.get('/test', (req, res) => {

res.json({
status: 'Clara webhook funcionando',
});

});

module.exports = router;
