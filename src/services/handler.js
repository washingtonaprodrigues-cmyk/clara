// v2 - consulta direta sem LLM
// Sessao 11 (25/06/2026): multiplas_tarefas, acao confirmada no contexto,
// timezone no contexto, classify com exemplos de horario quebrado, anti-loop apelido.
const { classify, detectarGeneroPorNome, extractPersonalInfo, extractPendenciaEmocional, extractEpisodio, checkResolucaoPendencia, searchWeb, freeResponse, generateMemorySummary, generateRelationshipSummary, ativarModoComparacao, desativarModoComparacao, emModoComparacao, detectarComandoComparacao, detectarComandoIronia, detectarAssuntoEmAberto, infoDatas, isRespostaFallback, extrairQueryBusca, buildPersonality, apararRespostaCortada, detectarPadraoReacao, filtrarResposta } = require('./groq');
const { geminiFreeResponse, geminiDisponivel, todosModelosEsgotados, geminiGerarImagem, geminiGerarSelfie, gerarPromptSelfieDetalhado } = require('./gemini');
const fs = require('fs');
const path = require('path');

// ── Foto de referência da Clara (pessoa sintética, gerada por IA — não
// existe de verdade) ── usada como âncora visual pra manter o mesmo
// rosto/estilo em toda selfie que ela gerar de si mesma, e também pro
// reconhecimento visual (webhook.js). Carregada uma vez e cacheada.
let _claraReferenciaBase64 = null;
let _claraReferenciaTentouCarregar = false;
function getClaraReferenciaBase64() {
  if (_claraReferenciaBase64) return _claraReferenciaBase64;
  if (_claraReferenciaTentouCarregar) return null;
  _claraReferenciaTentouCarregar = true;
  try {
    const caminho = path.join(__dirname, '..', '..', 'public', 'clara-referencia.jpeg');
    _claraReferenciaBase64 = fs.readFileSync(caminho).toString('base64');
    console.log('[ClaraReferencia] Foto de referência carregada com sucesso');
    return _claraReferenciaBase64;
  } catch (e) {
    console.error('[ClaraReferencia] Não encontrou public/clara-referencia.jpeg — selfies vão cair no gerador genérico:', e.message);
    return null;
  }
}


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

async function sendImageMsg(phone, base64Image, caption = '', mimeType = 'image/png') {
  const w = getWhatsapp();
  if (w && typeof w.sendImage === 'function') {
    return w.sendImage(phone, base64Image, caption, mimeType);
  }
  const axios = require('axios');
  const BASE_URL = process.env.UAZAPI_URL || 'https://claravirtual.uazapi.com';
  const TOKEN = process.env.UAZAPI_TOKEN;
  console.log(`[Handler/Fallback] Enviando imagem direto para ${phone}`);
  const dataUri = `data:${mimeType};base64,${base64Image}`;
  return axios.post(`${BASE_URL}/send/media`,
    { number: phone, type: 'image', file: dataUri, text: caption },
    { headers: { token: TOKEN, 'Content-Type': 'application/json' }, timeout: 30000 }
  );
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

// ── Retry automático em falha de conexão (mesma lógica de memory.js) ──
prisma.$use(async (params, next) => {
  const MAX_TENTATIVAS = 3;
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    try {
      return await next(params);
    } catch (e) {
      const ehErroConexao = e?.code === 'P1001' || /can't reach database server/i.test(e?.message || '');
      if (!ehErroConexao || tentativa >= MAX_TENTATIVAS) throw e;
      const espera = 300 * tentativa;
      console.warn(`[Prisma] Conexão falhou (tentativa ${tentativa}/${MAX_TENTATIVAS}), retry em ${espera}ms — ${params.model}.${params.action}`);
      await new Promise(r => setTimeout(r, espera));
    }
  }
});

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

// Marca o bom_dia_lock se estiver na janela da manhã (5h-11h) — usada em
// QUALQUER ponto de interação real com o usuário (não só conversa livre):
// confirmar remédio, responder saudação, etc. Qualquer interação de manhã
// já é sinal de que ela sabe que o usuário acordou — sem isso em todos os
// pontos de entrada, o cron automático de bom dia (reminders.js) não sabia
// que vocês já tinham "se falado" e mandava um bom dia duplicado depois.
async function marcarBomDiaSeManha(userId) {
  try {
    const horaBRTagora = nowBRT().getHours();
    if (horaBRTagora < 5 || horaBRTagora >= 11) return;
    const hojeStr = dateBRT();
    const lockJaExiste = await prisma.memory.findFirst({
      where: { userId, type: 'bom_dia_lock', content: hojeStr }
    }).catch(() => null);
    if (!lockJaExiste) {
      await prisma.memory.create({
        data: { userId, type: 'bom_dia_lock', content: hojeStr }
      }).catch(() => {});
    }
  } catch {}
}

