const express = require('express');
const router = express.Router();
const { handleMessage } = require('../services/handler');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// Palavras que indicam que o lembrete foi concluído
const PALAVRAS_FEITO = [
  'feito', 'fiz', 'ok', 'pronto', 'done', 'concluído', 'concluido',
  'já fiz', 'ja fiz', 'já', 'sim', 'certo', 'desliguei', 'tomei',
  'paguei', 'fui', 'cheguei', 'terminei', 'acabei', 'foi',
  'tá bom', 'ta bom', 'tudo certo', '👍', '✅'
];

router.post('/receive', async (req, res) => {
  try {
    const body = req.body;

    if (body.fromMe) return res.json({ ok: true });

    const phone = body.phone;

    // RESPOSTA A UMA MENSAGEM (reply) — verifica se é confirmação de lembrete
    if (body.referenceMessageId || body.replyTo?.messageId) {
      const msgId = body.referenceMessageId || body.replyTo?.messageId;
      const textoResposta = body.text?.message?.toLowerCase().trim() || '';

      const isFeitoReply = PALAVRAS_FEITO.some(p => textoResposta.includes(p));

      if (isFeitoReply) {
        // Tenta encontrar lembrete pendente do usuário e confirmar
        try {
          const user = await prisma.user.findUnique({ where: { phone } });
          if (user) {
            const lembreteAtivo = await prisma.reminder.findFirst({
              where: { userId: user.id, confirmed: false, sent: false },
              orderBy: { scheduledAt: 'asc' }
            });
            if (lembreteAtivo) {
              await prisma.reminder.update({
                where: { id: lembreteAtivo.id },
                data: { confirmed: true, sent: true }
              });
              console.log(`[Webhook] Lembrete confirmado via reply: ${lembreteAtivo.message}`);
            }
          }
        } catch (e) {
          console.error('Erro confirmar lembrete:', e.message);
        }
      }
    }

    // TEXTO NORMAL
    if (body.text?.message) {
      const text = body.text.message;
      console.log(`📩 ${phone}: ${text}`);

      // Verifica se é confirmação de lembrete recente (enviado nos últimos 15min)
      const textoLower = text.toLowerCase().trim();
      const isFeitoSimples = PALAVRAS_FEITO.some(p => textoLower === p || textoLower.startsWith(p + ' ') || textoLower.endsWith(' ' + p));

      if (isFeitoSimples) {
        try {
          const user = await prisma.user.findUnique({ where: { phone } });
          if (user) {
            const quinzeMinAtras = new Date(Date.now() - 15 * 60000);
            const lembreteRecente = await prisma.reminder.findFirst({
              where: {
                userId: user.id,
                confirmed: false,
                attempts: { gte: 1 },
                updatedAt: { gte: quinzeMinAtras }
              },
              orderBy: { updatedAt: 'desc' }
            });
            if (lembreteRecente) {
              await prisma.reminder.update({
                where: { id: lembreteRecente.id },
                data: { confirmed: true, sent: true }
              });
              console.log(`[Webhook] Lembrete confirmado: ${lembreteRecente.message}`);
            }
          }
        } catch (e) {
          console.error('Erro confirmar lembrete simples:', e.message);
        }
      }

      handleMessage(phone, text).catch(console.error);
      return res.json({ ok: true });
    }

    // LOCALIZAÇÃO
    if (body.location) {
      console.log(`📍 Localização de ${phone}`);
      handleMessage(phone, null, {
        latitude: body.location.latitude,
        longitude: body.location.longitude,
      }).catch(console.error);
      return res.json({ ok: true });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error('Erro webhook:', error);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

router.get('/test', (req, res) => {
  res.json({ status: 'Clara funcionando ✅' });
});

module.exports = router;
