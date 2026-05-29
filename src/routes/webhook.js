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
  'Estou por aqui.',
  'Me avisa quando concluir.',
  'Tudo certo por ai?',
  'Pode deixar comigo.'
];

// ====================== BOM DIA ======================
cron.schedule('0 7 * * *', async function () {
  try {
    const now = nowBRT();

    const ano = now.getFullYear();
    const mes = String(now.getMonth() + 1).padStart(2, '0');
    const dia = String(now.getDate()).padStart(2, '0');

    const hoje = ano + '-' + mes + '-' + dia;

    const users = await prisma.user.findMany({
      where: {
        blocked: false
      }
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

        if (jaEnviou) {
          continue;
        }

        await prisma.memory.create({
          data: {
            userId: user.id,
            type: 'bom_dia_enviado',
            content: hoje
          }
        });

        const inicioHoje = new Date(hoje + 'T00:00:00-03:00');
        const fimHoje = new Date(hoje + 'T23:59:59-03:00');

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

        const nome = user.name ? ', ' + user.name : '';

        let msg = 'Bom dia' + nome + '.\n\n';

        if (lembretes.length > 0) {
          msg += 'Voce tem ';
          msg += lembretes.length;
          msg += lembretes.length > 1 ? ' lembretes' : ' lembrete';
          msg += ' programados hoje.\n\n';

          for (const r of lembretes) {
            const hora = new Date(r.scheduledAt)
              .toLocaleTimeString('pt-BR', {
                timeZone: 'America/Sao_Paulo',
                hour: '2-digit',
                minute: '2-digit'
              });

            msg += '- ' + hora + ' | ' + r.message + '\n';
          }
        } else {
          msg += 'Hoje parece estar mais tranquilo.';
        }

        msg += '\n\nQualquer coisa, so me chamar.';

        await sendMessage(user.phone, msg);

      } catch (e) {
        console.error('Erro bom dia:', e.message);
      }
    }

  } catch (e) {
    console.error('Erro cron bom dia:', e.message);
  }

}, {
  timezone: 'America/Sao_Paulo'
});

// ====================== LEMBRETES ======================
cron.schedule('* * * * *', async function () {

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

    if (!reminders.length) {
      return;
    }

    const grupos = {};

    for (const r of reminders) {

      const hora = new Date(r.scheduledAt)
        .toLocaleTimeString('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          hour: '2-digit',
          minute: '2-digit'
        });

      const key = r.phone + '_' + hora;

      if (!grupos[key]) {
        grupos[key] = {
          phone: r.phone,
          hora: hora,
          reminders: []
        };
      }

      grupos[key].reminders.push(r);
    }

    const keys = Object.keys(grupos);

    for (const key of keys) {

      const grupo = grupos[key];

      let msg = '';

      // UM LEMBRETE
      if (grupo.reminders.length === 1) {

        const r = grupo.reminders[0];

        msg =
          'Lembrete\n\n' +
          r.message +
          '\nHorario: ' +
          grupo.hora +
          '\n\n' +
          random(finais);

      } else {

        // VARIOS LEMBRETES
        msg =
          'Voce tem ' +
          grupo.reminders.length +
          ' lembretes agora\n\n';

        for (const r of grupo.reminders) {
          msg += '- ' + r.message + '\n';
        }

        msg += '\nHorario: ' + grupo.hora;
        msg += '\n\n' + random(finais);
      }

      await sendMessage(grupo.phone, msg);

      await prisma.reminder.updateMany({
        where: {
          id: {
            in: grupo.reminders.map(function (r) {
              return r.id;
            })
          }
        },
        data: {
          sent: true
        }
      });

      console.log(
        '[Reminder]',
        grupo.phone,
        grupo.reminders.length
      );
    }

  } catch (e) {
    console.error('Erro reminder:', e.message);
  }

}, {
  timezone: 'America/Sao_Paulo'
});

// ====================== MEDICAMENTOS ======================
cron.schedule('* * * * *', async function () {

  try {
    const now = nowBRT();

    const hora = String(now.getHours()).padStart(2, '0');
    const minuto = String(now.getMinutes()).padStart(2, '0');

    const minutoChave = hora + ':' + minuto;

    const meds = await prisma.medication.findMany({
      where: {
        active: true,
        remaining: {
          gt: 0
        }
      },
      include: {
        user: true
      }
    });

    for (const med of meds) {

      const horarios = JSON.parse(med.times || '[]');

      if (!horarios.includes(minutoChave)) {
        continue;
      }

      const lockKey =
        'med_' +
        med.id +
        '_' +
        minutoChave;

      const jaExiste = await prisma.memory.findFirst({
        where: {
          type: 'med_lock',
          content: lockKey
        }
      });

      if (jaExiste) {
        continue;
      }

      await prisma.memory.create({
        data: {
          userId: med.userId,
          type: 'med_lock',
          content: lockKey
        }
      });

      const msg =
        'Hora do medicamento\n\n' +
        med.name +
        '\nHorario: ' +
        minutoChave +
        '\n\nNao esquece de tomar certinho.';

      await sendMessage(
        med.user.phone,
        msg
      );

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

      console.log(
        '[Med]',
        med.name,
        med.user.phone
      );
    }

  } catch (e) {
    console.error('Erro meds:', e.message);
  }

}, {
  timezone: 'America/Sao_Paulo'
});

console.log('Clara reminders iniciado');