// Gênero confiável do usuário: prioriza a resposta EXPLÍCITA que ele deu
// quando perguntado (salva permanentemente em info_pessoal) — só cai pro
// palpite por nome (detectarGeneroPorNome, lista fixa no código) quando
// ainda não existe resposta explícita. Sem essa priorização, o sistema
// nunca funcionaria bem pra usuários futuros com nomes fora da lista fixa
// — cada ponto do código que precisa saber o gênero deve usar ESTA função,
// nunca detectarGeneroPorNome diretamente.
async function getGeneroConfiavel(userId, nomeFallback) {
  const explicito = await memory.getGeneroExplicito(userId).catch(() => null);
  if (explicito) return explicito;
  return detectarGeneroPorNome(nomeFallback);
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

// Gera o aviso de "deixa eu checar" NA VOZ da Clara — nada de mensagem fixa
// genérica. Usa o apelido real guardado na memória afetiva (ex: "fedo"),
// nunca um fallback hardcoded. Se a geração por IA falhar, cai em frases
// fixas COM personalidade, ainda assim usando o apelido quando disponível.
async function gerarAvisoBusca(text, tom = 'leve', apelido = '') {
  const n = apelido || '';
  const por_tom = {
    leve: n ? [
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
  const opcoes = por_tom[tom] || por_tom.leve;
  return opcoes[Math.floor(Math.random() * opcoes.length)];
}

async function responderLivre(user, phone, text, contextoExtra = '', skipContext = false, acaoConfirmacao = null, confirmacaoSeparada = null) {
  try {
    const history = await memory.getConversationHistory(user.id, 16);
    const preferences = await memory.getUserPreference(user.id);
    preferences._phone = phone;

    // Detecta o gênero ANTES do nome ser substituído pelo apelido logo
    // abaixo — crítico: buildPersonality tenta detectar gênero pelo texto
    // que recebe como "name", mas se isso já virou "fedo" (apelido), a
    // detecção por nome falha silenciosamente e ela pode errar a
    // concordância (ex: chamar o usuário de "senhora"). Prioriza a
    // resposta explícita salva na memória (funciona pra qualquer usuário,
    // não só nomes numa lista fixa) — só cai pro nome como último recurso.
    const generoUsuario = await getGeneroConfiavel(user.id, preferences.name);

    // Usa o apelido carinhoso (ex: "fedo") em vez do nome real sempre que
    // existir — sem isso, freeResponse/buildPersonality recebem só o nome
    // cadastrado (Washington) e a Clara depende só do histórico/memória do
    // relacionamento pra "lembrar" de te chamar do jeito carinhoso, o que é
    // inconsistente. Isso restaura o apelido em TODA resposta, não só em
    // pontos isolados.
    const memAfetivaGeral = await memory.getMemoriaAfetiva(user.id).catch(() => ({}));
    if (memAfetivaGeral?.apelido_usuario) preferences.name = memAfetivaGeral.apelido_usuario;

    if (acaoConfirmacao) preferences._acaoConfirmacao = acaoConfirmacao;
    if (confirmacaoSeparada) {
      preferences._confirmacaoSeparada = confirmacaoSeparada;
      // A IA não recebe a confirmação pra despejar (isso vai na 2ª mensagem),
      // mas precisa saber que o lembrete FOI criado, pra responder coerente
      // (comentar/brincar) sem dizer que vai anotar no futuro nem repetir
      // título/hora — isso já vem logo depois, cru.
      preferences._dicaAcao = 'O lembrete que o usuário pediu JÁ foi anotado com sucesso (a confirmação detalhada será enviada logo após sua mensagem). Responda de forma natural e no seu tom — pode comentar, brincar, reagir — mas NÃO repita o título nem o horário, e NÃO diga que "vai anotar" (já está feito).';
    }

    if (skipContext) {
      preferences._contexto = '';
      // Marca o bom_dia_lock — esse caminho só roda quando o classify já
      // identificou a mensagem como saudação (qualquer tipo). Qualquer
      // saudação de manhã já é sinal de que vocês estão conversando.
      await marcarBomDiaSeManha(user.id);
      const resp = await freeResponse(text, history, preferences);
      if (resp === null) return;
      if (resp && resp.includes('__BUSCAR:')) {
        const memAfSC = await memory.getMemoriaAfetiva(user.id).catch(() => ({}));
        const avSC = await gerarAvisoBusca(text, preferences?.tom || 'leve', memAfSC?.apelido_usuario || preferences?.name || '');
        await sendMessage(phone, avSC);
        return;
      }
      // Detecta selfie mesmo no caminho skipContext — sem isso, pedidos de
      // foto classificados como saudação nunca chegavam no bloco de detecção
      // principal (linha ~996), pois o return abaixo corta o caminho antes.
      if (resp && /[*_]{0,2}GERAR_SELFIE(?::[^*_\n]*)?[*_]{0,2}/i.test(resp)) {
        const selfieMatchSC = resp.match(/[*_]{0,2}GERAR_SELFIE(?::[^*_\n]*)?[*_]{0,2}/i);
        const respSemTagSC = resp.replace(selfieMatchSC[0], '').trim();
        const memAfSelfie = await memory.getMemoriaAfetiva(user.id).catch(() => ({}));
        const apelidoSelfie = memAfSelfie?.apelido_usuario || preferences?.name || '';
        const falaNatural = respSemTagSC.length > 3 ? respSemTagSC
          : (apelidoSelfie ? `Pera, deixa eu tirar uma foto pra te mandar, ${apelidoSelfie}! 📸` : `Pera, deixa eu tirar uma foto pra te mandar! 📸`);
        await sendMessage(phone, falaNatural);
        await memory.saveConversationMessage(user.id, 'user', text).catch(() => {});
        await memory.saveConversationMessage(user.id, 'assistant', falaNatural).catch(() => {});
        try {
          const wTypingSC = getWhatsapp();
          if (wTypingSC && typeof wTypingSC.sendTyping === 'function') wTypingSC.sendTyping(phone, 8000).catch(() => {});
          const contextoParaPromptSC = `Usuário disse: "${text}"\nClara respondeu: "${falaNatural}"`;
          const cenaTecnicaSC = await gerarPromptSelfieDetalhado(contextoParaPromptSC);
          const referenciaSC = getClaraReferenciaBase64();
          const selfieSC = referenciaSC
            ? await geminiGerarSelfie(cenaTecnicaSC, referenciaSC, 'image/jpeg')
            : await geminiGerarImagem(cenaTecnicaSC);
          await sendImageMsg(phone, selfieSC.base64, '', selfieSC.mimeType);
          await memory.saveConversationMessage(user.id, 'assistant', `Te mandei uma selfie minha 📸`).catch(() => {});
        } catch (eSC) { console.error('[GerarSelfie/skipContext] Erro:', eSC.message); }
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
        buildPersonalContext(user.id, text || '').catch(() => ''),
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
      const txtLow = (text||'').toLowerCase();
      const falaDeAgenda = /hoje|amanhã|horário|quando|agenda|compromisso|reunião|consulta|médico|dentista|semana|mês/.test(txtLow);
      const falaDeRemedio = /remédio|comprimido|tomar|dose|farmácia|medicamento|triglicere|toroide|holmis|landizin/.test(txtLow);
      const faladeDinheiro = /dinheiro|gasto|gastei|saldo|orçamento|conta|pagar|pagamento|real|reais|r\$/.test(txtLow);
      const falaDeLista = /lista|mercado|compras|item|comprar/.test(txtLow);
      const ehManha = now.getHours() >= 6 && now.getHours() < 11;

      if (lembretes.length > 0) {
        const fmtLemb = (r) => {
          const d = new Date(r.scheduledAt);
          const dStr = toDateStr(d) === hoje ? 'Hoje' : 'Amanhã';
          const horaBRT = d.toLocaleTimeString('pt-BR', {timeZone:'America/Sao_Paulo', hour:'2-digit', minute:'2-digit'});
          return `• ${dStr} às ${horaBRT} — ${r.message}`;
        };
        // Filtra: só mostra lembretes dentro de 40 min no contexto automático
        // Lembretes distantes só entram se o usuário perguntar sobre agenda
        const agora = nowBRT();
        const lembretesProximos = lembretes.filter(r => {
          const diffMin = (new Date(r.scheduledAt).getTime() - agora.getTime()) / 60000;
          return diffMin >= -5 && diffMin <= 40; // janela: até 5 min atrás até 40 min à frente
        });
        if (falaDeAgenda && lembretes.length > 0) {
          // Usuário perguntou sobre agenda → mostra tudo
          contexto += `\n\n[AGENDA — mencione SOMENTE se o usuário trouxer o assunto ou perguntar. Nunca puxe por iniciativa em conversa sobre outro assunto]\n${lembretes.map(fmtLemb).join('\n')}`;
        } else if (lembretesProximos.length > 0) {
          // Lembrete próximo (< 40 min) → injeta só esse, como toque de passagem
          contexto += `\n\n[LEMBRETE PRÓXIMO — pode mencionar de passagem UMA VEZ se natural, não force]\n${lembretesProximos.map(fmtLemb).join('\n')}`;
        }
        // Lembretes distantes sem pergunta de agenda = invisíveis no contexto
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

      // Medicamentos — FORA do contexto conversacional
      // O alerta dedicado (cron) cuida do horário e da dose.
      // Clara só menciona se o usuário trouxer o assunto de remédio/saúde.
      if (meds.length > 0 && falaDeRemedio) {
        const fmtMed = (m) => {
          let times = []; try { times = JSON.parse(m.times || '[]'); } catch {}
          const proxima = times.find(t => t >= hm) || times[0] || '—';
          return `• ${m.name} — próxima dose: ${proxima}, ${m.remaining} doses restantes`;
        };
        contexto += `\n\n[MEDICAMENTOS — usuário trouxe o assunto]\n${meds.map(fmtMed).join('\n')}`;
      }

      // Financeiro — só injeta se falar de dinheiro
      if (preferences.saldo != null && faladeDinheiro) {
        const saidas = gastos.filter(g => g.value > 0);
        const entradas = gastos.filter(g => g.value < 0);
        const totalGasto = saidas.reduce((a, g) => a + g.value, 0);
        const totalEntradas = entradas.reduce((a, g) => a + Math.abs(g.value), 0);
        const restante = preferences.saldo - totalGasto + totalEntradas;
        contexto += `\n\n[FINANCEIRO]\nOrçamento: R$ ${preferences.saldo.toFixed(2)}\nGasto: R$ ${totalGasto.toFixed(2)}\nEntradas: R$ ${totalEntradas.toFixed(2)}\nSaldo: R$ ${restante.toFixed(2)}`;
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
      // Eventos concretos que aconteceram ou vão acontecer — informa o
      // contexto de vida sem sobrecarregar (máx 3, pendentes primeiro)
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
          const RECENTE_MS   = 2 * 24 * 60 * 60 * 1000; // 0-2 dias: sempre mostra
          const RESOLVIDO_MS = 2 * 24 * 60 * 60 * 1000; // resolvido: mostra por 2 dias pra ela comentar

          const filtradosEp = episodios.filter(e => {
            let meta = {}; try { meta = JSON.parse(e.metadata || '{}'); } catch {}
            const idade = agora - new Date(e.createdAt).getTime();
            const pendente = meta.resultado === 'pendente';

            // Resolvido explicitamente pelo sistema → some imediatamente
            if (meta.resolvidoEm) return false;

            // Muito recente (< 2 dias): sempre mostra
            if (idade < RECENTE_MS) return true;

            // Resolvido (positivo/negativo): mostra por 2 dias pra ela poder comentar
            if (!pendente) return idade < RESOLVIDO_MS;

            // Pendente com prazo: só mostra quando o prazo chegou
            if (meta.acompanhar_em_dias) {
              const baseCheck = meta.next_check_at
                ? new Date(meta.next_check_at).getTime()
                : new Date(e.createdAt).getTime() + (meta.acompanhar_em_dias * 24 * 60 * 60 * 1000);
              return agora >= baseCheck;
            }

            // Pendente sem prazo: mostra por até 5 dias
            return idade < 5 * 24 * 60 * 60 * 1000;
          }).slice(0, 3);

          if (filtradosEp.length > 0) {
            const formatarIdadeEp = (createdAt) => {
              const dias = Math.floor((agora - new Date(createdAt).getTime()) / (24 * 60 * 60 * 1000));
              if (dias <= 0) return 'hoje';
              if (dias === 1) return 'ontem';
              return `há ${dias} dias`;
            };
            const listaEp = filtradosEp.map(e => {
              let meta = {}; try { meta = JSON.parse(e.metadata || '{}'); } catch {}
              return `• (mencionado ${formatarIdadeEp(e.createdAt)}) ${e.content}${meta.resultado === 'pendente' ? ' (ainda vai acontecer ou não atualizou)' : ''}`;
            }).join('\n');
            contexto += `\n\n[CONTEXTO DE VIDA RECENTE — use naturalmente se relevante, nunca force. NUNCA trate algo mencionado "ontem" ou "há dias" como se tivesse acabado de acontecer agora]\n${listaEp}`;
          }
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
          // Saúde geral: só mostra se recente (< 48h) — evita dado stale de dias atrás
          const criadoEm = pendenciaSaude.criadoEm ? new Date(pendenciaSaude.criadoEm) : null;
          const horasAtras = criadoEm ? (Date.now() - criadoEm.getTime()) / (60 * 60 * 1000) : 999;
          mostrarPendenciaSaude = horasAtras < 48;
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
      contexto += `\n\n[HORA ATUAL] Agora são ${horaBRTfmt} (Brasília), período: ${periodoDia}. Use isso pra saudar corretamente — não diga "bom dia" à tarde nem "hora do almoço" de manhã.`;

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
            if (!conversaAnteriorHoje && !jaCumprimentou) {
              contexto += `\n\n[BOM DIA — IMPORTANTE] Esta é a PRIMEIRA mensagem do usuário hoje e ele NÃO te deu bom dia — foi direto ao assunto. Antes (ou junto) de responder o que ele pediu, EMENDE um bom dia SEU no SEU tom atual, de forma natural e curta. Exemplos conforme o tom: se for sarcástica/sem filtro, algo como "bom dia primeiro, né, grosso 🙄" ou "nem um oi, mas tá bom kk bom dia"; se for carinhosa/simpática, algo como "hummm acordou cedinho! bom dia, fedo 💜" ou "bom dia! 😊". Se souber algo do dia anterior ou do estado dele pela memória, pode puxar com humanidade ("dormiu bem?", "como você tá hoje?", "melhorou de ontem?"). NÃO seja robótica nem repita a mesma frase de sempre — varie. Depois disso, responda normalmente o que ele pediu.`;
              // Marca o lock agora pra o cron não duplicar (ela vai cumprimentar nesta resposta)
              await prisma.memory.create({
                data: { userId: user.id, type: 'bom_dia_lock', content: hojeStr }
              }).catch(() => {});
            } else if (jaCumprimentou && !conversaAnteriorHoje) {
              // Usuário já deu bom dia primeiro — ela responde no clima, mas
              // marcamos o lock mesmo assim pra o cron não mandar um bom dia
              // redundante depois.
              await prisma.memory.create({
                data: { userId: user.id, type: 'bom_dia_lock', content: hojeStr }
              }).catch(() => {});
            }
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

      // ── Noção de tempo real entre mensagens ────────────────────────────
      // O histórico só tem texto, sem timestamp — sem isso a IA podia tratar
      // um plano futuro ("vou almoçar", "te chamo daqui a pouco", "domingo
      // vou lá") como se já tivesse acontecido, só porque fazia sentido no
      // texto. Aqui a gente dá a ela o tempo real desde a última troca.
      const gapTempo = await memory.getGapUltimaMensagem(user.id).catch(() => null);
      if (gapTempo) {
        contexto += `\n\n[NOÇÃO DE TEMPO — IMPORTANTE] A última troca de mensagens foi há ${gapTempo}. Use isso pra calibrar se algo mencionado (almoço, chegar em algum lugar, ligar, sair, dormir etc) já teve tempo real de acontecer — se o tempo foi curto, trate como ainda por vir, NUNCA pergunte "e aí, como foi?" sobre algo que não teve tempo de rolar. Da mesma forma, se um plano foi combinado pra uma data ou horário específico no futuro (ex: "domingo", "às 12:40", "mais tarde"), trate como algo que AINDA VAI acontecer até esse momento chegar de verdade — nunca antecipe como se já tivesse passado.`;
      }

      // ── Sugestão de chamada inteligente ─────────────────────────────────
      // Só sugere quando existe PADRÃO REAL: conversaram nesse mesmo
      // horário (almoço/noite) em 3+ dias SEGUIDOS. Sem esse padrão, ela
      // nunca sugere — só age se o usuário pedir explicitamente (chamada
      // combinada normal). Gatilho: um assunto ficou em aberto na conversa
      // recente (últimas 3h) e ainda dá tempo de perguntar antes do
      // próximo período (manhã→pergunta sobre almoço, tarde→sobre noite).
      try {
        const horaAgora = now.getHours();
        const periodoAlvo = (horaAgora >= 8 && horaAgora < 11) ? 'almoco'
                          : (horaAgora >= 13 && horaAgora < 18) ? 'noite'
                          : null;
        if (periodoAlvo) {
          const pendenciasAtuais = await memory.getPendenciasAbertas(user.id).catch(() => []);
          // Só considera pendência bem recente — representa um assunto que
          // ficou em aberto NESTA conversa, não um assunto antigo qualquer.
          const pendenciaRecente = pendenciasAtuais.find(p => (Date.now() - new Date(p.criadoEm).getTime()) < 3 * 60 * 60 * 1000);
          if (pendenciaRecente) {
            const lockKeySugestao = `${dateBRT()}_${periodoAlvo}_${pendenciaRecente.id}`;
            const jaSugeriuHoje = await prisma.memory.findFirst({
              where: { userId: user.id, type: 'sugestao_chamada_lock', content: lockKeySugestao }
            }).catch(() => null);
            if (!jaSugeriuHoje) {
              const padraoExiste = await memory.getJanelaConversaConsecutiva(user.id, periodoAlvo, 3);
              if (padraoExiste) {
                const horaSugerida = periodoAlvo === 'almoco' ? '12:30' : '20:30';
                contexto += `\n\n[SUGESTÃO DE CHAMADA — OPCIONAL, só se soar natural] Vocês costumam conversar n${periodoAlvo === 'almoco' ? 'o horário de almoço' : 'o período da noite'} há pelo menos 3 dias seguidos. Ficou um assunto em aberto agora: "${pendenciaRecente.assunto}". Se o papo estiver mesmo encerrando, pergunte de forma leve se pode te chamar ${periodoAlvo === 'almoco' ? 'no almoço' : 'à noite'} pra continuar isso — nunca force, e se ele disser não, aceite tranquila sem insistir. NUNCA chame sem essa autorização.`;
                await prisma.memory.create({ data: { userId: user.id, type: 'sugestao_chamada_lock', content: lockKeySugestao } }).catch(() => {});
                await prisma.memory.create({
                  data: { userId: user.id, type: 'confirmacao_pendente', content: JSON.stringify({
                    tipo: 'sugestao_chamada', periodo: periodoAlvo, hora: horaSugerida, assunto: pendenciaRecente.assunto,
                    expira: Date.now() + 3 * 60 * 60 * 1000
                  }) }
                }).catch(() => {});
              }
            }
          }
        }
      } catch (eSugestao) { console.error(`[${phone}] Erro sugestão chamada:`, eSugestao.message); }

      // ── Reforço explícito de gênero ──────────────────────────────────
      // Sempre presente, independente do que "name" virar (apelido, nome
      // real) — a detecção interna do buildPersonality só funciona com
      // nome real, então isso é o que garante a concordância certa mesmo
      // quando ela está usando o apelido pra se dirigir a ele.
      if (generoUsuario === 'M') {
        contexto += `\n\n[GÊNERO — IMPORTANTE] O usuário é HOMEM. Concorde sempre no masculino ao falar dele (ex: "querido", "lindo", "seguro"), nunca no feminino (nunca "senhora", "querida", "linda"). Você (Clara) é MULHER — concorde sempre no feminino ao falar de si mesma (ex: "segura", "apaixonada", "safada"), nunca no masculino (nunca "seguro", "apaixonado", "safado"). Preste atenção especial nisso em brincadeiras, hipóteses e apelidos.`;
      } else if (generoUsuario === 'F') {
        contexto += `\n\n[GÊNERO — IMPORTANTE] O usuário é MULHER. Concorde sempre no feminino ao falar dela, nunca no masculino. Você (Clara) é MULHER — concorde sempre no feminino ao falar de si mesma.`;
      }

      // ── Nível de ironia (teste temporário) ──────────────────────────
      try {
        const nivelIronia = await prisma.memory.findFirst({ where: { userId: user.id, type: 'ironia_nivel' } }).catch(() => null);
        if (nivelIronia?.content === 'mais') {
          contexto += `\n\n[TESTE TEMPORÁRIO DE IRONIA — pedido explícito do usuário, vale só até ele desligar] Aumente a ironia/zoeira por enquanto — pode ser mais ácida, debochada, menos filtro, brinca mais inclusive em momentos mais sérios. É um teste que ele mesmo pediu.`;
        } else if (nivelIronia?.content === 'menos') {
          contexto += `\n\n[TESTE TEMPORÁRIO DE IRONIA — pedido explícito do usuário, vale só até ele desligar] Diminua a ironia/deboche por enquanto — mais colo, mais suave, menos brincadeira ácida, mais acolhimento direto. É um teste que ele mesmo pediu.`;
        }
      } catch {}

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
      // Segunda camada de proteção — não deveria mais acontecer com o fix
      // do filtrarResposta (que evita zerar a resposta inteira), mas se
      // acontecer por qualquer outro motivo, nunca fica muda em silêncio.
      console.warn(`[${phone}] respStr vazio depois de freeResponse — mandando fallback em vez de ficar muda`);
      await sendMessage(phone, 'Opa, me perdi aqui por um segundo 😅 pode repetir?');
      return;
    }

    // ── Busca proativa: Clara sinalizou que quer pesquisar ──
    const buscaMatch = respStr.match(/[*_]{0,2}BUSCAR:(.+?)(?:[*_]{0,2}|\n|$)/i);
    if (buscaMatch) {
      const query = buscaMatch[1].trim();
      // Avisa que vai pesquisar, no estilo da Clara — com o apelido real
      const tom = preferences?.tom || 'leve';
      const memAfetivaBusca = await memory.getMemoriaAfetiva(user.id).catch(() => ({}));
      const apelidoBusca = memAfetivaBusca?.apelido_usuario || preferences?.name || '';
      const aviso = await gerarAvisoBusca(text, tom, apelidoBusca);
      await sendMessage(phone, aviso);

      try {
        const cidadeBusca = await memory.getCidadeAtual(user.id).catch(() => '');
        const resultado = await searchWeb(query, cidadeBusca, apelidoBusca, tom);
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

    // ── Geração de imagem genérica: Clara sinalizou que vai desenhar algo ──
    // Aqui ela mesma escreve a descrição em inglês (faz sentido pra imagem
    // externa qualquer, não uma selfie dela — não depende da aparência fixa
    // dela nem do contexto de atividade).
    const imagemMatch = respStr.match(/[*_]{0,2}GERAR_IMAGEM:(.+?)(?:[*_]{0,2}|\n|$)/i);
    if (imagemMatch) {
      const promptImagem = imagemMatch[1].trim();
      const tomImg = preferences?.tom || 'leve';
      const memAfetivaImg = await memory.getMemoriaAfetiva(user.id).catch(() => ({}));
      const apelidoImg = memAfetivaImg?.apelido_usuario || preferences?.name || '';
      const avisoImg = apelidoImg
        ? `Pera aí que já faço isso pra você, ${apelidoImg}! 🎨`
        : `Pera aí que já faço isso! 🎨`;
      await sendMessage(phone, avisoImg);

      try {
        const imagem = await geminiGerarImagem(promptImagem);
        await sendImageMsg(phone, imagem.base64, '', imagem.mimeType);
        await memory.saveConversationMessage(user.id, 'user', text).catch(() => {});
        await memory.saveConversationMessage(user.id, 'assistant', `Te mandei uma imagem que criei 🎨`).catch(() => {});
      } catch (eImg) {
        console.error(`[GerarImagem] Erro:`, eImg.message);
        await sendMessage(phone, `Ih, não consegui gerar essa imagem agora 😕 ${tomImg === 'sarcastico' ? 'Nem eu sou perfeita.' : 'Tenta de novo daqui a pouco?'}`);
      }
      return;
    }

    // ── Selfie da Clara — arquitetura de duas etapas ──────────────────
    // 1) A resposta NATURAL dela (respStrSemTag) já foi gerada pela IA
    //    normalmente, sem nenhuma descrição técnica — ela só sinaliza com
    //    a tag simples __GERAR_SELFIE__, igual uma pessoa real que "tira"
    //    uma foto sem descrever tecnicamente o que está fazendo.
    // 2) O prompt técnico em inglês é montado SEPARADO, nos bastidores,
    //    usando o contexto real da conversa + a descrição física fixa
    //    dela (gerarPromptSelfieDetalhado, em gemini.js) — nunca a mesma
    //    chamada que gera a fala dela.
    const selfieMatch = respStr.match(/[*_]{0,2}GERAR_SELFIE(?::[^*_\n]*)?[*_]{0,2}/i);
    if (selfieMatch) {
      const respStrSemTag = respStr.replace(selfieMatch[0], '').trim();
      const tomSelfie = preferences?.tom || 'leve';
      const memAfetivaSelfie = await memory.getMemoriaAfetiva(user.id).catch(() => ({}));
      const apelidoSelfie = memAfetivaSelfie?.apelido_usuario || preferences?.name || '';

      // Manda a fala natural dela primeiro (se sobrou algo depois de tirar a tag)
      const falaNatural = respStrSemTag.length > 3
        ? respStrSemTag
        : (apelidoSelfie ? `Pera, deixa eu tirar uma foto pra te mandar, ${apelidoSelfie}! 📸` : `Pera, deixa eu tirar uma foto pra te mandar! 📸`);
      await sendMessage(phone, falaNatural);
      await memory.saveConversationMessage(user.id, 'user', text).catch(() => {});
      await memory.saveConversationMessage(user.id, 'assistant', falaNatural).catch(() => {});

      try {
        // Mostra "digitando..." enquanto gera a foto — evita a sensação de
        // silêncio/travamento durante a parte demorada do processo.
        const wTyping = getWhatsapp();
        if (wTyping && typeof wTyping.sendTyping === 'function') {
          wTyping.sendTyping(phone, 8000).catch(() => {});
        }
        // Contexto pra montar o prompt técnico: a fala dela + a mensagem do usuário
        const contextoParaPrompt = `Usuário disse: "${text}"\nClara respondeu: "${falaNatural}"`;
        const cenaTecnica = await gerarPromptSelfieDetalhado(contextoParaPrompt);
        const referencia = getClaraReferenciaBase64();
        const selfie = referencia
          ? await geminiGerarSelfie(cenaTecnica, referencia, 'image/jpeg')
          : await geminiGerarImagem(cenaTecnica);
        await sendImageMsg(phone, selfie.base64, '', selfie.mimeType);
        await memory.saveConversationMessage(user.id, 'assistant', `Te mandei uma selfie minha 📸`).catch(() => {});
      } catch (eSelfie) {
        console.error(`[GerarSelfie] Erro:`, eSelfie.message);
        await sendMessage(phone, `Ih, não consegui tirar a foto agora 😕 ${tomSelfie === 'sarcastico' ? 'Nem toda hora tô fotogênica.' : 'Tenta de novo daqui a pouco?'}`);
      }
      return;
    }

    await memory.saveConversationMessage(user.id, 'user', text);
    await memory.saveConversationMessage(user.id, 'assistant', respStr);
    await sendMessage(phone, respStr);

    // ── Detecção de promessa de busca não executada ───────────────────
    // Restrito ao final da resposta (~40 chars) — mesmo motivo do fix em
    // imagem/selfie: evita disparar busca de verdade toda vez que ela usa
    // uma frase parecida em conversa casual, sem pedido real de busca.
    const prometeuBuscar = /peraí que vou ver|deixa eu (dar uma olhada|pesquisar|verificar|checar|buscar)|vou (pesquisar|buscar|dar uma olhada|verificar)|deixa eu ver|um segundo que|rapidinho aqui/i.test(respStr.trim().slice(-40));
    if (prometeuBuscar && !buscaMatch) {
      // Tenta extrair query do texto do usuário (mais relevante que da resposta da IA)
      const queryBusca = text.trim();
      ;(async () => {
        try {
          await new Promise(r => setTimeout(r, 1500));
          const memAfetivaProm = await memory.getMemoriaAfetiva(user.id).catch(() => ({}));
          const apelidoProm = memAfetivaProm?.apelido_usuario || preferences?.name || '';
          const cidadeProm = await memory.getCidadeAtual(user.id).catch(() => '');
          const resultado = await searchWeb(queryBusca, cidadeProm, apelidoProm, preferences?.tom || 'leve');
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

    // ── Memória relacional: categoriza e salva o que vale lembrar ──────────
    // PERMANENTE: apelidos novos, brincadeiras internas, quem são juntos
    // ACONTECIMENTO: saúde, trabalho, família — dura 1 ano
    // DESCARTA: lembretes, listas, agenda, operacional sem carga emocional
    ;(async () => {
      try {
        const histMR = await memory.getConversationHistory(user.id, 8).catch(() => []);
        if (histMR.length < 3) return;
        const resumoMR = histMR.slice(-6).map(m =>
          `${m.role === 'user' ? 'Ele' : 'Clara'}: ${(m.content || '').slice(0, 120)}`
        ).join('\n');
        const extracted = await geminiFreeResponse([
          { role: 'user', content: `Conversa (prefixo "Ele:" = o usuário Washington, homem. Prefixo "Clara:" = você mesma, mulher):\n${resumoMR}\n\nO que dessa conversa merece ser lembrado?\n\nATENÇÃO CRÍTICA NA ATRIBUIÇÃO: preste muita atenção em QUEM disse o quê antes de escrever a memória — nunca troque a autoria. Se a Clara falou uma regra ou característica sobre SI MESMA (ex: "eu não posso dizer labuta", "eu não uso essa palavra"), isso é sobre a Clara — NUNCA escreva como se fosse algo que ela proibiu ELE de fazer ou dizer. Se o Ele disse algo sobre si mesmo, é sobre ele, não sobre ela. Também respeite o gênero de cada um: Clara é mulher (adjetivos no feminino ao falar dela), Ele é homem (adjetivos no masculino ao falar dele) — nunca inverta.\n\nPERMANENTE (nunca apaga): novo apelido criado, brincadeira interna nova (incluindo referências a "combinados" hipotéticos/brincalhões tipo "nosso encontro", "nosso date" — mesmo que fictício, isso é o tipo de coisa que define a intimidade da relação e precisa ser lembrado), algo que define quem são juntos, papel de pessoa importante na vida dele (filha Isis, esposa/patroa).\nACONTECIMENTO (1 ano): saúde marcante, trabalho com carga emocional, momento familiar importante, algo emotivamente significativo que aconteceu.\nDESCARTAR: lembrete, lista, gasto, agenda, pão de queijo, qualquer coisa operacional sem peso emocional.\n\nPara cada memória relevante: {"categoria":"permanente|acontecimento","conteudo":"1 frase natural","tags":["tag1","tag2"]}\nResposta APENAS como JSON array. Se nada relevante: []` }
        ], { temperature: 0.1, maxTokens: 200 }).catch(() => null);
        if (!extracted) return;
        const clean = extracted.replace(/```json|```/g, '').trim();
        const itens = JSON.parse(clean.startsWith('[') ? clean : '[]');
        if (!Array.isArray(itens) || itens.length === 0) return;
        for (const item of itens) {
          if (!item?.conteudo || item.categoria === 'descartar') continue;
          await memory.salvarMemoriaRelacional(user.id, item.conteudo, item.categoria, item.tags || []);
        }
      } catch {}
    })();

    // ── Clara Personagem: salva o que ela disse de si mesma ──────────────
    // Quando ela se chama de "fraquinha", inventa que foi ao barzinho com a
    // Bia e Carol, ou faz uma afirmação memorável sobre si — salva pra lembrar
    // quando o assunto voltar. Ela não pode se esquecer do que ela mesma disse.
    ;(async () => {
      try {
        if (!respStr || respStr.length < 30) return;
        // Detecta se ela fez afirmação sobre si mesma (atividade, apelido, qualidade)
        const temAutoReferencia = /\b(tô|tava|sou|me chamo|sou a|me\s+\w+|minha|minhas|aqui eu|aqui a|fraquinha|aqui tô|acabei de|eu que|eu já|eu também|eu adoro|eu odeio|eu gosto|eu sou)\b/i.test(respStr);
        if (!temAutoReferencia) return;
        const extraido = await geminiFreeResponse([
          { role: 'user', content: `Mensagem da Clara: "${respStr.slice(0, 400)}"\n\nSe Clara disse algo MEMORÁVEL sobre si mesma — um apelido que usou ("fraquinha"), algo que inventou sobre sua vida (amiga, lugar, atividade), ou uma afirmação marcante sobre quem ela é — extraia em 1 frase curta. Se não há nada memorável, responda: NADA.` }
        ], { temperature: 0.1, maxTokens: 80 }).catch(() => null);
        if (!extraido || /^NADA/i.test(extraido.trim())) return;
        const conteudo = extraido.trim().slice(0, 150);
        // Verifica se já existe entrada similar para não duplicar
        const existe = await prisma.memory.findFirst({
          where: { userId: user.id, type: 'clara_personagem', content: { contains: conteudo.split(' ').slice(0, 3).join(' ') } }
        }).catch(() => null);
        if (!existe) {
          await prisma.memory.create({ data: {
            userId: user.id, type: 'clara_personagem',
            content: conteudo,
            metadata: JSON.stringify({ data: new Date().toISOString() })
          }}).catch(() => {});
          console.log(`[ClaraPersonagem] "${conteudo.slice(0, 60)}"`);
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

async function handleMessage(phone, text, location = null, quotedText = null) {
  try {
    const user = await memory.getOrCreateUser(phone);

    // Se uma imagem mandada há pouco ainda está sendo analisada, espera
    // terminar antes de continuar — sem isso, uma pergunta de texto logo
    // depois de mandar uma foto ("sabe quem é essa?") podia ser respondida
    // "às cegas", sem saber o que realmente tinha na imagem, porque os dois
    // processamentos rodam em paralelo (webhooks separados).
    try {
      for (let tentativa = 0; tentativa < 16; tentativa++) {
        const lockImagem = await prisma.memory.findFirst({ where: { userId: user.id, type: 'imagem_em_analise' } }).catch(() => null);
        if (!lockImagem) break;
        const idadeMs = Date.now() - parseInt(lockImagem.content, 10);
        if (idadeMs > 25000) break; // trava velha demais (algo travou) — não espera mais
        await new Promise(r => setTimeout(r, 600));
      }
    } catch {}

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

    // ── Comando de teste: nível de ironia ──────────────────────────────
    const comandoIronia = detectarComandoIronia(text);
    if (comandoIronia) {
      if (comandoIronia === 'reset') {
        await prisma.memory.deleteMany({ where: { userId: user.id, type: 'ironia_nivel' } }).catch(() => {});
        return await sendMessage(phone, '✅ Ironia voltou ao padrão normal.');
      }
      await upsertMemoryPorTipo(user.id, 'ironia_nivel', comandoIronia).catch(() => {});
      const msgConfirma = comandoIronia === 'mais'
        ? '😏 Bora, vou soltar mais o verbo. Diga "volta ironia ao normal" quando quiser desligar o teste.'
        : '😊 Combinado, vou segurar mais a ironia. Diga "volta ironia ao normal" quando quiser desligar o teste.';
      return await sendMessage(phone, msgConfirma);
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


    // Intercepta ANTES do classify: confirmação de remédio via citação.
    // Remédio vive numa tabela separada (Medication), não em Reminder —
    // sem esse intercept, "Feito" citando "💊 Hora do medicamento!" caía
    // na busca de LEMBRETES, nunca achava correspondência real ali, e
    // acabava confirmando por engano outro lembrete pendente qualquer
    // (bug observado: remédio da Toroide virou "Ver sobre a matéria do
    // Jornal" — coisas completamente sem relação).
    // O webhook.js monta `text` como `[Mensagem citada: "..."]\n${texto real
    // do usuário}` quando há citação — sem remover esse prefixo antes de
    // checar se o texto começa com "feito"/"tomei", a checagem nunca batia
    // (o texto real do usuário nunca estava de fato no início da string).
    // Esse foi o bug real por trás do interceptor nunca disparar.
    const textoSemCitacaoMed = text.replace(/^\[Mensagem citada:\s*"[^"]*"\]\s*\n?/i, '').trim();
    if (quotedText && /hora do medicamento|💊/i.test(quotedText) && /^(feito|tomei|pronto|ok|tomado|já tomei|jah tomei)\b/i.test(textoSemCitacaoMed)) {
      const medNomeMatch = quotedText.match(/\*(.+?)\*/);
      const medNomeCitado = medNomeMatch ? medNomeMatch[1].toLowerCase() : null;
      const medicamentosAtivos = await prisma.medication.findMany({ where: { userId: user.id, active: true } }).catch(() => []);
      let medEncontrado = null;
      if (medNomeCitado) {
        medEncontrado = medicamentosAtivos.find(m =>
          m.name.toLowerCase().includes(medNomeCitado) || medNomeCitado.includes(m.name.toLowerCase().split(' ')[0])
        );
      }
      // Fallback: os asteriscos podem não sobreviver na extração da
      // citação do WhatsApp (formatação visual, nem sempre vem no texto
      // bruto) — tenta achar o nome de algum remédio ativo direto no
      // texto citado. Ignora palavras genéricas que vários remédios
      // podem compartilhar (ex: "Remédio de X" e "Remédio da Y" — "remédio",
      // "de", "da" não distinguem nada) e usa a parte distintiva do nome.
      if (!medEncontrado) {
        const quotedLower = quotedText.toLowerCase();
        const PALAVRAS_GENERICAS = new Set(['remédio', 'remedio', 'medicamento', 'de', 'da', 'do', 'das', 'dos', 'e']);
        medEncontrado = medicamentosAtivos.find(m => {
          const palavrasDistintas = m.name.toLowerCase().split(' ').filter(p => p.length > 3 && !PALAVRAS_GENERICAS.has(p));
          return palavrasDistintas.some(p => quotedLower.includes(p));
        });
      }
      if (!medEncontrado && medicamentosAtivos.length === 1) medEncontrado = medicamentosAtivos[0];
      console.log(`[MedIntercept] medicamentosAtivos: [${medicamentosAtivos.map(m => m.name).join(', ')}] | medEncontrado: ${medEncontrado ? medEncontrado.name : 'NENHUM'}`);
      if (medEncontrado) {
        const novoRemaining = Math.max(0, medEncontrado.remaining - 1);
        await prisma.medication.update({ where: { id: medEncontrado.id }, data: { remaining: novoRemaining } });
        await sendMessage(phone, `✅ Tomado! *${medEncontrado.name}* registrado. Restam ${novoRemaining} dose${novoRemaining === 1 ? '' : 's'}. 💊`);
        emitirAtualizacao(phone, 'remedios');
        await marcarBomDiaSeManha(user.id);
        return;
      }
      // Não achou o remédio específico — segue fluxo normal em vez de travar
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
            await sendMessage(phone, `✅ Feito! "${escolhido.message}" concluído.`);
            await marcarBomDiaSeManha(user.id);
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
      const cidade = await (typeof memory.getCidadeAtual === 'function'
        ? memory.getCidadeAtual(user.id)
        : Promise.resolve('')
      ).catch(() => '');
      const preferencesBusca = await memory.getUserPreference(user.id).catch(() => ({}));
      const tomBusca = preferencesBusca?.tom || 'leve';
      const apelidoBusca = (await memory.getMemoriaAfetiva(user.id).catch(() => {}))?.apelido_usuario || preferencesBusca?.name || '';
      const resultadoBusca = await searchWeb(classified.query, cidade, apelidoBusca, tomBusca);
      if (resultadoBusca) {
        await memory.saveConversationMessage(user.id, 'user', text);
        await memory.saveConversationMessage(user.id, 'assistant', resultadoBusca);
        await sendMessage(phone, resultadoBusca);
        extractAndSavePersonalInfo(user.id, text).catch(() => {});

        // Comentário pós-busca: saúde → preocupação, local → oferta de mais, outros → toque se seco
        const respLower = (resultadoBusca || '').toLowerCase();
        const temCalor = /(fedo|meu bem|viu\?|eita|nossa)/i.test(respLower) || /[\u{1F300}-\u{1FAFF}]/u.test(resultadoBusca || '');
        const ehSaude = /(sintoma|saúde|doença|pressão|febre|\bdor\b|remédio|médico|hospital|consulta)/i.test((classified.query || '') + ' ' + text);
        const ehLocal = /(farmácia|farmacia|médico|medico|clínica|clinica|cardiologista|loja|mercado|restaurante|oficina|móveis|moveis)/i.test((classified.query || '') + ' ' + text);
        const ehEspecifica = /\b(o da|a da|da |do )\s*[A-ZÀ-Ú]/.test(text);
        if (ehSaude || ehLocal || !temCalor) {
          ;(async () => {
            try {
              await new Promise(r => setTimeout(r, 1500));
              if (!geminiDisponivel() || todosModelosEsgotados()) return;
              const promptComent = ehSaude
                ? `\n\n[INFO DE SAÚDE ENVIADA] Mande UM comentário de amiga preocupada — pergunte se é ele ou alguém. MÁXIMO 1 frase.`
                : ehLocal && ehEspecifica
                ? `\n\n[DADO ESPECÍFICO ENVIADO] Tarefa concluída. Comentário curto natural ou SKIP.`
                : ehLocal
                ? `\n\n[OPÇÕES LOCAIS ENVIADAS] Ofereça buscar mais em 1 frase curta. NUNCA diga que faltou info.`
                : `\n\n[INFO ENVIADA] Toque pessoal curtíssimo ou SKIP.`;
              const generoBusca = await getGeneroConfiavel(user.id, preferencesBusca?.name);
              const reforcoGeneroBusca = generoBusca === 'M'
                ? '\n\n[GÊNERO] O usuário é homem — concorde no masculino ao falar dele. Você é mulher — concorde no feminino ao falar de si.'
                : generoBusca === 'F' ? '\n\n[GÊNERO] O usuário é mulher — concorde no feminino ao falar dela. Você é mulher — concorde no feminino ao falar de si.' : '';
              const coment = await geminiFreeResponse([
                { role: 'system', content: buildPersonality(tomBusca, apelidoBusca, false) + promptComent + reforcoGeneroBusca },
                { role: 'user', content: text }
              ], { temperature: 0.85, maxTokens: 60 }).catch(() => null);
              const comentLimpo = filtrarResposta((coment || '').replace(/[*_]{0,2}BUSCAR[*_]{0,2}:[^\n]*/gi, '').trim());
              if (comentLimpo && comentLimpo.length > 3 && !/^SKIP/i.test(comentLimpo)) {
                await sendMessage(phone, comentLimpo);
                await memory.saveConversationMessage(user.id, 'assistant', comentLimpo).catch(() => {});
              }
            } catch {}
          })();
        }
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
      const prefsHora = await memory.getUserPreference(user.id).catch(() => ({}));
      const afetivaHora = await memory.getMemoriaAfetiva(user.id).catch(() => ({}));
      const nomeHora = afetivaHora?.apelido_usuario || prefsHora?.name || '';
      const systemHora = buildPersonality(prefsHora?.tom || 'leve', nomeHora, false) + `\n\nVocê anotou um lembrete: "${classified.titulo}" pro dia ${dataFmt}. Mas não foi informado o horário. Pergunte que horas colocar, do SEU jeito — curta, natural, sem parecer formulário de sistema. Deixe claro que se não souber pode dizer que você coloca às 09:00. NUNCA use __BUSCAR__ nem tags de sistema.`;
      const msgHora = await geminiFreeResponse([
        { role: 'system', content: systemHora },
        { role: 'user', content: text }
      ], { temperature: 0.85, maxTokens: 120 }).catch(() => null);
      const msgHoraFiltrada = msgHora ? filtrarResposta(msgHora.trim()) : null;
      const msgHoraFinal = (msgHoraFiltrada && msgHoraFiltrada.trim().length > 3 && !isRespostaFallback(msgHoraFiltrada))
        ? msgHoraFiltrada.trim()
        : `Anotei "${classified.titulo}" pro ${dataFmt} 📌 — que horas coloco? Se não souber, fala que deixo às 09:00.`;
      await sendMessage(phone, msgHoraFinal);
      await memory.saveConversationMessage(user.id, 'assistant', msgHoraFinal).catch(() => {});
      await memory.saveMemory(user.id, 'tarefa', classified.titulo, { data: classified.data, hora: null });
      extractAndSavePersonalInfo(user.id, text).catch(e => console.error('[extract pessoal]', e.message));
      return;
    }

    // ajustar_remedio precisa rodar de forma síncrona (não fire-and-forget)
    // para sabermos o número real de doses resultante antes de confirmar —
    // evita a Clara "inventar" ou ficar vaga sobre a quantidade.
    let confirmacaoAjusteRemedio = null;
    let contextoAcaoExtra = '';
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
      const { respondeuAqui: acaoRespondeu, contextoParaResposta } = await executeAction(user, phone, classified, text, quotedText).catch(e => { console.error('Erro executeAction:', e.message); return { respondeuAqui: false, contextoParaResposta: '' }; });
      contextoAcaoExtra = contextoParaResposta || '';
      // Se executeAction já respondeu ao usuário (ex: chamada_combinada),
      // não gera mais resposta — apenas salva info pessoal em background.
      if (acaoRespondeu) {
        extractAndSavePersonalInfo(user.id, text).catch(e => console.error('[extract pessoal]', e.message));
        return;
      }
    }
    const isSaudacao = classified.tipo === 'saudacao';

    // Tipos estruturados que executam uma ação concreta (criar lembrete, gasto, etc) —
    // usados para dar confirmação fixa caso o bate-papo livre esteja em modo direto
    let confirmacaoTarefa = classified.titulo
      ? `✅ Anotado! "${classified.titulo}" — vou te lembrar 😉`
      : '✅ Anotado! Vou te lembrar.';
    if (classified.tipo === 'tarefa' && (classified.hora || calcularHorarioRelativo(text))) {
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
          confirmacaoTarefa = `✅ Lembrete criado!\n\n📌 ${classified.titulo}\n🕒 ${dataFmt}, ${horaFmt}\n\nVou te avisar no horário certinho.`;
        }
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
      await sendMessage(phone, acaoConfirmacao);
      emitirAtualizacao(phone, 'lembretes');
      return;
    }

    // Para TAREFA (lembrete único): a confirmação vai como SEGUNDA mensagem
    // crua, separada da resposta humana. A IA gera só a conversa natural (não
    // recebe a confirmação no contexto, pra não confirmar embutido e duplicar);
    // a confirmação estruturada é enviada logo depois dentro de responderLivre.
    if (classified.tipo === 'tarefa' && acaoConfirmacao) {
      await responderLivre(user, phone, text, '', isSaudacao, null, acaoConfirmacao);
      extractAndSavePersonalInfo(user.id, text).catch(e => console.error('[extract pessoal]', e.message));
      emitirAtualizacao(phone, 'lembretes');
      return;
    }

    await responderLivre(user, phone, text, contextoAcaoExtra, isSaudacao, acaoConfirmacao);
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

async function executeAction(user, phone, classified, originalText, quotedText = null) {
  let respondeuAqui = false;
  let contextoParaResposta = '';
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

      // Suporte a tempo relativo: "daqui 15 minutos", "em 30 min"
      if (!horaFinal) {
        const relativo = calcularHorarioRelativo(originalText || '');
        if (relativo) {
          // Converte para horário BRT explicitamente — servidor Railway está em UTC
          const horaBRT = relativo.toLocaleString('pt-BR', {
            timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false
          });
          horaFinal = horaBRT.replace(',', '').trim().slice(0, 5);
          console.log(`[ChamadaCombinada] Tempo relativo → ${horaFinal} (BRT)`);
        }
      }

      if (!horaFinal) {
        // Antes de calcular: verifica se há horário de almoço ou padrão
        // de chamada salvo na memória pessoal (ex: usuário já disse antes
        // "me chama às 12:40 no almoço" várias vezes → deve usar isso).
        try {
          const memoriaAlmoco = await prisma.memory.findFirst({
            where: { userId: user.id, type: 'info_pessoal', metadata: { contains: '"chave":"horario_almoco"' } }
          }).catch(() => null);
          if (memoriaAlmoco?.content) {
            const match = memoriaAlmoco.content.match(/(\d{1,2})[h:](\d{0,2})/i);
            if (match) {
              const h = match[1].padStart(2,'0');
              const m = (match[2] || '00').padStart(2,'0');
              horaFinal = `${h}:${m}`;
              console.log(`[ChamadaCombinada] Horário de almoço da memória: ${horaFinal}`);
            }
          }
        } catch {}
      }

      if (!horaFinal) {
        // Sem horário — calcula baseado na agenda (remédios + compromissos)
        try {
          const agora = nowBRT();
          const hojeISO = dateBRT();
          const hAtual = agora.getHours() * 60 + agora.getMinutes();

          // Pega remédios do dia
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

          // Pega próximo compromisso do dia
          const proximoComp = await prisma.reminder.findFirst({
            where: { userId: user.id, sent: false, confirmed: false, scheduledAt: { gte: new Date(`${hojeISO}T${String(agora.getHours()).padStart(2,'0')}:${String(agora.getMinutes()).padStart(2,'0')}:00-03:00`) } },
            orderBy: { scheduledAt: 'asc' }
          }).catch(() => null);

          let horaBaseMin = null;

          if (horariosMeds.length > 0) {
            // Tem remédio — chama 30min depois do primeiro remédio futuro
            const primeiroMed = Math.min(...horariosMeds);
            horaBaseMin = primeiroMed + 30;
          } else if (proximoComp) {
            // Tem compromisso — chama 1h antes
            const compMin = new Date(proximoComp.scheduledAt).getHours() * 60 + new Date(proximoComp.scheduledAt).getMinutes();
            horaBaseMin = compMin - 60;
          }

          // Garante que está no range 20h-23h e tem pelo menos 1h de folga
          if (!horaBaseMin || horaBaseMin < 20 * 60 || horaBaseMin > 23 * 60) {
            horaBaseMin = 21 * 60; // padrão: 21h
          }
          if (horaBaseMin < hAtual + 60) {
            horaBaseMin = hAtual + 60; // mínimo 1h a partir de agora
          }

          // Variação de ±15 min pra não parecer alarme
          const variacao = Math.floor(Math.random() * 31) - 15;
          horaBaseMin = Math.min(Math.max(horaBaseMin + variacao, hAtual + 30), 23 * 60);

          const h = Math.floor(horaBaseMin / 60);
          const m = horaBaseMin % 60;
          horaFinal = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
        } catch(e) {
          horaFinal = '21:00'; // fallback seguro
        }
      }

      // Salva a chamada combinada — apaga entradas anteriores primeiro
      // pra garantir que só existe UMA no banco e dispara no horário certo
      await prisma.memory.deleteMany({ where: { userId: user.id, type: 'chamada_combinada' } }).catch(() => {});
      const histCombinado = await memory.getConversationHistory(user.id, 6).catch(() => []);
      const ctxCombinado = histCombinado.slice(-4).map(m =>
        `${m.role === 'user' ? 'Ele' : 'Você'}: ${(m.content || '').slice(0, 100)}`
      ).join('\n');
      await prisma.memory.create({
        data: {
          userId: user.id,
          type: 'chamada_combinada',
          content: horaFinal,
          metadata: JSON.stringify({ hora: horaFinal, ctxCombinado, expira: Date.now() + 24 * 60 * 60 * 1000 })
        }
      }).catch(() => {});

      const foiSaudade = /saudade|quando sentir|quando quiser|quando der/i.test(originalText || '');
      // Busca preferências e apelido para personalizar a confirmação
      const prefsChamada = await memory.getUserPreference(user.id).catch(() => ({}));
      const afetivaChamada = await memory.getMemoriaAfetiva(user.id).catch(() => ({}));
      const apelidoChamada = afetivaChamada?.apelido_usuario || prefsChamada?.name || '';
      const dicaChamada = foiSaudade
        ? `Usuário disse pra chamar quando sentir saudade — você decidiu que vai chamar às ${horaFinal}. Responda de forma natural e carinhosa/zoeira conforme o tom, sem revelar que calculou o horário. Confirme que vai aparecer, sem mencionar a hora exata. NUNCA use __BUSCAR__ nem tags de sistema.`
        : horaJaInformada
          ? `Usuário pediu pra ser chamado às ${horaFinal}. Confirme no seu tom — pode provocar, pode ser carinhosa, pode ser as duas coisas. Só confirma que vai aparecer, do jeito que for mais natural pra você nesse momento. NUNCA use __BUSCAR__ nem tags de sistema.`
          : `Usuário pediu pra ser chamado sem dizer hora — você ESCOLHEU às ${horaFinal} por conta própria. Confirme no seu tom, com o espírito de quem fez isso porque quis, não porque foi mandada — provoque, seja carinhosa, improvise como quiser. NUNCA use __BUSCAR__ nem tags de sistema.`;
      const generoChamada = await getGeneroConfiavel(user.id, prefsChamada?.name);
      const reforcoGeneroChamada = generoChamada === 'M'
        ? ' Ele é homem — concorde no masculino ao falar dele. Você é mulher — concorde no feminino ao falar de si.'
        : generoChamada === 'F' ? ' Ela é mulher — concorde no feminino ao falar dela. Você é mulher — concorde no feminino ao falar de si.' : '';
      const systemChamada = buildPersonality(prefsChamada?.tom || 'leve', apelidoChamada, false) + `\n\n${dicaChamada}${reforcoGeneroChamada}`;
      const confMsg = await geminiFreeResponse([
        { role: 'system', content: systemChamada },
        { role: 'user', content: originalText || 'ok' }
      ], { temperature: 0.85, maxTokens: 80 }).catch(() => null);
      const confLimpo = (confMsg || '').replace(/\[.*?\]/g, '').trim();
      const msgFinal = confLimpo && confLimpo.length > 3
        ? confLimpo
        : (foiSaudade ? `Combinado, apareço quando a saudade bater 😏` : `Combinado! Te chamo às ${horaFinal} 😉`);
      await sendMessage(phone, msgFinal);
      await memory.saveConversationMessage(user.id, 'assistant', msgFinal).catch(() => {});
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
        const ctx = `\n\n[TÍTULO INCOMPLETO] O usuário pediu um lembrete mas o título ficou incompleto: "${resultTarefa.tituloIncompleto}". Pergunte de forma natural e com seu jeito — ex: "Opa, cobrar quem? 😄" ou "Espera, ${resultTarefa.tituloIncompleto} quem? Não me deixa curiosa! 🤔" — curto, no seu tom, sem criar nada ainda.`;
        contextoParaResposta = ctx;
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
        const ctx = `\n\n[COLETA DE LEMBRETE] O usuário pediu pra lembrar de "${resultTarefa.lembreteTitulo}"${temData ? ` para ${resultTarefa.lembreteData}` : ''} mas não disse ${temData ? 'o horário' : 'quando'}. Pergunte ${temData ? 'que horas' : 'quando e que horas'} do seu jeito — natural, curta, sem parecer formulário. NÃO crie o lembrete ainda.`;
        contextoParaResposta = ctx;
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
      // Sem título e sem código explícito: tenta inferir pelo texto da mensagem
      let matchMultiplo = null;
      if (!match && !codigo) {
        if (pendentes.length === 1) {
          // Só 1 pendente — assume ele
          match = pendentes[0];
        } else {
          // Múltiplos pendentes — tenta casar pelo texto da mensagem ou quotedText
          const textoParaBusca = ((originalText || '') + ' ' + (quotedText || '')).toLowerCase();
          const candidatos = pendentes.filter(r => {
            const palavras = r.message.toLowerCase().split(/\s+/).filter(w => w.length > 3);
            return palavras.some(p => textoParaBusca.includes(p));
          });
          if (candidatos.length > 1) {
            // Bateu com mais de um pendente ao mesmo tempo — normalmente
            // porque ele respondeu ao AVISO AGRUPADO inteiro ("🔔 Você tem
            // N lembretes agora") com um "feito" genérico, sem apontar
            // item específico. Interpreta como "todos concluídos" — bug
            // observado: 2 lembretes disparados juntos, resposta genérica
            // só marcava o primeiro, deixando o segundo pendente à toa.
            matchMultiplo = candidatos;
          } else if (candidatos.length === 1) {
            match = candidatos[0];
          } else {
            // Sem candidato: só faz fallback se NÃO houver citação de conversa
            // comum — arrastar mensagem de conversa (não é lembrete) nunca deve
            // confirmar o lembrete mais recente da fila, que seria sempre errado.
            const citacaoEhLembrete = quotedText && /🔔|Lembrete/i.test(quotedText);
            if (!quotedText || citacaoEhLembrete) {
              match = pendentes.find(r => r.sent) || pendentes[0];
            }
            // Se citou conversa sem relação: match fica null → não confirma nada
          }
        }
      }

      // PROTEÇÃO: lembrete de mandar foto/selfie nunca fecha por essa via
      // genérica de "confirmação conversacional" — só a entrega real da
      // foto (no bloco de geração de selfie) pode marcar como concluído.
      // Sem isso, uma resposta tipo "tá pronta!" (mesmo sem a foto ter
      // saído de verdade) podia fechar o lembrete como se tivesse cumprido.
      const ehLembreteDeFoto = (msg) => /\b(foto|fotinha|selfie)\b/i.test(msg || '');
      if (matchMultiplo) {
        const semFoto = matchMultiplo.filter(m => !ehLembreteDeFoto(m.message));
        if (semFoto.length) {
          await prisma.reminder.updateMany({ where: { id: { in: semFoto.map(m => m.id) } }, data: { confirmed: true } });
          for (const m of semFoto) fecharPendenciaLembrete(user.id, m.message).catch(() => {});
          emitirAtualizacao(phone, 'lembretes');
          const listaConfirmada = semFoto.map(m => `"${m.message}"`).join(' e ');
          const msgConfirmacaoMultipla = `✅ Feito! ${listaConfirmada} concluído${semFoto.length > 1 ? 's' : ''}.`;
          await sendMessage(phone, msgConfirmacaoMultipla);
          await memory.saveConversationMessage(user.id, 'assistant', msgConfirmacaoMultipla).catch(() => {});
          respondeuAqui = true;
        }
      } else if (match) {
        if (ehLembreteDeFoto(match.message)) {
          break; // não fecha — deixa a conversa normal seguir, sem confirmar algo que não foi entregue de verdade
        }
        await prisma.reminder.update({ where: { id: match.id }, data: { confirmed: true } });
        fecharPendenciaLembrete(user.id, match.message).catch(() => {});
        emitirAtualizacao(phone, 'lembretes');
        const msgConfirmacao = `✅ Feito! "${match.message}" concluído.`;
        await sendMessage(phone, msgConfirmacao);
        await memory.saveConversationMessage(user.id, 'assistant', msgConfirmacao).catch(() => {});
        respondeuAqui = true;
      }
      break;
    }
    case 'saldo':
      if (classified.valor !== undefined && classified.valor !== null) await memory.saveUserPreference(user.id, null, null, parseFloat(classified.valor));
      break;
  }
  return { respondeuAqui, contextoParaResposta };
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
  // Atividade atual — onde ele está / o que está fazendo agora
  const TRABALHANDO = /(chegando|cheguei|fui|vou|estou|tô|vim).{0,20}(trabalh|escritório|escritorio|servi[cç]o|empresa|firma)|no trabalho|no serviço/i;
  const EM_CASA     = /cheg(ando|uei) em casa|tô em casa|estou em casa|voltei pra casa|já em casa/i;
  const ALMOCANDO   = /almo[cç](ando|ar|ei)|no almoço|hora do almoço|pausa do almoço/i;
  const VIAJANDO    = /viajando|na estrada|no carro|no ônibus|no avião|dirigindo|de viagem/i;

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

  // Atividade tem prioridade — onde ele está define o contexto do dia
  if (TRABALHANDO.test(t))   { estado = 'trabalhando'; motivo = 'no trabalho'; }
  else if (ALMOCANDO.test(t)) { estado = 'almoçando'; }
  else if (EM_CASA.test(t))   { estado = 'em_casa'; }
  else if (VIAJANDO.test(t))  { estado = 'viajando'; }
  else if (DOENTE.test(t)) {
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
  // ── SEM HORA E SEM DATA — sempre pede o horário antes de criar ──
  // Ex: "não me deixa esquecer de marcar os exames" → não tem hora nem data
  // → retorna perguntarHora para a Clara perguntar quando quer ser lembrado
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
    let novoLembrete = await prisma.reminder.create({ data: { userId: user.id, phone, message: classified.titulo, scheduledAt } });
    // ── Verificação de segurança pós-escrita ──
    // Relê o registro recém-criado antes de seguir. Isso não deveria ser
    // necessário (o await já garante que o Postgres confirmou a escrita),
    // mas protege contra o cenário raro visto em produção: o processo é
    // encerrado (ex: restart do Railway no meio de um deploy) bem entre o
    // create() resolver e o restante do fluxo continuar — nesses casos a
    // Clara confirmava "Anotado!" para o usuário, mas o lembrete nunca
    // existiu de fato no banco. Custo é uma leitura indexada por ID (rápida)
    // e só dispara uma recriação no caso raro de não encontrar.
    const verificacao = await prisma.reminder.findUnique({ where: { id: novoLembrete.id } }).catch(() => null);
    if (!verificacao) {
      console.warn(`[Lembrete] Verificação pós-escrita falhou para "${classified.titulo}" — recriando`);
      novoLembrete = await prisma.reminder.create({ data: { userId: user.id, phone, message: classified.titulo, scheduledAt } }).catch(e => {
        console.error('[Lembrete] Recriação também falhou:', e.message);
        return novoLembrete; // mantém referência original — não interrompe o fluxo
      });
    }
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

    // ── Prioridade 1: quotedText — quando o usuário arrastou/citou o lembrete
    // específico, é a fonte mais confiável pra identificar qual é.
    if (!encontrado && originalText) {
      const qtLower = originalText.toLowerCase();
      encontrado = todosLembretes.find(r => {
        const palavras = r.message.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        return palavras.some(p => qtLower.includes(p));
      });
    }

    // ── Prioridade 2: código curto (#1, #2, "o 1"...) ──
    const codigo = extrairCodigoLembrete(originalText || '');
    if (!encontrado && codigo) {
      const pendentes = await getLembretesPendentesConfirmacao(user.id);
      if (pendentes[codigo - 1]) encontrado = pendentes[codigo - 1];
    }

    if (!encontrado && !titulo) {
      const agora = Date.now();
      const enviados = todosLembretes
        .filter(r => r.sent)
        .sort((a, b) => Math.abs(new Date(a.scheduledAt) - agora) - Math.abs(new Date(b.scheduledAt) - agora));
      encontrado = enviados[0] || null;
      if (!encontrado) {
        encontrado = todosLembretes[0] || null;
      }
    } else if (!encontrado) {
      encontrado = todosLembretes.find(r => r.message.toLowerCase().includes(titulo));
      if (!encontrado) {
        const palavras = titulo.split(' ').filter(p => p.length > 3);
        encontrado = todosLembretes.find(r =>
          palavras.some(p => r.message.toLowerCase().includes(p))
        );
      }
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

    // Só reseta sent:false se o novo horário for no FUTURO — sem isso, resetar
    // pra false num horário já passado fazia o cron disparar o lembrete de
    // novo imediatamente no próximo ciclo, como se fosse um novo lembrete.
    const sentNovoValor = novoScheduledAt.getTime() > Date.now();
    await prisma.reminder.update({ where: { id: encontrado.id }, data: { scheduledAt: novoScheduledAt, sent: sentNovoValor } });

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
      let ctxParaResposta = `\n\n[TÍTULO COMPLETADO] Lembrete "${tituloCompleto}" foi criado. Confirme naturalmente.`;
      if (resultFinal?.perguntarHora) {
        const expira = Date.now() + 15 * 60 * 1000;
        await prisma.memory.create({
          data: {
            userId: user.id, type: 'confirmacao_pendente',
            content: JSON.stringify({ tipo: 'coleta_lembrete', titulo: tituloCompleto, data: dados.data, turno: 'hora', expira })
          }
        }).catch(() => {});
        ctxParaResposta = `\n\n[COLETA] Lembrete "${tituloCompleto}" — ainda falta o horário. Pergunte que horas de forma natural.`;
      }
      await responderLivre(user, phone, text, ctxParaResposta);
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
    // ── Resposta à sugestão de chamada inteligente ──────────────────────
    // Precisa vir ANTES do bloco genérico sim/não abaixo (que é específico
    // do fluxo de enviar_mensagem), senão a resposta seria interceptada
    // pelo lugar errado.
    if (dados.tipo === 'sugestao_chamada') {
      await prisma.memory.delete({ where: { id: pendente.id } }).catch(() => {});
      const afirmativo = /^(sim|pode|claro|manda|isso|s|ok|beleza|adoraria|quero|vai|combinado|com certeza|bora)\b/i.test(textNorm);
      const negativo = /^(n[aã]o|nao|n\b|deixa|melhor n[aã]o|hoje n[aã]o|prefiro que n[aã]o|agora n[aã]o)/i.test(textNorm);
      if (afirmativo) {
        // Converte em chamada_combinada — reusa o mesmo mecanismo de
        // disparo já existente pro pedido explícito (janela -3 a 0min).
        await prisma.memory.deleteMany({ where: { userId: user.id, type: 'chamada_combinada' } }).catch(() => {});
        await prisma.memory.create({
          data: { userId: user.id, type: 'chamada_combinada', content: dados.hora,
            metadata: JSON.stringify({ hora: dados.hora, ctxCombinado: `Combinado pra continuar: ${dados.assunto}`, expira: Date.now() + 24 * 60 * 60 * 1000 }) }
        }).catch(() => {});
        const contextoExtra = `\n\n[SUGESTÃO ACEITA] Ele topou! Você vai chamar ${dados.periodo === 'almoco' ? 'no almoço' : 'à noite'}. Confirme com carinho e naturalidade, sem soar robótica.`;
        await responderLivre(user, phone, text, contextoExtra);
        return true;
      }
      if (negativo) {
        // Respeita o não — sem insistir, sem criar nada.
        await responderLivre(user, phone, text, `\n\n[SUGESTÃO RECUSADA] Ele preferiu que você não chame agora. Aceite com naturalidade e leveza, sem insistir nem ficar sem graça.`);
        return true;
      }
      // Resposta ambígua — não força decisão binária, deixa cair no fluxo normal
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
  // Busca a última mensagem da Clara pra dar contexto à extração — sem
  // isso, uma resposta curta de confirmação ("sim", "isso mesmo", "é
  // verdade") a uma pergunta de curiosidade orgânica (incluindo as
  // suspeitas de perfil da atualização noturna) não era reconhecida como
  // informação nova, porque o gate de palavras-chave exige mensagem mais
  // longa/específica quando não há contexto da pergunta.
  const historicoRecente = await memory.getConversationHistory(userId, 3).catch(() => []);
  const ultimaDaClara = [...historicoRecente].reverse().find(m => m.role === 'assistant');
  const infos = await extractPersonalInfo(text, ultimaDaClara?.content || null);
  if (infos && infos.length > 0) {
    for (const { chave, valor, categoria } of infos) {
      if (!chave || !valor) continue;
      await savePersonalInfo(userId, chave, valor, categoria || 'outro');
      console.log(`[memória pessoal] salvo: ${chave} = "${valor}"`);
    }
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
