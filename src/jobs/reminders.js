// Clara reminders v4.0
const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const { sendMessage } = require('../services/whatsapp');

const prisma = new PrismaClient();

function random(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function isSameMinute(d1, d2) {
  return d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate() &&
    d1.getHours() === d2.getHours() &&
    d1.getMinutes() === d2.getMinutes();
}

const MENU_CAPACIDADES = `Estou aqui pra te ajudar com o que precisar. Algumas coisas que faço por você:

📅 *Compromissos e tarefas* — te lembro antes da hora, com o que precisa levar
💊 *Remédios* — horários e controle de estoque
🩺 *Saúde* — pressão, glicemia, humor — tudo registrado
😴 *Sono* — acompanho seu descanso
🏋️ *Treinos* — registro e histórico
🛒 *Lista de mercado* — salvo e sugiro repetir quando precisar
💸 *Gastos do mês* — controle simples e sem julgamento
🎂 *Datas especiais* — aniversários e eventos com lembrete antecipado
📝 *Anotações e ideias* — guardo pra você buscar quando quiser
🎯 *Metas pessoais* — registro e acompanho com você
🔐 *Segredos* — informações guardadas com discrição

Me conta, como posso te ajudar?`;

// ============================================
// LEMBRETES PONTUAIS - a cada minuto
// ============================================
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const reminders = await prisma.reminder.findMany({
      where: { sent: false, confirmed: false, scheduledAt: { lte: now } },
      include: { user: true },
    });

    for (const reminder of reminders) {
      try {
        if (reminder.attempts === 0) {
          const msgs = [
            `So passando pra te lembrar:\n${reminder.message}\n\nDepois me fala se deu tudo certo.`,
            `Lembrete rapido:\n${reminder.message}\n\nMe avisa quando resolver!`,
            `${reminder.message}\n\nConseguiu fazer isso?`,
          ];
          await sendMessage(reminder.phone, random(msgs));
          await prisma.reminder.update({
            where: { id: reminder.id },
            data: { attempts: 1, scheduledAt: new Date(Date.now() + 10 * 60000) },
          });
        } else if (reminder.attempts === 1) {
          const msgs2 = [
            `Nao quero insistir nao, mas ainda nao me avisou sobre:\n${reminder.message}\n\nSe ja resolveu pode me falar!`,
            `Oi! So reforcando esse aqui:\n${reminder.message}\n\nSe quiser remarcar e so me chamar.`,
          ];
          await sendMessage(reminder.phone, random(msgs2));
          await prisma.reminder.update({
            where: { id: reminder.id },
            data: { attempts: 2, sent: true },
          });
        }
      } catch (e) {
        console.error('Erro reminder individual:', e.message);
      }
    }
  } catch (error) {
    console.error('Erro job lembretes:', error.message);
  }
});

// ============================================
// REMEDIOS - a cada minuto
// ============================================
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const medications = await prisma.medication.findMany({
      where: { active: true, remaining: { gt: 0 } },
      include: { user: true },
    });

    for (const med of medications) {
      try {
        const horarios = JSON.parse(med.times || '[]');
        for (const horario of horarios) {
          const [h, m] = horario.split(':').map(Number);
          const medTime = new Date();
          medTime.setHours(h, m, 0, 0);
          if (!isSameMinute(now, medTime)) continue;

          const alreadySent = await prisma.reminder.findFirst({
            where: {
              userId: med.userId,
              message: { contains: med.name },
              createdAt: { gte: new Date(Date.now() - 60000) },
            },
          });
          if (alreadySent) continue;

          const msgs = [
            `Hora do ${med.name}! Tomou ja?`,
            `Passando pra lembrar do ${med.name}. Me confirma quando tomar!`,
            `Lembrete do ${med.name}. Conseguiu tomar?`,
          ];
          await sendMessage(med.user.phone, random(msgs));

          if (med.remaining === 10) {
            await sendMessage(med.user.phone, `So um aviso: seu ${med.name} esta chegando em 10 comprimidos. Ja pensa em renovar!`);
          }
          if (med.remaining <= 3) {
            await sendMessage(med.user.phone, `Atencao: o ${med.name} esta quase acabando (${med.remaining} restantes). Precisa providenciar mais!`);
          }

          await prisma.medication.update({
            where: { id: med.id },
            data: { remaining: { decrement: 1 } },
          });

          await prisma.reminder.create({
            data: {
              userId: med.user.id,
              phone: med.user.phone,
              message: `Conseguiu tomar o ${med.name}?`,
              scheduledAt: new Date(Date.now() + 15 * 60000),
              attempts: 0,
            },
          });
        }
      } catch (e) {
        console.error('Erro medicamento individual:', e.message);
      }
    }
  } catch (error) {
    console.error('Erro job remedios:', error.message);
  }
});

