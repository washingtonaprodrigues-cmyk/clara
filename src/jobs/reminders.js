// Clara jobs v2.0
const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const { sendMessage } = require('../services/whatsapp');

const prisma = new PrismaClient();

// ============================================
// LEMBRETES PONTUAIS - verifica a cada minuto
// ============================================
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();

    const reminders = await prisma.reminder.findMany({
      where: { sent: false, confirmed: false, scheduledAt: { lte: now }, attempts: { lt: 2 } },
    });

    for (const reminder of reminders) {
      if (reminder.attempts === 0) {
        // 1a tentativa - horario exato
        await sendMessage(reminder.phone, reminder.message);
        await prisma.reminder.update({
          where: { id: reminder.id },
          data: { attempts: 1, scheduledAt: new Date(Date.now() + 10 * 60000) },
        });
        console.log(`Lembrete 1/2 enviado para ${reminder.phone}`);

      } else if (reminder.attempts === 1) {
        // 2a tentativa - 10 minutos depois, carinhosa e sem pressao
        const msg = `Oi, tudo bem por ai? Nao precisa se preocupar nao, se ja fez e so me avisar que eu marco como feito! Se quiser remarcar esse lembrete, e so me chamar. Estou aqui quando precisar!`;
        await sendMessage(reminder.phone, msg);
        await prisma.reminder.update({
          where: { id: reminder.id },
          data: { attempts: 2, sent: true },
        });
        console.log(`Lembrete 2/2 enviado para ${reminder.phone}`);
      }
    }
  } catch (error) {
    console.error('Erro job lembretes:', error.message);
  }
});

// ============================================
// REMEDIOS - verifica a cada 5 minutos
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

          // Aviso de estoque baixo
          if (med.remaining <= 3) {
            await sendMessage(med.user.phone, `Atencao! Seu ${med.name} esta quase acabando, so restam ${med.remaining} comprimidos. Ja pensou em comprar mais antes que acabe?`);
          } else if (med.remaining === 10) {
            await sendMessage(med.user.phone, `So um aviso rapido: seu ${med.name} esta com apenas 10 comprimidos. Ja vai pensando em renovar a receita!`);
          }

          // Lembrete de tomar
          const msg = `Hora do seu ${med.name}! Tomou? Me confirma aqui quando tomar!`;
          await sendMessage(med.user.phone, msg);

          // Desconta estoque
          await prisma.medication.update({
            where: { id: med.id },
            data: { remaining: { decrement: 1 } },
          });

          // Cria reminder de reenvio em 10 minutos se nao confirmar
          await prisma.reminder.create({
            data: {
              userId: med.user.id,
              phone: med.user.phone,
              message: msg,
              scheduledAt: new Date(Date.now() + 10 * 60000),
              attempts: 1,
            },
          });

          console.log(`Remedio ${med.name} lembrado para ${med.user.phone}. Restam ${med.remaining - 1}`);
        }
      }
    }
  } catch (error) {
    console.error('Erro job remedios:', error.message);
  }
});

// ============================================
// TAREFAS - verifica a cada 30 minutos
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
        msg = `Em 1 hora voce tem: ${task.title}`;
        if (task.dueTime) msg += ` as ${task.dueTime}`;
        if (task.items) msg += `. Nao esquece de levar: ${task.items}!`;
      } else if (daysUntil === 0) {
        msg = `Hoje voce tem: ${task.title}`;
        if (task.dueTime) msg += ` as ${task.dueTime}`;
        if (task.items) msg += `. Ja separou: ${task.items}?`;
      } else if (daysUntil === 1) {
        msg = `Amanha voce tem: ${task.title}`;
        if (task.dueTime) msg += ` as ${task.dueTime}`;
        if (task.items) msg += `. Ja foi separando: ${task.items}?`;
      } else if (daysUntil === 3) {
        msg = `Daqui 3 dias: ${task.title}`;
        if (task.items) msg += `. Vai precisar levar: ${task.items}.`;
      }

      if (msg) {
        await sendMessage(task.user.phone, msg);
        await prisma.task.update({ where: { id: task.id }, data: { notified: true } });
        console.log(`Tarefa lembrada para ${task.user.phone}: ${task.title}`);
      }
    }
  } catch (error) {
    console.error('Erro job tarefas:', error.message);
  }
});

// ============================================
// BOM DIA - todo dia as 8h
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
        where: { userId: user.id, completed: false, dueDate: { gte: today, lt: tomorrow } },
      });

      const meds = await prisma.medication.findMany({
        where: { userId: user.id, active: true, remaining: { gt: 0 } },
      });

      const nome = user.name ? `, ${user.name}` : '';
      let msg = `Bom dia${nome}! Como voce esta hoje?\n`;

      if (todayTasks.length > 0) {
        msg += `\nHoje voce tem:\n`;
        todayTasks.forEach((t) => {
          msg += `- ${t.title}${t.dueTime ? ` as ${t.dueTime}` : ''}`;
          if (t.items) msg += ` (levar: ${t.items})`;
          msg += '\n';
        });
      }

      if (meds.length > 0) {
        msg += `\nRemedios de hoje:\n`;
        meds.forEach((m) => {
          const times = JSON.parse(m.times || '[]');
          msg += `- ${m.name} - ${times.join(', ')} (${m.remaining} comprimidos restantes)\n`;
        });
      }

      msg += `\nEstou aqui pra te ajudar no que precisar!`;
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

console.log('Clara - jobs de lembretes iniciados');
