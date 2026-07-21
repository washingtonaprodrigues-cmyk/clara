// v2 - consulta direta sem LLM
// Sessao 11 (25/06/2026): multiplas_tarefas, acao confirmada no contexto,
// timezone no contexto, classify com exemplos de horario quebrado, anti-loop apelido.
// Sessao 12 (10/07/2026): confirmacoes de sistema em 1 linha (Feito!/Tomado!/Anotado!),
// Clara comenta separada so se genuino (nunca generico). Ver webhook.js LembreteConfirm.
const { classify, extractPersonalInfo, extractPendenciaEmocional, extractEpisodio, checkResolucaoPendencia, searchWeb, freeResponse, generateMemorySummary, generateRelationshipSummary, ativarModoComparacao, desativarModoComparacao, emModoComparacao, detectarComandoComparacao, detectarAssuntoEmAberto, infoDatas, isRespostaFallback, extrairQueryBusca, buildPersonality, apararRespostaCortada, detectarPadraoReacao, filtrarResposta } = require('./groq');
const { geminiFreeResponse, geminiDisponivel, todosModelosEsgotados } = require('./gemini');

// CORREÇÃO DETERMINÍSTICA DE DIA DA SEMANA:
// O classify() já recebe uma tabela com a data exata de cada dia da semana
// e instrução pra "nunca calcular por conta própria" — mas modelos (mesmo
// seguindo a instrução na maioria das vezes) ocasionalmente calculam errado
// de qualquer forma (ex: usuário disse "segunda" e o modelo devolveu uma
// data de outra semana). Como isso é 100% calculável em código, sempre que
// o texto original citar um dia da semana explícito (sem qualificador tipo
// "que vem"/"próxima", que pode legitimamente significar a semana seguinte),
// sobrescrevemos classified.data com o valor correto, ignorando o que o
// modelo respondeu.
const DIAS_SEMANA_REGEX = /\b(domingo|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado)(-feira)?\b/i;
const QUALIFICADOR_SEMANA_QUE_VEM = /\b(que vem|pr[oó]xim[ao]|da semana que vem)\b/i;
function corrigirDataDiaSemana(textoOriginal, classified) {
  if (!classified || !classified.data) return classified;
  const matchDia = textoOriginal.match(DIAS_SEMANA_REGEX);
  if (!matchDia) return classified;
  if (QUALIFICADOR_SEMANA_QUE_VEM.test(textoOriginal)) return classified; // deixa o modelo decidir esse caso mais ambíguo
  const nomeDiaRaw = matchDia[1].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // remove acento: terça→terca, sábado→sabado
  const mapaNormalizado = { domingo: 'domingo', segunda: 'segunda', terca: 'terça', quarta: 'quarta', quinta: 'quinta', sexta: 'sexta', sabado: 'sábado' };
  const nomeDia = mapaNormalizado[nomeDiaRaw];
  const { mapa } = infoDatas();
  const dataCorreta = nomeDia && mapa[nomeDia];
  if (dataCorreta && dataCorreta !== classified.data) {
    console.log(`[DATA_CORRIGIDA] "${nomeDia}" → modelo disse ${classified.data}, correto é ${dataCorreta}`);
    classified.data = dataCorreta;
  }
  return classified;
}

// Peça 2 da dedução: resolve a DATA DE FIM de um tratamento a partir de texto
// livre ("na segunda", "até sexta", "amanhã", "hoje"). Retorna Date (fim do dia
// em BRT) ou null. Reusa o mapa de dias-da-semana do infoDatas().
function resolverDataFim(texto) {
  const t = (texto || '').toLowerCase();
  if (/\bhoje\b/.test(t)) { const d = nowBRT(); d.setHours(23, 59, 59, 0); return d; }
  if (/\bamanh[ãa]\b/.test(t)) { const d = nowBRT(); d.setDate(d.getDate() + 1); d.setHours(23, 59, 59, 0); return d; }
  const m = t.match(DIAS_SEMANA_REGEX);
  if (m) {
    const raw = m[1].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const mapaNorm = { domingo: 'domingo', segunda: 'segunda', terca: 'terça', quarta: 'quarta', quinta: 'quinta', sexta: 'sexta', sabado: 'sábado' };
    const nome = mapaNorm[raw];
    try {
      const { mapa } = infoDatas();
      const ds = nome && mapa[nome]; // 'YYYY-MM-DD' (próxima ocorrência)
      if (ds) return new Date(`${ds}T23:59:59-03:00`);
    } catch {}
  }
  return null;
}

// Item 4: decide se a cidade do usuário deve entrar na busca. Só entra quando a
// intenção é claramente LOCAL e a query NÃO traz cidade explícita — senão
// "hotel em Curitiba" viraria "...em <cidade do user>". Conservador: na dúvida,
// NÃO injeta (busca sem cidade funciona; busca poluída com cidade errada, não).
function cidadeParaBusca(query, cidade) {
  if (!cidade) return '';
  const q = (query || '');
  const qLow = q.toLowerCase();
  const intencaoLocal = /(perto|pr[óo]xim|\baqui\b|por aqui|perto de mim|na minha (cidade|regi[ãa]o|[áa]rea)|farm[áa]cia|drogaria|restaurante|lanchonete|pizzaria|posto|mercado|supermercado|padaria|hospital|pronto.?socorro|cl[íi]nica|dentista|cinema|shopping|\bloja\b|barbearia|sal[ãa]o|previs[ãa]o do tempo|\bclima\b|\btempo (hoje|amanh|agora|de hoje)|vai chover|temperatura|tr[âa]nsito)/.test(qLow);
  if (!intencaoLocal) return '';
  // cidade explícita na própria query (ex: "em Curitiba", "no Rio") → não injeta
  const temCidadeExplicita = /(^|\s)(em|no|na|nos|nas|pra|para)\s+[A-ZÀ-Ú]/.test(q);
  if (temCidadeExplicita) return '';
  return cidade;
}

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
const { buildPersonalContext, savePersonalInfo, saveContact, getContacts, findContactByName, savePendencia, fecharPendenciaLembrete, salvarHumorDia, getHumorDia, salvarLocalizacao, getLocalizacao, salvarMemoriaAfetiva } = memory;

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

// Gera um comentário de personalidade curto via Gemini puro — sem cascata
// pra Groq. Usado nos backgrounds opcionais (pós-lembrete, pós-medicamento,
// pós-multiplas_tarefas). Se Gemini falhar, espera 4s e tenta mais uma vez
// antes de desistir — cobre casos de retorno vazio momentâneo.
async function comentarioGemini(systemPrompt, userMessage, maxTokens = 150) {
  const tentarUmaVez = async () => {
    if (!geminiDisponivel() || todosModelosEsgotados()) return null;
    const resp = await geminiFreeResponse([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ], { temperature: 0.85, maxTokens });
    return resp && resp.trim().length > 3 ? resp.trim() : null;
  };
  try {
    const resultado = await tentarUmaVez();
    if (resultado) return resultado;
    // Primeira tentativa retornou vazio — espera 4s e tenta de novo
    await new Promise(r => setTimeout(r, 4000));
    return await tentarUmaVez();
  } catch {
    try {
      await new Promise(r => setTimeout(r, 4000));
      return await tentarUmaVez();
    } catch { return null; }
  }
}

// Monta o pedacinho de contexto relacional (apelidos, piadas internas, tom
// da relação) usado pra deixar a busca soar "ela 100%" e não só a
// personalidade base — a mesma memória usada no fluxo normal de conversa.
async function buscarContextoRelacional(userId) {
  try {
    const relMemoria = await prisma.memory.findFirst({ where: { userId, type: 'relationship_summary' }, orderBy: { createdAt: 'desc' } }).catch(() => null);
    return relMemoria?.content ? `\n\n[MEMÓRIA DO RELACIONAMENTO]\n${relMemoria.content}` : '';
  } catch { return ''; }
}

// Gera o aviso de "deixa eu checar" NA VOZ da Clara — nada de lupa nem recado
// fixo. Usado nos caminhos de busca via __BUSCAR__ (o caminho de busca
// classificada já gera o dele inline). Se a geração falhar, cai em frases
// fixas COM personalidade (estilo do backup) — nunca uma lupa seca.
async function gerarAvisoBusca(text, tom = 'carinhoso', apelido = '') {
  // Frases fixas por tom — mais confiável que geração. O Gemini era criativo
  // demais no aviso e acabava respondendo a pergunta antes de buscar.
  // Frases curtas, naturais, no tom dela, sem revelar nenhuma informação.
  const n = apelido || '';
  const por_tom = {
    carinhoso: n ? [
      `Pera aí que vou dar uma olhada pra gente, ${n}! 💜`,
      `Já vejo isso pra você, ${n}! 😊`,
      `Um segundo que já checo aqui!`,
    ] : [
      `Pera aí que vou dar uma olhada pra gente! 💜`,
      `Já vejo isso! 😊`,
      `Um segundo que já checo aqui!`,
    ],
    direto: [`Verificando.`, `Um segundo.`, `Já checo.`],
    divertido: n ? [
      `Pera aí que vou dar uma olhada pra gente, ${n}! 😄`,
      `Já vejo isso, ${n}!`,
      `Um segundo que já checo!`,
    ] : [
      `Pera aí que vou dar uma olhada pra gente! 😄`,
      `Já vejo isso!`,
      `Um segundo que já checo!`,
    ],
    sarcastico: n ? [
      `Pera aí que vou dar uma olhada pra gente, ${n}. 😉`,
      `Já vejo isso, ${n}.`,
      `Um segundo.`,
    ] : [
      `Pera aí que vou dar uma olhada pra gente. 😉`,
      `Já vejo isso.`,
      `Um segundo.`,
    ],
  };
  const opcoes = por_tom[tom] || por_tom.carinhoso;
  return opcoes[Math.floor(Math.random() * opcoes.length)];
}

