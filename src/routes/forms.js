const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const memory = require('../services/memory');

const prisma = new PrismaClient();

const BASE_URL = 'https://clara-production-8128.up.railway.app';

function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function dateBRT() {
  const d = nowBRT();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function criarDataBRT(dataStr, horaStr) {
  const [ano, mes, dia] = dataStr.split('-').map(Number);
  const [hora, min] = horaStr.split(':').map(Number);
  const d = new Date();
  d.setFullYear(ano, mes - 1, dia);
  d.setHours(hora, min, 0, 0);
  return new Date(d.getTime() + (d.getTimezoneOffset() + 180) * -60000);
}

// ====================== LEMBRETE ======================
router.get('/lembrete/:phone', (req, res) => {
  const { phone } = req.params;
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Criar Lembrete</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
    .card { background: white; border-radius: 16px; padding: 24px; width: 100%; max-width: 420px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    .header { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
    .header-icon { font-size: 32px; }
    .header h1 { font-size: 20px; font-weight: 700; color: #1a1a2e; }
    .header p { font-size: 13px; color: #888; margin-top: 2px; }
    .field { margin-bottom: 16px; }
    label { display: block; font-size: 13px; font-weight: 600; color: #444; margin-bottom: 6px; }
    input, textarea, select { width: 100%; padding: 12px 14px; border: 1.5px solid #e0e0e0; border-radius: 10px; font-size: 15px; color: #1a1a2e; background: #fafafa; outline: none; transition: border 0.2s; }
    input:focus, textarea:focus, select:focus { border-color: #7c3aed; background: white; }
    textarea { resize: none; height: 80px; }
    .btn { width: 100%; padding: 14px; background: linear-gradient(135deg, #7c3aed, #a855f7); color: white; border: none; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 8px; transition: opacity 0.2s; }
    .btn:active { opacity: 0.85; }
    .success { display: none; text-align: center; padding: 24px 0; }
    .success-icon { font-size: 56px; margin-bottom: 12px; }
    .success h2 { font-size: 20px; font-weight: 700; color: #1a1a2e; margin-bottom: 8px; }
    .success p { font-size: 14px; color: #888; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <div id="form-area">
      <div class="header">
        <div class="header-icon">⏰</div>
        <div>
          <h1>Criar Lembrete</h1>
          <p>Eu te aviso na hora certa!</p>
        </div>
      </div>
      <div class="field">
        <label>📌 O que você quer lembrar?</label>
        <textarea id="titulo" placeholder="Ex: Buscar minha filha na escola..."></textarea>
      </div>
      <div class="row">
        <div class="field">
          <label>📅 Data</label>
          <input type="date" id="data" />
        </div>
        <div class="field">
          <label>🕐 Horário</label>
          <input type="time" id="hora" />
        </div>
      </div>
      <button class="btn" onclick="salvar()">✅ Criar Lembrete</button>
    </div>
    <div class="success" id="success-area">
      <div class="success-icon">🎉</div>
      <h2>Lembrete criado!</h2>
      <p>Vou te avisar na hora certinha 😊</p>
    </div>
  </div>
  <script>
    // Preenche data e hora atual como padrão
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    document.getElementById('data').value = now.getFullYear() + '-' + pad(now.getMonth()+1) + '-' + pad(now.getDate());
    document.getElementById('hora').value = pad(now.getHours()) + ':' + pad(now.getMinutes());

    async function salvar() {
      const titulo = document.getElementById('titulo').value.trim();
      const data = document.getElementById('data').value;
      const hora = document.getElementById('hora').value;
      if (!titulo) { alert('Por favor, descreva o lembrete!'); return; }
      if (!hora) { alert('Por favor, informe o horário!'); return; }
      const btn = document.querySelector('.btn');
      btn.textContent = 'Salvando...';
      btn.disabled = true;
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
          btn.textContent = '✅ Criar Lembrete';
          btn.disabled = false;
        }
      } catch(e) {
        alert('Erro de conexão.');
        btn.textContent = '✅ Criar Lembrete';
        btn.disabled = false;
      }
    }
  </script>
</body>
</html>`);
});

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

    const { sendMessage, sendButtons } = require('../services/whatsapp');
    const dataFormatada = scheduledAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });

    await sendButtons(phone,
      `🔔 *Lembrete criado pelo formulário!*\n\n📌 ${titulo}\n🗓️ ${dataFormatada}\n\nVou te avisar no horário certinho 😊`,
      [
        { id: 'ver_lembretes', label: '📋 Ver lembretes' },
        { id: 'menu', label: '🏠 Menu' },
      ]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('Erro form lembrete:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== REMÉDIO ======================
router.get('/remedio/:phone', (req, res) => {
  const { phone } = req.params;
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cadastrar Remédio</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
    .card { background: white; border-radius: 16px; padding: 24px; width: 100%; max-width: 420px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    .header { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
    .header-icon { font-size: 32px; }
    .header h1 { font-size: 20px; font-weight: 700; color: #1a1a2e; }
    .header p { font-size: 13px; color: #888; margin-top: 2px; }
    .field { margin-bottom: 16px; }
    label { display: block; font-size: 13px; font-weight: 600; color: #444; margin-bottom: 6px; }
    input, select { width: 100%; padding: 12px 14px; border: 1.5px solid #e0e0e0; border-radius: 10px; font-size: 15px; color: #1a1a2e; background: #fafafa; outline: none; transition: border 0.2s; }
    input:focus, select:focus { border-color: #059669; background: white; }
    .btn { width: 100%; padding: 14px; background: linear-gradient(135deg, #059669, #10b981); color: white; border: none; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 8px; transition: opacity 0.2s; }
    .btn:active { opacity: 0.85; }
    .success { display: none; text-align: center; padding: 24px 0; }
    .success-icon { font-size: 56px; margin-bottom: 12px; }
    .success h2 { font-size: 20px; font-weight: 700; color: #1a1a2e; margin-bottom: 8px; }
    .success p { font-size: 14px; color: #888; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .resumo { background: #f0fdf4; border: 1.5px solid #bbf7d0; border-radius: 10px; padding: 14px; margin-bottom: 16px; display: none; }
    .resumo p { font-size: 13px; color: #166534; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div id="form-area">
      <div class="header">
        <div class="header-icon">💊</div>
        <div>
          <h1>Cadastrar Remédio</h1>
          <p>Vou te lembrar em todos os horários!</p>
        </div>
      </div>
      <div class="field">
        <label>💊 Nome do medicamento</label>
        <input type="text" id="nome" placeholder="Ex: Losartana, Vitamina C..." oninput="atualizarResumo()" />
      </div>
      <div class="row">
        <div class="field">
          <label>💉 Dose</label>
          <input type="text" id="dose" placeholder="Ex: 1 comp, 5ml" oninput="atualizarResumo()" />
        </div>
        <div class="field">
          <label>⏱️ A cada quantas horas</label>
          <select id="intervalo" onchange="atualizarResumo()">
            <option value="4">4 horas</option>
            <option value="6">6 horas</option>
            <option value="8">8 horas</option>
            <option value="12" selected>12 horas</option>
            <option value="24">24 horas (1x/dia)</option>
          </select>
        </div>
      </div>
      <div class="row">
        <div class="field">
          <label>📅 Por quantos dias</label>
          <input type="number" id="dias" placeholder="Ex: 7" min="1" max="365" oninput="atualizarResumo()" />
        </div>
        <div class="field">
          <label>🕐 Primeira dose</label>
          <input type="time" id="horario_inicio" oninput="atualizarResumo()" />
        </div>
      </div>
      <div class="resumo" id="resumo">
        <p id="resumo-texto"></p>
      </div>
      <button class="btn" onclick="salvar()">💊 Cadastrar Medicamento</button>
    </div>
    <div class="success" id="success-area">
      <div class="success-icon">✅</div>
      <h2>Medicamento cadastrado!</h2>
      <p>Vou te lembrar em todos os horários combinados 😊</p>
    </div>
  </div>
  <script>
    // Hora atual como padrão
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    document.getElementById('horario_inicio').value = pad(now.getHours()) + ':' + pad(now.getMinutes());

    function atualizarResumo() {
      const nome = document.getElementById('nome').value.trim();
      const dose = document.getElementById('dose').value.trim();
      const intervalo = parseInt(document.getElementById('intervalo').value);
      const dias = parseInt(document.getElementById('dias').value) || 0;
      const horarioInicio = document.getElementById('horario_inicio').value;

      if (!nome || !dose || !horarioInicio) { document.getElementById('resumo').style.display = 'none'; return; }

      const freqDia = Math.round(24 / intervalo);
      const totalDoses = dias > 0 ? dias * freqDia : '?';

      const horarios = [];
      if (horarioInicio) {
        const [h, m] = horarioInicio.split(':').map(Number);
        for (let i = 0; i < freqDia; i++) {
          const hh = (h + i * intervalo) % 24;
          horarios.push(pad(hh) + ':' + pad(m));
        }
      }

      const termina = new Date();
      if (dias > 0) { termina.setDate(termina.getDate() + dias); }

      document.getElementById('resumo-texto').innerHTML =
        '📋 <b>' + nome + '</b> — ' + dose + '<br>' +
        '⏰ Horários: ' + horarios.join(', ') + '<br>' +
        '🔄 ' + freqDia + 'x por dia por ' + (dias || '?') + ' dias<br>' +
        '💊 Total: ' + totalDoses + ' doses' +
        (dias > 0 ? '<br>🏁 Termina: ' + termina.toLocaleDateString('pt-BR') : '');

      document.getElementById('resumo').style.display = 'block';
    }

    async function salvar() {
      const nome = document.getElementById('nome').value.trim();
      const dose = document.getElementById('dose').value.trim();
      const intervalo = parseInt(document.getElementById('intervalo').value);
      const dias = parseInt(document.getElementById('dias').value) || 0;
      const horarioInicio = document.getElementById('horario_inicio').value;

      if (!nome) { alert('Informe o nome do medicamento!'); return; }
      if (!dose) { alert('Informe a dose!'); return; }
      if (!horarioInicio) { alert('Informe o horário da primeira dose!'); return; }

      const btn = document.querySelector('.btn');
      btn.textContent = 'Salvando...';
      btn.disabled = true;

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
          btn.textContent = '💊 Cadastrar Medicamento';
          btn.disabled = false;
        }
      } catch(e) {
        alert('Erro de conexão.');
        btn.textContent = '💊 Cadastrar Medicamento';
        btn.disabled = false;
      }
    }
  </script>
</body>
</html>`);
});

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
      const hh = (h + i * intervalo) % 24;
      horarios.push(pad(hh) + ':' + pad(m));
    }

    await memory.saveMedication(user.id, {
      nome, quantidade: totalDoses, frequencia: freqDia, horarios
    });

    const termina = new Date();
    if (dias > 0) termina.setDate(termina.getDate() + dias);

    const { sendButtons } = require('../services/whatsapp');

    await sendButtons(phone,
      `💊 *Medicamento cadastrado!*\n\n📋 *${nome}*\n💊 Dose: ${dose}\n⏱️ A cada ${intervalo}h\n⏰ Horários: ${horarios.join(', ')}\n🔄 ${freqDia}x por dia\n📅 Duração: ${dias} dias\n💊 Total: ${totalDoses} doses\n🏁 Termina: ${termina.toLocaleDateString('pt-BR')}\n\nVou te lembrar em todos os horários! 😊`,
      [
        { id: 'ver_medicamentos', label: '📋 Ver medicamentos' },
        { id: 'menu', label: '🏠 Menu' },
      ]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('Erro form remedio:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====================== PONTO ======================
router.get('/ponto/:phone', (req, res) => {
  const { phone } = req.params;
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Registrar Ponto</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
    .card { background: white; border-radius: 16px; padding: 24px; width: 100%; max-width: 420px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    .header { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
    .header-icon { font-size: 32px; }
    .header h1 { font-size: 20px; font-weight: 700; color: #1a1a2e; }
    .header p { font-size: 13px; color: #888; margin-top: 2px; }
    .field { margin-bottom: 16px; }
    label { display: block; font-size: 13px; font-weight: 600; color: #444; margin-bottom: 6px; }
    input { width: 100%; padding: 12px 14px; border: 1.5px solid #e0e0e0; border-radius: 10px; font-size: 15px; color: #1a1a2e; background: #fafafa; outline: none; transition: border 0.2s; }
    input:focus { border-color: #2563eb; background: white; }
    .btn { width: 100%; padding: 14px; background: linear-gradient(135deg, #2563eb, #3b82f6); color: white; border: none; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 8px; transition: opacity 0.2s; }
    .btn:active { opacity: 0.85; }
    .success { display: none; text-align: center; padding: 24px 0; }
    .success-icon { font-size: 56px; margin-bottom: 12px; }
    .success h2 { font-size: 20px; font-weight: 700; color: #1a1a2e; margin-bottom: 8px; }
    .success p { font-size: 14px; color: #888; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .tip { font-size: 12px; color: #aaa; margin-top: 4px; }
  </style>
</head>
<body>
  <div class="card">
    <div id="form-area">
      <div class="header">
        <div class="header-icon">📍</div>
        <div>
          <h1>Registrar Ponto</h1>
          <p>Preencha os horários do seu dia</p>
        </div>
      </div>
      <div class="row">
        <div class="field">
          <label>🟢 Entrada</label>
          <input type="time" id="entrada" />
        </div>
        <div class="field">
          <label>🍽️ Saída almoço</label>
          <input type="time" id="saida_almoco" />
        </div>
      </div>
      <div class="row">
        <div class="field">
          <label>🔄 Volta almoço</label>
          <input type="time" id="volta_almoco" />
        </div>
        <div class="field">
          <label>🔴 Saída</label>
          <input type="time" id="saida" />
        </div>
      </div>
      <p class="tip">💡 Preencha apenas os horários que já aconteceram</p>
      <button class="btn" onclick="salvar()">📍 Registrar Ponto</button>
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
      const saida_almoco = document.getElementById('saida_almoco').value;
      const volta_almoco = document.getElementById('volta_almoco').value;
      const saida = document.getElementById('saida').value;

      if (!entrada) { alert('Informe pelo menos o horário de entrada!'); return; }

      const btn = document.querySelector('.btn');
      btn.textContent = 'Salvando...';
      btn.disabled = true;

      try {
        const res = await fetch('/forms/ponto/${phone}', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entrada, saida_almoco, volta_almoco, saida })
        });
        if (res.ok) {
          document.getElementById('form-area').style.display = 'none';
          document.getElementById('success-area').style.display = 'block';
          setTimeout(() => window.close(), 2500);
        } else {
          alert('Erro ao salvar. Tente novamente.');
          btn.textContent = '📍 Registrar Ponto';
          btn.disabled = false;
        }
      } catch(e) {
        alert('Erro de conexão.');
        btn.textContent = '📍 Registrar Ponto';
        btn.disabled = false;
      }
    }
  </script>
</body>
</html>`);
});

router.post('/ponto/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const { entrada, saida_almoco, volta_almoco, saida } = req.body;

    const user = await memory.getOrCreateUser(phone);

    function nowBRT() {
      return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    }

    function dateBRT() {
      const d = nowBRT();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function toTimestamp(horaStr) {
      if (!horaStr) return null;
      const [h, m] = horaStr.split(':').map(Number);
      const d = nowBRT();
      d.setHours(h, m, 0, 0);
      return d;
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
      const existing = await prisma.workLog.findFirst({
        where: { userId: user.id, type: p.type, date: hoje }
      });
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

    function horaStr(date) {
      if (!date) return '—';
      const d = new Date(date);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    function minutesToHours(min) {
      const h = Math.floor(min / 60);
      const m = min % 60;
      return `${h}h${m > 0 ? m + 'min' : ''}`;
    }

    const get = tipo => todosPontos.find(p => p.type === tipo);
    const e = get('entrada');
    const sa = get('saida_almoco');
    const va = get('volta_almoco');
    const s = get('saida');
    const jornada = await getJornada(user.id);

    let tempoManha = null, tempoTarde = null, total = null, extras = null;
    if (e && sa) tempoManha = (new Date(sa.timestamp) - new Date(e.timestamp)) / 60000;
    if (va && s) tempoTarde = (new Date(s.timestamp) - new Date(va.timestamp)) / 60000;
    if (tempoManha !== null && tempoTarde !== null) { total = tempoManha + tempoTarde; extras = total - jornada; }

    let texto = e && !s
      ? `📍 *Entrada registrada!*\n\n🕘 Expediente iniciado às *${horaStr(e.timestamp)}*\n\nTenha um ótimo trabalho! 💜\n\n`
      : `✨ *Resumo do seu dia*\n\n`;

    texto += `🟢 Entrada: *${horaStr(e?.timestamp)}*\n`;
    texto += `🍽️ Saída almoço: *${horaStr(sa?.timestamp)}*\n`;
    if (tempoManha !== null) texto += `⏱️ Manhã: *${minutesToHours(tempoManha)}*\n`;
    texto += `🔄 Volta almoço: *${horaStr(va?.timestamp)}*\n`;
    if (s) texto += `🔴 Saída: *${horaStr(s.timestamp)}*\n`;
    if (tempoTarde !== null) texto += `⏱️ Tarde: *${minutesToHours(tempoTarde)}*\n`;
    if (total !== null) {
      texto += `\n📊 Total: *${minutesToHours(total)}*\n`;
      if (extras > 0) texto += `⭐ Horas extras: *${minutesToHours(extras)}*\n`;
      else if (extras < 0) texto += `⚠️ Faltam: *${minutesToHours(Math.abs(extras))}*\n`;
      else texto += `✅ Jornada completa!\n`;
    }
    if (!s) texto += `\n💡 Me avisa quando sair!`;

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

module.exports = router;
