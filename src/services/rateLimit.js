/**
 * rateLimit.js — Gerencia pausas criativas da Clara quando o Groq atinge rate limit
 *
 * RPM (requests per minute): pausa ~1 min → desculpas rápidas e engraçadas
 * TPD (tokens per day): pausa até reset (21h BRT = meia-noite UTC) → desculpas longas
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function pad(n) { return String(n).padStart(2, '0'); }

function horaStr(date) {
  const d = new Date(date);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── Desculpas RPM (curtas, ~1 minuto) ──
const DESCULPAS_RPM = [
  { ausencia: 'escovando o dente', retorno: 'já escovei' },
  { ausencia: 'pagando uma conta aqui', retorno: 'já paguei a conta' },
  { ausencia: 'fazendo um café', retorno: 'o café ficou pronto' },
  { ausencia: 'pegando um copo de água', retorno: 'já me hidratei' },
  { ausencia: 'respondendo uma coisa rápida aqui', retorno: 'já resolvi' },
  { ausencia: 'passando protetor solar', retorno: 'já passei o protetor' },
  { ausencia: 'buscando meu carregador', retorno: 'já achei o carregador' },
  { ausencia: 'lavando a mão rapidinho', retorno: 'já lavei a mão' },
  { ausencia: 'esticando as pernas aqui', retorno: 'já me estirei' },
  { ausencia: 'checando uma notificação', retorno: 'já chequei' },
];

// ── Desculpas TPD (longas, horas) ──
const DESCULPAS_TPD = [
  { ausencia: 'vou dormir um pouco 😴', retorno: 'Bom dia! Já acordei' },
  { ausencia: 'vou almoçar 🍽️', retorno: 'Já almocei' },
  { ausencia: 'vou jantar 🍽️', retorno: 'Já jantei' },
  { ausencia: 'vou tomar um banho 🚿', retorno: 'Já tomei banho' },
  { ausencia: 'fui ao mercado 🛒', retorno: 'Já voltei do mercado' },
  { ausencia: 'vou ao dentista 🦷', retorno: 'Já sai do dentista' },
  { ausencia: 'vou fazer academia 🏋️', retorno: 'Já terminei a academia' },
  { ausencia: 'preciso resolver uma coisa pessoal aqui', retorno: 'Já resolvi' },
  { ausencia: 'vou descansar os olhos um pouco 😌', retorno: 'Já descansei' },
  { ausencia: 'fui buscar minha filha 👧', retorno: 'Já busquei minha filha' },
];

function random(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Calcula o próximo reset do TPD (meia-noite UTC = 21h BRT)
function proximoResetTPD() {
  const now = new Date();
  const reset = new Date(now);
  reset.setUTCHours(0, 0, 0, 0);
  reset.setUTCDate(reset.getUTCDate() + 1); // próxima meia-noite UTC
  return reset;
}

/**
 * Registra uma pausa criativa no banco
 * tipo: 'rpm' | 'tpd'
 */
async function registrarPausa(phone, tipo) {
  const now = nowBRT();
  let retornoEm, desculpa;

  if (tipo === 'rpm') {
    // Retorna em 1 minuto e 30 segundos (margem de segurança)
    retornoEm = new Date(now.getTime() + 90 * 1000);
    desculpa = random(DESCULPAS_RPM);
  } else {
    // TPD: retorna no próximo reset (21h BRT)
    retornoEm = proximoResetTPD();
    desculpa = random(DESCULPAS_TPD);
  }

  const retornoHora = horaStr(new Date(retornoEm.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })));

  // Salvar estado no banco
  await prisma.memory.upsert({
    where: { userId_type: { userId: phone, type: 'clara_pausa' } },
    update: {
      content: JSON.stringify({
        tipo,
        ausencia: desculpa.ausencia,
        retorno: desculpa.retorno,
        retornoEm: retornoEm.toISOString(),
        retornoHora,
      })
    },
    create: {
      userId: phone,
      type: 'clara_pausa',
      content: JSON.stringify({
        tipo,
        ausencia: desculpa.ausencia,
        retorno: desculpa.retorno,
        retornoEm: retornoEm.toISOString(),
        retornoHora,
      })
    }
  }).catch(async () => {
    // Se não tem unique constraint, delete e recria
    await prisma.memory.deleteMany({ where: { userId: phone, type: 'clara_pausa' } });
    await prisma.memory.create({
      data: {
        userId: phone,
        type: 'clara_pausa',
        content: JSON.stringify({
          tipo,
          ausencia: desculpa.ausencia,
          retorno: desculpa.retorno,
          retornoEm: retornoEm.toISOString(),
          retornoHora,
        })
      }
    });
  });

  return { desculpa, retornoHora, retornoEm };
}

/**
 * Verifica se Clara está em pausa para um usuário
 * Retorna null se não está em pausa, ou os dados da pausa se está
 */
async function verificarPausa(phone) {
  try {
    const pausa = await prisma.memory.findFirst({
      where: { userId: phone, type: 'clara_pausa' }
    });
    if (!pausa) return null;

    const dados = JSON.parse(pausa.content);
    const agora = new Date();
    const retornoEm = new Date(dados.retornoEm);

    // Pausa expirou — limpar e retornar null
    if (agora >= retornoEm) {
      await prisma.memory.deleteMany({ where: { userId: phone, type: 'clara_pausa' } });
      return { expirou: true, dados };
    }

    return { expirou: false, dados };
  } catch (e) {
    return null;
  }
}

/**
 * Remove a pausa (chamado quando o limite resetou)
 */
async function limparPausa(phone) {
  await prisma.memory.deleteMany({ where: { userId: phone, type: 'clara_pausa' } });
}

/**
 * Gera a mensagem de aviso de pausa para o usuário
 */
function mensagemPausa(tipo, ausencia, retornoHora) {
  if (tipo === 'rpm') {
    return `Eita, ${ausencia}! Já te chamo às ${retornoHora}! 🏃`;
  } else {
    return `Ei, ${ausencia}. Volto às ${retornoHora}, tá? Não some! 💜`;
  }
}

/**
 * Gera a mensagem de retorno da pausa
 */
function mensagemRetorno(tipo, retorno) {
  if (tipo === 'rpm') {
    return `Oi! ${retorno}! Pode falar 😄`;
  } else {
    return `${retorno}! Tô aqui de volta, pode chamar 💜`;
  }
}

/**
 * Gera a mensagem para quando o usuário tenta falar durante a pausa
 */
function mensagemDurantePausa(tipo, ausencia, retornoHora) {
  if (tipo === 'rpm') {
    const variações = [
      `Ainda ${ausencia}! Já já volto, prometo 😅`,
      `Calma! Ainda ${ausencia}... um minutinho 🏃`,
      `Ei, ainda ${ausencia}! Já te chamo às ${retornoHora} 😄`,
    ];
    return variações[Math.floor(Math.random() * variações.length)];
  } else {
    const variações = [
      `Ainda ${ausencia} 😴 Volto às ${retornoHora}, tô quase!`,
      `Oi! Ainda ${ausencia}... aguenta um pouco, volto às ${retornoHora} 💜`,
      `Ei! Ainda ${ausencia}. ${retornoHora} tô de volta, tá? 😊`,
    ];
    return variações[Math.floor(Math.random() * variações.length)];
  }
}

module.exports = {
  registrarPausa,
  verificarPausa,
  limparPausa,
  mensagemPausa,
  mensagemRetorno,
  mensagemDurantePausa,
};
