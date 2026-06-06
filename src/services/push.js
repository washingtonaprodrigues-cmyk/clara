// src/services/push.js
// Envio de Web Push Notifications (VAPID)

const https = require('https');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:clara@seuapp.com';

// ── JWT para VAPID ──
function base64urlEncode(buf) {
  return buf.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function buildVapidJWT(audience) {
  const header = base64urlEncode(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = base64urlEncode(Buffer.from(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 43200,
    sub: VAPID_SUBJECT,
  })));
  const sigInput = `${header}.${payload}`;
  const sign = crypto.createSign('SHA256');
  sign.update(sigInput);
  // Converte chave private base64url → DER para node crypto
  const privBuf = Buffer.from(VAPID_PRIVATE, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(privBuf);
  const privPem = `-----BEGIN EC PRIVATE KEY-----\n${Buffer.concat([
    Buffer.from('3077020101042', 'hex').slice(0,1), // placeholder – usa webcrypto
  ]).toString('base64')}\n-----END EC PRIVATE KEY-----`;
  // Usa abordagem direta com subtle crypto via raw sign
  const sig = crypto.sign('SHA256', Buffer.from(sigInput), {
    key: ecdh.getPrivateKey(),
    dsaEncoding: 'ieee-p1363',
    format: 'jwk',
    type: 'pkcs8',
  });
  return `${sigInput}.${base64urlEncode(sig)}`;
}

// Implementação simplificada usando web-push como dependência do projeto
async function sendPush(subscription, payload) {
  try {
    const webpush = require('web-push');
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return true;
  } catch (e) {
    console.error('Erro push:', e.message);
    return false;
  }
}

// ── Salvar subscription ──
async function saveSubscription(userId, subscription) {
  // Salva na tabela Memory com type 'push_sub'
  // Remove subs antigas do mesmo userId
  await prisma.memory.deleteMany({
    where: { userId, type: 'push_sub' }
  });
  await prisma.memory.create({
    data: {
      userId,
      type: 'push_sub',
      content: JSON.stringify(subscription),
    }
  });
}

// ── Buscar subscriptions de um user ──
async function getSubscriptions(userId) {
  const mems = await prisma.memory.findMany({
    where: { userId, type: 'push_sub' }
  });
  return mems.map(m => {
    try { return JSON.parse(m.content); } catch { return null; }
  }).filter(Boolean);
}

// ── Notificar usuário ──
async function notifyUser(userId, title, body, url = '/dashboard') {
  const subs = await getSubscriptions(userId);
  for (const sub of subs) {
    await sendPush(sub, { title, body, url });
  }
}

module.exports = { saveSubscription, getSubscriptions, notifyUser };