// ============================================
// TAREFAS - a cada 20 minutos
// CORRIGIDO: removido completed e notified (campos excluidos do schema)
// ============================================
cron.schedule('*/20 * * * *', async () => {
  try {
    const now = new Date();
    const tasks = await prisma.task.findMany({
      where: { done: false },
      include: { user: true },
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

        // Evita mandar lembrete mais de uma vez: verifica se ja mandou nas ultimas 12h
        const jaLembrou = await prisma.reminder.findFirst({
          where: {
            userId: task.userId,
            message: { contains: task.title },
            createdAt: { gte: new Date(Date.now() - 12 * 60 * 60 * 1000) },
          },
        });
        if (jaLembrou) continue;

        let msg = null;

        if (hours >= 0 && hours <= 1) {
          msg = `Em cerca de 1 hora voce tem:\n${task.title}`;
          if (task.items) msg += `\n\nNao esquece de levar:\n${task.items}`;
        } else if (days === 0 && hours > 1) {
          msg = `Lembrando que hoje voce tem:\n${task.title}`;
          if (task.dueTime) msg += ` as ${task.dueTime}`;
          if (task.items) msg += `\n\nLevar: ${task.items}`;
        } else if (days === 1) {
          msg = `Amanha voce tem:\n${task.title}`;
          if (task.dueTime) msg += ` as ${task.dueTime}`;
          if (task.items) msg += `\n\nJa foi separando: ${task.items}`;
        }

        if (msg) {
          await sendMessage(task.user.phone, msg);
          // Marca que lembrou criando um registro de reminder
          await prisma.reminder.create({
            data: {
              userId: task.userId,
              phone: task.user.phone,
              message: `Lembrete tarefa: ${task.title}`,
              scheduledAt: new Date(),
              sent: true,
              confirmed: true,
              attempts: 2,
            },
          });
        }
      } catch (e) {
        console.error('Erro task individual:', e.message);
      }
    }
  } catch (error) {
    console.error('Erro job tarefas:', error.message);
  }
});

// ============================================
// EVENTOS ESPECIAIS - todo dia as 9h
// CORRIGIDO: removido followedUp (campo excluido do schema)
// ============================================
cron.schedule('0 9 * * *', async () => {
  try {
    const now = new Date();
    const in7days = new Date(); in7days.setDate(in7days.getDate() + 7);

    const events = await prisma.event.findMany({
      where: { notified: false, date: { lte: in7days } },
      include: { user: true },
    });

    for (const event of events) {
      try {
        const daysUntil = Math.ceil((event.date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        let msg = null;

        if (daysUntil <= 1) {
          msg = `Amanha e ${event.title}`;
          if (event.personName) msg += ` de ${event.personName}`;
          if (event.personAge) msg += ` (${event.personAge} anos)`;
          msg += `! Ja tem tudo preparado?`;
        } else if (daysUntil <= 3) {
          msg = `Daqui ${daysUntil} dias e ${event.title}`;
          if (event.personName) msg += ` de ${event.personName}`;
          msg += `. Ja pensou no presente?`;
        } else if (daysUntil <= 7) {
          msg = `Semana que vem tem ${event.title}`;
          if (event.personName) msg += ` de ${event.personName}`;
          if (event.personAge) msg += ` (vai fazer ${event.personAge} anos)`;
          msg += `! Ja foi pensando?`;
        }

        if (msg) {
          await sendMessage(event.user.phone, msg);
          await prisma.event.update({ where: { id: event.id }, data: { notified: true } });
        }
      } catch (e) {
        console.error('Erro evento individual:', e.message);
      }
    }
  } catch (error) {
    console.error('Erro job eventos:', error.message);
  }
});

// ============================================
// FOLLOWUP POS EVENTO - no dia seguinte as 10h
// CORRIGIDO: nao usa mais followedUp — usa notified como substituto
// ============================================
cron.schedule('0 10 * * *', async () => {
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);

    const events = await prisma.event.findMany({
      where: { notified: true, date: { gte: yesterday, lt: today } },
      include: { user: true },
    });

    for (const event of events) {
      try {
        let msg = `E ai, como foi`;
        if (event.title.toLowerCase().includes('aniversario') && event.personName) {
          msg += ` a festa de aniversario de ${event.personName}?`;
        } else {
          msg += ` o ${event.title}?`;
        }
        await sendMessage(event.user.phone, msg);
      } catch (e) {
        console.error('Erro followup evento:', e.message);
      }
    }
  } catch (error) {
    console.error('Erro job followup eventos:', error.message);
  }
});

