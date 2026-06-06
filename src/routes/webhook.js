const express = require('express');
const router = express.Router();
const { handleMessage } = require('../services/handler');
const { sendMessage } = require('../services/whatsapp');

router.post('/', async (req, res) => {
  try {
    const body = req.body;

    // Ignora mensagens enviadas pela própria Clara
    if (body.message?.fromMe === true) return res.json({ ok: true });
    if (body.message?.wasSentByApi === true) return res.json({ ok: true });

    // Ignora grupos
    if (body.message?.isGroup === true) return res.json({ ok: true });

    // Extrai phone no formato UazAPI pago
    const phone = body.message?.sender_pn?.replace('@s.whatsapp.net', '')
      || body.chat?.phone?.replace(/\D/g, '');

    if (!phone) {
      console.log('⚠️ Webhook sem phone:', JSON.stringify(body).slice(0, 300));
      return res.json({ ok: true });
    }

    // Extrai texto no formato UazAPI pago
    const text = body.message?.content?.text
      || body.message?.text
      || '';

    console.log(`📨 WEBHOOK UazAPI: ${phone} — texto: ${text.slice(0, 80)}`);

    // TEXTO
    if (text) {
      handleMessage(phone, text).catch(console.error);
