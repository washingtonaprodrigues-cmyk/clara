const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const { sendMessage, sendButtons } = require('../services/whatsapp');
const { sendReminderWithButtons } = require('../services/handler');

const prisma = new PrismaClient();

function random(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function isSameMinute(d1, d2) {
  return (
    d1.getHours() === d2.getHours() &&
    d1.getMinutes() === d2.getMinutes()
  );
}

// ====================== REMINDERS ======================
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();

    const reminders = await prisma.reminder.findMany({
      where: {
        sent: false,
        confirmed: false,
        scheduledAt: { lte: now }
      },
    });

    for (const r of reminders) {
      if (r.attempts === 0) {
        await sendReminderWithButtons(r.phone, r.message, r.id);

        await prisma.reminder.update({
          where: { id: r.id },
          data: {
            attempts: 1,
            scheduledAt: new Date(Date.now() + 10 * 60000),
          },
        });

      } else {
        await sendReminderWithButtons(
          r.phone,
          `Ainda sobre:\n${r.message}`,
          r.id
        );

        await prisma.reminder.update({
          where: { id: r.id },
          data: {
            sent: true,
            attempts: 2,
          },
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
    const now = new Date();

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
            createdAt: { gte: new Date(Date.now() - 60000) },
          },
        });

        if (already) continue;

        const reminder = await prisma.reminder.create({
          data: {
            userId: med.userId,
            phone: med.user.phone,
            message: `Tomou o ${med.name}?`,
            scheduledAt: new Date(Date.now() + 15 * 60000),
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
      }
    }
  } catch (e) {
    console.error('Erro meds:', e.message);
  }
});

console.log('Reminders v4 iniciado');
