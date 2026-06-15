const { classify, extractPersonalInfo, searchWeb, freeResponse, generateMemorySummary, generateRelationshipSummary, ativarModoComparacao, desativarModoComparacao, emModoComparacao, detectarComandoComparacao } = require('./groq');
const { sendMessage, sendButtons, sendReminderWithButtons } = require('./whatsapp');
const memory = require('./memory');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { buildPersonalContext, savePersonalInfo, saveContact, getContacts, findContactByName } = memory;

const MENU = `✨ *Oi, eu sou a Clara.*

Posso cuidar de lembretes, anotações, gastos, saúde, ponto e pesquisas rápidas.

Você pode tocar em uma opção ou escrever do seu jeito:
- _"me lembra de tomar remédio às 22h"_
- _"gastei 42 reais no mercado"_
- _"cheguei às 9h no trabalho"_
- _"qual foi a senha do Wi-Fi?"_

O que vamos resolver agora?`;

const MENU_BUTTONS = [
  { id: 'criar_lembrete', label: '⏰ Lembrete' },
  { id: 'nova_anotacao', label: '📝 Anotação' },
  { id: 'novo_gasto', label: '💰 Gasto' },
  { id: 'bater_ponto', label: '📍 Ponto' },
  { id: 'pesquisar', label: '🔍 Pesquisa' },
  { id: 'conversar', label: '💬 Conversar' },
];

const BOAS_VINDAS_MODO = {
  'lembrete':  `⏰ *Lembretes*\n\nPosso te lembrar de qualquer compromisso!\n\nExemplos:\n• _"Me lembra às 19h de buscar minha filha"_\n• _"Lembrete amanhã às 8h de tomar remédio"_\n\n_É só me dizer!_ 😊`,
  'anotacao':  `📝 *Anotações*\n\nGuardo qualquer informação pra você!\n\nExemplos:\n• _"Senha do Wi-Fi: 12345"_\n• _"Código do cliente: ABC123"_\n\n_O que quer guardar?_ 😊`,
  'gasto':     `💰 *Gastos*\n\nRegistro tudo e te mostro resumo do mês!\n\nExemplos:\n• _"Gastei 45 reais no mercado"_\n• _"Quanto gastei esse mês?"_\n\n_Me conta seu gasto!_ 💸`,
  'saude':     `💊 *Saúde*\n\nCuido dos seus remédios!\n\nExemplos:\n• _"Tomo Losartana todo dia às 8h"_\n• _"Vitamina C às 9h e às 21h"_\n\n_Qual medicamento?_ 😊`,
  'ponto':     `📍 *Ponto Digital*\n\nRegistro sua jornada!\n\nExemplos:\n• _"Entrei às 8:15"_\n• _"Saí pra almoçar às 12:30"_\n\n_Pode me dizer!_ 📍`,
  'pesquisar': `🔍 *Pesquisar*\n\nBusco qualquer coisa na internet!\n\n_O que quer pesquisar?_ ✨`,
  'conversar': `💬 *Conversar*\n\nAdoro uma boa conversa! Pode falar à vontade 😄`,
};

const LISTA_TIPOS = ['lista_compras', 'lista_buscar', 'lista_marcar', 'lista_adicionar'];
const CONTATO_TIPOS = ['salvar_contato', 'deletar_contato', 'enviar_mensagem', 'enviar_mensagem_agendada'];

