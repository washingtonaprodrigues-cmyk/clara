const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const { sendMessage } = require('../services/whatsapp');

const prisma = new PrismaClient();

// ============================================
// REMÉDIOS — verifica a cada 5 minutos
// ============================================
cron.schedule('*/5 * * * *', async () => {
  try {
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const medications = await prisma.medication.findMany({
      where: { active: true, remaining: { gt: 0 } },
      include: { user: true },
    });

    for (const med of medications) {
      const times = JSON.parse(med.times || '[]');
      for (const time of times) {
        if (isWithinMinutes(currentTime, time, 5)) {
          let msg = `💊 *Hora do ${med.name}!*\n`;
          msg += `Restam *${med.remaining} comprimidos*`;
          if (med.remaining <= 3) msg += `\n\n⚠️ Estoque baixo, meu bem! Já está acabando.`;
          msg += `\n\nJá tomou? Me confirma aqui! 💛`;

          await sendMessage(med.user.phone, msg);
          await prisma.medication.update({
            where: { id: med.id },
            data: { remaining: { decrement: 1 } },
          });

          // Cria lembrete de reenvio se não confirmar
          await prisma.reminder.create({
            data: {
              userId: med.user.id,
              phone: med.user.phone,
              message: `💊 Ei, você tomou o *${med.name}*? Me confirma aqui! 💛`,
              scheduledAt: new Date(Date.now() + 60000), // 1 minuto
            },
          });

          console.log(`💊 Lembrete remédio enviado para ${med.user.phone}: ${med.name}`);
        }
      }
    }
  } catch (error) {
    console.error('Erro job remédios:', error.message);
  }
});

// ============================================
// REENVIO DE LEMBRETES — a cada 1 minuto, até 15 tentativas
// ============================================
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();

    const reminders = await prisma.reminder.findMany({
      where: {
        sent: false,
        confirmed: false,
        scheduledAt: { lte: now },
        attempts: { lt: 15 },
      },
    });

    for (const reminder of reminders) {
      await sendMessage(reminder.phone, reminder.message);

      const nextAttempt = reminder.attempts + 1;

      if (nextAttempt >= 15) {
        // Última tentativa — desiste
        await prisma.reminder.update({
          where: { id: reminder.id },
          data: { sent: true, attempts: nextAttempt },
        });
        await sendMessage(
          reminder.phone,
          `Tudo bem, meu bem! Não precisa me responder agora. Estou por aqui quando precisar. 💛`
        );
      } else {
        // Agenda próximo reenvio em 1 minuto
        await prisma.reminder.update({
          where: { id: reminder.id },
          data: {
            attempts: nextAttempt,
            scheduledAt: new Date(Date.now() + 60000),
          },
        });
      }

      console.log(`🔔 Reenvio ${nextAttempt}/15 para ${reminder.phone}`);
    }
  } catch (error) {
    console.error('Erro job reenvio:', error.message);
  }
});

// ============================================
// TAREFAS E COMPROMISSOS — a cada 30 minutos
// ============================================
cron.schedule('*/30 * * * *', async () => {
  try {
    const now = new Date();

    const tasks = await prisma.task.findMany({
      where: { completed: false, notified: false, dueDate: { not: null } },
      include: { user: true },
    });

    for (const task of tasks) {
      const due = new Date(task.dueDate);
      const daysUntil = Math.ceil((due - now) / (1000 * 60 * 60 * 24));
      const hoursUntil = Math.ceil((due - now) / (1000 * 60 * 60));

      let msg = null;

      if (hoursUntil <= 1 && hoursUntil > 0) {
        msg = `⏰ Em 1 hora: *${task.title}*`;
        if (task.dueTime) msg += ` às ${task.dueTime}`;
        if (task.items) msg += `\n\nNão esqueça de levar: ${task.items} 💛`;
      } else if (daysUntil === 0) {
        msg = `📅 Hoje você tem: *${task.title}*`;
        if (task.dueTime) msg += ` às ${task.dueTime}`;
        if (task.items) msg += `\n\nLembra de levar: ${task.items} 💛`;
      } else if (daysUntil === 1) {
        msg = `📅 Amanhã você tem: *${task.title}*`;
        if (task.dueTime) msg += ` às ${task.dueTime}`;
        if (task.items) msg += `\n\nJá separou: ${task.items}? 💛`;
      } else if (daysUntil === 3) {
        msg = `📅 Em 3 dias: *${task.title}*`;
        if (task.items) msg += `\n\nVai precisar levar: ${task.items} 💛`;
      }

      if (msg) {
        await sendMessage(task.user.phone, msg);
        await prisma.task.update({
          where: { id: task.id },
          data: { notified: true },
        });
        console.log(`📅 Lembrete tarefa enviado para ${task.user.phone}: ${task.title}`);
      }
    }
  } catch (error) {
    console.error('Erro job tarefas:', error.message);
  }
});

// ============================================
// COMPRAS RECORRENTES — todo dia às 10h
// ============================================
cron.schedule('0 10 * * *', async () => {
  try {
    const purchases = await prisma.purchase.findMany({
      where: { notified: false, avgFrequency: { not: null } },
      include: { user: true },
    });

    for (const purchase of purchases) {
      const daysSinceLast = Math.floor(
        (Date.now() - purchase.lastBought.getTime()) / (1000 * 60 * 60 * 24)
      );
      const threshold = Math.floor(purchase.avgFrequency * 0.9);

      if (daysSinceLast >= threshold) {
        const msg = `🛒 Faz ${daysSinceLast} dias que você comprou *${purchase.item}*. Já precisa repor, meu bem? 💛`;
        await sendMessage(purchase.user.phone, msg);
        await prisma.purchase.update({
          where: { id: purchase.id },
          data: { notified: true },
        });
      }
    }
  } catch (error) {
    console.error('Erro job compras:', error.message);
  }
});

// ============================================
// BOM DIA — todo dia às 8h
// ============================================
cron.schedule('0 8 * * *', async () => {
  try {
    const users = await prisma.user.findMany();

    for (const user of users) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const todayTasks = await prisma.task.findMany({
        where: {
          userId: user.id,
          completed: false,
          dueDate: { gte: today, lt: tomorrow },
        },
      });

      const meds = await prisma.medication.findMany({
        where: { userId: user.id, active: true, remaining: { gt: 0 } },
      });

      let msg = `☀️ Bom dia! Como você está hoje?\n`;

      if (todayTasks.length > 0) {
        msg += `\n📅 *Hoje você tem:*\n`;
        todayTasks.forEach((t) => {
          msg += `• ${t.title}${t.dueTime ? ` às ${t.dueTime}` : ''}`;
          if (t.items) msg += ` — levar: ${t.items}`;
          msg += '\n';
        });
      }

      if (meds.length > 0) {
        msg += `\n💊 *Remédios de hoje:*\n`;
        meds.forEach((m) => {
          const times = JSON.parse(m.times || '[]');
          msg += `• ${m.name} — ${times.join(', ')}\n`;
        });
      }

      msg += `\nEstou aqui pra te ajudar no que precisar! 💛`;

      await sendMessage(user.phone, msg.trim());
    }
  } catch (error) {
    console.error('Erro job bom dia:', error.message);
  }
});

function isWithinMinutes(time1, time2, minutes) {
  const [h1, m1] = time1.split(':').map(Number);
  const [h2, m2] = time2.split(':').map(Number);
  const diff = Math.abs(h1 * 60 + m1 - (h2 * 60 + m2));
  return diff <= minutes;
}

console.log('⏰ Clara — jobs de lembretes iniciados 💛');
