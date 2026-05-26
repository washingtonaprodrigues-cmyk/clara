const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const { sendMessage, sendReminderWithButtons } = require('../services/whatsapp');

const prisma = new PrismaClient();

function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function random(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ====================== LEMBRETES ======================
cron.schedule('* * * * *', async () => {
  try {
    const now = nowBRT();

    const reminders = await prisma.reminder.findMany({
      where: {
        sent: false,
        confirmed: false,
        scheduledAt: { lte: now }
      },
    });

    console.log(`[Cron] ${now.toLocaleTimeString('pt-BR')} — ${reminders.length} lembrete(s) pendente(s)`);

    for (const r of reminders) {
      if (r.attempts === 0) {
        await sendReminderWithButtons(r.phone, r.message, r.id);
        await prisma.reminder.update({
          where: { id: r.id },
          data: {
            attempts: 1,
            scheduledAt: new Date(now.getTime() + 10 * 60000),
          },
        });
        console.log(`[Cron] Lembrete enviado: ${r.message} → ${r.phone}`);
      } else {
        await sendReminderWithButtons(r.phone, `Ainda sobre:\n${r.message}`, r.id);
        await prisma.reminder.update({
          where: { id: r.id },
          data: { sent: true, attempts: 2 },
        });
        console.log(`[Cron] Lembrete final enviado: ${r.message} → ${r.phone}`);
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

    const meds = await prisma.medication.findMany({
      where: { active: true, remaining: { gt: 0 } },
      include: { user: true },
    });

    for (const med of meds) {
      const horarios = JSON.parse(med.times || '[]');

      for (const h of horarios) {
        const [hh, mm] = h.split(':').map(Number);
        if (now.getHours() !== hh || now.getMinutes() !== mm) continue;

        const already = await prisma.reminder.findFirst({
          where: {
            userId: med.userId,
            message: { contains: med.name },
            createdAt: { gte: new Date(now.getTime() - 60000) },
          },
        });

        if (already) continue;

        const reminder = await prisma.reminder.create({
          data: {
            userId: med.userId,
            phone: med.user.phone,
            message: `Tomou o ${med.name}?`,
            scheduledAt: new Date(now.getTime() + 15 * 60000),
          },
        });

        await sendReminderWithButtons(
          med.user.phone,
          `💊 ${random([
            `Hora do ${med.name}`,
            `Lembrete do ${med.name}`,
            `Não esquece o ${med.name}`
          ])}`,
          reminder.id
        );

        await prisma.medication.update({
          where: { id: med.id },
          data: { remaining: { decrement: 1 } },
        });

        console.log(`[Cron] Med enviado: ${med.name} → ${med.user.phone}`);
      }
    }
  } catch (e) {
    console.error('Erro meds:', e.message);
  }
});

console.log('Reminders v4 iniciado');
