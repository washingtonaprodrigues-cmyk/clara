```js
const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const { sendMessage } = require('../services/whatsapp');

const prisma = new PrismaClient();

function nowBRT() {
  return new Date(
    new Date().toLocaleString('en-US', {
      timeZone: 'America/Sao_Paulo'
    })
  );
}

function random(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const finais = [
  '💜 Estou por aqui.',
  '😊 Me avisa quando concluir.',
  '✨ Tudo certo por aí?',
  '💜 Pode deixar comigo.',
];

// ====================== BOM DIA ======================
cron.schedule('0 7 * * *', async () => {
  try {
    const now = nowBRT();

    const hoje = `${now.getFullYear()}-${String(
      now.getMonth() + 1
    ).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const diasSemana = [
      'Domingo',
      'Segunda',
      'Terça',
      'Quarta',
      'Quinta',
      'Sexta',
      'Sábado'
    ];

    const meses = [
      'janeiro',
      'fevereiro',
      'março',
      'abril',
      'maio',
      'junho',
      'julho',
      'agosto',
      'setembro',
      'outubro',
      'novembro',
      'dezembro'
    ];

    const dataFormatada = `${diasSemana[now.getDay()]}, ${now.getDate()} de ${meses[now.getMonth()]}`;

    const users = await prisma.user.findMany({
      where: { blocked: false }
    });

    for (const user of users) {
      try {
        const jaEnviou = await prisma.memory.findFirst({
          where: {
            userId: user.id,
            type: 'bom_dia_enviado',
            content: hoje
          }
        });

        if (jaEnviou) continue;

        await prisma.memory.create({
          data: {
            userId: user.id,
            type: 'bom_dia_enviado',
            content: hoje
          }
        });

        const inicioHoje = new Date(`${hoje}T00:00:00-03:00`);
        const fimHoje = new Date(`${hoje}T23:59:59-03:00`);

        const lembretes = await prisma.reminder.findMany({
          where: {
            userId: user.id,
            confirmed: false,
            scheduledAt: {
              gte: inicioHoje,
              lte: fimHoje
            }
          },
          orderBy: {
            scheduledAt: 'asc'
          },
          take: 5
        });

        const nome = user.name ? `, ${user.name}` : '';

        let msg = `✨ Bom dia${nome}!\n\n`;
        msg += `Hoje você tem ${lembretes.length} lembrete${lembretes.length !== 1 ? 's' : ''} programado${lembretes.length !== 1 ? 's' : ''} 📋\n`;

        if (lembretes.length > 0) {
          msg += `Vou te avisando ao longo do dia pra você não esquecer de nada 😊\n\n`;

          msg += `⏰ Próximos compromissos:\n`;

          lembretes.forEach(r => {
            const hora = new Date(r.scheduledAt).toLocaleTimeString(
              'pt-BR',
              {
                timeZone: 'America/Sao_Paulo',
                hour: '2-digit',
                minute: '2-digit'
              }
            );

            msg += `• ${hora} — ${r.message}\n`;
          });
        }

        msg += `\n💜 Qualquer coisa, só me chamar.`;

        await sendMessage(user.phone, msg);
      } catch (e) {
        console.error(`Erro bom dia ${user.phone}:`, e.message);
      }
    }
  } catch (e) {
    console.error('Erro cron bom dia:', e.message);
  }
}, {
  timezone: 'America/Sao_Paulo'
});

// ====================== LEMBRETES ======================
cron.schedule('* * * * *', async () => {
  try {
    const now = nowBRT();

    const reminders = await prisma.reminder.findMany({
      where: {
        sent: false,
        confirmed: false,
        scheduledAt: {
          lte: now
        }
      },
      orderBy: {
        scheduledAt: 'asc'
      }
    });

    if (!reminders.length) return;

    // AGRUPA POR TELEFONE + HORÁRIO
    const grupos = {};

    for (const r of reminders) {
      const hora = new Date(r.scheduledAt).toLocaleTimeString(
        'pt-BR',
        {
          timeZone: 'America/Sao_Paulo',
          hour: '2-digit',
          minute: '2-digit'
        }
      );

      const key = `${r.phone}_${hora}`;

      if (!grupos[key]) {
        grupos[key] = {
          phone: r.phone,
          hora,
          reminders: []
        };
      }

      grupos[key].reminders.push(r);
    }

    for (const key of Object.keys(grupos)) {
      const grupo = grupos[key];

      let msg = '';

      // UM LEMBRETE
      if (grupo.reminders.length === 1) {
        const r = grupo.reminders[0];

        msg =
`🔔 Lembrete

${r.message}
⏰ ${grupo.hora}

${random(finais)}`;
      }

      // VÁRIOS LEMBRETES
      else {
        msg =
`📌 Você tem ${grupo.reminders.length} lembretes agora

`;

        grupo.reminders.forEach(r => {
          msg += `• ${r.message}\n`;
        });

        msg += `\n⏰ Horário: ${grupo.hora}\n\n`;
        msg += random(finais);
      }

      await sendMessage(grupo.phone, msg);

      // MARCA COMO ENVIADO
      await prisma.reminder.updateMany({
        where: {
          id: {
            in: grupo.reminders.map(r => r.id)
          }
        },
        data: {
          sent: true
        }
      });

      console.log(
        `[Reminder] ${grupo.phone} → ${grupo.reminders.length} lembrete(s)`
      );
    }
  } catch (e) {
    console.error('Erro reminder:', e.message);
  }
}, {
  timezone: 'America/Sao_Paulo'
});

// ====================== MEDICAMENTOS ======================
cron.schedule('* * * * *', async () => {
  try {
    const now = nowBRT();

    const minutoChave = `${String(now.getHours()).padStart(2, '0')}:${String(
      now.getMinutes()
    ).padStart(2, '0')}`;

    const meds = await prisma.medication.findMany({
      where: {
        active: true,
        remaining: { gt: 0 }
      },
      include: {
        user: true
      }
    });

    for (const med of meds) {
      const horarios = JSON.parse(med.times || '[]');

      if (!horarios.includes(minutoChave)) continue;

      const lockKey = `med_${med.id}_${minutoChave}`;

      const jaExiste = await prisma.memory.findFirst({
        where: {
          type: 'med_lock',
          content: lockKey
        }
      });

      if (jaExiste) continue;

      await prisma.memory.create({
        data: {
          userId: med.userId,
          type: 'med_lock',
          content: lockKey
        }
      });

      const msg =
`💊 Hora do medicamento

${med.name}
⏰ ${minutoChave}

Não esquece de tomar certinho 😊`;

      await sendMessage(med.user.phone, msg);

      await prisma.medication.update({
        where: {
          id: med.id
        },
        data: {
          remaining: {
            decrement: 1
          }
        }
      });

      console.log(`[Med] ${med.name} → ${med.user.phone}`);
    }
  } catch (e) {
    console.error('Erro meds:', e.message);
  }
}, {
  timezone: 'America/Sao_Paulo'
});

console.log('Clara reminders premium iniciado 💜');
```
