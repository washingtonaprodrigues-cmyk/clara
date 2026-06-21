const express = require('express');
const router = express.Router();
const { handleMessage } = require('../services/handler');
const memory = require('../services/memory');
const rateLimit = require('../services/rateLimit');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ── Cache de deduplicação de messageId ──
// Guarda os IDs de mensagens já processadas recentemente (10 minutos é
// mais que suficiente para cobrir qualquer reenvio realista por timeout
// de rede). Usa um Map (id -> timestamp de expiração) com limpeza
// periódica simples, para não crescer indefinidamente em memória.
const _messageIdsProcessados = new Map();
const DEDUP_JANELA_MS = 10 * 60 * 1000; // 10 minutos

function marcarMessageIdProcessado(id) {
  _messageIdsProcessados.set(id, Date.now() + DEDUP_JANELA_MS);
}

// ── Segunda camada: dedup por CONTEÚDO (telefone + texto) ──
// A deduplicação por messageId depende de a UazAPI sempre mandar o ID em
// um dos 4 campos verificados abaixo. Se um reenvio vier sem nenhum desses
// campos (ou em um campo desconhecido), o messageId fica undefined e a
// primeira camada não pega nada — bug real observado: mesmo lembrete
// criado 2x com título quase idêntico ("Enviar..." vs "enviar..."),
// indicando duas chamadas de IA separadas para o mesmo texto do usuário,
// ou seja, dois processamentos completos do mesmo webhook.
// Esta camada não depende de nenhum campo de ID — só telefone + texto
// exatos, numa janela curta (15s). Curta o suficiente para não bloquear
// um usuário que realmente manda a mesma frase de novo minutos depois,
// longa o suficiente para cobrir qualquer reenvio realista por timeout.
const _conteudoProcessadoRecente = new Map(); // `${phone}|${text}` -> timestamp de expiração
// Janela aumentada de 15s → 60s: observado na prática um caso de lembrete
// duplicado ("artes do crediário" criado 2x, mesmo título, mesmo horário)
// que a janela de 15s não cobriu — sugere que o reenvio da UazAPI (ou
// alguma instabilidade de rede) demorou mais que 15s pra chegar. 60s ainda
// é curto o suficiente pra não bloquear alguém que genuinamente manda a
// mesma frase de novo um minuto depois, mas cobre reenvios mais lentos.
const DEDUP_CONTEUDO_JANELA_MS = 60 * 1000; // 60 segundos

function chaveConteudo(phone, text) {
  return `${phone}|${text}`;
}

function conteudoJaProcessado(phone, text) {
  if (!text) return false; // mensagens vazias (áudio, contato etc.) não passam por aqui
  const chave = chaveConteudo(phone, text);
  const expiraEm = _conteudoProcessadoRecente.get(chave);
  if (!expiraEm) return false;
  if (Date.now() >= expiraEm) { _conteudoProcessadoRecente.delete(chave); return false; }
  return true;
}

function marcarConteudoProcessado(phone, text) {
  if (!text) return;
  _conteudoProcessadoRecente.set(chaveConteudo(phone, text), Date.now() + DEDUP_CONTEUDO_JANELA_MS);
}

