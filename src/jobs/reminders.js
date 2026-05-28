const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const { sendMessage } = require('../services/whatsapp');

const prisma = new PrismaClient();

// Lock em memória para evitar duplo disparo no mesmo minuto
const medLocks = new Set();

function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function random(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
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

        const inicioHoje = new Date(`${hoje}T00:00:00-03:00`);
        const fimHoje = new Date(`${hoje}T23:59:59-03:00`);

        const lembretes = await prisma.reminder.findMany({
          where: {
            userId: user.id, sent: false, confirmed: false,
            scheduledAt: { gte: inicioHoje, lte: fimHoje }
          },
          orderBy: { scheduledAt: 'asc' },
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

        await prisma.memory.create({
          data: { userId: user.id, type: 'bom_dia_enviado', content: hoje }
        });
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

        const nome = user.name ? `, ${user.name}` : '';
        await sendMessage(user.phone,
          `Boa noite${nome} 💜\n\nComo foi seu dia?\n\nSe quiser, posso te lembrar de algo amanhã 😊`
        );

        await prisma.memory.create({
          data: { userId: user.id, type: 'boa_noite_enviado', content: hoje }
        });
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
  try {
    const now = nowBRT();

    const reminders = await prisma.reminder.findMany({
      where: { sent: false, confirmed: false, scheduledAt: { lte: now } },
    });

    console.log(`[Cron] ${now.toLocaleTimeString('pt-BR')} — ${reminders.length} lembrete(s)`);

    for (const r of reminders) {
      const frasesPrimeira = [
        `Ei, não esquece: ${r.message} 😊`,
        `Oi! Só passando pra lembrar: ${r.message}`,
        `Psiu! ${r.message} — era isso 😊`,
        `Lembrete rápido: ${r.message} 👋`,
      ];

      const frasesSegunda = [
        `Ainda sobre "${r.message}" — já conseguiu? 😊`,
        `Oi! Não esqueceu de ${r.message}, né?`,
        `Só conferindo: ${r.message} — tudo certo? 😉`,
      ];

      if (r.attempts === 0) {
        await sendMessage(r.phone, random(frasesPrimeira));
        await prisma.reminder.update({
          where: { id: r.id },
          data: { attempts: 1, scheduledAt: new Date(now.getTime() + 10 * 60000) },
        });
      } else {
        await sendMessage(r.phone, random(frasesSegunda));
        await prisma.reminder.update({
          where: { id: r.id },
          data: { sent: true, attempts: 2 },
        });
      }
    }
  } catch (e) {
    console.error('Erro reminder:', e.message);
  }
});

// ====================== MEDICAMENTOS ======================
cron.schedule('* * * * *', async () => {
  try {
    const now = nowBRT();
    const minutoAtual = `${now.getHours()}:${now.getMinutes()}`;

    const meds = await prisma.medication.findMany({
      where: { active: true, remaining: { gt: 0 } },
      include: { user: true },
    });

    for (const med of meds) {
      const horarios = JSON.parse(med.times || '[]');

      for (const h of horarios) {
        const [hh, mm] = h.split(':').map(Number);
        if (now.getHours() !== hh || now.getMinutes() !== mm) continue;

        // Lock em memória — evita duplo disparo no mesmo minuto
        const lockKey = `${med.id}-${minutoAtual}`;
        if (medLocks.has(lockKey)) continue;
        medLocks.add(lockKey);
        setTimeout(() => medLocks.delete(lockKey), 90000); // limpa após 90s

        // Verificação dupla no banco
        const already = await prisma.reminder.findFirst({
          where: {
            userId: med.userId,
            message: med.name,
            createdAt: { gte: new Date(now.getTime() - 90000) },
          },
        });
        if (already) continue;

        await prisma.reminder.create({
          data: {
            userId: med.userId,
            phone: med.user.phone,
            message: med.name,
            scheduledAt: new Date(now.getTime() + 15 * 60000),
            attempts: 1,
            sent: true, // marca como enviado direto — não re-dispara pelo cron de lembretes
          },
        });

        const frasesMed = [
          `Ei, hora do ${med.name}! 💊`,
          `Não esquece o ${med.name} 💊`,
          `${med.name} — tá na hora! 😊`,
          `Psiu, ${med.name}! Pode tomar 💊`,
        ];
        await sendMessage(med.user.phone, random(frasesMed));

        await prisma.medication.update({
          where: { id: med.id },
          data: { remaining: { decrement: 1 } },
        });

        console.log(`[Cron] Med: ${med.name} → ${med.user.phone}`);
      }
    }
  } catch (e) {
    console.error('Erro meds:', e.message);
  }
});

console.log('Reminders v5 iniciado');
