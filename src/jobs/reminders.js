const cron = require('node-cron');
const { sendMessage } = require('../services/whatsapp');
const { freeResponse } = require('../services/groq');
const memory = require('../services/memory');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}
function pad(n) { return String(n).padStart(2, '0'); }
function dateBRT(d = nowBRT()) {
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function random(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const finais = [
  '😊 Me avisa quando concluir.',
  '💜 Irei te lembrar!',
  '✨ Estou de olho pra você!',
  '🔔 Não deixo você esquecer.',
  '😊 Conta comigo.',
];

async function jaEnviouHoje(userId, tipo) {
  const hoje = dateBRT();
  return prisma.memory.findFirst({ where: { userId, type: tipo, content: hoje } });
}

async function marcarEnviadoHoje(userId, tipo) {
  await prisma.memory.create({ data: { userId, type: tipo, content: dateBRT() } });
}

async function getUserContext(user) {
  const prefs = await memory.getUserPreference(user.id);
  const perfilTexto = await memory.buildPersonalContext(user.id);
  return { prefs, perfilTexto };
}

// ─────────────────────────────────────────────
// BOM DIA INTELIGENTE (07:05)
// ─────────────────────────────────────────────
const _locksBomDia = new Set();
const _locksBoaNoite = new Set();

cron.schedule('5 7 * * *', async () => {
  try {
    const now = nowBRT();
    const hoje = dateBRT(now);
    if (_locksBomDia.has(hoje)) { console.log('[Bom dia] já processando hoje'); return; }
    _locksBomDia.add(hoje);

    const lockKey = `bom_dia_${hoje}`;
    const jaEnviou = await prisma.memory.findFirst({ where: { type: lockKey } });
    if (jaEnviou) { console.log('[Bom dia] já enviado hoje, pulando'); return; }
    await prisma.memory.create({ data: { userId: 'system', type: lockKey, content: '1' } }).catch(() => {});

    const amanha = new Date(now); amanha.setDate(amanha.getDate() + 1);
    const amanhaStr = dateBRT(amanha);
    const diasSemana = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
    const meses = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
    const diaTexto = `${diasSemana[now.getDay()]}, ${now.getDate()} de ${meses[now.getMonth()]}`;

    const users = await prisma.user.findMany({ where: { blocked: false } });

    for (const user of users) {
      try {
        if (await jaEnviouHoje(user.id, 'bom_dia_enviado')) continue;

        const lockExistente = await prisma.memory.findFirst({
          where: { userId: user.id, type: `bom_dia_${hoje}` }, orderBy: { createdAt: 'desc' }
        });
        if (lockExistente) { console.log(`[Bom dia] já enviado hoje para ${user.phone}`); continue; }
        await prisma.memory.create({ data: { userId: user.id, type: `bom_dia_${hoje}`, content: new Date().toISOString() } });

        const inicioHoje = new Date(`${hoje}T00:00:00-03:00`);
        const fimHoje = new Date(`${hoje}T23:59:59-03:00`);

        const [lembretes, eventos, infoPessoal] = await Promise.all([
          prisma.reminder.findMany({
            where: { userId: user.id, confirmed: false, sent: false, scheduledAt: { gte: inicioHoje, lte: fimHoje } },
            orderBy: { scheduledAt: 'asc' }, take: 5
          }),
          prisma.event.findMany({
            where: { userId: user.id, date: { gte: inicioHoje, lte: new Date(`${amanhaStr}T23:59:59-03:00`) } }
          }),
          memory.buildPersonalContext(user.id)
        ]);

        const { prefs } = await getUserContext(user);

        let ctx = `Hoje é ${diaTexto}.\n`;
        if (lembretes.length > 0) {
          ctx += `\nLembretes de hoje:\n`;
          lembretes.forEach(r => {
            const h = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
            ctx += `• ${h} — ${r.message}\n`;
          });
        } else {
          ctx += `\nNenhum compromisso agendado para hoje.\n`;
        }
        if (eventos.length > 0) {
          ctx += `\nEventos próximos:\n`;
          eventos.forEach(e => { ctx += `• ${e.title}${e.personName ? ` (${e.personName})` : ''}\n`; });
        }
        if (infoPessoal) ctx += infoPessoal;

        const systemBomDia = `Você é a Clara, assistente pessoal. ${user.name ? `O nome do usuário é ${user.name}.` : ''}
Crie uma mensagem de bom dia ÚNICA e HUMANA — como se fosse a primeira vez que fala com a pessoa naquele dia específico.

CONTEXTO DO DIA:
${ctx}

REGRAS OBRIGATÓRIAS:
- Máximo 3-4 linhas
- Use o dia da semana de forma natural
- Se tiver compromissos: mencione apenas o primeiro horário
- Se não tiver compromissos: celebre levemente o dia livre
- Varie sempre a abertura — NUNCA repita "Bom dia, [nome]! ☀️"
- Use no máximo 1 emoji
- Encerre com algo caloroso e breve
- NÃO liste compromissos. NÃO pergunte. NÃO agende nada.
Tom: ${prefs.tom || 'carinhoso'}.`;

        const msg = await freeResponse('Envie uma mensagem de bom dia para o usuário.', [], { _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso', _systemOverride: systemBomDia });
        await sendMessage(user.phone, msg);
        console.log(`[Bom dia] Enviado para ${user.phone}`);
      } catch (e) { console.error(`[Bom dia] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Bom dia] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ─────────────────────────────────────────────
// BOA NOITE INTELIGENTE (21:30)
// ─────────────────────────────────────────────
cron.schedule('30 21 * * *', async () => {
  try {
    const now = nowBRT();
    const hoje = dateBRT(now);
    if (_locksBoaNoite.has(hoje)) { console.log('[Boa noite] já processando hoje'); return; }
    _locksBoaNoite.add(hoje);

    const lockKey = `boa_noite_${hoje}`;
    const jaEnviou = await prisma.memory.findFirst({ where: { type: lockKey } });
    if (jaEnviou) { console.log('[Boa noite] já enviado hoje, pulando'); return; }
    await prisma.memory.create({ data: { userId: 'system', type: lockKey, content: '1' } }).catch(() => {});

    const amanha = new Date(now); amanha.setDate(amanha.getDate() + 1);
    const amanhaStr = dateBRT(amanha);
    const users = await prisma.user.findMany({ where: { blocked: false } });

    for (const user of users) {
      try {
        if (await jaEnviouHoje(user.id, 'boa_noite_enviado')) continue;

        const lockNoiteExistente = await prisma.memory.findFirst({
          where: { userId: user.id, type: `boa_noite_${hoje}` }, orderBy: { createdAt: 'desc' }
        });
        if (lockNoiteExistente) { console.log(`[Boa noite] já enviado hoje para ${user.phone}`); continue; }
        await prisma.memory.create({ data: { userId: user.id, type: `boa_noite_${hoje}`, content: new Date().toISOString() } });

        const inicioAmanha = new Date(`${amanhaStr}T00:00:00-03:00`);
        const fimAmanha = new Date(`${amanhaStr}T23:59:59-03:00`);
        const inicioHoje = new Date(`${hoje}T00:00:00-03:00`);
        const fimHoje = new Date(`${hoje}T23:59:59-03:00`);

        const [lembretesAmanha, tarefasHoje, infoPessoal] = await Promise.all([
          prisma.reminder.findMany({
            where: { userId: user.id, confirmed: false, sent: false, scheduledAt: { gte: inicioAmanha, lte: fimAmanha } },
            orderBy: { scheduledAt: 'asc' }, take: 3
          }),
          prisma.reminder.findMany({
            where: { userId: user.id, scheduledAt: { gte: inicioHoje, lte: fimHoje } }
          }),
          memory.buildPersonalContext(user.id)
        ]);

        const { prefs } = await getUserContext(user);
        const concluidasHoje = tarefasHoje.filter(t => t.confirmed).length;
        const totalHoje = tarefasHoje.length;

        let ctx = `Hoje foi ${['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'][now.getDay()]}.\n`;
        if (totalHoje > 0) ctx += `O usuário tinha ${totalHoje} compromisso(s) hoje e concluiu ${concluidasHoje}.\n`;
        if (lembretesAmanha.length > 0) {
          ctx += `\nAmanhã tem:\n`;
          lembretesAmanha.forEach(r => {
            const h = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
            ctx += `• ${h} — ${r.message}\n`;
          });
        }
        if (infoPessoal) ctx += infoPessoal;

        const systemBoaNoite = `Você é a Clara, assistente pessoal. ${user.name ? `O nome do usuário é ${user.name}.` : ''}
Crie uma mensagem de boa noite ÚNICA — como quem se despede de verdade ao final daquele dia específico.

CONTEXTO DO DIA:
${ctx}

REGRAS OBRIGATÓRIAS:
- Máximo 3 linhas, sem emojis
- Considere o dia da semana
- Varie sempre a abertura
- Mencione amanhã de forma leve sem listar compromissos
- Encerre com algo caloroso e diferente a cada dia
- NÃO liste compromissos. NÃO use emojis. NÃO pergunte. NÃO agende nada.
Tom: ${prefs.tom || 'carinhoso'}.`;

        const msg = await freeResponse('Envie uma mensagem de boa noite para o usuário.', [], { _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso', _systemOverride: systemBoaNoite });
        await sendMessage(user.phone, msg);
        console.log(`[Boa noite] Enviado para ${user.phone}`);
      } catch (e) { console.error(`[Boa noite] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Boa noite] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ─────────────────────────────────────────────
// ALERTAS DE DATAS IMPORTANTES (08:00)
// ─────────────────────────────────────────────
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
          const dia = parseInt(match[1]);
          const mes = mesesMap[match[2].toLowerCase()];
          if (!dia || !mes) continue;
          const dataEvento = new Date(now.getFullYear(), mes - 1, dia);
          const diffDias = Math.round((dataEvento - now) / (1000 * 60 * 60 * 24));
          const lockKey = `alerta_data_${chave}_${dateBRT()}`;
          const jaEnviou = await prisma.memory.findFirst({ where: { userId: user.id, type: 'alerta_data_lock', content: lockKey } });
          if (jaEnviou) continue;
          let msg = null;
          if (diffDias === 0) msg = `🎉 ${valor.replace('Aniversário', 'Hoje é o aniversário')} — não esquece de dar os parabéns! 🎂`;
          else if (diffDias === 1) msg = `⏰ Amanhã: ${valor} Já preparou algo especial? 😊`;
          else if (diffDias === 3) msg = `📅 Em 3 dias: ${valor} 💜`;
          else if (diffDias === 7) msg = `📅 Em uma semana: ${valor} Já anotei pra te lembrar mais perto! 😊`;
          if (msg) {
            await sendMessage(user.phone, msg);
            await prisma.memory.create({ data: { userId: user.id, type: 'alerta_data_lock', content: lockKey } });
          }
        }

        const eventos = await prisma.event.findMany({ where: { userId: user.id, notified: false } });
        for (const ev of eventos) {
          const dataEv = new Date(ev.date);
          const diffDias = Math.round((dataEv - now) / (1000 * 60 * 60 * 24));
          let msg = null;
          if (diffDias === 0) msg = `🎉 Hoje é ${ev.title}${ev.personName ? ` da ${ev.personName}` : ''}! 🎂`;
          else if (diffDias === 1) msg = `⏰ Amanhã é ${ev.title}${ev.personName ? ` da ${ev.personName}` : ''}! Não esquece 😊`;
          else if (diffDias === 3) msg = `📅 Em 3 dias: ${ev.title}${ev.personName ? ` da ${ev.personName}` : ''} 💜`;
          else if (diffDias === 7) msg = `📅 Em uma semana: ${ev.title}${ev.personName ? ` da ${ev.personName}` : ''} 😊`;
          if (msg) {
            await sendMessage(user.phone, msg);
            await prisma.event.update({ where: { id: ev.id }, data: { notified: true } });
          }
        }
      } catch (e) { console.error(`[Datas] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Datas] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ─────────────────────────────────────────────
// MENSAGENS PROATIVAS INTELIGENTES (10:00 e 15:00)
// ─────────────────────────────────────────────
cron.schedule('0 10 * * 1-5', async () => proativaInteligente('manha'), { timezone: 'America/Sao_Paulo' });
cron.schedule('0 15 * * 1-5', async () => proativaInteligente('tarde'), { timezone: 'America/Sao_Paulo' });

async function proativaInteligente(periodo) {
  try {
    const users = await prisma.user.findMany({ where: { blocked: false } });
    const now = nowBRT();
    for (const user of users) {
      try {
        const lockKey = `proativa_${periodo}_${dateBRT()}`;
        if (await prisma.memory.findFirst({ where: { userId: user.id, type: 'proativa_lock', content: lockKey } })) continue;
        const ultimaConversa = await prisma.memory.findFirst({ where: { userId: user.id, type: 'conversa' }, orderBy: { createdAt: 'desc' } });
        if (!ultimaConversa) continue;
        const diasSemConversa = (now - new Date(ultimaConversa.createdAt)) / (1000 * 60 * 60 * 24);
        if (diasSemConversa > 3) continue;
        const [infoPessoal, memsRecentes, { prefs }] = await Promise.all([
          memory.buildPersonalContext(user.id),
          memory.getRecentMemories(user.id, 15),
          getUserContext(user)
        ]);
        if (!infoPessoal && memsRecentes.length < 3) continue;
        if (Math.random() > 0.33) continue;
        const contextoMems = memsRecentes
          .filter(m => !['conversa','bom_dia_enviado','boa_noite_enviado','proativa_lock','med_lock','alerta_data_lock'].includes(m.type))
          .slice(0, 8).map(m => `[${m.type}] ${m.content}`).join('\n');
        const systemProativa = `Você é a Clara, assistente pessoal íntima e proativa.
${user.name ? `O nome do usuário é ${user.name}.` : ''}
Tom: ${prefs.tom || 'carinhoso'}.
Com base no que você sabe, envie UMA mensagem proativa curta e natural (1-3 linhas).
REGRAS:
- Seja NATURAL, como uma amiga enviando mensagem
- NÃO comece com "Olá" ou "Oi [nome]!"
- NÃO agende nada, NÃO liste tarefas
- Se não tiver contexto suficiente, responda APENAS: SKIP
Contexto: ${contextoMems}\n${infoPessoal}`;
        const msg = await freeResponse('Envie uma mensagem proativa.', [], { _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso', _systemOverride: systemProativa });
        if (!msg || msg.trim() === 'SKIP' || msg.length < 5) continue;
        await sendMessage(user.phone, msg);
        await prisma.memory.create({ data: { userId: user.id, type: 'proativa_lock', content: lockKey } });
        console.log(`[Proativa ${periodo}] Enviado para ${user.phone}`);
      } catch (e) { console.error(`[Proativa] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error(`[Proativa ${periodo}] Erro geral:`, e.message); }
}

// ─────────────────────────────────────────────
// TRADIÇÕES SEMANAIS — SEXTA (17:00)
// ─────────────────────────────────────────────
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
        const ctx = `É sexta-feira à tarde.\nEssa semana o usuário concluiu ${tarefasSemana.length} compromisso(s)${totalGasto > 0 ? ` e registrou R$ ${totalGasto.toFixed(2)} em gastos` : ''}.\n${infoPessoal}`;
        const systemSexta = `Você é a Clara, assistente pessoal. ${user.name ? `O nome é ${user.name}.` : ''}
Envie uma mensagem de sexta-feira calorosa e breve (2-3 linhas).
NÃO liste tarefas. NÃO agende nada. Tom: ${prefs.tom || 'carinhoso'}.
${ctx}`;
        const msg = await freeResponse('Envie mensagem de sexta.', [], { _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso', _systemOverride: systemSexta });
        await sendMessage(user.phone, msg);
        await marcarEnviadoHoje(user.id, 'sexta_enviado');
        console.log(`[Sexta] Enviado para ${user.phone}`);
      } catch (e) { console.error(`[Sexta] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Sexta] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ─────────────────────────────────────────────
// TRADIÇÕES SEMANAIS — DOMINGO (19:00)
// ─────────────────────────────────────────────
cron.schedule('0 19 * * 0', async () => {
  try {
    const users = await prisma.user.findMany({ where: { blocked: false } });
    const now = nowBRT();
    const semanaQ = new Date(now); semanaQ.setDate(now.getDate() + 1);
    const fimSemanaQ = new Date(now); fimSemanaQ.setDate(now.getDate() + 7);
    for (const user of users) {
      try {
        if (await jaEnviouHoje(user.id, 'domingo_enviado')) continue;
        const [lembretesSemana, { prefs }, infoPessoal] = await Promise.all([
          prisma.reminder.findMany({ where: { userId: user.id, confirmed: false, sent: false, scheduledAt: { gte: semanaQ, lte: fimSemanaQ } }, orderBy: { scheduledAt: 'asc' }, take: 5 }),
          getUserContext(user),
          memory.buildPersonalContext(user.id)
        ]);
        const ctx = `É domingo à noite, véspera de uma nova semana.\n${lembretesSemana.length > 0 ? `Próximos compromissos:\n${lembretesSemana.map(r => `• ${r.message}`).join('\n')}` : 'Sem compromissos agendados para a semana.'}\n${infoPessoal}`;
        const systemDomingo = `Você é a Clara, assistente pessoal. ${user.name ? `O nome é ${user.name}.` : ''}
Envie uma mensagem de domingo à noite — tranquila, motivadora e breve (2-3 linhas).
NÃO liste tarefas. NÃO agende nada. Tom: ${prefs.tom || 'carinhoso'}.
${ctx}`;
        const msg = await freeResponse('Envie mensagem de domingo.', [], { _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso', _systemOverride: systemDomingo });
        await sendMessage(user.phone, msg);
        await marcarEnviadoHoje(user.id, 'domingo_enviado');
        console.log(`[Domingo] Enviado para ${user.phone}`);
      } catch (e) { console.error(`[Domingo] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Domingo] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ─────────────────────────────────────────────
// SUMIÇO — detecta quem sumiu por 5+ dias (09:00)
// ─────────────────────────────────────────────
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
        const systemSumico = `Você é a Clara, assistente pessoal. ${user.name ? `O nome é ${user.name}.` : ''}
O usuário não conversa com você há ${diasSemConversa} dias.
Envie uma mensagem curta e genuína perguntando como ele está — sem ser dramática, sem cobrar.
Máx 2 linhas. Tom: ${prefs.tom || 'carinhoso'}.
${infoPessoal}`;
        const msg = await freeResponse('Mensagem para usuário que sumiu.', [], { _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso', _systemOverride: systemSumico });
        await sendMessage(user.phone, msg);
        await prisma.memory.create({ data: { userId: user.id, type: 'sumico_lock', content: lockKey } });
        console.log(`[Sumiço] ${user.phone} — ${diasSemConversa} dias sem conversar`);
      } catch (e) { console.error(`[Sumiço] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Sumiço] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ─────────────────────────────────────────────
// RESUMO DO MEIO-DIA (12:00)
// ─────────────────────────────────────────────
cron.schedule('0 12 * * *', async () => {
  try {
    const now = nowBRT();
    const hoje = dateBRT(now);
    const users = await prisma.user.findMany({ where: { blocked: false } });
    for (const user of users) {
      try {
        const inicioDia = new Date(`${hoje}T00:00:00-03:00`);
        const meioDia = new Date(`${hoje}T12:00:00-03:00`);
        const pendentes = await prisma.reminder.findMany({
          where: { userId: user.id, sent: true, confirmed: false, scheduledAt: { gte: inicioDia, lt: meioDia } }
        });
        if (!pendentes.length) continue;
        const lista = pendentes.map(r => {
          const h = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
          return '• ' + h + ' — ' + r.message;
        }).join('\n');
        const prefs = await prisma.preference.findFirst({ where: { userId: user.id } }).catch(() => null);
        const nome = prefs?.name || user.name || '';
        await sendMessage(user.phone, `⏰ ${nome ? nome + ', a' : 'A'}inda tem ${pendentes.length} ${pendentes.length === 1 ? 'tarefa da manhã pendente' : 'tarefas da manhã pendentes'}:\n\n${lista}\n\nConseguiu fazer alguma? Me avisa que dou baixa ou remarco pra você 😊`);
      } catch(e) { console.error('[Meio-dia]', e.message); }
    }
  } catch(e) { console.error('[Meio-dia] Erro:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ─────────────────────────────────────────────
// FECHAMENTO DO DIA (18:30)
// ─────────────────────────────────────────────
cron.schedule('30 18 * * *', async () => {
  try {
    const now = nowBRT();
    const hoje = dateBRT(now);
    const lockKey = `fechamento_${hoje}`;
    const jaEnviou = await prisma.memory.findFirst({ where: { type: lockKey } });
    if (jaEnviou) { console.log('[Fechamento] já enviado hoje'); return; }
    await prisma.memory.create({ data: { userId: 'system', type: lockKey, content: '1' } }).catch(() => {});

    const users = await prisma.user.findMany({ where: { blocked: false } });
    for (const user of users) {
      try {
        const lockUser = `fechamento_user_${hoje}`;
        const jaEnviouUser = await prisma.memory.findFirst({ where: { userId: user.id, type: lockUser } });
        if (jaEnviouUser) continue;
        await prisma.memory.create({ data: { userId: user.id, type: lockUser, content: new Date().toISOString() } });

        const inicioDia = new Date(`${hoje}T00:00:00-03:00`);
        const fimTarde = new Date(`${hoje}T18:30:00-03:00`);

        const pendentes = await prisma.reminder.findMany({
          where: { userId: user.id, sent: true, confirmed: false, scheduledAt: { gte: inicioDia, lte: fimTarde } },
          orderBy: { scheduledAt: 'asc' }
        });
        const concluidos = await prisma.reminder.findMany({
          where: { userId: user.id, confirmed: true, scheduledAt: { gte: inicioDia, lte: fimTarde } }
        });

        if (!pendentes.length && !concluidos.length) continue;

        const prefs = await prisma.preference.findFirst({ where: { userId: user.id } }).catch(() => null);
        const nome = prefs?.name || user.name || '';

        let msg = `📋 ${nome ? nome + ', r' : 'R'}esumo do seu dia:\n\n`;
        if (concluidos.length) msg += `✅ Concluídos hoje: ${concluidos.length}\n`;
        if (pendentes.length) {
          msg += `\n⚠️ Ainda pendentes (${pendentes.length}):\n`;
          pendentes.forEach(r => {
            const h = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
            msg += `• ${h} — ${r.message}\n`;
          });
          msg += `\nFez algum desses? Me avisa que dou baixa ou remarca pra amanhã 😊`;
        } else {
          msg += `\nTudo resolvido hoje! Que dia produtivo 🎉`;
        }

        await sendMessage(user.phone, msg);
        console.log(`[Fechamento] Enviado para ${user.phone}`);
      } catch (e) { console.error(`[Fechamento] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Fechamento] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ─────────────────────────────────────────────
// LEMBRETES (a cada minuto)
// ─────────────────────────────────────────────
cron.schedule('* * * * *', async () => {
  try {
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
      let msg;
      try {
        const user = await prisma.user.findFirst({ where: { phone: grupo.phone } });
        const prefs = user ? await prisma.preference.findFirst({ where: { userId: user.id } }) : null;
        const nome = prefs?.name || user?.name || null;

        if (grupo.reminders.length === 1) {
          const r = grupo.reminders[0];
          const system = `Você é a Clara, assistente pessoal. ${nome ? `O usuário se chama ${nome}.` : ''}
Envie uma notificação de lembrete calorosa e breve (máx 2 linhas).
O lembrete é: "${r.message}" às ${grupo.hora}.
Seja direta e encorajadora — não genérica.`;
          msg = await freeResponse('Envie a notificação deste lembrete.', [], { _systemOverride: system });
        } else {
          const titulos = grupo.reminders.map(r => `• ${r.message}`).join('\n');
          msg = `📌 Você tem ${grupo.reminders.length} lembretes agora\n\n${titulos}\n\n⏰ ${grupo.hora}\n\n${random(finais)}`;
        }
      } catch(e) {
        msg = grupo.reminders.length === 1
          ? `🔔 Lembrete\n\n${grupo.reminders[0].message}\n⏰ ${grupo.hora}\n\n${random(finais)}`
          : `📌 Você tem ${grupo.reminders.length} lembretes agora\n\n${grupo.reminders.map(r => `• ${r.message}`).join('\n')}\n\n⏰ ${grupo.hora}\n\n${random(finais)}`;
      }

      await sendMessage(grupo.phone, msg);

      // ── Feature 3: Recorrência — recria lembrete para próximo período ──
      for (const r of grupo.reminders) {
        if (r.recorrente && r.frequencia) {
          try {
            const proxima = new Date(r.scheduledAt);
            if (r.frequencia === 'diario') proxima.setDate(proxima.getDate() + 1);
            else if (r.frequencia === 'semanal') proxima.setDate(proxima.getDate() + 7);
            else if (r.frequencia === 'mensal') proxima.setMonth(proxima.getMonth() + 1);

            // Só recria se a próxima data for no futuro
            if (proxima > new Date()) {
              await prisma.reminder.create({
                data: {
                  userId: r.userId,
                  phone: r.phone,
                  message: r.message,
                  scheduledAt: proxima,
                  recorrente: true,
                  frequencia: r.frequencia,
                  sent: false,
                  confirmed: false,
                }
              });
              console.log(`[Recorrência] Recriado: "${r.message}" → ${proxima.toISOString()}`);
            }
          } catch(e) { console.error(`[Recorrência] Erro ao recriar lembrete ${r.id}:`, e.message); }
        }
      }

      await prisma.reminder.updateMany({
        where: { id: { in: grupo.reminders.map(r => r.id) } },
        data: { sent: true }
      });
      console.log(`[Reminder] ${grupo.phone} → ${grupo.reminders.length} lembrete(s)`);
    }
  } catch (e) { console.error('[Reminder] Erro:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ─────────────────────────────────────────────
// MEDICAMENTOS (a cada minuto)
// ─────────────────────────────────────────────
cron.schedule('* * * * *', async () => {
  try {
    const nowLocal = nowBRT();
    const minutoChave = `${pad(nowLocal.getHours())}:${pad(nowLocal.getMinutes())}`;
    const meds = await prisma.medication.findMany({ where: { active: true, remaining: { gt: 0 } }, include: { user: true } });

    for (const med of meds) {
      try {
        let horarios = []; try { horarios = JSON.parse(med.times || '[]'); } catch {}
        if (!horarios.includes(minutoChave)) continue;
        const phone = med.user?.phone || (await prisma.user.findUnique({ where: { id: med.userId } }))?.phone;
        if (!phone) continue;
        const lockKey = `med_${med.id}_${minutoChave}`;
        if (await prisma.memory.findFirst({ where: { type: 'med_lock', content: lockKey } })) continue;
        await prisma.memory.create({ data: { userId: med.userId, type: 'med_lock', content: lockKey } });
        const msg = `💊 Hora do medicamento!\n\n*${med.name}*\n⏰ ${minutoChave}\n\nNão esquece de tomar certinho 😊\n\n💜 Restam ${med.remaining - 1} doses.`;
        await sendMessage(phone, msg);
        await prisma.medication.update({ where: { id: med.id }, data: { remaining: { decrement: 1 } } });
        console.log(`[Med] ${med.name} → ${phone}`);
      } catch (e) { console.error(`[Med] Erro ${med.id}:`, e.message); }
    }
  } catch (e) { console.error('[Med] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ─────────────────────────────────────────────
// MENSAGENS AGENDADAS PARA CONTATOS (a cada minuto)
// ─────────────────────────────────────────────
cron.schedule('* * * * *', async () => {
  try {
    const now = nowBRT();
    const msgs = await prisma.scheduledMessage.findMany({
      where: { sent: false, scheduledAt: { lte: now } },
      orderBy: { scheduledAt: 'asc' }
    });
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
      } catch (e) { console.error(`[Msg Agendada] Erro msg ${msg.id}:`, e.message); }
    }
  } catch (e) { console.error('[Msg Agendada] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ─────────────────────────────────────────────
// LIMPEZA DE LOCKS ANTIGOS (03:00)
// ─────────────────────────────────────────────
cron.schedule('0 3 * * *', async () => {
  try {
    const ontem = new Date(nowBRT()); ontem.setDate(ontem.getDate() - 2);
    await prisma.memory.deleteMany({
      where: {
        type: { in: ['med_lock', 'alerta_data_lock', 'proativa_lock', 'sumico_lock'] },
        createdAt: { lt: ontem }
      }
    });
    console.log('[Cleanup] Locks antigos removidos');
  } catch (e) { console.error('[Cleanup] Erro:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ─────────────────────────────────────────────
// LIMPEZA DE LEMBRETES NÃO CONFIRMADOS > 48h (04:00)
// ─────────────────────────────────────────────
cron.schedule('0 4 * * *', async () => {
  try {
    const limite = new Date(nowBRT().getTime() - 48 * 60 * 60 * 1000);
    const resultado = await prisma.reminder.deleteMany({
      where: { confirmed: false, scheduledAt: { lt: limite } }
    });
    if (resultado.count > 0) {
      console.log(`[Cleanup Lembretes] ${resultado.count} lembrete(s) não confirmados com mais de 48h removidos`);
    }
  } catch (e) { console.error('[Cleanup Lembretes] Erro:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ─────────────────────────────────────────────
// FEATURE 4: ALERTA ESTOQUE BAIXO DE REMÉDIO (08:30)
// ─────────────────────────────────────────────
cron.schedule('30 8 * * *', async () => {
  try {
    const LIMITE_DOSES = 5;
    const meds = await prisma.medication.findMany({
      where: { active: true, remaining: { gt: 0, lte: LIMITE_DOSES } },
      include: { user: true }
    });

    for (const med of meds) {
      try {
        const phone = med.user?.phone || (await prisma.user.findUnique({ where: { id: med.userId } }))?.phone;
        if (!phone) continue;

        // Lock: avisar no máximo 1x por dia por remédio
        const lockKey = `estoque_baixo_${med.id}_${dateBRT()}`;
        if (await prisma.memory.findFirst({ where: { type: 'estoque_lock', content: lockKey } })) continue;
        await prisma.memory.create({ data: { userId: med.userId, type: 'estoque_lock', content: lockKey } });

        const urgencia = med.remaining === 1 ? '🚨 Última dose!' : `⚠️ Restam apenas ${med.remaining} doses`;
        await sendMessage(phone,
          `💊 ${urgencia}\n\n*${med.name}* está acabando.\n\nNão esquece de comprar mais para não interromper o tratamento! 🏥`
        );
        console.log(`[Estoque] Alerta enviado: ${med.name} → ${phone} (${med.remaining} doses)`);
      } catch (e) { console.error(`[Estoque] Erro ${med.id}:`, e.message); }
    }
  } catch (e) { console.error('[Estoque] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

console.log('Clara scheduler iniciado 💜');