// Limpeza periódica: remove entradas expiradas de AMBOS os caches a cada
// 5 minutos, evitando que cresçam sem limite em uma instância de longa
// duração.
setInterval(() => {
  const agora = Date.now();
  for (const [id, expiraEm] of _messageIdsProcessados) {
    if (agora >= expiraEm) _messageIdsProcessados.delete(id);
  }
  for (const [chave, expiraEm] of _conteudoProcessadoRecente) {
    if (agora >= expiraEm) _conteudoProcessadoRecente.delete(chave);
  }
}, 5 * 60 * 1000);

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
  // ── Prioridade absoluta: citação (swipe-reply) ──
  // Bug corrigido: quando o usuário arrasta pra responder um lembrete
  // FUTURO (ainda não disparado, sent:false — ex: "dar remédio pra filha"
  // marcado pra amanhã) e responde "Feito", a busca por janela de tempo
  // abaixo NÃO encontrava ele (só pega sent:true dos últimos 15min), então
  // o atalho de concluir falhava e a mensagem caía na classificação geral,
  // que interpretava errado (como remarcar). Agora, SE há citação, primeiro
  // procuramos o lembrete pelo título citado entre TODOS os não concluídos
  // do usuário (passado ou futuro, disparado ou não) — só assim o "Feito"
  // via reply funciona pra qualquer lembrete, independente da hora dele.
  if (quotedText) {
    const quotedLower = quotedText.toLowerCase();
    const naoConcluidos = await prisma.reminder.findMany({
      where: { OR: [{ userId, confirmed: false }, { phone, confirmed: false }] },
      orderBy: { scheduledAt: 'desc' }
    });
    const porCitacao = naoConcluidos.find(r => quotedLower.includes(r.message.toLowerCase()));
    if (porCitacao) return porCitacao;
  }

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
    // ── Prioridade 1: pendência de confirmação real (criada no alarme,
    // ver reminders.js) ── Mais confiável que a heurística de janela de
    // tempo abaixo, porque cobre o caso do follow-up de 20min (a resposta
    // pode chegar bem depois do horário exato da dose) e resolve a
    // pendência de verdade — sem isso, ela ficaria presa até expirar
    // sozinha à meia-noite (sem decrementar, por design).
    // ── Suporte a múltiplos remédios pendentes ao mesmo tempo ──
    // Quando dois ou mais remédios batem no mesmo horário (mensagem
    // agrupada, ver reminders.js), pode haver várias pendências abertas
    // simultaneamente. Busca TODAS (não só a mais recente) e tenta
    // identificar qual o usuário quis dizer pelo nome citado na mensagem
    // — evita decrementar o remédio errado quando há ambiguidade.
    const todasPendentesMems = await prisma.memory.findMany({
      where: { userId: user.id, type: 'confirmacao_pendente' },
      orderBy: { createdAt: 'desc' }
    }).catch(() => []);
    const pendentesRemedio = todasPendentesMems
      .map(p => { try { const d = JSON.parse(p.content); return d.tipo === 'remedio_dose' ? { memoryId: p.id, ...d } : null; } catch { return null; } })
      .filter(Boolean);

    if (pendentesRemedio.length === 1) {
      const pendenteRemedio = pendentesRemedio[0];
      const med = await prisma.medication.findUnique({ where: { id: pendenteRemedio.medId } }).catch(() => null);
      if (med) {
        const atualizado = await prisma.medication.update({ where: { id: med.id }, data: { remaining: { decrement: 1 } } });
        await prisma.memory.delete({ where: { id: pendenteRemedio.memoryId } }).catch(() => {});
        await sendMessage(phone, `✅ Ótimo! Marquei que você tomou o *${med.name}*. Restam ${atualizado.remaining} doses. 💊`);
        return true;
      }
    } else if (pendentesRemedio.length > 1) {
      // ── Prioridade pra citação (swipe-reply) ──
      // Bug corrigido: antes só olhava o texto digitado ("Tomado" não
      // menciona nome nenhum) — ignorava completamente qual mensagem
      // específica o usuário respondeu, podia confirmar o remédio errado
      // mesmo quando a citação deixava claro qual era. Agora tenta achar
      // o nome do remédio primeiro na CITAÇÃO, e só se não achar lá, tenta
      // no texto digitado (cobre o caso de "tomei pressão" sem citação).
      const textoLower = textLower.toLowerCase();
      const quotedLowerMed = (quotedText || '').toLowerCase();
      const match = pendentesRemedio.find(p => {
        const palavrasNome = p.medNome.toLowerCase().split(' ').filter(w => w.length > 3);
        return palavrasNome.some(w => quotedLowerMed.includes(w));
      }) || pendentesRemedio.find(p => {
        const palavrasNome = p.medNome.toLowerCase().split(' ').filter(w => w.length > 3);
        return palavrasNome.some(w => textoLower.includes(w));
      });
      if (match) {
        const med = await prisma.medication.findUnique({ where: { id: match.medId } }).catch(() => null);
        if (med) {
          const atualizado = await prisma.medication.update({ where: { id: med.id }, data: { remaining: { decrement: 1 } } });
          await prisma.memory.delete({ where: { id: match.memoryId } }).catch(() => {});
          await sendMessage(phone, `✅ Ótimo! Marquei que você tomou o *${med.name}*. Restam ${atualizado.remaining} doses. 💊`);
          return true;
        }
      } else {
        // Ambíguo — não decrementa nada, pede pra especificar em vez de
        // arriscar marcar o remédio errado.
        const nomes = pendentesRemedio.map(p => `• ${p.medNome}`).join('\n');
        await sendMessage(phone, `Você tem mais de um remédio pendente agora:\n${nomes}\n\nQual deles você tomou? Me diz o nome 😊`);
        return true;
      }
    }

    // ── Fallback: heurística de janela de tempo ── Cobre o caso de o
    // usuário avisar "tomei" proativamente, sem ter uma pendência ativa
    // (ex: tomou por conta própria sem esperar o alarme).
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

    // ── Deduplicação por messageId ──
    // A UazAPI (como a maioria das integrações de WhatsApp) pode reenviar
    // o mesmo webhook em caso de timeout/retry de rede, especialmente se
    // o servidor demorar a responder. Sem essa proteção, a mesma mensagem
    // do usuário pode ser processada 2-3x, criando lembretes/ações
    // duplicadas (bug real observado: "me lembra às 9 de comprar remédio"
    // virou 3 lembretes idênticos no banco).
    //
    // ── Camada extra: persistência no banco (sobrevive a restart) ──
    // Bug corrigido: o cache em memória (_messageIdsProcessados) se perde
    // toda vez que o processo reinicia (cada deploy). Se a UazAPI reenviar
    // o mesmo webhook bem no instante de um restart, o processo novo não
    // tem mais nenhum registro de já ter processado aquela mensagem — e
    // processa de novo do zero, criando lembrete duplicado. Isso ficou
    // mais visível num dia com muitos deploys em sequência. Agora, além do
    // cache rápido em memória (cobre o caso comum, sem custo de DB),
    // também verificamos/registramos no banco — mais lento, mas sobrevive
    // a qualquer restart.
    const messageId = body.message?.id || body.message?.messageid || body.message?.messageId || body.message?.key?.id;
    if (messageId) {
      if (_messageIdsProcessados.has(messageId)) {
        console.log(`[Webhook] messageId duplicado ignorado (cache memória): ${messageId}`);
        return res.json({ ok: true });
      }
      const jaProcessadoDB = await prisma.memory.findFirst({
        where: { type: 'webhook_msgid', content: messageId }
      }).catch(() => null);
      if (jaProcessadoDB) {
        console.log(`[Webhook] messageId duplicado ignorado (banco, sobreviveu a restart): ${messageId}`);
        marcarMessageIdProcessado(messageId); // também marca em memória pra próxima checagem ser rápida
        return res.json({ ok: true });
      }
      marcarMessageIdProcessado(messageId);
      // Fire-and-forget é seguro aqui — não é crítico que esse registro
      // termine antes da resposta; o pior caso de uma corrida rara é o
      // mesmo cenário de antes (proteção só pelo cache em memória).
      prisma.memory.create({ data: { userId: 'system', type: 'webhook_msgid', content: messageId } }).catch(() => {});
    } else {
      // Sem messageId identificável — loga pra eventualmente descobrirmos
      // o campo certo, já que isso significa que a 1ª camada de dedup não
      // está protegendo essa mensagem (cai só na 2ª camada, por conteúdo).
      console.log('[Webhook] messageId não encontrado neste payload — chaves disponíveis:', Object.keys(body.message || {}).join(', '));
    }

    const phone = (body.message?.sender_pn || '').replace('@s.whatsapp.net', '').replace(/\D/g, '');
    if (!phone) {
      console.log('⚠️ Webhook sem phone:', JSON.stringify(body).slice(0, 200));
      return res.json({ ok: true });
    }

    const text = body.message?.text || body.message?.content?.text || '';

    // ── Deduplicação por conteúdo (2ª camada, ver comentário acima) ──
    // Roda independente de ter encontrado messageId ou não — cobre o caso
    // de um reenvio vir com um messageId DIFERENTE do original (não deveria
    // acontecer, mas não temos garantia formal da UazAPI sobre isso) e
    // também o caso de não ter messageId nenhum.
    if (text && conteudoJaProcessado(phone, text)) {
      console.log(`[Webhook] conteúdo duplicado ignorado (2ª camada): ${phone} — "${text.slice(0, 60)}"`);
      return res.json({ ok: true });
    }
    if (text) marcarConteudoProcessado(phone, text);

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
    await handleMessage(phone, texto);
  } catch (e) {
    console.error('[Áudio] Erro:', e.message);
    await sendMessage(phone, 'Tive um problema com o áudio 😕 Pode digitar?');
  }
}

module.exports = router;
