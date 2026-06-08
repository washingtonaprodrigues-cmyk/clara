const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const { sendMessage } = require('../services/whatsapp');
const { freeResponse } = require('../services/groq');
const memory = require('../services/memory');

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
  '💜 Estou por aqui.',
  '😊 Me avisa quando concluir.',
  '✨ Tudo certo por aí?',
  '💜 Pode deixar comigo.',
];

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

async function jaEnviouHoje(userId, tipo) {
  const hoje = dateBRT();
  return prisma.memory.findFirst({
    where: { userId, type: tipo, content: hoje }
  });
}

async function marcarEnviadoHoje(userId, tipo) {
  await prisma.memory.create({
    data: { userId, type: tipo, content: dateBRT() }
  });
}

async function getUserContext(user) {
  const prefs = await memory.getUserPreference(user.id);
  const perfilTexto = await memory.buildPersonalContext(user.id);
  return { prefs, perfilTexto };
}

// ─────────────────────────────────────────────
// BOM DIA INTELIGENTE (07:00)
// ─────────────────────────────────────────────
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
        if (await jaEnviouHoje(user.id, 'bom_dia_enviado')) continue;
        await marcarEnviadoHoje(user.id, 'bom_dia_enviado');

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
        const nome = user.name ? `, ${user.name}` : '';

        // Monta contexto para IA gerar bom dia personalizado
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
Envie uma mensagem de bom dia personalizada, calorosa e breve (máx 5 linhas).
Use o contexto abaixo para torná-la relevante. Mencione compromissos do dia se houver.
Se souber algo pessoal do usuário (família, trabalho, hábitos), faça uma referência natural.
NÃO liste os lembretes em formato de lista — mencione de forma conversacional.
NÃO agende nada. NÃO termine com "Como posso ajudar?".
Tom: ${prefs.tom || 'carinhoso'}.

${ctx}`;

        const msg = await freeResponse('Envie uma mensagem de bom dia para o usuário.', [], { _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso', _systemOverride: systemBomDia });
        await sendMessage(user.phone, msg);
        console.log(`[Bom dia] Enviado para ${user.phone}`);
      } catch (e) {
        console.error(`[Bom dia] Erro ${user.phone}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[Bom dia] Erro geral:', e.message);
  }
}, { timezone: 'America/Sao_Paulo' });

