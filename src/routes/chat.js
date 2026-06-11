const express = require('express');
const router = express.Router();
const { freeResponse, classify, extractPersonalInfo } = require('../services/groq');
const { searchWeb } = require('../services/groq');
const memory = require('../services/memory');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { buildPersonalContext, savePersonalInfo } = memory;

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
      case 'concluir_lembrete': {
        if (classified.titulo) {
          const lembretes = await prisma.reminder.findMany({
            where: { userId: user.id, confirmed: false, sent: false },
            orderBy: { scheduledAt: 'asc' }
          });
          const titulo = classified.titulo.toLowerCase();
          const match = lembretes.find(r =>
            r.message.toLowerCase().includes(titulo) ||
            titulo.includes(r.message.toLowerCase().substring(0, 10))
          ) || lembretes[0];
          if (match) {
            await prisma.reminder.update({ where: { id: match.id }, data: { confirmed: true, sent: true } });
            console.log(`[chat] Lembrete concluído: "${match.message}"`);
            return { lembreteId: match.id, lembreteTitulo: match.message };
          }
        }
        return null;
      }

      case 'gasto':
        if (classified.valor) {
          await memory.saveExpense(user.id, { valor: classified.valor, categoria: classified.categoria || 'outro', descricao: classified.descricao || classified.categoria });
        }
        return null;

      case 'saldo':
        if (classified.valor !== undefined && classified.valor !== null) {
          await memory.saveUserPreference(user.id, null, null, parseFloat(classified.valor));
        }
        return null;

      case 'preferencia':
        await memory.saveUserPreference(user.id, classified.nome, classified.tom, null);
        return null;

      case 'tarefa': {
        let scheduledAt = null;
        if (originalText) {
          const relativo = calcularHorarioRelativo(originalText);
          if (relativo) scheduledAt = relativo;
        }
        if (!scheduledAt && classified.hora) {
          const anoAtual = new Date().getFullYear();
          let dataUsada = classified.data || dateBRT();
          if (classified.data) {
            const anoData = new Date(classified.data + 'T12:00:00-03:00').getFullYear();
            if (anoData < anoAtual || anoData > anoAtual + 1) {
              console.warn(`[DATA_INVALIDA] chat titulo="${classified.titulo}" data="${classified.data}"`);
              dataUsada = dateBRT();
            }
          }
          const [h, m] = classified.hora.split(':').map(Number);
          scheduledAt = new Date(`${dataUsada}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00-03:00`);
          if (!classified.data && scheduledAt < nowBRT()) scheduledAt.setDate(scheduledAt.getDate() + 1);
        }
        if (scheduledAt && classified.titulo) {
          await prisma.reminder.create({ data: { userId: user.id, phone, message: classified.titulo, scheduledAt } });
          console.log(`[chat] Lembrete: "${classified.titulo}" → ${scheduledAt.toISOString()}`);
        }
        return null;
      }

      case 'medicamento':
        if (classified.nome) {
          await memory.saveMedication(user.id, { nome: classified.nome, quantidade: classified.quantidade || 0, frequencia: classified.frequencia || 1, horarios: classified.horarios || ['08:00'] });
        }
        return null;

      case 'anotacao':
        await memory.saveMemory(user.id, 'anotacao', classified.conteudo || classified.titulo || originalText, { titulo: classified.titulo });
        return null;

      case 'cidade':
        if (classified.cidade) await memory.saveMemory(user.id, 'cidade', classified.cidade);
        return null;

      case 'lista_buscar':
      case 'lista_compras': {
        if (classified.itens && classified.itens.length > 0) {
          const itemsJson = classified.itens.map((nome, i) => ({ id: i + 1, nome, done: false }));
          const lista = await prisma.groceryList.create({
            data: { userId: user.id, name: classified.nome || '🛒 Lista de compras', items: JSON.stringify(itemsJson), done: false }
          });
          await memory.saveMemory(user.id, 'ultima_lista', lista.id);
          return { listaId: lista.id, listaNome: lista.name, listaItems: itemsJson };
        }
        const mems = await memory.getRecentMemories(user.id, 20);
        const listaRef = mems.find(m => m.type === 'ultima_lista');
        if (listaRef) {
          const lista = await prisma.groceryList.findUnique({ where: { id: listaRef.content } });
          if (lista && !lista.done) {
            let items = []; try { items = JSON.parse(lista.items); } catch {}
            return { listaId: lista.id, listaNome: lista.name, listaItems: items };
          }
        }
        const listaRecente = await prisma.groceryList.findFirst({ where: { userId: user.id, done: false }, orderBy: { createdAt: 'desc' } });
        if (listaRecente) {
          let items = []; try { items = JSON.parse(listaRecente.items); } catch {}
          await memory.saveMemory(user.id, 'ultima_lista', listaRecente.id);
          return { listaId: listaRecente.id, listaNome: listaRecente.name, listaItems: items };
        }
        return null;
      }

      case 'lista_marcar': {
        const temNumeros = classified.numeros && classified.numeros.length > 0;
        const temNomes = classified.nomes && classified.nomes.length > 0;
        if (!temNumeros && !temNomes) return null;
        let lista = null;
        if (classified.lista) {
          const todas = await prisma.groceryList.findMany({ where: { userId: user.id, done: false } });
          lista = todas.find(l => l.name.toLowerCase().includes(classified.lista.toLowerCase()));
        }
        if (!lista) {
          const mems = await memory.getRecentMemories(user.id, 20);
          const ref = mems.find(m => m.type === 'ultima_lista');
          if (ref) lista = await prisma.groceryList.findUnique({ where: { id: ref.content } });
        }
        if (!lista) lista = await prisma.groceryList.findFirst({ where: { userId: user.id, done: false }, orderBy: { createdAt: 'desc' } });
        if (!lista) return null;
        let items = []; try { items = JSON.parse(lista.items); } catch {}
        if (temNumeros) items = items.map(i => classified.numeros.includes(i.id) ? { ...i, done: true } : i);
        if (temNomes) items = items.map(i => { const nm = i.nome.toLowerCase(); const hit = classified.nomes.some(n => nm.includes(n.toLowerCase()) || n.toLowerCase().includes(nm.split(' ')[0])); return hit ? { ...i, done: true } : i; });
        const allDone = items.every(i => i.done);
        await prisma.groceryList.update({ where: { id: lista.id }, data: { items: JSON.stringify(items), done: allDone } });
        return { listaId: lista.id, listaNome: lista.name, listaItems: items };
      }

      case 'lista_adicionar': {
        if (classified.item) {
          const mems2 = await memory.getRecentMemories(user.id, 20);
          const ref2 = mems2.find(m => m.type === 'ultima_lista');
          if (ref2) {
            const lista2 = await prisma.groceryList.findUnique({ where: { id: ref2.content } });
            if (lista2) {
              let items2 = []; try { items2 = JSON.parse(lista2.items); } catch {}
              const newId = items2.length > 0 ? Math.max(...items2.map(i => i.id)) + 1 : 1;
              items2.push({ id: newId, nome: classified.item, done: false });
              await prisma.groceryList.update({ where: { id: lista2.id }, data: { items: JSON.stringify(items2) } });
              return { listaId: lista2.id, listaNome: lista2.name, listaItems: items2 };
            }
          }
        }
        return null;
      }

      default:
        return null;
    }
  } catch (e) {
    console.error('[chat] Erro executeActionFromChat:', e.message);
    return null;
  }
}

