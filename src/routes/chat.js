const express = require('express');
const router = express.Router();
const { freeResponse, classify } = require('../services/groq');
const memory = require('../services/memory');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function dateBRT() {
  const d = nowBRT();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function calcularHorarioRelativo(texto) {
  const t = (texto || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const minMatch = t.match(/daqui\s+(\d+)\s*(min|minuto|minutos)/);
  if (minMatch) { const d = nowBRT(); d.setMinutes(d.getMinutes() + parseInt(minMatch[1])); return d; }
  const hrMatch = t.match(/daqui\s+(\d+)\s*(h|hora|horas)/);
  if (hrMatch) { const d = nowBRT(); d.setHours(d.getHours() + parseInt(hrMatch[1])); return d; }
  const emMinMatch = t.match(/em\s+(\d+)\s*(min|minuto|minutos)/);
  if (emMinMatch) { const d = nowBRT(); d.setMinutes(d.getMinutes() + parseInt(emMinMatch[1])); return d; }
  const emHrMatch = t.match(/em\s+(\d+)\s*(h|hora|horas)/);
  if (emHrMatch) { const d = nowBRT(); d.setHours(d.getHours() + parseInt(emHrMatch[1])); return d; }
  return null;
}

async function executeActionFromChat(user, phone, classified, originalText) {
  try {
    switch (classified.tipo) {
      case 'gasto':
        if (classified.valor) {
          await memory.saveExpense(user.id, {
            valor: classified.valor,
            categoria: classified.categoria || 'outro',
            descricao: classified.descricao || classified.categoria,
          });
          console.log(`[chat] Gasto salvo: R$${classified.valor} em ${classified.categoria}`);
        }
        break;

      case 'saldo':
        if (classified.valor !== undefined && classified.valor !== null) {
          await memory.saveUserPreference(user.id, null, null, parseFloat(classified.valor));
          console.log(`[chat] Saldo salvo: R$${classified.valor}`);
        }
        break;

      case 'preferencia':
        await memory.saveUserPreference(user.id, classified.nome, classified.tom, null);
        break;

      case 'tarefa': {
        let scheduledAt = null;
        if (originalText) {
          const relativo = calcularHorarioRelativo(originalText);
          if (relativo) scheduledAt = relativo;
        }
        if (!scheduledAt && classified.hora) {
          const hoje = classified.data || dateBRT();
          const [h, m] = classified.hora.split(':').map(Number);
          scheduledAt = new Date(`${hoje}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00-03:00`);
          if (!classified.data && scheduledAt < nowBRT()) scheduledAt.setDate(scheduledAt.getDate() + 1);
        }
        if (scheduledAt && classified.titulo) {
          await prisma.reminder.create({
            data: { userId: user.id, phone, message: classified.titulo, scheduledAt }
          });
          console.log(`[chat] Lembrete salvo: "${classified.titulo}" para ${scheduledAt}`);
        }
        break;
      }

      case 'medicamento':
        if (classified.nome) {
          await memory.saveMedication(user.id, {
            nome: classified.nome,
            quantidade: classified.quantidade || 0,
            frequencia: classified.frequencia || 1,
            horarios: classified.horarios || ['08:00'],
          });
          console.log(`[chat] Medicamento salvo: ${classified.nome}`);
        }
        break;

      case 'anotacao':
        await memory.saveMemory(user.id, 'anotacao',
          classified.conteudo || classified.titulo || originalText,
          { titulo: classified.titulo }
        );
        console.log(`[chat] Anotação salva`);
        break;

      case 'cidade':
        if (classified.cidade) {
          await memory.saveMemory(user.id, 'cidade', classified.cidade);
        }
        break;
    }
  } catch (e) {
    console.error('[chat] Erro executeActionFromChat:', e.message);
  }
}

router.post('/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const { message, privateMode } = req.body;
    if (!message) return res.status(400).json({ error: 'Mensagem vazia' });

    const user = await memory.getOrCreateUser(phone);
    const limit = privateMode ? 100 : 10;
    const history = await memory.getConversationHistory(user.id, limit);
    const preferences = await memory.getUserPreference(user.id);

    // Monta contexto completo para a Clara
    let contexto = '';
    if (!privateMode) {
      try {
        const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
        const pad = n => String(n).padStart(2,'0');
        const hm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

        // Data de hoje e amanhã no fuso BRT
        const toDateStr = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
        const hoje = toDateStr(now);
        const amanha = new Date(now); amanha.setDate(amanha.getDate()+1);
        const amanhaStr = toDateStr(amanha);

        const inicioHoje = new Date(`${hoje}T00:00:00-03:00`);
        const fimAmanha = new Date(`${amanhaStr}T23:59:59-03:00`);
        const inicioMes = new Date(now.getFullYear(), now.getMonth(), 1);

        // Busca tudo em paralelo
        const [lembretes, meds, gastos] = await Promise.all([
          prisma.reminder.findMany({
            where: { userId: user.id, sent: false, confirmed: false, scheduledAt: { gte: inicioHoje, lte: fimAmanha } },
            orderBy: { scheduledAt: 'asc' }, take: 20
          }),
          prisma.medication.findMany({
            where: { userId: user.id, active: true, remaining: { gt: 0 } }
          }),
          preferences.saldo != null ? prisma.expense.findMany({
            where: { userId: user.id, createdAt: { gte: inicioMes } }
          }) : Promise.resolve([])
        ]);

        // Lembretes de hoje e amanhã
        if (lembretes.length > 0) {
          const fmtLemb = (r) => {
            const d = new Date(r.scheduledAt);
            const dStr = toDateStr(d) === hoje ? 'Hoje' : 'Amanhã';
            return `• ${dStr} às ${pad(d.getHours())}:${pad(d.getMinutes())} — ${r.message}`;
          };
          contexto += `\n\n[AGENDA DO USUÁRIO - hoje e amanhã]\n${lembretes.map(fmtLemb).join('\n')}`;
        } else {
          contexto += `\n\n[AGENDA DO USUÁRIO]\nNenhum lembrete para hoje ou amanhã.`;
        }

        // Medicamentos ativos
        if (meds.length > 0) {
          const fmtMed = (m) => {
            let times = []; try { times = JSON.parse(m.times || '[]'); } catch {}
            const proxima = times.find(t => t >= hm) || times[0] || '—';
            const quando = times.find(t => t >= hm) ? 'hoje' : 'amanhã';
            return `• ${m.name} — próxima dose: ${proxima} (${quando}), ${m.remaining} doses restantes`;
          };
          contexto += `\n\n[MEDICAMENTOS DO USUÁRIO]\n${meds.map(fmtMed).join('\n')}`;
        }

        // Financeiro
        if (preferences.saldo != null) {
          const totalGasto = gastos.reduce((a, g) => a + g.value, 0);
          const restante = preferences.saldo - totalGasto;
          contexto += `\n\n[FINANCEIRO DO USUÁRIO]\nOrçamento mensal: R$ ${preferences.saldo.toFixed(2)}\nGasto este mês: R$ ${totalGasto.toFixed(2)}\nSaldo restante: R$ ${restante.toFixed(2)}`;
        }

        if (contexto) contexto = `\n\nUse as informações abaixo para responder com precisão quando o usuário perguntar sobre agenda, remédios ou finanças:${contexto}`;
      } catch (e) {
        console.error('[chat] Erro contexto:', e.message);
      }
    }

    const preferencesComContexto = { ...preferences, _contexto: contexto };

    // Executa classify e freeResponse em paralelo
    const [response, classified] = await Promise.all([
      freeResponse(message, history, preferencesComContexto, privateMode),
      privateMode ? Promise.resolve({ tipo: 'outro' }) : classify(message),
    ]);

    await memory.saveConversationMessage(user.id, 'user', message, privateMode);
    await memory.saveConversationMessage(user.id, 'assistant', response, privateMode);

    if (!privateMode) {
      executeActionFromChat(user, phone, classified, message).catch(e =>
        console.error('[chat] Erro bg action:', e.message)
      );
    }

    res.json({ reply: response, actionType: classified?.tipo || 'outro' });
  } catch (e) {
    console.error('Erro chat:', e.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
