const express = require('express');
const router = express.Router();
const { handleMessage } = require('../services/handler');
const memory = require('../services/memory');
const rateLimit = require('../services/rateLimit');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Imports lazy para evitar circular dependency / problema de ordem de carregamento
function sendMessage(phone, msg, delay) {
  const w = require('../services/whatsapp');
  if (w && typeof w.sendMessage === 'function') return w.sendMessage(phone, msg, delay);
  const axios = require('axios');
  return axios.post(`${process.env.UAZAPI_URL || 'https://claravirtual.uazapi.com'}/send/text`,
    { number: phone, text: msg, delay: delay || 800 },
    { headers: { token: process.env.UAZAPI_TOKEN, 'Content-Type': 'application/json' }, timeout: 30000 }
  );
}

// Mostra "digitando..." enquanto a resposta está sendo processada — só
// efeito visual, nunca deve atrasar nem quebrar o fluxo principal.
function mostrarDigitando(phone) {
  try {
    const w = require('../services/whatsapp');
    if (w && typeof w.mostrarDigitando === 'function') {
      w.mostrarDigitando(phone).catch(() => {});
    }
  } catch (e) {
    // Silencioso — efeito visual opcional, nunca deve interromper o fluxo
  }
}

function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

const CONFIRMACOES = [
  /^(ok|okay|certo|beleza|combinado|entendido|anotado)$/i,
];
const NEGACOES = [
  /^(n[aã]o|nao|nope|agora n[aã]o|depois|n)$/i,
];
const TOMEI_REMEDIO = [
  /tomei|já tomei|ja tomei|tomado|dose tomada/i,
];
const LEMBRETE_FEITO = [
  /^(sim|s|feito|fiz|pronto|conclu[ií]do?|já fiz|ja fiz|feito!|pronto!|perfeito|ótimo|otimo)$/i,
];

async function getLembretePendente(userId, phone, quotedText) {
  const quinze = new Date(nowBRT().getTime() - 15 * 60 * 1000);
  const candidatos = await prisma.reminder.findMany({
    where: {
      OR: [
        { userId, sent: true, confirmed: false, scheduledAt: { gte: quinze } },
        { phone, sent: true, confirmed: false, scheduledAt: { gte: quinze } },
      ]
    },
    orderBy: { scheduledAt: 'desc' }
  });
  if (!candidatos.length) return null;

  // Se o usuário citou (reply) uma mensagem específica, prioriza o
  // lembrete cujo título aparece nesse texto citado — isso resolve o caso
  // de 2+ lembretes pendentes ao mesmo tempo, onde a heurística de "mais
  // recente" pode escolher o errado mesmo com a citação explícita.
  if (quotedText) {
    const quotedLower = quotedText.toLowerCase();
    const porCitacao = candidatos.find(r => quotedLower.includes(r.message.toLowerCase()));
    if (porCitacao) return porCitacao;
  }

  return candidatos[0];
}

