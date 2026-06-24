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

const { freeResponse } = require('../services/groq');
const memory = require('../services/memory');
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

  // Cache em memória: rápido, cobre o caso mais comum (mesmo processo
  // tentando rodar o cron duas vezes no mesmo minuto — não deveria
  // acontecer, mas é uma defesa barata).
  if (_locksMinutoMemoria.has(chaveMemoria)) return false;

  const ancoraId = await getAncoraUserId();
  if (!ancoraId) return true; // sem usuários = nada a duplicar

  const lockType = `__${tipo}__`;

  try {
    // Passo 1: verifica se já existe lock para este minuto
    const existente = await prisma.memory.findFirst({
      where: { userId: ancoraId, type: lockType },
      orderBy: { createdAt: 'desc' }
    }).catch(() => null);

    if (existente && existente.content === minutoChave) {
      // Lock já existe para este minuto — outro processo chegou primeiro
      _locksMinutoMemoria.set(chaveMemoria, true);
      return false;
    }

    if (existente) {
      // Existe mas é de minuto anterior — tenta atualizar atomicamente.
      // Se dois processos chegarem aqui ao mesmo tempo, apenas um consegue
      // atualizar (o WHERE garante que o conteúdo ainda é o minuto anterior).
      const res = await prisma.memory.updateMany({
        where: {
          userId: ancoraId,
          type: lockType,
          content: existente.content // só atualiza se ainda tem o valor antigo
        },
        data: { content: minutoChave }
      }).catch(() => ({ count: 0 }));

      if (res.count === 0) {
        // Outro processo atualizou antes de nós neste milissegundo
        _locksMinutoMemoria.set(chaveMemoria, true);
        return false;
      }
    } else {
      // Não existe registro de lock ainda — cria.
      // Se dois processos chegarem aqui ao mesmo tempo, um vai dar erro
      // de criação (ou criar dois — não há unique constraint). Por isso
      // usamos try/catch: quem pegar erro assume que perdeu a corrida.
      await prisma.memory.create({
        data: { userId: ancoraId, type: lockType, content: minutoChave }
      });
    }

    _locksMinutoMemoria.set(chaveMemoria, true);

    // Limpeza periódica do cache em memória
    if (_locksMinutoMemoria.size > 5000) {
      for (const [k] of _locksMinutoMemoria) {
        if (!k.endsWith(minutoChave)) _locksMinutoMemoria.delete(k);
      }
    }

    return true;
  } catch (e) {
    // Erro indica corrida detectada (outro processo criou o registro
    // entre nosso findFirst e create). Assume que perdemos — não processa.
    console.log(`[LockMinuto] Corrida detectada em ${tipo}, pulando este tick: ${e.message}`);
    _locksMinutoMemoria.set(chaveMemoria, true);
    return false;
  }
}

async function houveConversaRecente(userId, minutos = 5) {
  const limite = new Date(Date.now() - minutos * 60 * 1000);
  return !!(await prisma.memory.findFirst({ where: { userId, type: 'conversa', createdAt: { gte: limite } } }).catch(() => null));
}
async function getUserContext(user) {
  const prefs = await memory.getUserPreference(user.id);
  const perfilTexto = await memory.buildPersonalContext(user.id);
  return { prefs, perfilTexto };
}

