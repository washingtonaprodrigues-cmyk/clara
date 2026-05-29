const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const { sendMessage } = require('../services/whatsapp');
const { processMessage, MODEL_LIGHT } = require('../services/groq');

const prisma = new PrismaClient();

// Flag global para evitar execuções simultâneas do cron de lembretes
let reminderCronRunning = false;
let medCronRunning = false;

function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ====================== BOM DIA ======================
cron.schedule('0 7 * * *', async () => {
  try {
    const now = nowBRT();
    const hoje = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const diasSemana = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
    const meses = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
    const dataFormatada = `${diasSemana[now.getDay()]}, ${now.getDate()} de ${meses[now.getMonth()]}`;

    const users = await prisma.user.findMany({ where: { blocked: false } });

    for (const user of users) {
      try {
        const jaEnviou = await prisma.memory.findFirst({
          where: {
            userId: user.id,
            type: 'bom_dia_enviado',
            createdAt: { gte: new Date(`${hoje}T00:00:00-03:00`) }
          }
        });
        if (jaEnviou) continue;

        // Cria o lock ANTES de montar a mensagem para evitar duplicatas
        await prisma.memory.create({
          data: { userId: user.id, type: 'bom_dia_enviado', content: hoje }
        });

        const inicioHoje = new Date(`${hoje}T00:00:00-03:00`);
        const fimHoje = new Date(`${hoje}T23:59:59-03:00`);

        // Busca lembretes sem duplicatas (distinct por message + scheduledAt)
        const lembretes = await prisma.reminder.findMany({
          where: {
            userId: user.id, sent: false, confirmed: false,
            scheduledAt: { gte: inicioHoje, lte: fimHoje }
          },
          orderBy: { scheduledAt: 'asc' },
          distinct: ['message'],
          take: 5,
        });

        const nome = user.name ? `, ${user.name}` : '';
        let msg = `Bom dia${nome} 💜\n\n☀️ ${dataFormatada}`;

        if (lembretes.length > 0) {
          msg += `\n\n📌 Você tem ${lembretes.length} lembrete${lembretes.length > 1 ? 's' : ''} hoje:`;
          lembretes.forEach(r => {
            const hora = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', {
              timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit'
            });
            msg += `\n• ${r.message} às ${hora}`;
          });
        }

        msg += `\n\nBom trabalho hoje 😊`;
        await sendMessage(user.phone, msg);

      } catch (e) {
        console.error(`Erro bom dia ${user.phone}:`, e.message);
      }
    }
  } catch (e) {
    console.error('Erro cron bom dia:', e.message);
  }
}, { timezone: 'America/Sao_Paulo' });

// ====================== BOA NOITE ======================
cron.schedule('0 21 * * *', async () => {
  try {
    const now = nowBRT();
    const hoje = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

    const users = await prisma.user.findMany({ where: { blocked: false } });

    for (const user of users) {
      try {
        const jaEnviou = await prisma.memory.findFirst({
          where: {
            userId: user.id,
            type: 'boa_noite_enviado',
            createdAt: { gte: new Date(`${hoje}T00:00:00-03:00`) }
          }
        });
        if (jaEnviou) continue;

        // Lock ANTES de enviar
        await prisma.memory.create({
          data: { userId: user.id, type: 'boa_noite_enviado', content: hoje }
        });

        const nome = user.name ? `, ${user.name}` : '';
        await sendMessage(user.phone,
          `Boa noite${nome} 💜\n\nComo foi seu dia?\n\nSe quiser, posso te lembrar de algo amanhã 😊`
        );
      } catch (e) {
        console.error(`Erro boa noite ${user.phone}:`, e.message);
      }
    }
  } catch (e) {
    console.error('Erro cron boa noite:', e.message);
  }
}, { timezone: 'America/Sao_Paulo' });