// ============================================
// LISTA DE MERCADO - toda segunda as 10h
// ============================================
cron.schedule('0 10 * * 1', async () => {
  try {
    const users = await prisma.user.findMany();
    for (const user of users) {
      try {
        const lastList = await prisma.groceryList.findFirst({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' },
        });
        if (!lastList) continue;
        const daysSince = Math.floor((Date.now() - lastList.createdAt.getTime()) / (1000 * 60 * 60 * 24));
        if (daysSince >= 7) {
          await sendMessage(user.phone, `Faz ${daysSince} dias desde a ultima lista de mercado. Quer que eu mande a lista anterior pra voce repetir?`);
        }
      } catch (e) {}
    }
  } catch (error) {
    console.error('Erro job mercado:', error.message);
  }
});

// ============================================
// BOM DIA - todo dia as 8h
// A cada 7 dias inclui o menu completo de capacidades
// ============================================
cron.schedule('0 8 * * *', async () => {
  try {
    const users = await prisma.user.findMany();
    for (const user of users) {
      try {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);

        const todayTasks = await prisma.task.findMany({
          where: { userId: user.id, done: false, dueDate: { gte: today, lt: tomorrow } },
        });
        const meds = await prisma.medication.findMany({
          where: { userId: user.id, active: true, remaining: { gt: 0 } },
        });

        const nome = user.name ? `, ${user.name}` : '';
        let msg = `Bom dia${nome}! Como voce esta hoje?\n`;

        if (todayTasks.length > 0) {
          msg += `\nHoje voce tem:\n`;
          todayTasks.forEach(t => {
            msg += `- ${t.title}${t.dueTime ? ` as ${t.dueTime}` : ''}`;
            if (t.items) msg += ` (levar: ${t.items})`;
            msg += '\n';
          });
        }

        if (meds.length > 0) {
          msg += `\nRemedios de hoje:\n`;
          meds.forEach(m => {
            const times = JSON.parse(m.times || '[]');
            msg += `- ${m.name} - ${times.join(', ')} (${m.remaining} restantes)\n`;
          });
        }

        // Verifica se deve incluir menu de capacidades (a cada 7 dias)
        const deveEnviarMenu = await verificarMenuSemanal(user.id);
        if (deveEnviarMenu) {
          msg += `\n${MENU_CAPACIDADES}`;
          await marcarMenuEnviado(user.id);
        } else {
          msg += `\nEstou aqui pra te ajudar no que precisar!`;
        }

        await sendMessage(user.phone, msg.trim());
      } catch (e) {
        console.error('Erro bom dia usuario:', e.message);
      }
    }
  } catch (error) {
    console.error('Erro job bom dia:', error.message);
  }
});

// ============================================
// MENU APOS 48H SEM INTERACAO - a cada hora
// Quando usuario mandar qualquer mensagem, o handler verifica isso
// Aqui apenas marcamos o timestamp do ultimo contato via job
// ============================================
// A logica de 48h fica no handler.js — veja handleMessage

// ============================================
// HELPERS MENU SEMANAL
// Usa a tabela Memory pra guardar quando mandou o menu pela ultima vez
// ============================================
async function verificarMenuSemanal(userId) {
  try {
    const ultimo = await prisma.memory.findFirst({
      where: { userId, type: 'menu_enviado' },
      orderBy: { createdAt: 'desc' },
    });
    if (!ultimo) return true; // nunca mandou
    const diasPassados = Math.floor((Date.now() - ultimo.createdAt.getTime()) / (1000 * 60 * 60 * 24));
    return diasPassados >= 7;
  } catch (e) {
    return false;
  }
}

async function marcarMenuEnviado(userId) {
  try {
    await prisma.memory.create({
      data: { userId, type: 'menu_enviado', content: 'menu de capacidades enviado' },
    });
  } catch (e) {}
}

console.log('Clara reminders v4 iniciado');
