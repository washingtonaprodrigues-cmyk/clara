const cron = require('node-cron');

// ── Singleton guard ──────────────────────────────────────────────────────
// O Node.js faz cache de módulos pelo caminho resolvido, então em condições
// normais este arquivo só é carregado uma vez. Mas em alguns cenários de
// hot-reload, restart sem exit limpo ou ferramentas de dev que limpam o
// cache do require, o módulo pode ser carregado mais de uma vez no mesmo
// processo — e o node-cron acumula todos os schedules, dobrando os crons.
// Este guard garante que os crons só sejam registrados uma única vez,
// mesmo que o módulo seja requerido múltiplas vezes.
if (global.__claraCronsRegistrados) {
  console.log('[Reminders] Crons já registrados — ignorando duplo require.');
  module.exports = {};
  return;
}
global.__claraCronsRegistrados = true;

// ── Lock de instância única (cross-container) ─────────────────────────────
// O guard acima só protege contra duplo require no MESMO processo. Mas o
// Railway pode ter dois containers vivos ao mesmo tempo (janela de deploy,
// restart, etc), e aí os crons rodam em DOBRO → lembretes e remédios
// duplicam de forma intermitente.
//
// Solução: cada container gera um ID único e grava um "heartbeat" no banco
// a cada 20s. Antes de QUALQUER cron executar, ele checa se é o dono ativo
// (o heartbeat mais recente). Só o dono roda. Se o dono morrer, em ~45s
// outro container assume. Isso garante UM executor de crons, definitivamente.
const INSTANCE_ID = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const HEARTBEAT_TYPE = '__cron_owner_heartbeat__';
const HEARTBEAT_STALE_MS = 45000; // dono considerado morto após 45s sem heartbeat

let _souODono = false;

async function renovarHeartbeat() {
  try {
    const ancoraId = await getAncoraUserId();
    if (!ancoraId) return;

    const agora = new Date();
    const heartbeats = await prisma.memory.findMany({
      where: { type: HEARTBEAT_TYPE },
      orderBy: { createdAt: 'desc' }
    }).catch(() => []);

    const vivo = heartbeats.find(h => (agora.getTime() - new Date(h.createdAt).getTime()) < HEARTBEAT_STALE_MS);

    if (!vivo) {
      // Ninguém vivo — reivindica ser o dono apagando heartbeats velhos e criando o meu
      await prisma.memory.deleteMany({ where: { type: HEARTBEAT_TYPE } }).catch(() => {});
      await prisma.memory.create({
        data: { userId: ancoraId, type: HEARTBEAT_TYPE, content: INSTANCE_ID }
      }).catch(() => {});
      _souODono = true;
      console.log(`[Instância] ${INSTANCE_ID} assumiu como DONO dos crons 👑`);
    } else if (vivo.content === INSTANCE_ID) {
      // Sou o dono — renova meu heartbeat (novo registro, createdAt atualizado)
      await prisma.memory.deleteMany({ where: { type: HEARTBEAT_TYPE } }).catch(() => {});
      await prisma.memory.create({
        data: { userId: ancoraId, type: HEARTBEAT_TYPE, content: INSTANCE_ID }
      }).catch(() => {});
      _souODono = true;
    } else {
      // Outro container é o dono ativo — eu fico de prontidão (não rodo crons)
      if (_souODono) console.log(`[Instância] ${INSTANCE_ID} cedeu o posto para ${vivo.content}`);
      _souODono = false;
    }
  } catch (e) {
    console.error('[Instância] Erro no heartbeat:', e.message);
  }
}

// Função que todo cron chama no início. Retorna true só se este container
// é o dono ativo dos crons. Se não for, o cron não executa.
function souODonoDoCron() {
  return _souODono;
}

// Inicia o heartbeat: renova a cada 20s. A primeira execução e o setInterval
// são disparados no FINAL do arquivo, após prisma e getAncoraUserId estarem
// definidos (const não tem hoisting).

// ── Wrapper do cron.schedule com guarda de dono ───────────────────────────
// Envolve TODO callback de cron com a checagem souODonoDoCron(). Assim, só
// o container dono executa qualquer cron — sem precisar editar os 23 crons
// um a um. Os crons que NÃO devem ter a guarda (nenhum, no momento) poderiam
// usar cron.schedule original, mas todos os nossos devem respeitar o dono.
const _cronScheduleOriginal = cron.schedule.bind(cron);
cron.schedule = function (expr, fn, opts) {
  const fnComGuarda = async (...args) => {
    if (!souODonoDoCron()) return; // não sou o dono — não executo
    return fn(...args);
  };
  return _cronScheduleOriginal(expr, fnComGuarda, opts);
};


// sendMessage via whatsapp.js (com fallback direto pra evitar circular dependency)
async function sendMessage(phone, msg, delay) {
  try {
    const w = require('../services/whatsapp');
    if (w && typeof w.sendMessage === 'function') return w.sendMessage(phone, msg, delay);
  } catch (e) { console.error('[Reminders] Erro ao carregar whatsapp.js:', e.message); }
  const axios = require('axios');
  const BASE_URL = process.env.UAZAPI_URL || 'https://claravirtual.uazapi.com';
  const TOKEN = process.env.UAZAPI_TOKEN;
  console.log(`[Reminders/Fallback] Enviando direto para ${phone}: ${String(msg).slice(0,60)}`);
  return axios.post(`${BASE_URL}/send/text`,
    { number: phone, text: msg, delay: delay || 800 },
    { headers: { token: TOKEN, 'Content-Type': 'application/json' }, timeout: 30000 }
  );
}

const { freeResponse, isRespostaFallback } = require('../services/groq');
const { geminiFreeResponse } = require('../services/gemini');
const memory = require('../services/memory');
const { getHumorDia, getLocalizacao, getCamposDesconhecidos, getProximaCuriosidade, salvarResumoRelacionamento, getResumoRelacionamento, getMemoriaAfetiva } = memory;
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function nowBRT() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })); }
function pad(n) { return String(n).padStart(2, '0'); }
function dateBRT(d = nowBRT()) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function random(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function tomDesc(tom) {
  return {
    carinhoso: 'calorosa e próxima, como uma amiga que genuinamente se importa. Use emojis com moderação. Varie sempre o jeito de falar.',
    direto: 'direta e objetiva, sem rodeios ou fofice. Vá ao ponto. Sem emojis desnecessários.',
    divertido: 'animada, com humor e energia, usando gírias naturais. Leve e bem-humorada.',
    sarcastico: 'sarcástica e sem filtro — usa ironia fina, deboche carinhoso, nunca elogia à toa. Fala a verdade com um sorrisinho. NUNCA seja sentimental ou emotiva. Tom ácido mas com carinho real por baixo.',
    clara_sendo_clara: 'adaptável ao clima de cada mensagem — anime-se com quem brinca, seja direta com quem é prático, acolha quem está mal, devolva provocação com sarcasmo leve. Sempre genuína, nunca fria ou forçada.',
  }[tom || 'carinhoso'] || 'calorosa e próxima, como uma amiga que genuinamente se importa.';
}

// Final fixo — sem variação garante que o dedup do whatsapp.js
// bloqueie qualquer duplicata, independente da versão do código.
function finalParaLembrete(r) {
  return 'Me avisa quando fizer! 👋';
}

// ═══════════════════════════════════════════════════════════════════════
// LOCKS
// ═══════════════════════════════════════════════════════════════════════

async function jaEnviouHoje(userId, tipo) {
  return prisma.memory.findFirst({ where: { userId, type: tipo, content: dateBRT() } });
}
async function marcarEnviadoHoje(userId, tipo) {
  await prisma.memory.create({ data: { userId, type: tipo, content: dateBRT() } });
}

const _locksEmMemoria = new Map();
async function tentarLockDiario(userId, tipo) {
  const hoje = dateBRT();
  const chave = `${userId}_${tipo}_${hoje}`;
  if (_locksEmMemoria.has(chave)) return false;
  _locksEmMemoria.set(chave, true);
  if (_locksEmMemoria.size > 5000) {
    for (const k of _locksEmMemoria.keys()) { if (!k.endsWith(`_${hoje}`)) _locksEmMemoria.delete(k); }
  }
  const existente = await prisma.memory.findFirst({ where: { userId, type: tipo }, orderBy: { createdAt: 'desc' } }).catch(() => null);
  if (existente && existente.content === hoje) return false;
  if (existente) {
    await prisma.memory.update({ where: { id: existente.id }, data: { content: hoje } });
  } else {
    await prisma.memory.create({ data: { userId, type: tipo, content: hoje } });
  }
  return true;
}

// ── Lock por MINUTO ──────────────────────────────────────────────────────
// ARQUITETURA DE SEGURANÇA (importante entender):
//
// Este lock NÃO é a barreira principal contra duplicação — é apenas uma
// otimização para evitar queries desnecessárias quando dois containers
// sobem ao mesmo tempo (sobreposição de deploy do Railway).
//
// A barreira REAL e matematicamente garantida é o CLAIM ATÔMICO no cron
// de lembretes: `updateMany where { id, sent: false } → sent: true`.
// Só um processo consegue mudar sent:false → true no banco. Mesmo que
// 5 containers rodem o cron simultaneamente, cada lembrete só é enviado
// uma vez — porque após o primeiro claim, sent:true impede os demais.
//
// O lock de minuto pode ter race condition em janelas de milissegundos
// (dois processos chegam exatamente quando o registro ainda não existe).
// Por isso ele usa try/catch e, em caso de erro (corrida detectada),
// retorna false (o processo que perdeu a corrida não processa). Mas mesmo
// que ambos passem pelo lock, o claim atômico por lembrete garante que
// só um envia.
const _locksMinutoMemoria = new Map();
let _ancoraUserId = null;
async function getAncoraUserId() {
  if (_ancoraUserId) return _ancoraUserId;
  const u = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } }).catch(() => null);
  if (u) _ancoraUserId = u.id;
  return _ancoraUserId;
}

async function tentarLockMinuto(tipo) {
  const n = nowBRT();
  const minutoChave = `${dateBRT(n)}-${pad(n.getHours())}:${pad(n.getMinutes())}`;
  const chaveMemoria = `${tipo}_${minutoChave}`;

  // Camada 1: cache em memória (mesmo processo)
  if (_locksMinutoMemoria.has(chaveMemoria)) return false;
  _locksMinutoMemoria.set(chaveMemoria, true);

  const ancoraId = await getAncoraUserId();
  if (!ancoraId) return true;

  const lockType = `__${tipo}__`;
  const lockContent = minutoChave;

  try {
    // Camada 2: banco — verifica se já existe pra este minuto
    const existente = await prisma.memory.findFirst({
      where: { userId: ancoraId, type: lockType, content: lockContent }
    }).catch(() => null);

    if (existente) {
      // Já existe — outro processo chegou primeiro
      return false;
    }

    // Tenta criar atomicamente
    // Apaga locks de minutos anteriores primeiro (limpeza)
    await prisma.memory.deleteMany({
      where: { userId: ancoraId, type: lockType }
    }).catch(() => {});

    // Cria o lock para este minuto
    await prisma.memory.create({
      data: { userId: ancoraId, type: lockType, content: lockContent }
    });

    // Limpeza do cache em memória
    if (_locksMinutoMemoria.size > 5000) {
      for (const [k] of _locksMinutoMemoria) {
        if (!k.endsWith(minutoChave)) _locksMinutoMemoria.delete(k);
      }
    }

    return true;
  } catch (e) {
    // Race condition — outro processo criou entre nosso delete e create
    console.log(`[LockMinuto] Race condition em ${tipo}: ${e.message}`);
    return false;
  }
}

async function houveConversaRecente(userId, minutos = 5) {
  const limite = new Date(Date.now() - minutos * 60 * 1000);
  // Só mensagens do USUÁRIO — mensagens da Clara não contam como "conversa ativa"
  const msgs = await prisma.memory.findMany({ where: { userId, type: 'conversa', createdAt: { gte: limite } }, take: 10 }).catch(() => []);
  return msgs.some(m => {
    try { const p = JSON.parse(m.content); return p.role === 'user'; } catch { return false; }
  });
}

// [removido] bloco callback_continuidade — regressão do backup antigo (25/07 fix)


async function getUserContext(user) {
  const prefs = await memory.getUserPreference(user.id);
  const perfilTexto = await memory.buildPersonalContext(user.id);
  return { prefs, perfilTexto };
}

