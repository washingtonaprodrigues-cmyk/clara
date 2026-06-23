// v2 - consulta direta sem LLM
const { classify, extractPersonalInfo, extractPendenciaEmocional, checkResolucaoPendencia, searchWeb, freeResponse, generateMemorySummary, generateRelationshipSummary, ativarModoComparacao, desativarModoComparacao, emModoComparacao, detectarComandoComparacao, detectarAssuntoEmAberto } = require('./groq');

// Importa whatsapp de forma segura com fallback direto via axios
let _whatsappModule = null;
function getWhatsapp() {
  if (!_whatsappModule) {
    try {
      _whatsappModule = require('./whatsapp');
    } catch(e) {
      console.error('[Handler] Erro ao carregar whatsapp.js:', e.message);
    }
  }
  return _whatsappModule;
}

async function sendMessage(phone, msg, delay) {
  const w = getWhatsapp();
  if (w && typeof w.sendMessage === 'function') {
    return w.sendMessage(phone, msg, delay);
  }
  // Fallback direto via axios se whatsapp.js não carregar
  const axios = require('axios');
  const BASE_URL = process.env.UAZAPI_URL || 'https://claravirtual.uazapi.com';
  const TOKEN = process.env.UAZAPI_TOKEN;
  console.log(`[Handler/Fallback] Enviando direto para ${phone}: ${String(msg).slice(0,60)}`);
  return axios.post(`${BASE_URL}/send/text`,
    { number: phone, text: msg, delay: delay || 800 },
    { headers: { token: TOKEN, 'Content-Type': 'application/json' }, timeout: 30000 }
  );
}

async function sendButtons(phone, msg, buttons) {
  const w = getWhatsapp();
  if (w && typeof w.sendButtons === 'function') return w.sendButtons(phone, msg, buttons);
  return sendMessage(phone, msg);
}

async function sendReminderWithButtons(phone, msg, id) {
  const w = getWhatsapp();
  if (w && typeof w.sendReminderWithButtons === 'function') return w.sendReminderWithButtons(phone, msg, id);
  return sendMessage(phone, msg);
}
const memory = require('./memory');
const { tentarConsultaDireta } = require('./consultaDireta');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { buildPersonalContext, savePersonalInfo, saveContact, getContacts, findContactByName, savePendencia, fecharPendenciaLembrete } = memory;

