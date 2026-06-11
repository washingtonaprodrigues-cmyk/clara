/**
 * rateLimit.js — Gerencia pausas criativas da Clara quando o Groq atinge rate limit
 * Salvar em: src/services/rateLimit.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}
function pad(n) { return String(n).padStart(2, '0'); }
function horaStr(date) {
  const brt = new Date(new Date(date).toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  return `${pad(brt.getHours())}:${pad(brt.getMinutes())}`;
}
function random(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const DESCULPAS_RPM = [
  { ausencia: 'escovando o dente', retorno: 'Já escovei o dente' },
  { ausencia: 'pagando uma conta aqui', retorno: 'Já paguei a conta' },
  { ausencia: 'fazendo um café', retorno: 'Café pronto' },
  { ausencia: 'pegando um copo de água', retorno: 'Já me hidratei' },
  { ausencia: 'respondendo uma coisa rápida aqui', retorno: 'Já resolvi' },
  { ausencia: 'buscando meu carregador', retorno: 'Já achei o carregador' },
  { ausencia: 'lavando a mão rapidinho', retorno: 'Já lavei a mão' },
  { ausencia: 'esticando as pernas aqui', retorno: 'Já me estirei' },
  { ausencia: 'checando uma notificação', retorno: 'Já chequei' },
  { ausencia: 'passando protetor solar', retorno: 'Já passei o protetor' },
];

const DESCULPAS_TPD = [
  { ausencia: 'vou dormir um pouco 😴', retorno: 'Bom dia! Já acordei' },
  { ausencia: 'vou almoçar 🍽️', retorno: 'Já almocei' },
  { ausencia: 'vou jantar 🍽️', retorno: 'Já jantei' },
  { ausencia: 'vou tomar um banho 🚿', retorno: 'Já tomei banho' },
  { ausencia: 'fui ao mercado 🛒', retorno: 'Já voltei do mercado' },
  { ausencia: 'vou ao dentista 🦷', retorno: 'Já saí do dentista' },
  { ausencia: 'vou fazer academia 🏋️', retorno: 'Já terminei a academia' },
  { ausencia: 'vou descansar os olhos um pouco 😌', retorno: 'Já descansei' },
  { ausencia: 'fui buscar minha filha 👧', retorno: 'Já busquei minha filha' },
  { ausencia: 'preciso resolver uma coisa pessoal aqui', retorno: 'Já resolvi' },
];

function proximoResetTPD() {
  const now = new Date();
  const reset = new Date(now);
  reset.setUTCHours(0, 0, 0, 0);
  reset.setUTCDate(reset.getUTCDate() + 1);
  return reset;
}

async function registrarPausa(phone, tipo) {
  const now = nowBRT();
  let retornoEm, desculpa;
  if (tipo === 'rpm') {
    retornoEm = new Date(now.getTime() + 90 * 1000);
    desculpa = random(DESCULPAS_RPM);
  } else {
    retornoEm = proximoResetTPD();
    desculpa = random(DESCULPAS_TPD);
  }
  const retornoHora = horaStr(retornoEm);
  const dados = { tipo, ausencia: desculpa.ausencia, retorno: desculpa.retorno, retornoEm: retornoEm.toISOString(), retornoHora };
  try {
    await prisma.memory.deleteMany({ where: { userId: phone, type: 'clara_pausa' } });
    await prisma.memory.create({ data: { userId: phone, type: 'clara_pausa', content: JSON.stringify(dados) } });
  } catch (e) { console.error('[RateLimit] Erro ao salvar pausa:', e.message); }
  return { desculpa, retornoHora, retornoEm };
}

async function verificarPausa(phone) {
  try {
    const pausa = await prisma.memory.findFirst({ where: { userId: phone, type: 'clara_pausa' } });
    if (!pausa) return null;
    const dados = JSON.parse(pausa.content);
    if (new Date() >= new Date(dados.retornoEm)) {
      await prisma.memory.deleteMany({ where: { userId: phone, type: 'clara_pausa' } });
      return { expirou: true, dados };
    }
    return { expirou: false, dados };
  } catch (e) { return null; }
}

function mensagemPausa(tipo, ausencia, retornoHora) {
  if (tipo === 'rpm') return `Eita, ${ausencia}! Já te chamo às ${retornoHora}! 🏃`;
  return `Ei, ${ausencia}. Volto às ${retornoHora}, tá? Não some! 💜`;
}

function mensagemRetorno(tipo, retorno) {
  if (tipo === 'rpm') return `Oi! ${retorno}! Pode falar 😄`;
  return `${retorno}! Tô aqui de volta, pode chamar 💜`;
}

function mensagemDurantePausa(tipo, ausencia, retornoHora) {
  if (tipo === 'rpm') {
    return random([
      `Ainda ${ausencia}! Já já volto, prometo 😅`,
      `Calma! Ainda ${ausencia}... um minutinho 🏃`,
      `Ei, ainda ${ausencia}! Já te chamo às ${retornoHora} 😄`,
    ]);
  }
  return random([
    `Ainda ${ausencia} 😴 Volto às ${retornoHora}, tô quase!`,
    `Oi! Ainda ${ausencia}... aguenta um pouco, volto às ${retornoHora} 💜`,
    `Ei! Ainda ${ausencia}. ${retornoHora} tô de volta, tá? 😊`,
  ]);
}

module.exports = { registrarPausa, verificarPausa, mensagemPausa, mensagemRetorno, mensagemDurantePausa };