// ====================== LEMBRETES ======================
cron.schedule('* * * * *', async () => {
  // Evita execuções simultâneas — se ainda tá rodando, pula essa rodada
  if (reminderCronRunning) {
    console.log('[Cron] Lembretes ainda processando, pulando rodada');
    return;
  }

  reminderCronRunning = true;

  try {
    const now = nowBRT();

    const reminders = await prisma.reminder.findMany({
      where: { sent: false, confirmed: false, scheduledAt: { lte: now } },
      include: { user: true },
      orderBy: { scheduledAt: 'asc' },
    });

    console.log(`[Cron] ${now.toLocaleTimeString('pt-BR')} — ${reminders.length} lembrete(s)`);

    for (const r of reminders) {
      try {
        // Já tentou 2 vezes → desiste
        if (r.attempts >= 2) {
          await prisma.reminder.update({
            where: { id: r.id },
            data: { sent: true }
          });
          console.log(`[Cron] Reminder ${r.id} abandonado após 2 tentativas`);
          continue;
        }

        // LOCK: evita duplicatas se processMessage demorar
        const lockKey = `reminder_lock_${r.id}_attempt_${r.attempts}`;
        const jaDisparou = await prisma.memory.findFirst({
          where: { userId: r.user.id, type: 'reminder_lock', content: lockKey }
        });
        if (jaDisparou) continue;

        // Cria lock ANTES de chamar a IA
        await prisma.memory.create({
          data: { userId: r.user.id, type: 'reminder_lock', content: lockKey }
        });

        const prompt = r.attempts === 0
          ? `Você precisa lembrar o usuário sobre: "${r.message}". Mande uma mensagem curta e natural, como se fosse um lembrete de uma amiga. Máximo 1 linha.`
          : `Você já lembrou o usuário sobre "${r.message}" e ele ainda não confirmou. Mande uma segunda mensagem curta e gentil perguntando se já conseguiu. Máximo 1 linha.`;

        let msgLimpa;
        try {
          const msgIA = await processMessage(prompt, [], { nome: r.user?.name || null }, MODEL_LIGHT);
          msgLimpa = msgIA.replace(/<action>[\s\S]*?<\/action>/gi, '').replace(/<action>[\s\S]*/gi, '').trim();

          // Se a IA retornou mensagem de erro, não avança o attempt — tenta na próxima rodada
          if (msgLimpa.includes('Tive um probleminha') || msgLimpa.length < 3) {
            console.warn(`[Cron] IA retornou erro para reminder ${r.id}, tentando na próxima rodada`);
            // Remove o lock para poder tentar de novo
            await prisma.memory.deleteMany({
              where: { userId: r.user.id, type: 'reminder_lock', content: lockKey }
            });
            continue;
          }
        } catch (iaErr) {
          console.error(`[Cron] Erro IA reminder ${r.id}:`, iaErr.message);
          // Remove lock para tentar de novo
          await prisma.memory.deleteMany({
            where: { userId: r.user.id, type: 'reminder_lock', content: lockKey }
          });
          continue;
        }

        await sendMessage(r.user.phone, msgLimpa);

        if (r.attempts === 0) {
          await prisma.reminder.update({
            where: { id: r.id },
            data: { attempts: 1, scheduledAt: new Date(now.getTime() + 15 * 60000) },
          });
        } else {
          await prisma.reminder.update({
            where: { id: r.id },
            data: { sent: true, attempts: 2 },
          });
        }

        // Delay entre reminders para não bater rate limit da Groq
        await sleep(1500);

      } catch (e) {
        console.error(`Erro enviar reminder ${r.id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('Erro reminder:', e.message);
  } finally {
    reminderCronRunning = false;
  }
});

// ====================== MEDICAMENTOS ======================
cron.schedule('* * * * *', async () => {
  if (medCronRunning) {
    console.log('[Cron] Medicamentos ainda processando, pulando rodada');
    return;
  }

  medCronRunning = true;

  try {
    const now = nowBRT();
    const hoje = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const minutoChave = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

    const meds = await prisma.medication.findMany({
      where: { active: true, remaining: { gt: 0 } },
      include: { user: true },
    });

    for (const med of meds) {
      const horarios = JSON.parse(med.times || '[]');

      for (const h of horarios) {
        if (h !== minutoChave) continue;

        const lockKey = `med_lock_${med.id}_${hoje}_${minutoChave}`;
        const jaDisparou = await prisma.memory.findFirst({
          where: { userId: med.userId, type: 'med_lock', content: lockKey }
        });
        if (jaDisparou) continue;

        await prisma.memory.create({
          data: { userId: med.userId, type: 'med_lock', content: lockKey }
        });

        const jaConfirmou = await prisma.memory.findFirst({
          where: { userId: med.userId, type: 'med_confirmado_hoje', content: hoje }
        });
        if (jaConfirmou) {
          console.log(`[Cron] Med ${med.name} já confirmado hoje, pulando`);
          continue;
        }

        let msgLimpa;
        try {
          const prompt = `Você precisa lembrar o usuário de tomar o medicamento "${med.name}". Mande uma mensagem curta, natural e gentil. Máximo 1 linha.`;
          const msgIA = await processMessage(prompt, [], { nome: med.user?.name || null }, MODEL_LIGHT);
          msgLimpa = msgIA.replace(/<action>[\s\S]*?<\/action>/gi, '').replace(/<action>[\s\S]*/gi, '').trim();

          if (msgLimpa.includes('Tive um probleminha') || msgLimpa.length < 3) {
            console.warn(`[Cron] IA retornou erro para med ${med.id}, tentando na próxima rodada`);
            await prisma.memory.deleteMany({
              where: { userId: med.userId, type: 'med_lock', content: lockKey }
            });
            continue;
          }
        } catch (iaErr) {
          console.error(`[Cron] Erro IA med ${med.id}:`, iaErr.message);
          await prisma.memory.deleteMany({
            where: { userId: med.userId, type: 'med_lock', content: lockKey }
          });
          continue;
        }

        await sendMessage(med.user.phone, msgLimpa);

        await prisma.medication.update({
          where: { id: med.id },
          data: { remaining: { decrement: 1 } },
        });

        console.log(`[Cron] Med: ${med.name} → ${med.user.phone}`);

        await sleep(1500);
      }
    }
  } catch (e) {
    console.error('Erro meds:', e.message);
  } finally {
    medCronRunning = false;
  }
});

console.log('Reminders v8 iniciado');
