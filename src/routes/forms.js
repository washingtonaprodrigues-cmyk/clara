const express = require('express');
const router = express.Router();
const memory = require('../services/memory');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// sendMessage/sendButtons com fallback direto via axios — mesmo padrão
// usado em handler.js e reminders.js, evita "sendButtons is not a function"
// quando require('../services/whatsapp') falha ao carregar.
async function sendMessage(phone, msg, delay) {
  try {
    const w = require('../services/whatsapp');
    if (w && typeof w.sendMessage === 'function') return w.sendMessage(phone, msg, delay);
  } catch (e) {
    console.error('[Forms] Erro ao carregar whatsapp.js:', e.message);
  }
  const axios = require('axios');
  const BASE_URL = process.env.UAZAPI_URL || 'https://claravirtual.uazapi.com';
  const TOKEN = process.env.UAZAPI_TOKEN;
  console.log(`[Forms/Fallback] Enviando direto para ${phone}: ${String(msg).slice(0,60)}`);
  return axios.post(`${BASE_URL}/send/text`,
    { number: phone, text: msg, delay: delay || 800 },
    { headers: { token: TOKEN, 'Content-Type': 'application/json' }, timeout: 30000 }
  );
}

async function sendButtons(phone, msg, buttons) {
  try {
    const w = require('../services/whatsapp');
    if (w && typeof w.sendButtons === 'function') return w.sendButtons(phone, msg, buttons);
  } catch (e) {
    console.error('[Forms] Erro ao carregar whatsapp.js (sendButtons):', e.message);
  }
  return sendMessage(phone, msg);
}

