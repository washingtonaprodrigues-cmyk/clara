const express = require('express');
const router = express.Router();
const memory = require('../services/memory');
const prisma = require('../services/prisma');

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
    const agora = nowBRT();
    const lembretes = await prisma.reminder.findMany({
      where: { userId: user.id, sent: false, confirmed: false, scheduledAt: { gte: agora } },
      orderBy: { scheduledAt: 'asc' },
      take: 20,
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
    res.json(medicamentos);
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

    function nowBRT() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })); }
    function dateBRT() { const d = nowBRT(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
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
    await prisma.medication.update({
      where: { id },
      data: { remaining: { decrement: 1 } }
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro remedio-tomado:', e.message);
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

// ====================== REGISTRAR GASTO ======================
router.post('/gasto/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const { valor, categoria, descricao } = req.body;
    const user = await memory.getOrCreateUser(phone);
    await memory.saveExpense(user.id, { valor, categoria, descricao });
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro POST gasto:', e.message);
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

// ====================== PREFERÊNCIA: POST ======================
router.post('/preferencia/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const { nome, tom, saldo } = req.body;
    const user = await memory.getOrCreateUser(phone);
    const saldoNum = (saldo !== undefined && saldo !== null && saldo !== '') ? parseFloat(saldo) : null;
    await memory.saveUserPreference(user.id, nome || null, tom || null, saldoNum);
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

    const { sendButtons } = require('../services/whatsapp');
    const dataFormatada = scheduledAt.toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short'
    });

    await sendButtons(phone,
      `✅ Lembrete criado!\n\n📌 ${titulo}\n🕒 ${dataFormatada}\n\nVou te avisar no horário certinho.`,
      [{ id: 'ver_lembretes', label: '📋 Ver lembretes' }, { id: 'menu', label: '🏠 Menu' }]
    );

    res.json({ ok: true });
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

    const { sendButtons } = require('../services/whatsapp');
    await sendButtons(phone,
      `✅ Remédio anotado!\n\n💊 ${nome}\n🕒 ${horarios.join(', ')}\n📅 ${dias > 0 ? dias + ' dias · termina ' + termina.toLocaleDateString('pt-BR') : 'uso contínuo'}\n\nVou te lembrar nos horários certinhos.`,
      [{ id: 'ver_medicamentos', label: '💊 Ver remédios' }, { id: 'menu', label: '🏠 Menu' }]
    );

    res.json({ ok: true });
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

    function nowBRT() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })); }
    function dateBRT() { const d = nowBRT(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
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

    const { sendButtons } = require('../services/whatsapp');
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

    await sendButtons(phone, texto, [
      { id: 'ver_horas_hoje', label: '📋 Ver horas hoje' },
      { id: 'menu', label: '🏠 Menu' },
    ]);

    res.json({ ok: true });
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

module.exports = router;