// Substitui prisma.memory.upsert({ where: { userId_type: {...} } }) — esse
// nome de campo composto só existe quando o model Memory tem
// @@unique([userId, type]) no schema, o que NÃO é o caso aqui. Em vez de
// depender disso, fazemos findFirst + create/update manual.
async function upsertMemoryPorTipo(userId, type, content) {
  const existente = await prisma.memory.findFirst({
    where: { userId, type },
    orderBy: { createdAt: 'desc' }
  }).catch(() => null);

  if (existente) {
    return prisma.memory.update({ where: { id: existente.id }, data: { content } });
  }
  return prisma.memory.create({ data: { userId, type, content } });
}

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
const CONTATO_TIPOS = ['salvar_contato', 'deletar_contato', 'enviar_mensagem', 'enviar_mensagem_agendada', 'salvar_cofre'];

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
      if (resp === null) return;
      if (resp && resp.includes('__BUSCAR:')) {
        // improvável em saudações, mas tratamos igual
        await sendMessage(phone, 'Deixa eu pesquisar isso! 🔍');
        return;
      }
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

      const [lembretes, meds, gastos, perfilPessoal, relMemoria, pendenciaSaude] = await Promise.all([
        prisma.reminder.findMany({
          where: { userId: user.id, sent: false, confirmed: false, scheduledAt: { gte: inicioHoje, lte: fimAmanha } },
          orderBy: { scheduledAt: 'asc' }, take: 20
        }),
        prisma.medication.findMany({ where: { userId: user.id, active: true, remaining: { gt: 0 } } }),
        preferences.saldo != null ? prisma.expense.findMany({ where: { userId: user.id, createdAt: { gte: inicioMes } } }) : Promise.resolve([]),
        buildPersonalContext(user.id).catch(() => ''),
        prisma.memory.findFirst({ where: { userId: user.id, type: 'relationship_summary' }, orderBy: { createdAt: 'desc' } }).catch(() => null),
        // ── Pendência de saúde ainda não cobrada ──
        // Se o usuário chamar a Clara DEPOIS do horário de check-in
        // calculado (checkInAt, normalmente 3-5h após a menção original),
        // ela já traz o assunto à tona na conversa em vez de esperar o
        // cron disparar sozinho — fica mais natural ("ela lembrou porque
        // você apareceu"). AJUSTE: antes essa busca não checava checkInAt,
        // só perguntado/resolvido — isso fazia ela puxar o assunto segundos
        // depois de você ter mencionado, mesmo sem nenhum tempo ter
        // passado, colidindo de forma estranha com outras perguntas feitas
        // logo em seguida (ex: pergunta sobre agenda virando também
        // pergunta sobre dor de cabeça na mesma resposta). Agora só
        // considera pendências cujo prazo de check-in já venceu — mesmo
        // timing que o cron usa, só que com chance de aparecer organicamente
        // na conversa em vez de só por iniciativa própria da Clara.
        prisma.pendencia.findFirst({
          where: { userId: user.id, categoria: 'saude', perguntado: false, resolvido: false, checkInAt: { lte: new Date() } },
          orderBy: { createdAt: 'desc' }
        }).catch(() => null)
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

      // ── Pendência de saúde: traz à tona se fizer sentido na conversa ──
      // ── Pendência de saúde: só aparece no contexto se fizer sentido ──
      // REGRAS DE PRIORIDADE E TIMING:
      // 1. Se já existe assunto em aberto de CONVERSA (pendencia_conversa, ex:
      //    hospital), ele já aparece via buildPersonalContext → [ASSUNTOS EM ABERTO].
      //    Adicionar pendenciaSaude por cima causaria dois assuntos competindo,
      //    tornando a resposta sobrecarregada. Nesse caso, pendenciaSaude é omitida.
      // 2. Para remédios: só inclui se o horário da dose estiver dentro de 2h
      //    (antes ou depois). Perguntar sobre remédio das 22h às 15h é fora de
      //    contexto e perturbador — bug real observado em produção.
      // 3. Para outros tipos (saúde geral, dor de cabeça etc.): mantém o
      //    comportamento anterior — aparece quando checkInAt já venceu.
      const temAssuntoAberto = (perfilPessoal || '').includes('[ASSUNTOS EM ABERTO');
      let mostrarPendenciaSaude = false;
      if (pendenciaSaude && !temAssuntoAberto) {
        const resumoLower = (pendenciaSaude.resumo || '').toLowerCase();
        const ehRemedio = /rem[eé]dio|medicamento|comp|dose|tomar/.test(resumoLower);
        if (ehRemedio) {
          // Só mostra se algum remédio ativo tem horário dentro de 2h
          const now2 = nowBRT();
          const hm2 = `${String(now2.getHours()).padStart(2,'0')}:${String(now2.getMinutes()).padStart(2,'0')}`;
          const dentroJanela = meds.some(m => {
            let times = []; try { times = JSON.parse(m.times || '[]'); } catch {}
            return times.some(t => {
              const [th, tm] = t.split(':').map(Number);
              const [nh, nm] = hm2.split(':').map(Number);
              const diffMin = Math.abs((th * 60 + tm) - (nh * 60 + nm));
              return diffMin <= 120; // dentro de 2h
            });
          });
          mostrarPendenciaSaude = dentroJanela;
        } else {
          mostrarPendenciaSaude = true; // saúde geral — comportamento anterior
        }
      }
      if (mostrarPendenciaSaude) {
        contexto += `\n\n[SAÚDE EM ABERTO] Mais cedo a pessoa mencionou: "${pendenciaSaude.resumo}". Se fizer sentido natural na conversa, pergunte com carinho genuíno como está se sentindo agora — sem forçar se a mensagem atual for sobre outro assunto completamente diferente, e sem repetir isso em toda resposta.`;
      }

      if (contexto) contexto = `\n\nUse as informações abaixo para responder com precisão:${contexto}`;
      if (perfilPessoal) contexto += perfilPessoal;
      if (contextoExtra) contexto += contextoExtra;
      preferences._contexto = contexto;
    } catch (e) {
      console.error(`[${phone}] Erro contexto:`, e.message);
    }

    const resp = await freeResponse(text, history, preferences);
    if (resp === null) return; // modo direto: já avisado, não responde

    // Garante que resp é string — o Gemini pode retornar objeto em casos de erro
    const respStr = typeof resp === 'string' ? resp : String(resp || '');
    if (!respStr) return;

    // ── Busca proativa: Clara sinalizou que quer pesquisar ──
    const buscaMatch = respStr.match(/__BUSCAR:(.+?)(__|\n|$)/);
    if (buscaMatch) {
      const query = buscaMatch[1].trim();
      // Avisa que vai pesquisar, no estilo da Clara
      const tom = preferences?.tom || 'carinhoso';
      const avisos = {
        carinhoso: `✨ Buscando pra gente…`,
        direto: `🔍 Buscando.`,
        divertido: `✨ Um segundinho, deixa eu dar uma garimpada!`,
        sarcastico: `Tá bom, vou pesquisar porque obviamente você não vai fazer isso sozinho. 🙄`,
      };
      await sendMessage(phone, avisos[tom] || avisos.carinhoso);

      try {
        const resultado = await searchWeb(query, '');
        if (resultado) {
          await memory.saveConversationMessage(user.id, 'user', text);
          await memory.saveConversationMessage(user.id, 'assistant', resultado);
          await sendMessage(phone, resultado);
          updateRelationshipSummary(user.id, history, resultado).catch(() => {});
        } else {
          await sendMessage(phone, 'Pesquisei mas não encontrei nada útil sobre isso agora 😕');
        }
      } catch (eBusca) {
        console.error(`[BuscaProativa] Erro:`, eBusca.message);
        await sendMessage(phone, 'Não consegui pesquisar isso agora 😕 Tenta de novo?');
      }
      return;
    }

    await memory.saveConversationMessage(user.id, 'user', text);
    await memory.saveConversationMessage(user.id, 'assistant', respStr);
    await sendMessage(phone, respStr);
    updateRelationshipSummary(user.id, history, respStr).catch(() => {});

    // ── Detecção de assunto em aberto (fire-and-forget) ──────────────
    // Roda após a resposta, sem adicionar latência. Se a conversa gerou
    // um assunto relevante não resolvido (saúde, trabalho, evento esperado),
    // salva como pendencia_conversa pra Clara retomar naturalmente depois.
    // Também detecta quando o usuário fecha um assunto aberto.
    ;(async () => {
      try {
        await memory.fecharPendenciasPorResolucao(user.id, text);
        const histAtual = [...history, { role: 'user', content: text }, { role: 'assistant', content: respStr }];
        if (histAtual.length >= 2 && text.length > 15) {
          const pendencia = await detectarAssuntoEmAberto(histAtual);
          if (pendencia) {
            // ── Guarda no lugar certo ──
            // Informações permanentes (filhos, aniversários, trabalho, gostos)
            // são fatos de vida — vão pro perfil, não viram pendência temporária.
            // Pendências são só eventos com resultado incerto e prazo curto.
            const TEMAS_PERMANENTES = /\b(filho|filha|esposa|marido|aniversário|aniversario|namorad|família|familia|trabalho|empresa|cargo|mora|nasceu|nascimento|signo|time de|serie favorita|comida favorita|alergi|gosta de|adora|hobby)\b/i;
            if (TEMAS_PERMANENTES.test(pendencia.assunto) || TEMAS_PERMANENTES.test(pendencia.contexto)) {
              extractAndSavePersonalInfo(user.id, pendencia.contexto, respStr).catch(() => {});
              console.log(`[Pendência→Perfil] "${pendencia.assunto}" redirecionado pro perfil`);
            } else {
              await memory.salvarOuAtualizarPendencia(user.id, pendencia);
            }
          }
        }
      } catch { /* silencioso — nunca bloqueia a resposta */ }
    })();
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

    // ── Consulta direta (sem LLM) ──
    // Para perguntas de leitura pura sobre dados já existentes no banco
    // (agenda de hoje/amanhã, lembretes pendentes, saldo), responde
    // direto sem passar por classify/freeResponse — instantâneo e sempre
    // consistente entre WhatsApp e Dashboard (mesmo módulo compartilhado
    // consultaDireta.js). Corrige também o bug em que fallbacks diferentes
    // da cascata formatavam horários de forma inconsistente (fuso horário).
    const respostaDireta = await tentarConsultaDireta(text, { prisma, memory, userId: user.id });
    if (respostaDireta) {
      await memory.saveConversationMessage(user.id, 'user', text).catch(() => {});
      await memory.saveConversationMessage(user.id, 'assistant', respostaDireta).catch(() => {});
      return await sendMessage(phone, respostaDireta);
    }

    // ── Resposta "ele"/"ela" à pergunta de gênero ──
    // Detecção leve e determinística (sem custo de IA): só verifica o
    // histórico se a mensagem for exatamente "ele" ou "ela" isolada, e
    // confirma que a última mensagem da Clara realmente perguntou sobre
    // isso, antes de salvar — evita falso positivo em "ele" sem contexto.
    if (/^(ele|ela)[.!]?$/i.test(text.trim())) {
      const ultimasMsgs = await memory.getConversationHistory(user.id, 2).catch(() => []);
      const ultimaDaClara = [...ultimasMsgs].reverse().find(m => m.role === 'assistant');
      if (ultimaDaClara && /direcionar.*voc[eê]|ele ou ela|prefere.*ele.*ela/i.test(ultimaDaClara.content || '')) {
        const genero = text.trim().toLowerCase().replace(/[.!]/g, '');
        await memory.savePersonalInfo(user.id, 'genero', genero, 'outro').catch(() => {});
        return await sendMessage(phone, genero === 'ela' ? 'Combinado! 💜' : 'Combinado! 👍');
      }
    }

    // ── Desativar "Meu Dia" permanentemente ──
    if (/para de criar (o\s+)?meu dia|n[aã]o (quero|preciso) (mais )?(o\s+)?meu dia|remove (o\s+)?meu dia|cancela (o\s+)?meu dia/i.test(text)) {
      await upsertMemoryPorTipo(user.id, 'meu_dia_desativado', new Date().toISOString()).catch(() => {});
      return await sendMessage(phone, 'Ok! Não crio mais o "Meu Dia" automaticamente. Se quiser ativar de novo, é só me pedir 😊');
    }

    // ── Reativar "Meu Dia" ──
    if (/ativa (o\s+)?meu dia|quero (o\s+)?meu dia (de volta|novamente)|volta (com |a criar )?(o\s+)?meu dia/i.test(text)) {
      await prisma.memory.deleteMany({
        where: { userId: user.id, type: 'meu_dia_desativado' }
      }).catch(() => {});
      return await sendMessage(phone, '✅ "Meu Dia" ativado! A partir de amanhã de manhã já crio a lista automaticamente pra você 📅');
    }


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
            fecharPendenciaLembrete(user.id, escolhido.message).catch(() => {});
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

    // ── Consulta de agenda por DATA(S) ESPECÍFICA(S) (ex: "o que tenho pro
    // dia 24?", "e dia 24 e dia 27?") ──
    // O bloco [AGENDA] usado no fluxo normal só cobre hoje/amanhã (ver
    // construção do contexto em responderLivre) — perguntas sobre datas
    // mais distantes nunca tinham acesso aos dados reais, fazendo a Clara
    // dizer "não encontrei nada" mesmo quando existia um compromisso real
    // (bug observado: consulta com nutricionista dia 24 cadastrada, mas
    // invisível pra ela porque estava fora da janela hoje/amanhã). Esse
    // branch busca DIRETO no banco pela(s) data(s) perguntada(s), cobrindo
    // Reminder (lembretes/horários) e Task (compromissos sem lembrete).
    // Aceita um ARRAY de datas porque o usuário pode perguntar por mais de
    // uma de uma vez (ex: "dia 24 e dia 27") — com campo único anterior,
    // isso ficava ambíguo pro classify e a busca nunca disparava.
    if (classified.tipo === 'consulta' && Array.isArray(classified.datas) && classified.datas.length > 0) {
      try {
        const blocos = [];
        for (const dataStr of classified.datas.slice(0, 5)) { // limite de segurança
          const dataAlvo = new Date(`${dataStr}T00:00:00-03:00`);
          if (isNaN(dataAlvo.getTime())) continue;
          const fimDia = new Date(`${dataStr}T23:59:59-03:00`);
          const [lembretesData, tarefasData] = await Promise.all([
            prisma.reminder.findMany({ where: { userId: user.id, scheduledAt: { gte: dataAlvo, lte: fimDia } }, orderBy: { scheduledAt: 'asc' } }),
            prisma.task.findMany({ where: { userId: user.id, dueDate: { gte: dataAlvo, lte: fimDia } }, orderBy: { dueDate: 'asc' } })
          ]);
          const dataFmt = dataAlvo.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
          const ehPassado = fimDia < nowBRT();
          if (!lembretesData.length && !tarefasData.length) {
            // Para datas PASSADAS, não dá pra afirmar com certeza que "não
            // teve nada" — lembretes não confirmados com mais de 48h são
            // apagados automaticamente (ver cron de limpeza em
            // reminders.js), então a ausência pode significar "realmente
            // não teve nada" OU "teve algo mas já foi limpo por não ter
            // sido confirmado". Para datas futuras essa ambiguidade não
            // existe — vazio é só vazio mesmo.
            blocos.push(ehPassado
              ? `[${dataFmt}, data passada] Nada encontrado no banco para essa data. IMPORTANTE: isso pode significar que realmente não havia nada, OU que havia algo não confirmado que já foi removido automaticamente (lembretes não confirmados somem após 48h). Avise essa incerteza ao usuário em vez de afirmar com certeza que não teve nada.`
              : `[${dataFmt}] Nada agendado para essa data no banco de dados — confirmado pela busca real.`);
          } else {
            const itens = [
              ...lembretesData.map(r => `${new Date(r.scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })} — ${r.message}`),
              ...tarefasData.map(t => `${t.dueTime || '(sem horário)'} — ${t.title}`)
            ];
            blocos.push(`[${dataFmt}]\n${itens.map(i => `• ${i}`).join('\n')}`);
          }
        }
        const contextoData = `\n\n[CONSULTA DATA] Resultado da busca real no banco de dados:\n${blocos.join('\n\n')}`;
        await responderLivre(user, phone, text, contextoData, false);
        return;
      } catch (e) {
        console.error('[consulta data específica]', e.message);
        // Em caso de erro, cai no fluxo padrão abaixo em vez de travar.
      }
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

    // ajustar_remedio precisa rodar de forma síncrona (não fire-and-forget)
    // para sabermos o número real de doses resultante antes de confirmar —
    // evita a Clara "inventar" ou ficar vaga sobre a quantidade.
    let confirmacaoAjusteRemedio = null;
    if (classified.tipo === 'ajustar_remedio') {
      confirmacaoAjusteRemedio = await executeAjustarRemedio(user, classified).catch(e => {
        console.error('Erro ajustar_remedio:', e.message);
        return null;
      });
    } else {
      // ── AWAIT em vez de fire-and-forget ──
      // Bug corrigido: antes essa chamada não era esperada (.catch() sem
      // await) — a Clara já respondia "Anotado!" pro usuário enquanto a
      // gravação real no banco (ex: criação do Reminder) ainda rodava em
      // segundo plano. Na maioria das vezes isso não dava problema (a
      // gravação é rápida), mas em dias com muitos deploys em sequência
      // (como hoje), se o processo fosse reiniciado bem nesse instante, a
      // gravação podia ser interrompida no meio — o usuário recebia a
      // confirmação, mas o lembrete nunca chegava a existir de verdade no
      // banco (bug observado: lembrete confirmado por mensagem mas que
      // nunca disparou). Agora esperamos a gravação terminar de verdade
      // antes de seguir pra mensagem de confirmação.
      await executeAction(user, phone, classified, text).catch(e => console.error('Erro executeAction:', e.message));
    }
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
      ajustar_remedio: confirmacaoAjusteRemedio || '😕 Não encontrei esse remédio. Me diz o nome certinho?',
    };
    const acaoConfirmacao = CONFIRMACOES_ACAO[classified.tipo] || null;

    await responderLivre(user, phone, text, '', isSaudacao, acaoConfirmacao);
    extractAndSavePersonalInfo(user.id, text).catch(e => console.error('[extract pessoal]', e.message));
  } catch (error) {
    console.error('Erro handleMessage:', error.message);
    try {
      await sendMessage(phone, 'Ops, tive um probleminha. Pode repetir?');
    } catch (e2) {
      console.error('Erro ao enviar mensagem de erro:', e2.message);
    }
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

// Ajusta o estoque (doses restantes) e/ou os horários de um medicamento —
// usado para correções manuais via texto (ex: "ajusta pra 31 doses",
// "remarca a tiroide pra 7h", "muda de 7:30 pra 7:00").
// Roda de forma síncrona (não fire-and-forget) para podermos confirmar
// com os valores reais resultantes, em vez de uma mensagem genérica/vaga.
// Retorna a mensagem de confirmação, ou null se não encontrou o remédio.
async function executeAjustarRemedio(user, classified) {
  const medicamentos = await prisma.medication.findMany({ where: { userId: user.id, active: true } });
  if (!medicamentos.length) return null;

  let med = null;
  if (classified.nome) {
    const termo = classified.nome.toLowerCase();
    med = medicamentos.find(m => m.name.toLowerCase().includes(termo) || termo.includes(m.name.toLowerCase().split(' ')[0]));
  }
  // Sem nome citado: se só há 1 remédio ativo, usa ele. Se houver vários,
  // usa o mais recentemente atualizado/criado — evita perguntar o nome
  // sempre quando há um contexto óbvio (ex: resposta ao "hora do remédio").
  if (!med) {
    med = medicamentos.length === 1
      ? medicamentos[0]
      : medicamentos.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))[0];
  }
  if (!med) return null;

  const dataUpdate = {};
  const partesConfirmacao = [];

  // ── Ajuste de doses/estoque ──
  if (classified.doses !== undefined && classified.doses !== null) {
    let novoRemaining = med.remaining;
    if (classified.operacao === 'decrementar') {
      novoRemaining = Math.max(0, med.remaining - (classified.doses || 1));
    } else {
      novoRemaining = Math.max(0, classified.doses);
    }
    dataUpdate.remaining = novoRemaining;
    partesConfirmacao.push(`${novoRemaining} dose${novoRemaining === 1 ? '' : 's'} em estoque`);
  }

  // ── Ajuste de horário(s) ──
  if (classified.novos_horarios && Array.isArray(classified.novos_horarios) && classified.novos_horarios.length) {
    // Redefine a lista completa de horários
    dataUpdate.times = JSON.stringify(classified.novos_horarios);
    dataUpdate.frequency = classified.novos_horarios.length;
    partesConfirmacao.push(`horários: ${classified.novos_horarios.join(', ')}`);
  } else if (classified.horario_novo) {
    // Troca um horário específico (ou o único, se não houver antigo citado)
    let horarios = [];
    try { horarios = JSON.parse(med.times || '[]'); } catch {}

    if (classified.horario_antigo) {
      const idx = horarios.indexOf(classified.horario_antigo);
      if (idx >= 0) horarios[idx] = classified.horario_novo;
      else horarios.push(classified.horario_novo); // horário antigo não encontrado, adiciona o novo
    } else if (horarios.length === 1) {
      horarios = [classified.horario_novo];
    } else if (horarios.length > 1) {
      // Múltiplos horários sem especificar qual trocar — substitui o mais próximo do horário antigo citado, ou o primeiro
      horarios[0] = classified.horario_novo;
    } else {
      horarios = [classified.horario_novo];
    }

    horarios.sort();
    dataUpdate.times = JSON.stringify(horarios);
    dataUpdate.frequency = horarios.length;
    partesConfirmacao.push(`horário${horarios.length > 1 ? 's' : ''}: ${horarios.join(', ')}`);
  }

  if (Object.keys(dataUpdate).length === 0) return null;

  await prisma.medication.update({ where: { id: med.id }, data: dataUpdate });
  console.log(`[ajustar_remedio] ${med.name}: ${partesConfirmacao.join(' | ')}`);

  return `✅ Ajustado! "${med.name}" agora tem ${partesConfirmacao.join(' e ')}.`;
}

