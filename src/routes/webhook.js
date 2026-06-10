const express = require('express');
const router = express.Router();
const { handleMessage } = require('../services/handler');
const { sendMessage, sendButtons } = require('../services/whatsapp');
const memory = require('../services/memory');
const { PrismaClient } = require('@prisma/client');
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

// Extrai contatos de um vCard
function parseVCard(vcard) {
  if (!vcard) return null;
  const lines = vcard.split('\n');
  let nome = null;
  let telefone = null;

  for (const line of lines) {
    // Nome: FN:João Silva
    if (line.startsWith('FN:')) {
      nome = line.replace('FN:', '').trim();
    }
    // Telefone: TEL;type=CELL;waid=5511999998888:+55 11 99999-8888
    // ou TEL:+5511999998888
    if (line.startsWith('TEL')) {
      // Tenta extrair do waid primeiro (mais confiável)
      const waidMatch = line.match(/waid=(\d+)/);
      if (waidMatch) {
        telefone = waidMatch[1];
      } else {
        // Extrai só números do valor
        const val = line.split(':').slice(1).join(':');
        telefone = val.replace(/\D/g, '');
      }
    }
  }

  if (!nome || !telefone) return null;

  // Normaliza telefone
  if (!telefone.startsWith('55') && telefone.length <= 11) telefone = '55' + telefone;

  return { nome, telefone };
}

async function handleSimpleResponse(phone, text) {
  const user = await memory.getOrCreateUser(phone);
  const textLower = text.trim();

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

  if (CONFIRMACOES.some(r => r.test(textLower))) {
    const lembrete = await getLembretePendente(user.id, phone);
    if (lembrete) {
      await sendMessage(phone, `👍 Ok! Te lembro de: *${lembrete.message}*`);
      return true;
    }
    return false;
  }

  if (NEGACOES.some(r => r.test(textLower))) {
    const lembrete = await getLembretePendente(user.id, phone);
    if (lembrete) {
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

    // Extrai mensagem citada (quando usuário responde/cita uma mensagem)
    const quotedText = body.message?.quotedMsg?.body
      || body.message?.quotedMsg?.text
      || body.message?.contextInfo?.quotedMessage?.conversation
      || body.message?.content?.contextInfo?.quotedMessage?.conversation
      || '';

    // Se tem mensagem citada, injeta no texto para a IA ter contexto
    const textComContexto = quotedText && text
      ? `[Mensagem citada: "${quotedText.slice(0, 200)}"]
${text}`
      : text;

    console.log(`📨 WEBHOOK: ${phone} — "${text.slice(0, 80)}"${quotedText ? ` [citou: "${quotedText.slice(0, 40)}"]` : ''}`);

    if (text) {
      const handled = await handleSimpleResponse(phone, text);
      // Se não tratado pela resposta simples, usa o texto com contexto
      if (!handled) {
        handleMessage(phone, textComContexto).catch(console.error);
      }
      return res.json({ ok: true });
    }

    // ── CONTATO encaminhado pelo WhatsApp ──
    const msgType = body.message?.messageType || body.message?.type || '';
    const isContact = msgType === 'contactMessage' ||
                      msgType === 'contactsArrayMessage' ||
                      body.message?.contact ||
                      body.message?.contacts;

    if (isContact) {
      try {
        const user = await memory.getOrCreateUser(phone);

        // Pega vCards — pode vir como array ou objeto único
        const vcards = [];
        if (body.message?.contacts) {
          for (const c of body.message.contacts) {
            if (c.vcard) vcards.push(c.vcard);
          }
        } else if (body.message?.contact?.vcard) {
          vcards.push(body.message.contact.vcard);
        } else if (body.message?.content?.vcard) {
          vcards.push(body.message.content.vcard);
        }

        if (vcards.length === 0) {
          return res.json({ ok: true });
        }

        const salvos = [];
        const erros = [];

        for (const vcard of vcards) {
          const contato = parseVCard(vcard);
          if (!contato) { erros.push('vCard inválido'); continue; }

          try {
            await memory.saveContact(user.id, {
              nome: contato.nome,
              phone: contato.telefone,
            });
            salvos.push(contato.nome);
            console.log(`[Contato vCard] Salvo: ${contato.nome} → ${contato.telefone}`);
          } catch (e) {
            erros.push(contato.nome);
            console.error(`[Contato vCard] Erro ao salvar ${contato.nome}:`, e.message);
          }
        }

        // Resposta para o usuário
        if (salvos.length === 1) {
          await sendMessage(phone, `✅ Contato salvo! *${salvos[0]}* está na minha lista agora 📱\n\nSempre que quiser enviar uma mensagem, é só me pedir!`);
        } else if (salvos.length > 1) {
          await sendMessage(phone, `✅ ${salvos.length} contatos salvos!\n\n${salvos.map(n => `• ${n}`).join('\n')}\n\nJá posso enviar mensagens para eles quando precisar 📱`);
        } else {
          await sendMessage(phone, 'Recebi o contato mas não consegui ler as informações 😕 Tenta encaminhar de novo!');
        }
      } catch (e) {
        console.error('[Contato vCard] Erro geral:', e.message);
      }
      return res.json({ ok: true });
    }

    // Áudio — transcreve via Groq Whisper
    if (body.message?.mediaType === 'audio' || body.message?.messageType === 'audioMessage') {
      transcribeAndProcess(phone, body).catch(console.error);
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

// ── Transcrição de áudio via Groq Whisper ──
async function transcribeAndProcess(phone, body) {
  try {
    const messageId = body.message?.id || body.message?.messageid;
    if (!messageId) {
      await sendMessage(phone, 'Não consegui processar o áudio 😕 Pode digitar?');
      return;
    }

    // Baixar o áudio da UazAPI
    const UAZAPI_URL = process.env.UAZAPI_URL || 'https://claravirtual.uazapi.com';
    const UAZAPI_TOKEN = process.env.UAZAPI_TOKEN;
    
    const dlRes = await fetch(`${UAZAPI_URL}/message/download/${messageId}`, {
      headers: { token: UAZAPI_TOKEN }
    });

    if (!dlRes.ok) {
      await sendMessage(phone, 'Não consegui baixar o áudio 😕 Pode digitar?');
      return;
    }

    const audioBuffer = Buffer.from(await dlRes.arrayBuffer());
    
    // Transcrever via Groq Whisper
    const Groq = require('groq-sdk');
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const { toFile } = require('groq-sdk');

    const transcription = await groq.audio.transcriptions.create({
      file: await toFile(audioBuffer, 'audio.ogg', { type: 'audio/ogg' }),
      model: 'whisper-large-v3-turbo',
      language: 'pt',
    });

    const texto = transcription.text?.trim();
    if (!texto) {
      await sendMessage(phone, 'Não entendi o áudio 😕 Pode repetir digitando?');
      return;
    }

    console.log(`[Áudio] ${phone} transcrito: "${texto.slice(0, 80)}"`);

    // Processar como mensagem de texto normal
    const { handleMessage } = require('../services/handler');
    await handleMessage(phone, texto);

  } catch(e) {
    console.error('[Áudio] Erro:', e.message);
    await sendMessage(phone, 'Tive um problema com o áudio 😕 Pode digitar?');
  }
}

module.exports = router;
