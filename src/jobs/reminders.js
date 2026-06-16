const cron = require('node-cron');

// sendMessage com fallback direto via axios — evita o mesmo problema de
// circular dependency / ordem de carregamento que ocorreu no handler.js
// (sendMessage is not a function quando importado por destructuring direto).
async function sendMessage(phone, msg, delay) {
  try {
    const w = require('../services/whatsapp');
    if (w && typeof w.sendMessage === 'function') {
      return w.sendMessage(phone, msg, delay);
    }
  } catch (e) {
    console.error('[Reminders] Erro ao carregar whatsapp.js:', e.message);
  }
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

function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}
function pad(n) { return String(n).padStart(2, '0'); }
function dateBRT(d = nowBRT()) {
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function random(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function tomDesc(tom) {
  return {
    carinhoso: 'calorosa e próxima, como uma amiga que genuinamente se importa. Use emojis com moderação. Varie sempre o jeito de falar.',
    direto: 'direta e objetiva, sem rodeios ou fofice. Vá ao ponto. Sem emojis desnecessários.',
    divertido: 'animada, com humor e energia, usando gírias naturais. Leve e bem-humorada.',
    sarcastico: 'sarcástica e sem filtro — usa ironia fina, deboche carinhoso, nunca elogia à toa. Fala a verdade com um sorrisinho. NUNCA seja sentimental ou emotiva. Tom ácido mas com carinho real por baixo.',
  }[tom || 'carinhoso'] || 'calorosa e próxima, como uma amiga que genuinamente se importa.';
}

const finais = [
  '😊 Me avisa quando concluir.',
  '✨ Estou de olho pra você!',
  '🔔 Não deixo você esquecer.',
  '😊 Conta comigo.',
  '💜 Boa sorte com isso!',
];

async function jaEnviouHoje(userId, tipo) {
  const hoje = dateBRT();
  return prisma.memory.findFirst({ where: { userId, type: tipo, content: hoje } });
}

async function marcarEnviadoHoje(userId, tipo) {
  await prisma.memory.create({ data: { userId, type: tipo, content: dateBRT() } });
}

// Lock atomico por usuario/tipo/dia.
// Retorna true se esta chamada "ganhou" o lock (deve processar/enviar),
// e false se ja havia um lock para hoje (outra execucao ja esta/esteve
// processando - pular). Marcar o lock ANTES de gerar a mensagem evita
// duplicidade quando o cron dispara em paralelo (duas replicas, restart
// no mesmo minuto, etc).
//
// NOTA: o model Memory não tem @@unique([userId, type]) no schema, então
// não é possível usar upsert com where: { userId_type: {...} } (esse nome
// de campo composto só existe quando há esse unique constraint). Por isso
// usamos findFirst + create/update manual.
async function tentarLockDiario(userId, tipo) {
  const hoje = dateBRT();
  const existente = await prisma.memory.findFirst({
    where: { userId, type: tipo },
    orderBy: { createdAt: 'desc' }
  }).catch(() => null);

  if (existente && existente.content === hoje) return false;

  if (existente) {
    await prisma.memory.update({
      where: { id: existente.id },
      data: { content: hoje }
    });
  } else {
    await prisma.memory.create({
      data: { userId, type: tipo, content: hoje }
    });
  }
  return true;
}

async function getUserContext(user) {
  const prefs = await memory.getUserPreference(user.id);
  const perfilTexto = await memory.buildPersonalContext(user.id);
  return { prefs, perfilTexto };
}

// BOM DIA INTELIGENTE (07:05)
cron.schedule('5 7 * * *', async () => {
  try {
    const now = nowBRT();
    const amanha = new Date(now); amanha.setDate(amanha.getDate() + 1);
    const amanhaStr = dateBRT(amanha);
    const hoje = dateBRT(now);
    const diasSemana = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
    const meses = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
    const diaTexto = `${diasSemana[now.getDay()]}, ${now.getDate()} de ${meses[now.getMonth()]}`;

    const users = await prisma.user.findMany({ where: { blocked: false } });

    for (const user of users) {
      try {
        if (!(await tentarLockDiario(user.id, 'bom_dia_lock'))) {
          console.log(`[Bom dia] ja enviado/processando hoje para ${user.phone}`);
          continue;
        }

        const inicioHoje = new Date(`${hoje}T00:00:00-03:00`);
        const fimHoje = new Date(`${hoje}T23:59:59-03:00`);

        const [lembretes, eventos, infoPessoal] = await Promise.all([
          prisma.reminder.findMany({
            where: { userId: user.id, confirmed: false, sent: false, scheduledAt: { gte: inicioHoje, lte: fimHoje } },
            orderBy: { scheduledAt: 'asc' }, take: 5
          }),
          prisma.event.findMany({
            where: { userId: user.id, date: { gte: inicioHoje, lte: new Date(`${amanhaStr}T23:59:59-03:00`) } }
          }).catch(() => []),
          memory.buildPersonalContext(user.id)
        ]);

        const { prefs } = await getUserContext(user);

        let ctx = `Hoje é ${diaTexto}.\n`;
        const totalLembretes = lembretes.length;
        if (lembretes.length > 0) {
          ctx += `\nLembretes de hoje (${totalLembretes} no total):\n`;
          lembretes.forEach(r => {
            const h = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
            ctx += `• ${h} — ${r.message}\n`;
          });
        }
        if (eventos.length > 0) {
          ctx += `\nEventos próximos:\n`;
          eventos.forEach(e => { ctx += `• ${e.title}${e.personName ? ` (${e.personName})` : ''}\n`; });
        }
        if (infoPessoal) ctx += infoPessoal;

        let systemBomDia;
        if (totalLembretes > 0) {
          const primeira = lembretes[0];
          const horaPrimeira = new Date(primeira.scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
          systemBomDia = `Você é a Clara, assistente pessoal. ${user.name ? `O nome do usuário é ${user.name}.` : ''}
Crie uma mensagem de bom dia OBJETIVA e INFORMATIVA — um resumo rápido do dia, não poética.

CONTEXTO DO DIA:
${ctx}

REGRAS OBRIGATÓRIAS:
- 2-3 linhas, direto ao ponto
- Diga "Bom dia" + quantas tarefas/compromissos tem hoje (${totalLembretes}) + qual é a primeira (${primeira.message} às ${horaPrimeira})
- Encerre com algo curto tipo "estarei aqui pra te lembrar de tudo" — adaptado ao seu tom
- Varie a abertura — não repita sempre a mesma frase
- Use no máximo 1 emoji
- NÃO seja sentimental ou poética. Seja prática.
Tom: ${prefs.tom || 'carinhoso'}.`;
        } else {
          systemBomDia = `Você é a Clara, assistente pessoal. ${user.name ? `O nome do usuário é ${user.name}.` : ''}
Crie uma mensagem de bom dia SIMPLES e HUMANA — como se fosse a primeira vez que fala com a pessoa naquele dia.

CONTEXTO DO DIA:
${ctx}

REGRAS OBRIGATÓRIAS:
- Máximo 2-3 linhas
- Sem compromissos hoje — diga algo positivo e leve sobre o dia, sem mencionar a ausência de tarefas
- Varie sempre a abertura — NUNCA repita "Bom dia, [nome]! ☀️"
- Use no máximo 1 emoji
- NÃO pergunte. NÃO agende nada.
Tom: ${prefs.tom || 'carinhoso'}.`;
        }

        const msg = await freeResponse('Envie uma mensagem de bom dia para o usuário.', [], { _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso', _systemOverride: systemBomDia });
        if (!msg) { console.log(`[Bom dia] Rate limit, pulado para ${user.phone}`); continue; }
        await sendMessage(user.phone, msg);

        // ── Criar "Meu Dia" — lista especial sem horário ──
        // Criada automaticamente junto com o bom dia. Respeita flag de
        // exclusão permanente (meu_dia_desativado) caso o usuário tenha
        // pedido pra parar de criar.
        try {
          const desativado = await prisma.memory.findFirst({
            where: { userId: user.id, type: 'meu_dia_desativado' }
          });
          if (!desativado) {
            const jaTemHoje = await prisma.memory.findFirst({
              where: { userId: user.id, type: 'meu_dia_criado', content: dateBRT() }
            });
            if (!jaTemHoje) {
              // Busca tarefas pendentes sem horário ou com horário passado não confirmadas
              const tarefasPendentes = await prisma.reminder.findMany({
                where: { userId: user.id, confirmed: false, sent: false,
                  scheduledAt: { gte: new Date(`${dateBRT()}T00:00:00-03:00`), lte: new Date(`${dateBRT()}T23:59:59-03:00`) }
                },
                orderBy: { scheduledAt: 'asc' }, take: 10
              });

              // Monta lista "Meu Dia" no formato de grocery list existente
              const itens = tarefasPendentes.map((t, i) => ({
                id: i + 1,
                nome: t.message,
                done: false,
                lembreteId: t.id
              }));

              // Adiciona item padrão se lista vazia
              if (itens.length === 0) {
                itens.push({ id: 1, nome: 'Adicione tarefas do seu dia aqui 📝', done: false });
              }

              await prisma.groceryList.create({
                data: {
                  userId: user.id,
                  name: '📅 Meu Dia',
                  items: JSON.stringify(itens),
                  done: false
                }
              });
              await prisma.memory.create({
                data: { userId: user.id, type: 'meu_dia_criado', content: dateBRT() }
              });
              console.log(`[Meu Dia] Criado para ${user.phone}`);
            }
          }
        } catch (eMeuDia) { console.error(`[Meu Dia] Erro ${user.phone}:`, eMeuDia.message); }

        console.log(`[Bom dia] Enviado para ${user.phone}`);
      } catch (e) { console.error(`[Bom dia] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Bom dia] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// BOA NOITE INTELIGENTE (22:00)
cron.schedule('0 22 * * *', async () => {
  try {
    const now = nowBRT();
    const hoje = dateBRT(now);
    const amanha = new Date(now); amanha.setDate(amanha.getDate() + 1);
    const amanhaStr = dateBRT(amanha);
    const users = await prisma.user.findMany({ where: { blocked: false } });

    for (const user of users) {
      try {
        if (!(await tentarLockDiario(user.id, 'boa_noite_lock'))) {
          console.log(`[Boa noite] ja enviado/processando hoje para ${user.phone}`);
          continue;
        }

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
          ctx += `\nAmanhã tem ${lembretesAmanha.length} compromisso(s):\n`;
          lembretesAmanha.forEach(r => {
            const h = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
            ctx += `• ${h} — ${r.message}\n`;
          });
        }
        if (infoPessoal) ctx += infoPessoal;

        let systemBoaNoite;
        if (totalHoje > 0 || lembretesAmanha.length > 0) {
          systemBoaNoite = `Você é a Clara, assistente pessoal. ${user.name ? `O nome do usuário é ${user.name}.` : ''}
Crie uma mensagem de boa noite OBJETIVA — um resumo rápido do dia, não poética.

CONTEXTO DO DIA:
${ctx}

REGRAS OBRIGATÓRIAS:
- 2-3 linhas, direto ao ponto
- Se concluiu tarefas hoje (${concluidasHoje}/${totalHoje}), parabenize brevemente por isso
- Se tem compromissos amanhã (${lembretesAmanha.length}), mencione a quantidade de forma breve
- Encerre com algo curto tipo "durma bem, estarei aqui pra te ajudar amanhã" — adaptado ao seu tom
- Varie a abertura — não repita sempre a mesma frase
- Máximo 1 emoji
- NÃO seja sentimental ou poética. Seja prática.
Tom: ${prefs.tom || 'carinhoso'}.`;
        } else {
          systemBoaNoite = `Você é a Clara, assistente pessoal. ${user.name ? `O nome do usuário é ${user.name}.` : ''}
Crie uma mensagem de boa noite SIMPLES — como quem se despede de verdade ao final do dia.

CONTEXTO DO DIA:
${ctx}

REGRAS OBRIGATÓRIAS:
- Máximo 2-3 linhas, sem emojis
- Considere o dia da semana
- Varie sempre a abertura
- Encerre com algo caloroso e diferente a cada dia
- NÃO mencione falta de compromissos. NÃO pergunte. NÃO agende nada.
Tom: ${prefs.tom || 'carinhoso'}.`;
        }

        const msg = await freeResponse('Envie uma mensagem de boa noite para o usuário.', [], { _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso', _systemOverride: systemBoaNoite });
        if (!msg) { console.log(`[Boa noite] Rate limit, pulado para ${user.phone}`); continue; }
        await sendMessage(user.phone, msg);
        console.log(`[Boa noite] Enviado para ${user.phone}`);
      } catch (e) { console.error(`[Boa noite] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Boa noite] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ALERTAS DE DATAS IMPORTANTES (08:00)
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

        const eventos = await prisma.event.findMany({ where: { userId: user.id, notified: false } }).catch(() => []);
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

// MENSAGENS PROATIVAS INTELIGENTES (10:00 e 15:00)
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
        const tomDesc = {
          carinhoso: 'calorosa e próxima, como uma amiga que genuinamente se importa',
          direto: 'direta e objetiva, sem rodeios ou fofice',
          divertido: 'animada, com humor e energia, usando gírias naturais',
          sarcastico: 'sarcástica e sem filtro — usa ironia fina, deboche carinhoso, nunca elogia à toa. Fala a verdade com um sorrisinho. NUNCA seja sentimental ou emotiva.'
        }[prefs.tom || 'carinhoso'] || 'calorosa e próxima';

        const systemProativa = `Você é a Clara, parceira pessoal do ${user.name || 'usuário'} no WhatsApp.
SEU TOM AGORA: ${tomDesc}

Envie UMA mensagem curta e natural (1-2 linhas) como parceira presente — não como assistente genérica.
REGRAS:
- NUNCA comece com "Oi", "Olá" ou nome da pessoa
- NÃO agende nada, NÃO liste tarefas
- Use o contexto para algo genuíno e específico — nunca genérico
- Se não tiver nada relevante ou o contexto for fraco, responda APENAS: SKIP
- Respeite rigorosamente o tom acima — não misture estilos

Contexto recente: ${contextoMems}
${infoPessoal}`;
        const msg = await freeResponse('Envie uma mensagem proativa.', [], { _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso', _systemOverride: systemProativa });
        if (!msg || msg.trim() === 'SKIP' || msg.length < 5) continue;
        await sendMessage(user.phone, msg);
        await prisma.memory.create({ data: { userId: user.id, type: 'proativa_lock', content: lockKey } });
        console.log(`[Proativa ${periodo}] Enviado para ${user.phone}`);
      } catch (e) { console.error(`[Proativa] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error(`[Proativa ${periodo}] Erro geral:`, e.message); }
}

// TRADIÇÕES SEMANAIS — SEXTA (17:00)
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
        const ctxSexta = tarefasSemana.length > 0
          ? `Essa semana o usuário concluiu ${tarefasSemana.length} compromisso(s)${totalGasto > 0 ? ` e registrou R$ ${totalGasto.toFixed(2)} em gastos` : ''}.`
          : ``;
        const ctx = `É sexta-feira à tarde.\n${ctxSexta}\n${infoPessoal}`;
        const systemSexta = `Você é a Clara, assistente pessoal. ${user.name ? `O nome é ${user.name}.` : ''}
Envie uma mensagem de sexta-feira calorosa e breve (2-3 linhas).
NÃO liste tarefas. NÃO agende nada. Tom: ${prefs.tom || 'carinhoso'}.
${ctx}`;
        const msg = await freeResponse('Envie mensagem de sexta.', [], { _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso', _systemOverride: systemSexta });
        if (!msg) { console.log(`[Sexta] Rate limit, pulado para ${user.phone}`); continue; }
        await sendMessage(user.phone, msg);
        await marcarEnviadoHoje(user.id, 'sexta_enviado');
        console.log(`[Sexta] Enviado para ${user.phone}`);
      } catch (e) { console.error(`[Sexta] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Sexta] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// TRADIÇÕES SEMANAIS — DOMINGO (19:00)
cron.schedule('0 19 * * 0', async () => {
  try {
    const users = await prisma.user.findMany({ where: { blocked: false } });
    const now = nowBRT();
    const semanaQ = new Date(now); semanaQ.setDate(now.getDate() + 1);
    const fimSemanaQ = new Date(now); fimSemanaQ.setDate(now.getDate() + 7);
    for (const user of users) {
      try {
        if (!(await tentarLockDiario(user.id, 'domingo_enviado'))) {
          console.log(`[Domingo] ja enviado/processando hoje para ${user.phone}`);
          continue;
        }

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
        if (!msg) { console.log(`[Domingo] Rate limit, pulado para ${user.phone}`); continue; }
        await sendMessage(user.phone, msg);
        console.log(`[Domingo] Enviado para ${user.phone}`);
      } catch (e) { console.error(`[Domingo] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Domingo] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// SUMIÇO — detecta quem sumiu por 5+ dias (09:00)
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
        if (!msg) { console.log(`[Sumiço] Rate limit, pulado para ${user.phone}`); continue; }
        await sendMessage(user.phone, msg);
        await prisma.memory.create({ data: { userId: user.id, type: 'sumico_lock', content: lockKey } });
        console.log(`[Sumiço] ${user.phone} — ${diasSemConversa} dias sem conversar`);
      } catch (e) { console.error(`[Sumiço] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Sumiço] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// RESUMO DO MEIO-DIA (12:00)
cron.schedule('0 12 * * *', async () => {
  try {
    const now = nowBRT();
    const hoje = dateBRT(now);
    const users = await prisma.user.findMany({ where: { blocked: false } });
    for (const user of users) {
      try {
        const lockMeioDia = `meio_dia_${hoje}`;
        if (await prisma.memory.findFirst({ where: { userId: user.id, type: 'meio_dia_lock', content: lockMeioDia } })) continue;

        const inicioDia = new Date(`${hoje}T00:00:00-03:00`);
        const meioDia = new Date(`${hoje}T12:00:00-03:00`);
        const pendentes = await prisma.reminder.findMany({
          where: { userId: user.id, sent: true, confirmed: false, scheduledAt: { gte: inicioDia, lt: meioDia } }
        });
        if (!pendentes.length) continue;

        const prefs = await memory.getUserPreference(user.id).catch(() => null);
        const listaPendentes = pendentes.map(r => {
          const h = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
          return `• ${h} — ${r.message}`;
        }).join('\n');

        const systemMeioDia = `Você é a Clara, assistente pessoal. ${user.name ? `O nome do usuário é ${user.name}.` : ''}
São 12h do dia. O usuário tem ${pendentes.length} tarefa(s) da manhã que ainda não foram marcadas como concluídas:
${listaPendentes}

Envie uma mensagem curta e natural (2-3 linhas) perguntando se conseguiu fazer alguma dessas tarefas — sem ser cobrador(a), sem listar formalmente, com leveza.
Diga que pode dar baixa ou remarcar.
Tom: ${prefs?.tom || 'carinhoso'}.`;

        const msg = await freeResponse('Mensagem de meio-dia.', [], {
          _contexto: '', name: user.name, tom: prefs?.tom || 'carinhoso', _systemOverride: systemMeioDia
        });
        if (!msg) continue;
        await sendMessage(user.phone, msg);
        await prisma.memory.create({ data: { userId: user.id, type: 'meio_dia_lock', content: lockMeioDia } });
        console.log(`[Meio-dia] Enviado para ${user.phone}`);
      } catch(e) { console.error('[Meio-dia]', e.message); }
    }
  } catch(e) { console.error('[Meio-dia] Erro:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// FECHAMENTO DO DIA (18:30)
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

        const prefs = await memory.getUserPreference(user.id).catch(() => null);
        const infoPessoal = await memory.buildPersonalContext(user.id).catch(() => '');

        // Identifica quais pendentes são urgentes (médico, reunião, etc) —
        // esses merecem menção mais específica ("como foi a consulta?"),
        // não só "fez essa tarefa?" como os demais.
        const idsUrgentes = new Set();
        if (pendentes.length > 0) {
          const marcacoes = await prisma.memory.findMany({
            where: { type: 'lembrete_urgente', content: { in: pendentes.map(r => r.id) } }
          }).catch(() => []);
          marcacoes.forEach(m => idsUrgentes.add(m.content));
        }

        const listaPendentes = pendentes.map(r => {
          const h = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
          const marca = idsUrgentes.has(r.id) ? ' [IMPORTANTE — pergunte como foi/resultado, não só se fez]' : '';
          return `• ${h} — ${r.message}${marca}`;
        }).join('\n');

        const systemFechamento = `Você é a Clara, assistente pessoal. ${user.name ? `O nome do usuário é ${user.name}.` : ''}
São 18:30h. Resumo do dia do usuário:
- Concluídos hoje: ${concluidos.length}
- Ainda pendentes (${pendentes.length}):
${listaPendentes || '(nenhum pendente)'}
${infoPessoal}

Envie uma mensagem natural (2-4 linhas) de fechamento do dia:
- Se tiver pendentes marcados como [IMPORTANTE], pergunte especificamente sobre o resultado deles (ex: "como foi a consulta com o médico?"), não apenas se fez
- Outros pendentes (sem marcação), mencione de forma leve — sem cobrar, perguntando se fez e oferecendo remarcar
- Se concluiu tudo, celebre
- Varie a abertura — não repita a mesma frase
- NÃO liste formalmente nem repita a marcação [IMPORTANTE] no texto — é só uma instrução interna
Tom: ${prefs?.tom || 'carinhoso'}.`;

        const msg = await freeResponse('Mensagem de fechamento do dia.', [], {
          _contexto: '', name: user.name, tom: prefs?.tom || 'carinhoso', _systemOverride: systemFechamento
        });
        if (!msg) { console.log(`[Fechamento] Rate limit, pulado para ${user.phone}`); continue; }
        await sendMessage(user.phone, msg);
        console.log(`[Fechamento] Enviado para ${user.phone}`);
      } catch (e) { console.error(`[Fechamento] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Fechamento] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// LEMBRETES (a cada minuto)
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
        const prefs = user ? await memory.getUserPreference(user.id).catch(() => null) : null;
        const nome = prefs?.name || user?.name || null;

        const isFollowup = grupo.reminders.length === 1 && grupo.reminders[0].message.startsWith('__followup__');
        if (isFollowup) {
          msg = grupo.reminders[0].message.replace('__followup__', '');
        } else if (grupo.reminders.length === 1) {
          const r = grupo.reminders[0];
          msg = `🔔 Lembrete\n\n${r.message}\n⏰ ${grupo.hora}\n\n${random(finais)}`;
        } else {
          // Múltiplos lembretes na mesma janela — numera cada um (1, 2...)
          // para que o usuário consiga confirmar/concluir um específico
          // sem ambiguidade (ex: "feito o 1", "concluído 2").
          const titulos = grupo.reminders.map((r, i) => `${i + 1}. ${r.message}`).join('\n');
          msg = `🔔 Você tem ${grupo.reminders.length} lembretes agora\n\n${titulos}\n\n⏰ ${grupo.hora}\n\n${random(finais)}`;
        }
      } catch(e) {
        msg = grupo.reminders.length === 1
          ? `🔔 Lembrete\n\n${grupo.reminders[0].message}\n⏰ ${grupo.hora}\n\n${random(finais)}`
          : `🔔 Você tem ${grupo.reminders.length} lembretes agora\n\n${grupo.reminders.map((r, i) => `${i + 1}. ${r.message}`).join('\n')}\n\n⏰ ${grupo.hora}\n\n${random(finais)}`;
      }

      await sendMessage(grupo.phone, msg);

      for (const r of grupo.reminders) {
        try {
          const isUrgente = await prisma.memory.findFirst({ where: { type: 'lembrete_urgente', content: r.id } });
          if (!isUrgente) continue;

          const user = await prisma.user.findFirst({ where: { phone: grupo.phone } });
          const prefs = user ? await memory.getUserPreference(user.id).catch(() => null) : null;

          const quinzeAntes = new Date(r.scheduledAt.getTime() - 15 * 60 * 1000);
          if (quinzeAntes > new Date()) {
            const jaTemAntes = await prisma.memory.findFirst({ where: { type: 'urgente_antes_lock', content: r.id } });
            if (!jaTemAntes) {
              await prisma.reminder.create({
                data: { userId: r.userId, phone: grupo.phone, message: `⚡ Em 15 minutos: ${r.message}`, scheduledAt: quinzeAntes }
              });
              await prisma.memory.create({ data: { userId: r.userId, type: 'urgente_antes_lock', content: r.id } });
            }
          }

          const quinzeDepois = new Date(r.scheduledAt.getTime() + 15 * 60 * 1000);
          const jaTemDepois = await prisma.memory.findFirst({ where: { type: 'urgente_followup_lock', content: r.id } });
          if (!jaTemDepois) {
            const systemFollowup = `Você é a Clara, parceira pessoal. Tom: ${tomDesc(prefs?.tom)}.
O usuário tinha um compromisso urgente: "${r.message}".
Já passou 15 minutos. Pergunte de forma natural e breve (1 linha) se conseguiu fazer.
Respeite o tom — sarcástica não pergunta com fofice.`;

            let msgFollowup = await freeResponse('Pergunta de follow-up.', [], {
              _systemOverride: systemFollowup, tom: prefs?.tom || 'carinhoso'
            }).catch(() => `E aí, conseguiu fazer "${r.message}"? 😊`);
            if (!msgFollowup) msgFollowup = `E aí, conseguiu fazer "${r.message}"? 😊`;

            await prisma.reminder.create({
              data: { userId: r.userId, phone: grupo.phone, message: `__followup__${msgFollowup}`, scheduledAt: quinzeDepois }
            });
            await prisma.memory.create({ data: { userId: r.userId, type: 'urgente_followup_lock', content: r.id } });
          }

          // ── Follow-up "como foi?" — 2h depois ──
          // O follow-up de 15min ("conseguiu fazer?") é prematuro para
          // compromissos como médico/reunião que ainda podem estar
          // acontecendo. 2h depois, pergunta de forma mais específica e
          // fechada como foi o resultado, fechando o ciclo do compromisso.
          const duasHorasDepois = new Date(r.scheduledAt.getTime() + 2 * 60 * 60 * 1000);
          const jaTemResultado = await prisma.memory.findFirst({ where: { type: 'urgente_resultado_lock', content: r.id } });
          if (!jaTemResultado) {
            const systemResultado = `Você é a Clara, parceira pessoal. Tom: ${tomDesc(prefs?.tom)}.
O usuário tinha um compromisso importante há 2 horas: "${r.message}".
Pergunte de forma natural e breve (1 linha) como foi / se deu tudo certo — não pergunte só "conseguiu fazer", pergunte sobre o RESULTADO (ex: "como foi a consulta?", "deu tudo certo na reunião?").
Respeite o tom — sarcástica não pergunta com fofice.`;

            let msgResultado = await freeResponse('Pergunta sobre resultado do compromisso.', [], {
              _systemOverride: systemResultado, tom: prefs?.tom || 'carinhoso'
            }).catch(() => `Oi! Como foi "${r.message}"? Deu tudo certo? 😊`);
            if (!msgResultado) msgResultado = `Oi! Como foi "${r.message}"? Deu tudo certo? 😊`;

            await prisma.reminder.create({
              data: { userId: r.userId, phone: grupo.phone, message: `__followup__${msgResultado}`, scheduledAt: duasHorasDepois }
            });
            await prisma.memory.create({ data: { userId: r.userId, type: 'urgente_resultado_lock', content: r.id } });
          }
        } catch(e) { console.error(`[Urgência] Erro ${r.id}:`, e.message); }
      }

      for (const r of grupo.reminders) {
        if (r.recorrente && r.frequencia) {
          try {
            const proxima = new Date(r.scheduledAt);
            if (r.frequencia === 'diario') proxima.setDate(proxima.getDate() + 1);
            else if (r.frequencia === 'semanal') proxima.setDate(proxima.getDate() + 7);
            else if (r.frequencia === 'mensal') proxima.setMonth(proxima.getMonth() + 1);

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

// MEDICAMENTOS (a cada minuto)
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

        const lockExistente = await prisma.memory.findFirst({
          where: { type: 'med_lock', content: lockKey },
          orderBy: { createdAt: 'desc' }
        });
        if (lockExistente) {
          const ageMs = Date.now() - new Date(lockExistente.createdAt).getTime();
          if (ageMs < 120000) continue;
          await prisma.memory.delete({ where: { id: lockExistente.id } }).catch(() => {});
          console.log(`[Med] Lock expirado removido: ${lockKey}`);
        }

        await prisma.memory.create({ data: { userId: med.userId, type: 'med_lock', content: lockKey } });
        const msg = `💊 Hora do medicamento!\n\n*${med.name}*\n⏰ ${minutoChave}\n\nNão esquece de tomar certinho 😊\n\n💜 Restam ${med.remaining - 1} doses.`;
        await sendMessage(phone, msg);
        await prisma.medication.update({ where: { id: med.id }, data: { remaining: { decrement: 1 } } });
        console.log(`[Med] ${med.name} → ${phone}`);
      } catch (e) { console.error(`[Med] Erro ${med.id}:`, e.message); }
    }
  } catch (e) { console.error('[Med] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// MENSAGENS AGENDADAS PARA CONTATOS (a cada minuto)
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

// FINALIZA LEMBRETES COM HORÁRIO PENDENTE (timeout) — a cada minuto
// Quando a Clara pergunta "que horas devo colocar?" (tipo: hora_lembrete em
// confirmacao_pendente) e o usuário não responde até expirar, cria o
// lembrete com horário provisório 09:00 e avisa que pode ser alterado.
cron.schedule('* * * * *', async () => {
  try {
    const pendentes = await prisma.memory.findMany({
      where: { type: 'confirmacao_pendente' }
    });
    for (const p of pendentes) {
      try {
        let dados;
        try { dados = JSON.parse(p.content); } catch { continue; }
        if (dados.tipo !== 'hora_lembrete') continue;
        if (Date.now() <= dados.expira) continue; // ainda não expirou

        const user = await prisma.user.findUnique({ where: { id: p.userId } }).catch(() => null);
        if (!user?.phone) { await prisma.memory.delete({ where: { id: p.id } }).catch(() => {}); continue; }

        const scheduledAt = new Date(`${dados.data}T09:00:00-03:00`);
        await prisma.reminder.create({ data: { userId: user.id, phone: user.phone, message: dados.titulo, scheduledAt } });
        await prisma.memory.delete({ where: { id: p.id } }).catch(() => {});

        const dataFmt = scheduledAt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
        await sendMessage(user.phone, `⏰ Não me respondeu o horário, então deixei "${dados.titulo}" pra ${dataFmt} às 09:00 (provisório). Pode me dizer o horário certo a qualquer momento que eu remarco 😊`);
        console.log(`[HoraLembrete] Finalizado com 09:00 provisório: "${dados.titulo}" → ${user.phone}`);
      } catch (e) { console.error(`[HoraLembrete] Erro pendente ${p.id}:`, e.message); }
    }
  } catch (e) { console.error('[HoraLembrete] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// LIMPEZA DE LOCKS ANTIGOS (03:00)
cron.schedule('0 3 * * *', async () => {
  try {
    const ontem = new Date(nowBRT()); ontem.setDate(ontem.getDate() - 2);
    await prisma.memory.deleteMany({
      where: {
        type: { in: ['med_lock', 'alerta_data_lock', 'proativa_lock', 'sumico_lock', 'bom_dia_lock', 'boa_noite_lock', 'meio_dia_lock', 'meu_dia_criado', 'urgente_resultado_lock'] },
        createdAt: { lt: ontem }
      }
    });
    console.log('[Cleanup] Locks antigos removidos');
  } catch (e) { console.error('[Cleanup] Erro:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// Limpeza de med_lock a cada hora
cron.schedule('0 * * * *', async () => {
  try {
    const doisMinutosAtras = new Date(Date.now() - 2 * 60 * 1000);
    const resultado = await prisma.memory.deleteMany({
      where: { type: 'med_lock', createdAt: { lt: doisMinutosAtras } }
    });
    if (resultado.count > 0) console.log(`[Cleanup Med Locks] ${resultado.count} locks removidos`);
  } catch (e) { console.error('[Cleanup Med Locks] Erro:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// LIMPEZA DE LEMBRETES NÃO CONFIRMADOS > 48h (04:00)
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

// ALERTA ESTOQUE BAIXO DE REMÉDIO (08:30)
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

// PARCEIRA — avisa 30min antes, mas APENAS se detectar urgência no lembrete
// (médico, reunião, voo, consulta, prazo, etc). Lembretes simples/rotineiros
// não precisam de aviso antecipado — evita excesso de mensagens.
cron.schedule('* * * * *', async () => {
  try {
    const now = nowBRT();
    const em30min = new Date(now.getTime() + 30 * 60 * 1000);
    const em31min = new Date(now.getTime() + 31 * 60 * 1000);

    const proximos = await prisma.reminder.findMany({
      where: {
        sent: false,
        confirmed: false,
        scheduledAt: { gte: em30min, lt: em31min }
      }
    });

    if (!proximos.length) return;

    // Palavras que indicam urgência/importância — só avisa 30min antes
    // quando o lembrete tem pelo menos uma dessas.
    const URGENCIA_RE = /medico|médico|médica|medica|consulta|dentista|cirurgia|exame|laboratorio|laboratório|farmacia|farmácia|vacina|hospital|clinica|clínica|psico|terapia|fisio|upa|reuniao|reunião|apresentacao|apresentação|entrevista|prova|concurso|voo|aeroporto|embarque|onibus|ônibus|trem|documento|cartorio|cartório|contrato|assinar|protocolar|prazo|vencimento|vence|renovar|passaporte|entrega|importante|urgente|cnh|rg/i;

    for (const r of proximos) {
      try {
        // Só envia se o lembrete for urgente/importante
        if (!URGENCIA_RE.test(r.message)) {
          console.log(`[Parceira] Pulado (sem urgência): "${r.message}"`);
          continue;
        }

        const lockKey = `parceira_${r.id}`;
        if (await prisma.memory.findFirst({ where: { type: 'parceira_lock', content: lockKey } })) continue;
        await prisma.memory.create({ data: { userId: r.userId, type: 'parceira_lock', content: lockKey } });

        const user = await prisma.user.findFirst({ where: { id: r.userId } });
        if (!user?.phone) continue;

        const prefs = await memory.getUserPreference(r.userId).catch(() => null);
        const nome = prefs?.name || user.name || null;
        const infoPessoal = await memory.buildPersonalContext(r.userId).catch(() => '');

        const hora = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', {
          timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit'
        });

        const systemParceira = `Você é a Clara, parceira pessoal do ${nome || 'usuário'} no WhatsApp.
Tom obrigatório: ${tomDesc(prefs?.tom)}

Daqui a 30 minutos ele(a) tem algo IMPORTANTE: "${r.message}" às ${hora}.
${infoPessoal ? `\nO que você sabe sobre ele(a):\n${infoPessoal}` : ''}

Envie UMA mensagem curta (1-2 linhas) como parceira presente:
- Mencione o compromisso de forma natural, respeitando seu tom
- Ofereça ajuda ESPECÍFICA para aquele contexto (ex: "precisa de alguma coisa antes de ir?")
- NÃO use "lembrete" ou "aviso" — seja natural
- NÃO agende nada novo
- Respeite rigorosamente o tom acima — não misture estilos
- NUNCA termine com "boa sorte", "boa tarde" ou saudação de período`;

        const msg = await freeResponse('Envie mensagem de parceira para o compromisso próximo.', [], {
          _contexto: '',
          name: nome,
          tom: prefs?.tom || 'carinhoso',
          _systemOverride: systemParceira
        });

        if (!msg || msg.length < 5) continue;

        await sendMessage(user.phone, msg);
        console.log(`[Parceira] ${user.phone} → "${r.message}" em 30min (urgente)`);
      } catch (e) { console.error(`[Parceira] Erro lembrete ${r.id}:`, e.message); }
    }
  } catch (e) { console.error('[Parceira] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

console.log('Clara scheduler iniciado 💜');