function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function dateBRT() {
  const d = nowBRT();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function minutesToHours(minutes) {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return `${h}h${m > 0 ? m + 'min' : ''}`;
}

function horaStr(date) {
  if (!date) return '—';
  const d = new Date(date);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatarDataBR(date) {
  if (!date) return '—';
  const d = new Date(date);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function formatarDataHoraBR(date) {
  if (!date) return '—';
  const d = new Date(date);
  const hoje = nowBRT();
  const amanha = new Date(hoje); amanha.setDate(amanha.getDate() + 1);
  const hStr = horaStr(d);
  if (d.toDateString() === hoje.toDateString()) return `Hoje às ${hStr}`;
  if (d.toDateString() === amanha.toDateString()) return `Amanhã às ${hStr}`;
  const dias = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  return `${dias[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1} às ${hStr}`;
}

function calcularHorarioRelativo(texto) {
  const t = (texto || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // IMPORTANTE: usar Date.now() (epoch UTC real) + delta em ms, e NUNCA
  // nowBRT() + setMinutes/setHours. nowBRT() retorna um Date cujo valor
  // interno (epoch) está deslocado pelo offset entre o timezone do
  // servidor e America/Sao_Paulo — somar minutos/horas em cima dele
  // preserva (e propaga) esse deslocamento, gerando horários errados
  // (ex: "daqui 30 minutos" às 14:09 virando 11:39).
  const minMatch = t.match(/daqui\s+(\d+)\s*(min|minuto|minutos)/);
  if (minMatch) return new Date(Date.now() + parseInt(minMatch[1]) * 60 * 1000);
  const hrMatch = t.match(/daqui\s+(\d+)\s*(h|hora|horas)/);
  if (hrMatch) return new Date(Date.now() + parseInt(hrMatch[1]) * 60 * 60 * 1000);
  const emMinMatch = t.match(/em\s+(\d+)\s*(min|minuto|minutos)/);
  if (emMinMatch) return new Date(Date.now() + parseInt(emMinMatch[1]) * 60 * 1000);
  const emHrMatch = t.match(/em\s+(\d+)\s*(h|hora|horas)/);
  if (emHrMatch) return new Date(Date.now() + parseInt(emHrMatch[1]) * 60 * 60 * 1000);
  return null;
}

async function getModoAtual(userId) {
  const mems = await memory.getRecentMemories(userId, 10);
  return mems.find(m => m.type === 'modo_atual')?.content || null;
}

function normalizar(text) {
  return (text || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Extrai um código curto de lembrete do texto do usuário (ex: "#1", "feito 2",
// "concluí o 1", "número 3"). Retorna o número (1-indexed) ou null se não
// encontrar. Usado para desambiguar quando múltiplos lembretes foram
// disparados juntos e o usuário confirma um específico por número.
function extrairCodigoLembrete(texto) {
  const t = normalizar(texto);
  // "#1", "# 1"
  let m = t.match(/#\s*(\d{1,2})\b/);
  if (m) return parseInt(m[1]);
  // "numero 1", "número 2", "item 3"
  m = t.match(/(?:numero|número|item)\s*(\d{1,2})\b/);
  if (m) return parseInt(m[1]);
  // texto é só um número isolado (ex: "1", "2")
  m = t.match(/^(\d{1,2})$/);
  if (m) return parseInt(m[1]);
  // "feito o 1", "feito 2", "concluí o 1", "fiz o 2", "marca o 1"
  m = t.match(/(?:feito|conclui|concluido|concluí|fiz|marca|marquei|pronto)\s*(?:o|a)?\s*(\d{1,2})\b/);
  if (m) return parseInt(m[1]);
  return null;
}

// Busca os lembretes "recém-disparados" aguardando confirmação (sent=true,
// confirmed=false), ordenados por scheduledAt asc — mesma ordem usada pelo
// scheduler ao numerá-los (#1, #2...) na mensagem de disparo múltiplo.
async function getLembretesPendentesConfirmacao(userId) {
  return prisma.reminder.findMany({
    where: { userId, sent: true, confirmed: false },
    orderBy: { scheduledAt: 'asc' }
  });
}

async function enviarMenu(phone) {
  return sendButtons(phone, MENU, MENU_BUTTONS);
}

async function executeListaAction(user, phone, classified) {
  try {
    const tipo = classified.tipo;
    if ((tipo === 'lista_compras') && classified.itens && classified.itens.length > 0) {
      const itemsJson = classified.itens.map((nome, i) => ({ id: i + 1, nome, done: false }));
      const lista = await prisma.groceryList.create({
        data: { userId: user.id, name: classified.nome || '🛒 Lista de compras', items: JSON.stringify(itemsJson), done: false }
      });
      await memory.saveMemory(user.id, 'ultima_lista', lista.id);
      return { acao: 'criada', listaNome: lista.name, listaItems: itemsJson };
    }
    if (tipo === 'lista_buscar' || (tipo === 'lista_compras' && (!classified.itens || classified.itens.length === 0))) {
      const mems = await memory.getRecentMemories(user.id, 20);
      const listaRef = mems.find(m => m.type === 'ultima_lista');
      if (listaRef) {
        const lista = await prisma.groceryList.findUnique({ where: { id: listaRef.content } });
        if (lista && !lista.done) {
          let items = []; try { items = JSON.parse(lista.items); } catch {}
          return { acao: 'encontrada', listaNome: lista.name, listaItems: items };
        }
      }
      const listaRecente = await prisma.groceryList.findFirst({ where: { userId: user.id, done: false }, orderBy: { createdAt: 'desc' } });
      if (listaRecente) {
        let items = []; try { items = JSON.parse(listaRecente.items); } catch {}
        await memory.saveMemory(user.id, 'ultima_lista', listaRecente.id);
        return { acao: 'encontrada', listaNome: listaRecente.name, listaItems: items };
      }
      return { acao: 'nenhuma', listaNome: null, listaItems: [] };
    }
    if (tipo === 'lista_marcar') {
      const temNumeros = classified.numeros && classified.numeros.length > 0;
      const temNomes = classified.nomes && classified.nomes.length > 0;
      if (!temNumeros && !temNomes) return null;
      let lista = null;
      if (classified.lista) {
        const nomeLista = classified.lista.toLowerCase();
        const todasListas = await prisma.groceryList.findMany({ where: { userId: user.id, done: false } });
        lista = todasListas.find(l => l.name.toLowerCase().includes(nomeLista));
      }
      if (!lista) {
        const mems = await memory.getRecentMemories(user.id, 20);
        const listaRef = mems.find(m => m.type === 'ultima_lista');
        if (listaRef) lista = await prisma.groceryList.findUnique({ where: { id: listaRef.content } });
      }
      if (!lista) lista = await prisma.groceryList.findFirst({ where: { userId: user.id, done: false }, orderBy: { createdAt: 'desc' } });
      if (!lista) return null;
      let items = []; try { items = JSON.parse(lista.items); } catch {}
      if (temNumeros) items = items.map(i => classified.numeros.includes(i.id) ? { ...i, done: true } : i);
      if (temNomes) {
        items = items.map(i => {
          const nomeItem = i.nome.toLowerCase();
          const match = classified.nomes.some(n => nomeItem.includes(n.toLowerCase()) || n.toLowerCase().includes(nomeItem.split(' ')[0]));
          return match ? { ...i, done: true } : i;
        });
      }
      const allDone = items.every(i => i.done);
      await prisma.groceryList.update({ where: { id: lista.id }, data: { items: JSON.stringify(items), done: allDone } });
      await memory.saveMemory(user.id, 'ultima_lista', lista.id);
      return { acao: 'marcada', listaNome: lista.name, listaItems: items, allDone };
    }
    if (tipo === 'lista_adicionar' && classified.item) {
      const mems2 = await memory.getRecentMemories(user.id, 20);
      const listaRef2 = mems2.find(m => m.type === 'ultima_lista');
      if (listaRef2) {
        const lista2 = await prisma.groceryList.findUnique({ where: { id: listaRef2.content } });
        if (lista2) {
          let items2 = []; try { items2 = JSON.parse(lista2.items); } catch {}
          const newId = items2.length > 0 ? Math.max(...items2.map(i => i.id)) + 1 : 1;
          items2.push({ id: newId, nome: classified.item, done: false });
          await prisma.groceryList.update({ where: { id: lista2.id }, data: { items: JSON.stringify(items2) } });
          return { acao: 'adicionado', listaNome: lista2.name, listaItems: items2, itemAdicionado: classified.item };
        }
      }
      return null;
    }
    return null;
  } catch (e) {
    console.error(`[${phone}] Erro executeListaAction:`, e.message);
    return null;
  }
}

function formatarListaWhatsApp(listaResult) {
  if (!listaResult || !listaResult.listaItems) return '';
  const { listaNome, listaItems } = listaResult;
  const itens = listaItems.map(i => `${i.done ? '✅' : '⬜'} ${i.id}. ${i.nome}`).join('\n');
  const done = listaItems.filter(i => i.done).length;
  return `🛒 *${listaNome}*\n\n${itens}\n\n_${done}/${listaItems.length} itens marcados_`;
}

async function responderLivre(user, phone, text, contextoExtra = '', skipContext = false, acaoConfirmacao = null) {
  try {
    const history = await memory.getConversationHistory(user.id, 10);
    const preferences = await memory.getUserPreference(user.id);
    preferences._phone = phone;

    if (acaoConfirmacao) preferences._acaoConfirmacao = acaoConfirmacao;

    if (skipContext) {
      preferences._contexto = '';
      const resp = await freeResponse(text, history, preferences);
      if (resp === null) return; // modo direto: já avisado, não responde
      await memory.saveConversationMessage(user.id, 'user', text);
      await memory.saveConversationMessage(user.id, 'assistant', resp);
      await sendMessage(phone, resp);
      return;
    }

    let contexto = '';
    try {
      const now = nowBRT();
      const pad = n => String(n).padStart(2,'0');
      const hm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
      const toDateStr = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
      const hoje = toDateStr(now);
      const amanha = new Date(now); amanha.setDate(amanha.getDate()+1);
      const amanhaStr = toDateStr(amanha);
      const inicioHoje = new Date(`${hoje}T00:00:00-03:00`);
      const fimAmanha = new Date(`${amanhaStr}T23:59:59-03:00`);
      const inicioMes = new Date(now.getFullYear(), now.getMonth(), 1);

      const [lembretes, meds, gastos, perfilPessoal, relMemoria] = await Promise.all([
        prisma.reminder.findMany({
          where: { userId: user.id, sent: false, confirmed: false, scheduledAt: { gte: inicioHoje, lte: fimAmanha } },
          orderBy: { scheduledAt: 'asc' }, take: 20
        }),
        prisma.medication.findMany({ where: { userId: user.id, active: true, remaining: { gt: 0 } } }),
        preferences.saldo != null ? prisma.expense.findMany({ where: { userId: user.id, createdAt: { gte: inicioMes } } }) : Promise.resolve([]),
        buildPersonalContext(user.id).catch(() => ''),
        prisma.memory.findFirst({ where: { userId: user.id, type: 'relationship_summary' }, orderBy: { createdAt: 'desc' } }).catch(() => null)
      ]);

      if (lembretes.length > 0) {
        const fmtLemb = (r) => {
          const d = new Date(r.scheduledAt);
          const dStr = toDateStr(d) === hoje ? 'Hoje' : 'Amanhã';
          const horaBRT = d.toLocaleTimeString('pt-BR', {timeZone:'America/Sao_Paulo', hour:'2-digit', minute:'2-digit'});
          return `• ${dStr} às ${horaBRT} — ${r.message}`;
        };
        contexto += `\n\n[AGENDA]\n${lembretes.map(fmtLemb).join('\n')}`;
      } else {
        contexto += `\n\n[AGENDA]\nNenhum lembrete para hoje ou amanhã.`;
      }

      try {
        const textLower = (text||'').toLowerCase();
        if (/envi|mand|recado|contato|mostr|lista/.test(textLower)) {
          const contatos = await getContacts(user.id);
          if (contatos.length > 0) {
            const listaCtx = contatos.map((c,i) => `${i+1}. ${c.name}${c.relation?` (${c.relation})`:''} — ${c.phone}`).join('\n');
            contexto += `\n\n[CONTATOS SALVOS]\n${listaCtx}`;
          }
        }
      } catch(e) {}

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
        const saidas = gastos.filter(g => g.value > 0);
        const entradas = gastos.filter(g => g.value < 0);
        const totalGasto = saidas.reduce((a, g) => a + g.value, 0);
        const totalEntradas = entradas.reduce((a, g) => a + Math.abs(g.value), 0);
        const restante = preferences.saldo - totalGasto + totalEntradas;
        contexto += `\n\n[FINANCEIRO]\nOrçamento: R$ ${preferences.saldo.toFixed(2)}\nGasto: R$ ${totalGasto.toFixed(2)}\nEntradas: R$ ${totalEntradas.toFixed(2)}\nSaldo: R$ ${restante.toFixed(2)}`;
      }

      // Listas ativas — evita Clara inventar listas
      try {
        const listas = await prisma.groceryList.findMany({
          where: { userId: user.id, done: false },
          orderBy: { createdAt: 'desc' }, take: 5
        });
        if (listas.length > 0) {
          const listaCtx = listas.map(l => {
            let items = []; try { items = JSON.parse(l.items); } catch {}
            const pendentes = items.filter(i => !i.done).map(i => i.nome).join(', ');
            const done = items.filter(i => i.done).length;
            return `• "${l.name}" — ${done}/${items.length} concluídos${pendentes ? ` | Pendentes: ${pendentes}` : ' ✅'}`;
          }).join('\n');
          contexto += `\n\n[LISTAS ATIVAS]\n${listaCtx}`;
        } else {
          contexto += `\n\n[LISTAS ATIVAS]\nNenhuma lista ativa.`;
        }
      } catch(e) {}

      if (relMemoria?.content) contexto += `\n\n[MEMÓRIA DO RELACIONAMENTO]\n${relMemoria.content}`;
      if (contexto) contexto = `\n\nUse as informações abaixo para responder com precisão:${contexto}`;
      if (perfilPessoal) contexto += perfilPessoal;
      if (contextoExtra) contexto += contextoExtra;
      preferences._contexto = contexto;
    } catch (e) {
      console.error(`[${phone}] Erro contexto:`, e.message);
    }

    const resp = await freeResponse(text, history, preferences);
    if (resp === null) return; // modo direto: já avisado, não responde
    await memory.saveConversationMessage(user.id, 'user', text);
    await memory.saveConversationMessage(user.id, 'assistant', resp);
    await sendMessage(phone, resp);
    updateRelationshipSummary(user.id, history, resp).catch(() => {});
  } catch (e) {
    console.error(`[${phone}] Erro responderLivre:`, e.message);
    await sendMessage(phone, 'Ops, tive um probleminha. Pode repetir?');
  }
}

async function handleMessage(phone, text, location = null) {
  try {
    const user = await memory.getOrCreateUser(phone);

    if (location && location.latitude) {
      await memory.saveMemory(user.id, 'localizacao', JSON.stringify({ latitude: location.latitude, longitude: location.longitude, updatedAt: new Date().toISOString() }));
      return await sendMessage(phone, '✅ Localização recebida! Agora posso te ajudar melhor com clima, farmácias e lojas próximas.');
    }

    if (!text) return;

    const textLower = normalizar(text);

    // ── Comando interno: ativa/desativa modo comparação (Gemini manual) ──
    const comandoComparacao = detectarComandoComparacao(text);
    if (comandoComparacao === 'on') {
      ativarModoComparacao(phone);
      return await sendMessage(phone, '🔄 Modo comparação ativado — vou responder usando o Gemini agora. Diga "volta pro Groq" quando quiser voltar ao normal.');
    }
    if (comandoComparacao === 'off') {
      const estava = emModoComparacao(phone);
      desativarModoComparacao(phone);
      if (estava) return await sendMessage(phone, '✅ Voltei pro Groq — fluxo normal (com os fallbacks de sempre).');
      // já não estava em modo comparação — segue o fluxo normal sem responder isso
    }

    const foiConfirmacao = await checkConfirmacaoPendente(user, phone, text);
    if (foiConfirmacao) return;

    // ── Confirmação de lembrete por código curto (#1, #2, "feito o 1"...) ──
    // Intercepta ANTES do classify (LLM): se o usuário citou um código e há
    // lembretes recém-disparados aguardando confirmação, marca direto o
    // correspondente como concluído — evita depender do LLM classificar
    // corretamente uma resposta curta e ambígua, e evita o problema de
    // "arrastei a conversa e ela confirmou o último" quando há vários.
    {
      const codigoRapido = extrairCodigoLembrete(text);
      if (codigoRapido) {
        const pendentes = await getLembretesPendentesConfirmacao(user.id);
        if (pendentes.length > 0) {
          const escolhido = pendentes[codigoRapido - 1];
          if (escolhido) {
            await prisma.reminder.update({ where: { id: escolhido.id }, data: { confirmed: true } });
            await sendMessage(phone, `✅ Marquei como feito: "${escolhido.message}" 📌`);
            return;
          } else {
            await sendMessage(phone, `Não achei o lembrete #${codigoRapido} 😕 Você tem ${pendentes.length} pendente${pendentes.length > 1 ? 's' : ''} (#1 a #${pendentes.length}).`);
            return;
          }
        }
      }
    }

    if (['menu','inicio','voltar','comeco','ajuda','opcoes'].includes(textLower)) {
      await memory.saveMemory(user.id, 'modo_atual', '');
      return await enviarMenu(phone);
    }

    if (['ver lembretes','ver_lembretes'].includes(textLower)) return await listarLembretes(user, phone);
    if (['ver anotacoes','ver_anotacoes'].includes(textLower)) return await listarAnotacoes(user, phone);
    if (['ver gastos','ver_gastos','resumo_mes','relatorio','relatorio do mes','relatorio financeiro'].includes(textLower)) return await listarGastos(user, phone);
    if (['ver horas hoje','ver_horas_hoje'].includes(textLower)) return await listarPontoHoje(user, phone);
    if (['ver medicamentos','ver_medicamentos'].includes(textLower)) return await listarMedicamentos(user, phone);

    const modoMap = {
      'lembretes':'lembrete','lembrete':'lembrete','criar_lembrete':'lembrete','novo_lembrete':'lembrete',
      'anotacoes':'anotacao','anotacao':'anotacao','nova_anotacao':'anotacao',
      'gastos':'gasto','gasto':'gasto','novo_gasto':'gasto',
      'saude':'saude','novo_remedio':'saude',
      'ponto digital':'ponto','ponto':'ponto','bater_ponto':'ponto',
      'pesquisar algo':'pesquisar','pesquisar':'pesquisar','pesquisa':'pesquisar',
      'conversar':'conversar','bater papo':'conversar',
    };

    if (modoMap[textLower]) {
      const modo = modoMap[textLower];
      await memory.saveMemory(user.id, 'modo_atual', modo);
      return await sendMessage(phone, BOAS_VINDAS_MODO[modo]);
    }

    const modoAtual = await getModoAtual(user.id);

    if (modoAtual === 'anotacao') {
      await memory.saveMemory(user.id, 'anotacao', text, { titulo: text.substring(0, 50) });
      return await sendButtons(phone,
        `📝 *Anotação salva!*\n\n_"${text}"_\n\nGuardei isso aqui com segurança 💜`,
        [{ id: 'ver_anotacoes', label: '📋 Ver anotações' }, { id: 'menu', label: '🏠 Menu' }]
      );
    }

    if (modoAtual === 'conversar') return await responderLivre(user, phone, text);

    // ── Passa contexto da conversa para o classify resolver referências vagas ──
    let contextoClassify = '';
    try {
      const history = await memory.getConversationHistory(user.id, 4);
      if (history.length > 0) {
        contextoClassify = history.map(m => `${m.role === 'user' ? 'Usuário' : 'Clara'}: ${m.content}`).join('\n');
      }
    } catch(e) {}

    const classified = await classify(text, phone, contextoClassify);
    console.log(`[${phone}] Tipo: ${classified.tipo}`);

    // ── Intercepta: lista_marcar com hora → editar_lembrete ──
    if (classified.tipo === 'lista_marcar' && (classified.nova_hora || classified.nova_data)) {
      classified.tipo = 'editar_lembrete';
    }

    if (LISTA_TIPOS.includes(classified.tipo)) {
      const listaResult = await executeListaAction(user, phone, classified);
      let contextoExtra = '';
      if (listaResult) {
        const { acao, listaNome, listaItems, allDone, itemAdicionado } = listaResult;
        if (acao === 'criada') contextoExtra = `\n\n[AÇÃO REALIZADA] Acabei de criar a lista "${listaNome}" com os itens: ${listaItems.map(i=>i.nome).join(', ')}. Confirme de forma animada. Não liste os itens pois aparecem separadamente.`;
        else if (acao === 'encontrada') contextoExtra = `\n\n[LISTA ENCONTRADA] Lista "${listaNome}" com: ${listaItems.map(i=>`${i.done?'✅':'⬜'} ${i.nome}`).join(', ')}. Apresente naturalmente.`;
        else if (acao === 'nenhuma') contextoExtra = `\n\n[SEM LISTA] Usuário não tem lista ativa. Informe e ofereça criar uma.`;
        else if (acao === 'marcada') contextoExtra = `\n\n[AÇÃO REALIZADA] Marquei itens na lista "${listaNome}".${allDone?' Todos concluídos! 🎉':''} Confirme.`;
        else if (acao === 'adicionado') contextoExtra = `\n\n[AÇÃO REALIZADA] Adicionei "${itemAdicionado}" à lista "${listaNome}". Confirme.`;
        await responderLivre(user, phone, text, contextoExtra);
        if (['criada','encontrada','adicionado','marcada'].includes(acao) && listaItems.length > 0) {
          await sendMessage(phone, formatarListaWhatsApp(listaResult));
        }
      } else {
        await responderLivre(user, phone, text, `\n\n[SEM LISTA] Não foi possível encontrar/criar lista. Informe o usuário.`);
      }
      extractAndSavePersonalInfo(user.id, text).catch(e => console.error('[extract lista]', e.message));
      return;
    }

    if (CONTATO_TIPOS.includes(classified.tipo)) {
      await handleContatoAction(user, phone, classified);
      extractAndSavePersonalInfo(user.id, text).catch(() => {});
      return;
    }

    if (classified.tipo === 'busca' && classified.query) {
      const cidade = await memory.getRecentMemories(user.id, 5)
        .then(mems => mems.find(m => m.type === 'cidade')?.content || '')
        .catch(() => '');
      const resultadoBusca = await searchWeb(classified.query, cidade);
      if (resultadoBusca) {
        await memory.saveConversationMessage(user.id, 'user', text);
        await memory.saveConversationMessage(user.id, 'assistant', resultadoBusca);
        await sendMessage(phone, resultadoBusca);
        extractAndSavePersonalInfo(user.id, text).catch(() => {});
        return;
      }
      await responderLivre(user, phone, text, `\n\n[BUSCA] Não encontrei resultados para "${classified.query}". Informe de forma curta que não encontrou nada.`, false);
      return;
    }

    if (classified.tipo === 'relatorio_financeiro' || classified.tipo === 'consulta_saldo') {
      await gerarRelatorioFinanceiroWhatsApp(user, phone);
      return;
    }

    // ── editar_lembrete e deletar_lembrete: executa sem responderLivre depois ──
    if (classified.tipo === 'editar_lembrete') {
      await editarLembrete(user, phone, classified, contextoClassify, text);
      return;
    }
    if (classified.tipo === 'deletar_lembrete') {
      await deletarLembretePorTitulo(user, phone, classified);
      return;
    }

    // ── tarefa com DATA mas SEM HORA: pergunta o horário ao usuário ──
    // em vez de criar o lembrete silenciosamente ou responder "Anotado"
    // sem que nada tenha sido salvo de fato.
    if (classified.tipo === 'tarefa' && classified.data && !classified.hora && !calcularHorarioRelativo(text)) {
      const expira = Date.now() + 10 * 60 * 1000;
      await prisma.memory.create({
        data: {
          userId: user.id, type: 'confirmacao_pendente',
          content: JSON.stringify({ tipo: 'hora_lembrete', titulo: classified.titulo, data: classified.data, expira })
        }
      }).catch(() => {});
      const dataFmt = new Date(`${classified.data}T12:00:00-03:00`).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
      await sendMessage(phone, `Anotado: "${classified.titulo}" no dia ${dataFmt} 📌\n\nQue horas devo colocar esse lembrete? Se não souber, me diz que eu deixo às 09:00 provisoriamente 😊`);
      await memory.saveMemory(user.id, 'tarefa', classified.titulo, { data: classified.data, hora: null });
      extractAndSavePersonalInfo(user.id, text).catch(e => console.error('[extract pessoal]', e.message));
      return;
    }

    executeAction(user, phone, classified, text).catch(e => console.error('Erro executeAction:', e.message));
    const isSaudacao = classified.tipo === 'saudacao';

    // Tipos estruturados que executam uma ação concreta (criar lembrete, gasto, etc) —
    // usados para dar confirmação fixa caso o bate-papo livre esteja em modo direto
    let confirmacaoTarefa = '✅ Anotado! Vou te lembrar.';
    if (classified.tipo === 'tarefa' && classified.hora) {
      // Calcula o mesmo scheduledAt que salvarTarefaSilenciosa vai gravar,
      // para dar uma confirmação com data/hora reais — igual ao formato
      // "Pronto! '...' agendado pra DD/MM às HH:MM 📌" usado em outros fluxos
      // (ex: checkConfirmacaoPendente, tipo hora_lembrete).
      try {
        let scheduledAt = calcularHorarioRelativo(text);
        if (!scheduledAt) {
          const hoje = dateBRT();
          let dataUsada = hoje;
          if (classified.data) {
            const dataObj = new Date(classified.data + 'T12:00:00-03:00');
            const anoClassify = dataObj.getFullYear();
            const anoAtual = new Date().getFullYear();
            if (anoClassify >= anoAtual && anoClassify <= anoAtual + 1) dataUsada = classified.data;
          }
          const [h, m] = classified.hora.split(':').map(Number);
          scheduledAt = new Date(`${dataUsada}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00-03:00`);
          if (!classified.data && scheduledAt < nowBRT()) { scheduledAt.setDate(scheduledAt.getDate() + 1); }
        }
        const dataFmt = scheduledAt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
        const horaFmt = scheduledAt.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
        confirmacaoTarefa = `✅ Pronto! "${classified.titulo}" agendado pra ${dataFmt} às ${horaFmt} 📌`;
      } catch (e) {
        // mantém fallback genérico em caso de erro de parsing
      }
    }

    const CONFIRMACOES_ACAO = {
      tarefa: confirmacaoTarefa,
      gasto: '✅ Gasto registrado!',
      entrada_financeira: '✅ Entrada registrada!',
      medicamento: '✅ Medicamento cadastrado!',
      anotacao: '✅ Anotado!',
    };
    const acaoConfirmacao = CONFIRMACOES_ACAO[classified.tipo] || null;

    await responderLivre(user, phone, text, '', isSaudacao, acaoConfirmacao);
    extractAndSavePersonalInfo(user.id, text).catch(e => console.error('[extract pessoal]', e.message));
  } catch (error) {
    console.error('Erro handleMessage:', error.message);
    await sendMessage(phone, 'Ops, tive um probleminha. Pode repetir?');
  }
}

async function gerarRelatorioFinanceiroWhatsApp(user, phone) {
  try {
    const now = nowBRT();
    const inicioMes = new Date(now.getFullYear(), now.getMonth(), 1);
    const preferences = await memory.getUserPreference(user.id);
    const gastos = await prisma.expense.findMany({ where: { userId: user.id, createdAt: { gte: inicioMes } }, orderBy: { createdAt: 'desc' } });
    const saidas = gastos.filter(g => g.value > 0);
    const entradas = gastos.filter(g => g.value < 0);
    const totalGasto = saidas.reduce((a, g) => a + g.value, 0);
    const totalEntradas = entradas.reduce((a, g) => a + Math.abs(g.value), 0);
    const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const nomeMes = meses[now.getMonth()];
    const catIcones = { alimentacao:'🍔', mercado:'🛒', transporte:'🚗', saude:'💊', lazer:'🎮', moradia:'🏠', educacao:'📚', entrada:'💰', outro:'📦' };
    const porCategoria = {};
    saidas.forEach(g => { const cat = g.category || 'outro'; if (!porCategoria[cat]) porCategoria[cat] = 0; porCategoria[cat] += g.value; });
    let texto = `📊 *Relatório de ${nomeMes}*\n\n`;
    if (entradas.length > 0) texto += `💰 *Entradas:* R$ ${totalEntradas.toFixed(2)}\n`;
    texto += `💸 *Total gasto:* R$ ${totalGasto.toFixed(2)}\n`;
    if (preferences.saldo != null) { const saldo = preferences.saldo - totalGasto + totalEntradas; texto += `💵 *Saldo restante:* R$ ${saldo.toFixed(2)}\n`; }
    texto += `\n`;
    if (Object.keys(porCategoria).length > 0) {
      texto += `*Por categoria:*\n`;
      Object.entries(porCategoria).sort((a, b) => b[1] - a[1]).forEach(([cat, val]) => { texto += `${catIcones[cat] || '📦'} ${cat.charAt(0).toUpperCase() + cat.slice(1)}: R$ ${val.toFixed(2)}\n`; });
      texto += `\n`;
    }
    const ultimos = saidas.slice(0, 5);
    if (ultimos.length > 0) { texto += `*Últimos lançamentos:*\n`; ultimos.forEach(g => { const nome = g.description && g.description !== g.category ? g.description : g.category; texto += `• ${catIcones[g.category]||'📦'} ${nome} — R$ ${g.value.toFixed(2)}\n`; }); }
    if (gastos.length === 0) texto = `📊 *Relatório de ${nomeMes}*\n\nNenhum lançamento este mês ainda 😊`;
    await sendButtons(phone, texto, [{ id: 'novo_gasto', label: '➕ Registrar gasto' }, { id: 'menu', label: '🏠 Menu' }]);
  } catch (e) {
    console.error('[gerarRelatorioFinanceiro]', e.message);
    await sendMessage(phone, 'Não consegui gerar o relatório agora. Tenta de novo?');
  }
}

function convertToDateWithTime(horaStr) {
  const [hora, min] = horaStr.split(':').map(Number);
  const date = nowBRT();
  date.setHours(hora, min || 0, 0, 0);
  return date;
}

async function gerarResumoDoBanco(pontos, userId) {
  const get = (tipo) => pontos.find(p => p.type === tipo);
  const entrada = get('entrada'), saidaAlmoco = get('saida_almoco'), voltaAlmoco = get('volta_almoco'), saida = get('saida');
  const jornada = await memory.getJornada(userId);
  let tempoManha = null, tempoTarde = null, totalTrabalhado = null, horasExtras = null;
  if (entrada && saidaAlmoco) tempoManha = (new Date(saidaAlmoco.timestamp) - new Date(entrada.timestamp)) / 60000;
  if (voltaAlmoco && saida) tempoTarde = (new Date(saida.timestamp) - new Date(voltaAlmoco.timestamp)) / 60000;
  if (tempoManha !== null && tempoTarde !== null) { totalTrabalhado = tempoManha + tempoTarde; horasExtras = totalTrabalhado - jornada; }
  let texto = entrada && !saida
    ? `📍 *Entrada registrada!*\n\n🕘 Você iniciou seu expediente às *${horaStr(entrada.timestamp)}*.\n\nTenha um ótimo trabalho hoje 💜\n\n`
    : `✨ *Resumo do seu dia*\n\n`;
  texto += `🟢 Entrada: *${horaStr(entrada?.timestamp)}*\n`;
  texto += `🍽️ Saída almoço: *${horaStr(saidaAlmoco?.timestamp)}*\n`;
  if (tempoManha !== null) texto += `⏱️ Manhã: *${minutesToHours(tempoManha)}*\n`;
  texto += `🔄 Volta almoço: *${horaStr(voltaAlmoco?.timestamp)}*\n`;
  if (saida) texto += `🔴 Saída: *${horaStr(saida.timestamp)}*\n`;
  if (tempoTarde !== null) texto += `⏱️ Tarde: *${minutesToHours(tempoTarde)}*\n`;
  if (totalTrabalhado !== null) {
    texto += `\n📊 Total: *${minutesToHours(totalTrabalhado)}*\n`;
    if (horasExtras > 0) texto += `⭐ Horas extras: *${minutesToHours(horasExtras)}*\n`;
    else if (horasExtras < 0) texto += `⚠️ Faltam: *${minutesToHours(Math.abs(horasExtras))}*\n`;
    else texto += `✅ Jornada completa!\n`;
  }
  if (!saida) texto += `\n💡 Me avisa quando sair!`;
  return texto;
}

async function listarLembretes(user, phone) {
  const agora = new Date();
  const reminders = await prisma.reminder.findMany({ where: { userId: user.id, sent: false, confirmed: false, scheduledAt: { gte: agora } }, orderBy: { scheduledAt: 'asc' }, take: 10 });
  if (reminders.length === 0) return await sendButtons(phone, `📋 *Seus lembretes*\n\nVocê não tem lembretes ativos no momento 😊`, [{ id: 'lembrete', label: '➕ Criar lembrete' }, { id: 'menu', label: '🏠 Menu' }]);
  const numeros = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
  let texto = `📋 *Seus lembretes ativos*\n\n`;
  reminders.forEach((r, i) => { texto += `${numeros[i] || `${i+1}.`} 📌 ${r.message}\n`; texto += `    🗓️ ${formatarDataHoraBR(r.scheduledAt)}\n\n`; });
  texto += `_${reminders.length} lembrete${reminders.length > 1 ? 's' : ''} ativo${reminders.length > 1 ? 's' : ''}_ ✨`;
  await sendButtons(phone, texto, [{ id: 'criar_lembrete', label: '➕ Criar lembrete' }, { id: 'menu', label: '🏠 Menu' }]);
}

async function listarAnotacoes(user, phone) {
  const mems = await memory.getRecentMemories(user.id, 50);
  const anotacoes = mems.filter(m => m.type === 'anotacao').slice(0, 10);
  if (anotacoes.length === 0) return await sendButtons(phone, `📝 *Suas anotações*\n\nVocê ainda não tem anotações salvas 😊`, [{ id: 'anotacao', label: '➕ Nova anotação' }, { id: 'menu', label: '🏠 Menu' }]);
  let texto = `📝 *Suas anotações*\n\n`;
  anotacoes.forEach((a) => { texto += `📌 _"${a.content}"_\n🗓️ ${formatarDataBR(a.createdAt)}\n\n`; });
  texto += `_${anotacoes.length} anotaç${anotacoes.length > 1 ? 'ões' : 'ão'} salva${anotacoes.length > 1 ? 's' : ''}_ 💜`;
  await sendButtons(phone, texto, [{ id: 'nova_anotacao', label: '➕ Nova anotação' }, { id: 'menu', label: '🏠 Menu' }]);
}

async function listarGastos(user, phone) {
  try {
    const now = nowBRT();
    const inicioMes = new Date(now.getFullYear(), now.getMonth(), 1);
    const preferences = await memory.getUserPreference(user.id);
    const gastos = await prisma.expense.findMany({ where: { userId: user.id, createdAt: { gte: inicioMes } }, orderBy: { createdAt: 'desc' }, take: 20 });
    if (gastos.length === 0) return await sendButtons(phone, `💰 *Seus gastos*\n\nNenhum lançamento registrado este mês 😊`, [{ id: 'novo_gasto', label: '➕ Registrar gasto' }, { id: 'menu', label: '🏠 Menu' }]);
    const saidas = gastos.filter(g => g.value > 0);
    const entradas = gastos.filter(g => g.value < 0);
    const totalGasto = saidas.reduce((acc, g) => acc + g.value, 0);
    const totalEntradas = entradas.reduce((acc, g) => acc + Math.abs(g.value), 0);
    const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const catIcones = { alimentacao:'🍔', mercado:'🛒', transporte:'🚗', saude:'💊', lazer:'🎮', moradia:'🏠', educacao:'📚', entrada:'💰', outro:'📦' };
    let texto = `💰 *${meses[now.getMonth()]} — Resumo*\n\n`;
    if (entradas.length > 0) texto += `💰 Entradas: *R$ ${totalEntradas.toFixed(2)}*\n`;
    texto += `💸 Gastos: *R$ ${totalGasto.toFixed(2)}*\n`;
    if (preferences.saldo != null) { const saldo = preferences.saldo - totalGasto + totalEntradas; texto += `💵 Saldo: *R$ ${saldo.toFixed(2)}*\n`; }
    texto += `\n`;
    gastos.slice(0, 8).forEach(g => { const isEntrada = g.value < 0; const absVal = Math.abs(g.value); const nome = g.description && g.description !== g.category ? g.description : g.category; const sinal = isEntrada ? '+' : '-'; const icon = isEntrada ? '💰' : (catIcones[g.category] || '📦'); texto += `${icon} ${nome} — *${sinal}R$ ${absVal.toFixed(2)}*\n`; });
    texto += `\n_${gastos.length} lançamento${gastos.length !== 1 ? 's' : ''} este mês_`;
    await sendButtons(phone, texto, [{ id: 'novo_gasto', label: '➕ Novo gasto' }, { id: 'menu', label: '🏠 Menu' }]);
  } catch (e) { console.error('[listarGastos]', e.message); await sendMessage(phone, 'Não consegui buscar os gastos agora. Tenta de novo?'); }
}

async function listarPontoHoje(user, phone) {
  const hoje = dateBRT();
  const pontos = await prisma.workLog.findMany({ where: { userId: user.id, date: hoje }, orderBy: { timestamp: 'asc' } });
  if (pontos.length === 0) return await sendButtons(phone, `📍 *Ponto de hoje*\n\nNenhum registro de ponto hoje ainda 😊`, [{ id: 'ponto', label: '📍 Bater ponto' }, { id: 'menu', label: '🏠 Menu' }]);
  const resumo = await gerarResumoDoBanco(pontos, user.id);
  await sendButtons(phone, resumo, [{ id: 'bater_ponto', label: '📍 Bater ponto' }, { id: 'menu', label: '🏠 Menu' }]);
}

async function listarMedicamentos(user, phone) {
  const meds = await prisma.medication.findMany({ where: { userId: user.id, active: true }, orderBy: { createdAt: 'desc' } });
  if (meds.length === 0) return await sendButtons(phone, `💊 *Seus medicamentos*\n\nNenhum medicamento cadastrado ainda 😊`, [{ id: 'saude', label: '➕ Cadastrar remédio' }, { id: 'menu', label: '🏠 Menu' }]);
  let texto = `💊 *Seus medicamentos ativos*\n\n`;
  meds.forEach((m) => { const horarios = JSON.parse(m.times || '[]').join(', '); texto += `💊 *${m.name}*\n⏰ ${horarios} — ${m.frequency}x por dia\n💊 Restam: ${m.remaining}\n\n`; });
  await sendButtons(phone, texto, [{ id: 'novo_remedio', label: '➕ Novo remédio' }, { id: 'menu', label: '🏠 Menu' }]);
}

async function executeAction(user, phone, classified, originalText) {
  switch (classified.tipo) {
    case 'ponto_multiplo':
      await salvarPontoSilencioso(user, classified.acoes);
      break;
    case 'cidade':
      await memory.saveMemory(user.id, 'cidade', classified.cidade);
      break;
    case 'anotacao':
      await memory.saveMemory(user.id, 'anotacao', classified.conteudo || classified.titulo || originalText, { titulo: classified.titulo });
      break;
    case 'tarefa':
      await salvarTarefaSilenciosa(user, phone, classified, originalText);
      break;
    case 'deletar_remedio':
      if (classified.nome) {
        const nomeRemedio = classified.nome.toLowerCase();
        const remedios = await prisma.medication.findMany({ where: { userId: user.id } });
        const encontrados = remedios.filter(m => m.name.toLowerCase().includes(nomeRemedio) || nomeRemedio.includes(m.name.toLowerCase().split(' ')[0]));
        if (encontrados.length > 0) await prisma.medication.deleteMany({ where: { id: { in: encontrados.map(m => m.id) } } });
      }
      break;
    case 'gasto':
      await memory.saveExpense(user.id, { valor: classified.valor, categoria: classified.categoria || 'outro', descricao: classified.descricao || classified.categoria });
      break;
    case 'entrada_financeira':
      if (classified.valor) await memory.saveExpense(user.id, { valor: -Math.abs(classified.valor), categoria: 'entrada', descricao: classified.descricao || 'Entrada' });
      break;
    case 'deletar_gasto':
      if (classified.descricao || classified.id) {
        try {
          if (classified.id) {
            await prisma.expense.delete({ where: { id: classified.id } });
          } else {
            const descBusca = (classified.descricao || '').toLowerCase();
            const inicioMes = new Date(nowBRT().getFullYear(), nowBRT().getMonth(), 1);
            const gastos = await prisma.expense.findMany({ where: { userId: user.id, createdAt: { gte: inicioMes } }, orderBy: { createdAt: 'desc' } });
            const encontrado = gastos.find(g => (g.description || '').toLowerCase().includes(descBusca) || (g.category || '').toLowerCase().includes(descBusca));
            if (encontrado) await prisma.expense.delete({ where: { id: encontrado.id } });
          }
        } catch(e) { console.error('[deletar_gasto]', e.message); }
      }
      break;
    case 'medicamento':
      if (classified.nome) await memory.saveMedication(user.id, { nome: classified.nome, quantidade: classified.quantidade || 0, frequencia: classified.frequencia || 1, horarios: classified.horarios || ['08:00'] });
      break;
    case 'preferencia':
      if (classified.tom && typeof classified.tom === 'string' && classified.tom.trim()) {
        await memory.saveUserPreference(user.id, null, classified.tom, null);
      }
      if (classified.nome && typeof classified.nome === 'string' && classified.nome.trim()) {
        await memory.saveUserPreference(user.id, classified.nome, null, null);
      }
      break;
    case 'concluir_lembrete': {
      const pendentes = await getLembretesPendentesConfirmacao(user.id);
      if (!pendentes.length) break;

      // Se o usuário citou um código curto (#1, #2, "feito o 2"...), usa
      // o índice diretamente — evita ambiguidade quando vários lembretes
      // foram disparados juntos.
      const codigo = extrairCodigoLembrete(originalText || '');
      let match = null;
      if (codigo && pendentes[codigo - 1]) {
        match = pendentes[codigo - 1];
      } else if (classified.titulo) {
        const titulo = classified.titulo.toLowerCase();
        match = pendentes.find(r => r.message.toLowerCase().includes(titulo) || titulo.includes(r.message.toLowerCase().substring(0, 10)));
      }
      // Sem título e sem código: se só há 1 pendente, assume ele.
      if (!match && !classified.titulo && !codigo && pendentes.length === 1) {
        match = pendentes[0];
      }

      if (match) await prisma.reminder.update({ where: { id: match.id }, data: { confirmed: true } });
      break;
    }
    case 'saldo':
      if (classified.valor !== undefined && classified.valor !== null) await memory.saveUserPreference(user.id, null, null, parseFloat(classified.valor));
      break;
  }
}

async function salvarPontoSilencioso(user, acoes) {
  const hoje = dateBRT();
  for (const acao of acoes) {
    let subtipo = (acao.subtipo || '').toLowerCase().trim();
    if (subtipo.includes('entrada') || subtipo.includes('cheg')) subtipo = 'entrada';
    else if (subtipo.includes('saida_almoco') || (subtipo.includes('almo') && subtipo.includes('sai'))) subtipo = 'saida_almoco';
    else if (subtipo.includes('volta_almoco') || (subtipo.includes('almo') && subtipo.includes('volt'))) subtipo = 'volta_almoco';
    else if (subtipo.includes('saida') || subtipo.includes('sai')) subtipo = 'saida';
    const timestamp = acao.hora ? convertToDateWithTime(acao.hora) : nowBRT();
    const existing = await prisma.workLog.findFirst({ where: { userId: user.id, type: subtipo, date: hoje } });
    if (existing) await prisma.workLog.update({ where: { id: existing.id }, data: { timestamp } });
    else await prisma.workLog.create({ data: { userId: user.id, type: subtipo, timestamp, date: hoje } });
  }
}

function detectarUrgencia(titulo) {
  const t = (titulo || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const palavras = ['medico','medica','consulta','dentista','cirurgia','exame','laboratorio','farmacia','remedio','medicamento','vacina','hospital','clinica','psico','terapia','fisio','upa','documento','cartorio','contrato','assinar','entregar','protocolar','prazo','vencimento','vence','renovar','passaporte','rg','cnh','voo','aeroporto','embarque','onibus','trem','reuniao','apresentacao','entrevista','prova','concurso','buscar','pegar','retirar','entregar','entrega','cabelereiro','barbearia','manicure','cabeleireiro','marmita','almoco','janta','jantar','escola','creche'];
  return palavras.some(p => t.includes(p));
}

async function salvarTarefaSilenciosa(user, phone, classified, originalText) {
  await memory.saveMemory(user.id, 'tarefa', classified.titulo, { data: classified.data, hora: classified.hora });
  let scheduledAt = null;
  if (originalText) { const relativo = calcularHorarioRelativo(originalText); if (relativo) { scheduledAt = relativo; } }
  if (!scheduledAt && classified.hora) {
    const hoje = dateBRT();
    let dataUsada = hoje;
    if (classified.data) {
      const dataObj = new Date(classified.data + 'T12:00:00-03:00');
      const anoClassify = dataObj.getFullYear();
      const anoAtual = new Date().getFullYear();
      if (anoClassify >= anoAtual && anoClassify <= anoAtual + 1) dataUsada = classified.data;
      else console.warn(`[DATA_INVALIDA] phone=${phone} titulo="${classified.titulo}" data_groq="${classified.data}" — ignorada, usando hoje`);
    }
    const [h, m] = classified.hora.split(':').map(Number);
    scheduledAt = new Date(`${dataUsada}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00-03:00`);
    if (!classified.data && scheduledAt < nowBRT()) { scheduledAt.setDate(scheduledAt.getDate() + 1); }
  }
  // ── Tem DATA mas SEM HORA (ex: "no dia 24 tenho consulta") ──
  // Sinaliza para o chamador perguntar o horário ao usuário, em vez de
  // criar o lembrete silenciosamente com um horário arbitrário.
  if (!scheduledAt && !classified.hora && classified.data) {
    const dataObj = new Date(classified.data + 'T12:00:00-03:00');
    const anoClassify = dataObj.getFullYear();
    const anoAtual = new Date().getFullYear();
    if (anoClassify >= anoAtual && anoClassify <= anoAtual + 1) {
      return { perguntarHora: true, lembreteTitulo: classified.titulo, lembreteData: classified.data };
    } else {
      console.warn(`[DATA_INVALIDA] phone=${phone} titulo="${classified.titulo}" data_groq="${classified.data}" — ignorada, lembrete não criado`);
      return null;
    }
  }
  if (scheduledAt) {
    const novoLembrete = await prisma.reminder.create({ data: { userId: user.id, phone, message: classified.titulo, scheduledAt } });
    if (detectarUrgencia(classified.titulo)) {
      await prisma.memory.create({ data: { userId: user.id, type: 'lembrete_urgente', content: novoLembrete.id } }).catch(() => {});
      const expira = Date.now() + 5 * 60 * 1000;
      await prisma.memory.create({ data: { userId: user.id, type: 'confirmacao_pendente', content: JSON.stringify({ tipo: 'urgente_confirmacao', lembreteId: novoLembrete.id, expira }) } }).catch(() => {});
      return { lembreteUrgente: true, lembreteTitulo: classified.titulo };
    }
    const antecedencia = classified.antecedencia;
    if (antecedencia && antecedencia > 0) {
      const scheduledAntes = new Date(scheduledAt.getTime() - antecedencia * 60 * 1000);
      if (scheduledAntes > new Date()) await prisma.reminder.create({ data: { userId: user.id, phone, message: `⏰ Em ${antecedencia} minutos: ${classified.titulo}`, scheduledAt: scheduledAntes } });
    }
  }
}

async function editarLembrete(user, phone, classified, contextoClassify = '', originalText = '') {
  try {
    let titulo = (classified.titulo || '').toLowerCase().trim();

    // Busca todos os lembretes não confirmados
    const todosLembretes = await prisma.reminder.findMany({
      where: { userId: user.id, confirmed: false },
      orderBy: { scheduledAt: 'asc' }
    });

    let encontrado = null;

    // ── Código curto (#1, #2, "o 1"...) ──
    // Quando múltiplos lembretes foram disparados juntos (numerados pelo
    // scheduler como #1, #2...), o usuário pode citar o número para
    // desambiguar — tem prioridade sobre o fallback "último disparado",
    // que era a causa de confirmar o lembrete errado ao arrastar a conversa.
    const codigo = extrairCodigoLembrete(originalText || '');
    if (codigo) {
      const pendentes = await getLembretesPendentesConfirmacao(user.id);
      if (pendentes[codigo - 1]) encontrado = pendentes[codigo - 1];
    }

    if (!encontrado && !titulo) {
      // Sem título: pega o último disparado (o que acabou de notificar)
      // Ordena por scheduledAt desc para pegar o mais recente disparado
      const enviados = todosLembretes.filter(r => r.sent)
        .sort((a,b) => new Date(b.scheduledAt) - new Date(a.scheduledAt));
      encontrado = enviados[0] || null;

      // Se não tem nenhum sent, pega o próximo a vencer
      if (!encontrado) {
        encontrado = todosLembretes[0] || null;
      }
    } else if (!encontrado) {
      // Com título: busca por correspondência
      encontrado = todosLembretes.find(r => r.message.toLowerCase().includes(titulo));

      // Fallback: palavras-chave com mais de 3 chars
      if (!encontrado) {
        const palavras = titulo.split(' ').filter(p => p.length > 3);
        encontrado = todosLembretes.find(r =>
          palavras.some(p => r.message.toLowerCase().includes(p))
        );
      }

      // Fallback: usa contexto da conversa para inferir
      if (!encontrado && contextoClassify) {
        const linhasCtx = contextoClassify.split('\n');
        for (const linha of linhasCtx) {
          const match = todosLembretes.find(r =>
            linha.toLowerCase().includes(r.message.toLowerCase().substring(0, 15))
          );
          if (match) { encontrado = match; break; }
        }
      }

      if (!encontrado) {
        await sendMessage(phone, `Não encontrei nenhum lembrete com "${classified.titulo}" 😕\n\nMe diz o nome certinho!`);
        return;
      }
    }

    if (!encontrado) {
      await sendMessage(phone, 'Não encontrei nenhum lembrete pra remarcar 😕');
      return;
    }

    let novoScheduledAt = new Date(encontrado.scheduledAt);
    if (classified.nova_hora) {
      const [h, m] = classified.nova_hora.split(':').map(Number);
      const dataBase = classified.nova_data || new Date(encontrado.scheduledAt).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
      novoScheduledAt = new Date(`${dataBase}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00-03:00`);
    } else if (classified.nova_data) {
      const horaAtual = new Date(encontrado.scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
      const [h, m] = horaAtual.split(':').map(Number);
      novoScheduledAt = new Date(`${classified.nova_data}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00-03:00`);
    }

    await prisma.reminder.update({ where: { id: encontrado.id }, data: { scheduledAt: novoScheduledAt, sent: false } });

    const horaFormatada = novoScheduledAt.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
    const dataFormatada = novoScheduledAt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short' });
    await sendMessage(phone, `✅ Remarcado!\n\n📌 ${encontrado.message}\n🕒 ${dataFormatada} às ${horaFormatada}`);

  } catch(e) {
    console.error('[editarLembrete]', e.message);
    await sendMessage(phone, 'Ops, erro ao remarcar 😕');
  }
}

async function deletarLembretePorTitulo(user, phone, classified) {
  try {
    const titulo = classified.titulo?.toLowerCase();
    if (!titulo) { await sendMessage(phone, 'Qual lembrete quer cancelar? Me diz o nome 😊'); return; }
    const lembretes = await prisma.reminder.findMany({ where: { userId: user.id, sent: false, confirmed: false } });
    const encontrados = lembretes.filter(r => r.message.toLowerCase().includes(titulo));
    if (!encontrados.length) { await sendMessage(phone, `Não encontrei nenhum lembrete com "${classified.titulo}" 😕`); return; }
    await prisma.reminder.deleteMany({ where: { id: { in: encontrados.map(r => r.id) } } });
    await sendMessage(phone, `✅ Lembrete cancelado: "${encontrados[0].message}"`);
  } catch(e) { console.error('[deletarLembrete]', e.message); }
}

async function handleContatoAction(user, phone, classified) {
  try {
    if (classified.tipo === 'listar_contatos') {
      const contatos = await getContacts(user.id);
      if (!contatos.length) { await sendMessage(phone, 'Você ainda não tem contatos salvos. Me diz o número de alguém: "o número do João é 43999998888" 😊'); return; }
      const lista = contatos.map((c, i) => `${i+1}. *${c.name}*${c.relation?` (${c.relation})`:''} — ${c.phone}`).join('\n');
      await sendMessage(phone, `📋 *Seus contatos:*\n\n${lista}\n\nPode dizer "envia mensagem pro contato 2" ou "lembra o contato 1 de tal coisa" 😊`);
      await prisma.memory.upsert({ where: { userId_type: { userId: user.id, type: 'contatos_listados' } }, update: { content: JSON.stringify(contatos) }, create: { userId: user.id, type: 'contatos_listados', content: JSON.stringify(contatos) } }).catch(() => {});
      return;
    }
    if (classified.tipo === 'deletar_contato') {
      const nome = classified.nome;
      if (!nome) { await sendMessage(phone, 'Qual contato quer apagar? Me diz o nome 😊'); return; }
      const pareceNumero = /^\d{8,}$/.test(nome.replace(/\D/g,'')) && nome.replace(/\D/g,'').length >= 8;
      let encontrados = [];
      if (pareceNumero) { const tel = nome.replace(/\D/g,''); const todos = await prisma.contact.findMany({ where: { userId: user.id } }); encontrados = todos.filter(c => c.phone && c.phone.replace(/\D/g,'').endsWith(tel) || tel.endsWith(c.phone.replace(/\D/g,''))); }
      if (!encontrados.length) {
        const numLista = parseInt(nome);
        if (!isNaN(numLista) && numLista >= 1) {
          try { const mem = await prisma.memory.findFirst({ where: { userId: user.id, type: 'contatos_listados' } }); if (mem) { const lista = JSON.parse(mem.content); const c = lista[numLista - 1]; if (c) { const found = await prisma.contact.findMany({ where: { userId: user.id, phone: c.phone } }); encontrados = found; } } } catch(e) {}
        }
      }
      if (!encontrados.length) encontrados = await findContactByName(user.id, nome);
      if (encontrados.length === 0) { await sendMessage(phone, `Não encontrei nenhum contato com "${nome}" 😕`); return; }
      for (const c of encontrados) await prisma.contact.delete({ where: { id: c.id } });
      await sendMessage(phone, `✅ Contato${encontrados.length>1?'s':''} removido${encontrados.length>1?'s':''}: *${encontrados.map(c=>c.name).join(', ')}* 🗑️`);
      return;
    }
    if (classified.tipo === 'salvar_contato') {
      if (!classified.nome || !classified.phone) { await sendMessage(phone, 'Preciso do nome e do número para salvar o contato 😊'); return; }
      await saveContact(user.id, { nome: classified.nome, phone: classified.phone, relation: classified.relation || null, notes: classified.notes || null });
      await sendMessage(phone, `✅ Contato salvo! ${classified.nome}${classified.relation?` (${classified.relation})`:''} 📱`);
      return;
    }
    if (classified.tipo === 'enviar_mensagem_agendada') {
      let destinatarioPhone = classified.phone || null;
      let destinatarioNome = classified.destinatario || null;
      if (!destinatarioPhone && destinatarioNome) {
        const encontrados = await findContactByName(user.id, destinatarioNome);
        if (encontrados.length === 0) { await sendMessage(phone, `Não encontrei "${destinatarioNome}" 😕 Me diz o número!`); return; }
        if (encontrados.length > 1) {
          const lista = encontrados.map((c, i) => `${i+1}. ${c.name}${c.relation?` (${c.relation})`:''} — ${c.phone}`).join('\n');
          await memory.saveMemory(user.id, 'confirmacao_pendente', JSON.stringify({ tipo:'selecao_contato', opcoes:encontrados.map(c=>({nome:c.name,phone:c.phone,relation:c.relation})), mensagem:classified.mensagem||'', expira:Date.now()+3*60*1000 }));
          await sendMessage(phone, `Encontrei mais de um contato:\n\n${lista}\n\nQual você quer? Responde com o número (1, 2...)`);
          return;
        }
        destinatarioPhone = encontrados[0].phone; destinatarioNome = encontrados[0].name;
      }
      if (!destinatarioPhone) { await sendMessage(phone, 'Para quem quer enviar? Me diz o nome ou número 😊'); return; }
      let phoneClean = destinatarioPhone.replace(/\D/g, '');
      if (!phoneClean.startsWith('55') && phoneClean.length <= 11) phoneClean = '55' + phoneClean;
      const mensagem = classified.mensagem || '';
      if (!mensagem) { await sendMessage(phone, 'O que quer que eu escreva? 😊'); return; }
      const nowLocal = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
      const now = nowLocal();
      let scheduledAt = null;
      if (classified.data && classified.hora) scheduledAt = new Date(`${classified.data}T${classified.hora}:00-03:00`);
      else if (classified.hora) { const [h,m] = classified.hora.split(':').map(Number); scheduledAt = new Date(now); scheduledAt.setHours(h,m||0,0,0); if (scheduledAt<=now) scheduledAt.setDate(scheduledAt.getDate()+1); }
      if (!scheduledAt || scheduledAt <= new Date()) { await sendMessage(phone, 'Não entendi quando quer enviar 😕 Me diz a hora, ex: "amanhã às 10h"'); return; }
      const horaPrev = scheduledAt.toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'});
      const dataPrev = scheduledAt.toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo',weekday:'long',day:'numeric',month:'long'});
      await memory.saveMemory(user.id,'confirmacao_pendente',JSON.stringify({tipo:'mensagem_agendada',toPhone:phoneClean,toName:destinatarioNome,mensagem,scheduledAt:scheduledAt.toISOString(),expira:Date.now()+2*60*1000}));
      await sendMessage(phone,`📤 Vou enviar para *${destinatarioNome}*:\n\n_"${mensagem}"_\n\n📅 ${dataPrev} às ${horaPrev}\n\nConfirma? (sim/não)`);
      return;
    }
    if (classified.tipo === 'enviar_mensagem') {
      let destinatarioPhone = classified.phone || null;
      let destinatarioNome = classified.destinatario || null;
      if (classified.contato_numero) {
        try { const mem = await prisma.memory.findFirst({ where: { userId: user.id, type: 'contatos_listados' } }); if (mem) { const lista = JSON.parse(mem.content); const c = lista[classified.contato_numero-1]; if (c) { destinatarioNome = c.name; destinatarioPhone = c.phone; } } } catch(e) {}
      }
      if (!destinatarioPhone && destinatarioNome) {
        const encontrados = await findContactByName(user.id, destinatarioNome);
        if (encontrados.length === 0) { await sendMessage(phone, `Não encontrei "${destinatarioNome}" 😕 Me diz o número!`); return; }
        if (encontrados.length > 1) {
          const lista = encontrados.map((c,i)=>`${i+1}. ${c.name}${c.relation?` (${c.relation})`:''} — ${c.phone}`).join('\n');
          await memory.saveMemory(user.id,'confirmacao_pendente',JSON.stringify({tipo:'selecao_contato',opcoes:encontrados.map(c=>({nome:c.name,phone:c.phone,relation:c.relation})),mensagem:classified.mensagem||'',expira:Date.now()+3*60*1000}));
          await sendMessage(phone,`Encontrei mais de um contato:\n\n${lista}\n\nQual você quer? Responde com o número (1, 2...)`);
          return;
        }
        destinatarioPhone = encontrados[0].phone; destinatarioNome = encontrados[0].name;
      }
      if (!destinatarioPhone) { await sendMessage(phone, 'Para quem quer enviar? 😊'); return; }
      let phoneClean = destinatarioPhone.replace(/\D/g, '');
      if (!phoneClean.startsWith('55') && phoneClean.length <= 11) phoneClean = '55' + phoneClean;
      if (destinatarioNome && classified.phone) await saveContact(user.id, { nome: destinatarioNome, phone: phoneClean }).catch(() => {});
      const mensagem = classified.mensagem || '';
      if (!mensagem) { await sendMessage(phone, 'O que quer que eu escreva? 😊'); return; }
      await memory.saveMemory(user.id,'confirmacao_pendente',JSON.stringify({tipo:'enviar_mensagem',destinatarioPhone:phoneClean,destinatarioNome:destinatarioNome||phoneClean,mensagem,expira:Date.now()+2*60*1000}));
      await sendMessage(phone,`📤 Vou enviar para *${destinatarioNome||phoneClean}*:\n\n_"${mensagem}"_\n\nConfirma? (sim/não)`);
      return;
    }
  } catch (e) {
    console.error('[handleContatoAction] Erro:', e.message);
    await sendMessage(phone, 'Ops, tive um problema com isso. Pode tentar de novo?');
  }
}

async function checkConfirmacaoPendente(user, phone, text) {
  try {
    const mems = await memory.getRecentMemories(user.id, 10);
    const pendente = mems.find(m => m.type === 'confirmacao_pendente');
    if (!pendente) return false;
    let dados; try { dados = JSON.parse(pendente.content); } catch { return false; }
    if (Date.now() > dados.expira) { await prisma.memory.delete({ where: { id: pendente.id } }); return false; }
    const textNorm = text.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    if (dados.tipo === 'hora_lembrete') {
      // Tenta extrair um horário do texto (ex: "10h", "14:30", "10 da manhã", "2 da tarde")
      let horaEscolhida = null;
      const matchHM = textNorm.match(/(\d{1,2})[:h](\d{2})/);
      const matchH = textNorm.match(/(\d{1,2})\s*h(?:oras)?\b/);
      const matchNum = !matchHM && !matchH ? textNorm.match(/^(\d{1,2})$/) : null;
      if (matchHM) {
        horaEscolhida = `${String(parseInt(matchHM[1])).padStart(2,'0')}:${matchHM[2]}`;
      } else if (matchH || matchNum) {
        let h = parseInt((matchH || matchNum)[1]);
        if (/tarde/.test(textNorm) && h < 12) h += 12;
        else if (/noite/.test(textNorm) && h < 12) h += 12;
        horaEscolhida = `${String(h).padStart(2,'0')}:00`;
      }

      // Se não souber / não informou hora → usa 09:00 provisório
      const naoSabe = /nao sei|não sei|qualquer|tanto faz|vc escolhe|voce escolhe|decide voce|sei nao/.test(textNorm);

      if (!horaEscolhida && !naoSabe) {
        // Não entendeu a resposta — pede de novo, mantendo o pendente
        await sendMessage(phone, 'Não entendi o horário 😅 Pode me dizer assim: "10h" ou "14:30"? Ou diga "não sei" que eu deixo às 09:00.');
        return true;
      }

      const horaFinal = horaEscolhida || '09:00';
      const [h, m] = horaFinal.split(':').map(Number);
      const scheduledAt = new Date(`${dados.data}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00-03:00`);

      const novoLembrete = await prisma.reminder.create({ data: { userId: user.id, phone, message: dados.titulo, scheduledAt } });
      await prisma.memory.delete({ where: { id: pendente.id } });

      if (detectarUrgencia(dados.titulo)) {
        await prisma.memory.create({ data: { userId: user.id, type: 'lembrete_urgente', content: novoLembrete.id } }).catch(() => {});
      }

      const dataFmt = scheduledAt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
      if (!horaEscolhida) {
        await sendMessage(phone, `✅ Combinado! Deixei "${dados.titulo}" pra ${dataFmt} às 09:00 (provisório) — se descobrir o horário certo depois, me avisa que eu remarco 😊`);
      } else {
        await sendMessage(phone, `✅ Pronto! "${dados.titulo}" agendado pra ${dataFmt} às ${horaFinal} 📌`);
      }
      return true;
    }

    if (dados.tipo === 'selecao_contato') {
      const num = parseInt(textNorm);
      if (!isNaN(num) && num >= 1 && num <= dados.opcoes.length) {
        const escolhido = dados.opcoes[num-1];
        await prisma.memory.delete({ where: { id: pendente.id } });
        let phoneClean = escolhido.phone.replace(/\D/g, '');
        if (!phoneClean.startsWith('55') && phoneClean.length <= 11) phoneClean = '55' + phoneClean;
        if (dados.mensagem) { await memory.saveMemory(user.id,'confirmacao_pendente',JSON.stringify({tipo:'enviar_mensagem',destinatarioPhone:phoneClean,destinatarioNome:escolhido.nome,mensagem:dados.mensagem,expira:Date.now()+2*60*1000})); await sendMessage(phone,`📤 Vou enviar para *${escolhido.nome}*:\n\n_"${dados.mensagem}"_\n\nConfirma? (sim/não)`); }
        else { await sendMessage(phone, `Ok! ${escolhido.nome} selecionado. O que quer enviar?`); }
        return true;
      }
      if (!isNaN(num)) { await sendMessage(phone, `Número inválido. Escolha entre 1 e ${dados.opcoes.length}.`); return true; }
      if (['nao','n','não','cancelar','cancela'].includes(textNorm)) { await prisma.memory.delete({ where: { id: pendente.id } }); await sendMessage(phone, 'Ok, cancelei 😊'); return true; }
      return false;
    }
    if (['sim','s','ok','confirma','envia','manda','pode','yes'].includes(textNorm)) {
      const remetente = await memory.getUserPreference(user.id);
      const nomeRemetente = remetente.name || 'seu contato';
      const foneFormatado = phone.replace('55','').replace(/(\d{2})(\d{5})(\d{4})/,'($1) $2-$3');
      const msgFormatada = `Oi! Sou a Clara, assistente inteligente do ${nomeRemetente}.\n\n📌 Passando um lembrete:\n\n${dados.mensagem}\n\nNão precisa me responder! Se precisar de algo, é só chamar no WhatsApp: ${foneFormatado} 😊`;
      await sendMessage(dados.destinatarioPhone, msgFormatada);
      await prisma.memory.delete({ where: { id: pendente.id } });
      await sendMessage(phone, `✅ Mensagem enviada para *${dados.destinatarioNome}*! 📤`);
      return true;
    }
    if (['nao','n','não','cancelar','cancela','para'].includes(textNorm)) {
      await prisma.memory.delete({ where: { id: pendente.id } });
      await sendMessage(phone, 'Ok, cancelei o envio 😊');
      return true;
    }
    if (dados.tipo === 'urgente_confirmacao') {
      const sim = /^(sim|s|claro|pode|quero|yes|ok|manda|ativa|coloca)/.test(textNorm);
      const nao = /^(n[aã]o|nao|n|não precisa|dispenso|deixa|tá bom|ta bom)/.test(textNorm);
      if (sim || nao) {
        await prisma.memory.delete({ where: { id: pendente.id } });
        if (sim) {
          const rem = await prisma.reminder.findUnique({ where: { id: dados.lembreteId } }).catch(() => null);
          if (rem) {
            const quinzeAntes = new Date(rem.scheduledAt.getTime() - 15 * 60 * 1000);
            if (quinzeAntes > new Date()) {
              await prisma.reminder.create({ data: { userId: user.id, phone, message: `⚡ Em 15 minutos: ${rem.message}`, scheduledAt: quinzeAntes } });
              await prisma.memory.create({ data: { userId: user.id, type: 'urgente_antes_lock', content: rem.id } });
            }
          }
          await sendMessage(phone, 'Feito! Vou te avisar 15 minutos antes 🔔');
        } else {
          await sendMessage(phone, 'Ok, te aviso só na hora 😊');
        }
        return true;
      }
    }
    return false;
  } catch (e) {
    console.error('[checkConfirmacaoPendente] Erro:', e.message);
    return false;
  }
}

async function extractAndSavePersonalInfo(userId, text) {
  const infos = await extractPersonalInfo(text);
  if (!infos || infos.length === 0) return;
  for (const { chave, valor, categoria } of infos) {
    if (!chave || !valor) continue;
    await savePersonalInfo(userId, chave, valor, categoria || 'outro');
    console.log(`[memória pessoal] salvo: ${chave} = "${valor}"`);
  }
}

async function updateRelationshipSummary(userId, history, lastReply) {
  try {
    const count = await prisma.memory.count({ where: { userId, type: 'conversation_message' } });
    if (count % 3 !== 0) return;
    const current = await prisma.memory.findFirst({ where: { userId, type: 'relationship_summary' }, orderBy: { createdAt: 'desc' } });
    const msgs = [...history.slice(-10), { role: 'assistant', content: lastReply }];
    const novoResumo = await generateRelationshipSummary(msgs, current?.content || '');
    if (novoResumo) {
      await prisma.memory.upsert({
        where: { userId_type: { userId, type: 'relationship_summary' } },
        update: { content: novoResumo },
        create: { userId, type: 'relationship_summary', content: novoResumo }
      }).catch(async () => {
        await prisma.memory.deleteMany({ where: { userId, type: 'relationship_summary' } });
        await prisma.memory.create({ data: { userId, type: 'relationship_summary', content: novoResumo } });
      });
    }
  } catch(e) {}
}

module.exports = { handleMessage };