function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function dateBRT() {
  const d = nowBRT();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function criarDataBRT(dataStr, horaStr) {
  const [ano, mes, dia] = dataStr.split('-').map(Number);
  const [hora, min] = horaStr.split(':').map(Number);
  const isoStr = `${ano}-${String(mes).padStart(2,'0')}-${String(dia).padStart(2,'0')}T${String(hora).padStart(2,'0')}:${String(min).padStart(2,'0')}:00-03:00`;
  return new Date(isoStr);
}

const CSS_BASE = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
  .card { background: white; border-radius: 16px; padding: 24px; width: 100%; max-width: 420px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
  .header { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
  .header-icon { font-size: 32px; }
  .header h1 { font-size: 20px; font-weight: 700; color: #1a1a2e; }
  .header p { font-size: 13px; color: #888; margin-top: 2px; }
  .field { margin-bottom: 16px; }
  label { display: block; font-size: 13px; font-weight: 600; color: #444; margin-bottom: 6px; }
  input, select, textarea { width: 100%; padding: 12px 14px; border: 1.5px solid #e0e0e0; border-radius: 10px; font-size: 15px; color: #1a1a2e; background: #fafafa; outline: none; transition: border 0.2s; }
  textarea { resize: none; height: 80px; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .success { display: none; text-align: center; padding: 32px 0; }
  .success-icon { font-size: 56px; margin-bottom: 12px; }
  .success h2 { font-size: 20px; font-weight: 700; color: #1a1a2e; margin-bottom: 8px; }
  .success p { font-size: 14px; color: #888; }
  .tip { font-size: 12px; color: #aaa; margin-top: 4px; }
  .resumo { border-radius: 10px; padding: 14px; margin-bottom: 16px; display: none; font-size: 13px; line-height: 1.6; }
`;

// ====================== LISTAGEM: LEMBRETES ======================
router.get('/lembretes/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const user = await memory.getOrCreateUser(phone);
    const lembretes = await prisma.reminder.findMany({
      where: { userId: user.id },
      orderBy: { scheduledAt: 'asc' },
      take: 100,
    });
    res.json(lembretes);
  } catch (e) {
    console.error('Erro GET lembretes:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== LISTAGEM: REMÉDIOS ======================
router.get('/remedios/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const user = await memory.getOrCreateUser(phone);
    const medicamentos = await prisma.medication.findMany({
      where: { userId: user.id, active: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    // ── Pendências de confirmação reais (ver reminders.js/MEDICAMENTOS) ──
    // Antes, o Dashboard inferia "tomado" só comparando o horário atual
    // com a lista `times` do remédio — se já tinha passado o último
    // horário do dia, mostrava "Todas as doses tomadas hoje" mesmo sem
    // nenhuma confirmação real. Agora expomos quais medicamentos têm uma
    // pendência de confirmação genuinamente aberta, pro frontend distinguir
    // "realmente confirmado" de "só já passou da hora".
    const pendentes = await prisma.memory.findMany({ where: { userId: user.id, type: 'confirmacao_pendente' } });
    const medIdsPendentes = new Set();
    for (const p of pendentes) {
      try {
        const dados = JSON.parse(p.content);
        if (dados.tipo === 'remedio_dose') medIdsPendentes.add(dados.medId);
      } catch {}
    }
    const enriquecido = medicamentos.map(m => ({ ...m, aguardandoConfirmacao: medIdsPendentes.has(m.id) }));
    res.json(enriquecido);
  } catch (e) {
    console.error('Erro GET remedios:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== LISTAGEM: GASTOS ======================
router.get('/gastos/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const user = await memory.getOrCreateUser(phone);
    const inicioMes = new Date(nowBRT().getFullYear(), nowBRT().getMonth(), 1);
    const gastos = await prisma.expense.findMany({
      where: { userId: user.id, createdAt: { gte: inicioMes } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json(gastos);
  } catch (e) {
    console.error('Erro GET gastos:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== REGISTRAR GASTO ======================
router.post('/gasto/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const { valor, categoria, descricao, data } = req.body;
    const user = await memory.getOrCreateUser(phone);
    const createdAt = data ? new Date(data + 'T12:00:00-03:00') : undefined;
    await memory.saveExpense(user.id, { valor, categoria, descricao, createdAt });
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro POST gasto:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== DELETAR GASTO ======================
router.delete('/gasto/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.expense.delete({ where: { id } });
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro DELETE gasto:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== PONTO: GET ======================
router.get('/pontos/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const user = await memory.getOrCreateUser(phone);
    const inicioMes = new Date();
    inicioMes.setDate(1); inicioMes.setHours(0,0,0,0);
    const pontos = await prisma.workLog.findMany({
      where: { userId: user.id, createdAt: { gte: inicioMes } },
      orderBy: { createdAt: 'asc' },
    });
    res.json(pontos);
  } catch (e) {
    console.error('Erro GET pontos:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== PONTO: POST (registro) ======================
router.post('/ponto/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const user = await memory.getOrCreateUser(phone);
    const body = req.body;

    function toTimestamp(horaStr) {
      if (!horaStr) return null;
      const [h, m] = horaStr.split(':').map(Number);
      const isoStr = `${dateBRT()}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00-03:00`;
      return new Date(isoStr);
    }

    const hoje = dateBRT();
    const tipos = ['entrada', 'saida_almoco', 'volta_almoco', 'saida'];

    for (const tipo of tipos) {
      if (!body[tipo]) continue;
      const timestamp = toTimestamp(body[tipo]);
      const existing = await prisma.workLog.findFirst({ where: { userId: user.id, type: tipo, date: hoje } });
      if (existing) {
        await prisma.workLog.update({ where: { id: existing.id }, data: { timestamp } });
      } else {
        await prisma.workLog.create({ data: { userId: user.id, type: tipo, timestamp, date: hoje } });
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('Erro POST ponto:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== PONTO CONFIG: GET ======================
router.get('/ponto-config/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const user = await memory.getOrCreateUser(phone);
    const mems = await memory.getRecentMemories(user.id, 20);
    const conf = mems.find(m => m.type === 'ponto_config');
    if (conf) {
      try { return res.json(JSON.parse(conf.content)); } catch {}
    }
    res.json({ entrada: '08:00', saida: '17:00', almoco: 60, jornada: 480 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====================== PONTO CONFIG: POST ======================
router.post('/ponto-config/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const user = await memory.getOrCreateUser(phone);
    const { entrada, saida, almoco, jornada } = req.body;

    await prisma.user.update({
      where: { id: user.id },
      data: { jornadaMinutos: jornada || 480 }
    });

    await memory.saveMemory(user.id, 'ponto_config', JSON.stringify({ entrada, saida, almoco, jornada }));
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro POST ponto-config:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== COFRE: GET ======================
router.get('/cofre/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const user = await memory.getOrCreateUser(phone);
    const itens = await prisma.memory.findMany({
      where: { userId: user.id, type: 'cofre' },
      orderBy: { createdAt: 'desc' },
    });
    res.json(itens);
  } catch (e) {
    console.error('Erro GET cofre:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== COFRE: POST ======================
router.post('/cofre/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const { conteudo } = req.body;
    const user = await memory.getOrCreateUser(phone);
    const item = await prisma.memory.create({
      data: { userId: user.id, type: 'cofre', content: conteudo }
    });
    res.json({ ok: true, id: item.id });
  } catch (e) {
    console.error('Erro POST cofre:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== COFRE: DELETE ======================
router.delete('/cofre/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.memory.delete({ where: { id } });
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro DELETE cofre:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== LISTAGEM: MEMÓRIAS ======================
router.get('/memorias/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const user = await memory.getOrCreateUser(phone);
    const mems = await memory.getRecentMemories(user.id, 50);
    res.json(mems);
  } catch (e) {
    console.error('Erro GET memorias:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== REMÉDIO TOMADO ======================
router.post('/remedio-tomado/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const med = await prisma.medication.update({
      where: { id },
      data: { remaining: { decrement: 1 } }
    });
    // ── Limpa a pendência de confirmação criada pelo alarme (reminders.js) ──
    // Bug corrigido: confirmar pelo Dashboard decrementava normalmente,
    // mas não cancelava a pendência de confirmação aberta pelo alarme —
    // isso significava que o follow-up de 20 minutos ("oi, voltei...")
    // ainda disparava no WhatsApp mesmo já tendo confirmado por aqui,
    // parecendo que a Clara "esqueceu" que você já tinha confirmado.
    try {
      const pendente = await prisma.memory.findFirst({
        where: { userId: med.userId, type: 'confirmacao_pendente' },
        orderBy: { createdAt: 'desc' }
      });
      if (pendente) {
        const dados = JSON.parse(pendente.content);
        if (dados.tipo === 'remedio_dose' && dados.medId === id) {
          await prisma.memory.delete({ where: { id: pendente.id } });
        }
      }
    } catch (e) {
      console.error('[remedio-tomado] Erro ao limpar pendência:', e.message);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro remedio-tomado:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== REMÉDIO: AJUSTAR ESTOQUE (doses restantes) ======================
// Permite corrigir manualmente o número de doses restantes — útil quando
// o usuário tomou mais de uma dose no dia, errou a contagem, ou repôs o
// estoque (comprou uma caixa nova).
router.put('/remedio-estoque/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { remaining } = req.body;
    const remainingNum = parseInt(remaining);
    if (isNaN(remainingNum) || remainingNum < 0) {
      return res.status(400).json({ error: 'Quantidade inválida' });
    }
    const med = await prisma.medication.update({
      where: { id },
      data: { remaining: remainingNum }
    });
    res.json({ ok: true, remaining: med.remaining });
  } catch (e) {
    console.error('Erro ajustar estoque remedio:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== REMÉDIO: AJUSTAR HORÁRIOS ======================
// Permite redefinir a lista completa de horários das doses — útil quando
// a rotina muda (ex: passou a tomar mais cedo) ou foi cadastrado errado.
router.put('/remedio-horarios/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { horarios } = req.body;
    if (!Array.isArray(horarios) || !horarios.length) {
      return res.status(400).json({ error: 'Lista de horários inválida' });
    }
    const formatoValido = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!horarios.every(h => formatoValido.test(h))) {
      return res.status(400).json({ error: 'Formato de horário inválido (use HH:MM)' });
    }
    const horariosOrdenados = [...horarios].sort();
    const med = await prisma.medication.update({
      where: { id },
      data: { times: JSON.stringify(horariosOrdenados), frequency: horariosOrdenados.length }
    });
    res.json({ ok: true, times: med.times });
  } catch (e) {
    console.error('Erro ajustar horarios remedio:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== LIMPAR CONVERSA ======================
router.post('/conversa-limpar/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const user = await memory.getOrCreateUser(phone);
    await prisma.memory.deleteMany({
      where: { userId: user.id, type: 'conversa' }
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro limpar conversa:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== CONCLUIR LEMBRETE ======================
router.post('/lembrete-concluir/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.reminder.update({
      where: { id },
      data: { sent: true, confirmed: true }
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro concluir lembrete:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== PREFERÊNCIA: GET ======================
router.get('/preferencia/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const user = await memory.getOrCreateUser(phone);
    const pref = await memory.getUserPreference(user.id);
    res.json(pref);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====================== MEMÓRIA DO RELACIONAMENTO (debug) ======================
router.get('/relacionamento/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const user = await memory.getOrCreateUser(phone);
    const rel = await prisma.memory.findFirst({
      where: { userId: user.id, type: 'relationship_summary' },
      orderBy: { createdAt: 'desc' }
    });
    res.json({
      content: rel?.content || null,
      createdAt: rel?.createdAt || null,
      updatedAt: rel?.updatedAt || null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====================== PREFERÊNCIA: POST ======================
router.post('/preferencia/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const { nome, tom, saldo } = req.body;
    const user = await memory.getOrCreateUser(phone);
    const saldoNum = (saldo !== undefined && saldo !== null && saldo !== '') ? parseFloat(saldo) : null;

    const prefsAntigas = await memory.getUserPreference(user.id).catch(() => null);
    const tomMudou = tom && prefsAntigas?.tom !== tom;

    await memory.saveUserPreference(user.id, nome || null, tom || null, saldoNum);

    if (tomMudou) {
      const NOMES_TOM = {
        clara_sendo_clara: 'Clara Sendo Clara 🙎🏻‍♀️',
        carinhoso: 'Simpática 🥰',
        direto: 'Direta 🎯',
        divertido: 'Divertida 🎉',
        sarcastico: 'Sem Filtro 🔥',
      };
      const nomeTom = NOMES_TOM[tom] || tom;
      sendMessage(phone, `💜 Modo de personalidade atualizado para *${nomeTom}*!\n\nÉ assim que vou conversar com você a partir de agora.`).catch(() => {});
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====================== LEMBRETE: GET (form) ======================
router.get('/lembrete/:phone', (req, res) => {
  const { phone } = req.params;
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dataHoje = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  const horaAgora = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Criar Lembrete</title>
  <style>
    ${CSS_BASE}
    input:focus, textarea:focus { border-color: #7c3aed; background: white; }
    .btn { width: 100%; padding: 14px; background: linear-gradient(135deg, #7c3aed, #a855f7); color: white; border: none; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 8px; }
    .btn:disabled { opacity: 0.6; }
  </style>
</head>
<body>
<div class="card">
  <div id="form-area">
    <div class="header">
      <div class="header-icon">⏰</div>
      <div><h1>Criar Lembrete</h1><p>Vou te avisar na hora certa!</p></div>
    </div>
    <div class="field">
      <label>O que você quer lembrar?</label>
      <textarea id="titulo" placeholder="Ex: Buscar minha filha na escola, pagar a conta de luz..."></textarea>
    </div>
    <div class="row">
      <div class="field">
        <label>Data</label>
        <input type="date" id="data" value="${dataHoje}" />
      </div>
      <div class="field">
        <label>Horário</label>
        <input type="time" id="hora" value="${horaAgora}" />
      </div>
    </div>
    <button class="btn" onclick="salvar()">Criar lembrete</button>
  </div>
  <div class="success" id="success-area">
    <div class="success-icon">🎉</div>
    <h2>Lembrete criado!</h2>
    <p>Vou te avisar na hora certinha 😊</p>
  </div>
</div>
<script>
  async function salvar() {
    const titulo = document.getElementById('titulo').value.trim();
    const data = document.getElementById('data').value;
    const hora = document.getElementById('hora').value;
    if (!titulo) { alert('Descreva o lembrete!'); return; }
    if (!hora) { alert('Informe o horário!'); return; }
    const btn = document.querySelector('.btn');
    btn.textContent = 'Salvando...'; btn.disabled = true;
    try {
      const res = await fetch('/forms/lembrete/${phone}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ titulo, data, hora })
      });
      if (res.ok) {
        document.getElementById('form-area').style.display = 'none';
        document.getElementById('success-area').style.display = 'block';
        setTimeout(() => window.close(), 2500);
      } else {
        alert('Erro ao salvar. Tente novamente.');
        btn.textContent = 'Criar lembrete'; btn.disabled = false;
      }
    } catch(e) {
      alert('Erro de conexão.');
      btn.textContent = 'Criar lembrete'; btn.disabled = false;
    }
  }
</script>
</body></html>`);
});

// ====================== LEMBRETE: POST ======================
router.post('/lembrete/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const { titulo, data, hora } = req.body;
    const user = await memory.getOrCreateUser(phone);
    const scheduledAt = criarDataBRT(data || dateBRT(), hora);

    await prisma.reminder.create({
      data: { userId: user.id, phone, message: titulo, scheduledAt }
    });

    await memory.saveMemory(user.id, 'tarefa', titulo, { data, hora });

    res.json({ ok: true });

    try {
      const dataFormatada = scheduledAt.toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short'
      });
      await sendButtons(phone,
        `✅ Lembrete criado!\n\n📌 ${titulo}\n🕒 ${dataFormatada}\n\nVou te avisar no horário certinho.`,
        [{ id: 'ver_lembretes', label: '📋 Ver lembretes' }, { id: 'menu', label: '🏠 Menu' }]
      );
    } catch(wErr) {
      console.error('[lembrete] Erro ao notificar WhatsApp:', wErr.message);
    }
  } catch (e) {
    console.error('Erro form lembrete:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== LEMBRETE: DELETE ======================
router.delete('/lembrete/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.reminder.delete({ where: { id } });
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro DELETE lembrete:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== LEMBRETE: REMARCAR ======================
router.put('/lembrete-remarcar/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, hora } = req.body;
    if (!data || !hora) return res.status(400).json({ error: 'Data e hora obrigatórios' });

    const scheduledAt = criarDataBRT(data, hora);

    const lembrete = await prisma.reminder.findUnique({ where: { id } });
    if (!lembrete) return res.status(404).json({ error: 'Lembrete não encontrado' });

    await prisma.reminder.update({
      where: { id },
      data: { scheduledAt, sent: false, confirmed: false }
    });

    res.json({ ok: true });

    try {
      const dataFormatada = scheduledAt.toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short'
      });
      await sendButtons(lembrete.phone,
        `✅ Lembrete remarcado!\n\n📌 ${lembrete.message}\n🕒 ${dataFormatada}\n\nVou te avisar no horário certinho.`,
        [{ id: 'ver_lembretes', label: '📋 Ver lembretes' }, { id: 'menu', label: '🏠 Menu' }]
      );
    } catch (wErr) {
      console.error('[lembrete-remarcar] Erro ao notificar WhatsApp:', wErr.message);
    }
  } catch (e) {
    console.error('Erro remarcar lembrete:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== REMÉDIO: GET (form) ======================
router.get('/remedio/:phone', (req, res) => {
  const { phone } = req.params;
  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const horaAgora = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cadastrar Remédio</title>
  <style>
    ${CSS_BASE}
    input:focus, select:focus { border-color: #059669; background: white; }
    .btn { width: 100%; padding: 14px; background: linear-gradient(135deg, #059669, #10b981); color: white; border: none; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 8px; }
    .btn:disabled { opacity: 0.6; }
    .resumo { background: #f0fdf4; border: 1.5px solid #bbf7d0; color: #166534; }
  </style>
</head>
<body>
<div class="card">
  <div id="form-area">
    <div class="header">
      <div class="header-icon">💊</div>
      <div><h1>Cadastrar Remédio</h1><p>Vou te lembrar em todos os horários!</p></div>
    </div>
    <div class="field">
      <label>Nome do medicamento</label>
      <input type="text" id="nome" placeholder="Ex: Losartana, Vitamina C..." oninput="atualizar()" />
    </div>
    <div class="row">
      <div class="field">
        <label>Dose</label>
        <input type="text" id="dose" placeholder="Ex: 1 comp, 5ml" />
      </div>
      <div class="field">
        <label>A cada quantas horas</label>
        <select id="intervalo" onchange="atualizar()">
          <option value="4">4 horas</option>
          <option value="6">6 horas</option>
          <option value="8">8 horas</option>
          <option value="12" selected>12 horas</option>
          <option value="24">24h (1x/dia)</option>
        </select>
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label>Por quantos dias</label>
        <input type="number" id="dias" placeholder="Ex: 7" min="1" max="365" oninput="atualizar()" />
      </div>
      <div class="field">
        <label>Primeira dose</label>
        <input type="time" id="horario_inicio" value="${horaAgora}" oninput="atualizar()" />
      </div>
    </div>
    <div class="resumo" id="resumo"><span id="resumo-texto"></span></div>
    <button class="btn" onclick="salvar()">Cadastrar remédio</button>
  </div>
  <div class="success" id="success-area">
    <div class="success-icon">✅</div>
    <h2>Remédio cadastrado!</h2>
    <p>Vou te lembrar em todos os horários 😊</p>
  </div>
</div>
<script>
  const pad = n => String(n).padStart(2, '0');
  function atualizar() {
    const nome = document.getElementById('nome').value.trim();
    const intervalo = parseInt(document.getElementById('intervalo').value);
    const dias = parseInt(document.getElementById('dias').value) || 0;
    const hi = document.getElementById('horario_inicio').value;
    if (!nome || !hi) { document.getElementById('resumo').style.display = 'none'; return; }
    const freqDia = Math.round(24 / intervalo);
    const [h, m] = hi.split(':').map(Number);
    const horarios = [];
    for (let i = 0; i < freqDia; i++) {
      horarios.push(pad((h + i * intervalo) % 24) + ':' + pad(m));
    }
    const termina = new Date();
    if (dias > 0) termina.setDate(termina.getDate() + dias);
    document.getElementById('resumo-texto').innerHTML =
      '💊 ' + nome + ' — a cada ' + intervalo + 'h<br>' +
      '⏰ ' + horarios.join(', ') + '<br>' +
      (dias > 0 ? '📅 ' + dias + ' dias · ' + (dias * freqDia) + ' doses · até ' + termina.toLocaleDateString('pt-BR') : '');
    document.getElementById('resumo').style.display = 'block';
  }
  async function salvar() {
    const nome = document.getElementById('nome').value.trim();
    const dose = document.getElementById('dose').value.trim();
    const intervalo = parseInt(document.getElementById('intervalo').value);
    const dias = parseInt(document.getElementById('dias').value) || 0;
    const horarioInicio = document.getElementById('horario_inicio').value;
    if (!nome) { alert('Informe o nome do medicamento!'); return; }
    if (!horarioInicio) { alert('Informe o horário da primeira dose!'); return; }
    const btn = document.querySelector('.btn');
    btn.textContent = 'Salvando...'; btn.disabled = true;
    try {
      const res = await fetch('/forms/remedio/${phone}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome, dose, intervalo, dias, horarioInicio })
      });
      if (res.ok) {
        document.getElementById('form-area').style.display = 'none';
        document.getElementById('success-area').style.display = 'block';
        setTimeout(() => window.close(), 2500);
      } else {
        alert('Erro ao salvar. Tente novamente.');
        btn.textContent = 'Cadastrar remédio'; btn.disabled = false;
      }
    } catch(e) {
      alert('Erro de conexão.');
      btn.textContent = 'Cadastrar remédio'; btn.disabled = false;
    }
  }
</script>
</body></html>`);
});

// ====================== REMÉDIO: POST ======================
router.post('/remedio/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const { nome, dose, intervalo, dias, horarioInicio } = req.body;
    const user = await memory.getOrCreateUser(phone);

    const freqDia = Math.round(24 / intervalo);
    const totalDoses = dias > 0 ? dias * freqDia : 30;
    const pad = n => String(n).padStart(2, '0');
    const [h, m] = horarioInicio.split(':').map(Number);
    const horarios = [];
    for (let i = 0; i < freqDia; i++) {
      horarios.push(pad((h + i * intervalo) % 24) + ':' + pad(m));
    }

    await memory.saveMedication(user.id, { nome, quantidade: totalDoses, frequencia: freqDia, horarios });

    const termina = new Date();
    if (dias > 0) termina.setDate(termina.getDate() + dias);

    res.json({ ok: true });

    try {
      await sendButtons(phone,
        `✅ Remédio anotado!\n\n💊 ${nome}\n🕒 ${horarios.join(', ')}\n📅 ${dias > 0 ? dias + ' dias · termina ' + termina.toLocaleDateString('pt-BR') : 'uso contínuo'}\n\nVou te lembrar nos horários certinhos.`,
        [{ id: 'ver_medicamentos', label: '💊 Ver remédios' }, { id: 'menu', label: '🏠 Menu' }]
      );
    } catch (wErr) {
      console.error('[remedio] Erro ao notificar WhatsApp:', wErr.message);
    }
  } catch (e) {
    console.error('Erro form remedio:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== REMÉDIO: DELETE ======================
router.delete('/remedio/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.medication.update({ where: { id }, data: { active: false } });
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro DELETE remedio:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== PONTO: GET (form) ======================
router.get('/ponto/:phone', (req, res) => {
  const { phone } = req.params;
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Registrar Ponto</title>
  <style>
    ${CSS_BASE}
    input:focus { border-color: #2563eb; background: white; }
    .btn { width: 100%; padding: 14px; background: linear-gradient(135deg, #2563eb, #3b82f6); color: white; border: none; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 8px; }
    .btn:disabled { opacity: 0.6; }
  </style>
</head>
<body>
<div class="card">
  <div id="form-area">
    <div class="header">
      <div class="header-icon">📍</div>
      <div><h1>Registrar Ponto</h1><p>Preencha os horários do seu dia</p></div>
    </div>
    <div class="row">
      <div class="field"><label>🟢 Entrada</label><input type="time" id="entrada" /></div>
      <div class="field"><label>🍽️ Saída almoço</label><input type="time" id="saida_almoco" /></div>
    </div>
    <div class="row">
      <div class="field"><label>🔄 Volta almoço</label><input type="time" id="volta_almoco" /></div>
      <div class="field"><label>🔴 Saída</label><input type="time" id="saida" /></div>
    </div>
    <p class="tip" style="margin-bottom:16px">Preencha apenas os horários que já aconteceram</p>
    <button class="btn" onclick="salvar()">Registrar ponto</button>
  </div>
  <div class="success" id="success-area">
    <div class="success-icon">✅</div>
    <h2>Ponto registrado!</h2>
    <p>Resumo enviado no WhatsApp 😊</p>
  </div>
</div>
<script>
  async function salvar() {
    const entrada = document.getElementById('entrada').value;
    if (!entrada) { alert('Informe o horário de entrada!'); return; }
    const btn = document.querySelector('.btn');
    btn.textContent = 'Salvando...'; btn.disabled = true;
    try {
      const res = await fetch('/forms/ponto/${phone}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entrada,
          saida_almoco: document.getElementById('saida_almoco').value,
          volta_almoco: document.getElementById('volta_almoco').value,
          saida: document.getElementById('saida').value
        })
      });
      if (res.ok) {
        document.getElementById('form-area').style.display = 'none';
        document.getElementById('success-area').style.display = 'block';
        setTimeout(() => window.close(), 2500);
      } else {
        alert('Erro ao salvar. Tente novamente.');
        btn.textContent = 'Registrar ponto'; btn.disabled = false;
      }
    } catch(e) {
      alert('Erro de conexão.');
      btn.textContent = 'Registrar ponto'; btn.disabled = false;
    }
  }
</script>
</body></html>`);
});

// ====================== PONTO: POST ======================
router.post('/ponto/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const { entrada, saida_almoco, volta_almoco, saida } = req.body;
    const user = await memory.getOrCreateUser(phone);

    function toTimestamp(horaStr) {
      if (!horaStr) return null;
      const [h, m] = horaStr.split(':').map(Number);
      const isoStr = `${dateBRT()}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00-03:00`;
      return new Date(isoStr);
    }

    const hoje = dateBRT();
    const pontos = [
      { type: 'entrada', hora: entrada },
      { type: 'saida_almoco', hora: saida_almoco },
      { type: 'volta_almoco', hora: volta_almoco },
      { type: 'saida', hora: saida },
    ].filter(p => p.hora);

    for (const p of pontos) {
      const timestamp = toTimestamp(p.hora);
      const existing = await prisma.workLog.findFirst({ where: { userId: user.id, type: p.type, date: hoje } });
      if (existing) {
        await prisma.workLog.update({ where: { id: existing.id }, data: { timestamp } });
      } else {
        await prisma.workLog.create({ data: { userId: user.id, type: p.type, timestamp, date: hoje } });
      }
    }

    const todosPontos = await prisma.workLog.findMany({
      where: { userId: user.id, date: hoje },
      orderBy: { timestamp: 'asc' }
    });

    const { getJornada } = require('../services/memory');

    const pad = n => String(n).padStart(2, '0');
    function horaStr(date) {
      if (!date) return '—';
      const d = new Date(date);
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    function minToH(min) {
      const h = Math.floor(min/60), m = min%60;
      return `${h}h${m > 0 ? m+'min' : ''}`;
    }

    const get = tipo => todosPontos.find(p => p.type === tipo);
    const e = get('entrada'), sa = get('saida_almoco'), va = get('volta_almoco'), s = get('saida');
    const jornada = await getJornada(user.id);

    let manha = null, tarde = null, total = null, extras = null;
    if (e && sa) manha = (new Date(sa.timestamp) - new Date(e.timestamp)) / 60000;
    if (va && s) tarde = (new Date(s.timestamp) - new Date(va.timestamp)) / 60000;
    if (manha !== null && tarde !== null) { total = manha + tarde; extras = total - jornada; }

    let texto = '';
    if (e && !s) {
      texto = `✅ Entrada registrada\n\n⏰ ${horaStr(e.timestamp)}\n\nTenha um ótimo trabalho hoje 😊`;
    } else {
      texto = `🏁 Saída registrada\n\n⏰ ${horaStr(s?.timestamp)}\n\n📊 Resumo do dia:\n`;
      texto += `• Total trabalhado: ${total !== null ? minToH(total) : '—'}\n`;
      if (extras !== null) {
        if (extras > 0) texto += `• Horas extras: ${minToH(extras)}`;
        else if (extras < 0) texto += `• Faltaram: ${minToH(Math.abs(extras))}`;
        else texto += `• Jornada completa ✅`;
      }
      texto += `\n\nBom descanso 💜`;
    }

    res.json({ ok: true });

    try {
      await sendButtons(phone, texto, [
        { id: 'ver_horas_hoje', label: '📋 Ver horas hoje' },
        { id: 'menu', label: '🏠 Menu' },
      ]);
    } catch (wErr) {
      console.error('[ponto] Erro ao notificar WhatsApp:', wErr.message);
    }
  } catch (e) {
    console.error('Erro form ponto:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== LISTAS: GET ======================
router.get('/listas/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const user = await memory.getOrCreateUser(phone);
    const listas = await prisma.groceryList.findMany({
      where: { userId: user.id, done: false },
      orderBy: { createdAt: 'desc' },
    });
    const result = listas.map(l => ({
      ...l, items: (() => { try { return JSON.parse(l.items); } catch { return []; } })()
    }));
    res.json(result);
  } catch (e) {
    console.error('Erro GET listas:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== LISTA: POST (criar) ======================
router.post('/lista/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const { nome, itens } = req.body;
    const user = await memory.getOrCreateUser(phone);
    const itemsArr = Array.isArray(itens)
      ? itens
      : String(itens).split(/[,\n;]+/).map(i => i.trim()).filter(Boolean);
    const itemsJson = itemsArr.map((nome, i) => ({ id: i + 1, nome, done: false }));
    const lista = await prisma.groceryList.create({
      data: { userId: user.id, name: nome || '🛒 Lista de compras', items: JSON.stringify(itemsJson), done: false }
    });
    const { saveMemory } = require('../services/memory');
    await saveMemory(user.id, 'ultima_lista', lista.id);
    res.json({ ok: true, id: lista.id, items: itemsJson });
  } catch (e) {
    console.error('Erro POST lista:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== LISTA: DELETE ======================
router.delete('/lista/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.groceryList.delete({ where: { id } });
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro DELETE lista:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== LISTA ITEM: TOGGLE ======================
router.post('/lista-item/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { itemId } = req.body;
    const lista = await prisma.groceryList.findUnique({ where: { id } });
    if (!lista) return res.status(404).json({ error: 'Lista não encontrada' });
    let items = []; try { items = JSON.parse(lista.items); } catch {}
    items = items.map(i => i.id === itemId ? { ...i, done: !i.done } : i);
    const allDone = items.every(i => i.done);
    await prisma.groceryList.update({ where: { id }, data: { items: JSON.stringify(items), done: allDone } });
    res.json({ ok: true, items, allDone });
  } catch (e) {
    console.error('Erro toggle item:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== LISTA ITEM: ADD ======================
router.post('/lista-add-item/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome } = req.body;
    const lista = await prisma.groceryList.findUnique({ where: { id } });
    if (!lista) return res.status(404).json({ error: 'Lista não encontrada' });
    let items = []; try { items = JSON.parse(lista.items); } catch {}
    const newId = items.length > 0 ? Math.max(...items.map(i => i.id)) + 1 : 1;
    items.push({ id: newId, nome, done: false });
    await prisma.groceryList.update({ where: { id }, data: { items: JSON.stringify(items) } });
    res.json({ ok: true, items });
  } catch (e) {
    console.error('Erro add item:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== LISTA ITEM: REMOVE ======================
router.delete('/lista-item/:id/:itemId', async (req, res) => {
  try {
    const { id, itemId } = req.params;
    const lista = await prisma.groceryList.findUnique({ where: { id } });
    if (!lista) return res.status(404).json({ error: 'Lista não encontrada' });
    let items = []; try { items = JSON.parse(lista.items); } catch {}
    items = items.filter(i => i.id !== parseInt(itemId));
    await prisma.groceryList.update({ where: { id }, data: { items: JSON.stringify(items) } });
    res.json({ ok: true, items });
  } catch (e) {
    console.error('Erro remove item:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== LISTA: EDITAR TÍTULO ======================
router.put('/lista-titulo/:id', async (req, res) => {
  try {
    const { nome } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome obrigatório' });
    await prisma.groceryList.update({ where: { id: req.params.id }, data: { name: nome } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====================== LISTA ITEM: EDITAR ======================
router.put('/lista-item-editar/:id/:itemId', async (req, res) => {
  try {
    const { nome } = req.body;
    const lista = await prisma.groceryList.findUnique({ where: { id: req.params.id } });
    if (!lista) return res.status(404).json({ error: 'Lista não encontrada' });
    const items = JSON.parse(lista.items || '[]');
    const itemId = parseInt(req.params.itemId);
    const item = items.find(i => i.id === itemId);
    if (!item) return res.status(404).json({ error: 'Item não encontrado' });
    item.nome = nome;
    await prisma.groceryList.update({ where: { id: req.params.id }, data: { items: JSON.stringify(items) } });
    res.json({ items });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====================== LISTA: ARQUIVAR ======================
router.post('/lista-arquivar/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.groceryList.update({ where: { id }, data: { done: true } });
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro arquivar lista:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== LISTA: REORDENAR ======================
router.put('/lista-reorder/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { items: newOrder } = req.body;
    const lista = await prisma.groceryList.findUnique({ where: { id } });
    if (!lista) return res.status(404).json({ error: 'Lista não encontrada' });
    let items = []; try { items = JSON.parse(lista.items); } catch {}
    const reordered = newOrder.map(id => items.find(i => i.id === id)).filter(Boolean);
    items.forEach(i => { if (!reordered.find(r => r.id === i.id)) reordered.push(i); });
    await prisma.groceryList.update({ where: { id }, data: { items: JSON.stringify(reordered) } });
    res.json({ ok: true, items: reordered });
  } catch (e) {
    console.error('Erro reorder lista:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== ADMIN: LISTAR USUÁRIOS (debug/limpeza) ======================
// Rota temporária para identificar usuários duplicados/incorretos no banco.
// Mostra todos os usuários com contagem de dados relacionados, para decidir
// com segurança quais merecem ser removidos. REMOVER após a limpeza.
router.get('/admin/usuarios', async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        _count: {
          select: { reminders: true, medications: true, expenses: true, groceryLists: true }
        }
      }
    });
    const resumo = users.map(u => ({
      id: u.id,
      phone: u.phone,
      name: u.name,
      blocked: u.blocked,
      createdAt: u.createdAt,
      lembretes: u._count.reminders,
      medicamentos: u._count.medications,
      gastos: u._count.expenses,
      listas: u._count.groceryLists,
    }));
    res.json(resumo);
  } catch (e) {
    console.error('Erro admin/usuarios:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== ADMIN: BLOQUEAR USUÁRIO (não deletar dados) ======================
// Marca um usuário como blocked=true em vez de deletar — assim os crons
// (bom dia, boa noite, etc) param de notificar esse número, mas os dados
// continuam no banco caso seja preciso recuperar algo depois.
router.post('/admin/bloquear/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.user.update({ where: { id }, data: { blocked: true } });
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro admin/bloquear:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== ADMIN: EXCLUIR USUÁRIO (definitivo) ======================
// Remove o usuário e TODOS os dados relacionados do banco — irreversível.
// Apaga primeiro os registros que referenciam o usuário (Reminder,
// Medication, Expense, GroceryList, Memory, Contact, etc) antes do User,
// pois o schema não tem onDelete: Cascade configurado.
router.delete('/admin/usuario/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.$transaction([
      prisma.reminder.deleteMany({ where: { userId: id } }),
      prisma.medication.deleteMany({ where: { userId: id } }),
      prisma.expense.deleteMany({ where: { userId: id } }),
      prisma.purchase.deleteMany({ where: { userId: id } }),
      prisma.task.deleteMany({ where: { userId: id } }),
      prisma.bill.deleteMany({ where: { userId: id } }),
      prisma.event.deleteMany({ where: { userId: id } }),
      prisma.groceryList.deleteMany({ where: { userId: id } }),
      prisma.sleepLog.deleteMany({ where: { userId: id } }),
      prisma.workout.deleteMany({ where: { userId: id } }),
      prisma.workLog.deleteMany({ where: { userId: id } }),
      prisma.secret.deleteMany({ where: { userId: id } }),
      prisma.contact.deleteMany({ where: { userId: id } }),
      prisma.scheduledMessage.deleteMany({ where: { userId: id } }),
      prisma.memory.deleteMany({ where: { userId: id } }),
      prisma.user.delete({ where: { id } }),
    ]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro admin/excluir usuario:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== ADMIN: PÁGINA DE LIMPEZA (HTML) ======================
// Serve a página de bloqueio de usuários duplicados direto do mesmo
// domínio do backend — evita qualquer bloqueio de CORS que ocorreria se
// a página fosse aberta localmente (file://) fazendo fetch para outro
// domínio. Busca os usuários ao vivo via /admin/usuarios em vez de lista
// fixa, então sempre reflete o estado real do banco.
router.get('/admin/limpeza', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Limpeza de Usuários — Clara</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0b0d12; color: #eee; min-height: 100vh; padding: 20px; }
  h1 { font-size: 18px; margin-bottom: 6px; }
  .sub { font-size: 13px; color: #888; margin-bottom: 24px; }
  .card { background: #161922; border: 1px solid #2a2d3a; border-radius: 14px; padding: 16px; margin-bottom: 12px; }
  .card.real { border-color: #22c55e; background: #0f1a13; }
  .card.blocked { opacity: 0.5; }
  .phone { font-size: 16px; font-weight: 700; }
  .meta { font-size: 12px; color: #999; margin-top: 4px; line-height: 1.5; }
  .badge { display: inline-block; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 8px; margin-top: 8px; }
  .badge.real { background: rgba(34,197,94,.15); color: #22c55e; }
  .badge.lixo { background: rgba(239,68,68,.15); color: #f87171; }
  .badge.blocked { background: rgba(107,114,128,.2); color: #9ca3af; }
  button { width: 100%; padding: 12px; margin-top: 10px; border: none; border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer; }
  button.bloquear { background: #dc2626; color: white; }
  button.bloquear:disabled { background: #3a3a3a; color: #888; cursor: default; }
  .status { font-size: 12px; margin-top: 8px; min-height: 16px; }
  .status.ok { color: #22c55e; }
  .status.erro { color: #f87171; }
  .loading { text-align: center; padding: 40px; color: #888; }
</style>
</head>
<body>
<h1>🧹 Limpeza de usuários duplicados</h1>
<div class="sub">Bloqueia os usuários que não são você — eles continuam no banco, só param de receber mensagens automáticas (bom dia, boa noite, etc).</div>

<div id="lista"><div class="loading">Carregando usuários...</div></div>

<script>
async function carregar() {
  const el = document.getElementById('lista');
  try {
    const res = await fetch('/forms/admin/usuarios');
    const usuarios = await res.json();
    // Heurística simples: o usuário com mais dados totais é provavelmente
    // o real — os outros aparecem marcados como possível duplicado.
    const totais = usuarios.map(u => u.lembretes + u.medicamentos + u.gastos + u.listas);
    const maxTotal = Math.max(...totais);

    el.innerHTML = usuarios.map((u, i) => {
      const isReal = totais[i] === maxTotal && maxTotal > 0;
      const isBlocked = u.blocked;
      return \`
        <div class="card \${isReal ? 'real' : ''} \${isBlocked ? 'blocked' : ''}" id="card-\${u.id}">
          <div class="phone">\${u.phone}</div>
          <div class="meta">\${u.name || '(sem nome)'} · \${u.lembretes} lembretes · \${u.medicamentos} medicamentos · \${u.gastos} gastos · \${u.listas} listas</div>
          \${isBlocked
            ? '<span class="badge blocked">🚫 já bloqueado</span>'
            : isReal
              ? '<span class="badge real">✅ provável usuário real — confira antes de bloquear</span>'
              : '<span class="badge lixo">⚠️ possível duplicado/lixo</span>'
          }
          \${!isBlocked ? \`<button class="bloquear" id="btn-\${u.id}" onclick="bloquear('\${u.id}')">Bloquear esse número</button>\` : ''}
          <div class="status" id="status-\${u.id}"></div>
        </div>
      \`;
    }).join('');
  } catch (e) {
    el.innerHTML = '<div class="status erro">Erro ao carregar usuários: ' + e.message + '</div>';
  }
}

async function bloquear(id) {
  const btn = document.getElementById('btn-' + id);
  const status = document.getElementById('status-' + id);
  btn.disabled = true;
  btn.textContent = 'Bloqueando...';
  status.textContent = '';
  status.className = 'status';
  try {
    const res = await fetch('/forms/admin/bloquear/' + id, { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.ok) {
      btn.textContent = '✅ Bloqueado';
      status.textContent = 'Esse número não vai mais receber mensagens automáticas.';
      status.className = 'status ok';
    } else {
      throw new Error(data.error || 'Erro desconhecido');
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Tentar de novo';
    status.textContent = 'Erro: ' + e.message;
    status.className = 'status erro';
  }
}

carregar();
</script>
</body>
</html>`);
});


// ═══════════════════════════════════════════════════════════════════════
// MEMÓRIAS — Perfil rico da Clara 3.0
// GET  /memorias/:phone        → lista todas as memórias por categoria
// DELETE /memoria/:id/:phone   → deleta uma memória específica
// POST /memoria/:phone         → adiciona memória manualmente
// GET  /memorias-categorias    → retorna as categorias disponíveis
// ═══════════════════════════════════════════════════════════════════════

router.get('/memorias/:phone', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { phone: req.params.phone } });
    if (!user) return res.json({ categorias: {} });

    const mems = await prisma.memory.findMany({
      where: { userId: user.id, type: 'info_pessoal' },
      orderBy: { createdAt: 'desc' }
    });

    // Agrupa por categoria para exibição no Dashboard
    const categorias = {};
    for (const m of mems) {
      let meta = {};
      try { meta = JSON.parse(m.metadata || '{}'); } catch {}
      const cat = meta.categoria || 'outro';
      if (!categorias[cat]) categorias[cat] = [];
      categorias[cat].push({
        id: m.id,
        chave: meta.chave || '',
        valor: m.content,
        categoria: cat,
        criadoEm: m.createdAt,
        atualizadoEm: meta.updatedAt || meta.createdAt || m.createdAt
      });
    }

    // Também inclui assuntos em aberto
    const pendencias = await prisma.memory.findMany({
      where: { userId: user.id, type: 'pendencia_conversa' },
      orderBy: { createdAt: 'desc' },
      take: 10
    });
    const pendenciasAtivas = pendencias
      .map(m => { try { return { id: m.id, criadoEm: m.createdAt, ...JSON.parse(m.content) }; } catch { return null; } })
      .filter(p => p && !p.encerrado);

    res.json({ categorias, pendenciasAbertas: pendenciasAtivas });
  } catch (e) {
    console.error('[GET /memorias]', e.message);
    res.status(500).json({ error: 'Erro ao buscar memórias' });
  }
});

router.delete('/memoria/:id/:phone', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { phone: req.params.phone } });
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

    const mem = await prisma.memory.findFirst({
      where: { id: req.params.id, userId: user.id }
    });
    if (!mem) return res.status(404).json({ error: 'Memória não encontrada' });

    await prisma.memory.delete({ where: { id: req.params.id } });

    // Marca que o usuário não quer ser perguntado sobre isso por 30 dias
    let meta = {};
    try { meta = JSON.parse(mem.metadata || '{}'); } catch {}
    if (meta.chave) {
      await prisma.memory.create({
        data: {
          userId: user.id,
          type: 'perfil_deletado',
          content: meta.chave,
          metadata: JSON.stringify({
            deletadoEm: new Date().toISOString(),
            expira: Date.now() + 30 * 24 * 60 * 60 * 1000
          })
        }
      }).catch(() => {});
    }

    // Avisa a Clara via WhatsApp que a memória foi removida (opcional, não bloqueia)
    try {
      const w = require('../services/whatsapp');
      if (w && user.phone) {
        const chave = meta.chave || 'essa informação';
        await w.sendMessage(user.phone, `🗑️ Entendido! Removi "${mem.content}" das minhas memórias. Não vou mais trazer esse assunto 😊`);
      }
    } catch {}

    res.json({ ok: true, deletado: mem.content });
  } catch (e) {
    console.error('[DELETE /memoria]', e.message);
    res.status(500).json({ error: 'Erro ao deletar memória' });
  }
});

router.post('/memoria/:phone', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { phone: req.params.phone } });
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

    const { chave, valor, categoria } = req.body;
    if (!chave || !valor) return res.status(400).json({ error: 'chave e valor são obrigatórios' });

    // Verifica se já existe e atualiza
    const existing = await prisma.memory.findFirst({
      where: { userId: user.id, type: 'info_pessoal', metadata: { contains: `"chave":"${chave}"` } }
    });

    let mem;
    if (existing) {
      mem = await prisma.memory.update({
        where: { id: existing.id },
        data: {
          content: valor,
          metadata: JSON.stringify({ chave, categoria: categoria || 'outro', updatedAt: new Date().toISOString() })
        }
      });
    } else {
      mem = await prisma.memory.create({
        data: {
          userId: user.id,
          type: 'info_pessoal',
          content: valor,
          metadata: JSON.stringify({ chave, categoria: categoria || 'outro', createdAt: new Date().toISOString() })
        }
      });
    }

    res.json({ ok: true, id: mem.id, chave, valor, categoria });
  } catch (e) {
    console.error('[POST /memoria]', e.message);
    res.status(500).json({ error: 'Erro ao salvar memória' });
  }
});

router.delete('/pendencia/:id/:phone', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { phone: req.params.phone } });
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    const mem = await prisma.memory.findFirst({
      where: { id: req.params.id, userId: user.id, type: 'pendencia_conversa' }
    });
    if (!mem) return res.status(404).json({ error: 'Pendência não encontrada' });
    // Marca como encerrada em vez de deletar — preserva histórico
    const dados = JSON.parse(mem.content || '{}');
    await prisma.memory.update({
      where: { id: req.params.id },
      data: { content: JSON.stringify({ ...dados, encerrado: true }) }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao encerrar pendência' });
  }
});

router.get('/memorias-categorias', (req, res) => {
  // Retorna as categorias disponíveis com labels para o Dashboard
  res.json({
    categorias: {
      relacionamento:  { label: 'Relacionamento',  emoji: '❤️' },
      filhos:          { label: 'Filhos',           emoji: '👶' },
      familia:         { label: 'Família',          emoji: '👨‍👩‍👧' },
      trabalho:        { label: 'Trabalho',         emoji: '💼' },
      hobbies:         { label: 'Hobbies',          emoji: '🎯' },
      entretenimento:  { label: 'Entretenimento',   emoji: '🎬' },
      alimentacao:     { label: 'Alimentação',      emoji: '🍔' },
      metas:           { label: 'Metas',            emoji: '🚀' },
      personalidade:   { label: 'Personalidade',    emoji: '✨' },
      saude:           { label: 'Saúde',            emoji: '💊' },
      datas:           { label: 'Datas importantes',emoji: '📅' },
      rotina:          { label: 'Rotina',           emoji: '⏰' },
      outro:           { label: 'Informações gerais',emoji: '📌' },
    }
  });
});

module.exports = router;
