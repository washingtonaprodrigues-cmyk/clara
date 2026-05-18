// Clara reminders v3.0 - humana, inteligente e contextual
const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const { sendMessage } = require('../services/whatsapp');

const prisma = new PrismaClient();

function random(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function isSameMinute(date1, date2) {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate() &&
    date1.getHours() === date2.getHours() &&
    date1.getMinutes() === date2.getMinutes()
  );
}

// ============================================
// LEMBRETES
// ============================================

cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();

    const reminders = await prisma.reminder.findMany({
      where: {
        sent: false,
        confirmed: false,
        scheduledAt: {
          lte: now,
        },
      },
      include: {
        user: true,
      },
    });

    for (const reminder of reminders) {
      try {

        // PRIMEIRO ENVIO
        if (reminder.attempts === 0) {

          const mensagens = [
            `Oi 😌 passando pra te lembrar: ${reminder.message}`,
            `Meu bem, só pra não deixar passar 💜\n${reminder.message}`,
            `Lembrete rapidinho ✨\n${reminder.message}`,
            `Clara passando aqui pra te lembrar 😄\n${reminder.message}`,
          ];

          await sendMessage(reminder.phone, random(mensagens));

          await prisma.reminder.update({
            where: { id: reminder.id },
            data: {
              attempts: 1,
              scheduledAt: new Date(Date.now() + 10 * 60000),
            },
          });

          console.log(`Reminder enviado: ${reminder.phone}`);
        }

        // SEGUNDO ENVIO
        else if (reminder.attempts === 1) {

          const mensagens2 = [
            `Tudo certinho por aí? 😅\nSe já resolveu isso pode só me avisar.`,
            `Não quero te pressionar tá? 💜\nSó passando novamente caso tenha esquecido.`,
            `Oi 😌 só reforçando esse lembrete rapidinho.`,
            `Se quiser remarcar ou ajustar esse lembrete eu consigo também ✨`,
          ];

          await sendMessage(reminder.phone, random(mensagens2));

          await prisma.reminder.update({
            where: { id: reminder.id },
            data: {
              attempts: 2,
              sent: true,
            },
          });

          console.log(`Reminder reforçado: ${reminder.phone}`);
        }

      } catch (e) {
        console.error('Erro reminder individual:', e.message);
      }
    }

  } catch (error) {
    console.error('Erro reminders:', error.message);
  }
});

// ============================================
// REMÉDIOS
// ============================================

cron.schedule('* * * * *', async () => {
  try {

    const now = new Date();

    const medications = await prisma.medication.findMany({
      where: {
        active: true,
        remaining: {
          gt: 0,
        },
      },
      include: {
        user: true,
      },
    });

    for (const med of medications) {

      try {

        const horarios = JSON.parse(med.times || '[]');

        for (const horario of horarios) {

          const [h, m] = horario.split(':').map(Number);

          const medTime = new Date();
          medTime.setHours(h, m, 0, 0);

          if (!isSameMinute(now, medTime)) continue;

          // evita duplicar no mesmo minuto
          const alreadySent = await prisma.reminder.findFirst({
            where: {
              userId: med.userId,
              message: {
                contains: med.name,
              },
              createdAt: {
                gte: new Date(Date.now() - 60000),
              },
            },
          });

          if (alreadySent) continue;

          const mensagens = [
            `Hora do seu ${med.name} 💊`,
            `Passando pra lembrar do ${med.name} 😌`,
            `Meu bem, não esquece do ${med.name} 💜`,
            `Lembrete do remédio ✨\n${med.name}`,
          ];

          await sendMessage(med.user.phone, random(mensagens));

          // estoque baixo
          if (med.remaining === 10) {
            await sendMessage(
              med.user.phone,
              `Só um aviso 😅 seu ${med.name} já está chegando nos 10 comprimidos restantes.`
            );
          }

          if (med.remaining <= 3) {
            await sendMessage(
              med.user.phone,
              `Atenção 💜 o ${med.name} está quase acabando (${med.remaining} restantes).`
            );
          }

          // decrementa
          await prisma.medication.update({
            where: { id: med.id },
            data: {
              remaining: {
                decrement: 1,
              },
            },
          });

          // cria reminder de confirmação
          await prisma.reminder.create({
            data: {
              userId: med.user.id,
              phone: med.user.phone,
              message: `Você conseguiu tomar o ${med.name}?`,
              scheduledAt: new Date(Date.now() + 15 * 60000),
              attempts: 0,
            },
          });

          console.log(`Medicamento enviado: ${med.name}`);
        }

      } catch (e) {
        console.error('Erro medicamento individual:', e.message);
      }
    }

  } catch (error) {
    console.error('Erro medicamentos:', error.message);
  }
});

// ============================================
// TAREFAS
// ============================================

cron.schedule('*/20 * * * *', async () => {

  try {

    const now = new Date();

    const tasks = await prisma.task.findMany({
      where: {
        completed: false,
      },
      include: {
        user: true,
      },
    });

    for (const task of tasks) {

      try {

        if (!task.dueDate) continue;

        const due = new Date(task.dueDate);

        if (task.dueTime) {
          const [h, m] = task.dueTime.split(':').map(Number);
          due.setHours(h, m, 0, 0);
        } else {
          due.setHours(12, 0, 0, 0);
        }

        const diff = due.getTime() - now.getTime();

        const hours = Math.floor(diff / (1000 * 60 * 60));
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));

        let msg = null;

        if (hours >= 0 && hours <= 1 && !task.notified) {

          msg = `Ei 😄 em cerca de 1 hora você tem:\n${task.title}`;

          if (task.items) {
            msg += `\n\nTalvez seja bom já separar:\n${task.items}`;
          }

          await prisma.task.update({
            where: { id: task.id },
            data: {
              notified: true,
            },
          });

        } else if (days === 0 && hours > 1 && !task.notified) {

          msg = `Passando pra te lembrar da programação de hoje ✨\n\n${task.title}`;

          if (task.dueTime) {
            msg += ` às ${task.dueTime}`;
          }

          if (task.items) {
            msg += `\n\nLevar:\n${task.items}`;
          }

          await prisma.task.update({
            where: { id: task.id },
            data: {
              notified: true,
            },
          });

        }

        if (msg) {
          await sendMessage(task.user.phone, msg);
        }

      } catch (e) {
        console.error('Erro task individual:', e.message);
      }
    }

  } catch (error) {
    console.error('Erro tarefas:', error.message);
  }
});

console.log('Clara reminders v3 iniciado');
