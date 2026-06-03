const express = require('express');
const router = express.Router();
const { handleMessage } = require('../services/handler');
const { sendMessage } = require('../services/whatsapp');

router.post('/receive', async (req, res) => {
  try {
    const body = req.body;

    // Ignora mensagens enviadas pela própria Clara
    if (body.fromMe) return res.json({ ok: true });

    // Ignora mensagens de teste do Z-API trial
    const textoMensagem = body.text?.message || '';
    if (
      textoMensagem.includes('MENSAGEM DE TESTE') ||
      textoMensagem.includes('CONTA EM TRIAL') ||
      textoMensagem.includes('FAVOR DESCONSIDERAR')
    ) {
      console.log('⚠️ Mensagem de teste Z-API ignorada');
      return res.json({ ok: true });
    }

    const phone = body.phone;
    console.log(`📨 WEBHOOK: ${phone} — tipo: ${body.type}`);

    // TEXTO
    if (body.text?.message) {
      const text = body.text.message;
      console.log(`📩 ${phone}: ${text}`);
      handleMessage(phone, text).catch(console.error);
      return res.json({ ok: true });
    }

    // ÁUDIO
    if (body.audio?.audioUrl) {
      console.log(`🎤 Áudio recebido de ${phone} — não suportado`);
      sendMessage(phone, 'Por enquanto não consigo ouvir áudios, mas você pode digitar que eu respondo na hora! 😊').catch(console.error);
      return res.json({ ok: true });
    }

    // LOCALIZAÇÃO
    if (body.location) {
      console.log(`📍 Localização recebida de ${phone}`);
      handleMessage(phone, null, {
        latitude: body.location.latitude,
        longitude: body.location.longitude,
      }).catch(console.error);
      return res.json({ ok: true });
    }

    // IMAGEM, VÍDEO, DOCUMENTO, STICKER
    if (body.image || body.video || body.document || body.sticker) {
      sendMessage(phone, 'Por enquanto não consigo ver fotos, vídeos ou arquivos — mas se escrever pra mim eu ajudo! 😊').catch(console.error);
      return res.json({ ok: true });
    }

    console.log('⚠️ Payload não reconhecido:', Object.keys(body));
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