async function getRemedioRecente(userId) {
  const now = nowBRT();
  const pad = n => String(n).padStart(2, '0');
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

function parseVCard(vcard) {
  if (!vcard) return null;
  const lines = vcard.split('\n');
  let nome = null, telefone = null;
  for (const line of lines) {
    if (line.startsWith('FN:')) nome = line.replace('FN:', '').trim();
    if (line.startsWith('TEL')) {
      const waidMatch = line.match(/waid=(\d+)/);
      if (waidMatch) { telefone = waidMatch[1]; }
      else { const val = line.split(':').slice(1).join(':'); telefone = val.replace(/\D/g, ''); }
    }
  }
  if (!nome || !telefone) return null;
  if (!telefone.startsWith('55') && telefone.length <= 11) telefone = '55' + telefone;
  return { nome, telefone };
}

// ── Extrai o texto da mensagem citada (reply / "arrastar para responder")
// de qualquer um dos formatos conhecidos que a UazAPI pode usar.
// Se nenhum bater, retorna '' — nesse caso o log abaixo (DEBUG_QUOTE)
// mostra o payload completo para descobrirmos o campo certo.
function extrairQuotedText(message) {
  return message?.quotedMsg?.body
    || message?.quotedMsg?.text
    || message?.quotedMsg?.content
    || message?.quoted?.body
    || message?.quoted?.text
    || message?.quoted?.content
    || message?.contextInfo?.quotedMessage?.conversation
    || message?.contextInfo?.quotedMessage?.extendedTextMessage?.text
    || message?.content?.contextInfo?.quotedMessage?.conversation
    || message?.content?.contextInfo?.quotedMessage?.extendedTextMessage?.text
    || message?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation
    || '';
}

async function handleSimpleResponse(phone, text, quotedText) {
  const user = await memory.getOrCreateUser(phone);
  const textLower = text.trim();

  if (TOMEI_REMEDIO.some(r => r.test(textLower))) {
    const med = await getRemedioRecente(user.id);
    if (med) {
      await prisma.medication.update({ where: { id: med.id }, data: { remaining: { decrement: 1 } } });
      await sendMessage(phone, `✅ Ótimo! Marquei que você tomou o *${med.name}*. Restam ${med.remaining - 1} doses. 💊`);
      return true;
    }
  }

  if (LEMBRETE_FEITO.some(r => r.test(textLower))) {
    const lembrete = await getLembretePendente(user.id, phone, quotedText);
    if (lembrete) {
      await prisma.reminder.update({ where: { id: lembrete.id }, data: { confirmed: true } });
      const msgs = [
        `Arrasou! ✅ "${lembrete.message}" marcado como concluído 💜`,
        `Boa! ✅ "${lembrete.message}" tá feito então 😊`,
        `Perfeito! ✅ Anotei que você concluiu "${lembrete.message}" 💜`,
        `Isso! ✅ "${lembrete.message}" concluído com sucesso 🎉`,
      ];
      await sendMessage(phone, msgs[Math.floor(Math.random() * msgs.length)]);
      return true;
    }
  }

  if (CONFIRMACOES.some(r => r.test(textLower))) {
    const lembrete = await getLembretePendente(user.id, phone, quotedText);
    if (lembrete) { await sendMessage(phone, `👍 Ok! Te lembro de: *${lembrete.message}*`); return true; }
    return false;
  }

  if (NEGACOES.some(r => r.test(textLower))) {
    const lembrete = await getLembretePendente(user.id, phone, quotedText);
    if (lembrete) {
      // Em vez de remarcar automaticamente +30min, pergunta pra que
      // horário o usuário quer remarcar — fica registrado como pendência
      // pra próxima mensagem (checkConfirmacaoPendente trata isso).
      const expira = Date.now() + 10 * 60 * 1000;
      await prisma.memory.create({
        data: {
          userId: user.id, type: 'confirmacao_pendente',
          content: JSON.stringify({ tipo: 'remarcar_negacao', lembreteId: lembrete.id, lembreteTitulo: lembrete.message, expira })
        }
      }).catch(() => {});
      await sendMessage(phone, `Tudo bem! Pra que horas quer que eu remarque "${lembrete.message}"? 😊`);
      return true;
    }
    return false;
  }

  return false;
}

router.post('/', async (req, res) => {
  try {
    const body = req.body;

    if (body.message?.fromMe === true) return res.json({ ok: true });
    if (body.message?.wasSentByApi === true) return res.json({ ok: true });
    if (body.message?.isGroup === true) return res.json({ ok: true });

    const phone = (body.message?.sender_pn || '').replace('@s.whatsapp.net', '').replace(/\D/g, '');
    if (!phone) {
      console.log('⚠️ Webhook sem phone:', JSON.stringify(body).slice(0, 200));
      return res.json({ ok: true });
    }

    const text = body.message?.text || body.message?.content?.text || '';
    const quotedText = extrairQuotedText(body.message);
    const textComContexto = quotedText && text ? `[Mensagem citada: "${quotedText.slice(0, 200)}"]\n${text}` : text;

    console.log(`📨 WEBHOOK: ${phone} — "${text.slice(0, 80)}"${quotedText ? ` [citou: "${quotedText.slice(0, 40)}"]` : ''}`);

    if (text) {
      // ── Verificar pausa criativa (rate limit) ──
      const pausaStatus = await rateLimit.verificarPausa(phone);

      if (pausaStatus && !pausaStatus.expirou) {
        // Clara ainda está em pausa — responde contextualmente
        const msg = rateLimit.mensagemDurantePausa(
          pausaStatus.dados.tipo,
          pausaStatus.dados.ausencia,
          pausaStatus.dados.retornoHora
        );
        await sendMessage(phone, msg);
        return res.json({ ok: true });
      }

      if (pausaStatus && pausaStatus.expirou) {
        // Pausa expirou — Clara voltou! Manda mensagem de retorno
        const msgRetorno = rateLimit.mensagemRetorno(pausaStatus.dados.tipo, pausaStatus.dados.retorno);
        await sendMessage(phone, msgRetorno);
        // Continua processando a mensagem normalmente
      }

      const handled = await handleSimpleResponse(phone, text, quotedText);
      if (!handled) {
        mostrarDigitando(phone); // efeito visual, não bloqueia
        handleMessage(phone, textComContexto).catch(console.error);
      }
      return res.json({ ok: true });
    }

    // ── CONTATO encaminhado ──
    const msgType = body.message?.messageType || body.message?.type || '';
    const isContact = msgType === 'contactMessage' || msgType === 'contactsArrayMessage'
      || body.message?.contact || body.message?.contacts;

    if (isContact) {
      try {
        const user = await memory.getOrCreateUser(phone);
        const vcards = [];
        if (body.message?.contacts) {
          for (const c of body.message.contacts) { if (c.vcard) vcards.push(c.vcard); }
        } else if (body.message?.contact?.vcard) {
          vcards.push(body.message.contact.vcard);
        } else if (body.message?.content?.vcard) {
          vcards.push(body.message.content.vcard);
        }
        if (vcards.length === 0) return res.json({ ok: true });

        const salvos = [], erros = [];
        for (const vcard of vcards) {
          const contato = parseVCard(vcard);
          if (!contato) { erros.push('vCard inválido'); continue; }
          try {
            await memory.saveContact(user.id, { nome: contato.nome, phone: contato.telefone });
            salvos.push(contato.nome);
          } catch (e) { erros.push(contato.nome); }
        }

        if (salvos.length === 1) {
          await sendMessage(phone, `✅ Contato salvo! *${salvos[0]}* está na minha lista agora 📱`);
        } else if (salvos.length > 1) {
          await sendMessage(phone, `✅ ${salvos.length} contatos salvos!\n\n${salvos.map(n => `• ${n}`).join('\n')}\n\nJá posso enviar mensagens para eles 📱`);
        } else {
          await sendMessage(phone, 'Recebi o contato mas não consegui ler as informações 😕 Tenta encaminhar de novo!');
        }
      } catch (e) { console.error('[Contato vCard] Erro:', e.message); }
      return res.json({ ok: true });
    }

    // ── ÁUDIO ──
    const audioMsgType = body.message?.messageType || body.message?.mediaType || body.message?.type || '';
    const isAudio = ['audioMessage','audio','pttMessage','AudioMessage','media'].includes(audioMsgType)
      || body.message?.audio || body.message?.ptt
      || (body.message?.mimeType || '').includes('audio')
      || (body.message?.content?.mimeType || '').includes('audio');

    if (isAudio) {
      console.log('[Áudio] Detectado. messageType:', audioMsgType);
      transcribeAndProcess(phone, body).catch(console.error);
      return res.json({ ok: true });
    }

    if (['image','video','document'].includes(body.message?.mediaType) ||
        ['imageMessage','videoMessage','documentMessage'].includes(body.message?.messageType)) {
      sendMessage(phone, 'Por enquanto não consigo ver fotos, vídeos ou arquivos — mas se escrever pra mim eu ajudo! 😊').catch(console.error);
      return res.json({ ok: true });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error('Erro webhook:', error);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

router.post('/receive', (req, res) => res.json({ ok: true }));
router.get('/test', (req, res) => res.json({ status: 'Clara funcionando ✅' }));

async function transcribeAndProcess(phone, body) {
  try {
    const messageId = body.message?.id || body.message?.messageid || body.message?.messageId || body.message?.key?.id;
    if (!messageId) {
      console.log('[Áudio] ID não encontrado. Keys:', Object.keys(body.message || {}).join(', '));
      await sendMessage(phone, 'Não consegui processar o áudio 😕 Pode digitar?');
      return;
    }
    console.log(`[Áudio] Baixando messageId:`, messageId);
    const UAZAPI_URL = process.env.UAZAPI_URL || 'https://claravirtual.uazapi.com';
    const UAZAPI_TOKEN = process.env.UAZAPI_TOKEN;
    const dlRes = await fetch(`${UAZAPI_URL}/message/download`, {
      method: 'POST',
      headers: { 'token': UAZAPI_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: messageId, return_base64: true, return_link: false, generate_mp3: false }),
    });
    if (!dlRes.ok) {
      const errText = await dlRes.text().catch(() => '');
      console.error('[Áudio] Falha no download:', dlRes.status, errText.slice(0, 200));
      await sendMessage(phone, 'Não consegui baixar o áudio 😕 Pode digitar?');
      return;
    }
    const dlData = await dlRes.json();
    if (!dlData.base64Data) {
      console.error('[Áudio] base64Data vazio.');
      await sendMessage(phone, 'Não consegui ler o áudio 😕 Pode digitar?');
      return;
    }
    const audioBuffer = Buffer.from(dlData.base64Data, 'base64');
    const mimeType = dlData.mimetype || 'audio/ogg';
    const ext = mimeType.includes('mp3') ? 'mp3' : 'ogg';
    const Groq = require('groq-sdk');
    const { toFile } = require('groq-sdk');
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const transcription = await groq.audio.transcriptions.create({
      file: await toFile(audioBuffer, `audio.${ext}`, { type: mimeType }),
      model: 'whisper-large-v3-turbo',
      language: 'pt',
    });
    const texto = transcription.text?.trim();
    if (!texto) {
      await sendMessage(phone, 'Não entendi o áudio 😕 Pode repetir digitando?');
      return;
    }
    console.log(`[Áudio] ${phone} transcrito: "${texto.slice(0, 80)}"`);

    // Processa normalmente — resposta sempre em texto (sem TTS/áudio).
    mostrarDigitando(phone); // efeito visual, não bloqueia
    await handleMessage(phone, texto);
  } catch (e) {
    console.error('[Áudio] Erro:', e.message);
    await sendMessage(phone, 'Tive um problema com o áudio 😕 Pode digitar?');
  }
}

module.exports = router;