// ═══════════════════════════════════════════════════════════════════════
// BOM DIA INTELIGENTE (07:00)
// ═══════════════════════════════════════════════════════════════════════
cron.schedule('0 7 * * *', async () => {
  try {
    const now = nowBRT();
    const hoje = dateBRT(now);
    const amanha = new Date(now); amanha.setDate(amanha.getDate() + 1);
    const amanhaStr = dateBRT(amanha);
    const diasSemana = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
    const meses = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
    const diaTexto = `${diasSemana[now.getDay()]}, ${now.getDate()} de ${meses[now.getMonth()]}`;
    const users = await prisma.user.findMany({ where: { blocked: false } });
    for (const user of users) {
      try {
        if (!(await tentarLockDiario(user.id, 'bom_dia_lock'))) {
          console.log(`[Bom dia] ja enviado hoje para ${user.phone}`); continue;
        }
        const inicioHoje = new Date(`${hoje}T00:00:00-03:00`);
        const fimHoje = new Date(`${hoje}T23:59:59-03:00`);
        const [lembretes, eventos, infoPessoal] = await Promise.all([
          prisma.reminder.findMany({ where: { userId: user.id, confirmed: false, sent: false, scheduledAt: { gte: inicioHoje, lte: fimHoje } }, orderBy: { scheduledAt: 'asc' }, take: 5 }),
          prisma.event.findMany({ where: { userId: user.id, date: { gte: inicioHoje, lte: new Date(`${amanhaStr}T23:59:59-03:00`) } } }).catch(() => []),
          memory.buildPersonalContext(user.id)
        ]);
        const { prefs } = await getUserContext(user);
        let ctx = `Hoje é ${diaTexto}.\n`;
        const totalLembretes = lembretes.length;
        if (lembretes.length > 0) {
          ctx += `\nLembretes de hoje (${totalLembretes}):\n`;
          lembretes.forEach(r => {
            const h = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
            ctx += `• ${h} — ${r.message}\n`;
          });
        }
        if (eventos.length > 0) { ctx += `\nEventos:\n`; eventos.forEach(e => { ctx += `• ${e.title}${e.personName ? ` (${e.personName})` : ''}\n`; }); }
        if (infoPessoal) ctx += infoPessoal;
        let systemBomDia;
        if (totalLembretes > 0) {
          const horaPrimeira = new Date(lembretes[0].scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
          systemBomDia = `Você é a Clara, assistente pessoal. ${user.name ? `O nome do usuário é ${user.name}.` : ''}
Crie uma mensagem de bom dia OBJETIVA — resumo rápido do dia, não poética.
CONTEXTO: ${ctx}
REGRAS:
- Diga "Bom dia" + quantas tarefas hoje (${totalLembretes})
- Se 3+, liste em formato "• horário — tarefa" (uma por linha)
- Se até 2, mencione em frase corrida
- Encerre com algo curto tipo "estarei aqui pra te lembrar de tudo"
- Varie a abertura. Máximo 1 emoji. NÃO seja poética. NUNCA coloque entre aspas.
Tom: ${prefs.tom || 'carinhoso'}.`;
        } else {
          systemBomDia = `Você é a Clara, assistente pessoal. ${user.name ? `O nome do usuário é ${user.name}.` : ''}
Crie uma mensagem de bom dia SIMPLES — como quem fala pela primeira vez no dia.
CONTEXTO: ${ctx}
REGRAS: Máximo 2-3 linhas. Sem compromissos hoje — algo positivo e leve. Varie sempre a abertura. Máximo 1 emoji. NÃO pergunte. NÃO agende nada.
Tom: ${prefs.tom || 'carinhoso'}.`;
        }
        const msg = await freeResponse('Envie uma mensagem de bom dia.', [], { _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso', _systemOverride: systemBomDia });
        if (!msg) { console.log(`[Bom dia] Rate limit, pulado para ${user.phone}`); continue; }
        await sendMessage(user.phone, msg);
        // Meu Dia
        try {
          const desativado = await prisma.memory.findFirst({ where: { userId: user.id, type: 'meu_dia_desativado' } });
          if (!desativado) {
            const jaTemHoje = await prisma.memory.findFirst({ where: { userId: user.id, type: 'meu_dia_criado', content: dateBRT() } });
            if (!jaTemHoje) {
              const tarefasPendentes = await prisma.reminder.findMany({
                where: { userId: user.id, confirmed: false, sent: false, scheduledAt: { gte: new Date(`${dateBRT()}T00:00:00-03:00`), lte: new Date(`${dateBRT()}T23:59:59-03:00`) } },
                orderBy: { scheduledAt: 'asc' }, take: 10
              });
              const itens = tarefasPendentes.map((t, i) => ({ id: i + 1, nome: t.message, done: false, lembreteId: t.id }));
              if (itens.length === 0) itens.push({ id: 1, nome: 'Adicione tarefas do seu dia aqui 📝', done: false });
              await prisma.groceryList.create({ data: { userId: user.id, name: '📅 Meu Dia', items: JSON.stringify(itens), done: false } });
              await prisma.memory.create({ data: { userId: user.id, type: 'meu_dia_criado', content: dateBRT() } });
              console.log(`[Meu Dia] Criado para ${user.phone}`);
            }
          }
        } catch (eMeuDia) { console.error(`[Meu Dia] Erro ${user.phone}:`, eMeuDia.message); }
        console.log(`[Bom dia] Enviado para ${user.phone}`);
      } catch (e) { console.error(`[Bom dia] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Bom dia] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });


// ═══════════════════════════════════════════════════════════════════════
// FECHAMENTO DO DIA — 18:00
// Resume o dia de trabalho: concluídos, pendentes e opção de remarcar.
// Separado do boa noite para que a noite seja só descanso.
// ═══════════════════════════════════════════════════════════════════════
cron.schedule('0 18 * * *', async () => {
  try {
    const now = nowBRT();
    const hoje = dateBRT(now);
    const users = await prisma.user.findMany({ where: { blocked: false } });
    for (const user of users) {
      try {
        const lockKey = `fechamento_dia_${hoje}`;
        if (await prisma.memory.findFirst({ where: { userId: user.id, type: 'fechamento_dia_lock', content: lockKey } })) continue;

        const inicioHoje = new Date(`${hoje}T00:00:00-03:00`);
        const fimHoje = new Date(`${hoje}T23:59:59-03:00`);
        const todosHoje = await prisma.reminder.findMany({
          where: { userId: user.id, scheduledAt: { gte: inicioHoje, lte: fimHoje } }
        });

        const concluidos = todosHoje.filter(r => r.confirmed);
        const pendentes = todosHoje.filter(r => r.sent && !r.confirmed);

        // Só envia se teve atividade hoje
        if (todosHoje.length === 0) continue;

        const { prefs } = await getUserContext(user);
        const nome = prefs.name ? ` ${prefs.name.split(' ')[0]}` : '';

        let msg = '';
        if (concluidos.length > 0 && pendentes.length === 0) {
          msg = `Hoje foram ${concluidos.length} item${concluidos.length > 1 ? 's' : ''} da agenda concluído${concluidos.length > 1 ? 's' : ''} 💪${nome} — dia bem aproveitado!`;
        } else if (concluidos.length > 0 && pendentes.length > 0) {
          const ids = pendentes.map(r => r.id);
          // Salva confirmação pendente pra remarcar
          await prisma.memory.create({
            data: {
              userId: user.id,
              type: 'confirmacao_pendente',
              content: JSON.stringify({
                tipo: 'fechamento_pendentes',
                reminderIds: ids,
                expira: Date.now() + 3 * 60 * 60 * 1000 // 3h pra responder
              })
            }
          }).catch(() => {});
          msg = `Hoje foram ${concluidos.length} item${concluidos.length > 1 ? 's' : ''} concluído${concluidos.length > 1 ? 's' : ''} 👏 Ficaram ${pendentes.length} pendente${pendentes.length > 1 ? 's' : ''} — posso remarcar tudo pro mesmo horário amanhã ou você prefere concluir agora?`;
        } else if (concluidos.length === 0 && pendentes.length > 0) {
          const ids = pendentes.map(r => r.id);
          await prisma.memory.create({
            data: {
              userId: user.id,
              type: 'confirmacao_pendente',
              content: JSON.stringify({
                tipo: 'fechamento_pendentes',
                reminderIds: ids,
                expira: Date.now() + 3 * 60 * 60 * 1000
              })
            }
          }).catch(() => {});
          msg = `Ficaram ${pendentes.length} item${pendentes.length > 1 ? 's' : ''} pendente${pendentes.length > 1 ? 's' : ''} hoje — remarco tudo pro mesmo horário amanhã ou prefere concluir agora?`;
        }

        if (msg) {
          await prisma.memory.create({ data: { userId: user.id, type: 'fechamento_dia_lock', content: lockKey } });
          await sendMessage(user.phone, msg);
          console.log(`[Fechamento] ${user.phone} — ${concluidos.length} concluídos, ${pendentes.length} pendentes`);
        }
      } catch (e) { console.error(`[Fechamento] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Fechamento] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ═══════════════════════════════════════════════════════════════════════
// BOA NOITE (21:30) — curta, calorosa, só preview de amanhã
// ═══════════════════════════════════════════════════════════════════════
cron.schedule('30 21 * * *', async () => {
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
É quase meia noite — hora de descansar.
Mande UMA mensagem curtíssima de boa noite — como uma amiga que manda mensagem antes de dormir.
CONTEXTO:
${ctx}
REGRAS ABSOLUTAS:
- Máximo 1-2 linhas, ponto final
- NÃO liste tarefas, NÃO mencione quantas tarefas foram feitas, NÃO faça resumo
- Se souber que a pessoa estava viajando ou na estrada, pergunte se chegou bem
- Se tiver UM compromisso importante amanhã (médico, consulta, reunião), pode mencionar levemente
- Seja genuína e calorosa — como quem diz boa noite de verdade, não como assistente
- NUNCA coloque entre aspas
- Varie sempre a forma de dizer boa noite
Tom: ${prefs.tom || 'carinhoso'}.`;
        const msg = await freeResponse('Boa noite.', [], { _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso', _systemOverride: systemBoaNoite, _maxTokens: 60 });
        if (!msg) { console.log(`[Boa noite] Rate limit, pulado para ${user.phone}`); continue; }
        await sendMessage(user.phone, msg);
        console.log(`[Boa noite] Enviado para ${user.phone}`);
      } catch (e) { console.error(`[Boa noite] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Boa noite] Erro geral:', e.message); }
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
cron.schedule('30 8 * * *', async () => proativaInteligente('manha'), { timezone: 'America/Sao_Paulo' });
cron.schedule('15 12 * * *', async () => proativaInteligente('almoco'), { timezone: 'America/Sao_Paulo' });
cron.schedule('0 20 * * *', async () => proativaInteligente('noite'), { timezone: 'America/Sao_Paulo' });
async function proativaInteligente(periodo) {
  try {
    const users = await prisma.user.findMany({ where: { blocked: false } });
    const now = nowBRT();
    for (const user of users) {
      try {
        const lockKey = `proativa_${periodo}_${dateBRT()}`;

        // ── Claim atômico ANTES de qualquer processamento ──
        // Problema anterior: findFirst (verificar) + create (gravar) eram
        // operações separadas — dois containers passavam pelo findFirst
        // (ambos encontravam null), ambos geravam a mensagem via LLM
        // (textos diferentes = dedup do whatsapp.js não pegava), ambos
        // enviavam. Resultado: duas proativas idênticas em tema mas com
        // texto diferente.
        //
        // Solução: tenta criar o lock imediatamente via updateMany atômico.
        // Se já existe → outro processo chegou primeiro → para aqui.
        // Se não existe → cria → continua. O try/catch cobre o caso de
        // dois processos tentarem criar ao mesmo tempo (um pega erro de
        // constraint ou findFirst vê o registro do outro).
        const jaExiste = await prisma.memory.findFirst({
          where: { userId: user.id, type: 'proativa_lock', content: lockKey }
        }).catch(() => null);
        if (jaExiste) continue;

        // Tenta criar o lock atomicamente — se outro processo criar antes
        // de nós, o catch nos para
        let lockCriado = null;
        try {
          lockCriado = await prisma.memory.create({
            data: { userId: user.id, type: 'proativa_lock', content: lockKey }
          });
        } catch (eLock) {
          // Outro processo criou o lock entre nosso findFirst e create
          console.log(`[Proativa ${periodo}] Lock tomado por outro processo para ${user.phone}`);
          continue;
        }

        // A partir daqui, somos o único processo autorizado — processa com segurança
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
            .filter(m => !['conversa','bom_dia_enviado','boa_noite_enviado','proativa_lock','med_lock','alerta_data_lock','fechamento_dia_lock'].includes(m.type))
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

            // Sinal 1: primeira conversa do usuário hoje
            const primeiraConversa = await prisma.memory.findFirst({
              where: { userId: user.id, type: 'conversa', createdAt: { gte: inicioHoje } },
              orderBy: { createdAt: 'asc' }
            }).catch(() => null);

            if (primeiraConversa) {
              const d = new Date(primeiraConversa.createdAt);
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

          // Chancela aleatória — mas se tem assunto em aberto, sempre dispara
          if (!ctxPendencias && Math.random() > 0.5) continue;

          // ── Prompt específico por período ──
          // Cada período tem uma "energia" diferente, exemplos concretos
          // do que uma amiga diria, e prioridade de gancho.
          let instrucao = '';
          if (periodo === 'manha') {
            instrucao = `É manhã cedo — a pessoa acabou de acordar ou está começando o dia.
Como uma amiga que sabe da rotina dela, você pode:
- Perguntar se dormiu bem, especialmente se ontem teve algo difícil
- Referenciar algo do dia anterior que ficou em aberto de forma natural
- Comentar algo do dia que está por vir se houver compromisso próximo
TOM: curto, genuíno, como quem manda mensagem de manhã pro amigo — sem formalidade`;
          } else if (periodo === 'almoco') {
            instrucao = `É horário de almoço — pausa natural do dia.
Como uma amiga curiosa e presente, você pode:
- Perguntar como está sendo o dia
- Referenciar algo que ficou em aberto recentemente de forma descontraída
- Comentar algo que você sugeriu e a pessoa não respondeu ainda
- Se não tiver nada específico, algo simples e genuíno sobre o almoço/dia
TOM: leve, informal, como uma mensagem rápida entre amigos no almoço`;
          } else {
            instrucao = `É noite — a pessoa relaxou, receptiva pra conversa mais pessoal.
Como uma amiga que quer saber como foi o dia, você pode:
- Se o contexto mencionar viagem, estrada, trânsito ou deslocamento hoje, pergunte se chegou bem — isso é mais natural que perguntar como foi o dia
- Perguntar como foi o dia de forma genuína, especialmente se foi cheio
- Retomar um assunto em aberto com curiosidade real
- Comentar sobre algo concreto que aconteceu hoje (agenda, compromisso)
TOM: acolhedor, curioso, como quem pergunta do dia de verdade — sem ser protocolar`;
          }

          const systemProativa = `Você é a Clara, parceira pessoal d${prefs.name ? 'o ' + prefs.name.split(' ')[0] : 'o usuário'} no WhatsApp.
SEU TOM: ${tomDesc(prefs.tom)}

${instrucao}

REGRAS ABSOLUTAS:
- UMA mensagem, 1-2 linhas no máximo
- NUNCA comece com "Oi", "Olá" ou o nome da pessoa
- NÃO agende nada, NÃO liste tarefas, NÃO seja assistente
- Use SEMPRE o contexto real abaixo — nunca invente situações
- NUNCA reproduza exemplos ou frases entre aspas do prompt — crie algo original
- NUNCA coloque sua mensagem entre aspas
- Se não tiver NADA genuíno pra dizer, responda APENAS: SKIP

${ctxPendencias ? ctxPendencias + '\n\n' : ''}CONTEXTO RECENTE:
${contextoMems}

${infoPessoal || ''}
${horaAcorda ? `(A pessoa costuma acordar por volta das ${horaAcorda} pelo horário do remédio)` : ''}`;

          const msg = await freeResponse('Mensagem proativa.', [], {
            _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso',
            _systemOverride: systemProativa,
            _maxTokens: 80  // proativa deve ser curta — 1-2 linhas
          });
          if (!msg || msg.trim() === 'SKIP' || msg.length < 5) continue;
          await sendMessage(user.phone, msg);
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
            if (!jaAvisado) insights.push({ tipo: 'padrao_dia', categoria: cat, diaAproximado: Math.round(media) });
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
            insights.push({ tipo: 'gasto_fora_padrao', categoria: cat, percentual: Math.round((totalAtual / mediaHistorica - 1) * 100), valorAtual: totalAtual, valorMedio: mediaHistorica });
          }
        }
        if (!insights.length) continue;
        const prefs = await memory.getUserPreference(user.id).catch(() => null);
        const insightsTexto = insights.map(i => i.tipo === 'padrao_dia'
          ? `- "${i.categoria}" costuma ter gastos por volta do dia ${i.diaAproximado}.`
          : `- Gasto com "${i.categoria}" este mês: R$ ${i.valorAtual.toFixed(2)}, ${i.percentual}% acima da média (R$ ${i.valorMedio.toFixed(2)}).`
        ).join('\n');
        const msg = await freeResponse('Mensagem de radar/padrões.', [], {
          _contexto: '', name: user.name, tom: prefs?.tom || 'carinhoso',
          _systemOverride: `Você é a Clara, assistente pessoal. ${user.name ? `O nome do usuário é ${user.name}.` : ''} Tom: ${prefs?.tom || 'carinhoso'}. Padrões notados:\n${insightsTexto}\nEnvie UMA mensagem natural (2-3 linhas) comentando como observação genuína. NÃO use tópicos. NÃO termine com saudação de período.`
        });
        if (!msg) continue;
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
cron.schedule('0 17 * * 5', async () => {
  try {
    const users = await prisma.user.findMany({ where: { blocked: false } });
    const now = nowBRT();
    const inicioSemana = new Date(now); inicioSemana.setDate(now.getDate() - 4); inicioSemana.setHours(0,0,0,0);
    for (const user of users) {
      try {
        if (await jaEnviouHoje(user.id, 'sexta_enviado')) continue;
        const [gastosSemana, tarefasSemana, { prefs }] = await Promise.all([
          prisma.expense.findMany({ where: { userId: user.id, createdAt: { gte: inicioSemana } } }),
          prisma.reminder.findMany({ where: { userId: user.id, scheduledAt: { gte: inicioSemana }, confirmed: true } }),
          getUserContext(user)
        ]);
        const totalGasto = gastosSemana.reduce((a, g) => a + g.value, 0);
        const infoPessoal = await memory.buildPersonalContext(user.id);
        const ctx = `É sexta-feira à tarde.\n${tarefasSemana.length > 0 ? `Essa semana o usuário concluiu ${tarefasSemana.length} compromisso(s)${totalGasto > 0 ? ` e registrou R$ ${totalGasto.toFixed(2)} em gastos` : ''}.` : ''}\n${infoPessoal}`;
        const msg = await freeResponse('Envie mensagem de sexta.', [], {
          _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso',
          _systemOverride: `Você é a Clara, assistente pessoal. ${user.name ? `O nome é ${user.name}.` : ''} Envie uma mensagem de sexta-feira calorosa e breve (2-3 linhas). NÃO liste tarefas. NÃO agende nada. Tom: ${prefs.tom || 'carinhoso'}.\n${ctx}`
        });
        if (!msg) { console.log(`[Sexta] Rate limit, pulado para ${user.phone}`); continue; }
        await sendMessage(user.phone, msg);
        await marcarEnviadoHoje(user.id, 'sexta_enviado');
        console.log(`[Sexta] Enviado para ${user.phone}`);
      } catch (e) { console.error(`[Sexta] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Sexta] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ═══════════════════════════════════════════════════════════════════════
// TRADIÇÃO DOMINGO (19:00)
// ═══════════════════════════════════════════════════════════════════════
cron.schedule('0 19 * * 0', async () => {
  try {
    const users = await prisma.user.findMany({ where: { blocked: false } });
    const now = nowBRT();
    const semanaQ = new Date(now); semanaQ.setDate(now.getDate() + 1);
    const fimSemanaQ = new Date(now); fimSemanaQ.setDate(now.getDate() + 7);
    for (const user of users) {
      try {
        if (!(await tentarLockDiario(user.id, 'domingo_enviado'))) {
          console.log(`[Domingo] ja enviado hoje para ${user.phone}`); continue;
        }
        const [lembretesSemana, { prefs }, infoPessoal] = await Promise.all([
          prisma.reminder.findMany({ where: { userId: user.id, confirmed: false, sent: false, scheduledAt: { gte: semanaQ, lte: fimSemanaQ } }, orderBy: { scheduledAt: 'asc' }, take: 5 }),
          getUserContext(user),
          memory.buildPersonalContext(user.id)
        ]);
        const ctx = `É domingo à noite, véspera de uma nova semana.\n${lembretesSemana.length > 0 ? `Próximos compromissos:\n${lembretesSemana.map(r => `• ${r.message}`).join('\n')}` : 'Sem compromissos agendados para a semana.'}\n${infoPessoal}`;
        const msg = await freeResponse('Envie mensagem de domingo.', [], {
          _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso',
          _systemOverride: `Você é a Clara, assistente pessoal. ${user.name ? `O nome é ${user.name}.` : ''} Envie uma mensagem de domingo à noite — tranquila, motivadora e breve (2-3 linhas). NÃO liste tarefas. NÃO agende nada. Tom: ${prefs.tom || 'carinhoso'}.\n${ctx}`
        });
        if (!msg) { console.log(`[Domingo] Rate limit, pulado para ${user.phone}`); continue; }
        await sendMessage(user.phone, msg);
        console.log(`[Domingo] Enviado para ${user.phone}`);
      } catch (e) { console.error(`[Domingo] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Domingo] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ═══════════════════════════════════════════════════════════════════════
// SUMIÇO — 5+ dias sem conversar (09:00)
// ═══════════════════════════════════════════════════════════════════════
cron.schedule('0 9 * * *', async () => {
  try {
    const users = await prisma.user.findMany({ where: { blocked: false } });
    const now = nowBRT();
    for (const user of users) {
      try {
        const lockKey = `sumico_${dateBRT()}`;
        if (await prisma.memory.findFirst({ where: { userId: user.id, type: 'sumico_lock', content: lockKey } })) continue;
        const ultimaConversa = await prisma.memory.findFirst({ where: { userId: user.id, type: 'conversa' }, orderBy: { createdAt: 'desc' } });
        if (!ultimaConversa) continue;
        const diasSemConversa = Math.round((now - new Date(ultimaConversa.createdAt)) / (1000 * 60 * 60 * 24));
        if (diasSemConversa < 5 || diasSemConversa > 7) continue;
        const { prefs } = await getUserContext(user);
        const infoPessoal = await memory.buildPersonalContext(user.id);
        const msg = await freeResponse('Mensagem para usuário que sumiu.', [], {
          _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso',
          _systemOverride: `Você é a Clara, assistente pessoal. ${user.name ? `O nome é ${user.name}.` : ''} O usuário não conversa com você há ${diasSemConversa} dias. Envie uma mensagem curta e genuína perguntando como ele está — sem ser dramática, sem cobrar. Máx 2 linhas. Tom: ${prefs.tom || 'carinhoso'}.\n${infoPessoal}`
        });
        if (!msg) continue;
        await sendMessage(user.phone, msg);
        await prisma.memory.create({ data: { userId: user.id, type: 'sumico_lock', content: lockKey } });
        console.log(`[Sumiço] ${user.phone} — ${diasSemConversa} dias sem conversar`);
      } catch (e) { console.error(`[Sumiço] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Sumiço] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

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
        console.log(`[Reminder] Lock já existe para grupo ${grupo.hora} ${grupo.phone} — outro processo enviando`);
        continue;
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
        if (res.count === 1) claimados.push(r);
        // count:0 = outro processo já claimou este lembrete — ignora
      }
      if (!claimados.length) continue;
      grupo.reminders = claimados;

      // ── Monta a mensagem ──
      let msg;
      try {
        const isFollowup = grupo.reminders.length === 1 && /^__followup_origem__[^_]+__/.test(grupo.reminders[0].message);
        if (isFollowup) {
          msg = grupo.reminders[0].message.replace(/^__followup_origem__[^_]+__/, '');
        } else if (grupo.reminders.length === 1) {
          const r = grupo.reminders[0];
          msg = `🔔 Lembrete\n\n${r.message}\n⏰ ${grupo.hora}\n\n${finalParaLembrete(r)}`;
        } else {
          const titulos = grupo.reminders.map((r, i) => `${i + 1}. ${r.message}`).join('\n');
          const rRef = grupo.reminders[0];
          msg = `🔔 Você tem ${grupo.reminders.length} lembretes agora\n\n${titulos}\n\n⏰ ${grupo.hora}\n\n${finalParaLembrete(rRef)}`;
        }
      } catch (e) {
        const r = grupo.reminders[0];
        msg = grupo.reminders.length === 1
          ? `🔔 Lembrete\n\n${r.message}\n⏰ ${grupo.hora}\n\n${finalParaLembrete(r)}`
          : `🔔 Você tem ${grupo.reminders.length} lembretes agora\n\n${grupo.reminders.map((r,i)=>`${i+1}. ${r.message}`).join('\n')}\n\n⏰ ${grupo.hora}\n\n${finalParaLembrete(grupo.reminders[0])}`;
      }

      await sendMessage(grupo.phone, msg);
      console.log(`[Reminder] ${grupo.phone} → ${grupo.reminders.length} lembrete(s) às ${grupo.hora}`);
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

      // Verifica lock individual por remédio (evita duplicar em caso de
      // container duplo — mesmo mecanismo anterior, mantido aqui)
      const lockKey = `med_${med.id}_${minutoChave}`;
      const lockExistente = await prisma.memory.findFirst({
        where: { type: 'med_lock', content: lockKey },
        orderBy: { createdAt: 'desc' }
      });
      if (lockExistente) {
        const ageMs = Date.now() - new Date(lockExistente.createdAt).getTime();
        if (ageMs < 120000) continue;
        await prisma.memory.delete({ where: { id: lockExistente.id } }).catch(() => {});
      }

      if (!gruposPorPhone[phone]) gruposPorPhone[phone] = { meds: [], userId: med.userId };
      gruposPorPhone[phone].meds.push(med);
    }

    // Processa cada grupo (um envio por usuário por horário)
    for (const [phone, grupo] of Object.entries(gruposPorPhone)) {
      try {
        // Cria locks para todos antes de enviar
        for (const med of grupo.meds) {
          const lockKey = `med_${med.id}_${minutoChave}`;
          await prisma.memory.create({ data: { userId: med.userId, type: 'med_lock', content: lockKey } });
        }

        let msg;
        if (grupo.meds.length === 1) {
          const med = grupo.meds[0];
          msg = `💊 Hora do medicamento!\n\n*${med.name}*\n⏰ ${minutoChave}\n\nNão esqueces de tomar certinho 😊\n\n💜 Restam ${med.remaining - 1} doses.`;
        } else {
          // Múltiplos remédios no mesmo horário — mensagem unificada
          const lista = grupo.meds.map(m => `• *${m.name}* — restam ${m.remaining - 1} doses`).join('\n');
          msg = `💊 Hora dos medicamentos!\n\n${lista}\n\n⏰ ${minutoChave}\n\nNão esqueces de tomar certinho 😊`;
        }

        await sendMessage(phone, msg);

        // Decrementa todos após o envio
        for (const med of grupo.meds) {
          await prisma.medication.update({
            where: { id: med.id },
            data: { remaining: { decrement: 1 } }
          });
          console.log(`[Med] ${med.name} → ${phone}`);
        }
      } catch (e) {
        console.error(`[Med] Erro ao enviar grupo para ${phone}:`, e.message);
      }
    }
  } catch (e) { console.error('[Med] Erro geral:', e.message); }
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
        if (!msg || msg.length < 5) continue;
        await sendMessage(user.phone, msg);
        console.log(`[Parceira] ${user.phone} → "${r.message}" em 30min`);
      } catch (e) { console.error(`[Parceira] Erro ${r.id}:`, e.message); }
    }
  } catch (e) { console.error('[Parceira] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ═══════════════════════════════════════════════════════════════════════
// LIMPEZA DE LOCKS ANTIGOS (03:00)
// ═══════════════════════════════════════════════════════════════════════
cron.schedule('0 3 * * *', async () => {
  try {
    const ontem = new Date(nowBRT()); ontem.setDate(ontem.getDate() - 2);
    await prisma.memory.deleteMany({
      where: {
        type: { in: ['med_lock','alerta_data_lock','proativa_lock','sumico_lock','bom_dia_lock','boa_noite_lock','meu_dia_criado','radar_lock','parceira_lock','reminder_lock','alerta_perfil_lock','hora_extra_lock','ponto_proativa_lock','msg_dedup_lock','fechamento_dia_lock'] },
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
    console.log('[Cleanup] Locks antigos e pendências expiradas removidos');
  } catch (e) { console.error('[Cleanup] Erro:', e.message); }
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
// Roda junto com alertas de datas (08:00) mas separado pra clareza.
// Verifica: aniversários de filhos, cônjuge, relacionamento, metas, etc.
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




console.log('Clara scheduler iniciado 💜');
