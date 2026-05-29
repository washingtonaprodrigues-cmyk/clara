```js
const express = require('express');
const router = express.Router();

const { handleMessage } = require('../services/handler');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const PALAVRAS_FEITO = [
  'feito',
  'fiz',
  'ok',
  'pronto',
  'done',
  'concluído',
  'concluido',
  'já fiz',
  'ja fiz',
  'sim',
  'certo',
  'tomei',
  'paguei',
  'fui',
  'cheguei',
  'terminei',
  'acabei',
  'foi',
  '👍',
  '✅'
];

// ====================== STATUS ======================
router.post('/status', async (req, res) => {
  try {
    return res.json({ ok: true });
  } catch (error) {
    console.error('Erro webhook status:', error);
    return res.status(500).json({
      error: 'Erro interno'
    });
  }
});

// ====================== RECEIVE ======================
router.post('/receive', async (req, res) => {
  try {
    const body = req.body;

    if (body.fromMe) {
      return res.json({ ok: true });
    }

    const phone = body.phone;

    // ====================== TEXTO ======================
    if (body.text?.message) {
      const text = body.text.message;

      console.log(`📩 ${phone}: ${text}`);

      const textoLower = text.toLowerCase().trim();

      const isConfirmacao = PALAVRAS_FEITO.some(
        p => textoLower === p
      );

      if (isConfirmacao) {
        try {
          const user = await prisma.user.findUnique({
            where: {
              phone
            }
          });

          if (user) {
            const lembrete = await prisma.reminder.findFirst({
              where: {
                userId: user.id,
                sent: true,
                confirmed: false
              },
              orderBy: {
                scheduledAt: 'desc'
              }
            });

            if (lembrete) {
              await prisma.reminder.update({
                where: {
                  id: lembrete.id
                },
                data: {
                  confirmed: true
                }
              });

              console.log(
                `[Webhook] Confirmado: ${lembrete.message}`
              );
            }
          }
        } catch (e) {
          console.error(
            'Erro confirmar lembrete:',
            e.message
          );
        }
      }

      handleMessage(phone, text).catch(console.error);

      return res.json({
        ok: true
      });
    }

    // ====================== LOCALIZAÇÃO ======================
    if (body.location) {
      console.log(`📍 Localização de ${phone}`);

      handleMessage(phone, null, {
        latitude: body.location.latitude,
        longitude: body.location.longitude
      }).catch(console.error);

      return res.json({
        ok: true
      });
    }

    return res.json({
      ok: true
    });
  } catch (error) {
    console.error('Erro webhook:', error);

    return res.status(500).json({
      error: 'Erro interno'
    });
  }
});

router.get('/test', (req, res) => {
  res.json({
    status: 'Clara funcionando ✅'
  });
});

module.exports = router;
```
