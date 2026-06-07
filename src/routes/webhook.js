const express = require('express');
const router = express.Router();
const { handleMessage } = require('../services/handler');
const { sendMessage, sendButtons } = require('../services/whatsapp');
const { PrismaClient } = require('@prisma/client');
const memory = require('../services/memory');

const prisma = new PrismaClient();

function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

// ── Respostas simples que NÃO precisam de IA ──
const CONFIRMACOES = [
  /^(ok|okay|sim|s|feito|fiz|pronto|conclu[ií]do?|certo|beleza|combinado|entendido|anotado|perfeito|ótimo|otimo)$/i,
];

const NEGACOES = [
  /^(n[aã]o|nao|nope|agora n[aã]o|depois|n)$/i,
];

const TOMEI_REMEDIO = [
  /tomei|já tomei|ja tomei|tomado|dose tomada/i,
];

const LEMBRETE_FEITO = [
  /^(feito|fiz|pronto|conclu[ií]do?|já fiz|ja fiz|feito!|pronto!)$/i,
];

// Verifica se tem lembrete enviado recentemente (últimos 15 min pelo horário agendado)
async function getLembretePendente(userId, phone) {
  const quinze = new Date(nowBRT().getTime() - 15 * 60 * 1000);
  return prisma.reminder.findFirst({
    where: {
      OR: [
        { userId, sent: true, confirmed: false, scheduledAt: { gte: quinze } },
        { phone, sent: true, confirmed: false, scheduledAt: { gte: quinze } },
      ]
    },
    orderBy: { scheduledAt: 'desc' }
  });
}

// Verifica se tem remédio com dose no horário atual (±5 min)
async function getRemedioRecente(userId) {
  const now = nowBRT();
  const pad = n => String(n).padStart(2, '0');
  const hm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  // Horários dentro de ±5 minutos
  const horarios = [];
  for (let d = -5; d <= 5; d++) {
    const t = new Date(now.getTime() + d * 60000);
    horarios.push(`${pad(t.getHours())}:${pad(t.getMinutes())}`);
  }
  const meds = await prisma.medication.findMany({
    where: { userId, active: true, remaining: { gt: 0 } }
  });
  for (const m of meds) {
    let times = []; try { times = JSON.parse(m.times || '[]'); } catch {}
    if (times.some(t => horarios.includes(t))) return m;
  }
  return null;
}

async function handleSimpleResponse(phone, text) {
  const user = await memory.getOrCreateUser(phone);
  const textLower = text.trim();

  // "tomei", "já tomei" → marca remédio como tomado
  if (TOMEI_REMEDIO.some(r => r.test(textLower))) {
    const med = await getRemedioRecente(user.id);
    if (med) {
      await prisma.medication.update({
        where: { id: med.id },
        data: { remaining: { decrement: 1 } }
      });
      await sendMessage(phone, `✅ Ótimo! Marquei que você tomou o *${med.name}*. Restam ${med.remaining - 1} doses. 💊`);
      return true;
    }
  }

  // "feito", "fiz", "pronto" → conclui lembrete pendente
  if (LEMBRETE_FEITO.some(r => r.test(textLower))) {
    const lembrete = await getLembretePendente(user.id, phone);
    if (lembrete) {
      await prisma.reminder.update({
        where: { id: lembrete.id },
        data: { confirmed: true }
      });
      const msgs = [
        'Arrasou! ✅ Marcado como concluído 💜',
        'Boa! ✅ Tá feito então 😊',
        'Perfeito! ✅ Anotei que você concluiu 💜',
        'Isso! ✅ Concluído com sucesso 🎉',
      ];
      await sendMessage(phone, msgs[Math.floor(Math.random() * msgs.length)]);
      return true;
    }
  }

  // "ok", "sim", "certo" após lembrete → confirma
  if (CONFIRMACOES.some(r => r.test(textLower))) {
    const lembrete = await getLembretePendente(user.id, phone);
    if (lembrete) {
      // Não conclui, só acusa recebimento sem gastar IA
      await sendMessage(phone, `👍 Ok! Te lembro de: *${lembrete.message}*`);
      return true;
    }
    // Se não tem lembrete pendente, deixa a IA responder
    return false;
  }

  // "não", "agora não" → snooze do lembrete
  if (NEGACOES.some(r => r.test(textLower))) {
    const lembrete = await getLembretePendente(user.id, phone);
    if (lembrete) {
      // Reagenda para 30 minutos
      const novoHorario = new Date(nowBRT().getTime() + 30 * 60 * 1000);
      await prisma.reminder.update({
        where: { id: lembrete.id },
        data: { scheduledAt: novoHorario, sent: false }
      });
      await sendMessage(phone, `⏰ Tudo bem! Vou te lembrar novamente em 30 minutos 😊`);
      return true;
    }
    return false;
  }

  return false;
}

router.post('/', async (req, res) => {
  try {
    const body = req.body;

    // Ignora mensagens enviadas pela própria Clara
    if (body.message?.fromMe === true) return res.json({ ok: true });
    if (body.message?.wasSentByApi === true) return res.json({ ok: true });
    if (body.message?.isGroup === true) return res.json({ ok: true });

    // Extrai phone
    const phone = (body.message?.sender_pn || '')
      .replace('@s.whatsapp.net', '')
      .replace(/\D/g, '');
    if (!phone) {
      console.log('⚠️ Webhook sem phone:', JSON.stringify(body).slice(0, 200));
      return res.json({ ok: true });
    }

    const text = body.message?.text || body.message?.content?.text || '';
    console.log(`📨 WEBHOOK: ${phone} — "${text.slice(0, 80)}"`);

    if (text) {
      // Tenta resposta simples primeiro (sem IA)
      const handled = await handleSimpleResponse(phone, text);
      if (!handled) {
        // Se não foi tratado, usa IA normalmente
        handleMessage(phone, text).catch(console.error);
      }
      return res.json({ ok: true });
    }

    // Áudio
    if (body.message?.mediaType === 'audio' || body.message?.messageType === 'audioMessage') {
      sendMessage(phone, 'Por enquanto não consigo ouvir áudios, mas pode digitar que respondo na hora! 😊').catch(console.error);
      return res.json({ ok: true });
    }

    // Imagem, vídeo, documento
    if (['image', 'video', 'document'].includes(body.message?.mediaType) ||
        ['imageMessage', 'videoMessage', 'documentMessage'].includes(body.message?.messageType)) {
      sendMessage(phone, 'Por enquanto não consigo ver fotos, vídeos ou arquivos — mas se escrever pra mim eu ajudo! 😊').catch(console.error);
      return res.json({ ok: true });
    }

    console.log('⚠️ Payload não reconhecido tipo:', body.message?.type || 'sem tipo');
    return res.json({ ok: true });
  } catch (error) {
    console.error('Erro webhook:', error);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

router.post('/receive', (req, res) => res.json({ ok: true }));
router.get('/test', (req, res) => res.json({ status: 'Clara funcionando ✅' }));

module.exports = router;
