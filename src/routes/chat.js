const express = require('express');
const router = express.Router();
const { freeResponse, classify, extractPersonalInfo } = require('../services/groq');
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

// Retorna actionData para tipos de lista, null para os demais
async function executeActionFromChat(user, phone, classified, originalText) {
  try {
    switch (classified.tipo) {
      case 'concluir_lembrete': {
        // Busca lembrete pelo título e conclui
        if (classified.titulo) {
          const lembretes = await prisma.reminder.findMany({
            where: { userId: user.id, confirmed: false, sent: false },
            orderBy: { scheduledAt: 'asc' }
          });
          // Busca o lembrete mais parecido com o título
          const titulo = classified.titulo.toLowerCase();
          const match = lembretes.find(r =>
            r.message.toLowerCase().includes(titulo) ||
            titulo.includes(r.message.toLowerCase().substring(0, 10))
          ) || lembretes[0]; // fallback: conclui o mais próximo

          if (match) {
            await prisma.reminder.update({
              where: { id: match.id },
              data: { confirmed: true, sent: true }
            });
            console.log(`[chat] Lembrete concluído: "${match.message}"`);
            return { lembreteId: match.id, lembreteTitulo: match.message };
          }
        }
        return null;
      }

      case 'gasto':
        if (classified.valor) {
          await memory.saveExpense(user.id, {
            valor: classified.valor,
            categoria: classified.categoria || 'outro',
            descricao: classified.descricao || classified.categoria,
          });
          console.log(`[chat] Gasto salvo: R$${classified.valor} em ${classified.categoria}`);
        }
        return null;

      case 'saldo':
        if (classified.valor !== undefined && classified.valor !== null) {
          await memory.saveUserPreference(user.id, null, null, parseFloat(classified.valor));
          console.log(`[chat] Saldo salvo: R$${classified.valor}`);
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
        return null;
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
        return null;

      case 'anotacao':
        await memory.saveMemory(user.id, 'anotacao',
          classified.conteudo || classified.titulo || originalText,
          { titulo: classified.titulo }
        );
        console.log(`[chat] Anotação salva`);
        return null;

      case 'cidade':
        if (classified.cidade) {
          await memory.saveMemory(user.id, 'cidade', classified.cidade);
        }
        return null;

      case 'lista_buscar':
      case 'lista_compras': {
        // Se tem itens → criar lista nova
        if (classified.itens && classified.itens.length > 0) {
          const itemsJson = classified.itens.map((nome, i) => ({ id: i + 1, nome, done: false }));
          const lista = await prisma.groceryList.create({
            data: {
              userId: user.id,
              name: classified.nome || '🛒 Lista de compras',
              items: JSON.stringify(itemsJson),
              done: false,
            }
          });
          await memory.saveMemory(user.id, 'ultima_lista', lista.id);
          console.log(`[chat] Lista criada: ${lista.name} com ${itemsJson.length} itens`);
          return { listaId: lista.id, listaNome: lista.name, listaItems: itemsJson };
        }

        // Sem itens → buscar lista existente (última ou mais recente não concluída)
        const mems = await memory.getRecentMemories(user.id, 20);
        const listaRef = mems.find(m => m.type === 'ultima_lista');
        if (listaRef) {
          const lista = await prisma.groceryList.findUnique({ where: { id: listaRef.content } });
          if (lista && !lista.done) {
            let items = []; try { items = JSON.parse(lista.items); } catch {}
            console.log(`[chat] Lista encontrada: ${lista.name}`);
            return { listaId: lista.id, listaNome: lista.name, listaItems: items };
          }
        }
        // Fallback: pegar a lista ativa mais recente
        const listaRecente = await prisma.groceryList.findFirst({
          where: { userId: user.id, done: false },
          orderBy: { createdAt: 'desc' }
        });
        if (listaRecente) {
          let items = []; try { items = JSON.parse(listaRecente.items); } catch {}
          await memory.saveMemory(user.id, 'ultima_lista', listaRecente.id);
          console.log(`[chat] Lista recente encontrada: ${listaRecente.name}`);
          return { listaId: listaRecente.id, listaNome: listaRecente.name, listaItems: items };
        }
        return null;
      }

      case 'lista_marcar': {
        if (classified.numeros && classified.numeros.length > 0) {
          const mems = await memory.getRecentMemories(user.id, 20);
          const listaRef = mems.find(m => m.type === 'ultima_lista');
          if (listaRef) {
            const lista = await prisma.groceryList.findUnique({ where: { id: listaRef.content } });
            if (lista) {
              let items = []; try { items = JSON.parse(lista.items); } catch {}
              items = items.map(i => classified.numeros.includes(i.id) ? { ...i, done: true } : i);
              const allDone = items.every(i => i.done);
              await prisma.groceryList.update({
                where: { id: lista.id },
                data: { items: JSON.stringify(items), done: allDone }
              });
              return { listaId: lista.id, listaNome: lista.name, listaItems: items };
            }
          }
        }
        return null;
      }

      case 'lista_adicionar': {
        if (classified.item) {
          const mems2 = await memory.getRecentMemories(user.id, 20);
          const listaRef2 = mems2.find(m => m.type === 'ultima_lista');
          if (listaRef2) {
            const lista2 = await prisma.groceryList.findUnique({ where: { id: listaRef2.content } });
            if (lista2) {
              let items2 = []; try { items2 = JSON.parse(lista2.items); } catch {}
              const newId = items2.length > 0 ? Math.max(...items2.map(i => i.id)) + 1 : 1;
              items2.push({ id: newId, nome: classified.item, done: false });
              await prisma.groceryList.update({
                where: { id: lista2.id },
                data: { items: JSON.stringify(items2) }
              });
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

// Tipos que precisam retornar dados pro frontend — executados de forma síncrona
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

    // Monta contexto completo para a Clara
    let contexto = '';
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

        let perfilPessoal = '';
        let _perfilPessoal = '';
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
          }) : Promise.resolve([]),
        ]);
        _perfilPessoal = await buildPersonalContext(user.id).catch(() => '');

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

        if (meds.length > 0) {
          const fmtMed = (m) => {
            let times = []; try { times = JSON.parse(m.times || '[]'); } catch {}
            const proxima = times.find(t => t >= hm) || times[0] || '—';
            const quando = times.find(t => t >= hm) ? 'hoje' : 'amanhã';
            return `• ${m.name} — próxima dose: ${proxima} (${quando}), ${m.remaining} doses restantes`;
          };
          contexto += `\n\n[MEDICAMENTOS DO USUÁRIO]\n${meds.map(fmtMed).join('\n')}`;
        }

        if (preferences.saldo != null) {
          const totalGasto = gastos.reduce((a, g) => a + g.value, 0);
          const restante = preferences.saldo - totalGasto;
          contexto += `\n\n[FINANCEIRO DO USUÁRIO]\nOrçamento mensal: R$ ${preferences.saldo.toFixed(2)}\nGasto este mês: R$ ${totalGasto.toFixed(2)}\nSaldo restante: R$ ${restante.toFixed(2)}`;
        }

        if (contexto) contexto = `\n\nUse as informações abaixo para responder com precisão quando o usuário perguntar sobre agenda, remédios ou finanças:${contexto}`;
        perfilPessoal = _perfilPessoal;
      } catch (e) {
        console.error('[chat] Erro contexto:', e.message);
      }
    }

    let actionData = null;

    // Classificar a mensagem primeiro (necessário para saber se é lista antes de gerar resposta)
    const classified = privateMode ? { tipo: 'outro' } : await classify(message);

    // Para tipos de lista: executar ação ANTES de gerar a resposta,
    // assim a Clara sabe que a lista foi criada/atualizada e responde corretamente
    if (!privateMode && SYNC_ACTION_TYPES.includes(classified?.tipo)) {
      actionData = await executeActionFromChat(user, phone, classified, message);
    }

    // Perfil pessoal carregado no bloco de contexto
    if (perfilPessoal) contexto += perfilPessoal;

    // Adicionar instrução ao contexto quando for ação de lista
    // Contexto para concluir lembrete
    if (actionData?.lembreteId) {
      contexto += `\n\n[AÇÃO REALIZADA] O lembrete "${actionData.lembreteTitulo}" foi marcado como concluído com sucesso. Confirme ao usuário de forma natural.`;
    }

    // Contexto para tarefa/lembrete criado — evitar que a IA confunda com lembretes existentes
    if (classified.tipo === 'tarefa' && actionData) {
      const horaCriada = classified.hora || '';
      const dataCriada = classified.data || '';
      contexto += `\n\n[AÇÃO REALIZADA] Lembrete criado com sucesso: "${classified.titulo || classified.tarefa || text}" para ${dataCriada} às ${horaCriada}. IMPORTANTE: confirme EXATAMENTE esse horário ao usuário, não consulte nem mencione outros lembretes existentes.`;
    }

    if (actionData?.listaId) {
      const itensTexto = actionData.listaItems.map(i => `${i.id}. ${i.nome}`).join(', ');
      const foiCriada = classified?.tipo === 'lista_compras' && classified?.itens?.length > 0;
      if (foiCriada) {
        contexto += `\n\n[AÇÃO REALIZADA] A lista "${actionData.listaNome}" foi criada com sucesso com os itens: ${itensTexto}. Confirme ao usuário de forma natural e animada que a lista foi criada, sem listar os itens pois eles já aparecem visualmente.`;
      } else {
        contexto += `\n\n[LISTA ENCONTRADA] Encontrei a lista "${actionData.listaNome}" do usuário com os itens: ${itensTexto}. Apresente-a ao usuário de forma natural, sem listar os itens pois eles já aparecem visualmente no card.`;
      }
    }

    const preferencesComContexto = { ...preferences, _contexto: contexto };

    const response = await freeResponse(message, history, preferencesComContexto, privateMode);

    await memory.saveConversationMessage(user.id, 'user', message, privateMode);
    await memory.saveConversationMessage(user.id, 'assistant', response, privateMode);

    // Extração de memória pessoal em background
    if (!privateMode) {
      extractPersonalInfo(message).then(async (infos) => {
        for (const { chave, valor, categoria } of (infos || [])) {
          if (!chave || !valor) continue;
          await savePersonalInfo(user.id, chave, valor, categoria || 'outro');
          console.log(`[memória pessoal web] ${chave} = "${valor}"`);
        }
      }).catch(e => console.error('[extract pessoal web]', e.message));
    }

    if (!privateMode && !SYNC_ACTION_TYPES.includes(classified?.tipo)) {
      // Demais ações rodam em background sem bloquear a resposta
      executeActionFromChat(user, phone, classified, message).catch(e =>
        console.error('[chat] Erro bg action:', e.message)
      );
    }

    res.json({ reply: response, actionType: classified?.tipo || 'outro', actionData });
  } catch (e) {
    console.error('Erro chat:', e.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