// ─────────────────────────────────────────────
// BOA NOITE INTELIGENTE (21:30)
// ─────────────────────────────────────────────
cron.schedule('30 21 * * *', async () => {
  try {
    const now = nowBRT();
    const hoje = dateBRT(now);
    const amanha = new Date(now); amanha.setDate(amanha.getDate() + 1);
    const amanhaStr = dateBRT(amanha);

    const users = await prisma.user.findMany({ where: { blocked: false } });

    for (const user of users) {
      try {
        if (await jaEnviouHoje(user.id, 'boa_noite_enviado')) continue;
        await marcarEnviadoHoje(user.id, 'boa_noite_enviado');

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
Envie uma mensagem de boa noite calorosa e breve (máx 4 linhas).
Se houver compromissos amanhã, mencione de forma natural (não em lista).
Se o usuário concluiu tarefas hoje, celebre levemente.
Se souber algo pessoal, faça uma referência natural.
NÃO pergunte "Como posso ajudar?". NÃO agende nada.
Tom: ${prefs.tom || 'carinhoso'}.

${ctx}`;

        const msg = await freeResponse('Envie uma mensagem de boa noite para o usuário.', [], { _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso', _systemOverride: systemBoaNoite });
        await sendMessage(user.phone, msg);
        console.log(`[Boa noite] Enviado para ${user.phone}`);
      } catch (e) {
        console.error(`[Boa noite] Erro ${user.phone}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[Boa noite] Erro geral:', e.message);
  }
}, { timezone: 'America/Sao_Paulo' });

// ─────────────────────────────────────────────
// ALERTAS DE DATAS IMPORTANTES (08:00)
// Aniversários, eventos, datas especiais
// ─────────────────────────────────────────────
cron.schedule('0 8 * * *', async () => {
  try {
    const now = nowBRT();
    const daqui7 = new Date(now); daqui7.setDate(daqui7.getDate() + 7);
    const daqui3 = new Date(now); daqui3.setDate(daqui3.getDate() + 3);
    const daqui1 = new Date(now); daqui1.setDate(daqui1.getDate() + 1);

    const users = await prisma.user.findMany({ where: { blocked: false } });

    for (const user of users) {
      try {
        // Busca memórias pessoais com datas
        const infos = await memory.getPersonalInfo(user.id, 'datas');

        for (const [chave, { valor }] of Object.entries(infos)) {
          // Tenta extrair dia/mês do valor (ex: "Aniversário em 15 de março")
          const match = valor.match(/(\d{1,2})\s+de\s+(\w+)/i);
          if (!match) continue;

          const mesesMap = { janeiro:1,fevereiro:2,março:3,abril:4,maio:5,junho:6,julho:7,agosto:8,setembro:9,outubro:10,novembro:11,dezembro:12 };
          const dia = parseInt(match[1]);
          const mes = mesesMap[match[2].toLowerCase()];
          if (!dia || !mes) continue;

          const anoAtual = now.getFullYear();
          const dataEvento = new Date(anoAtual, mes - 1, dia);
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
            console.log(`[Datas] Alerta enviado: ${chave} → ${user.phone}`);
          }
        }

        // Verifica também tabela Event
        const hoje = dateBRT(now);
        const eventos = await prisma.event.findMany({
          where: { userId: user.id, notified: false }
        });

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
            console.log(`[Eventos] Alerta enviado: ${ev.title} → ${user.phone}`);
          }
        }
      } catch (e) {
        console.error(`[Datas] Erro ${user.phone}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[Datas] Erro geral:', e.message);
  }
}, { timezone: 'America/Sao_Paulo' });

// ─────────────────────────────────────────────
// MENSAGENS PROATIVAS INTELIGENTES (10:00 e 15:00)
// Follow-ups naturais sobre contexto do usuário
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

        // Só envia se usuário conversou nos últimos 3 dias (não incomoda quem sumiu)
        const ultimaConversa = await prisma.memory.findFirst({
          where: { userId: user.id, type: 'conversa' },
          orderBy: { createdAt: 'desc' }
        });
        if (!ultimaConversa) continue;
        const diasSemConversa = (now - new Date(ultimaConversa.createdAt)) / (1000 * 60 * 60 * 24);
        if (diasSemConversa > 3) continue;

        // Busca contexto rico
        const [infoPessoal, memsRecentes, { prefs }] = await Promise.all([
          memory.buildPersonalContext(user.id),
          memory.getRecentMemories(user.id, 15),
          getUserContext(user)
        ]);

        if (!infoPessoal && memsRecentes.length < 3) continue; // Pouco contexto, não envia

        // Seleciona aleatoriamente 1 em cada 3 usuários por período (não spam)
        if (Math.random() > 0.33) continue;

        const contextoMems = memsRecentes
          .filter(m => !['conversa','bom_dia_enviado','boa_noite_enviado','proativa_lock','med_lock','alerta_data_lock'].includes(m.type))
          .slice(0, 8)
          .map(m => `[${m.type}] ${m.content}`)
          .join('\n');

        const systemProativa = `Você é a Clara, assistente pessoal íntima e proativa.
${user.name ? `O nome do usuário é ${user.name}.` : ''}
Tom: ${prefs.tom || 'carinhoso'}.

Com base no que você sabe sobre o usuário, envie UMA mensagem proativa curta e natural (1-3 linhas).
Pode ser:
- Um follow-up sobre algo que ele mencionou recentemente ("E aquele projeto, como está indo?")
- Uma observação sobre seus interesses ("Vi que você gosta de marketing — tem um assunto interessante rolando")
- Um lembrete gentil sobre algo que ele comentou
- Uma pergunta de acompanhamento sobre metas ou objetivos
- Uma celebração se ele atingiu algo

REGRAS:
- Seja NATURAL, como uma amiga enviando mensagem
- NÃO comece com "Olá" ou "Oi [nome]!" — seja direto
- NÃO agende nada, NÃO liste tarefas
- Se não tiver contexto suficiente para algo relevante, responda APENAS: SKIP
- Prefira perguntas abertas que convidam à conversa

Contexto recente do usuário:
${contextoMems}
${infoPessoal}`;

        const msg = await freeResponse('Envie uma mensagem proativa para o usuário.', [], {
          _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso', _systemOverride: systemProativa
        });

        if (!msg || msg.trim() === 'SKIP' || msg.length < 5) continue;

        await sendMessage(user.phone, msg);
        await prisma.memory.create({ data: { userId: user.id, type: 'proativa_lock', content: lockKey } });
        console.log(`[Proativa ${periodo}] Enviado para ${user.phone}: ${msg.slice(0,50)}`);
      } catch (e) {
        console.error(`[Proativa] Erro ${user.phone}:`, e.message);
      }
    }
  } catch (e) {
    console.error(`[Proativa ${periodo}] Erro geral:`, e.message);
  }
}

// ─────────────────────────────────────────────
// TRADIÇÕES SEMANAIS
// Toda sexta às 17h / Todo domingo às 19h
// ─────────────────────────────────────────────
cron.schedule('0 17 * * 5', async () => {
  // Sexta-feira: resumo da semana
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

        const ctx = `É sexta-feira à tarde.
Essa semana o usuário:
- Concluiu ${tarefasSemana.length} compromisso(s)
${totalGasto > 0 ? `- Registrou R$ ${totalGasto.toFixed(2)} em gastos` : ''}
${infoPessoal}`;

        const systemSexta = `Você é a Clara, assistente pessoal. ${user.name ? `O nome é ${user.name}.` : ''}
Envie uma mensagem de sexta-feira calorosa e breve (2-3 linhas).
Pode celebrar a semana, fazer um comentário leve sobre o que aconteceu, ou simplesmente dar um "sextou" com personalidade.
Se souber algo pessoal do usuário, mencione naturalmente.
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

cron.schedule('0 19 * * 0', async () => {
  // Domingo: preparação para a semana
  try {
    const users = await prisma.user.findMany({ where: { blocked: false } });
    const now = nowBRT();
    const semanaQ = new Date(now); semanaQ.setDate(now.getDate() + 1);
    const fimSemanaQ = new Date(now); fimSemanaQ.setDate(now.getDate() + 7);

    for (const user of users) {
      try {
        if (await jaEnviouHoje(user.id, 'domingo_enviado')) continue;

        const [lembretesSemana, { prefs }, infoPessoal] = await Promise.all([
          prisma.reminder.findMany({
            where: { userId: user.id, confirmed: false, sent: false, scheduledAt: { gte: semanaQ, lte: fimSemanaQ } },
            orderBy: { scheduledAt: 'asc' }, take: 5
          }),
          getUserContext(user),
          memory.buildPersonalContext(user.id)
        ]);

        const ctx = `É domingo à noite, véspera de uma nova semana.
${lembretesSemana.length > 0 ? `Próximos compromissos da semana:\n${lembretesSemana.map(r => `• ${r.message}`).join('\n')}` : 'Sem compromissos agendados para a semana.'}
${infoPessoal}`;

        const systemDomingo = `Você é a Clara, assistente pessoal. ${user.name ? `O nome é ${user.name}.` : ''}
Envie uma mensagem de domingo à noite — tranquila, motivadora e breve (2-3 linhas).
Pode ser sobre preparação para a semana, descanso, ou simplesmente um boa noite especial de domingo.
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

        const ultimaConversa = await prisma.memory.findFirst({
          where: { userId: user.id, type: 'conversa' },
          orderBy: { createdAt: 'desc' }
        });
        if (!ultimaConversa) continue;

        const diasSemConversa = Math.round((now - new Date(ultimaConversa.createdAt)) / (1000 * 60 * 60 * 24));

        // Só envia se sumiu entre 5 e 7 dias (não toda semana)
        if (diasSemConversa < 5 || diasSemConversa > 7) continue;

        const { prefs } = await getUserContext(user);
        const infoPessoal = await memory.buildPersonalContext(user.id);

        const systemSumico = `Você é a Clara, assistente pessoal. ${user.name ? `O nome é ${user.name}.` : ''}
O usuário não conversa com você há ${diasSemConversa} dias.
Envie uma mensagem curta e genuína perguntando como ele está — sem ser dramática, sem cobrar.
Pode fazer uma referência a algo que ele mencionou antes, se souber.
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
// LEMBRETES (a cada minuto)
// ─────────────────────────────────────────────
cron.schedule('* * * * *', async () => {
  try {
    const now = nowBRT();
    const reminders = await prisma.reminder.findMany({
      where: { sent: false, confirmed: false, scheduledAt: { lte: now } },
      orderBy: { scheduledAt: 'asc' }
    });
    if (!reminders.length) return;

    const grupos = {};
    for (const r of reminders) {
      const hora = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', {
        timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit'
      });
      const key = `${r.phone}_${hora}`;
      if (!grupos[key]) grupos[key] = { phone: r.phone, hora, reminders: [] };
      grupos[key].reminders.push(r);
    }

    for (const key of Object.keys(grupos)) {
      const grupo = grupos[key];
      let msg = grupo.reminders.length === 1
        ? `🔔 Lembrete\n\n${grupo.reminders[0].message}\n⏰ ${grupo.hora}\n\n${random(finais)}`
        : `📌 Você tem ${grupo.reminders.length} lembretes agora\n\n${grupo.reminders.map(r => `• ${r.message}`).join('\n')}\n\n⏰ ${grupo.hora}\n\n${random(finais)}`;

      await sendMessage(grupo.phone, msg);
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
    const now = nowBRT();
    const minutoChave = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

    const meds = await prisma.medication.findMany({
      where: { active: true, remaining: { gt: 0 } },
      include: { user: true }
    });

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
// LIMPEZA DE LOCKS (03:00)
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

console.log('Clara scheduler iniciado 💜');