async function responderLivre(user, phone, text, contextoExtra = '', skipContext = false, acaoConfirmacao = null, confirmacaoSeparada = null) {
  try {
    const history = await memory.getConversationHistory(user.id, 16);
    const preferences = await memory.getUserPreference(user.id);
    preferences._phone = phone;

    if (acaoConfirmacao) preferences._acaoConfirmacao = acaoConfirmacao;
    if (confirmacaoSeparada) {
      preferences._confirmacaoSeparada = confirmacaoSeparada;
      // A IA não recebe a confirmação pra despejar (isso vai na 2ª mensagem),
      // mas precisa saber que o lembrete FOI criado, pra responder coerente
      // (comentar/brincar) sem dizer que vai anotar no futuro nem repetir
      // título/hora — isso já vem logo depois, cru.
      preferences._dicaAcao = 'O lembrete que o usuário pediu JÁ foi anotado — a confirmação detalhada (título + horário) será enviada logo após. Responda de forma NATURAL, como se o lembrete fosse algo implícito e já resolvido. PROIBIDO: NÃO mencione horário, data nem título; NÃO diga "criei", "anotei", "registrei", "já até criei", "marquei", "agendei" nem qualquer variação — o usuário vai ver a confirmação em seguida. Foque em conversar sobre o assunto em si, pode comentar, brincar, reagir.';
    }

    if (skipContext) {
      preferences._contexto = '';
      const resp = await freeResponse(text, history, preferences);
      if (resp === null) return;
      if (resp && resp.includes('__BUSCAR:')) {
        const memAfSC = await memory.getMemoriaAfetiva(user.id).catch(() => ({}));
        const avSC = await gerarAvisoBusca(text, preferences?.tom || 'carinhoso', memAfSC?.apelido_usuario || preferences?.name || '');
        await sendMessage(phone, avSC);
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
        prisma.expense.findMany({ where: { userId: user.id, createdAt: { gte: inicioMes } } }),
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

      // ── Detecção de relevância por assunto da mensagem ───────────────────
      // Regexes amplas de propósito: cobrem as formas NATURAIS de falar, não só
      // as palavras óbvias. Melhor injetar o contexto a mais (a instrução já diz
      // pra ela não puxar por iniciativa) do que ela ficar "cega" quando o
      // usuário claramente tocou no assunto. Ex: "olha quanto sobrou", "minha
      // grana", "tô liso" → tudo dinheiro.
      const txtLow = (text||'').toLowerCase();
      const falaDeAgenda = /hoje|amanhã|amanha|horário|horario|quando|agenda|compromisso|reuni[ãa]o|consulta|m[ée]dico|dentista|semana|m[êe]s|marcad|agendad|hor[áa]rio|que horas|tenho algo|tenho que|preciso ir|calendário|calendario/.test(txtLow);
      const falaDeRemedio = /rem[ée]dio|comprimido|tomar|dose|farm[áa]cia|medicament|triglicere|toroide|holmis|landizin|rem[ée]dinho|cápsula|capsula|antibi[óo]tico|p[íi]lula|bula|receita/.test(txtLow);
      const faladeDinheiro = /dinheiro|gast|saldo|or[çc]amento|(paga|minha|a|essa|de)\s+conta|pagar|pagamento|reais|r\$|grana|sobrou|sobra|quanto tenho|quanto sobr|dispon[íi]vel|t[ôo] liso|falido|guap|bufunfa|extrato|finan[çc]|despesa|\bbanco\b|\bpix\b|d[íi]vida|divida|custou|custa|economiz|meu bolso|no vermelho/.test(txtLow)
        || (typeof classified !== 'undefined' && classified && (classified.tipo === 'consulta_saldo' || classified.tipo === 'relatorio_financeiro'));
      const falaDeLista = /lista|mercado|compras|item|comprar|feira|supermercado/.test(txtLow);
      const ehManha = now.getHours() >= 6 && now.getHours() < 11;

      if (lembretes.length > 0) {
        const fmtLemb = (r) => {
          const d = new Date(r.scheduledAt);
          const dStr = toDateStr(d) === hoje ? 'Hoje' : 'Amanhã';
          const horaBRT = d.toLocaleTimeString('pt-BR', {timeZone:'America/Sao_Paulo', hour:'2-digit', minute:'2-digit'});
          return `• ${dStr} às ${horaBRT} — ${r.message}`;
        };
        // Injeta agenda só se relevante — evita Clara puxar compromissos em papo casual
        if (falaDeAgenda || ehManha) {
          contexto += `\n\n[AGENDA — mencione SOMENTE se o usuário trouxer o assunto ou perguntar. Nunca puxe por iniciativa em conversa sobre outro assunto]\n${lembretes.map(fmtLemb).join('\n')}`;
        }
      }

      try {
        if (/envi|mand|recado|contato|mostr|lista/.test(txtLow)) {
          const contatos = await getContacts(user.id);
          if (contatos.length > 0) {
            const listaCtx = contatos.map((c,i) => `${i+1}. ${c.name}${c.relation?` (${c.relation})`:''} — ${c.phone}`).join('\n');
            contexto += `\n\n[CONTATOS SALVOS]\n${listaCtx}`;
          }
        }
      } catch(e) {}

      // Medicamentos — só injeta se falar de remédio ou for manhã (horário de tomar)
      if (meds.length > 0 && (falaDeRemedio || ehManha)) {
        const fmtMed = (m) => {
          let times = []; try { times = JSON.parse(m.times || '[]'); } catch {}
          const proxima = times.find(t => t >= hm) || times[0] || '—';
          const quando = times.find(t => t >= hm) ? 'hoje' : 'amanhã';
          return `• ${m.name} — próxima dose: ${proxima} (${quando}), ${m.remaining} doses restantes`;
        };
        contexto += `\n\n[MEDICAMENTOS]\n${meds.map(fmtMed).join('\n')}`;
      }

      // Financeiro — só injeta se falar de dinheiro. FLUXO DE CAIXA MENSAL:
      // saldo do mês = entradas − gastos. Se o usuário mencionar um mês
      // específico ("saldo de junho", "quanto gastei em maio"), busca AQUELE
      // mês; senão, usa o mês vigente (gastos já carregados).
      if (faladeDinheiro) {
        const MESES_NOMES = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
        const MESES_ALT = { 'marco':2, 'setembro':8 }; // sem acento
        // Detecta menção a mês por nome
        let mesAlvo = null; // 0-11, ou null = mês vigente
        for (let i = 0; i < MESES_NOMES.length; i++) {
          if (new RegExp(`\\b${MESES_NOMES[i]}\\b`, 'i').test(txtLow)) { mesAlvo = i; break; }
        }
        if (mesAlvo === null && /\bmarco\b/i.test(txtLow)) mesAlvo = 2;

        let gastosParaCalcular = gastos; // padrão: mês vigente (já carregado)
        let nomeMesLabel = now.toLocaleDateString('pt-BR', { month: 'long', timeZone: 'America/Sao_Paulo' });
        let ehMesEspecifico = false;

        if (mesAlvo !== null && mesAlvo !== now.getMonth()) {
          // Busca os gastos daquele mês específico. Considera o ano atual; se o
          // mês for futuro (ex: pergunta em jan sobre dezembro), usa ano passado.
          const anoAlvo = (mesAlvo - now.getMonth() > 6) ? now.getFullYear() - 1 : now.getFullYear();
          const inicioMesAlvo = new Date(anoAlvo, mesAlvo, 1);
          const fimMesAlvo = new Date(anoAlvo, mesAlvo + 1, 0, 23, 59, 59);
          gastosParaCalcular = await prisma.expense.findMany({
            where: { userId: user.id, createdAt: { gte: inicioMesAlvo, lte: fimMesAlvo } }
          }).catch(() => []);
          nomeMesLabel = MESES_NOMES[mesAlvo];
          ehMesEspecifico = true;
        }

        const saidas = gastosParaCalcular.filter(g => g.value > 0);
        const entradas = gastosParaCalcular.filter(g => g.value < 0);
        const totalGasto = saidas.reduce((a, g) => a + g.value, 0);
        const totalEntradas = entradas.reduce((a, g) => a + Math.abs(g.value), 0);
        const saldoMes = totalEntradas - totalGasto;
        const labelMes = ehMesEspecifico ? `${nomeMesLabel} (mês que o usuário perguntou)` : `${nomeMesLabel} (mês vigente)`;

        if (totalEntradas > 0 || totalGasto > 0) {
          contexto += `\n\n[FINANCEIRO — ${labelMes}]\nEntradas (recebido): R$ ${totalEntradas.toFixed(2)}\nGastos: R$ ${totalGasto.toFixed(2)}\nSaldo do mês (entradas − gastos): R$ ${saldoMes.toFixed(2)}\n\n[INSTRUÇÃO] O usuário perguntou das finanças. RESPONDA com esses números concretos no seu tom (ex: "esse mês você recebeu X, gastou Y, sobrou Z"). NÃO responda de forma vaga nem só pergunte "algum gasto te surpreendeu?" — mostre os valores reais primeiro, aí sim pode comentar.`;
        } else {
          contexto += `\n\n[FINANCEIRO — ${labelMes}]\nNenhum lançamento nesse mês (nem salário nem gastos registrados).\n\n[INSTRUÇÃO] Diga claramente que não há nada registrado nesse mês ainda — nem entradas nem gastos. Não invente números.`;
        }
      }

      // Listas — só injeta se falar de lista/compras
      if (falaDeLista) {
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
          }
        } catch(e) {}
      }

      if (relMemoria?.content) contexto += `\n\n[MEMÓRIA DO RELACIONAMENTO]\n${relMemoria.content}`;

      // ── Episódios recentes da vida do usuário ─────────────────────────
      // Lógica temporal: episódio só aparece no contexto quando for o momento
      // certo — como uma amiga que lembra de perguntar na hora certa, não toda
      // hora. Isso evita puxar assunto de semanas atrás como se fosse agora.
      try {
        const episodios = await prisma.memory.findMany({
          where: {
            userId: user.id, type: 'episodio_vida',
            createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
          },
          orderBy: { createdAt: 'desc' }, take: 10
        });
        if (episodios.length > 0) {
          const agora = Date.now();
          const RECENTE_MS    = 2 * 24 * 60 * 60 * 1000; // 0-2 dias: sempre mostra
          const RESOLVIDO_MS  = 2 * 24 * 60 * 60 * 1000; // resolvido: mostra por 2 dias

          const filtrados = episodios.filter(e => {
            let meta = {}; try { meta = JSON.parse(e.metadata || '{}'); } catch {}
            const idade = agora - new Date(e.createdAt).getTime();
            const pendente = meta.resultado === 'pendente';

            // Muito recente (< 2 dias): sempre mostra independente do status
            if (idade < RECENTE_MS) return true;

            // Resolvido: mostra por mais 2 dias pra ela poder comentar, depois some
            if (!pendente) return idade < RESOLVIDO_MS;

            // Pendente com prazo definido: só mostra quando o prazo chegou
            if (meta.acompanhar_em_dias) {
              // Usa next_check_at se foi reiniciado ("ainda não"), senão usa createdAt
              const baseCheck = meta.next_check_at
                ? new Date(meta.next_check_at).getTime()
                : new Date(e.createdAt).getTime() + (meta.acompanhar_em_dias * 24 * 60 * 60 * 1000);
              return agora >= baseCheck;
            }

            // Pendente sem prazo: mostra por até 5 dias
            return idade < 5 * 24 * 60 * 60 * 1000;
          }).slice(0, 3);

          if (filtrados.length > 0) {
            const listaEp = filtrados.map(e => {
              let meta = {}; try { meta = JSON.parse(e.metadata || '{}'); } catch {}
              return `• ${e.content}${meta.resultado === 'pendente' ? ' (ainda vai acontecer ou não atualizou)' : ''}`;
            }).join('\n');
            contexto += `\n\n[CONTEXTO DE VIDA RECENTE — use naturalmente se relevante, nunca force]\n${listaEp}`;
          }
        }
      } catch(e) {}

      // ── Conhecimento que Clara adquiriu pesquisando em sessões anteriores ──
      // Quando ela pesquisou algo pra si mesma (modo 'participar'), guarda
      // aqui. Nas próximas conversas, se o assunto aparecer, ela já sabe —
      // não precisa anunciar que vai buscar como se fosse novidade.
      try {
        const conhecimentos = await prisma.memory.findMany({
          where: {
            userId: user.id,
            type: 'conhecimento_adquirido',
            createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
          },
          orderBy: { createdAt: 'desc' },
          take: 5
        });
        if (conhecimentos.length > 0) {
          const lista = conhecimentos.map(c => {
            let meta = {}; try { meta = JSON.parse(c.metadata || '{}'); } catch {}
            return `• ${c.content}${meta.resumo ? ': ' + meta.resumo.slice(0, 120) : ''}`;
          }).join('\n');
          contexto += `\n\n[ASSUNTOS QUE JÁ PESQUISEI — já conheço, posso entrar na conversa direto]\n${lista}`;
        }
      } catch(e) {}

      // ── Pendência de saúde: traz à tona se fizer sentido na conversa ──
      // ── Pendência de saúde: só aparece no contexto se fizer sentido ──
      // IMPORTANTE: quando há pendência de saúde/evento, injeta agenda relacionada
      // para que a Clara referencie lembretes reais em vez de remédios/doses
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
      // Não injeta saúde em aberto se a mensagem atual é confirmação de remédio
      const ehConfirmacaoRemedio = /^(tomado|tomei|já tomei|tomou|feito)\s*(fedo)?\.?$/i.test((text||'').trim());
      if (pendenciaSaude && !temAssuntoAberto && !ehConfirmacaoRemedio) {
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
        // Busca lembretes futuros relacionados para dar contexto real à pergunta
        const lembretesRelac = await prisma.reminder.findMany({
          where: { userId: user.id, confirmed: false, scheduledAt: { gte: new Date() } },
          orderBy: { scheduledAt: 'asc' }, take: 3
        }).catch(() => []);
        const agendaRelac = lembretesRelac.length > 0
          ? ` Lembretes relacionados na agenda: ${lembretesRelac.map(r => {
              const h = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
              return `"${r.message}" às ${h}`;
            }).join(', ')}.`
          : '';
        contexto += `\n\n[SAÚDE EM ABERTO] Mais cedo a pessoa mencionou: "${pendenciaSaude.resumo}".${agendaRelac} Se fizer sentido natural na conversa, pergunte com carinho genuíno como está — referencie a agenda acima se relevante. NUNCA cite remédios, doses ou medicamentos aqui. Não force se a mensagem for sobre outro assunto.`;
      }

      // Injeta perfil pessoal — usa o buildPersonalContext do memory.js
      // que já consolida todas as categorias do info_pessoal do Dashboard
      try {
        const perfilCompleto = await memory.buildPersonalContext(user.id).catch(() => null);
        if (perfilCompleto && perfilCompleto.trim().length > 10) {
          contexto += `\n\n[QUEM ELE É — memória acumulada]\n${perfilCompleto}`;
        }
      } catch {}

      // Injeta hora atual e período do dia (em horário de Brasília) para a Clara
      // não chutar "bom dia"/"hora do almoço" errado. Bug antigo: o modelo
      // não recebia a hora e inventava o período baseado em UTC.
      const agoraBRT = nowBRT();
      const horaBRTnum = agoraBRT.getHours();
      const horaBRTfmt = `${String(horaBRTnum).padStart(2,'0')}:${String(agoraBRT.getMinutes()).padStart(2,'0')}`;
      const periodoDia = horaBRTnum < 5 ? 'madrugada'
        : horaBRTnum < 12 ? 'manhã'
        : horaBRTnum < 14 ? 'horário de almoço'
        : horaBRTnum < 18 ? 'tarde'
        : horaBRTnum < 22 ? 'noite'
        : 'fim da noite';
      contexto += `\n\n[HORA ATUAL] Agora são ${horaBRTfmt} (Brasília), período: ${periodoDia}. Use isso pra saudar corretamente — NUNCA diga "bom dia" se não for manhã (5h-11h), NUNCA "boa tarde" se não for tarde (12h-18h), NUNCA "boa noite" se não for noite (18h-22h). Às ${horaBRTfmt} o correto é: ${periodoDia === 'madrugada' || periodoDia === 'fim da noite' ? 'NÃO usar saudação de período — só conversa normal' : `"bom ${periodoDia === 'manhã' ? 'dia' : periodoDia === 'horário de almoço' ? 'dia ainda' : periodoDia === 'tarde' ? 'tarde' : 'noite'}"`}.`;

      // Injeta tempo desde a última mensagem — ela pode usar isso naturalmente
      // pra notar ausências ("saudade já?", "voltou!", "sumiu por X minutos")
      // MAS só quando você voltou a falar. Se ela já mandou algo sem resposta,
      // mencionar sumiço vira cobrança — nesse caso ela muda de assunto.
      try {
        const ultimaMsgUser = await prisma.memory.findFirst({
          where: { userId: user.id, type: 'conversa', content: { not: { startsWith: '[Clara]' } } },
          orderBy: { createdAt: 'desc' }
        }).catch(() => null);

        if (ultimaMsgUser) {
          const minAusente = Math.round((Date.now() - new Date(ultimaMsgUser.createdAt).getTime()) / 60000);
          // Só nota ausência depois de 2h — menos que isso é conversa normal,
          // não tem sentido chamar de sumido quem saiu pra almoçar.
          if (minAusente >= 120) {
            const tempoDesc = minAusente >= 60
              ? `${Math.round(minAusente / 60)}h${minAusente % 60 > 0 ? Math.round(minAusente % 60) + 'min' : ''}`
              : `${minAusente} minutos`;
            contexto += `\n\n[AUSÊNCIA — faz ${tempoDesc}] Se tiver assunto pendente ou contexto da vida dele pra puxar (episódio, o que estava acontecendo, algo que ele mencionou antes), use isso de forma natural e no seu tom — "e aí fedo, almoçou bem?", "e a macarronada da sogra, tava boa?" — sem mencionar que sumiu. Se não tiver assunto concreto, aí pode fazer um check-in leve e íntimo conforme o tom — "oi sumido, como tá por aí?", "cadê você?", "voltou!" — nunca como cobrança, sempre como intimidade. Não force se não combinar com o clima da conversa.`;
          }
        }
      } catch(eAus) { /* silencioso */ }

      // ── BOM DIA EMENDADO (proativo na resposta) ──
      // Se é de manhã (5h-11h), esta é a PRIMEIRA mensagem do usuário no dia,
      // e ele NÃO começou com um cumprimento, a Clara emenda o "bom dia" dela
      // na resposta — no tom configurado — em vez de só responder seco. Isso
      // transforma um "Clara, me lembra de X" às 7h num momento dela perceber
      // que você acordou e te cumprimentar (com graça, conforme o tom).
      // Coordenação: marca o bom_dia_lock do dia, pra o cron automático de
      // bom dia (reminders.js) NÃO mandar outro depois — sem duplicar.
      try {
        if (horaBRTnum >= 5 && horaBRTnum < 11) {
          const hojeStr = dateBRT();
          const lockBomDia = await prisma.memory.findFirst({
            where: { userId: user.id, type: 'bom_dia_lock', content: hojeStr }
          }).catch(() => null);
          if (!lockBomDia) {
            // É a primeira mensagem do dia? (a atual ainda não foi salva)
            const inicioHojeBRT = new Date(`${hojeStr}T00:00:00-03:00`);
            const conversaAnteriorHoje = await prisma.memory.findFirst({
              where: { userId: user.id, type: 'conversa', createdAt: { gte: inicioHojeBRT } }
            }).catch(() => null);
            // O usuário já cumprimentou nesta mensagem?
            const jaCumprimentou = /\b(bom dia|bomdia|oi|ola|opa|eai|e ai|salve|bom diaa+)\b/i.test(normalizar(text));
            // Não emenda bom dia se a primeira mensagem for confirmação de
            // remédio/lembrete — a Clara deve responder só sobre o remédio
            // e o bom dia vem separado pelo cron alguns minutos depois.
            const ehConfirmacaoAcao = /^(feito|tomei|tomado|já tomei|fiz|concluído|ok|feito fedo|tomou|pronto)[.! ]*(fedo)?[.!]?$/i.test(text.trim());
            if (!conversaAnteriorHoje && !jaCumprimentou && !ehConfirmacaoAcao) {
              contexto += `\n\n[BOM DIA — IMPORTANTE] Esta é a PRIMEIRA mensagem do usuário hoje e ele NÃO te deu bom dia — foi direto ao assunto. Antes (ou junto) de responder o que ele pediu, EMENDE um bom dia SEU no SEU tom atual, de forma natural e curta. Exemplos conforme o tom: se for sarcástica/sem filtro, algo como "bom dia primeiro, né, grosso 🙄" ou "nem um oi, mas tá bom kk bom dia"; se for carinhosa/simpática, algo como "hummm acordou cedinho! bom dia, fedo 💜" ou "bom dia! 😊". Se souber algo do dia anterior ou do estado dele pela memória, pode puxar com humanidade ("dormiu bem?", "como você tá hoje?", "melhorou de ontem?"). NÃO seja robótica nem repita a mesma frase de sempre — varie. Depois disso, responda normalmente o que ele pediu.`;
              await prisma.memory.create({
                data: { userId: user.id, type: 'bom_dia_lock', content: hojeStr }
              }).catch(() => {});
            } else if (jaCumprimentou && !conversaAnteriorHoje) {
              await prisma.memory.create({
                data: { userId: user.id, type: 'bom_dia_lock', content: hojeStr }
              }).catch(() => {});
            }
            // Se for confirmação de ação (remédio/lembrete), não seta lock
            // — o cron do bom dia ainda pode disparar separado
          }
        }
      } catch (eBomDia) {
        console.error(`[${phone}] Erro bom dia emendado:`, eBomDia.message);
      }

      if (contexto) contexto = `\n\nUse as informações abaixo para responder com precisão:${contexto}`;
      // ── Conexão inteligente de dados ──────────────────────────────────
      // Detecta quando a mensagem atual se conecta com dados que ela já tem
      // Ex: falar de comida → conecta com remédios de triglicerídeos
      //     falar de cansaço → conecta com remédio de tireoide
      //     falar de amanhã → conecta com episódios pendentes
      const conexoes = [];
      if (/comida|gordura|pizza|hambúrguer|fritura|churrasco|doce|açúcar|álcool|cerveja|vinho/i.test(txtLow)) {
        const medsTriglic = meds.filter(m => /triglic|colesterol|landizin|sinvastatina|atorvasta/i.test(m.name));
        if (medsTriglic.length > 0) conexoes.push(`Usuário tem ${medsTriglic.map(m=>m.name).join(', ')} — pode ser relevante mencionar com leveza se fizer sentido`);
      }
      if (/cansado|cansaço|sono|dormindo|energia|disposto|ânimo/i.test(txtLow)) {
        const medsTiroide = meds.filter(m => /tiroide|tireoide|levotirox|holmis/i.test(m.name));
        if (medsTiroide.length > 0) conexoes.push(`Usuário tem ${medsTiroide.map(m=>m.name).join(', ')} para tireoide — pode conectar com cansaço se fizer sentido`);
      }
      if (conexoes.length > 0) {
        contexto += `\n\n[CONEXÃO DE DADOS — use só se for natural e relevante]\n${conexoes.join('\n')}`;
      }

      // ── Aviso antecipado pendente ─────────────────────────────────────
      // Se o cron detectou um lembrete próximo enquanto conversávamos,
      // injeta aqui para a Clara mencionar de forma natural na resposta,
      // sem mandar mensagem separada que corta o clima.
      const avisoPendente = await prisma.memory.findFirst({
        where: { userId: user.id, type: 'aviso_pendente' },
        orderBy: { createdAt: 'desc' }
      }).catch(() => null);
      if (avisoPendente) {
        contexto += `\n\n[AVISO PENDENTE — mencione de passagem, no tom da conversa, sem cortar o assunto. Uma frase curta no meio ou fim da resposta. Ex: "...ah, e daqui pouco você tem ${avisoPendente.content}, não esquece! 😉". Depois apague da sua memória — não repita.] ${avisoPendente.content}`;
        await prisma.memory.delete({ where: { id: avisoPendente.id } }).catch(() => {});
      }

      if (contextoExtra) contexto += contextoExtra;
      preferences._contexto = contexto;
    } catch (e) {
      console.error(`[${phone}] Erro contexto:`, e.message);
    }

    const resp = await freeResponse(text, history, preferences);
    if (resp === null) return; // modo direto: já avisado, não responde

    // Garante que resp é string — o Gemini pode retornar objeto em casos de erro
    const respStr = typeof resp === 'string' ? resp : String(resp || '');
    if (!respStr) {
      console.error(`[${phone}] Resposta gerada mas vazia após freeResponse — não enviando`);
      return;
    }

    // Mensagem realmente parece pedido de informação? (pergunta, "que
    // horas", "quando", etc). Usado tanto pra tag BUSCAR quanto pra
    // detecção de promessa de busca mais abaixo — evita ela mesma criar
    // uma busca do nada em cima de comentário/comemoração sem pedido real.
    const pareceuPedidoInfo = /\?|que horas|quando|onde fica|onde é|qual (é|o|a)|quanto (custa|é|vale)|quem (é|foi|ganhou|joga)/i.test(text);
    const buscaMatch = respStr.match(/[*_]{0,2}BUSCAR:(.+?)(?:[*_]{0,2}|\n|$)/i);

    // ── Busca proativa: Clara sinalizou que quer pesquisar ──
    // REMOVIDO: o caminho antigo que mandava respSemTag (texto antes da tag)
    // e parava sem buscar quando !pareceuPedidoInfo. Isso causava mensagens
    // truncadas ("Nimesulida é um anti-inflamatório mais...") sem a busca.
    // Agora: se o modelo gerou __BUSCAR__, sempre busca — independente de
    // pareceuPedidoInfo. O aviso substitui o respSemTag.
    if (buscaMatch) {
      const query = buscaMatch[1].trim();
      const tom = preferences?.tom || 'carinhoso';
      const memAfetivaBusca = await memory.getMemoriaAfetiva(user.id).catch(() => ({}));
      const apelidoBusca = memAfetivaBusca?.apelido_usuario || preferences?.name || '';
      const aviso = await gerarAvisoBusca(text, tom, apelidoBusca);
      await sendMessage(phone, aviso);

      try {
        const contextoRelBusca = await buscarContextoRelacional(user.id);
        const cidadeBusca = await memory.getCidadeAtual(user.id).catch(() => '');
        const resultado = await searchWeb(query, cidadeParaBusca(query, cidadeBusca), apelidoBusca, preferences?.tom || 'carinhoso', contextoRelBusca, 'informar', '', text);
        if (resultado) {
          await memory.saveConversationMessage(user.id, 'user', text);
          await memory.saveConversationMessage(user.id, 'assistant', resultado);
          await sendMessage(phone, resultado);
          updateRelationshipSummary(user.id, history, resultado).catch(() => {});

          // Comentário depois da busca — sempre gera pra manter ela presente
          // após a info. Saúde → preocupação genuína. Outros → toque pessoal se seco.
          const ehSaudeBusca = /(sintoma|saúde|doença|pressão|febre|\bdor\b|dores|remédio|medicamento|médico|hospital|exame de saúde|consulta|enjoo|tontura|náusea|cansaço|infecção|alergia|gripe|emergência)/i.test(query + ' ' + text);
          const respLower = (resultado || '').toLowerCase();
          const jaTemCalor = /(fedo|meu bem|viu\?|hein\?|fica de olho|eita|nossa)/i.test(respLower) || /[\u{1F300}-\u{1FAFF}]/u.test(resultado || '');
          if (ehSaudeBusca || !jaTemCalor) {
            ;(async () => {
              try {
                await new Promise(r => setTimeout(r, 1500));
                if (!geminiDisponivel() || todosModelosEsgotados()) return;
                const promptPos = ehSaudeBusca
                  ? `\n\n[VOCÊ JÁ DEU A INFO DE SAÚDE] Você explicou sobre "${query}". Mande UM comentário curto de amiga preocupada — pergunte se ele tá sentindo algo, se é ele ou alguém da família. MÁXIMO 1 frase (menos de 15 palavras). Não repita a explicação.`
                  : `\n\n[VOCÊ JÁ EXPLICOU] Info sobre "${query}" enviada. Dê UM toque pessoal curtíssimo — opinião, brincadeira leve ou pergunta genuína. MÁXIMO 1 frase. NÃO repita. Se não tiver toque genuíno, responda APENAS: SKIP`;
                const coment = await geminiFreeResponse([
                  { role: 'system', content: buildPersonality(tom, apelidoBusca, false) + promptPos },
                  { role: 'user', content: text }
                ], { temperature: 0.85, maxTokens: 60 }).catch(() => null);
                const comentLimpo = filtrarResposta((coment || '').replace(/[*_]{0,2}BUSCAR:[^*_\n]*[*_]{0,2}/gi, '').replace(/🔍/g, '').trim());
                if (comentLimpo && comentLimpo.length > 3 && !/^SKIP/i.test(comentLimpo)) {
                  await sendMessage(phone, comentLimpo);
                  await memory.saveConversationMessage(user.id, 'assistant', comentLimpo).catch(() => {});
                }
              } catch {}
            })();
          }
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

    // Gap 1: registra hora da mensagem pra aprender rotina de presença
    ;(async () => {
      try {
        await prisma.memory.create({
          data: { userId: user.id, type: 'presenca_hora', content: String(nowBRT().getHours()) }
        });
        const limite30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        await prisma.memory.deleteMany({
          where: { userId: user.id, type: 'presenca_hora', createdAt: { lt: limite30d } }
        });
      } catch {}
    })();

    // Gap 2: extrai estado emocional/tópico do dia após cada troca
    // Salva como 'estado_do_dia' com TTL de 24h — injeta nas proativas e boa noite
    ;(async () => {
      try {
        const histEstado = await memory.getConversationHistory(user.id, 6).catch(() => []);
        if (histEstado.length < 2) return;
        const resumoTroca = histEstado.slice(-4).map(m =>
          `${m.role === 'user' ? 'Ele' : 'Você'}: ${m.content}`
        ).join('\n');
        const estadoResp = await geminiFreeResponse([
          { role: 'system', content: `Extraia em UMA linha o estado emocional e tópico principal desta troca de mensagens. Formato: "humor: [animado/preocupado/tranquilo/brincalhão/cansado], assunto: [tópico resumido em 5 palavras]". Exemplo: "humor: animado, assunto: saída com a Isis no parquinho". Se não der pra extrair, responda: SKIP` },
          { role: 'user', content: resumoTroca }
        ], { temperature: 0.3, maxTokens: 50 }).catch(() => null);
        if (!estadoResp || estadoResp === 'SKIP') return;
        // Salva/atualiza estado do dia
        await prisma.memory.deleteMany({ where: { userId: user.id, type: 'estado_do_dia' } });
        await prisma.memory.create({
          data: {
            userId: user.id, type: 'estado_do_dia',
            content: estadoResp.trim(),
            metadata: JSON.stringify({ expira: Date.now() + 24 * 60 * 60 * 1000 })
          }
        });
      } catch {}
    })();

    // ── Detecção de promessa de busca não executada ───────────────────
    // Só vale como promessa de busca de verdade se a MENSAGEM ORIGINAL do
    // usuário tiver cara de pedido de informação (pergunta, "que horas",
    // "quando", etc). Sem isso, uma frase de efeito dela tipo "deixa eu ver
    // que horas" numa resposta a um convite/comentário ("bora torcermos")
    // disparava busca escondida sem ninguém ter pedido nada.
    const prometeuBuscar = pareceuPedidoInfo && /peraí que vou ver|deixa eu (dar uma olhada|pesquisar|verificar|checar|buscar)|vou (pesquisar|buscar|dar uma olhada|verificar)|deixa eu ver|um segundo que|rapidinho aqui/i.test(respStr);
    if (prometeuBuscar && !buscaMatch) {
      ;(async () => {
        try {
          await new Promise(r => setTimeout(r, 1500));
          // Extrai o assunto que ela REALMENTE prometeu pesquisar — usar a
          // mensagem inteira do usuário como query dava resultado errado
          // quando ele misturava mais de um assunto na mesma mensagem
          // (ex: falou de café E do jogo do Brasil — a busca trazia café).
          const queryBusca = await extrairQueryBusca(text, respStr);
          const memAfetivaProm = await memory.getMemoriaAfetiva(user.id).catch(() => ({}));
          const apelidoProm = memAfetivaProm?.apelido_usuario || preferences?.name || '';
          const contextoRelProm = await buscarContextoRelacional(user.id);
          // Se o usuário estava CONTANDO algo (não perguntando), Clara buscou
          // pra ela mesma ficar por dentro — usa modo 'participar' pra não
          // explicar de volta pro usuário algo que ele mesmo já sabe.
          const modoBusca = pareceuPedidoInfo ? 'informar' : 'participar';
          const resultado = await searchWeb(queryBusca, '', apelidoProm, preferences?.tom || 'carinhoso', contextoRelProm, modoBusca);
          // Modo 'participar': salva na memória de longa duração o que ela
          // aprendeu — nas próximas sessões ela já sabe do assunto e não
          // precisa anunciar que vai pesquisar de novo como se fosse novidade.
          if (modoBusca === 'participar' && resultado && !isRespostaFallback(resultado)) {
            await prisma.memory.create({
              data: {
                userId: user.id,
                type: 'conhecimento_adquirido',
                content: queryBusca,
                metadata: JSON.stringify({
                  resumo: resultado.slice(0, 300),
                  dataAprendido: new Date().toISOString(),
                  expira: Date.now() + 30 * 24 * 60 * 60 * 1000 // 30 dias
                })
              }
            }).catch(() => {});
          }
          if (resultado && !isRespostaFallback(resultado)) {
            await memory.saveConversationMessage(user.id, 'assistant', resultado).catch(() => {});
            await sendMessage(phone, resultado);
            console.log(`[BuscaPrometida] Resultado enviado para ${phone}`);
          }
        } catch(e) { console.error('[BuscaPrometida] Erro:', e.message); }
      })();
    }
    // Quando o pedido criou um lembrete, a Clara responde de forma humana
    // (a mensagem acima) e LOGO EM SEGUIDA manda a confirmação estruturada,
    // literal (título + quando). Assim o usuário tem a conversa natural E um
    // comprovante exato do que foi anotado, sem depender do Dashboard — e a
    // parte estruturada nunca é "amolecida" ou inventada pela IA.
    if (preferences?._confirmacaoSeparada) {
      try {
        await new Promise(r => setTimeout(r, 1200)); // respiro pra chegar depois, como humano
        await sendMessage(phone, preferences._confirmacaoSeparada);
        await memory.saveConversationMessage(user.id, 'assistant', preferences._confirmacaoSeparada).catch(() => {});
      } catch (eConf) {
        console.error(`[${phone}] Erro ao enviar confirmação separada:`, eConf.message);
      }
    }

    updateRelationshipSummary(user.id, history, respStr).catch(() => {});

    // Ponto 3: detecta padrão de reação em background
    ;(async () => {
      try {
        const histPadrao = await memory.getConversationHistory(user.id, 8).catch(() => []);
        if (histPadrao.length >= 4) {
          const padrao = await detectarPadraoReacao(histPadrao);
          if (padrao) await memory.salvarPadraoReacao(user.id, padrao.tema, padrao.padrao);
        }
      } catch {}
    })();

    // ── "Ainda não" → reinicia contador do episódio ──
    // Quando Clara perguntou sobre algo e o usuário responde "ainda não",
    // reinicia o timer pra ela voltar a perguntar em 3 dias — não amanhã.
    ;(async () => {
      try {
        const aindaNao = /ainda\s*n[aã]o|n[aã]o\s*(ainda|consegui|rolou|deu|fiz|resolvi)|por\s*enquanto\s*n[aã]o|n[aã]o\s*ainda/i.test(text);
        if (!aindaNao) return;
        // Verifica se há episódio pendente recente (criado nos últimos 7 dias)
        const epsPendentes = await prisma.memory.findMany({
          where: { userId: user.id, type: 'episodio_vida', createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
          orderBy: { createdAt: 'desc' }, take: 3
        }).catch(() => []);
        for (const ep of epsPendentes) {
          let meta = {}; try { meta = JSON.parse(ep.metadata || '{}'); } catch {}
          if (meta.resultado !== 'pendente') continue;
          // Reinicia: next_check_at = agora + 3 dias
          meta.next_check_at = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
          await prisma.memory.update({ where: { id: ep.id }, data: { metadata: JSON.stringify(meta) } }).catch(() => {});
          console.log(`[Episodio] "Ainda não" detectado — next_check_at em 3 dias: "${ep.content.slice(0, 50)}"`);
        }
      } catch {}
    })();

    // ── Personagem Clara: salva o que ela inventou sobre si mesma ──
    // Detecta detalhes concretos que ela mencionou (amigas, lugares, atividades)
    // e salva pra manter consistência — a Bia e a Carol continuam sendo a Bia e a Carol.
    ;(async () => {
      try {
        if (!respStr || respStr.length < 40) return;
        const temVidaPropria = /\b(tô|tava|fui|estava|estou|saí|vou sair|fiz|comi|assisti|ouvi|encontrei|fiquei|cheguei|saindo|curtindo|passei)\b/i.test(respStr);
        if (!temVidaPropria) return;
        const extracted = await geminiFreeResponse([
          { role: 'user', content: `Resposta da Clara: "${respStr.slice(0, 400)}"\n\nSe Clara mencionou algo CONCRETO sobre a VIDA DELA (nome de amiga, bar/lugar específico, atividade que fez), liste em JSON: [{"item":"descrição curta"}]. Máx 3. Se nada concreto, responda: []` }
        ], { temperature: 0.1, maxTokens: 100 }).catch(() => null);
        if (!extracted) return;
        const limpo = extracted.replace(/```json|```/g, '').trim();
        const items = JSON.parse(limpo.startsWith('[') ? limpo : '[]');
        for (const it of items) {
          if (!it?.item || it.item.length < 5) continue;
          const palavraChave = it.item.split(' ').slice(0, 2).join(' ').toLowerCase();
          const existe = await prisma.memory.findFirst({
            where: { userId: user.id, type: 'clara_personagem', content: { contains: palavraChave } }
          }).catch(() => null);
          if (!existe) {
            await prisma.memory.create({ data: {
              userId: user.id, type: 'clara_personagem',
              content: it.item.slice(0, 150),
              metadata: JSON.stringify({ data: new Date().toISOString() })
            }}).catch(() => {});
            console.log(`[ClaraPersonagem] "${it.item.slice(0, 60)}"`);
          }
        }
      } catch {}
    })();

    // ── Linha do tempo: detecta eventos futuros que o usuário mencionou ──
    // Funciona com ou sem hora específica: "amanhã levo as crianças" também captura.
    ;(async () => {
      try {
        const temFuturo = /amanhã|depois de amanhã|semana que vem|hoje.{0,20}(à noite|mais tarde|depois)|às \d+\s*h\b|daqui \d+|próxim[ao]/i.test(text);
        if (!temFuturo) return;
        const agora = new Date();
        const ev = await geminiFreeResponse([
          { role: 'user', content: `Mensagem: "${text.slice(0, 300)}"\nData/hora atual: ${agora.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}\n\nSe o usuário mencionou um evento futuro específico (com OU sem horário exato), extraia:\n{"evento":"descrição curta","quando":"texto do quando","horas_ate_evento":N,"followup_horas_apos":M}\n\nhoras_ate_evento = quantas horas do MOMENTO ATUAL até o evento acontecer (ex: "amanhã às 9h" quando são 23h45 = ~9.25h)\nfollowup_horas_apos = quantas horas DEPOIS do evento perguntar como foi (padrão: 2-3h para eventos com hora específica, 6h para eventos sem hora)\n\nSe não há evento futuro claro, responda: NADA.` }
        ], { temperature: 0.1, maxTokens: 100 }).catch(() => null);
        if (!ev || /^NADA/i.test((ev || '').trim())) return;
        const parsed = JSON.parse(ev.replace(/```json|```/g, '').trim());
        if (!parsed?.evento) return;
        const horasAteEvento = parsed.horas_ate_evento || 12;
        const followupHoras = parsed.followup_horas_apos || 2;
        // followup_at = agora + horas até o evento + horas de follow-up
        const followupAt = new Date(agora.getTime() + (horasAteEvento + followupHoras) * 60 * 60 * 1000);
        await prisma.memory.create({ data: {
          userId: user.id, type: 'linha_tempo',
          content: parsed.evento.slice(0, 150),
          metadata: JSON.stringify({
            quando: parsed.quando,
            followup_at: followupAt.toISOString(),
            criadoEm: agora.toISOString(),
            status: 'pendente'
          })
        }}).catch(() => {});
        console.log(`[LinhaTempo] "${parsed.evento}" — follow-up previsto: ${followupAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
      } catch {}
    })();

    // Item 4: resumo de fim de sessão
    // Se a mensagem atual veio depois de 2h+ de silêncio, significa que
    // a sessão anterior encerrou. Gera um resumo mais rico dessa sessão
    // antes de começar a nova — captura o que aconteceu de importante,
    // referências compartilhadas, humor, highlights — pra ela lembrar
    // entre sessões.
    ;(async () => {
      try {
        const ultimaMsgAnterior = await prisma.memory.findFirst({
          where: {
            userId: user.id, type: 'conversa',
            content: { not: { startsWith: '[Clara]' } },
            createdAt: { lt: new Date(Date.now() - 100) } // antes da atual
          },
          orderBy: { createdAt: 'desc' }
        }).catch(() => null);

        if (!ultimaMsgAnterior) return;
        const minGap = (Date.now() - new Date(ultimaMsgAnterior.createdAt).getTime()) / 60000;
        if (minGap < 120) return; // menos de 2h → mesma sessão, não consolida

        // Sessão anterior encerrou — consolida o que aconteceu
        const lockSessao = `sessao_resumo_${new Date(ultimaMsgAnterior.createdAt).toISOString().slice(0,13)}`;
        const jaConsolidou = await prisma.memory.findFirst({
          where: { userId: user.id, type: 'sessao_resumo_lock', content: lockSessao }
        }).catch(() => null);
        if (jaConsolidou) return;

        await prisma.memory.create({
          data: { userId: user.id, type: 'sessao_resumo_lock', content: lockSessao }
        }).catch(() => {});

        // Busca mensagens da sessão anterior (até 2h antes da última msg)
        const fimSessao = new Date(ultimaMsgAnterior.createdAt);
        const inicioSessao = new Date(fimSessao.getTime() - 3 * 60 * 60 * 1000);
        const msgsSessao = await prisma.memory.findMany({
          where: { userId: user.id, type: 'conversa', createdAt: { gte: inicioSessao, lte: fimSessao } },
          orderBy: { createdAt: 'asc' }, take: 20
        }).catch(() => []);

        if (msgsSessao.length < 3) return;

        const textoSessao = msgsSessao.map(m => {
          const isClara = m.content.startsWith('[Clara]');
          return `${isClara ? 'Clara' : 'Ele'}: ${m.content.replace('[Clara]', '').trim()}`;
        }).join('\n');

        // Usa o generateRelationshipSummary com foco em highlights da sessão
        const current = await prisma.memory.findFirst({
          where: { userId: user.id, type: 'relationship_summary' },
          orderBy: { createdAt: 'desc' }
        }).catch(() => null);

        const novoResumo = await generateRelationshipSummary(
          msgsSessao.map(m => ({
            role: m.content.startsWith('[Clara]') ? 'assistant' : 'user',
            content: m.content.replace('[Clara]', '').trim()
          })),
          current?.content || ''
        );

        if (novoResumo) {
          await upsertMemoryPorTipo(user.id, 'relationship_summary', novoResumo).catch(() => {});
          console.log(`[SessãoResumo] ${user.id} — sessão de ${msgsSessao.length} msgs consolidada`);
        }
      } catch {}
    })();

    // ── Detecção de assunto em aberto (fire-and-forget) ──────────────
    // Roda após a resposta, sem adicionar latência. Se a conversa gerou
    // um assunto relevante não resolvido (saúde, trabalho, evento esperado),
    // salva como pendencia_conversa pra Clara retomar naturalmente depois.
    // Também detecta quando o usuário fecha um assunto aberto.
    ;(async () => {
      try {
        await memory.fecharPendenciasPorResolucao(user.id, text);
        // Detecta humor do usuário na mensagem atual
        detectarEsalvarHumor(user.id, text, respStr).catch(() => {});
        // Detecta apelidos e tom da relacao
        detectarEsalvarAfetivo(user.id, text, respStr).catch(() => {});
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


// ── WebSocket — notifica dashboard em tempo real ───────────────────────
function emitirAtualizacao(phone, tipo) {
  try {
    const io = global.__claraIO;
    if (io) io.to('user_' + phone).emit('atualizar', { tipo });
  } catch {}
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

    // ── Interceptação determinística: SONECA / ADIAR de UMA dose de remédio ──
    // Caso do print: o usuário responde ao "💊 Hora do medicamento!" pedindo
    // "remarca pra daqui 20 minutos". Isso NÃO é:
    //   • ajustar_remedio  → esse muda o horário FIXO diário do remédio;
    //   • editar_lembrete  → esse só olha a tabela `reminder`, e remédio vive
    //                        na tabela `medication`, então nunca acha
    //                        ("Não encontrei nenhum lembrete com ...").
    // É uma soneca de UMA dose: reagenda só aquela dose pra daqui X, criando
    // um lembrete one-off que reenvia o alerta — SEM tocar no schedule fixo.
    // Determinístico (regex, sem LLM) e disparado só quando o contexto é
    // claramente de remédio + tempo relativo + verbo de adiar, pra não roubar
    // pedidos legítimos de lembrete novo ("me lembra daqui 20 min de X").
    {
      const tNorm = (text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const verboAdiar = /\b(remarc\w*|adia\w*|adianta\w*|soneca|de novo|mais\s+\d+\s*min)\b/.test(tNorm);
      const contextoRemedio = /\b(remedio|medicamento|dose|comprimido|capsula)\b/.test(tNorm);
      const quandoRelativo = calcularHorarioRelativo(text); // Date (agora+X) ou null

      if (verboAdiar && contextoRemedio && quandoRelativo) {
        // Descobre QUAL dose adiar: 1º pelas pendências de confirmação abertas
        // (o remédio acabou de disparar), 2º pelo nome citado na mensagem.
        const pendMems = await prisma.memory.findMany({
          where: { userId: user.id, type: 'confirmacao_pendente' },
          orderBy: { createdAt: 'desc' }
        }).catch(() => []);
        const dosesPendentes = pendMems
          .map(p => { try { const d = JSON.parse(p.content); return d.tipo === 'remedio_dose' ? d : null; } catch { return null; } })
          .filter(Boolean);

        let alvo = null;
        if (dosesPendentes.length === 1) {
          alvo = dosesPendentes[0];
        } else if (dosesPendentes.length > 1) {
          alvo = dosesPendentes.find(d =>
            (d.medNome || '').toLowerCase().split(' ').filter(w => w.length > 3)
              .some(w => tNorm.includes(w.normalize('NFD').replace(/[\u0300-\u036f]/g, '')))
          ) || null;
        }
        // Fallback: sem pendência aberta, casa pelo nome de um remédio ativo
        // citado (via swipe-reply, o texto vem com "[Mensagem citada: ...]").
        if (!alvo) {
          const medsAtivos = await prisma.medication.findMany({ where: { userId: user.id, active: true } }).catch(() => []);
          const medCitado = medsAtivos.find(m =>
            (m.name || '').toLowerCase().split(' ').filter(w => w.length > 3)
              .some(w => tNorm.includes(w.normalize('NFD').replace(/[\u0300-\u036f]/g, '')))
          );
          if (medCitado) alvo = { medId: medCitado.id, medNome: medCitado.name };
        }

        if (alvo) {
          // Cria o lembrete one-off que reenvia o alerta no horário pedido.
          // Não mexemos em medication.times (schedule permanente) nem criamos
          // nova confirmacao_pendente — a que veio do disparo original ainda
          // vale (expira em 3h), então "tomei" continua descontando a dose.
          await prisma.reminder.create({
            data: {
              userId: user.id,
              phone,
              message: `💊 ${alvo.medNome} (dose remarcada)`,
              scheduledAt: quandoRelativo
            }
          }).catch(e => console.error('[soneca_remedio] erro ao criar:', e.message));

          const horaFmt = quandoRelativo.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
          await memory.saveConversationMessage(user.id, 'user', text).catch(() => {});
          console.log(`[soneca_remedio] ${alvo.medNome} adiado p/ ${horaFmt} (${phone})`);
          return await sendMessage(phone, `Beleza, adiei o *${alvo.medNome}* pra ${horaFmt} — te chamo de novo nesse horário 💊`);
        }
      }
    }

    // ── Peça 2 da dedução: "parar de tomar X na segunda" → data de fim ──────
    // Detecção determinística. Grava endDate no remédio; um cron diário (em
    // reminders.js) desativa e cria o acompanhamento (reusa a Peça 1) quando a
    // data chega. Conservador: exige gatilho de FIM + menção a remédio + data.
    {
      const tLow = (text || '').toLowerCase();
      const gatilhoFim = /\b(parar|paro|parei|pare|chega de|[uú]ltimo dia|s[óo] at[eé]|at[eé] (a |o )?(segunda|ter[cç]a|quarta|quinta|sexta|s[áa]bado|domingo|amanh[ãa]|hoje))\b/.test(tLow)
        || /n[ãa]o (vou|preciso) mais (tomar|de)/.test(tLow);
      const falaDeRemedio = /\b(rem[eé]dio|medicamento|tomar|comprimido|c[áa]psula|antibi[óo]tico)\b/.test(tLow);
      // "forte" = substantivo explícito de remédio (sem "tomar", que é ambíguo:
      // "parar de tomar café" não pode virar fim de tratamento).
      const falaDeRemedioForte = /\b(rem[eé]dio|medicamento|comprimido|c[áa]psula|antibi[óo]tico)\b/.test(tLow);
      if (gatilhoFim && falaDeRemedio) {
        const dataFim = resolverDataFim(text);
        if (dataFim) {
          const medsAtivos = await prisma.medication.findMany({ where: { userId: user.id, active: true } }).catch(() => []);
          let med = medsAtivos.find(m =>
            (m.name || '').toLowerCase().split(' ').filter(w => w.length > 3)
              .some(w => tLow.includes(w.normalize('NFD').replace(/[\u0300-\u036f]/g, '')))
          );
          // Fallback "só um remédio ativo → é ele" SÓ quando há substantivo de
          // remédio explícito, pra não confundir com "parar de tomar café".
          if (!med && medsAtivos.length === 1 && falaDeRemedioForte) med = medsAtivos[0];
          if (med) {
            await prisma.medication.update({ where: { id: med.id }, data: { endDate: dataFim } }).catch(e => console.error('[endDate]', e.message));
            const fmt = dataFim.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
            await memory.saveConversationMessage(user.id, 'user', text).catch(() => {});
            console.log(`[FimTratamento] ${med.name} → endDate ${fmt} (${phone})`);
            return await sendMessage(phone, `Anotado! Você para o *${med.name}* em ${fmt} 💜 Depois disso eu paro de te lembrar e te pergunto como foi.`);
          }
        }
      }
    }

    // ── Passa contexto da conversa para o classify resolver referências vagas ──
    // Inclui: histórico recente + lembretes pendentes (para concluir_lembrete funcionar sem swipe)
    let contextoClassify = '';
    try {
      const history = await memory.getConversationHistory(user.id, 4);
      if (history.length > 0) {
        contextoClassify = history.map(m => `${m.role === 'user' ? 'Usuário' : 'Clara'}: ${m.content}`).join('\n');
      }
      // Adiciona lembretes pendentes para o classify saber o que pode ser concluído
      const lembretesPendentes = await getLembretesPendentesConfirmacao(user.id).catch(() => []);
      if (lembretesPendentes.length > 0) {
        const listaPendentes = lembretesPendentes.map((r, i) => `${i+1}. "${r.message}"`).join(', ');
        contextoClassify += `\n[LEMBRETES PENDENTES DE CONFIRMAÇÃO: ${listaPendentes}] — se o usuário disser algo que soe como confirmação de qualquer um desses, classifique como concluir_lembrete com o título correspondente.`;
      }
    } catch(e) {}

    const classified = await classify(text, phone, contextoClassify);
    console.log(`[${phone}] Tipo: ${classified.tipo}`);

    // Corrige a data com base em código (não no modelo) sempre que o texto
    // citar um dia da semana explícito — cobre tarefa, editar_lembrete,
    // deletar_lembrete, consulta etc, qualquer tipo que tenha campo `data`.
    corrigirDataDiaSemana(text, classified);
    if (classified.tipo === 'multiplas_tarefas' && Array.isArray(classified.tarefas)) {
      // Múltiplas tarefas numa mensagem só citam o dia da semana uma vez
      // (ex: "segunda me lembra de X às 9h e de Y às 15h") — aplica a
      // mesma correção pra cada uma das tarefas extraídas.
      classified.tarefas.forEach(t => corrigirDataDiaSemana(text, t));
    }

    // ── Intercepta: lista_marcar com hora → editar_lembrete ──
    if (classified.tipo === 'lista_marcar' && (classified.nova_hora || classified.nova_data)) {
      classified.tipo = 'editar_lembrete';
    }

    // ── GUARDA: resposta a uma PERGUNTA da Clara não vira lembrete/tarefa ────
    // Mesma família do falso positivo do concluir. Se ele responde a uma
    // ── Guardrail: plano informal → nunca tarefa ─────────────────────────
    // "amanhã compro outro santo" → Gemini classificou como tarefa (falso
    // positivo). O prompt já proíbe isso, mas o modelo erra ocasionalmente.
    // Regra determinística de segurança: verbo de ação pessoal no futuro
    // (compro, faço, vou, pego, passo, resolvo...) SEM gatilho explícito
    // ("me lembra", "anota", "agenda", "daqui X min", "às HH") = plano
    // informal = conversa, não tarefa.
    if (classified.tipo === 'tarefa' || classified.tipo === 'multiplas_tarefas') {
      const tLowGuard = (text || '').toLowerCase();
      const temGatilhoGuard = /(me lembr|me avis|me cutuc|anota a[ií]|anota isso|j[áa] anota|um lembrete|cria(r)? lembrete|agenda isso|n[ãa]o me deixa esquecer|n[ãa]o deixa eu esquecer|me lembre|daqui a?\s*\d+|em\s+\d+\s*(min|hora)|às?\s*\d{1,2}h\b|às?\s*\d{1,2}:\d{2})/i.test(tLowGuard);
      const temVerboPessoal = /\b(compro|pego|paso|passo|resolvo|ligo|falo|vou buscar|vou comprar|vou fazer|vou l[áa]|chego|trago|levo|busco|acho|arrumo|resolvo|deixo|coloco)\b/i.test(tLowGuard);
      if (!temGatilhoGuard && temVerboPessoal) {
        console.log(`[Guardrail] tarefa-fantasma interceptada (plano informal sem gatilho): "${(text||'').slice(0,60)}"`);
        classified.tipo = 'outro';
      }
      // "Vou tentar renovar minha habilitação daqui a pouco" = intenção, não pedido
      // Se a frase começa com "vou/quero/preciso" sem gatilho explícito, é conversa
      if (classified.tipo !== 'outro') {
        const ehIntencao = /^(eu\s+)?(vou\s+(tentar|precisar|lá|fazer|buscar|ver|resolver|passar|pegar)|quero|preciso)\s+/i.test((text||'').trim());
        if (ehIntencao && !temGatilhoGuard) {
          console.log(`[Guardrail] Afirmação de intenção ≠ tarefa — tratando como conversa: "${(text||'').slice(0,60)}"`);
          classified.tipo = 'outro';
        }
      }
    }

    // pergunta da Clara (ex: "como foi o Detran? resolveu?" → "só na quinta
    // fedo"), o classify às vezes lê a data ("quinta") e cria um lembrete-
    // fantasma (e ainda perguntava "que horas?"). Se ele CITOU uma pergunta
    // dela (tem "?" e não é alerta) e NÃO há gatilho explícito de lembrete no
    // texto, é conversa — responde no tom, não cria tarefa nenhuma.
    if (classified.tipo === 'tarefa' || classified.tipo === 'multiplas_tarefas') {
      const mCitT = (text || '').match(/\[Mensagem citada:\s*"([\s\S]*?)"\]/i);
      const citadoT = mCitT ? mCitT[1] : '';
      const citouAlertaT = /🔔|💊|hora do medicamento|lembrete/i.test(citadoT);
      const citouPerguntaT = /\?/.test(citadoT) && !citouAlertaT;
      const temGatilhoLembrete = /(me lembr|me avis|me cutuc|anota a[ií]|anota isso|j[áa] anota|um lembrete|cria lembrete|agenda isso|n[ãa]o me deixa esquecer|n[ãa]o deixa eu esquecer|me lembre|daqui a?\s*\d+|em\s+\d+\s*(min|hora))/i.test(text || '');
      if (citouPerguntaT && !temGatilhoLembrete) {
        console.log('[tarefa] falso positivo (resposta a pergunta da Clara) — tratando como conversa');
        await responderLivre(user, phone, text, '', false, null);
        extractAndSavePersonalInfo(user.id, text).catch(() => {});
        return;
      }
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
      const preferencesBusca = await memory.getUserPreference(user.id).catch(() => null);
      const cidade = await memory.getCidadeAtual(user.id).catch(() => '');
      // Usa o apelido REAL que a Clara já usa pra ele (ex: "fedo"), não o
      // nome formal cadastrado — passar só "Washington" pro reprocessamento
      // fazia o modelo inventar um apelido próprio (ex: "Wash") do nada.
      const memAfetiva = await memory.getMemoriaAfetiva(user.id).catch(() => ({}));
      const apelidoReal = memAfetiva?.apelido_usuario || preferencesBusca?.name || '';
      const contextoRelBuscaClassify = await buscarContextoRelacional(user.id);
      const tomBuscaClassify = preferencesBusca?.tom || 'carinhoso';

      // Aviso pré-busca: usa as frases fixas do gerarAvisoBusca —
      // curtas, no tom dela, sem responder a pergunta antes de buscar.
      // O Gemini com maxTokens=60 aqui estava gerando respostas completas
      // cortadas no meio ("Bom dia, fedo! 🙄 Pra soltar a barriga..."),
      // que ficavam ótimas mas truncadas. Agora a frase é fixa e curta;
      // a resposta completa e contextual vem na síntese da busca.
      const avisoFixo = await gerarAvisoBusca(text, tomBuscaClassify, apelidoReal);
      await sendMessage(phone, avisoFixo);
      await memory.saveConversationMessage(user.id, 'assistant', avisoFixo).catch(() => {});

      const resultadoBusca = await searchWeb(classified.query, cidadeParaBusca(classified.query, cidade), apelidoReal, tomBuscaClassify, contextoRelBuscaClassify, 'informar', '', text);
      if (resultadoBusca) {
        await memory.saveConversationMessage(user.id, 'user', text);
        await memory.saveConversationMessage(user.id, 'assistant', resultadoBusca);
        await sendMessage(phone, resultadoBusca);
        extractAndSavePersonalInfo(user.id, text).catch(() => {});

        // 2ª mensagem: SÓ entra se a resposta da busca veio SECA/TÉCNICA. Se a
        // Clara já respondeu no tom dela (com apelido, emoji, calor), o toque
        // pessoal já está lá e a 3ª mensagem seria redundante. Detecta "seca":
        // sem apelido do usuário, sem emoji, sem expressões calorosas dela.
        const respLower = (resultadoBusca || '').toLowerCase();
        const temApelido = apelidoReal && respLower.includes(apelidoReal.toLowerCase());
        const temEmoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2764}]/u.test(resultadoBusca || '');
        const temCalor = /(fedo|meu bem|viu\?|hein\?|fica de olho|se cuida|👀|kkk|haha|olha|nossa|eita|opa|é isso|tá\?)/i.test(resultadoBusca || '');
        const respostaJaEhPessoal = temApelido || temEmoji || temCalor;

        // Saúde: SEMPRE gera comentário de preocupação — uma amiga que explica
        // sintomas também pergunta "e você tá bem?", independente de emojis.
        const ehSaude = /(sintoma|saúde|doença|pressão|febre|\bdor\b|dores|remédio|medicamento|médico|hospital|exame de saúde|consulta|enjoo|tontura|náusea|cansaço|infecção|alergia|gripe|covid|emergência)/i.test((classified.query || '') + ' ' + (text || ''));

        if (!respostaJaEhPessoal || ehSaude) {
          ;(async () => {
            try {
              await new Promise(r => setTimeout(r, 1500));
              if (!geminiDisponivel() || todosModelosEsgotados()) return;
              const promptComent = ehSaude
                ? `\n\n[VOCÊ JÁ DEU A INFO DE SAÚDE] Você explicou sobre "${classified.query}". Agora mande UM comentário curto de amiga preocupada — pergunte se ele tá sentindo algo, se é ele ou alguém da família, se tá bem. MÁXIMO 1 frase (menos de 15 palavras). Não repita a explicação.`
                : `\n\n[VOCÊ JÁ EXPLICOU] Você acabou de mandar a explicação sobre "${classified.query}", mas ela saiu meio seca. Dê UM toque pessoal curtíssimo — um conselho, uma preocupação ou uma brincadeira leve.\n\nREGRAS: MÁXIMO 1 frase curta. NÃO repita a explicação. NUNCA use __BUSCAR__. Se não tiver toque genuíno, responda APENAS: SKIP`;
              const sysComent = buildPersonality(tomBuscaClassify, apelidoReal, false) + promptComent;
              const coment = await geminiFreeResponse([
                { role: 'system', content: sysComent },
                { role: 'user', content: `Acabei de perguntar sobre: ${text}` }
              ], { temperature: 0.85, maxTokens: 60 }).catch(() => null);
              const comentLimpo = filtrarResposta((coment || '')
                .replace(/[*_]{0,2}BUSCAR:[^*_\n]*[*_]{0,2}/gi, '')
                .replace(/🔍/g, '')
                .trim());
              if (comentLimpo && comentLimpo.length > 3 && !/^SKIP/i.test(comentLimpo)) {
                await sendMessage(phone, comentLimpo);
                await memory.saveConversationMessage(user.id, 'assistant', comentLimpo).catch(() => {});
              }
            } catch (e) { console.error('[Busca comentário] Erro:', e.message); }
          })();
        } else {
          console.log('[Busca] Resposta já veio pessoal — pulando comentário extra');
        }
        return;
      }
      await responderLivre(user, phone, text, `\n\n[BUSCA] Não encontrei resultados para "${classified.query}". Informe de forma curta que não encontrou nada.`, false);
      return;
    }

    // Card completo (relatório visual) SÓ quando o usuário pede explicitamente
    // "relatório", "detalhado" ou "completo". Qualquer outra forma casual de
    // perguntar de finanças ("como tão minhas contas?", "mostra o saldo de
    // agosto") cai no fluxo normal, onde a Clara responde NO TOM DELA com os
    // números (o contexto [FINANCEIRO] já é injetado). Assim: casual = ela;
    // "relatório" = card. A intenção está nas palavras, sem precisar perguntar.
    const pediuRelatorioExplicito = /relat[óo]rio|detalhad|complet|planilha|extrato detalhad/i.test(text || '');
    if ((classified.tipo === 'relatorio_financeiro' || classified.tipo === 'consulta_saldo') && pediuRelatorioExplicito) {
      await gerarRelatorioFinanceiroWhatsApp(user, phone, text);
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
      // Pergunta de horário no tom dela — não como sistema
      // BUG CORRIGIDO: usava `prefs` (inexistente neste escopo) → crash
      // "prefs is not defined". Busca local resolve.
      const prefsHora = await memory.getUserPreference(user.id).catch(() => ({}));
      await freeResponse(`Preciso perguntar o horário pro lembrete "${classified.titulo}" no dia ${dataFmt}.`, [], {
        name: prefsHora?.name, tom: prefsHora?.tom || 'carinhoso',
        _contexto: `[SEM HORÁRIO] Você acabou de tentar criar o lembrete "${classified.titulo}" pro dia ${dataFmt} mas sem horário definido. Pergunte de forma natural e no seu tom qual horário colocar. Se a pessoa não souber, diga pra te passar quando souber que você ajusta. NÃO sugira horário provisório. Máximo 1-2 linhas.`,
        _maxTokens: 80
      }).then(async (resp) => {
        if (resp) await sendMessage(phone, resp);
      }).catch(() => sendMessage(phone, `Que horas vai ser "${classified.titulo}" no dia ${dataFmt}? Me diz quando souber 😊`));
      extractAndSavePersonalInfo(user.id, text).catch(e => console.error('[extract pessoal]', e.message));
      return;
    }

    // ajustar_remedio precisa rodar de forma síncrona (não fire-and-forget)
    // para sabermos o número real de doses resultante antes de confirmar —
    // evita a Clara "inventar" ou ficar vaga sobre a quantidade.
    let confirmacaoAjusteRemedio = null;
    let acaoRespondeu = false;
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
      acaoRespondeu = await executeAction(user, phone, classified, text).catch(e => { console.error('Erro executeAction:', e.message); return false; });
    }
    // Se o executeAction já respondeu ao usuário (pediu horário/título que
    // faltava, ou confirmou chamada combinada), encerra aqui: nada de
    // confirmação de sistema nem responderLivre final por cima.
    if (acaoRespondeu) {
      extractAndSavePersonalInfo(user.id, text).catch(e => console.error('[extract pessoal]', e.message));
      return;
    }
    const isSaudacao = classified.tipo === 'saudacao';

    // Tipos estruturados que executam uma ação concreta (criar lembrete, gasto, etc) —
    // usados para dar confirmação fixa caso o bate-papo livre esteja em modo direto
    let confirmacaoTarefa = classified.titulo
      ? `✅ Anotado! "${classified.titulo}" — vou te lembrar 😉`
      : '✅ Anotado! Vou te lembrar.';
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
        const dataFmt = scheduledAt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' });
        const horaFmt = scheduledAt.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

        // Regra de confirmação: se o lembrete é pra HOJE, mostra só a hora
        // (dizer a data de hoje é redundante e robótico). Se é pra outro dia,
        // mostra data + hora. Em ambos os casos, SEMPRE devolve o que foi
        // anotado (título + quando) — assim o usuário confere na hora que a
        // Clara entendeu certo, sem depender do Dashboard.
        // É texto PRONTO (não instrução): no fluxo normal serve de guia pra
        // IA confirmar no tom; se cair em modo direto/fallback, vai assim
        // mesmo — então tem que estar apresentável sozinho.
        const ehHoje = scheduledAt.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }) === nowBRT().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
        if (ehHoje) {
          confirmacaoTarefa = `✅ Anotado! "${classified.titulo}" às ${horaFmt} ⏰`;
        } else {
          confirmacaoTarefa = `✅ Lembrete criado!\n\n📌 ${classified.titulo}\n🕐 ${dataFmt}, ${horaFmt}`;
        }
      } catch (e) {
        // mantém fallback genérico em caso de erro de parsing
      }
    }

    const medFreq = classified.frequencia || classified.horarios?.length || 1;
    const medDur = classified.duracao_dias || null;
    const medQtd = classified.quantidade || (medDur ? medDur * medFreq : 0);
    const medHorarios = (classified.horarios || ['08:00']).join(', ');
    let medConfirmacao = `✅ Medicamento cadastrado!\n\n💊 *${classified.nome || 'Remédio'}*\n⏰ Horários: ${medHorarios}`;
    if (medDur) medConfirmacao += `\n📅 Duração: ${medDur} ${medDur === 1 ? 'dia' : 'dias'}`;
    if (medQtd) medConfirmacao += `\n📦 Estoque: ${medQtd} doses`;

    const CONFIRMACOES_ACAO = {
      tarefa: confirmacaoTarefa,
      gasto: '✅ Gasto registrado!',
      entrada_financeira: '✅ Entrada registrada!',
      medicamento: medConfirmacao,
      anotacao: '✅ Anotado!',
      ajustar_remedio: confirmacaoAjusteRemedio || '😕 Não encontrei esse remédio. Me diz o nome certinho?',
    };

    // Confirmação para múltiplas tarefas — lista todas que foram criadas
    if (classified.tipo === 'multiplas_tarefas' && Array.isArray(classified.tarefas)) {
      const linhas = classified.tarefas.map((t, i) => {
        const horaTxt = t.hora ? ` às ${t.hora}` : '';
        return `${i + 1}. ${t.titulo}${horaTxt}`;
      }).join('\n');
      CONFIRMACOES_ACAO.multiplas_tarefas = `✅ Pode deixar! Anotei ${classified.tarefas.length} lembretes aqui comigo:\n\n${linhas}\n\nPode relaxar que eu te aviso 😊`;
    }

    const acaoConfirmacao = CONFIRMACOES_ACAO[classified.tipo] || null;

    // Confirmação de dose tomada — resposta fixa, sem LLM.
    // O LLM não sabe quais remédios foram tomados hoje e especula
    // sobre outros remédios, causando confusão (ex: "e o de pressão?").
    if (classified.tipo === 'ajustar_remedio' && classified.operacao === 'decrementar' && confirmacaoAjusteRemedio) {
      await sendMessage(phone, confirmacaoAjusteRemedio);
      emitirAtualizacao(phone, 'remedios');
      return;
    }

    // Múltiplas tarefas — confirmação fixa direta (sem LLM), pra não "mentir"
    // dizendo que criou tarefas que não foram processadas. A confirmação
    // lista exatamente o que foi gravado no banco.
    if (classified.tipo === 'multiplas_tarefas' && acaoConfirmacao) {
      // 1ª msg: confirmação estruturada com a lista
      await sendMessage(phone, acaoConfirmacao);
      // Salva marcador de conversa pra proativa não disparar por cima
      await memory.saveConversationMessage(user.id, 'assistant', acaoConfirmacao).catch(() => {});
      emitirAtualizacao(phone, 'lembretes');
      // 2ª msg: Clara sendo ela — comentário natural sobre os lembretes,
      // igual ao fluxo de tarefa única mas em background pra não atrasar.
      ;(async () => {
        try {
          await new Promise(r => setTimeout(r, 1800));
          const prefsMulti = await memory.getUserPreference(user.id).catch(() => ({}));
          const memAfetivaMulti = await memory.getMemoriaAfetiva(user.id).catch(() => ({}));
          const apelidoMulti = memAfetivaMulti?.apelido_usuario || prefsMulti?.name || '';
          const relMemMulti = await prisma.memory.findFirst({ where: { userId: user.id, type: 'relationship_summary' }, orderBy: { createdAt: 'desc' } }).catch(() => null);
          const ctxRelMulti = relMemMulti?.content ? `\n\n[MEMÓRIA DO RELACIONAMENTO]\n${relMemMulti.content}` : '';
          const histMulti = await memory.getConversationHistory(user.id, 8).catch(() => []);
          const resumoHistMulti = histMulti.length > 0
            ? `\n\n[CONVERSA ANTES DOS LEMBRETES]\n${histMulti.slice(-6).map(m => `${m.role === 'user' ? 'Ele' : 'Você'}: ${m.content}`).join('\n')}`
            : '';
          const sistemaMulti = buildPersonality(prefsMulti?.tom || 'carinhoso', apelidoMulti, false) + ctxRelMulti + resumoHistMulti + `\n\n[LEMBRETES CRIADOS] Ele criou ${classified.tarefas?.length || 'vários'} lembretes. Confirmação enviada. Continue a conversa naturalmente — priorize o que estava rolando antes se tiver assunto. O lembrete foi um aparte. Máximo 2 linhas. NÃO liste os lembretes, NÃO repita que vai avisar.`;
          const comentarioMulti = await comentarioGemini(sistemaMulti, text, 120);
          if (comentarioMulti && !isRespostaFallback(comentarioMulti)) {
            await sendMessage(phone, comentarioMulti);
            await memory.saveConversationMessage(user.id, 'assistant', comentarioMulti).catch(() => {});
          }
        } catch(e) { console.error('[MultitaskComment] Erro:', e.message); }
      })();
      return;
    }

    if (classified.tipo === 'medicamento' && acaoConfirmacao) {
      // 1ª msg: confirmação estruturada
      await sendMessage(phone, acaoConfirmacao);
      // Salva marcador pra proativa não disparar por cima
      await memory.saveConversationMessage(user.id, 'assistant', '[Clara] medicamento cadastrado').catch(() => {});
      emitirAtualizacao(phone, 'remedios');
      // 2ª msg: Clara sendo ela — se não tem estoque cadastrado, pergunta
      // sobre a embalagem de forma natural (comprimidos/ml), que é a
      // informação certa pra controlar o estoque, não "quantas doses".
      ;(async () => {
        try {
          await new Promise(r => setTimeout(r, 1800));
          const prefsMed = await memory.getUserPreference(user.id).catch(() => ({}));
          const memAfetivaMed = await memory.getMemoriaAfetiva(user.id).catch(() => ({}));
          const apelidoMed = memAfetivaMed?.apelido_usuario || prefsMed?.name || '';
          const relMemMed = await prisma.memory.findFirst({ where: { userId: user.id, type: 'relationship_summary' }, orderBy: { createdAt: 'desc' } }).catch(() => null);
          const ctxRelMed = relMemMed?.content ? `\n\n[MEMÓRIA DO RELACIONAMENTO]\n${relMemMed.content}` : '';
          const temEstoque = !!(classified.quantidade || (classified.duracao_dias && medFreq));
          
          const sistemaMed = buildPersonality(prefsMed?.tom || 'carinhoso', apelidoMed, false) + ctxRelMed + `\n\n[MEDICAMENTO CADASTRADO] Você acabou de cadastrar ${classified.nome || 'um remédio'}. A confirmação estruturada já foi enviada. ${temEstoque ? 'Reaja de forma natural e curta — comente, incentive ou faça uma pergunta leve.' : 'Pergunte de forma natural quantos comprimidos ou ml vem na embalagem — pra controlar o estoque e avisar quando acabar. Não use a palavra "doses". Máximo 2 linhas.'}`;
          const comentarioMed = await comentarioGemini(sistemaMed, text, 120);
          if (comentarioMed && !isRespostaFallback(comentarioMed)) {
            await sendMessage(phone, comentarioMed);
            await memory.saveConversationMessage(user.id, 'assistant', comentarioMed).catch(() => {});
          }
        } catch(e) { console.error('[MedComment] Erro:', e.message); }
      })();
      return;
    }

    // Para TAREFA (lembrete único): a confirmação vai como SEGUNDA mensagem
    // crua, separada da resposta humana. A IA gera só a conversa natural (não
    // recebe a confirmação no contexto, pra não confirmar embutido e duplicar);
    // a confirmação estruturada é enviada logo depois dentro de responderLivre.
    if (classified.tipo === 'tarefa' && acaoConfirmacao) {
      // 1ª: confirmação do sistema (fatos, sem personalidade)
      await sendMessage(phone, acaoConfirmacao);
      await memory.saveConversationMessage(user.id, 'assistant', acaoConfirmacao).catch(() => {});
      emitirAtualizacao(phone, 'lembretes');
      // 2ª: Clara sendo ela — tem acesso ao histórico recente da conversa,
      // então pode finalizar um assunto que estava rolando antes do lembrete,
      // ou usar o lembrete como gancho natural se fizer sentido. Não precisa
      // comentar sobre o lembrete — pode simplesmente continuar a conversa.
      ;(async () => {
        try {
          await new Promise(r => setTimeout(r, 1800));
          const prefsTarefa = await memory.getUserPreference(user.id).catch(() => ({}));
          const memAfetivaTarefa = await memory.getMemoriaAfetiva(user.id).catch(() => ({}));
          const apelidoTarefa = memAfetivaTarefa?.apelido_usuario || prefsTarefa?.name || '';
          const relMemTarefa = await prisma.memory.findFirst({ where: { userId: user.id, type: 'relationship_summary' }, orderBy: { createdAt: 'desc' } }).catch(() => null);
          const ctxRelTarefa = relMemTarefa?.content ? `\n\n[MEMÓRIA DO RELACIONAMENTO]\n${relMemTarefa.content}` : '';
          const histTarefa = await memory.getConversationHistory(user.id, 8).catch(() => []);
          const resumoHistorico = histTarefa.length > 0
            ? `\n\n[CONVERSA RECENTE ANTES DO LEMBRETE]\n${histTarefa.slice(-6).map(m => `${m.role === 'user' ? 'Ele' : 'Você'}: ${m.content}`).join('\n')}`
            : '';
          const sistemaTarefa = buildPersonality(prefsTarefa?.tom || 'carinhoso', apelidoTarefa, false) + ctxRelTarefa + resumoHistorico +
            `\n\n[LEMBRETE CRIADO] No meio da conversa ele criou o lembrete "${classified.titulo}"${classified.hora ? ` às ${classified.hora}` : ''}. A confirmação já foi enviada como sistema. Agora você pode: (a) continuar o assunto que estava rolando antes do lembrete, como uma conversa humana faria — o lembrete foi um aparte, não o fim do papo; (b) ou usar o lembrete como gancho natural SE for algo interessante de comentar. Priorize a continuidade da conversa. Máximo 2 linhas. NÃO diga "vou te avisar", "não esquece", "anotei".`;
          const comentarioTarefa = await comentarioGemini(sistemaTarefa, text, 120);
          if (comentarioTarefa && !isRespostaFallback(comentarioTarefa)) {
            await sendMessage(phone, comentarioTarefa);
            await memory.saveConversationMessage(user.id, 'assistant', comentarioTarefa).catch(() => {});
          }
        } catch(e) { console.error('[TarefaComment] Erro:', e.message); }
      })();
      extractAndSavePersonalInfo(user.id, text).catch(e => console.error('[extract pessoal]', e.message));
      return;
    }

    // CONFIRMAÇÃO DE LEMBRETE/REMÉDIO pelo handler (classificado como
    // concluir_lembrete/concluir_remedio). A confirmação de SISTEMA já foi
    // enviada (webhook handleSimpleResponse) OU será — aqui a Clara NÃO deve
    // soltar resposta genérica ("Aí sim! Pra isso que eu existo"). Ela só
    // comenta se tiver algo genuíno, senão fica quieta. Mesma regra do
    // LembreteConfirm, agora também nesse caminho (era o que vazava genérico).
    if (classified.tipo === 'concluir_lembrete' || classified.tipo === 'concluir_remedio') {
      // ── GUARDA ANTI-FALSO-POSITIVO ──────────────────────────────────────
      // O classify às vezes lê "deu certo"/"consegui"/"foi"/"resolvi" como
      // conclusão de tarefa. Mas muitas vezes é o usuário RESPONDENDO a uma
      // PERGUNTA da Clara (ex: o acompanhamento "e aí, como foi o Detran?").
      // No caso do print: ele respondeu "Deu certo fedo" citando a pergunta,
      // isso virou concluir_lembrete, a resposta foi ENGOLIDA (nem salva no
      // histórico nem respondida) e logo depois a Clara ainda reclamou que
      // estava sendo ignorada — porque, pra ela, ele nunca tinha respondido.
      //
      // Regra: só tratar como conclusão de verdade quando há SINAL FORTE —
      //   (a) citou o próprio alerta (🔔 Lembrete / 💊 Hora do medicamento);
      //   (b) o título casa com um lembrete pendente de confirmação;
      //   (c) citou um código (#1, "o 2"...) que aponta pra um pendente.
      // Se ele citou uma PERGUNTA da Clara (tem "?" e não é alerta), ou não
      // há match nenhum, então NÃO é conclusão: deixa seguir pro papo normal
      // (responderLivre), que reconhece a resposta e salva o turno.
      const mCit = (text || '').match(/\[Mensagem citada:\s*"([\s\S]*?)"\]/i);
      const citado = mCit ? mCit[1] : '';
      const citouAlerta = /🔔|💊|hora do medicamento|lembrete/i.test(citado);
      const citouPergunta = /\?/.test(citado) && !citouAlerta;

      let ehConclusaoReal = false;
      if (!citouPergunta) {
        const pendentesConf = await getLembretesPendentesConfirmacao(user.id).catch(() => []);
        const codigoConcl = extrairCodigoLembrete(text);
        if (codigoConcl && pendentesConf[codigoConcl - 1]) {
          ehConclusaoReal = true;
        } else if (classified.titulo && pendentesConf.length) {
          const tt = classified.titulo.toLowerCase();
          ehConclusaoReal = pendentesConf.some(r =>
            r.message.toLowerCase().includes(tt) || tt.includes(r.message.toLowerCase().substring(0, 10))
          );
        }
        if (!ehConclusaoReal && citouAlerta) ehConclusaoReal = true;
      }

      if (!ehConclusaoReal) {
        // Falso positivo — é conversa de verdade. Segue pro fluxo normal.
        console.log(`[Concluir] falso positivo (citouPergunta=${citouPergunta}) — tratando como conversa`);
        await responderLivre(user, phone, text, '', isSaudacao, acaoConfirmacao);
        extractAndSavePersonalInfo(user.id, text).catch(() => {});
        return;
      }

      // Envia confirmação estruturada — o handleSimpleResponse faz isso no caminho
      // rápido, mas aqui no caminho classify ninguém mandava. Fix.
      const tituloConf = classified.titulo || 'tarefa';
      const msgConf = `✅ Feito! "${tituloConf}" concluído.`;
      await sendMessage(phone, msgConf);
      await memory.saveConversationMessage(user.id, 'user', text).catch(() => {});
      await memory.saveConversationMessage(user.id, 'assistant', msgConf).catch(() => {});

      ;(async () => {
        try {
          await new Promise(r => setTimeout(r, 1500));
          if (!geminiDisponivel() || todosModelosEsgotados()) return;
          // BUG CORRIGIDO: aqui usava `preferences?.tom` e `apelidoReal`, mas
          // essas variáveis só existem dentro de responderLivre / do sub-bloco
          // de busca — no escopo do handleMessage NÃO existem, então o bloco
          // lançava "preferences is not defined" TODA vez e a Clara nunca
          // reagia a uma conclusão (morria em silêncio). Busca local resolve.
          const prefsConcl = await memory.getUserPreference(user.id).catch(() => ({}));
          const memAfConcl = await memory.getMemoriaAfetiva(user.id).catch(() => ({}));
          const apelidoConcl = memAfConcl?.apelido_usuario || prefsConcl?.name || '';
          const oQueFoi = classified.titulo || 'aquilo';
          const sysConcl = buildPersonality(prefsConcl?.tom || 'carinhoso', apelidoConcl, false) + `\n\n[TAREFA CONCLUÍDA] O usuário confirmou que fez/tomou: "${oQueFoi}". O sistema JÁ confirmou pra ele — você NÃO precisa dizer que registrou nem repetir a tarefa.\n\nDECIDA: isso merece uma reação sua de amiga? Só reaja se tiver peso genuíno (uma conquista, algo importante, algo com graça real). Se for rotineiro (tomar remédio do dia a dia, tarefa comum), responda APENAS "SKIP" — fica quieta, o sistema já cuidou.\n\nSe for reagir: 1 linha curta, no seu tom, sobre ISSO. NÃO puxe outros assuntos (saúde de familiares, agenda, pendências). NÃO faça pergunta genérica tipo "como está se sentindo?" toda vez. NUNCA seja genérica ("boa!", "arrasou!", "pra isso que eu existo" são proibidos). Se não tem nada específico e genuíno, é SKIP.`;
          const coment = await geminiFreeResponse([
            { role: 'system', content: sysConcl },
            { role: 'user', content: `Confirmei: "${oQueFoi}"` }
          ], { temperature: 0.85, maxTokens: 100 }).catch(() => null);
          const comentLimpo = filtrarResposta((coment || '').replace(/[*_]{0,2}BUSCAR:[^*_\n]*[*_]{0,2}/gi, '').trim());
          if (comentLimpo && comentLimpo.length > 3 && !/^SKIP/i.test(comentLimpo)) {
            await sendMessage(phone, comentLimpo);
            await memory.saveConversationMessage(user.id, 'assistant', comentLimpo).catch(() => {});
          }
        } catch (e) { console.error('[ConcluirComment] Erro:', e.message); }
      })();
      extractAndSavePersonalInfo(user.id, text).catch(() => {});
      return;
    }

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

async function gerarRelatorioFinanceiroWhatsApp(user, phone, textoUsuario = '') {
  try {
    const now = nowBRT();
    const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const mesesLow = meses.map(m => m.toLowerCase());

    // Detecta mês específico na pergunta ("finanças de junho"); senão, vigente.
    const txtLow = (textoUsuario || '').toLowerCase();
    let mesAlvo = now.getMonth();
    let anoAlvo = now.getFullYear();
    for (let i = 0; i < mesesLow.length; i++) {
      if (new RegExp(`\\b${mesesLow[i]}\\b`, 'i').test(txtLow) || (i === 2 && /\bmarco\b/i.test(txtLow))) {
        mesAlvo = i;
        // Ano: por padrão o atual. Só considera ano PASSADO se o mês pedido
        // está muito à frente (mais de 6 meses no futuro) — aí provavelmente
        // a pessoa quer o passado (ex: em janeiro perguntar "novembro" = ano
        // passado). Meses próximos no futuro (agosto pedido em julho) usam o
        // ano atual, porque o usuário pode registrar lançamentos futuros.
        if (i - now.getMonth() > 6) anoAlvo = now.getFullYear() - 1;
        break;
      }
    }
    const inicioMes = new Date(anoAlvo, mesAlvo, 1);
    const fimMes = new Date(anoAlvo, mesAlvo + 1, 0, 23, 59, 59);
    const nomeMes = meses[mesAlvo];

    const gastos = await prisma.expense.findMany({ where: { userId: user.id, createdAt: { gte: inicioMes, lte: fimMes } }, orderBy: { createdAt: 'desc' } });
    const saidas = gastos.filter(g => g.value > 0);
    const entradas = gastos.filter(g => g.value < 0);
    const totalGasto = saidas.reduce((a, g) => a + g.value, 0);
    const totalEntradas = entradas.reduce((a, g) => a + Math.abs(g.value), 0);
    const saldo = totalEntradas - totalGasto;

    // Formata em pt-BR: R$ 1.919,07 (ponto de milhar, vírgula decimal)
    const brl = v => 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const catIcones = { alimentacao:'🍔', mercado:'🛒', transporte:'🚗', saude:'💊', lazer:'🎮', moradia:'🏠', educacao:'📚', entrada:'💰', outro:'📦' };
    const catNomes = { alimentacao:'Alimentação', mercado:'Mercado', transporte:'Transporte', saude:'Saúde', lazer:'Lazer', moradia:'Moradia', educacao:'Educação', entrada:'Entrada', outro:'Outros' };
    const porCategoria = {};
    saidas.forEach(g => { const cat = g.category || 'outro'; porCategoria[cat] = (porCategoria[cat] || 0) + g.value; });

    if (gastos.length === 0) {
      await sendButtons(phone, `📊 *Finanças • ${nomeMes} de ${anoAlvo}*\n\nNenhum lançamento nesse mês ainda 😊`, [{ id: 'novo_gasto', label: '➕ Registrar gasto' }, { id: 'menu', label: '🏠 Menu' }]);
      return;
    }

    // ── Cabeçalho ──
    let texto = `📊 *Finanças • ${nomeMes} de ${anoAlvo}*\n\n`;
    texto += `💰 *Entradas:* ${brl(totalEntradas)}\n`;
    texto += `💸 *Gastos:* ${brl(totalGasto)}\n`;
    const emojiSaldo = saldo < 0 ? '📉' : '📈';
    texto += `${emojiSaldo} *Saldo:* ${brl(saldo)}\n`;

    // ── Principais gastos ──
    if (Object.keys(porCategoria).length > 0) {
      texto += `\n*Principais gastos*\n`;
      Object.entries(porCategoria).sort((a, b) => b[1] - a[1]).forEach(([cat, val]) => {
        texto += `${catIcones[cat] || '📦'} ${catNomes[cat] || cat.charAt(0).toUpperCase() + cat.slice(1)}: ${brl(val)}\n`;
      });
    }

    // ── Últimos lançamentos ──
    const ultimos = saidas.slice(0, 5);
    if (ultimos.length > 0) {
      texto += `\n*Últimos lançamentos*\n`;
      ultimos.forEach(g => {
        const nome = g.description && g.description !== g.category ? g.description : (catNomes[g.category] || g.category);
        texto += `• ${nome} — ${brl(g.value)}\n`;
      });
    }

    // ── Resumo final (a linha que fecha com sentido) ──
    texto += `\n`;
    if (saldo < 0) {
      texto += `⚠️ Seus gastos ultrapassaram as entradas em ${brl(Math.abs(saldo))}, fechando ${nomeMes.toLowerCase()} com um saldo de ${brl(saldo)}.`;
    } else if (totalEntradas > 0) {
      texto += `✅ Você fechou ${nomeMes.toLowerCase()} no positivo, com ${brl(saldo)} de saldo. Mandou bem!`;
    } else {
      texto += `📌 Você ainda não registrou entradas em ${nomeMes.toLowerCase()}. Registre seu salário pra ver o saldo real do mês.`;
    }

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
    { const saldo = totalEntradas - totalGasto; texto += `💵 Saldo do mês: *R$ ${saldo.toFixed(2)}*\n`; }
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
  // Retorna true se JÁ respondeu ao usuário aqui dentro (pediu o horário/título
  // que faltava, ou confirmou a chamada combinada). Nesses casos o handleMessage
  // NÃO deve mandar confirmação de sistema nem chamar o responderLivre final —
  // senão sai mensagem duplicada.
  let respondeuAqui = false;
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
    case 'chamada_combinada': {
      const horaJaInformada = classified.hora;
      let horaFinal = horaJaInformada;

      if (!horaFinal) {
        // Sem horário — calcula baseado no CONTEXTO da conversa primeiro,
        // depois na agenda (remédios + compromissos), com 21h como último recurso
        try {
          const agora = nowBRT();
          const hojeISO = dateBRT();
          const hAtual = agora.getHours() * 60 + agora.getMinutes();

          let horaBaseMin = null;

          // 1) Pista do CONTEXTO — se ela sabe que ele tá saindo pra almoçar,
          // jantar, tirar uma soneca etc, faz mais sentido chamar depois
          // disso do que ir direto pro padrão fixo da noite.
          const textoContexto = (originalText || text || '').toLowerCase();
          if (/almo[çc]|almo[çc]ando|almo[çc]ar/.test(textoContexto)) {
            horaBaseMin = 14 * 60 + 30; // meio da tarde, depois do almoço
          } else if (/jant|jantando/.test(textoContexto)) {
            horaBaseMin = 21 * 60; // à noite
          } else if (/dormir|dormindo|sesta|cochilo|soneca/.test(textoContexto)) {
            horaBaseMin = hAtual + 120; // ~2h depois, dá tempo de descansar
          }

          // 2) Sem pista de contexto — usa a agenda real (remédio/compromisso)
          if (horaBaseMin === null) {
            const meds = await prisma.medication.findMany({ where: { userId: user.id, active: true } }).catch(() => []);
            const horariosMeds = [];
            for (const m of meds) {
              let times = []; try { times = JSON.parse(m.times || '[]'); } catch {}
              for (const t of times) {
                const [h, min] = t.split(':').map(Number);
                const hMin = h * 60 + min;
                if (hMin > hAtual) horariosMeds.push(hMin); // só futuros hoje
              }
            }

            const proximoComp = await prisma.reminder.findFirst({
              where: { userId: user.id, sent: false, confirmed: false, scheduledAt: { gte: new Date(`${hojeISO}T${String(agora.getHours()).padStart(2,'0')}:${String(agora.getMinutes()).padStart(2,'0')}:00-03:00`) } },
              orderBy: { scheduledAt: 'asc' }
            }).catch(() => null);

            if (horariosMeds.length > 0) {
              // Tem remédio — chama 30min depois do primeiro remédio futuro
              horaBaseMin = Math.min(...horariosMeds) + 30;
            } else if (proximoComp) {
              // Tem compromisso — chama 1h antes
              horaBaseMin = new Date(proximoComp.scheduledAt).getHours() * 60 + new Date(proximoComp.scheduledAt).getMinutes() - 60;
            }
          }

          // 3) Nada disso deu pista — padrão seguro: 21h
          if (!horaBaseMin) horaBaseMin = 21 * 60;

          // Sempre no mínimo 30min a partir de agora (nunca no passado/em cima)
          if (horaBaseMin < hAtual + 30) horaBaseMin = hAtual + 30;
          // Nunca depois das 23h (cron de disparo só roda até 23h)
          horaBaseMin = Math.min(horaBaseMin, 23 * 60);

          // Variação de ±15 min pra não parecer alarme
          const variacao = Math.floor(Math.random() * 31) - 15;
          horaBaseMin = Math.min(Math.max(horaBaseMin + variacao, hAtual + 15), 23 * 60);

          const h = Math.floor(horaBaseMin / 60);
          const m = horaBaseMin % 60;
          horaFinal = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
        } catch(e) {
          horaFinal = '21:00'; // fallback seguro
        }
      }

      // Salva a chamada combinada com o CONTEXTO DA CONVERSA — o que estava
      // sendo discutido quando o combinado foi feito. Quando o cron disparar
      // no horário combinado, ele usa esse contexto pra gerar a mensagem certa
      // em vez de aparecer genérico ("e aí fedo, o que tá fazendo?").
      await prisma.memory.deleteMany({ where: { userId: user.id, type: 'chamada_combinada' } }).catch(() => {});
      
      // Salva últimas 4 mensagens como contexto do combinado
      const histCombinado = await memory.getConversationHistory(user.id, 6).catch(() => []);
      const ctxCombinado = histCombinado.slice(-4).map(m =>
        `${m.role === 'user' ? 'Ele' : 'Você'}: ${m.content}`
      ).join('\n');

      await prisma.memory.create({
        data: {
          userId: user.id,
          type: 'chamada_combinada',
          content: horaFinal,
          metadata: JSON.stringify({
            hora: horaFinal,
            expira: Date.now() + 24 * 60 * 60 * 1000,
            contexto: ctxCombinado,  // o que estava rolando quando combinou
            assunto: (originalText || text || '').slice(0, 200) // a mensagem que gerou o combinado
          })
        }
      }).catch(() => {});

      const foiSaudade = /saudade|quando sentir|quando quiser|quando der/i.test(originalText || '');
      // Confirma a chamada combinada NO TOM dela, aqui mesmo (executeAction),
      // passando a dica como contextoExtra do responderLivre. Marca respondeuAqui
      // pro handleMessage não mandar outra resposta por cima.
      const dicaChamada = foiSaudade
        ? `\n\n[CHAMADA COMBINADA] Usuário disse pra chamar quando sentir saudade — você decidiu que vai chamar às ${horaFinal}. Responda de forma natural e carinhosa/zoeira conforme o tom, sem revelar que calculou o horário. Ex: "Pode deixar, uma hora dessas eu apareço 😏" — não mencione o horário exato, só confirme que vai aparecer.`
        : `\n\n[CHAMADA COMBINADA] Usuário pediu pra ser chamado${horaJaInformada ? ` às ${horaFinal}` : ` — você escolheu às ${horaFinal}`}. Confirme de forma natural e animada. ${!horaJaInformada ? `Como você calculou o horário sozinha, varie entre duas formas de confirmar: (a) só dizer algo como "combinado, apareço mais tarde 😉" sem revelar a hora exata, ou (b) oferecer deixar ele escolher, tipo "Chamo sim! Se quiser me dizer uma hora melhor, é só falar que eu te chamo quando você quiser 😉" — escolha a que soar mais natural pro momento.` : `Ex: "Combinado! Te chamo às ${horaFinal} 😏"`}`;
      await responderLivre(user, phone, originalText || '', dicaChamada).catch(e => console.error('[chamada_combinada resp]', e.message));
      respondeuAqui = true;
      break;
    }
    case 'tarefa': {
      const resultTarefa = await salvarTarefaSilenciosa(user, phone, classified, originalText);
      if (resultTarefa?.perguntarTitulo) {
        // Título incompleto — pede o complemento de forma natural e zoeira
        const expira = Date.now() + 15 * 60 * 1000;
        await prisma.memory.create({
          data: {
            userId: user.id,
            type: 'confirmacao_pendente',
            content: JSON.stringify({
              tipo: 'coleta_titulo',
              tituloIncompleto: resultTarefa.tituloIncompleto,
              data: classified.data,
              hora: classified.hora,
              expira
            })
          }
        }).catch(() => {});
        const ctx = `\n\nSITUAÇÃO: O usuário pediu um lembrete mas o título ficou incompleto: "${resultTarefa.tituloIncompleto}". Pergunte de forma natural e com seu jeito — ex: "Opa, cobrar quem? 😄" ou "Espera, ${resultTarefa.tituloIncompleto} quem? Não me deixa curiosa! 🤔" — curto, no seu tom, sem criar nada ainda.`;
        // Faz a pergunta aqui e sinaliza que já respondeu (evita "Anotado!" falso
        // e o responderLivre final — que sairiam por cima, já que nada foi criado).
        await responderLivre(user, phone, originalText || '', ctx).catch(e => console.error('[perguntarTitulo]', e.message));
        respondeuAqui = true;
      } else if (resultTarefa?.perguntarHora) {
        // Salva pendência de coleta — aguarda data/hora do usuário
        const expira = Date.now() + 15 * 60 * 1000; // 15 min
        await prisma.memory.create({
          data: {
            userId: user.id,
            type: 'confirmacao_pendente',
            content: JSON.stringify({
              tipo: 'coleta_lembrete',
              titulo: resultTarefa.lembreteTitulo,
              data: resultTarefa.lembreteData || null,
              turno: resultTarefa.lembreteData ? 'hora' : 'data',
              expira
            })
          }
        }).catch(() => {});
        // A Clara pergunta de forma natural no seu tom
        const temData = !!resultTarefa.lembreteData;
        const ctx = `\n\nSITUAÇÃO: O usuário pediu pra lembrar de "${resultTarefa.lembreteTitulo}"${temData ? ` para ${resultTarefa.lembreteData}` : ''} mas não disse ${temData ? 'o horário' : 'quando'}. Pergunte ${temData ? 'que horas' : 'quando e que horas'} de forma natural e com seu jeito — ex: "Que legal! A que horas vai ser?" ou "Pode deixar! Pra quando você quer que eu te lembre?" — varie conforme o contexto. Não crie o lembrete ainda.`;
        // Faz a pergunta aqui e sinaliza que já respondeu (ver nota acima).
        await responderLivre(user, phone, originalText || '', ctx).catch(e => console.error('[perguntarHora]', e.message));
        respondeuAqui = true;
      }
      break;
    }
    case 'multiplas_tarefas':
      // Cria cada tarefa do array individualmente, reusando salvarTarefaSilenciosa
      if (Array.isArray(classified.tarefas)) {
        for (const t of classified.tarefas) {
          await salvarTarefaSilenciosa(user, phone, { ...t, tipo: 'tarefa' }, null).catch(e => {
            console.error(`[MultiTarefa] Erro ao criar "${t.titulo}":`, e.message);
          });
        }
      }
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
      if (classified.nome) {
        const freq = classified.frequencia || classified.horarios?.length || 1;
        const durDias = classified.duracao_dias || null;
        // Calcula estoque: duracao × frequencia, ou o que veio no classified
        let qtd = classified.quantidade || 0;
        if (!qtd && durDias && freq) qtd = durDias * freq;
        await memory.saveMedication(user.id, {
          nome: classified.nome,
          quantidade: qtd,
          frequencia: freq,
          horarios: classified.horarios || ['08:00']
        });
      }
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
      // Sem título e sem código explícito: tenta inferir pelo texto da mensagem
      if (!match && !codigo) {
        if (pendentes.length === 1) {
          // Só 1 pendente — assume ele
          match = pendentes[0];
        } else {
          // Múltiplos pendentes — tenta casar pelo texto da mensagem ou quotedText
          const textoParaBusca = ((originalText || '') + ' ' + (quotedText || '')).toLowerCase();
          match = pendentes.find(r => {
            const palavras = r.message.toLowerCase().split(/\s+/).filter(w => w.length > 3);
            return palavras.some(p => textoParaBusca.includes(p));
          });
          // Fallback: usa o mais recente que já foi disparado (sent:true)
          if (!match) {
            match = pendentes.find(r => r.sent) || pendentes[0];
          }
        }
      }

      if (match) {
        await prisma.reminder.update({ where: { id: match.id }, data: { confirmed: true } });
        fecharPendenciaLembrete(user.id, match.message).catch(() => {});
        emitirAtualizacao(phone, 'lembretes');
      }
      break;
    }
    case 'saldo':
      if (classified.valor !== undefined && classified.valor !== null) await memory.saveUserPreference(user.id, null, null, parseFloat(classified.valor));
      break;
  }
  return respondeuAqui;
}

// ── Detector de humor ──────────────────────────────────────────────────
// Analisa texto do usuário e detecta estado emocional.
// Leve e rápido — usa regras simples sem chamar LLM.

// Detector de memoria afetiva
// Detecta apelidos e tom da relacao nas conversas.
async function detectarEsalvarAfetivo(userId, textoUsuario, respostaClara) {
  try {
    const t = (textoUsuario || '').toLowerCase();
    // Detecta apelido que a Clara usa pro usuario
    const matchApelido = (respostaClara || '').match(/\b(meu fedo|meu amor|meu bem|minha vida|fofinho|querido|querida)\b/i);
    if (matchApelido) {
      await salvarMemoriaAfetiva(userId, 'apelido_usuario', matchApelido[1].toLowerCase());
    }
    // Detecta tom da relacao
    if (/kkkk|rsrs|haha|brincand/i.test(t)) {
      await salvarMemoriaAfetiva(userId, 'tom_relacao', 'descontraido, com humor e brincadeiras');
    } else if (/amor|carinho/i.test(t)) {
      await salvarMemoriaAfetiva(userId, 'tom_relacao', 'carinhoso e proximo');
    }
    // Detecta como o usuario chama a Clara
    const apelidosClara = ['clarita', 'clarinha', 'fraquinha'];
    for (const ap of apelidosClara) {
      if (t.includes(ap)) {
        await salvarMemoriaAfetiva(userId, 'apelido_clara', ap);
        break;
      }
    }
  } catch {}
}

async function detectarEsalvarHumor(userId, textoUsuario, respostaClara) {
  const t = (textoUsuario || '').toLowerCase();

  // Sinais de estados negativos
  const DOENTE = /hospital|médico|medico|fui pro ps|passando mal|internado|operação|cirurgia|exame|consultório|consultor|enjoado|febre|dor de cabeça|pressão alta|remédio novo/i;
  const CANSADO = /cansad[oa]|exaust[oa]|sem energia|morto de cansaço|destruído|destruido|esgotad[oa]|não aguento|nao aguento|pesado demais|foi pesado/i;
  const ESTRESSADO = /estressad[oa]|nervos[oa]|irritad[oa]|raiva|bravo|brava|ódio|odio|dia horrível|horrivel|péssimo|pessimo|terrível|terrivel|foi uma merda|tá uma merda/i;
  const PREOCUPADO = /preocupad[oa]|ansios[oa]|com medo|nervoso com|não sei o que|nao sei o que|incerto|complicado|difícil|difícil demais/i;
  const TRISTE = /triste|deprimid[oa]|choran|chorei|mal hoje|muito mal|não tô bem|tô mal|tô ruim/i;

  // Sinais de estados positivos
  const ANIMADO = /animad[oa]|feliz|alegr[eo]|ótim[oa]|otim[oa]|maravilhos[oa]|incrível|incrivel|arrasand[oa]|deu tudo certo|foi incrível|foi ótimo|que dia/i;

  let estado = null;
  let intensidade = 'leve';
  let motivo = null;

  if (DOENTE.test(t)) {
    estado = 'doente';
    intensidade = 'intenso';
    const matchMotivo = t.match(/hospital|médico|ps|internado|operação|exame/i);
    if (matchMotivo) motivo = matchMotivo[0];
  } else if (ESTRESSADO.test(t)) {
    estado = 'estressado';
    intensidade = t.includes('muito') || t.includes('demais') ? 'intenso' : 'moderado';
  } else if (CANSADO.test(t)) {
    estado = 'cansado';
    intensidade = t.includes('muito') || t.includes('morto') || t.includes('destruído') ? 'intenso' : 'leve';
  } else if (PREOCUPADO.test(t)) {
    estado = 'preocupado';
  } else if (TRISTE.test(t)) {
    estado = 'triste';
    intensidade = 'moderado';
  } else if (ANIMADO.test(t)) {
    estado = 'animado';
    intensidade = 'leve';
  }

  if (estado) {
    await salvarHumorDia(userId, { estado, intensidade, motivo });
    console.log(`[Humor] ${userId}: ${estado} (${intensidade})${motivo ? ' — ' + motivo : ''}`);
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
  // ── Título incompleto — pede complemento antes de criar ──────────────
  // Se o título termina em preposição ou artigo, ou é muito curto/vago,
  // ela pergunta o complemento de forma natural em vez de criar "cobrar a"
  const titulo = (classified.titulo || '').trim();
  const terminaIncompleto = /\b(a|o|os|as|um|uma|de|do|da|dos|das|para|pro|pra|com|em|no|na|nos|nas|que|e|ou)\s*$/i.test(titulo);
  const tituloVago = titulo.length < 5 || terminaIncompleto;
  if (tituloVago) {
    return { perguntarTitulo: true, tituloIncompleto: titulo };
  }
  await memory.saveMemory(user.id, 'tarefa', titulo, { data: classified.data, hora: classified.hora });
  let scheduledAt = null;

  // 1ª tentativa: tempo relativo no texto original ("daqui 30 minutos", "em 1 hora")
  // Tem prioridade sobre classified.hora porque o modelo às vezes não converte
  // tempos relativos pra absoluto corretamente.
  const textoParaRelativo = originalText || classified.titulo || '';
  if (textoParaRelativo) {
    const relativo = calcularHorarioRelativo(textoParaRelativo);
    if (relativo) { scheduledAt = relativo; }
  }

  // 2ª tentativa: hora absoluta extraída pelo classify
  if (!scheduledAt && classified.hora) {
    try {
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
      if (!isNaN(h) && !isNaN(m)) {
        scheduledAt = new Date(`${dataUsada}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00-03:00`);
        if (!classified.data && scheduledAt < nowBRT()) { scheduledAt.setDate(scheduledAt.getDate() + 1); }
      }
    } catch (e) {
      console.warn(`[salvarTarefa] Erro ao parsear hora "${classified.hora}":`, e.message);
    }
  }
  // ── SEM HORA E SEM DATA — pede o horário antes de criar ──
  // Guarda: se o texto original tem expressão de tempo relativo mas
  // calcularHorarioRelativo falhou por algum motivo, tenta de novo
  // com uma janela mais ampla antes de pedir ao usuário.
  const textoTemRelativo = /daqui\s+\d+|em\s+\d+\s*(min|hora|h\b)/i.test(textoParaRelativo);
  if (!scheduledAt && textoTemRelativo) {
    // Tem "daqui X" ou "em X min/hora" mas parse falhou — usa 30 min como fallback seguro
    console.warn(`[salvarTarefa] Tempo relativo detectado mas parse falhou, usando 30min como fallback`);
    scheduledAt = new Date(Date.now() + 30 * 60 * 1000);
  }

  if (!scheduledAt && !classified.hora && !classified.data) {
    return { perguntarHora: true, lembreteTitulo: classified.titulo, lembreteData: null };
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
      let scheduledBase = scheduledAt;
      // Se não tem horário definido (hora:null), busca o lembrete existente pelo título
      if (!classified.hora && classified.titulo) {
        const lembreteExistente = await prisma.reminder.findFirst({
          where: {
            userId: user.id,
            confirmed: false,
            message: { contains: classified.titulo.split(' ').filter(w => w.length > 3)[0] || classified.titulo, mode: 'insensitive' }
          },
          orderBy: { scheduledAt: 'asc' }
        }).catch(() => null);
        if (lembreteExistente) scheduledBase = new Date(lembreteExistente.scheduledAt);
      }
      const scheduledAntes = new Date(scheduledBase.getTime() - antecedencia * 60 * 1000);
      if (scheduledAntes > new Date()) {
        await prisma.reminder.create({ data: { userId: user.id, phone, message: `⏰ Em ${antecedencia} minutos: ${classified.titulo}`, scheduledAt: scheduledAntes } });
      }
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
    // Se classify não extraiu nova_hora, tenta extrair do texto diretamente
    // ("pra 10 horas", "às 10", "10h", "10:00" etc.)
    if (!classified.nova_hora && text) {
      const textN = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const mHM = textN.match(/(\d{1,2})[:h](\d{2})/);
      const mH = textN.match(/(\d{1,2})\s*h(?:oras?)?\b/);
      const mAs = textN.match(/[a]s?\s+(\d{1,2})\b/);
      const mPra = textN.match(/pr[ao]\s+(\d{1,2})\b/);
      const m = mHM || mH || mAs || mPra;
      if (m) {
        let h = parseInt(mHM ? m[1] : m[1]);
        let min = mHM ? parseInt(m[2]) : 0;
        if (/tarde|noite/.test(textN) && h < 12) h += 12;
        classified.nova_hora = `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
      }
    }

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
    await sendMessage(phone, `✅ Remarcado!\n\n📌 ${encontrado.message}\n🕐 ${dataFormatada} às ${horaFormatada}`);

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

    // Aprende endereco de casa ou trabalho
    if (dados.tipo === 'aprender_endereco') {
      await prisma.memory.delete({ where: { id: pendente.id } }).catch(() => {});
      const ehCasa = /\bcasa\b|minha casa|em casa/i.test(text);
      const ehTrabalho = /\btrabalho\b|empresa|loja|servico|escritorio/i.test(text);
      if (ehCasa || ehTrabalho) {
        const chave = ehCasa ? 'endereco_casa' : 'endereco_trabalho';
        const chaveNome = ehCasa ? 'bairro_casa' : 'bairro_trabalho';
        const label = ehCasa ? 'casa' : 'trabalho';
        const locTexto = dados.bairro ? (dados.bairro + ', ' + (dados.cidade || '')).trim() : (dados.cidade || 'esse local');
        await memory.savePersonalInfo(user.id, chave, JSON.stringify({ lat: dados.lat, lng: dados.lng }), 'localizacao').catch(() => {});
        await memory.savePersonalInfo(user.id, chaveNome, locTexto, 'localizacao').catch(() => {});
        await sendMessage(phone, 'Anotei! Agora sei onde fica seu ' + label + ' (' + locTexto + '). Da proxima vez que compartilhar sua localizacao de la, vou reconhecer!');
        console.log('[Geo] Endereco de ' + label + ' aprendido: ' + locTexto);
      } else {
        await sendMessage(phone, 'Esse local e sua casa ou seu trabalho?');
        await prisma.memory.create({ data: { userId: user.id, type: 'confirmacao_pendente', content: JSON.stringify({ ...dados, expira: Date.now() + 5 * 60 * 1000 }) } }).catch(() => {});
      }
      return;
    }

    // ── Coleta de título incompleto ───────────────────────────────────────
    if (dados.tipo === 'coleta_titulo') {
      await prisma.memory.delete({ where: { id: pendente.id } }).catch(() => {});
      // Usa a resposta do usuário como complemento do título
      const tituloCompleto = dados.tituloIncompleto
        ? `${dados.tituloIncompleto} ${text.trim()}`.trim()
        : text.trim();
      // Agora cria com o título completo
      const classifiedCompleto = {
        tipo: 'tarefa',
        titulo: tituloCompleto,
        data: dados.data || null,
        hora: dados.hora || null,
        antecedencia: 0,
        recorrente: false,
        frequencia: null
      };
      const resultFinal = await salvarTarefaSilenciosa(user, phone, classifiedCompleto, text);
      // BUG CORRIGIDO: usava `preferences._dicaAcao` (preferences inexistente
      // neste escopo → crash) e passava '' pro responderLivre, então a pergunta
      // "que horas?" nunca chegava. Agora o ctx vai direto como contextoExtra.
      let dicaAcao = '';
      if (resultFinal?.perguntarHora) {
        const expira = Date.now() + 15 * 60 * 1000;
        await prisma.memory.create({
          data: {
            userId: user.id, type: 'confirmacao_pendente',
            content: JSON.stringify({ tipo: 'coleta_lembrete', titulo: tituloCompleto, data: dados.data, turno: 'hora', expira })
          }
        }).catch(() => {});
        dicaAcao = `\n\n[COLETA] Lembrete "${tituloCompleto}" — ainda falta o horário. Pergunte que horas de forma natural.`;
      }
      await responderLivre(user, phone, text, dicaAcao || `\n\n[TÍTULO COMPLETADO] Lembrete "${tituloCompleto}" foi criado. Confirme naturalmente.`);
      return;
    }

    // ── Coleta de lembrete em múltiplos turnos ────────────────────────────
    if (dados.tipo === 'coleta_lembrete') {
      await prisma.memory.delete({ where: { id: pendente.id } }).catch(() => {});

      const titulo = dados.titulo;
      let dataFinal = dados.data;
      let horaFinal = null;

      // Extrai data da resposta se ainda não tinha
      if (!dataFinal) {
        if (/hoje/i.test(textNorm)) dataFinal = dateBRT();
        else if (/amanhã|amanha/i.test(textNorm)) {
          const am = new Date(nowBRT()); am.setDate(am.getDate() + 1);
          dataFinal = `${am.getFullYear()}-${String(am.getMonth()+1).padStart(2,'0')}-${String(am.getDate()).padStart(2,'0')}`;
        } else {
          // Tenta extrair dia do mês
          const diaMatch = textNorm.match(/dia\s+(\d{1,2})|(\d{1,2})\s+de/);
          if (diaMatch) {
            const dia = parseInt(diaMatch[1] || diaMatch[2]);
            const agora = nowBRT();
            const tentativa = new Date(agora.getFullYear(), agora.getMonth(), dia);
            if (tentativa < agora) tentativa.setMonth(tentativa.getMonth() + 1);
            dataFinal = `${tentativa.getFullYear()}-${String(tentativa.getMonth()+1).padStart(2,'0')}-${String(tentativa.getDate()).padStart(2,'0')}`;
          }
        }
      }

      // Extrai hora da resposta
      const horaMatch = textNorm.match(/(\d{1,2})[h:]\s*(\d{0,2})/);
      const naoSabe = /não sei|qualquer|tanto faz|você decide|pode ser/i.test(textNorm);
      if (horaMatch && !naoSabe) {
        const h = String(parseInt(horaMatch[1])).padStart(2,'0');
        const m = String(parseInt(horaMatch[2] || '0')).padStart(2,'0');
        horaFinal = `${h}:${m}`;
      }

      // Se ainda falta informação, salva o que tem e pede o resto
      if (!dataFinal || !horaFinal) {
        const expira = Date.now() + 15 * 60 * 1000;
        await prisma.memory.create({
          data: {
            userId: user.id, type: 'confirmacao_pendente',
            content: JSON.stringify({ tipo: 'coleta_lembrete', titulo, data: dataFinal, turno: dataFinal ? 'hora' : 'data', expira })
          }
        }).catch(() => {});
        const ctx = !dataFinal
          ? `\n\n[COLETA] Usuário ainda não disse quando é "${titulo}". Pergunte a data de forma natural e curta.`
          : `\n\n[COLETA] Usuário disse que é ${dataFinal} mas não disse o horário de "${titulo}". Pergunte que horas de forma natural — pode sugerir um horário inteligente ex: "às 16h pra dar tempo de se preparar?" dependendo do contexto.`;
        await responderLivre(user, phone, text, ctx, false, null, null);
        return;
      }

      // Tem tudo — cria o lembrete
      const scheduledAt = new Date(`${dataFinal}T${horaFinal}:00-03:00`);
      if (scheduledAt <= nowBRT()) scheduledAt.setDate(scheduledAt.getDate() + 1);

      await prisma.reminder.create({ data: { userId: user.id, phone, message: titulo, scheduledAt } });
      const horaFmt = scheduledAt.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
      const dataFmt = scheduledAt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit' });

      const confirmacao = `✅ Anotado! "${titulo}" — ${dataFmt} às ${horaFmt} ⏰`;
      const ctx = `\n\n[LEMBRETE CRIADO] "${titulo}" para ${dataFmt} às ${horaFmt}. Confirme de forma natural e animada no seu tom.`;
      await responderLivre(user, phone, text, ctx, false, null, confirmacao);
      emitirAtualizacao(phone, 'lembretes');
      return;
    }

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
      // Detecção de cancelamento — "não precisa", "deixa", "cancela" = encerra sem criar
      const cancelou = /n[aã]o\s*(precisa|quero|vai|vou|vem|tem|queremos)|cancela|esquece|deixa\s*pra\s*l[aá]|desisti|mudei\s*de\s*ideia/i.test(text);
      if (cancelou) {
        await prisma.memory.delete({ where: { id: pendente.id } }).catch(() => {});
        console.log(`[HoraLembrete] Cancelado pelo usuário — "${dados.titulo}"`);
        return false; // deixa a resposta natural do freeResponse cuidar
      }

      // Emoji puro (😂, ❤️, 👍) = reação, não tentativa de dar horário — ignora
      const apenasEmoji = text.trim().length <= 4 || /^[\p{Emoji}\s]+$/u.test(text.trim());
      if (apenasEmoji) return false;
      let horaEscolhida = null;
      const matchHM = textNorm.match(/(d{1,2})[:h](d{2})/);
      const matchH = textNorm.match(/(d{1,2})s*h(?:oras)?b/);
      const matchAs = textNorm.match(/[àa]s?s+(d{1,2})b/);
      const matchNum = (!matchHM && !matchH && !matchAs) ? textNorm.match(/^[^0-9]*(d{1,2})[^0-9]*$/) : null;
      if (matchHM) {
        horaEscolhida = `${String(parseInt(matchHM[1])).padStart(2,'0')}:${matchHM[2]}`;
      } else if (matchH) {
        let h = parseInt(matchH[1]);
        if (/tarde|noite/.test(textNorm) && h < 12) h += 12;
        horaEscolhida = `${String(h).padStart(2,'0')}:00`;
      } else if (matchAs) {
        let h = parseInt(matchAs[1]);
        if (/tarde|noite/.test(textNorm) && h < 12) h += 12;
        horaEscolhida = `${String(h).padStart(2,'0')}:00`;
      } else if (matchNum) {
        let h = parseInt(matchNum[1]);
        if (/tarde|noite/.test(textNorm) && h < 12) h += 12;
        horaEscolhida = `${String(h).padStart(2,'0')}:00`;
      }

      // Se não souber → aguarda, não sugere horário provisório
      const naoSabe = /nao sei|não sei|qualquer|tanto faz|vc escolhe|voce escolhe|decide voce|sei nao|quando souber|te aviso|depois/.test(textNorm);

      if (!horaEscolhida && !naoSabe) {
        await sendMessage(phone, 'Não entendi o horário 😅 Me diz assim: "10h" ou "14:30", que eu anoto na hora.');
        return true;
      }

      const horaFinal = horaEscolhida || null;
      if (!horaFinal) {
        // Não sabe ainda — mantém a pendência ativa pra quando souber
        await sendMessage(phone, `Tudo bem! Quando souber o horário, me fala que eu anoto "${dados.titulo}" certinho 😊`);
        return true;
      }

      const [h, m] = horaFinal.split(':').map(Number);
      const scheduledAt = new Date(`${dados.data}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00-03:00`);

      const novoLembrete = await prisma.reminder.create({ data: { userId: user.id, phone, message: dados.titulo, scheduledAt } });
      await prisma.memory.delete({ where: { id: pendente.id } });

      if (detectarUrgencia(dados.titulo)) {
        await prisma.memory.create({ data: { userId: user.id, type: 'lembrete_urgente', content: novoLembrete.id } }).catch(() => {});
      }

      const dataFmt = scheduledAt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
      const msgConfirm = `✅ Anotado! "${dados.titulo}" pra ${dataFmt} às ${horaFinal} 📌`;
      await sendMessage(phone, msgConfirm);
      await memory.saveConversationMessage(user.id, 'assistant', msgConfirm).catch(() => {});

      // Sem continuação automática — se o usuário quiser continuar o assunto,
      // ele manda uma mensagem e o freeResponse normal cuida com o contexto
      // do histórico. Mais simples e sem risco de ressuscitar conversa encerrada.
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
      // CORRIGIDO: regex anterior tinha `s` e `n` como opções sem boundary,
      // então "Sobre o cartão..." casa com `s` e "nada disso..." com `n`.
      // \b garante que só palavras completas disparam — "s" sozinho, "sim", etc.
      const sim = /^(sim|claro|pode|quero|yes|ok|manda|ativa|coloca)\b|^s$/.test(textNorm);
      const nao = /^(n[aã]o|nao|n[aã]o precisa|dispenso|deixa|ta bom|tá bom)\b|^n$/.test(textNorm);
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
    for (const { chave, valor, categoria, duracao, deletar, chave_errada } of infos) {
      // Item de deleção: corrige atribuição errada removendo a entrada incorreta
      if (deletar && chave_errada) {
        const erradas = await prisma.memory.findMany({
          where: { userId, type: 'info_pessoal' }
        }).catch(() => []);
        for (const e of erradas) {
          let meta = {}; try { meta = JSON.parse(e.metadata || '{}'); } catch {}
          if ((meta.chave || '').toLowerCase().includes(chave_errada.toLowerCase())) {
            await prisma.memory.delete({ where: { id: e.id } }).catch(() => {});
            console.log(`[memória] CORRIGIDA: deletada entrada errada "${meta.chave}"`);
          }
        }
        continue;
      }
      if (!chave || !valor) continue;
      await savePersonalInfo(userId, chave, valor, categoria || 'outro', duracao || 'permanente');
      console.log(`[memória pessoal] salvo: ${chave} = "${valor}" (${duracao || 'permanente'})`);
    }
  }

  // ── Ponte "depois te conto" ──────────────────────────────────────────
  // Se o usuário prometeu contar algo depois, vira pendência de PRIORIDADE
  // ALTA (o memory.js dá 5 dias de vida e coloca sempre em primeiro na fila
  // da proativa da noite). É o assunto que ele mesmo prometeu — a Clara puxa
  // 1x/dia presumindo o melhor, sem cobrar. Detecção simples por regex; o
  // assunto exato é o que veio antes/depois da promessa na própria frase.
  try {
    const REGEX_DEPOIS_CONTO = /\b(depois (eu )?te conto|te conto (depois|mais tarde|logo)|te falo (depois|mais tarde|logo)|logo (eu )?te conto|(depois|mais tarde) (eu )?te falo|te explico depois|amanh[ãa] te conto)\b/i;
    if (REGEX_DEPOIS_CONTO.test(text)) {
      await memory.salvarOuAtualizarPendencia(userId, {
        assunto: 'algo que ele prometeu te contar',
        contexto: `Ele disse que ia te contar algo depois: "${text.slice(0, 150)}"`,
        como_retomar: 'puxe com leveza, presumindo o melhor — "ontem você ia me contar uma coisa, né? 👀", sem cobrar',
        prioridade: 'alta',
        origem: 'depois_te_conto'
      }).catch(() => {});
      console.log(`[depois te conto] pendência ALTA criada para ${userId}`);
    }
  } catch (eConto) {
    console.error('[depois te conto] erro:', eConto.message);
  }

  // ── Memória episódica: eventos concretos da vida do usuário ──────────
  // Ex: consulta médica, festa da filha, viagem — para acompanhar depois
  try {
    const episodio = await extractEpisodio(text);
    if (episodio) {
      const checkInAt = new Date(Date.now() + episodio.acompanharEmDias * 24 * 60 * 60 * 1000);
      await prisma.memory.create({
        data: {
          userId,
          type: 'episodio_vida',
          content: episodio.titulo,
          metadata: JSON.stringify({
            tipo: episodio.tipo,
            resultado: episodio.resultado,
            checkInAt: checkInAt.toISOString(),
            perguntado: false
          })
        }
      }).catch(() => {});
      console.log(`[Episódio] Salvo: "${episodio.titulo}" — acompanhar em ${episodio.acompanharEmDias}d`);
    }
  } catch (e) {
    console.error('[extractEpisodio]', e.message);
  }
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