const SYNC_ACTION_TYPES = ['lista_compras', 'lista_buscar', 'lista_marcar', 'lista_adicionar', 'concluir_lembrete', 'tarefa'];

router.post('/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const { message, privateMode } = req.body;
    if (!message) return res.status(400).json({ error: 'Mensagem vazia' });

    const user = await memory.getOrCreateUser(phone);
    const limit = privateMode ? 100 : 10;
    const history = await memory.getConversationHistory(user.id, limit);
    const preferences = await memory.getUserPreference(user.id);

    let contexto = '';
    let perfilPessoal = '';

    if (!privateMode) {
      try {
        const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
        const pad = n => String(n).padStart(2,'0');
        const hm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const toDateStr = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
        const hoje = toDateStr(now);
        const amanha = new Date(now); amanha.setDate(amanha.getDate()+1);
        const amanhaStr = toDateStr(amanha);
        const inicioHoje = new Date(`${hoje}T00:00:00-03:00`);
        const fimAmanha = new Date(`${amanhaStr}T23:59:59-03:00`);
        const inicioMes = new Date(now.getFullYear(), now.getMonth(), 1);

        const [lembretes, meds, gastos] = await Promise.all([
          prisma.reminder.findMany({ where: { userId: user.id, sent: false, confirmed: false, scheduledAt: { gte: inicioHoje, lte: fimAmanha } }, orderBy: { scheduledAt: 'asc' }, take: 20 }),
          prisma.medication.findMany({ where: { userId: user.id, active: true, remaining: { gt: 0 } } }),
          preferences.saldo != null ? prisma.expense.findMany({ where: { userId: user.id, createdAt: { gte: inicioMes } } }) : Promise.resolve([]),
        ]);
        perfilPessoal = await buildPersonalContext(user.id).catch(() => '');

        if (lembretes.length > 0) {
          const fmtLemb = (r) => {
            const d = new Date(r.scheduledAt);
            const dStr = toDateStr(d) === hoje ? 'Hoje' : 'Amanhã';
            return `• ${dStr} às ${pad(d.getHours())}:${pad(d.getMinutes())} — ${r.message}`;
          };
          contexto += `\n\n[AGENDA]\n${lembretes.map(fmtLemb).join('\n')}`;
        } else {
          contexto += `\n\n[AGENDA]\nNenhum lembrete para hoje ou amanhã.`;
        }

        if (meds.length > 0) {
          const fmtMed = (m) => {
            let times = []; try { times = JSON.parse(m.times || '[]'); } catch {}
            const proxima = times.find(t => t >= hm) || times[0] || '—';
            const quando = times.find(t => t >= hm) ? 'hoje' : 'amanhã';
            return `• ${m.name} — próxima dose: ${proxima} (${quando}), ${m.remaining} doses restantes`;
          };
          contexto += `\n\n[MEDICAMENTOS]\n${meds.map(fmtMed).join('\n')}`;
        }

        if (preferences.saldo != null) {
          const totalGasto = gastos.reduce((a, g) => a + g.value, 0);
          contexto += `\n\n[FINANCEIRO]\nOrçamento: R$ ${preferences.saldo.toFixed(2)}\nGasto: R$ ${totalGasto.toFixed(2)}\nSaldo: R$ ${(preferences.saldo - totalGasto).toFixed(2)}`;
        }

        if (contexto) contexto = `\n\nUse as informações abaixo quando relevante:${contexto}`;
        if (perfilPessoal) contexto += perfilPessoal;
      } catch (e) {
        console.error('[chat] Erro contexto:', e.message);
      }
    }

    // Classificar mensagem
    const classified = privateMode ? { tipo: 'outro' } : await classify(message, phone);
    let actionData = null;

    // ── BUSCA WEB — executar ANTES do freeResponse ──
    if (!privateMode && classified?.tipo === 'busca' && classified?.query) {
      try {
        console.log(`[chat] Busca web: "${classified.query}"`);
        const cidade = await prisma.memory.findFirst({ where: { userId: user.id, type: 'cidade' } }).catch(() => null);
        const locationContext = cidade?.content || '';
        const resultadoBusca = await searchWeb(classified.query, locationContext);
        if (resultadoBusca) {
          contexto += `\n\n[RESULTADO DA BUSCA — use isso para responder, são dados reais e atuais]\n${resultadoBusca}`;
          console.log(`[chat] Busca concluída para "${classified.query}"`);
        } else {
          contexto += `\n\n[BUSCA] Não encontrei resultados para "${classified.query}". Informe o usuário.`;
        }
      } catch (e) {
        console.error('[chat] Erro busca:', e.message);
        contexto += `\n\n[BUSCA] Erro ao buscar. Informe o usuário que não conseguiu pesquisar agora.`;
      }
    }

    // Ações síncronas (listas, lembretes, etc)
    if (!privateMode && SYNC_ACTION_TYPES.includes(classified?.tipo)) {
      actionData = await executeActionFromChat(user, phone, classified, message);
    }

    // Contexto adicional por tipo de ação
    if (actionData?.lembreteId) {
      contexto += `\n\n[AÇÃO] Lembrete "${actionData.lembreteTitulo}" marcado como concluído. Confirme naturalmente.`;
    }
    if (actionData?.lembreteUrgente) {
      contexto += `\n\n[AÇÃO] Lembrete urgente criado: "${actionData.lembreteTitulo}". Confirme que foi criado e pergunte de forma natural se quer ser avisado 15 minutos antes também. Seja breve e no seu tom habitual.`;
    }
    if (actionData?.listaId) {
      const itens = actionData.listaItems.map(i => `${i.id}. ${i.nome}`).join(', ');
      const foiCriada = classified?.tipo === 'lista_compras' && classified?.itens?.length > 0;
      contexto += foiCriada
        ? `\n\n[AÇÃO] Lista "${actionData.listaNome}" criada com: ${itens}. Confirme de forma animada sem listar itens.`
        : `\n\n[LISTA] Lista "${actionData.listaNome}": ${itens}. Apresente naturalmente sem listar itens.`;
    }

    const preferencesComContexto = { ...preferences, _contexto: contexto, _phone: phone };
    const response = await freeResponse(message, history, preferencesComContexto, privateMode);

    await memory.saveConversationMessage(user.id, 'user', message, privateMode);
    await memory.saveConversationMessage(user.id, 'assistant', response, privateMode);

    // Ações em background
    if (!privateMode) {
      extractPersonalInfo(message).then(async (infos) => {
        for (const { chave, valor, categoria } of (infos || [])) {
          if (!chave || !valor) continue;
          await savePersonalInfo(user.id, chave, valor, categoria || 'outro');
        }
      }).catch(() => {});

      if (!SYNC_ACTION_TYPES.includes(classified?.tipo) && classified?.tipo !== 'busca') {
        executeActionFromChat(user, phone, classified, message).catch(() => {});
      }
    }

    res.json({ reply: response, actionType: classified?.tipo || 'outro', actionData });
  } catch (e) {
    console.error('Erro chat:', e.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
