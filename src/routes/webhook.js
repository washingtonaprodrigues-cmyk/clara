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

// ====================== EVENTO DE LEITURA (VISTO) Z-API ======================
// Só confirma se o lembrete foi disparado há mais de 5 minutos
// (evita confirmar quando usuário só abre pra ler sem ter feito nada)
router.post('/status', async (req, res) => {
  try {
    const body = req.body;

    if (body.status === 'READ' && body.phone) {
      const phone = body.phone;

      try {
        const user = await prisma.user.findUnique({ where: { phone } });
        if (user) {
          const agora = Date.now();
          const cincoMinAtras = new Date(agora - 5 * 60000);   // mínimo 5min após disparo
          const trintaMinAtras = new Date(agora - 30 * 60000); // máximo 30min (não confirma lembretes velhos)

          const lembretePendente = await prisma.reminder.findFirst({
            where: {
              userId: user.id,
              confirmed: false,
              sent: false,
              updatedAt: {
                gte: trintaMinAtras, // disparado nos últimos 30min
                lte: cincoMinAtras,  // mas há pelo menos 5min atrás
              }
            },
            orderBy: { updatedAt: 'desc' }
          });

          if (lembretePendente) {
            await prisma.reminder.update({
              where: { id: lembretePendente.id },
              data: { confirmed: true, sent: true }
            });
            console.log(`[Webhook] Lembrete confirmado via VISTO (+5min): ${lembretePendente.message}`);
          }
        }
      } catch (e) {
        console.error('Erro confirmar por visto:', e.message);
      }
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error('Erro webhook status:', error);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

// ====================== MENSAGENS RECEBIDAS ======================
router.post('/receive', async (req, res) => {
  try {
    const body = req.body;

    if (body.fromMe) return res.json({ ok: true });

    const phone = body.phone;

    // ── RESPOSTA A UMA MENSAGEM (reply) ──
    if (body.referenceMessageId || body.replyTo?.messageId) {
      const textoResposta = body.text?.message?.toLowerCase().trim() || '';
      const isFeitoReply = PALAVRAS_FEITO.some(p => textoResposta.includes(p));

      if (isFeitoReply) {
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
          console.error('Erro confirmar lembrete por reply:', e.message);
        }
      }
    }

    // ── TEXTO NORMAL ──
    if (body.text?.message) {
      const text = body.text.message;
      console.log(`📩 ${phone}: ${text}`);

      const textoLower = text.toLowerCase().trim();

      // Verifica se é confirmação — funciona com attempts=0 ou 1
      const isFeitoSimples = PALAVRAS_FEITO.some(p =>
        textoLower === p ||
        textoLower.startsWith(p + ' ') ||
        textoLower.endsWith(' ' + p) ||
        textoLower.includes(p)
      );

      if (isFeitoSimples) {
        try {
          const user = await prisma.user.findUnique({ where: { phone } });
          if (user) {
            const trintaMinAtras = new Date(Date.now() - 30 * 60000);
            const lembretePendente = await prisma.reminder.findFirst({
              where: {
                userId: user.id,
                confirmed: false,
                sent: false,
                updatedAt: { gte: trintaMinAtras }
              },
              orderBy: { updatedAt: 'desc' }
            });

            if (lembretePendente) {
              await prisma.reminder.update({
                where: { id: lembretePendente.id },
                data: { confirmed: true, sent: true }
              });
              console.log(`[Webhook] Lembrete confirmado por texto: ${lembretePendente.message}`);
            }

            // Confirma medicamento do dia se mencionou que tomou
            const mencionouRemedio = ['tomei', 'tomi', 'já tomei', 'ja tomei'].some(p => textoLower.includes(p));
            if (mencionouRemedio) {
              const hoje = new Date().toISOString().slice(0, 10);
              const jaConfirmou = await prisma.memory.findFirst({
                where: { userId: user.id, type: 'med_confirmado_hoje', content: hoje }
              });
              if (!jaConfirmou) {
                await prisma.memory.create({
                  data: { userId: user.id, type: 'med_confirmado_hoje', content: hoje }
                });
                console.log(`[Webhook] Medicamento confirmado por texto: ${phone}`);
              }
            }
          }
        } catch (e) {
          console.error('Erro confirmar lembrete por texto:', e.message);
        }
      }

      handleMessage(phone, text).catch(console.error);
      return res.json({ ok: true });
    }

    // ── LOCALIZAÇÃO ──
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