async function executeAction(user, phone, classified, originalText) {
  switch (classified.tipo) {
    case 'ponto_multiplo':
      await salvarPontoSilencioso(user, classified.acoes, phone);
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

      if (match) {
        await prisma.reminder.update({ where: { id: match.id }, data: { confirmed: true } });
        fecharPendenciaLembrete(user.id, match.message).catch(() => {});
      }
      break;
    }
    case 'saldo':
      if (classified.valor !== undefined && classified.valor !== null) await memory.saveUserPreference(user.id, null, null, parseFloat(classified.valor));
      break;
  }
}

async function salvarPontoSilencioso(user, acoes, phone) {
  const hoje = dateBRT();
  const prefs = await memory.getUserPreference(user.id).catch(() => ({}));
  const nome = prefs.name ? prefs.name.split(' ')[0] : null;

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

    const hm = timestamp.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

    // ── Comportamentos imediatos por tipo de ponto ──

    if (subtipo === 'entrada') {
      // Confirma entrada com boa energia + salva horário habitual de entrada
      const cumps = [
        `Registrei sua entrada às ${hm} 📍 Bom trabalho hoje${nome ? ', ' + nome : ''}! 💪`,
        `Entrada registrada: ${hm} ✅ Vai com tudo${nome ? ', ' + nome : ''}! 🚀`,
        `Marcado! Você chegou às ${hm} 📍 Bom trabalho hoje${nome ? ', ' + nome : ''}! ☀️`,
      ];
      await sendMessage(phone, cumps[Math.floor(Math.random() * cumps.length)]);

      // Aprende horário habitual de entrada (salva se ainda não tem ou é diferente)
      const horaEntradaMemoria = await prisma.memory.findFirst({
        where: { userId: user.id, type: 'horario_entrada_trabalho' }
      }).catch(() => null);
      if (!horaEntradaMemoria) {
        await prisma.memory.create({ data: { userId: user.id, type: 'horario_entrada_trabalho', content: hm } }).catch(() => {});
      }

    } else if (subtipo === 'saida_almoco') {
      // Agenda proativa de 20min: "como foi o almoço?"
      const voltarEm20 = new Date(timestamp.getTime() + 20 * 60 * 1000);
      await prisma.reminder.create({
        data: {
          userId: user.id,
          phone: phone,
          message: `__PONTO_ALMOCO_FOLLOWUP__`,
          scheduledAt: voltarEm20,
        }
      }).catch(() => {});

      // Salva horário habitual de almoço
      await prisma.memory.upsert({
        where: { id: (await prisma.memory.findFirst({ where: { userId: user.id, type: 'horario_almoco' } }).catch(() => null))?.id || 'noop' },
        update: { content: hm },
        create: { userId: user.id, type: 'horario_almoco', content: hm }
      }).catch(async () => {
        const ex = await prisma.memory.findFirst({ where: { userId: user.id, type: 'horario_almoco' } }).catch(() => null);
        if (!ex) await prisma.memory.create({ data: { userId: user.id, type: 'horario_almoco', content: hm } }).catch(() => {});
      });

    } else if (subtipo === 'saida') {
      // Salva horário habitual de saída — usado pelo cron de hora extra
      const horaSaidaMemoria = await prisma.memory.findFirst({
        where: { userId: user.id, type: 'horario_saida_trabalho' }
      }).catch(() => null);
      if (!horaSaidaMemoria) {
        await prisma.memory.create({ data: { userId: user.id, type: 'horario_saida_trabalho', content: hm } }).catch(() => {});
      } else {
        // Atualiza se mudou mais de 30min do habitual (evita sobreescrever por exceção)
        const [hh, mm] = hm.split(':').map(Number);
        const [hhabitual, mmhabitual] = horaSaidaMemoria.content.split(':').map(Number);
        const diffMin = Math.abs((hh * 60 + mm) - (hhabitual * 60 + mmhabitual));
        if (diffMin > 30) {
          // Verifica se isso virou padrão (3+ dias com essa hora)
          const ultimasSaidas = await prisma.workLog.findMany({
            where: { userId: user.id, type: 'saida' },
            orderBy: { timestamp: 'desc' },
            take: 3
          }).catch(() => []);
          const saidasNoMesmoHorario = ultimasSaidas.filter(s => {
            const [sh, sm] = s.timestamp.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).split(':').map(Number);
            return Math.abs((sh * 60 + sm) - (hh * 60 + mm)) <= 30;
          });
          if (saidasNoMesmoHorario.length >= 2) {
            await prisma.memory.update({ where: { id: horaSaidaMemoria.id }, data: { content: hm } }).catch(() => {});
            console.log(`[Ponto] Horário habitual de saída atualizado: ${hm} para ${user.id}`);
          }
        }
      }
    }
  }
}