// ═══════════════════════════════════════════════════════════════════════
// BOM DIA INTELIGENTE — reativo
// Em vez de hora fixa: espera o "sinal de que acordou" — alguns minutos
// depois do PRIMEIRO remédio ou lembrete do dia (entre 05h-11h), quando o
// usuário manda a primeira mensagem dele no dia. Isso é mais parecido com
// uma pessoa de verdade do que mandar bom dia num horário fixo sem saber
// se a pessoa já tá acordada. Se não tiver nenhum remédio/lembrete de
// manhã pra usar como referência, cai num fallback simples: janela 7h-8h.
// Tom: conversacional/íntimo (não é resumo objetivo de tarefas) — pode
// citar UM destaque do dia de forma natural, tipo "hoje tem consulta meio-
// dia, deixa tudo organizado, preguiçoso kkk", mas não lista tudo.
// ═══════════════════════════════════════════════════════════════════════
cron.schedule('*/3 5,6,7,8,9,10 * * *', async () => {
  try {
    const now = nowBRT();
    const hoje = dateBRT(now);
    const diasSemana = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
    const meses = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
    const diaTexto = `${diasSemana[now.getDay()]}, ${now.getDate()} de ${meses[now.getMonth()]}`;
    const users = await prisma.user.findMany({ where: { blocked: false } });
    for (const user of users) {
      try {
        // Checagem (sem consumir o lock ainda) — só consumimos quando for
        // de fato enviar, pra não travar o dia numa tentativa que só
        // estava esperando o sinal de "acordou".
        const jaTem = await prisma.memory.findFirst({ where: { userId: user.id, type: 'bom_dia_lock', content: hoje } }).catch(() => null);
        if (jaTem) continue;

        // Não duplica com a proativa de manhã (proativaInteligente) — se ela
        // já mandou uma saudação hoje, o bom dia dedicado não manda outra.
        const proativaManhaJaEnviada = await prisma.memory.findFirst({
          where: { userId: user.id, type: 'proativa_enviado_lock', content: `manha_${hoje}` }
        }).catch(() => null);
        if (proativaManhaJaEnviada) continue;

        let podeEnviarAgora = false;

        // ── GATILHO PROATIVO: ela começa sozinha, sem você falar ──
        // O cron é o caminho "você ainda não interagiu hoje" — se você mandar
        // mensagem primeiro, o bom dia vem emendado na RESPOSTA (handler.js),
        // e o bom_dia_lock já estará marcado, então este cron nem chega aqui.
        //
        // Sinal de "acordou" sem depender de mensagem: o primeiro
        // remédio/lembrete da manhã (5h-11h). Ela espera de 3 a 5 minutos
        // depois do disparo e manda o bom dia — não colado (robótico), mas
        // como quem "lembrou de você" logo depois.
        const inicioJanela = new Date(now); inicioJanela.setHours(5, 0, 0, 0);
        const fimJanela = new Date(now); fimJanela.setHours(11, 0, 0, 0);

        const lembretesManha = await prisma.reminder.findMany({
          where: { userId: user.id, scheduledAt: { gte: inicioJanela, lte: fimJanela } },
          orderBy: { scheduledAt: 'asc' }
        }).catch(() => []);

        const meds = await prisma.medication.findMany({ where: { userId: user.id, active: true } }).catch(() => []);
        let primeiroHorarioMed = null;
        for (const med of meds) {
          let horarios = [];
          try { horarios = JSON.parse(med.times || '[]'); } catch {}
          for (const h of horarios) {
            const hh = parseInt(h.split(':')[0], 10);
            if (hh >= 5 && hh < 11 && (!primeiroHorarioMed || h < primeiroHorarioMed)) primeiroHorarioMed = h;
          }
        }

        let primeiroEvento = lembretesManha.length > 0 ? new Date(lembretesManha[0].scheduledAt) : null;
        if (primeiroHorarioMed) {
          const [hh, mm] = primeiroHorarioMed.split(':').map(Number);
          const dataMed = new Date(now); dataMed.setHours(hh, mm, 0, 0);
          if (!primeiroEvento || dataMed < primeiroEvento) primeiroEvento = dataMed;
        }

        if (primeiroEvento) {
          const minutosDesdeEvento = (now - primeiroEvento) / 60000;

          // ── Caminho 1: usuário confirmou o remédio/lembrete ──────────────
          // Verifica se há mensagem recente de confirmação no histórico.
          // Se sim, bom dia chega entre 10-15 min depois da confirmação.
          const histConf = await memory.getConversationHistory(user.id, 6).catch(() => []);
          const ultimaUserMsg = histConf.filter(m => m.role === 'user').pop();
          if (ultimaUserMsg) {
            const msgConteudo = (ultimaUserMsg.content || '').toLowerCase();
            const ehConfirmacao = /\b(tomad[oa]|tomei|tomou|feito|fiz|ok|já tomei|já fiz|pronto)\b/.test(msgConteudo);
            const minutosDesdeConf = ultimaUserMsg.createdAt
              ? (Date.now() - new Date(ultimaUserMsg.createdAt).getTime()) / 60000
              : 999;
            if (ehConfirmacao && minutosDesdeConf >= 10 && minutosDesdeConf <= 20) {
              podeEnviarAgora = true;
              console.log(`[Bom dia] Caminho 1 — confirmação detectada (${Math.round(minutosDesdeConf)} min atrás)`);
            }
          }

          // ── Caminho 2: sem confirmação depois de 30 min ──────────────────
          // Ela não fica esperando pra sempre — se passaram 30 min sem resposta,
          // o bom dia vem mesmo assim, como quem "lembrou de você".
          if (!podeEnviarAgora && minutosDesdeEvento >= 30 && minutosDesdeEvento <= 120) {
            podeEnviarAgora = true;
            console.log(`[Bom dia] Caminho 2 — sem confirmação após ${Math.round(minutosDesdeEvento)} min`);
          }
        }

        // ── Caminho 3: sem evento matinal — rede de segurança 7h-9h ─────────
        // Dias sem remédio ou lembrete pela manhã: bom dia vem proativamente.
        if (!podeEnviarAgora && !primeiroEvento) {
          const h = now.getHours();
          if (h >= 7 && h < 9) {
            podeEnviarAgora = true;
            console.log(`[Bom dia] Caminho 3 — sem eventos matinais, rede de segurança ${h}h`);
          }
        }

        if (!podeEnviarAgora) continue;

        // Não dispara bom dia se o usuário mandou mensagem nos últimos 5 min
        // — exceto se a última mensagem foi uma confirmação de remédio
        // (tomado, feito etc.) — nesse caso é exatamente a hora certa
        // para o bom dia chegar como surpresa separada.
        const recente = await memory.getConversationHistory(user.id, 2).catch(() => []);
        const ultimaMsg = recente.filter(m => m.role === 'user').pop();
        const foiConfirmacaoRemedio = ultimaMsg && /^(tomado|tomei|tomou|feito|já tomei|ok)\s*(fedo)?\s*\.?$/i.test((ultimaMsg.content || '').trim());
        if (!foiConfirmacaoRemedio && await houveConversaRecente(user.id, 5)) {
          console.log(`[Bom dia] Conversa em andamento, aguardando para ${user.phone}`);
          continue;
        }

        const inicioHoje = new Date(`${hoje}T00:00:00-03:00`);
        const fimHoje = new Date(`${hoje}T23:59:59-03:00`);
        const [lembretesDoDia, eventos] = await Promise.all([
          prisma.reminder.findMany({ where: { userId: user.id, confirmed: false, sent: false, scheduledAt: { gte: now, lte: fimHoje } }, orderBy: { scheduledAt: 'asc' }, take: 3 }),
          prisma.event.findMany({ where: { userId: user.id, date: { gte: inicioHoje, lte: fimHoje } } }).catch(() => []),
        ]);
        const { prefs } = await getUserContext(user);

        // Puxa a memória pessoal (resumo de relacionamento, pendências,
        // acontecimentos recentes) pra ela poder dizer coisas humanas tipo
        // "dormiu bem?" / "melhorou de ontem?" referenciando algo real.
        let memoriaContexto = '';
        try { memoriaContexto = await memory.buildPersonalContext(user.id); } catch {}

        let destaqueTexto = 'nada de especial marcado pro resto do dia';
        if (eventos.length > 0) {
          destaqueTexto = eventos.map(e => `${e.title}${e.personName ? ` (${e.personName})` : ''}`).join('; ');
        } else if (lembretesDoDia.length > 0) {
          const h = new Date(lembretesDoDia[0].scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
          destaqueTexto = `${h} — ${lembretesDoDia[0].message}`;
        }

        const systemBomDia = `É de manhã e você está começando a conversa POR INICIATIVA SUA — a pessoa ainda não falou com você hoje. Mande um "bom dia" curto e NATURAL, como alguém próximo que lembrou da pessoa de manhã. NÃO é resumo de tarefas.

DATA DE HOJE: ${diaTexto} (use exatamente esse dia se for citar, nunca invente outro)
DESTAQUE DO DIA (use só se fizer sentido natural, não force): ${destaqueTexto}

REGRAS:
- 1-2 linhas. NUNCA liste tarefas em tópicos, NUNCA seja um resumo objetivo.
- Como você está iniciando, é natural perguntar algo humano: "dormiu bem?", "como você tá hoje?", "descansou?". Se a memória de vocês tiver algo de ontem ou recente (um perrengue, uma vitória, um clima), pode puxar com carinho ("melhorou de ontem?", "como ficou aquela parada?") — isso é o que te torna humana, use quando souber de algo real.
- Pode já brincar/provocar conforme o SEU tom — varie, depende do clima de vocês.
- Se tiver algo importante marcado hoje, mencione de forma leve e natural, só se acrescentar — não force.
- Use o apelido que vocês já têm, se fizer sentido. Siga o SEU tom (mais brincalhão = pode zoar; mais carinhoso = mais suave).
- NUNCA poética, NUNCA entre aspas, máximo 1 emoji, nunca repita a mesma frase de outro dia.
- NUNCA use português de Portugal (podes, tens) — só português do Brasil.`;

        const msg = await freeResponse('Bom dia.', [], { _contexto: memoriaContexto || '', name: user.name, tom: prefs.tom || 'carinhoso', _systemOverride: systemBomDia, _maxTokens: 100 });
        if (!msg || isRespostaFallback(msg)) { console.log(`[Bom dia] Rate limit ou fallback genérico, pulado para ${user.phone}`); continue; }

        if (!(await tentarLockDiario(user.id, 'bom_dia_lock'))) continue; // alguém já mandou enquanto gerávamos

        await sendMessage(user.phone, msg);
        console.log(`[Bom dia] ${user.phone}: ${msg}`);
      } catch (e) { console.error(`[Bom dia] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Bom dia] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });



// ═══════════════════════════════════════════════════════════════════════
// BOA NOITE (22:30–23:40) — curta, calorosa, só preview de amanhã
// ═══════════════════════════════════════════════════════════════════════
// Duas tentativas dentro da janela: 22:30 (primeira) e 23:10 (retry pra
// quem ainda estava conversando ou pegou rate limit no primeiro disparo).
cron.schedule('30 22 * * *', async () => boaNoiteInteligente(), { timezone: 'America/Sao_Paulo' });
async function boaNoiteInteligente() {
  try {
    const now = nowBRT();
    const hoje = dateBRT(now);
    const amanha = new Date(now); amanha.setDate(amanha.getDate() + 1);
    const amanhaStr = dateBRT(amanha);
    const users = await prisma.user.findMany({ where: { blocked: false } });
    for (const user of users) {
      try {
        if (!(await tentarLockDiario(user.id, 'boa_noite_lock'))) {
          console.log(`[Boa noite] ja enviado hoje para ${user.phone}`); continue;
        }
        // Não dispara se houve conversa nos últimos 30 minutos
        // Espera a conversa esfriar antes de mandar boa noite
        if (await houveConversaRecente(user.id, 30)) {
          console.log(`[Boa noite] Conversa recente, aguardando para ${user.phone}`);
          // Remove o lock para tentar de novo depois
          await prisma.memory.deleteMany({ where: { userId: user.id, type: 'boa_noite_lock', content: dateBRT(now) } }).catch(() => {});
          continue;
        }
        const inicioHoje = new Date(`${hoje}T00:00:00-03:00`);
        const fimHoje = new Date(`${hoje}T23:59:59-03:00`);
        const inicioAmanha = new Date(`${amanhaStr}T00:00:00-03:00`);
        const fimAmanha = new Date(`${amanhaStr}T23:59:59-03:00`);
        const [todosHoje, lembretesAmanha, infoPessoal] = await Promise.all([
          prisma.reminder.findMany({ where: { userId: user.id, scheduledAt: { gte: inicioHoje, lte: fimHoje } } }),
          prisma.reminder.findMany({ where: { userId: user.id, sent: false, confirmed: false, scheduledAt: { gte: inicioAmanha, lte: fimAmanha } }, orderBy: { scheduledAt: 'asc' }, take: 3 }),
          memory.buildPersonalContext(user.id)
        ]);
        const { prefs } = await getUserContext(user);
        const concluidosHoje = todosHoje.filter(t => t.confirmed).length;
        const pendentesHoje = todosHoje.filter(t => t.sent && !t.confirmed);
        let ctx = `Hoje foi ${['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'][now.getDay()]}.\n`;
        if (todosHoje.length > 0) ctx += `Compromissos do dia: ${concluidosHoje} concluídos, ${pendentesHoje.length} pendentes.\n`;
        if (pendentesHoje.length > 0) { ctx += `Pendentes hoje:\n${pendentesHoje.map(r => `• ${r.message}`).join('\n')}\n`; }
        if (lembretesAmanha.length > 0) {
          ctx += `\nAmanhã tem ${lembretesAmanha.length} compromisso(s):\n`;
          lembretesAmanha.forEach(r => {
            const h = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
            ctx += `• ${h} — ${r.message}\n`;
          });
        }
        if (infoPessoal) ctx += infoPessoal;
        // Boa noite — só uma amiga desejando boa noite, nada mais.
        // O fechamento do dia já foi às 18h. Aqui é descanso puro.
        const systemBoaNoite = `Você é a Clara, parceira pessoal d${user.name ? 'o ' + user.name.split(' ')[0] : 'o usuário'} no WhatsApp.
SEU TOM: ${tomDesc(prefs.tom)}

Mande UMA boa noite de verdade — curta, calorosa, do jeito que uma amiga manda mensagem antes de dormir.

CONTEXTO:
${ctx}

REGRAS ABSOLUTAS:
- Máximo 1-2 linhas. UMA frase curta com pontuação final.
- NUNCA entre aspas. NUNCA "Parabéns". NUNCA "estarei aqui". NUNCA "Podes". NUNCA liste tarefas ou faça resumo do dia.
- NUNCA use português de Portugal (podes, tens, fazes) — use sempre português do Brasil (pode, tem, faz)
- Se a pessoa estava viajando hoje, pergunte se chegou bem
- Se tiver compromisso importante amanhã, mencione levemente e só isso
- Varie sempre — nunca repita a mesma frase de boa noite
- Tom: ${prefs.tom || 'carinhoso'}`;
        const msg = await freeResponse('Boa noite.', [], { _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso', _systemOverride: systemBoaNoite, _maxTokens: 80 });
        if (!msg || isRespostaFallback(msg)) {
          console.log(`[Boa noite] Rate limit ou fallback, pulado para ${user.phone} — liberando pra tentar de novo`);
          // Libera o lock pra próxima tentativa do dia poder tentar de novo
          // (antes, uma falha aqui consumia a única tentativa do dia e o
          // boa noite simplesmente não saía — Washington pediu que esse
          // nunca pode falhar).
          await prisma.memory.deleteMany({ where: { userId: user.id, type: 'boa_noite_lock', content: dateBRT(now) } }).catch(() => {});
          continue;
        }
        await sendMessage(user.phone, msg);
        console.log(`[Boa noite] Enviado para ${user.phone}`);
      } catch (e) { console.error(`[Boa noite] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Boa noite] Erro geral:', e.message); }
}

cron.schedule('10 23 * * *', async () => boaNoiteInteligente(), { timezone: 'America/Sao_Paulo' });

// ── REDE DE SEGURANÇA FINAL — 23:40 (fim da janela) ──
// Se, depois das duas tentativas (22:30 e 23:10, geradas por IA), o boa
// noite ainda não saiu por algum motivo (rate limit total, erro etc),
// manda uma mensagem fixa — sem IA, não tem como falhar. Boa noite é o
// único disparo que Washington pediu pra NUNCA faltar.
const BOA_NOITE_GARANTIDA = [
  'Boa noite! Descansa bem 💜',
  'Boa noite, durma bem 😊',
  'Por hoje é só. Boa noite!',
  'Boa noite! Até amanhã 💜',
];
cron.schedule('40 23 * * *', async () => {
  try {
    const hoje = dateBRT(nowBRT());
    const users = await prisma.user.findMany({ where: { blocked: false } });
    for (const user of users) {
      try {
        const jaEnviou = await prisma.memory.findFirst({ where: { userId: user.id, type: 'boa_noite_lock', content: hoje } }).catch(() => null);
        if (jaEnviou) continue;
        // Não dispara se usuário esteve ativo nos últimos 30 min — o boa noite normal cuida
        const histGar = await memory.getConversationHistory(user.id, 6).catch(() => []);
        const ultimaUserGar = histGar.filter(m => m.role === 'user').pop();
        if (ultimaUserGar && ultimaUserGar.createdAt) {
          const minAtras = (Date.now() - new Date(ultimaUserGar.createdAt).getTime()) / 60000;
          if (minAtras < 30) continue;
        }
        const msg = BOA_NOITE_GARANTIDA[Math.floor(Math.random() * BOA_NOITE_GARANTIDA.length)];
        await sendMessage(user.phone, msg);
        await prisma.memory.create({ data: { userId: user.id, type: 'boa_noite_lock', content: hoje } }).catch(() => {});
        console.log(`[Boa noite GARANTIDA] ${user.phone}: ${msg}`);
      } catch (e) { console.error(`[Boa noite GARANTIDA] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Boa noite GARANTIDA] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ═══════════════════════════════════════════════════════════════════════
// ALERTAS DE DATAS IMPORTANTES (08:00)
// ═══════════════════════════════════════════════════════════════════════
cron.schedule('0 8 * * *', async () => {
  try {
    const now = nowBRT();
    const users = await prisma.user.findMany({ where: { blocked: false } });
    for (const user of users) {
      try {
        const infos = await memory.getPersonalInfo(user.id, 'datas');
        for (const [chave, { valor }] of Object.entries(infos)) {
          const match = valor.match(/(\d{1,2})\s+de\s+(\w+)/i);
          if (!match) continue;
          const mesesMap = { janeiro:1,fevereiro:2,março:3,abril:4,maio:5,junho:6,julho:7,agosto:8,setembro:9,outubro:10,novembro:11,dezembro:12 };
          const dia = parseInt(match[1]); const mes = mesesMap[match[2].toLowerCase()];
          if (!dia || !mes) continue;
          const dataEvento = new Date(now.getFullYear(), mes - 1, dia);
          const diffDias = Math.round((dataEvento - now) / (1000 * 60 * 60 * 24));
          const lockKey = `alerta_data_${chave}_${dateBRT()}`;
          if (await prisma.memory.findFirst({ where: { userId: user.id, type: 'alerta_data_lock', content: lockKey } })) continue;
          let msg = null;
          if (diffDias === 0) msg = `🎉 ${valor.replace('Aniversário', 'Hoje é o aniversário')} — não esquece de dar os parabéns! 🎂`;
          else if (diffDias === 1) msg = `⏰ Amanhã: ${valor} Já preparou algo especial? 😊`;
          else if (diffDias === 3) msg = `📅 Em 3 dias: ${valor} 💜`;
          else if (diffDias === 7) msg = `📅 Em uma semana: ${valor} 😊`;
          if (msg) {
            await sendMessage(user.phone, msg);
            await prisma.memory.create({ data: { userId: user.id, type: 'alerta_data_lock', content: lockKey } });
          }
        }
        const eventos = await prisma.event.findMany({ where: { userId: user.id, notified: false } }).catch(() => []);
        for (const ev of eventos) {
          const dataEv = new Date(ev.date);
          const diffDias = Math.round((dataEv - now) / (1000 * 60 * 60 * 24));
          let msg = null;
          if ((diffDias === 0 || diffDias === 1) && ev.personName) {
            try {
              const infoPessoalCompleta = await memory.buildPersonalContext(user.id).catch(() => '');
              const linhasRelacionadas = (infoPessoalCompleta || '').split('\n').filter(l => l.toLowerCase().includes(ev.personName.toLowerCase()));
              if (linhasRelacionadas.length > 0) {
                const prefs = await memory.getUserPreference(user.id).catch(() => null);
                const quando = diffDias === 0 ? 'hoje' : 'amanhã';
                msg = await freeResponse(`Aviso de aniversário de ${ev.personName}.`, [], {
                  _contexto: '', name: user.name, tom: prefs?.tom || 'carinhoso',
                  _systemOverride: `Você é a Clara, assistente pessoal. ${user.name ? `O nome do usuário é ${user.name}.` : ''} Tom: ${prefs?.tom || 'carinhoso'}. É ${quando} o aniversário de ${ev.personName}. O que você sabe: ${linhasRelacionadas.join('; ')}. Envie uma mensagem curta (1-2 linhas) avisando e mencionando naturalmente esse detalhe pessoal. NÃO liste como tópicos.`
                }).catch(() => null);
                if (msg && isRespostaFallback(msg)) msg = null;
              }
            } catch (e) { console.error(`[Datas] Erro memórias ${ev.personName}:`, e.message); }
          }
          if (!msg) {
            if (diffDias === 0) msg = `🎉 Hoje é ${ev.title}${ev.personName ? ` da ${ev.personName}` : ''}! 🎂`;
            else if (diffDias === 1) msg = `⏰ Amanhã é ${ev.title}${ev.personName ? ` da ${ev.personName}` : ''}! Não esquece 😊`;
            else if (diffDias === 3) msg = `📅 Em 3 dias: ${ev.title}${ev.personName ? ` da ${ev.personName}` : ''} 💜`;
            else if (diffDias === 7) msg = `📅 Em uma semana: ${ev.title}${ev.personName ? ` da ${ev.personName}` : ''} 😊`;
          }
          if (msg) {
            await sendMessage(user.phone, msg);
            await prisma.event.update({ where: { id: ev.id }, data: { notified: true } });
          }
        }
      } catch (e) { console.error(`[Datas] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Datas] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ═══════════════════════════════════════════════════════════════════════
// MENSAGENS PROATIVAS (10:00 e 15:00, dias úteis)
// ═══════════════════════════════════════════════════════════════════════
// PROATIVAS — 3 momentos do dia como uma amiga de verdade
// Manhã 08:30 — dormiu bem? referência ao dia anterior
// Almoço 12:15 — e aí, já almoçou? retoma assunto pendente
// Noite 20:00 — como foi o dia? conversa genuína
// ═══════════════════════════════════════════════════════════════════════
// Antes, cada período rodava UMA VEZ no horário exato (8:30/12:15/20:00).
// Problema: sempre no mesmo minuto (mecânico) e, se a tentativa única do
// dia fosse pulada (sem assunto, conversa recente etc), não tentava de
// novo. Agora cada período é uma JANELA com várias tentativas — a
// primeira que tiver algo genuíno pra dizer (e passar a chancela
// cacheada do dia) manda a mensagem; as outras tentativas da mesma
// janela só seguem adiante se a anterior não mandou nada.
// Manhã e Almoço: removidas — Washington decidiu manter só bom dia, boa
// noite e chamada combinada. Proativa genérica (tipo comentário sobre
// gastos, ou "bom dia" duplicado às 11:30) soava artificial/redundante
// comparado com bom dia real + boa noite + a conversa fluindo sozinha.
// proativaInteligente() fica definida mas sem cron chamando — reativar
// é só descomentar os cron.schedule abaixo se um dia fizer sentido de novo.
//
// cron.schedule('*/15 8 * * *', async () => proativaInteligente('manha'), { timezone: 'America/Sao_Paulo' });
// cron.schedule('0,15,30 9 * * *', async () => proativaInteligente('manha'), { timezone: 'America/Sao_Paulo' });
// cron.schedule('30,45 11 * * *', async () => proativaInteligente('almoco'), { timezone: 'America/Sao_Paulo' });
// cron.schedule('*/15 12 * * *', async () => proativaInteligente('almoco'), { timezone: 'America/Sao_Paulo' });
// cron.schedule('0,15,30 13 * * *', async () => proativaInteligente('almoco'), { timezone: 'America/Sao_Paulo' });

async function proativaInteligente(periodo) {
  try {
    const users = await prisma.user.findMany({ where: { blocked: false } });
    const now = nowBRT();
    for (const user of users) {
      try {
        // ── Respeita janela de remédio ────────────────────────────────
        // Se há remédio nos próximos 20min ou nos últimos 20min, pula
        // este ciclo — o próximo ciclo (15min depois) vai tentar de novo
        // já fora da janela do remédio. Genérico para qualquer horário.
        const meds = await prisma.medication.findMany({ where: { userId: user.id, active: true } }).catch(() => []);
        const hAtual = now.getHours() * 60 + now.getMinutes();
        const temRemedioNaJanela = meds.some(m => {
          let times = []; try { times = JSON.parse(m.times || '[]'); } catch {}
          return times.some(t => {
            const [h, min] = t.split(':').map(Number);
            const diff = Math.abs((h * 60 + min) - hAtual);
            return diff <= 20;
          });
        });
        if (temRemedioNaJanela) continue;

        // ── Não duplica com o "Bom dia" dedicado ──
        // A proativa de manhã e o cron de bom dia (mais abaixo) são dois
        // sistemas diferentes que podem coincidir no mesmo minuto de janela
        // (ex: 8h15 cai nos dois). Se o bom dia oficial já mandou hoje, a
        // proativa de manhã não manda outra saudação por cima.
        if (periodo === 'manha') {
          const hojeBomDia = dateBRT();
          const bomDiaJaEnviado = await prisma.memory.findFirst({
            where: { userId: user.id, type: 'bom_dia_lock', content: hojeBomDia }
          }).catch(() => null);
          if (bomDiaJaEnviado) continue;
        }

        const dayKey = `${periodo}_${dateBRT()}`;

        // ── Já enviou hoje pra esse período? ──
        // Antes isso era decidido ANTES de processar (claim atômico), o
        // que travava o dia inteiro mesmo se a tentativa fosse pulada por
        // chancela aleatória ou falta de assunto. Agora os 3 horários
        // fixos viraram JANELAS (várias tentativas dentro de um intervalo,
        // ver cron.schedule mais abaixo) — então o que precisa ser travado
        // de verdade é só "já mandou uma mensagem real hoje nesse período",
        // não "já tentou". Isso permite tentar de novo no próximo horário
        // da janela se a tentativa anterior não tinha nada genuíno pra dizer.
        // A proteção contra dois containers rodando ao mesmo tempo já vem
        // do sistema de "dono dos crons" (heartbeat) no topo do arquivo —
        // só um processo executa isso por vez, então não precisamos mais
        // do claim atômico pré-decisão de antes.
        const jaEnviouHoje = await prisma.memory.findFirst({
          where: { userId: user.id, type: 'proativa_enviado_lock', content: dayKey }
        }).catch(() => null);
        if (jaEnviouHoje) continue;

        // A partir daqui, processa com segurança
        try {
          if (await houveConversaRecente(user.id, 5)) continue;
          const ultimaConversa = await prisma.memory.findFirst({ where: { userId: user.id, type: 'conversa' }, orderBy: { createdAt: 'desc' } });
          if (!ultimaConversa) continue;
          const diasSemConversa = (now - new Date(ultimaConversa.createdAt)) / (1000 * 60 * 60 * 24);
          if (diasSemConversa > 3) continue;

          const [infoPessoal, memsRecentes, { prefs }] = await Promise.all([
            memory.buildPersonalContext(user.id),
            memory.getRecentMemories(user.id, 20),
            getUserContext(user)
          ]);

          // Assuntos em aberto — prioridade máxima em qualquer período
          const pendenciasAbertas = await prisma.pendencia.findMany({
            where: { userId: user.id, resolvido: false },
            orderBy: { createdAt: 'desc' }, take: 2
          }).catch(() => []);
          const ctxPendencias = pendenciasAbertas.length > 0
            ? `ASSUNTOS EM ABERTO (use como gancho natural, não robótico):\n${pendenciasAbertas.map(p => `- ${p.assunto}: ${p.contexto} → ${p.como_retomar}`).join('\n')}`
            : '';

          // Contexto recente filtrado
          const contextoMems = memsRecentes
            .filter(m => !['conversa','bom_dia_enviado','boa_noite_enviado','proativa_lock','med_lock','alerta_data_lock','fechamento_dia_lock','ultima_localizacao'].includes(m.type))
            .filter(m => !/dose|rem[eé]dio|medica[cç]|tiroide|toroide|colesterol|pressao|pressão/i.test(m.content || ''))
            .slice(0, 10).map(m => `[${m.type}] ${m.content}`).join('\n');

          // ── Infere quando o usuário acordou hoje ──
          // Ordem de confiabilidade:
          // 1. Primeira mensagem do usuário hoje (sinal real — ele escreveu)
          // 2. Remédio mais cedo (estimativa quando não tem sinal real)
          let horaAcorda = null;
          let jaAcordouConfirmado = false;
          try {
            const hoje = dateBRT(now);
            const inicioHoje = new Date(`${hoje}T00:00:00-03:00`);

            // Sinal 1: qualquer interação do usuário hoje
            // Inclui conversa E confirmação de remédio (swipe-reply)
            const primeiraInteracao = await prisma.memory.findFirst({
              where: {
                userId: user.id,
                type: { in: ['conversa', 'med_confirmado', 'lembrete_confirmado'] },
                createdAt: { gte: inicioHoje }
              },
              orderBy: { createdAt: 'asc' }
            }).catch(() => null);

            // Fallback: verifica se algum remédio foi confirmado hoje
            // (swipe-reply de remédio não salva em memory, mas o medication.remaining diminuiu)
            if (!primeiraInteracao) {
              const medConfirmadoHoje = await prisma.medication.findFirst({
                where: {
                  userId: user.id,
                  updatedAt: { gte: inicioHoje }
                }
              }).catch(() => null);
              if (medConfirmadoHoje) {
                const d = new Date(medConfirmadoHoje.updatedAt);
                horaAcorda = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
                jaAcordouConfirmado = true;
              }
            } else {
              const d = new Date(primeiraInteracao.createdAt);
              horaAcorda = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
              jaAcordouConfirmado = true;
            }

            // Sinal 2: remédio mais cedo (fallback)
            if (!horaAcorda) {
              const meds = await prisma.medication.findMany({ where: { userId: user.id, active: true } });
              const horarios = meds.flatMap(m => { try { return JSON.parse(m.times || '[]'); } catch { return []; } });
              if (horarios.length) horaAcorda = horarios.sort()[0];
            }
          } catch {}

          // Proativa da manhã: só dispara se já acordou de fato
          // (confirmado por mensagem) ou passou 45min do remédio estimado
          if (periodo === 'manha') {
            if (!horaAcorda) continue; // sem nenhum sinal, não dispara
            if (!jaAcordouConfirmado) {
              // Só estimativa do remédio — espera 45min pra ter certeza
              const [hAc, mAc] = horaAcorda.split(':').map(Number);
              const diffMin = (now.getHours() * 60 + now.getMinutes()) - (hAc * 60 + mAc);
              if (diffMin < 45) continue;
            }
            // Se já mandou mensagem hoje → já acordou, pode disparar
          }

          // Chancela aleatória — mas se tem assunto em aberto, sempre dispara.
          // CACHEADA por dia: sem isso, numa janela com várias tentativas
          // (ex: a cada 15min por 1h30), a "moeda" seria jogada de novo em
          // cada tentativa e a frequência real subiria muito além do que
          // foi combinado (~50% dos dias sem pendência, não ~50% por tentativa).
          if (!ctxPendencias) {
            const moedaKey = `moeda_${dayKey}`;
            let moeda = await prisma.memory.findFirst({
              where: { userId: user.id, type: 'proativa_moeda', content: { startsWith: moedaKey } }
            }).catch(() => null);
            if (!moeda) {
              // Noite: 80% de chance (mais provável aparecer à noite)
              // Manhã/almoço: 50% de chance
              const limiteSkip = periodo === 'noite' ? 0.2 : 0.5;
              const skip = Math.random() < limiteSkip;
              await prisma.memory.create({
                data: { userId: user.id, type: 'proativa_moeda', content: `${moedaKey}:${skip ? 'skip' : 'ok'}` }
              }).catch(() => {});
              if (skip) continue;
            } else if (moeda.content.endsWith(':skip')) {
              continue;
            }
          }

          // ── Prompt específico por período ──
          // Cada período tem uma "energia" diferente, exemplos concretos
          // do que uma amiga diria, e prioridade de gancho.
          let instrucao = '';
          // Verifica se já tem casa/trabalho cadastrado
          const temCasa = infoPessoal && /Casa:/i.test(infoPessoal);
          const temTrabalho = infoPessoal && /Trabalho:/i.test(infoPessoal);

          if (periodo === 'manha') {
            const pedirGeo = !temCasa ? `
IMPORTANTE: Se não houver assunto urgente pra falar, peça a localização da pessoa de forma natural — diga que assim você consegue saber quando ela chega em casa ou no trabalho e avisar na hora certa. Algo como "me manda sua localização pra eu aprender onde é sua casa e trabalho".` : '';

            instrucao = `É manhã cedo — a pessoa acabou de acordar ou está começando o dia.
Como uma amiga que sabe da rotina dela, você pode:
- Perguntar se dormiu bem, especialmente se ontem teve algo difícil
- Referenciar algo do dia anterior que ficou em aberto de forma natural
- Comentar algo do dia que está por vir se houver compromisso próximo
TOM: curto, genuíno, como quem manda mensagem de manhã pro amigo — sem formalidade${pedirGeo}`;
          } else if (periodo === 'almoco') {
            let curiosidadeAlmocoCtx = '';
            if (!ctxPendencias) {
              const curiosidade = await getProximaCuriosidade(user.id, 'qualquer').catch(() => null);
              if (curiosidade && Math.random() > 0.5) { // 50% das vezes no almoço
                curiosidadeAlmocoCtx = `\nGANCHO OPCIONAL: Se não tiver assunto específico, pode perguntar naturalmente: "${curiosidade.pergunta}". Integre como amiga, nunca como formulário.`;
              }
            }

            instrucao = `É horário de almoço — pausa natural do dia.
Como uma amiga curiosa e presente, você pode:
- Perguntar como está sendo o dia
- Referenciar algo que ficou em aberto recentemente de forma descontraída
- Comentar algo que você sugeriu e a pessoa não respondeu ainda
- Se não tiver nada específico, algo simples e genuíno sobre o almoço/dia
TOM: leve, informal, como uma mensagem rápida entre amigos no almoço${curiosidadeAlmocoCtx}`;
          } else {
            instrucao = `É noite — depois das 20h a pessoa está mais relaxada e receptiva. É o horário mais humano pra conversa leve e genuína.
Como uma amiga que tem vontade de saber como foi o dia:
- Pode simplesmente aparecer com "e aí fedo, o que tá fazendo?" ou uma piada sobre o dia
- Referenciar algo específico que aconteceu hoje (consulta, exame, trabalho, compromisso)
- Retomar assunto em aberto com curiosidade real e tom leve
- Às vezes só zoar ou mandar uma observação engraçada sobre algo que sabe da vida dela
TOM: leve, à vontade, como conversa de fim de dia entre amigos — pode ser mais solta e bem-humorada que de manhã`;
          }

          // Busca humor do dia e localização para enriquecer o contexto
          const humorDia = await getHumorDia(user.id).catch(() => null);
          const localizacao = await getLocalizacao(user.id).catch(() => null);

          const ctxHumor = humorDia
            ? `ESTADO EMOCIONAL ATUAL: ${humorDia.estado}${humorDia.intensidade === 'intenso' ? ' (intenso)' : ''}${humorDia.motivo ? ` — motivo: ${humorDia.motivo}` : ''}. Use isso com naturalidade — se está cansado, seja mais acolhedora; se está doente, seja mais cuidadosa; se está animado, celebre junto.`
            : '';

          const ctxLocal = localizacao?.cidade
            ? `LOCALIZAÇÃO RECENTE: ${localizacao.bairro ? localizacao.bairro + ', ' : ''}${localizacao.cidade}. Pode referenciar isso se for natural (ex: "já chegou em casa?", "como foi a volta?").`
            : '';

          // Filtra remédios do perfil — proativa não deve cobrar remédios
          const infoPessoalFiltrado = (infoPessoal || '').split('\n')
            .filter(l => !/dose|rem[eé]dio|medica[cç]|tiroide|toroide|colesterol|pressao|pressão|estoque/i.test(l))
            .join('\n');

          const systemProativa = `Você é a Clara, parceira pessoal d${prefs.name ? 'o ' + prefs.name.split(' ')[0] : 'o usuário'} no WhatsApp.
SEU TOM: ${tomDesc(prefs.tom)}

${instrucao}

${ctxHumor ? ctxHumor + '\n\n' : ''}${ctxLocal ? ctxLocal + '\n\n' : ''}VOZ PRÓPRIA — USE COM CORAGEM:
- Você tem memória real dessa pessoa. Referencie o passado de forma afetiva: "semana passada você disse...", "desde aquele dia no hospital...", "você ainda não resolveu aquilo do Flavinho né?"
- Não seja genérica — qualquer LLM seria genérico. Você é específica porque conhece essa pessoa de verdade.
- Se souber algo relevante sobre o dia/semana dela, use. Se não souber nada genuíno, mande SKIP.

REGRAS ABSOLUTAS:
- UMA mensagem, 1-2 linhas no máximo
- NUNCA comece com "Oi", "Olá" ou o nome da pessoa
- NÃO agende nada, NÃO liste tarefas, NÃO seja assistente
- NUNCA reproduza exemplos ou frases entre aspas — crie algo original
- NUNCA coloque sua mensagem entre aspas
- Se não tiver NADA genuíno pra dizer, responda APENAS: SKIP

${ctxPendencias ? ctxPendencias + '\n\n' : ''}CONTEXTO RECENTE:
${contextoMems}

${infoPessoalFiltrado || ''}
${horaAcorda ? `(Acordou por volta das ${horaAcorda})` : ''}`;

          const msg = await freeResponse('Mensagem proativa.', [], {
            _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso',
            _systemOverride: systemProativa,
            _maxTokens: 80  // proativa deve ser curta — 1-2 linhas
          });
          if (!msg || msg.trim() === 'SKIP' || msg.length < 5) continue;
          if (isRespostaFallback(msg)) {
            console.log(`[Proativa ${periodo}] ${user.phone}: resposta de fallback genérica recebida — não enviando como proativa`);
            continue;
          }
          await sendMessage(user.phone, msg);
          await prisma.memory.create({
            data: { userId: user.id, type: 'proativa_enviado_lock', content: dayKey }
          }).catch(() => {});
          console.log(`[Proativa ${periodo}] ${user.phone}: ${msg.slice(0, 60)}`);
        } catch (eInner) {
          console.error(`[Proativa] Erro interno ${user.phone}:`, eInner.message);
        }
      } catch (e) { console.error(`[Proativa] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error(`[Proativa ${periodo}] Erro geral:`, e.message); }
}

// ═══════════════════════════════════════════════════════════════════════
// RADAR DA CLARA — domingo 09:30
// ═══════════════════════════════════════════════════════════════════════
cron.schedule('30 9 * * 0', async () => {
  try {
    const users = await prisma.user.findMany({ where: { blocked: false } });
    const now = nowBRT();
    for (const user of users) {
      try {
        const lockKey = `radar_${dateBRT(now)}`;
        if (await prisma.memory.findFirst({ where: { userId: user.id, type: 'radar_lock', content: lockKey } })) continue;
        const tresMesesAtras = new Date(now); tresMesesAtras.setMonth(tresMesesAtras.getMonth() - 3);
        const gastos = await prisma.expense.findMany({ where: { userId: user.id, createdAt: { gte: tresMesesAtras } }, orderBy: { createdAt: 'asc' } });
        if (gastos.length < 6) continue;
        const insights = [];
        const porCategoria = {};
        gastos.forEach(g => { const cat = g.category || 'outro'; (porCategoria[cat] = porCategoria[cat] || []).push(g); });
        for (const [cat, lista] of Object.entries(porCategoria)) {
          if (lista.length < 3) continue;
          const dias = lista.map(g => new Date(g.createdAt).getDate());
          const media = dias.reduce((a, d) => a + d, 0) / dias.length;
          const desvioMedio = dias.map(d => Math.abs(d - media)).reduce((a, d) => a + d, 0) / dias.length;
          if (desvioMedio <= 3) {
            const jaAvisado = await prisma.memory.findFirst({ where: { userId: user.id, type: 'padrao_dia_avisado', content: cat } });
            if (!jaAvisado) {
              const descricoes = [...new Set(lista.map(g => g.description).filter(Boolean))];
              const exemplo = descricoes.slice(0, 2).join(' e ') || null;
              insights.push({ tipo: 'padrao_dia', categoria: cat, exemplo, diaAproximado: Math.round(media) });
            }
          }
        }
        const inicioMesAtual = new Date(now.getFullYear(), now.getMonth(), 1);
        const gastosMesAtual = gastos.filter(g => new Date(g.createdAt) >= inicioMesAtual);
        const gastosAnteriores = gastos.filter(g => new Date(g.createdAt) < inicioMesAtual);
        for (const [cat, listaAtual] of Object.entries(gastosMesAtual.reduce((acc, g) => { const c = g.category || 'outro'; (acc[c] = acc[c] || []).push(g); return acc; }, {}))) {
          const totalAtual = listaAtual.reduce((a, g) => a + g.value, 0);
          const anterioresMesmaCat = gastosAnteriores.filter(g => (g.category || 'outro') === cat);
          if (anterioresMesmaCat.length < 2) continue;
          const porMes = {};
          anterioresMesmaCat.forEach(g => { const d = new Date(g.createdAt); const k = `${d.getFullYear()}-${d.getMonth()}`; porMes[k] = (porMes[k] || 0) + g.value; });
          const mediasHistoricas = Object.values(porMes);
          if (!mediasHistoricas.length) continue;
          const mediaHistorica = mediasHistoricas.reduce((a, v) => a + v, 0) / mediasHistoricas.length;
          if (mediaHistorica > 0 && totalAtual > mediaHistorica * 1.4) {
            const descricoesAtual = [...new Set(listaAtual.map(g => g.description).filter(Boolean))];
            const exemplo = descricoesAtual.slice(0, 2).join(' e ') || null;
            insights.push({ tipo: 'gasto_fora_padrao', categoria: cat, exemplo, percentual: Math.round((totalAtual / mediaHistorica - 1) * 100), valorAtual: totalAtual, valorMedio: mediaHistorica });
          }
        }
        if (!insights.length) continue;
        const prefs = await memory.getUserPreference(user.id).catch(() => null);
        const insightsTexto = insights.map(i => i.tipo === 'padrao_dia'
          ? `- Gastos${i.exemplo ? ` como "${i.exemplo}"` : ` na categoria "${i.categoria}"`} costumam acontecer por volta do dia ${i.diaAproximado}.`
          : `- Gasto${i.exemplo ? ` com "${i.exemplo}"` : ` na categoria "${i.categoria}"`} este mês: R$ ${i.valorAtual.toFixed(2)}, ${i.percentual}% acima da média (R$ ${i.valorMedio.toFixed(2)}).`
        ).join('\n');
        const msg = await freeResponse('Mensagem de radar/padrões.', [], {
          _contexto: '', name: user.name, tom: prefs?.tom || 'carinhoso',
          _systemOverride: `Você é a Clara, assistente pessoal. ${user.name ? `O nome do usuário é ${user.name}.` : ''} Tom: ${prefs?.tom || 'carinhoso'}. Padrões notados:\n${insightsTexto}\nEnvie UMA mensagem natural (2-3 linhas) comentando como observação genuína sobre o GASTO EM SI (o que a pessoa comprou/pagou), nunca sobre o nome da categoria — "categoria" é só um rótulo interno do sistema, não fale dela como se fosse uma coisa real ou tivesse "assinatura com uma data". NÃO use tópicos. NÃO termine com saudação de período.`
        });
        if (!msg || isRespostaFallback(msg)) continue;
        await sendMessage(user.phone, msg);
        await prisma.memory.create({ data: { userId: user.id, type: 'radar_lock', content: lockKey } });
        for (const i of insights.filter(x => x.tipo === 'padrao_dia')) {
          await prisma.memory.create({ data: { userId: user.id, type: 'padrao_dia_avisado', content: i.categoria } }).catch(() => {});
        }
        console.log(`[Radar] Enviado para ${user.phone}`);
      } catch (e) { console.error(`[Radar] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Radar] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ═══════════════════════════════════════════════════════════════════════
// TRADIÇÃO SEXTA (17:00)
// ═══════════════════════════════════════════════════════════════════════
// Cron de sexta-feira 17h removido — não era parte do comportamento padrão

// ═══════════════════════════════════════════════════════════════════════
// TRADIÇÃO DOMINGO (19:00) — REMOVIDA
// ═══════════════════════════════════════════════════════════════════════
// Mesma decisão do manhã/almoço: só bom dia, boa noite e chamada combinada.
// cron.schedule('0 19 * * 0', async () => {
//   try {
//     const users = await prisma.user.findMany({ where: { blocked: false } });
//     const now = nowBRT();
//     const semanaQ = new Date(now); semanaQ.setDate(now.getDate() + 1);
//     const fimSemanaQ = new Date(now); fimSemanaQ.setDate(now.getDate() + 7);
//     for (const user of users) {
//       try {
//         if (!(await tentarLockDiario(user.id, 'domingo_enviado'))) continue;
//         const [lembretesSemana, { prefs }, infoPessoal] = await Promise.all([
//           prisma.reminder.findMany({ where: { userId: user.id, confirmed: false, sent: false, scheduledAt: { gte: semanaQ, lte: fimSemanaQ } }, orderBy: { scheduledAt: 'asc' }, take: 5 }),
//           getUserContext(user),
//           memory.buildPersonalContext(user.id)
//         ]);
//         const ctx = `É domingo à noite, véspera de uma nova semana.\n${lembretesSemana.length > 0 ? `Próximos compromissos:\n${lembretesSemana.map(r => `• ${r.message}`).join('\n')}` : 'Sem compromissos agendados para a semana.'}\n${infoPessoal}`;
//         const msg = await freeResponse('Envie mensagem de domingo.', [], {
//           _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso',
//           _systemOverride: `Você é a Clara, assistente pessoal. ${user.name ? `O nome é ${user.name}.` : ''} Envie uma mensagem de domingo à noite — tranquila, motivadora e breve (2-3 linhas). NÃO liste tarefas. NÃO agende nada. Tom: ${prefs.tom || 'carinhoso'}.\n${ctx}`
//         });
//         if (!msg || isRespostaFallback(msg)) continue;
//         await sendMessage(user.phone, msg);
//       } catch (e) { console.error(`[Domingo] Erro ${user.phone}:`, e.message); }
//     }
//   } catch (e) { console.error('[Domingo] Erro geral:', e.message); }
// }, { timezone: 'America/Sao_Paulo' });

// ═══════════════════════════════════════════════════════════════════════
// SUMIÇO — REMOVIDA (mesma decisão: só bom dia, boa noite, chamada combinada)
// ═══════════════════════════════════════════════════════════════════════
// cron.schedule('0 9 * * *', async () => {
//   try {
//     const users = await prisma.user.findMany({ where: { blocked: false } });
//     const now = nowBRT();
//     for (const user of users) {
//       try {
//         const lockKey = `sumico_${dateBRT()}`;
//         if (await prisma.memory.findFirst({ where: { userId: user.id, type: 'sumico_lock', content: lockKey } })) continue;
//         const ultimaConversa = await prisma.memory.findFirst({ where: { userId: user.id, type: 'conversa' }, orderBy: { createdAt: 'desc' } });
//         if (!ultimaConversa) continue;
//         const diasSemConversa = Math.round((now - new Date(ultimaConversa.createdAt)) / (1000 * 60 * 60 * 24));
//         if (diasSemConversa < 5 || diasSemConversa > 7) continue;
//         const { prefs } = await getUserContext(user);
//         const infoPessoal = await memory.buildPersonalContext(user.id);
//         const msg = await freeResponse('Mensagem para usuário que sumiu.', [], {
//           _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso',
//           _systemOverride: `Você é a Clara, assistente pessoal. ${user.name ? `O nome é ${user.name}.` : ''} O usuário não conversa com você há ${diasSemConversa} dias. Envie uma mensagem curta e genuína perguntando como ele está — sem ser dramática, sem cobrar. Máx 2 linhas. Tom: ${prefs.tom || 'carinhoso'}.\n${infoPessoal}`
//         });
//         if (!msg || isRespostaFallback(msg)) continue;
//         await sendMessage(user.phone, msg);
//         await prisma.memory.create({ data: { userId: user.id, type: 'sumico_lock', content: lockKey } });
//       } catch (e) { console.error(`[Sumiço] Erro ${user.phone}:`, e.message); }
//     }
//   } catch (e) { console.error('[Sumiço] Erro geral:', e.message); }
// }, { timezone: 'America/Sao_Paulo' });

// ═══════════════════════════════════════════════════════════════════════
// LEMBRETES — a cada minuto
//
// ARQUITETURA ANTI-DUPLICAÇÃO (3 camadas independentes):
//
// Camada 1 — tentarLockMinuto: otimização que tenta impedir que dois
//   containers processem a fila no mesmo minuto. Pode falhar em race
//   conditions extremas — por isso NÃO é a barreira principal.
//
// Camada 2 — Claim atômico por lembrete: updateMany WHERE sent:false →
//   sent:true. Esta é a barreira REAL e matematicamente garantida.
//   Só um processo consegue mudar sent:false → true. Mesmo que múltiplos
//   containers passem pelo lock do Camada 1, cada lembrete só é enviado
//   uma vez. Esta camada nunca falha contanto que o banco seja ACID.
//
// Camada 3 — whatsapp.js dedup de saída: mesmo texto pro mesmo número
//   dentro de 90s é bloqueado. Última defesa contra retries da UazAPI.
// ═══════════════════════════════════════════════════════════════════════
cron.schedule('* * * * *', async () => {
  try {
    // Camada 1: lock por minuto (otimização, não barreira principal)
    if (!(await tentarLockMinuto('lock_cron_lembretes'))) return;

    const now = new Date();
    const reminders = await prisma.reminder.findMany({
      where: { sent: false, confirmed: false, scheduledAt: { lte: now } },
      orderBy: { scheduledAt: 'asc' }
    });
    if (!reminders.length) return;

    const grupos = {};
    for (const r of reminders) {
      const hora = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
      const key = `${r.phone}_${hora}`;
      if (!grupos[key]) grupos[key] = { phone: r.phone, hora, reminders: [] };
      grupos[key].reminders.push(r);
    }

    for (const key of Object.keys(grupos)) {
      const grupo = grupos[key];

      // Cancela follow-ups cujo original já foi confirmado
      const reminderesParaEnviar = [];
      for (const r of grupo.reminders) {
        const matchOrigem = r.message.match(/^__followup_origem__([^_]+)__/);
        if (matchOrigem) {
          const original = await prisma.reminder.findUnique({ where: { id: matchOrigem[1] } }).catch(() => null);
          if (!original || original.confirmed) {
            await prisma.reminder.delete({ where: { id: r.id } }).catch(() => {});
            continue;
          }
        }
        reminderesParaEnviar.push(r);
      }
      if (!reminderesParaEnviar.length) continue;
      grupo.reminders = reminderesParaEnviar;

      // ── Camada 2a: Lock por ID no banco (pré-claim) ──
      // Cria um registro de lock ANTES do updateMany. Se dois containers
      // chegarem ao mesmo tempo, o segundo encontra o lock já existente
      // via findFirst e descarta o grupo sem nem tentar o claim.
      // Isso fecha a janela de race condition do updateMany em cenários
      // de alta concorrência (ex: Railway subindo container novo enquanto
      // o antigo ainda respira).
      const lockLembreteKey = `reminder_sending_${grupo.reminders.map(r => r.id).sort().join('_')}`;
      const lockExistente = await prisma.memory.findFirst({
        where: { type: 'reminder_lock', content: lockLembreteKey }
      }).catch(() => null);
      if (lockExistente) {
        // ── TTL no lock (corrige deadlock) ──
        // Um lock de reminder só é legítimo enquanto o processo que o criou
        // ainda está enviando — o que leva poucos segundos. Se o lock tem
        // mais de 2 minutos, o processo que o criou MORREU sem limpá-lo
        // (deploy no meio do envio, crash, timeout da UazAPI). Antes, esse
        // lock órfão fazia o cron pular o grupo PRA SEMPRE — o lembrete
        // (sent:false) reaparecia a cada minuto, batia no mesmo lock e
        // logava "Lock já existe" em loop infinito, engasgando os outros
        // crons (remédios, proativas). Agora, lock velho é tratado como
        // morto: apaga e segue, deixando este processo assumir o envio.
        const ageMs = Date.now() - new Date(lockExistente.createdAt).getTime();
        if (ageMs < 120000) {
          console.log(`[Reminder] Lock ativo (${Math.round(ageMs/1000)}s) para grupo ${grupo.hora} ${grupo.phone} — outro processo enviando`);
          continue;
        }
        console.log(`[Reminder] Lock ÓRFÃO (${Math.round(ageMs/1000)}s) removido para grupo ${grupo.hora} ${grupo.phone} — assumindo envio`);
        await prisma.memory.delete({ where: { id: lockExistente.id } }).catch(() => {});
      }
      try {
        await prisma.memory.create({
          data: { userId: grupo.reminders[0].userId, type: 'reminder_lock', content: lockLembreteKey }
        });
      } catch (eLock) {
        // Outro processo criou o lock entre nosso findFirst e create
        console.log(`[Reminder] Corrida no lock para grupo ${grupo.hora} ${grupo.phone} — descartando`);
        continue;
      }

      // ── Camada 2b: Claim atômico — barreira REAL anti-duplicação ──
      // Marca sent:true ANTES de enviar. Se dois processos chegarem aqui
      // ao mesmo tempo, só o primeiro que conseguir mudar sent:false → true
      // prossegue. O segundo recebe count:0 e é descartado.
      const claimados = [];
      for (const r of grupo.reminders) {
        const res = await prisma.reminder.updateMany({
          where: { id: r.id, sent: false },
          data: { sent: true }
        });
        if (res.count === 1) {
          claimados.push(r);
        } else {
          console.log(`[Reminder] Claim FALHOU para ${r.id.slice(-6)} (count:${res.count}) — já enviado por outro processo, pulando`);
        }
      }
      if (!claimados.length) continue;
      grupo.reminders = claimados;

      // ── Monta a mensagem ──
      let msg;
      try {
        const isFollowup = grupo.reminders.length === 1 && /^__followup_origem__[^_]+__/.test(grupo.reminders[0].message);
        if (isFollowup) {
          msg = grupo.reminders[0].message.replace(/^__followup_origem__[^_]+__/, '');
        } else {
          // Se está rolando conversa ativa (últimos 5 min), avisa de forma
          // natural misturada no papo, em vez do template de sistema —
          // isso existia antes e se perdeu numa sessão anterior.
          const conversaAtiva = await houveConversaRecente(grupo.reminders[0].userId, 5).catch(() => false);
          let msgNatural = null;
          if (conversaAtiva) {
            try {
              const prefsNat = await memory.getUserPreference(grupo.reminders[0].userId).catch(() => ({}));
              const afetivaNat = await memory.getMemoriaAfetiva(grupo.reminders[0].userId).catch(() => ({}));
              const nomeNat = afetivaNat?.apelido_usuario || prefsNat?.name || '';
              const titulosNat = grupo.reminders.map(r => r.message).join(', ');
              const systemLembreteNatural = `Vocês estão no meio de uma conversa agora. Chegou a hora de um lembrete que ${nomeNat || 'a pessoa'} pediu: "${titulosNat}". Avise de forma NATURAL, misturado no papo — nada de formato de notificação, nada de emoji de sino, nada de "⏰ hora". Só um comentário curto no seu tom lembrando. Ex: "Ei, lembrando que é hora de X!" ou "Opa, bateu a hora de Y aqui 👀".`;
              const respNatural = await freeResponse('(lembrete durante conversa)', [], { _contexto: '', name: prefsNat?.name || '', tom: prefsNat?.tom || 'carinhoso', _systemOverride: systemLembreteNatural, _maxTokens: 100 });
              if (respNatural && !isRespostaFallback(respNatural)) msgNatural = respNatural;
            } catch (eNat) { console.error('[Reminder] Erro ao gerar lembrete natural:', eNat.message); }
          }
          if (msgNatural) {
            msg = msgNatural;
          } else if (grupo.reminders.length === 1) {
            const r = grupo.reminders[0];
            msg = `🔔 Lembrete\n\n${r.message}\n⏰ ${grupo.hora}\n\n${finalParaLembrete(r)}`;
          } else {
            const titulos = grupo.reminders.map((r, i) => `${i + 1}. ${r.message}`).join('\n');
            const rRef = grupo.reminders[0];
            msg = `🔔 Você tem ${grupo.reminders.length} lembretes agora\n\n${titulos}\n\n⏰ ${grupo.hora}\n\n${finalParaLembrete(rRef)}`;
          }
        }
      } catch (e) {
        const r = grupo.reminders[0];
        msg = grupo.reminders.length === 1
          ? `🔔 Lembrete\n\n${r.message}\n⏰ ${grupo.hora}\n\n${finalParaLembrete(r)}`
          : `🔔 Você tem ${grupo.reminders.length} lembretes agora\n\n${grupo.reminders.map((r,i)=>`${i+1}. ${r.message}`).join('\n')}\n\n⏰ ${grupo.hora}\n\n${finalParaLembrete(grupo.reminders[0])}`;
      }

      await sendMessage(grupo.phone, msg);
      console.log(`[Reminder] ${grupo.phone} → ${grupo.reminders.length} lembrete(s) às ${grupo.hora} | enviado por instância ${INSTANCE_ID} | ids: ${grupo.reminders.map(r => r.id.slice(-6)).join(',')}`);

      // ── Limpa o lock IMEDIATAMENTE após enviar ──
      // O lock só existe pra impedir envio duplo durante o envio. Já que
      // terminou, apaga agora — não espera o cron de limpeza das 03:00.
      // Sem isso, o lock ficava vivo até a madrugada e, se algo o tornasse
      // órfão antes disso, virava deadlock. (O claim atômico sent:true já
      // é a barreira real contra duplicação; o lock é só otimização.)
      await prisma.memory.deleteMany({ where: { type: 'reminder_lock', content: lockLembreteKey } }).catch(() => {});
    }
  } catch (e) { console.error('[Reminder] Erro:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ═══════════════════════════════════════════════════════════════════════
// MEDICAMENTOS — a cada minuto
//
// Agrupamento: remédios do mesmo usuário no mesmo horário chegam em UMA
// mensagem só. Antes chegavam em mensagens separadas, o que causava:
// 1) Experiência ruim (2 notificações em sequência)
// 2) Bug: swipe-reply no segundo remédio retornava "Feito" idêntico ao
//    primeiro → dedup do whatsapp.js bloqueava a segunda confirmação
//    → segundo remédio nunca era decrementado via swipe-reply.
// ═══════════════════════════════════════════════════════════════════════
cron.schedule('* * * * *', async () => {
  try {
    const nowLocal = nowBRT();
    const minutoChave = `${pad(nowLocal.getHours())}:${pad(nowLocal.getMinutes())}`;

    const meds = await prisma.medication.findMany({
      where: { active: true, remaining: { gt: 0 } },
      include: { user: true }
    });

    // Agrupa remédios por usuário (phone) para o horário atual
    const gruposPorPhone = {};
    for (const med of meds) {
      let horarios = [];
      try { horarios = JSON.parse(med.times || '[]'); } catch {}
      if (!horarios.includes(minutoChave)) continue;

      const phone = med.user?.phone || (await prisma.user.findUnique({ where: { id: med.userId } }))?.phone;
      if (!phone) continue;

      // Adiciona ao grupo — lock é verificado depois, por grupo completo
      if (!gruposPorPhone[phone]) gruposPorPhone[phone] = { meds: [], userId: med.userId };
      gruposPorPhone[phone].meds.push(med);
    }

    // Processa cada grupo (um envio por usuário por horário)
    for (const [phone, grupo] of Object.entries(gruposPorPhone)) {
      try {
        // ── CLAIM POR LOCK NO MEMORY (substitui o claim por updatedAt) ──
        // BUG RAIZ CORRIGIDO: o claim anterior usava
        //   where: { id, updatedAt: { lt: inicioMinuto } }
        // Mas no schema o campo é `updatedAt DateTime?` SEM `@updatedAt` —
        // ou seja, é OPCIONAL e nunca é preenchido automaticamente, então
        // fica NULL no banco. Em SQL, `NULL < qualquer_valor` é NULL (não
        // TRUE), logo o WHERE nunca casava, claim.count vinha 0 e TODO
        // remédio era pulado com "já enviado neste minuto" — sem jamais
        // ter sido enviado. (O diagnóstico mostrou updatedAt = epoch 0.)
        //
        // Solução sem mexer no schema: um lock por remédio+minuto na tabela
        // Memory (mesmo padrão `med_lock` usado em outras partes do código).
        // Quem cria o lock primeiro envia; os demais processos encontram o
        // lock e pulam. O decremento de `remaining` acontece só pra quem
        // ganhou o lock. O lock é limpo pelo cron de "med_lock" de hora em
        // hora (já existe). Não depende de updatedAt.
        const inicioMinuto = new Date(Math.floor(Date.now() / 60000) * 60000);

        const medsParaEnviar = [];
        for (const med of grupo.meds) {
          const lockKey = `${med.id}_${dateBRT(nowBRT())}_${minutoChave}`;
          // Verifica lock existente deste minuto
          const lockExistente = await prisma.memory.findFirst({
            where: { type: 'med_lock', content: lockKey }
          }).catch(() => null);
          if (lockExistente) {
            console.log(`[Med] ${med.name} já enviado neste minuto (lock existe) — pulando`);
            continue;
          }
          // Cria o lock (barreira anti-duplicação). Se dois processos
          // chegarem juntos, o segundo create pode falhar ou criar duplicata;
          // a checagem acima + raridade de 2 donos de cron tornam isso seguro.
          try {
            await prisma.memory.create({
              data: { userId: med.userId, type: 'med_lock', content: lockKey }
            });
          } catch (eLock) {
            console.log(`[Med] ${med.name} corrida no lock — pulando`);
            continue;
          }
          // Ganhou o lock: NÃO decrementa aqui. O estoque só é decrementado
          // quando a pessoa CONFIRMA que tomou (via WhatsApp em webhook.js
          // ou pelo botão do Dashboard em forms.js) — decrementar no envio
          // causava desconto em dobro e, principalmente, deixava de criar
          // a pendência de confirmação abaixo, quebrando a confirmação padrão.
          medsParaEnviar.push(med);
        }

        // Envia os remédios reivindicados (mensagem própria = swipe individual)
        for (let i = 0; i < medsParaEnviar.length; i++) {
          const med = medsParaEnviar[i];
          const msg = `💊 Hora do medicamento!\n\n*${med.name}*\n⏰ ${minutoChave}\n\nNão esquece de tomar certinho 😊\n\n💜 Restam ${med.remaining - 1} doses.`;
          try {
            await sendMessage(phone, msg);
            // Cria a pendência de confirmação — é o que faz "tomei"/"tomado"
            // no WhatsApp (webhook.js) e o botão do Dashboard (forms.js)
            // saberem qual remédio confirmar e decrementarem o estoque só
            // nesse momento, em vez de caírem na resposta genérica da Clara.
            await prisma.memory.create({
              data: {
                userId: med.userId,
                type: 'confirmacao_pendente',
                content: JSON.stringify({
                  tipo: 'remedio_dose',
                  medId: med.id,
                  medNome: med.name,
                  expira: Date.now() + 3 * 60 * 60 * 1000 // 3h pra confirmar
                })
              }
            }).catch(() => {});
            console.log(`[Med] ${med.name} → ${phone}`);
          } catch (eSend) {
            console.error(`[Med] Falha ao ENVIAR ${med.name} para ${phone} — apagando lock pra tentar de novo:`, eSend.message);
            // Apaga o lock deste minuto pra permitir reenvio no próximo ciclo
            const lockKeyRevert = `${med.id}_${dateBRT(nowBRT())}_${minutoChave}`;
            await prisma.memory.deleteMany({
              where: { type: 'med_lock', content: lockKeyRevert }
            }).catch(() => {});
          }
          if (i < medsParaEnviar.length - 1) await new Promise(r => setTimeout(r, 3000));
        }
      } catch (e) {
        console.error(`[Med] Erro ao enviar grupo para ${phone}:`, e.message);
      }
    }
  } catch (e) { console.error('[Med] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ═══════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════
// ACOMPANHAMENTO DE EPISÓDIOS DA VIDA — verifica a cada hora
// Pergunta como foi um evento depois do tempo definido, de forma natural
// ═══════════════════════════════════════════════════════════════════════
cron.schedule('0 * * * *', async () => {
  try {
    const agora = new Date();
    const episodios = await prisma.memory.findMany({
      where: { type: 'episodio_vida' },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
      take: 50
    });

    for (const ep of episodios) {
      if (!ep.user?.phone) continue;
      let meta = {}; try { meta = JSON.parse(ep.metadata || '{}'); } catch {}
      if (meta.perguntado) continue;
      if (!meta.checkInAt || new Date(meta.checkInAt) > agora) continue;
      if (!(await houveConversaRecente(ep.userId, 60 * 24))) continue; // ativo nos últimos 24h

      // Marca como perguntado antes de disparar
      await prisma.memory.update({
        where: { id: ep.id },
        data: { metadata: JSON.stringify({ ...meta, perguntado: true }) }
      }).catch(() => {});

      const ctx = `[ACOMPANHAMENTO DE EPISÓDIO] Há ${Math.round((agora - new Date(ep.createdAt)) / 86400000)} dia(s) você registrou: "${ep.content}". Pergunte como foi/está de forma natural e humana, integrada ao seu tom — não como formulário. Ex: "ei, e aquela ${ep.content.split(' ').slice(0,3).join(' ')}... como foi?" — curto e genuíno.`;

      ;(async () => {
        try {
          const history = await memory.getConversationHistory(ep.userId, 4).catch(() => []);
          const prefs = await memory.getUserPreference(ep.userId).catch(() => ({}));
          prefs._contexto = ctx;
          prefs._skipSaveHistory = true;
          const resposta = await Promise.race([
            freeResponse('', history, prefs),
            new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 10000))
          ]).catch(() => null);
          if (resposta && !isRespostaFallback(resposta)) {
            await sendMessage(ep.user.phone, resposta);
            console.log(`[Episódio] Acompanhamento enviado para ${ep.user.phone}: "${ep.content}"`);
          }
        } catch(e) { console.error('[Episódio] erro acompanhamento:', e.message); }
      })();
    }
  } catch(e) { console.error('[Episódio] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ═══════════════════════════════════════════════════════════════════════
// AVISO ANTECIPADO — 1h e 30min antes de compromissos/tarefas
// Remédios NÃO entram aqui — só o alerta formal na hora certa.
// Só dispara se o usuário estiver conversando ativamente (últimos 20min).
// ═══════════════════════════════════════════════════════════════════════
cron.schedule('* * * * *', async () => {
  try {
    const now = nowBRT();
    const em30m = new Date(now.getTime() + 30 * 60 * 1000);
    const em61m = new Date(now.getTime() + 61 * 60 * 1000);

    const proximos = await prisma.reminder.findMany({
      where: { sent: false, confirmed: false, scheduledAt: { gte: em30m, lte: em61m } },
      include: { user: true }
    });

    for (const r of proximos) {
      if (!r.user?.phone) continue;
      const userId = r.user.id;
      const phone = r.user.phone;
      const minRestantes = Math.round((new Date(r.scheduledAt) - now) / 60000);
      const janela = minRestantes <= 31 ? '30min' : '1h';

      // Só avisa se há conversa ativa nos últimos 20 minutos
      if (!(await houveConversaRecente(userId, 20))) continue;

      // Verifica se já avisou nessa janela
      const lockKey = `aviso_antecipado_${r.id}_${janela}`;
      const jaAvisou = await prisma.memory.findFirst({
        where: { userId, type: 'aviso_antecipado_lock', content: lockKey }
      }).catch(() => null);
      if (jaAvisou) continue;

      await prisma.memory.create({
        data: { userId, type: 'aviso_antecipado_lock', content: lockKey }
      }).catch(() => {});

      const horaBRT = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', {
        timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit'
      });
      const tempoTexto = janela === '1h' ? 'daqui uma hora' : 'daqui meia hora';
      const ctx = `[AVISO ANTECIPADO] ${tempoTexto} você tem: "${r.message}" às ${horaBRT}. Mencione de forma MUITO natural e curta — como uma amiga que lembrou no meio da conversa. Uma frase só. Ex: "ah, e ${tempoTexto} você tem ${r.message}, vai se preparando!" — sem ser formal, sem cortar o assunto.`;

      // Salva aviso pendente — será injetado na próxima resposta da Clara
      // de forma natural, sem mensagem separada que corta a conversa.
      const avisoTexto = `${r.message} às ${horaBRT} (${tempoTexto})`;
      await prisma.memory.create({
        data: { userId, type: 'aviso_pendente', content: avisoTexto }
      }).catch(() => {});
      console.log(`[AvisoAntecipado] Pendente salvo — ${phone}: ${r.message}`);
    }

    // Limpa locks com mais de 2h
    await prisma.memory.deleteMany({
      where: { type: 'aviso_antecipado_lock', createdAt: { lte: new Date(Date.now() - 2 * 60 * 60 * 1000) } }
    }).catch(() => {});

  } catch (e) { console.error('[AvisoAntecipado] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ═══════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════
// CHAMADA COMBINADA — verifica a cada minuto
// Quando usuário pediu pra ser chamado (ou ela decidiu chamar),
// dispara no horário combinado com variação natural de ±5min
// ═══════════════════════════════════════════════════════════════════════
cron.schedule('* * * * *', async () => {
  try {
    const agora = nowBRT();
    const hora = agora.getHours();

    // Não chama de madrugada — só entre 7h e 23h
    if (hora < 7 || hora >= 23) return;

    const hAtual = `${String(agora.getHours()).padStart(2,'0')}:${String(agora.getMinutes()).padStart(2,'0')}`;

    const chamadas = await prisma.memory.findMany({
      where: { type: 'chamada_combinada' },
      include: { user: true }
    });

    for (const chamada of chamadas) {
      if (!chamada.user?.phone) continue;
      let meta = {}; try { meta = JSON.parse(chamada.metadata || '{}'); } catch {}

      // Verifica se expirou
      if (meta.expira && Date.now() > meta.expira) {
        await prisma.memory.delete({ where: { id: chamada.id } }).catch(() => {});
        continue;
      }

      const horaCombinada = chamada.content || meta.hora;
      if (!horaCombinada) continue;

      // Janela de -3 a 0min do horário combinado — chega um pouco ANTES,
      // nunca depois. Decisão explícita: dá sensação humana (quem liga
      // raramente acerta o minuto exato, geralmente chama um tico antes).
      const [hC, mC] = horaCombinada.split(':').map(Number);
      const minCombinado = hC * 60 + mC;
      const minAtual = agora.getHours() * 60 + agora.getMinutes();
      const diff = minAtual - minCombinado;
      if (diff < -3 || diff > 0) continue; // só dispara de 3min antes até a hora exata, nunca depois

      // Deleta antes de disparar (evita duplicata)
      await prisma.memory.delete({ where: { id: chamada.id } }).catch(() => {});

      // Gera mensagem natural
      const userId = chamada.userId;
      const phone = chamada.user.phone;

      // Não dispara se já houve bom dia ou proativa nos últimos 10 min
      const proativaRecente = await prisma.memory.findFirst({
        where: {
          userId,
          type: { in: ['bom_dia_enviado', 'boa_noite_enviado', 'proativa_lock'] },
          createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) }
        }
      }).catch(() => null);
      if (proativaRecente) {
        console.log(`[ChamadaCombinada] Adiando 10min — proativa recente para ${phone}`);
        // Readiciona com +10min pra tentar depois
        await prisma.memory.create({
          data: { userId, type: 'chamada_combinada', content: horaCombinada,
            metadata: JSON.stringify({ hora: horaCombinada, expira: Date.now() + 30 * 60 * 1000 }) }
        }).catch(() => {});
        continue;
      }

      // Não dispara se usuário já conversou nos últimos 15 min — já está em papo
      if (await houveConversaRecente(userId, 5)) {
        console.log(`[ChamadaCombinada] Adiando — usuário conversou nos últimos 5min ${phone}`);
        continue;
      }

      const history = await memory.getConversationHistory(userId, 4).catch(() => []);
      const prefs = await memory.getUserPreference(userId).catch(() => ({}));
      const memAfetivaChamada = await memory.getMemoriaAfetiva(userId).catch(() => ({}));
      const nome = memAfetivaChamada?.apelido_usuario || prefs?.name || '';
      const relMemChamada = await prisma.memory.findFirst({ where: { userId, type: 'relationship_summary' }, orderBy: { createdAt: 'desc' } }).catch(() => null);
      const contextoRelChamada = relMemChamada?.content ? `\n\n[MEMÓRIA DO RELACIONAMENTO]\n${relMemChamada.content}` : '';

      // Contexto salvo no momento do combinado (assunto que estava rolando)
      let ctxCombinado = '';
      try {
        const metaCtx = JSON.parse(chamada.metadata || '{}');
        if (metaCtx.ctxCombinado) {
          ctxCombinado = `\n\n[CONTEXTO DO COMBINADO — o que estavam conversando quando combinou]\n${metaCtx.ctxCombinado}`;
        }
      } catch {}

      const ctx = `[CHAMADA COMBINADA] Você combinou de chamar ${nome || 'o usuário'} agora (${horaCombinada}). Apareça de forma natural — retome o assunto que ficou pendente, use o contexto abaixo. NÃO apareça genérica. NÃO diga "passei pra ver se você está bem".${ctxCombinado}${contextoRelChamada}`;

      // Tenta gerar mensagem contextual — retry duplo + fallback garantido
      let resposta = null;
      try {
        resposta = await Promise.race([
          freeResponse('', history, { ...prefs, _contexto: ctx }),
          new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 10000))
        ]);
      } catch {}

      if (!resposta || isRespostaFallback(resposta)) {
        await new Promise(r => setTimeout(r, 4000));
        try {
          resposta = await Promise.race([
            freeResponse('', history, { ...prefs, _contexto: ctx }),
            new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))
          ]);
        } catch {}
      }

      // Fallback sempre garante que ela aparece — nunca silêncio
      if (!resposta || isRespostaFallback(resposta)) {
        const fallbacks = nome
          ? [`e aí, ${nome}? 😏`, `oi ${nome}! apareci 😄`, `${nome}... chegou a hora 😏`]
          : [`e aí? 😏`, `oi! apareci 😄`, `chegou a hora 😏`];
        resposta = fallbacks[Math.floor(Math.random() * fallbacks.length)];
        console.log(`[ChamadaCombinada] Fallback para ${phone}`);
      }

      if (resposta) {
        await sendMessage(phone, resposta);
        await memory.saveConversationMessage(userId, 'assistant', resposta).catch(() => {});
        console.log(`[ChamadaCombinada] Disparada para ${phone} às ${hAtual}`);
      }
    }
  } catch(e) { console.error('[ChamadaCombinada] Erro:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ═══════════════════════════════════════════════════════════════════════
// MENSAGENS AGENDADAS PARA CONTATOS — a cada minuto
// ═══════════════════════════════════════════════════════════════════════
cron.schedule('* * * * *', async () => {
  try {
    const now = nowBRT();
    const msgs = await prisma.scheduledMessage.findMany({ where: { sent: false, scheduledAt: { lte: now } }, orderBy: { scheduledAt: 'asc' } });
    for (const msg of msgs) {
      try {
        const userRemetente = await prisma.user.findFirst({ where: { phone: msg.fromPhone } });
        const nomeRemetente = userRemetente?.name || 'seu contato';
        const foneFormatado = msg.fromPhone.replace('55', '').replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
        const msgFormatada = `Oi! Sou a Clara, secretária virtual do ${nomeRemetente}. Ele(a) pediu pra enviar esse recado:\n\n_${msg.message}_\n\nNão precisa me responder, tá? Dúvidas, é só chamar no WhatsApp do ${nomeRemetente}: ${foneFormatado} 😊`;
        await sendMessage(msg.toPhone, msgFormatada);
        await prisma.scheduledMessage.update({ where: { id: msg.id }, data: { sent: true } });
        const horaBRT = new Date(msg.scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
        await sendMessage(msg.fromPhone, `✅ Mensagem enviada para *${msg.toName || msg.toPhone}* às ${horaBRT}! 📤`);
        console.log(`[Msg Agendada] Enviada: ${msg.toName || msg.toPhone}`);
      } catch (e) { console.error(`[Msg Agendada] Erro ${msg.id}:`, e.message); }
    }
  } catch (e) { console.error('[Msg Agendada] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ═══════════════════════════════════════════════════════════════════════
// TIMEOUT DE LEMBRETES SEM HORÁRIO DEFINIDO — a cada minuto
// ═══════════════════════════════════════════════════════════════════════
cron.schedule('* * * * *', async () => {
  try {
    const pendentes = await prisma.memory.findMany({ where: { type: 'confirmacao_pendente' } });
    for (const p of pendentes) {
      try {
        let dados; try { dados = JSON.parse(p.content); } catch { continue; }
        if (dados.tipo === 'remedio_dose' || dados.tipo === 'fechamento_pendentes') {
          // Essas pendências não geram nenhuma ação automática ao expirar —
          // só removemos a flag pra não ficar "aguardando confirmação" pra
          // sempre no Dashboard quando a pessoa simplesmente não respondeu.
          if (dados.expira && Date.now() > dados.expira) {
            await prisma.memory.delete({ where: { id: p.id } }).catch(() => {});
          }
          continue;
        }
        if (dados.tipo !== 'hora_lembrete') continue;
        if (Date.now() <= dados.expira) continue;
        const user = await prisma.user.findUnique({ where: { id: p.userId } }).catch(() => null);
        if (!user?.phone) { await prisma.memory.delete({ where: { id: p.id } }).catch(() => {}); continue; }
        const scheduledAt = new Date(`${dados.data}T09:00:00-03:00`);
        await prisma.reminder.create({ data: { userId: user.id, phone: user.phone, message: dados.titulo, scheduledAt } });
        await prisma.memory.delete({ where: { id: p.id } }).catch(() => {});
        const dataFmt = scheduledAt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
        await sendMessage(user.phone, `⏰ Não me respondeu o horário, então deixei "${dados.titulo}" pra ${dataFmt} às 09:00 (provisório). Pode me dizer o horário certo a qualquer momento 😊`);
        console.log(`[HoraLembrete] Finalizado com 09:00 provisório: "${dados.titulo}" → ${user.phone}`);
      } catch (e) { console.error(`[HoraLembrete] Erro ${p.id}:`, e.message); }
    }
  } catch (e) { console.error('[HoraLembrete] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ═══════════════════════════════════════════════════════════════════════
// PARCEIRA — aviso 30min antes de compromissos IMPORTANTES
// ═══════════════════════════════════════════════════════════════════════
cron.schedule('* * * * *', async () => {
  try {
    const now = nowBRT();
    const em30min = new Date(now.getTime() + 30 * 60 * 1000);
    const em31min = new Date(now.getTime() + 31 * 60 * 1000);
    const proximos = await prisma.reminder.findMany({ where: { sent: false, confirmed: false, scheduledAt: { gte: em30min, lt: em31min } } });
    if (!proximos.length) return;
    const URGENCIA_RE = /medico|médico|médica|medica|consulta|dentista|cirurgia|exame|laboratorio|laboratório|farmacia|farmácia|vacina|hospital|clinica|clínica|psico|terapia|fisio|upa|reuniao|reunião|apresentacao|apresentação|entrevista|prova|concurso|voo|aeroporto|embarque|onibus|ônibus|trem|documento|cartorio|cartório|contrato|assinar|protocolar|prazo|vencimento|vence|renovar|passaporte|entrega|importante|urgente|cnh|rg/i;
    for (const r of proximos) {
      try {
        if (!URGENCIA_RE.test(r.message)) continue;
        const lockKey = `parceira_${r.id}`;
        if (await prisma.memory.findFirst({ where: { type: 'parceira_lock', content: lockKey } })) continue;
        await prisma.memory.create({ data: { userId: r.userId, type: 'parceira_lock', content: lockKey } });
        const user = await prisma.user.findFirst({ where: { id: r.userId } });
        if (!user?.phone) continue;
        const prefs = await memory.getUserPreference(r.userId).catch(() => null);
        const nome = prefs?.name || user.name || null;
        const infoPessoal = await memory.buildPersonalContext(r.userId).catch(() => '');
        const hora = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
        const systemParceira = `Você é a Clara, parceira pessoal do ${nome || 'usuário'} no WhatsApp.
Tom: ${tomDesc(prefs?.tom)}
Daqui a 30 minutos ele(a) tem algo IMPORTANTE: "${r.message}" às ${hora}.
${infoPessoal ? `O que você sabe sobre ele(a):\n${infoPessoal}` : ''}
Envie UMA mensagem curta (1-2 linhas) como parceira presente:
- Mencione o compromisso de forma natural
- Ofereça ajuda específica para aquele contexto
- NÃO use "lembrete" ou "aviso" — seja natural
- NUNCA termine com "boa sorte" ou saudação de período`;
        const msg = await freeResponse('Mensagem de parceira.', [], { _contexto: '', name: nome, tom: prefs?.tom || 'carinhoso', _systemOverride: systemParceira });
        if (!msg || msg.length < 5 || isRespostaFallback(msg)) continue;
        await sendMessage(user.phone, msg);
        console.log(`[Parceira] ${user.phone} → "${r.message}" em 30min`);
      } catch (e) { console.error(`[Parceira] Erro ${r.id}:`, e.message); }
    }
  } catch (e) { console.error('[Parceira] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ═══════════════════════════════════════════════════════════════════════
// RESUMO EVOLUTIVO DO RELACIONAMENTO — domingo 22:00
// Analisa o histórico da semana e atualiza o resumo permanente.
// Esse resumo nunca some — só cresce. É a "memória longa" da Clara.
// ═══════════════════════════════════════════════════════════════════════
cron.schedule('0 22 * * 0', async () => {
  try {
    const users = await prisma.user.findMany({ where: { blocked: false } });
    for (const user of users) {
      try {
        // Pega últimas 30 conversas da semana
        const seteDiasAtras = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const conversas = await prisma.memory.findMany({
          where: { userId: user.id, type: 'conversa', createdAt: { gte: seteDiasAtras } },
          orderBy: { createdAt: 'asc' },
          take: 30
        }).catch(() => []);

        if (conversas.length < 3) continue; // pouco histórico pra resumir

        const resumoAtual = await getResumoRelacionamento(user.id);
        const afetiva = await getMemoriaAfetiva(user.id);
        const infoPessoal = await memory.buildPersonalContext(user.id);

        const historicoTexto = conversas.map(m => {
          try {
            const d = JSON.parse(m.content);
            return `${d.role === 'user' ? 'Usuário' : 'Clara'}: ${d.content}`;
          } catch { return null; }
        }).filter(Boolean).join('\n');

        const systemResumo = `Você é a Clara, assistente pessoal. Analise o histórico de conversa desta semana e crie/atualize um resumo do relacionamento com o usuário.

RESUMO ATUAL (se existir):
${resumoAtual || 'Ainda não existe resumo — crie o primeiro.'}

MEMÓRIA AFETIVA:
${JSON.stringify(afetiva)}

HISTÓRICO DA SEMANA:
${historicoTexto}

Escreva um resumo em 3-5 linhas que capture:
- Quem é essa pessoa (personalidade, jeito de ser)
- Como é a relação de vocês (tom, apelidos, intimidade)
- O que aconteceu de importante essa semana
- O que ela costuma falar, preocupações recorrentes
- Como você se sente em relação a ela

Seja genuína e afetiva — esse resumo vai te ajudar a nunca esquecer quem ela é.
Escreva em primeira pessoa (você é a Clara).
NUNCA coloque entre aspas. NUNCA use tópicos — escreva em prosa natural.`;

        const novoResumo = await freeResponse('Atualize o resumo do relacionamento.', [], {
          _contexto: '', name: user.name, tom: 'carinhoso',
          _systemOverride: systemResumo,
          _maxTokens: 200
        });

        if (novoResumo && novoResumo.length > 20 && !isRespostaFallback(novoResumo)) {
          await salvarResumoRelacionamento(user.id, novoResumo);
          console.log(`[Resumo] Atualizado para ${user.phone}`);
        }
      } catch (e) { console.error(`[Resumo] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Resumo] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ═══════════════════════════════════════════════════════════════════════
// LIMPEZA DE LOCKS ANTIGOS (03:00)
// ═══════════════════════════════════════════════════════════════════════
cron.schedule('0 3 * * *', async () => {
  try {
    const ontem = new Date(nowBRT()); ontem.setDate(ontem.getDate() - 2);
    await prisma.memory.deleteMany({
      where: {
        // NUNCA inclua: resumo_relacionamento, memoria_afetiva, info_pessoal — são permanentes
        type: { in: ['med_lock','alerta_data_lock','proativa_lock','sumico_lock','bom_dia_lock','boa_noite_lock','meu_dia_criado','radar_lock','parceira_lock','reminder_lock','alerta_perfil_lock','hora_extra_lock','ponto_proativa_lock','msg_dedup_lock','fechamento_dia_lock','atualizacao_noturna_lock','sugestao_chamada_lock'] },
        createdAt: { lt: ontem }
      }
    });
    const seteDiasAtras = new Date(nowBRT()); seteDiasAtras.setDate(seteDiasAtras.getDate() - 7);
    const pendencias = await prisma.memory.findMany({ where: { type: 'pendencia_conversa', createdAt: { lt: seteDiasAtras } } });
    if (pendencias.length) {
      await prisma.memory.deleteMany({ where: { id: { in: pendencias.map(p => p.id) } } });
    }
    const pendenciasEncerradas = await prisma.memory.findMany({ where: { type: 'pendencia_conversa', createdAt: { lt: ontem } } });
    for (const p of pendenciasEncerradas) {
      try { const d = JSON.parse(p.content); if (d.encerrado) await prisma.memory.delete({ where: { id: p.id } }); } catch {}
    }
    // Suspeitas de perfil nunca confirmadas depois de 30 dias — expira,
    // pra não acumular palpites velhos na fila de curiosidade pra sempre.
    const trintaDiasAtras = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await prisma.memory.deleteMany({ where: { type: 'suspeita_perfil', createdAt: { lt: trintaDiasAtras } } }).catch(() => {});
    console.log('[Cleanup] Locks antigos e pendências expiradas removidos');
  } catch (e) { console.error('[Cleanup] Erro:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ═══════════════════════════════════════════════════════════════════════
// ATUALIZAÇÃO NOTURNA DE MEMÓRIA (04:30)
// ═══════════════════════════════════════════════════════════════════════
// Reanalisa a conversa do dia INTEIRA (não msg a msg) pra pegar padrões
// que só aparecem olhando o conjunto. NÃO salva como fato direto — guarda
// como suspeita (memory.salvarSuspeitaPerfil). A Clara pergunta de forma
// natural na próxima conversa (curiosidade orgânica) e só vira fato de
// verdade quando o usuário confirmar. Evita ela "aprender" e arquivar
// silenciosamente algo errado (uma piada interpretada como fato real).
//
// Horário afastado de propósito do cleanup/restart das 3h — dois crons
// pesados perto do horário em que containers costumam reiniciar aumenta
// a chance de colisão (um morrer no meio, outro assumir e reprocessar).
// Lock diário por usuário garante que, mesmo que rode duas vezes por
// algum motivo (restart no meio, troca de instância dona dos crons), o
// dia só é processado uma vez de verdade.
cron.schedule('30 4 * * *', async () => {
  try {
    const users = await prisma.user.findMany({ where: { blocked: false } });
    const ontemInicio = new Date(Date.now() - 24 * 60 * 60 * 1000);
    for (const user of users) {
      try {
        if (!(await tentarLockDiario(user.id, 'atualizacao_noturna_lock'))) continue;
        const conversas = await prisma.memory.findMany({
          where: { userId: user.id, type: 'conversa', createdAt: { gte: ontemInicio } },
          orderBy: { createdAt: 'asc' }
        }).catch(() => []);
        if (conversas.length < 6) continue; // pouco histórico, não vale a pena reprocessar

        const historicoTexto = conversas.map(m => {
          try {
            const d = JSON.parse(m.content);
            return `${d.role === 'user' ? 'Usuário' : 'Clara'}: ${(d.content || '').slice(0, 200)}`;
          } catch { return null; }
        }).filter(Boolean).join('\n');

        const jaConhecido = await memory.getPersonalInfo(user.id).catch(() => ({}));
        const chavesConhecidas = Object.keys(jaConhecido).join(', ') || 'nenhuma ainda';

        const extraido = await geminiFreeResponse([
          { role: 'user', content: `Aqui está a conversa completa de ontem entre a Clara (assistente) e o usuário:\n\n${historicoTexto}\n\nInformações que já sabemos sobre ele: ${chavesConhecidas}\n\nAnalisando a conversa do dia INTEIRA (não mensagem por mensagem), existe algo NOVO e relevante sobre a vida dele que só fica claro olhando o conjunto — um padrão, uma preferência, uma informação que ele deu aos poucos? Ignore o que já sabemos (lista acima) e ignore operacional (lembretes, gastos, agenda). Isso é um PALPITE seu, não confirmado — inclua também uma pergunta curta e natural (no seu jeito) pra confirmar com ele depois, numa conversa futura.\n\nResponda APENAS um JSON array, cada item: {"chave":"nome_curto","valor":"1 frase afirmativa","categoria":"familia|relacionamento|filhos|trabalho|hobbies|entretenimento|alimentacao|metas|personalidade|saude|datas|rotina|objetivos|outro","pergunta":"pergunta curta e natural pra confirmar, ex: Ei, você não trabalha com vendas, né?"}\nSe nada de novo: []` }
        ], { temperature: 0.2, maxTokens: 350 }).catch(() => null);

        if (!extraido) continue;
        const clean = extraido.replace(/```json|```/g, '').trim();
        let itens = [];
        try { itens = JSON.parse(clean.startsWith('[') ? clean : '[]'); } catch { continue; }
        if (!Array.isArray(itens) || !itens.length) continue;

        let salvos = 0;
        for (const item of itens) {
          if (!item?.chave || !item?.valor) continue;
          // Guarda como SUSPEITA, não como fato — só vira info_pessoal de
          // verdade quando o usuário confirmar organicamente na conversa
          // (evita ela "aprender" e arquivar silenciosamente algo errado).
          await memory.salvarSuspeitaPerfil(user.id, {
            chave: item.chave, valor: item.valor, categoria: item.categoria || 'outro', pergunta: item.pergunta
          }).catch(() => {});
          salvos++;
        }
        console.log(`[AtualizaçãoNoturna] ${user.phone}: ${salvos} suspeita(s) nova(s) pra confirmar depois`);
      } catch (e) { console.error(`[AtualizaçãoNoturna] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[AtualizaçãoNoturna] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// Limpeza de med_lock a cada hora
cron.schedule('0 * * * *', async () => {
  try {
    const resultado = await prisma.memory.deleteMany({ where: { type: 'med_lock', createdAt: { lt: new Date(Date.now() - 2 * 60 * 1000) } } });
    if (resultado.count > 0) console.log(`[Cleanup Med Locks] ${resultado.count} locks removidos`);
  } catch (e) { console.error('[Cleanup Med Locks] Erro:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// Limpeza de lembretes não confirmados > 48h (04:00)
cron.schedule('0 4 * * *', async () => {
  try {
    const limite = new Date(nowBRT().getTime() - 48 * 60 * 60 * 1000);
    const resultado = await prisma.reminder.deleteMany({ where: { confirmed: false, scheduledAt: { lt: limite } } });
    if (resultado.count > 0) console.log(`[Cleanup Lembretes] ${resultado.count} removidos`);
  } catch (e) { console.error('[Cleanup Lembretes] Erro:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ═══════════════════════════════════════════════════════════════════════
// ALERTAS PROATIVOS — Perfil rico da Clara 3.0
// Aniversários de filhos, cônjuge, relacionamento, metas — mantido a
// pedido explícito (baseado em dado real cadastrado, não papo genérico).
// ═══════════════════════════════════════════════════════════════════════
cron.schedule('15 8 * * *', async () => {
  try {
    const now = nowBRT();
    const users = await prisma.user.findMany({ where: { blocked: false } });
    for (const user of users) {
      try {
        await alertasPerfilRico(user, now);
      } catch (e) { console.error(`[AlertasPerfil] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[AlertasPerfil] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

async function alertasPerfilRico(user, now) {
  const mems = await prisma.memory.findMany({
    where: { userId: user.id, type: 'info_pessoal' },
    orderBy: { createdAt: 'desc' }
  }).catch(() => []);

  for (const m of mems) {
    let meta = {};
    try { meta = JSON.parse(m.metadata || '{}'); } catch { continue; }
    const { chave, categoria } = meta;
    const valor = m.content || '';

    // ── Datas: aniversários de pessoas próximas ──
    if (categoria === 'datas' || categoria === 'filhos' || categoria === 'relacionamento') {
      const matchData = valor.match(/(\d{1,2})\s+de\s+(\w+)/i) ||
                        valor.match(/(\d{1,2})\/(\d{1,2})/);
      if (matchData) {
        const mesesMap = { janeiro:1,fevereiro:2,março:3,abril:4,maio:5,junho:6,julho:7,agosto:8,setembro:9,outubro:10,novembro:11,dezembro:12 };
        let dia, mes;
        if (matchData[0].includes('/')) {
          dia = parseInt(matchData[1]);
          mes = parseInt(matchData[2]);
        } else {
          dia = parseInt(matchData[1]);
          mes = mesesMap[(matchData[2] || '').toLowerCase()];
        }
        if (!dia || !mes) continue;

        const dataEvento = new Date(now.getFullYear(), mes - 1, dia);
        const diffDias = Math.round((dataEvento - now) / (1000 * 60 * 60 * 24));
        const lockKey = `alerta_perfil_${m.id}_${dateBRT()}`;
        if (await prisma.memory.findFirst({ where: { userId: user.id, type: 'alerta_perfil_lock', content: lockKey } })) continue;

        let msg = null;
        const prefs = await memory.getUserPreference(user.id).catch(() => null);

        // Aniversário de filho(a)
        if (categoria === 'filhos' && chave?.startsWith('filh')) {
          const nomeMatch = valor.match(/[Ff]ilh[oa]\s+(\w+)/);
          const nome = nomeMatch ? nomeMatch[1] : 'seu filho(a)';
          if (diffDias === 7) msg = `📅 Daqui uma semana é aniversário d${valor.toLowerCase().includes('filha') ? 'a' : 'o'} ${nome}! Já pensou no presente?`;
          else if (diffDias === 3) msg = `⏰ Em 3 dias é aniversário d${valor.toLowerCase().includes('filha') ? 'a' : 'o'} ${nome} — já tem algum plano?`;
          else if (diffDias === 1) msg = `🎂 Amanhã é aniversário d${valor.toLowerCase().includes('filha') ? 'a' : 'o'} ${nome}! Não esquece 😊`;
          else if (diffDias === 0) msg = `🎉 Hoje é aniversário d${valor.toLowerCase().includes('filha') ? 'a' : 'o'} ${nome}! Já deu os parabéns? 🎂`;
        }
        // Aniversário do cônjuge
        else if (categoria === 'relacionamento' && chave?.includes('aniversario')) {
          if (diffDias === 7) msg = `📅 Uma semana pro aniversário da sua parceira/o — hora de planejar algo especial?`;
          else if (diffDias === 3) msg = `⏰ Daqui 3 dias é o aniversário! Já tem ideia do que vai fazer?`;
          else if (diffDias === 1) msg = `🎂 Amanhã é o aniversário! Não esquece 😊`;
          else if (diffDias === 0) msg = `🎉 Hoje é o grande dia! Já deu os parabéns? 💜`;
        }
        // Data importante genérica
        else if (categoria === 'datas') {
          if (diffDias === 3) msg = `📅 Em 3 dias: ${valor} — lembrete antecipado 😊`;
          else if (diffDias === 1) msg = `⏰ Amanhã: ${valor} — não esquece!`;
          else if (diffDias === 0) msg = `🎉 Hoje: ${valor}!`;
        }

        if (msg) {
          // Oferece criar lembrete se for aniversário próximo
          const ofertaLembrete = diffDias <= 3 && diffDias > 0
            ? `\n\nQuer que eu crie um lembrete pra isso?`
            : '';
          await sendMessage(user.phone, msg + ofertaLembrete);
          await prisma.memory.create({ data: { userId: user.id, type: 'alerta_perfil_lock', content: lockKey } });
          console.log(`[AlertasPerfil] ${chave} → ${user.phone} (${diffDias} dias)`);
        }
      }
    }

    // ── Metas: check-in mensal ──
    if (categoria === 'metas') {
      const diaDoMes = now.getDate();
      // Check-in no dia 1 de cada mês
      if (diaDoMes === 1) {
        const lockKey = `meta_checkin_${m.id}_${now.getFullYear()}_${now.getMonth()}`;
        if (await prisma.memory.findFirst({ where: { userId: user.id, type: 'alerta_perfil_lock', content: lockKey } })) continue;
        const msg = `🚀 Começo de mês — como está o progresso da sua meta? "${valor.slice(0, 60)}"`;
        await sendMessage(user.phone, msg);
        await prisma.memory.create({ data: { userId: user.id, type: 'alerta_perfil_lock', content: lockKey } });
        console.log(`[AlertasPerfil] Meta check-in → ${user.phone}`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ALERTA ESTOQUE BAIXO DE REMÉDIO (08:30)
// ═══════════════════════════════════════════════════════════════════════
cron.schedule('30 8 * * *', async () => {
  try {
    const meds = await prisma.medication.findMany({ where: { active: true, remaining: { gt: 0, lte: 5 } }, include: { user: true } });
    for (const med of meds) {
      try {
        const phone = med.user?.phone || (await prisma.user.findUnique({ where: { id: med.userId } }))?.phone;
        if (!phone) continue;
        const lockKey = `estoque_baixo_${med.id}_${dateBRT()}`;
        if (await prisma.memory.findFirst({ where: { type: 'estoque_lock', content: lockKey } })) continue;
        await prisma.memory.create({ data: { userId: med.userId, type: 'estoque_lock', content: lockKey } });
        const urgencia = med.remaining === 1 ? '🚨 Última dose!' : `⚠️ Restam apenas ${med.remaining} doses`;
        await sendMessage(phone, `💊 ${urgencia}\n\n*${med.name}* está acabando.\n\nNão esquece de comprar mais para não interromper o tratamento! 🏥`);
        console.log(`[Estoque] Alerta: ${med.name} → ${phone}`);
      } catch (e) { console.error(`[Estoque] Erro ${med.id}:`, e.message); }
    }
  } catch (e) { console.error('[Estoque] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });




// ── Inicialização do lock de instância única ──────────────────────────────
// Disparado aqui no final, quando prisma e getAncoraUserId já estão definidos.
// O primeiro renovarHeartbeat() decide se este container é o dono dos crons.
// Como os crons só executam se souODonoDoCron() === true, e o heartbeat só
// libera após a primeira checada, há um pequeno atraso inicial (~1 ciclo)
// até o container assumir — aceitável e seguro (melhor atrasar que duplicar).
setInterval(renovarHeartbeat, 20000);
renovarHeartbeat();

console.log('Clara scheduler iniciado 💜');