function detectarUrgencia(titulo) {
  const t = (titulo || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // ── "farmacia", "remedio" e "medicamento" removidos desta lista ──
  // Antes, um lembrete criado via chat com essas palavras (ex: "tomar
  // remédio da gripe às 14h") caía no fluxo "urgente" (aviso 15min antes +
  // cobrança 15min depois + pergunta "como foi?" 2h depois) — pesado
  // demais pra remédio do dia a dia, e DUPLICADO com o sistema dedicado
  // de medicamentos (cadastro via "+ remédio"), que já tem seu próprio
  // alarme + follow-up de 20min. "vacina" continua na lista pois é um
  // evento pontual (não recorrente), mais parecido com consulta.
  const palavras = ['medico','medica','consulta','dentista','cirurgia','exame','laboratorio','vacina','hospital','clinica','psico','terapia','fisio','upa','documento','cartorio','contrato','assinar','entregar','protocolar','prazo','vencimento','vence','renovar','passaporte','rg','cnh','voo','aeroporto','embarque','onibus','trem','reuniao','apresentacao','entrevista','prova','concurso','buscar','pegar','retirar','entregar','entrega','cabelereiro','barbearia','manicure','cabeleireiro','marmita','almoco','janta','jantar','escola','creche'];
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
      // Sem título: pega o lembrete mais recentemente disparado — ou seja,
      // o "sent" cujo scheduledAt está mais próximo do agora (não o mais
      // distante no futuro, que era o bug: scheduledAt desc pegava
      // lembretes antigos com data "maior" por engano, mesmo já passados
      // há mais tempo no relógio real).
      const agora = Date.now();
      const enviados = todosLembretes
        .filter(r => r.sent)
        .sort((a, b) => Math.abs(new Date(a.scheduledAt) - agora) - Math.abs(new Date(b.scheduledAt) - agora));
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
      await upsertMemoryPorTipo(user.id, 'contatos_listados', JSON.stringify(contatos)).catch(() => {});
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
    if (classified.tipo === 'salvar_cofre') {
      if (!classified.conteudo) { await sendMessage(phone, 'O que você quer guardar no cofre? 😊'); return; }
      // Mesmo formato usado pelo dashboard (forms.js POST /cofre/:phone):
      // content é um JSON com tipo+nome+dados, pra exibir certinho na tela Cofre.
      const dadosCofre = { tipo: 'nota', nome: classified.nome || 'Sem nome', nota: classified.conteudo };
      await prisma.memory.create({ data: { userId: user.id, type: 'cofre', content: JSON.stringify(dadosCofre) } });
      await sendMessage(phone, `🔐 Salvo no cofre! "${classified.nome || 'Item'}" protegido 💜`);
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
    // ── BUG CORRIGIDO: strip do prefixo de citação antes de normalizar ──
    // Quando o usuário responde arrastando (swipe-reply) uma notificação,
    // webhook.js monta o texto como `[Mensagem citada: "..."]\n${text real}`
    // antes de chamar handleMessage → checkConfirmacaoPendente. Todas as
    // regexes aqui (ex: /^(sim|pode|isso|...)/i) são ANCORADAS no início
    // da string (^) — com o prefixo de citação colado na frente, o ^ nunca
    // batia com a resposta real do usuário, fazendo TODA confirmação via
    // swipe-reply (fechamento_pendentes, hora_lembrete, remarcar_negacao,
    // selecao_contato, sim/não de envio de mensagem, urgente_confirmacao)
    // cair silenciosamente no fluxo normal de classify — que não sabe lidar
    // com essas pendências e responde algo desconexo. Removendo o prefixo
    // aqui, a checagem volta a enxergar só a resposta real ("Pode concluir
    // tudo fedo"), independente de ter sido enviada com ou sem citação.
    const textSemCitacao = text.replace(/^\[Mensagem citada:\s*"[^"]*"\]\s*\n?/i, '');
    const textNorm = textSemCitacao.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    if (dados.tipo === 'fechamento_pendentes') {
      // Resposta ao cron de Fechamento (18h, reminders.js) que perguntou
      // "posso concluir todos, ou quer remarcar algum?" — diferente da
      // pendência de saúde, aqui a resposta precisa de uma AÇÃO real no
      // banco, não só uma reação em texto.
      const afirmativo = /^(sim|pode|isso|s|ok|beleza|confirma|confirmado|concluir? tudo|pode concluir|todos?)\b/i.test(textNorm);
      if (afirmativo) {
        await prisma.reminder.updateMany({
          where: { id: { in: dados.reminderIds } },
          data: { confirmed: true }
        });
        await prisma.memory.delete({ where: { id: pendente.id } }).catch(() => {});
        const contextoExtra = `\n\n[AÇÃO] Todos os ${dados.reminderIds.length} lembrete(s) pendentes foram marcados como concluídos agora, conforme pedido. Confirme isso brevemente e com naturalidade.`;
        await responderLivre(user, phone, text, contextoExtra);
        return true;
      }
      // Resposta não é uma confirmação clara de "tudo" — provavelmente o
      // usuário quer remarcar algo específico ou listar o que falta.
      // Deixa a pendência expirar sozinha (não força decisão binária aqui)
      // e segue pro fluxo normal, que já sabe lidar com "remarcar X" via
      // classify/editar_lembrete.
      await prisma.memory.delete({ where: { id: pendente.id } }).catch(() => {});
      return false;
    }

    if (dados.tipo === 'pendencia_emocional') {
      // A Clara puxou de volta um assunto sozinha (cron "PENDÊNCIAS
      // EMOCIONAIS" em reminders.js) — isso aqui é a resposta do usuário.
      // Não usamos texto fixo: deixamos o freeResponse reagir de forma
      // genuína (cobrança leve se ainda não resolveu, comemoração se sim),
      // mantendo o tom escolhido, em vez de uma confirmação robótica.
      await prisma.pendencia.update({ where: { id: dados.pendenciaId }, data: { resolvido: true } }).catch(() => {});
      await prisma.memory.delete({ where: { id: pendente.id } }).catch(() => {});
      const instrucao = dados.categoria === 'saude'
        ? 'Se a resposta indicar que ainda não melhorou ou não cuidou disso, dê uma cobrança leve e genuína, do jeito do seu tom. Se já melhorou, comemore brevemente.'
        : 'Reaja ao resultado contado — comemore se foi bom, console se foi ruim — com curiosidade genuína de amiga, não como assistente.';
      const contextoExtra = `\n\n[PENDÊNCIA RESPONDIDA] Você tinha perguntado de volta sobre "${dados.resumo}". O usuário acabou de te contar o resultado/detalhes na mensagem atual. ${instrucao} NÃO repita a pergunta. NÃO reformule os fatos que ele contou como uma pergunta de confirmação (ex: NUNCA faça algo como "Foi assim: X. Confirma?") — ele já te contou, é informação dada, não precisa de checagem. Reaja com uma frase genuína (torça, comemore, brinque, console — o que couber), sem repetir os detalhes de volta para ele.`;
      await responderLivre(user, phone, text, contextoExtra);
      return true;
    }

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

    if (dados.tipo === 'remarcar_negacao') {
      // Usuário respondeu "não" à pergunta "já concluiu?" do disparo do
      // lembrete, e a Clara perguntou pra que horas remarcar. Extrai o
      // horário da resposta (mesmo parser usado em hora_lembrete).
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

      // Também aceita "daqui X minutos/horas" como resposta
      const relativo = calcularHorarioRelativo(text);

      const naoSabe = /nao sei|não sei|qualquer|tanto faz|vc escolhe|voce escolhe|decide voce|sei nao|mais tarde/.test(textNorm);

      if (!horaEscolhida && !relativo && !naoSabe) {
        await sendMessage(phone, 'Não entendi o horário 😅 Pode me dizer assim: "14h", "daqui 30 minutos", ou "não sei" que eu deixo em 30 minutos.');
        return true;
      }

      let novoScheduledAt;
      if (relativo) {
        novoScheduledAt = relativo;
      } else if (horaEscolhida) {
        const [h, m] = horaEscolhida.split(':').map(Number);
        novoScheduledAt = new Date(`${dateBRT()}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00-03:00`);
        if (novoScheduledAt < nowBRT()) novoScheduledAt.setDate(novoScheduledAt.getDate() + 1);
      } else {
        // não sabe — fallback de 30 minutos
        novoScheduledAt = new Date(Date.now() + 30 * 60 * 1000);
      }

      await prisma.reminder.update({ where: { id: dados.lembreteId }, data: { scheduledAt: novoScheduledAt, sent: false, confirmed: false } });
      await prisma.memory.delete({ where: { id: pendente.id } });

      const horaFmt = novoScheduledAt.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
      const dataFmt = novoScheduledAt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
      await sendMessage(phone, `✅ Remarcado! "${dados.lembreteTitulo}" pra ${dataFmt} às ${horaFmt} 📌`);
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
  if (infos && infos.length > 0) {
    for (const { chave, valor, categoria } of infos) {
      if (!chave || !valor) continue;
      await savePersonalInfo(userId, chave, valor, categoria || 'outro');
      console.log(`[memória pessoal] salvo: ${chave} = "${valor}"`);
    }
  }

  // ── Pendência emocional: mal-estar passageiro ou evento com resultado
  // incerto, pra Clara voltar a perguntar depois sozinha (ver cron
  // "PENDÊNCIAS EMOCIONAIS" em reminders.js) ──
  try {
    const pendencia = await extractPendenciaEmocional(text);
    if (pendencia) {
      await savePendencia(userId, pendencia);
      console.log(`[pendência emocional] salva: ${pendencia.categoria} — "${pendencia.resumo}" (check-in em ${pendencia.horas}h)`);
    }
  } catch (e) {
    console.error('[extractPendenciaEmocional]', e.message);
  }

  // ── Resolução de pendência aberta ──
  // Cobre o caso em que a Clara trouxe o assunto à tona sozinha NA
  // CONVERSA (via bloco [SAÚDE EM ABERTO] em responderLivre), não pelo
  // cron — esse caminho não gera um registro de confirmacao_pendente, então
  // sem essa checagem aqui a pendência nunca seria marcada como resolvida
  // e voltaria a ser perguntada para sempre, mesmo já confirmada.
  try {
    const pendenciaAberta = await prisma.pendencia.findFirst({
      where: { userId, resolvido: false },
      orderBy: { createdAt: 'desc' }
    });
    if (pendenciaAberta) {
      const resolvida = await checkResolucaoPendencia(text, pendenciaAberta.resumo);
      if (resolvida) {
        await prisma.pendencia.update({ where: { id: pendenciaAberta.id }, data: { resolvido: true } });
        console.log(`[pendência emocional] resolvida via conversa: "${pendenciaAberta.resumo}"`);
      }
    }
  } catch (e) {
    console.error('[checkResolucaoPendencia]', e.message);
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
      await upsertMemoryPorTipo(userId, 'relationship_summary', novoResumo).catch(() => {});
    }
  } catch(e) {}
}

module.exports = { handleMessage };
