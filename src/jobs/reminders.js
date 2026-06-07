const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const { sendMessage } = require('../services/whatsapp');

const prisma = new PrismaClient();

function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
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
    const hoje = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const diasSemana = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
    const meses = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];

    const users = await prisma.user.findMany({ where: { blocked: false } });

    for (const user of users) {
      try {
        const jaEnviou = await prisma.memory.findFirst({
          where: { userId: user.id, type: 'bom_dia_enviado', content: hoje }
        });
        if (jaEnviou) continue;

        await prisma.memory.create({
          data: { userId: user.id, type: 'bom_dia_enviado', content: hoje }
        });

        const inicioHoje = new Date(`${hoje}T00:00:00-03:00`);
        const fimHoje = new Date(`${hoje}T23:59:59-03:00`);

        const lembretes = await prisma.reminder.findMany({
          where: { userId: user.id, confirmed: false, scheduledAt: { gte: inicioHoje, lte: fimHoje } },
          orderBy: { scheduledAt: 'asc' },
          take: 5
        });

        const nome = user.name ? `, ${user.name}` : '';
        let msg = `✨ Bom dia${nome}!\n\n`;

        if (lembretes.length > 0) {
          msg += `Hoje você tem ${lembretes.length} lembrete${lembretes.length !== 1 ? 's' : ''} programado${lembretes.length !== 1 ? 's' : ''} 📋\n`;
          msg += `Vou te avisando ao longo do dia 😊\n\n⏰ Próximos compromissos:\n`;
          lembretes.forEach(r => {
            const hora = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', {
              timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit'
            });
            msg += `• ${hora} — ${r.message}\n`;
          });
        } else {
          msg += `Hoje parece estar mais tranquilo. 😌\n`;
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
}, { timezone: 'America/Sao_Paulo' });

// ====================== LEMBRETES ======================
cron.schedule('* * * * *', async () => {
  try {
    const now = nowBRT();

    const reminders = await prisma.reminder.findMany({
      where: { sent: false, confirmed: false, scheduledAt: { lte: now } },
      orderBy: { scheduledAt: 'asc' }
    });

    if (!reminders.length) return;

    const grupos = {};
    for (const r of reminders) {
      const hora = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', {
        timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit'
      });
      const key = `${r.phone}_${hora}`;
      if (!grupos[key]) grupos[key] = { phone: r.phone, hora, reminders: [] };
      grupos[key].reminders.push(r);
    }

    for (const key of Object.keys(grupos)) {
      const grupo = grupos[key];
      let msg = '';

      if (grupo.reminders.length === 1) {
        const r = grupo.reminders[0];
        msg = `🔔 Lembrete\n\n${r.message}\n⏰ ${grupo.hora}\n\n${random(finais)}`;
      } else {
        msg = `📌 Você tem ${grupo.reminders.length} lembretes agora\n\n`;
        grupo.reminders.forEach(r => { msg += `• ${r.message}\n`; });
        msg += `\n⏰ Horário: ${grupo.hora}\n\n${random(finais)}`;
      }

      await sendMessage(grupo.phone, msg);

      await prisma.reminder.updateMany({
        where: { id: { in: grupo.reminders.map(r => r.id) } },
        data: { sent: true }
      });

      console.log(`[Reminder] ${grupo.phone} → ${grupo.reminders.length} lembrete(s)`);
    }
  } catch (e) {
    console.error('Erro reminder:', e.message);
  }
}, { timezone: 'America/Sao_Paulo' });

// ====================== MEDICAMENTOS ======================
cron.schedule('* * * * *', async () => {
  try {
    const now = nowBRT();
    const minutoChave = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

    // Busca medicamentos ativos com dados do usuário
    const meds = await prisma.medication.findMany({
      where: { active: true, remaining: { gt: 0 } },
      include: { user: true }
    });

    for (const med of meds) {
      try {
        // Verifica se há horário correspondente
        let horarios = [];
        try { horarios = JSON.parse(med.times || '[]'); } catch {}

        if (!horarios.includes(minutoChave)) continue;

        // Garante que temos o telefone do usuário
        const userPhone = med.user?.phone;
        if (!userPhone) {
          // Fallback: busca usuário diretamente
          const user = await prisma.user.findUnique({ where: { id: med.userId } });
          if (!user?.phone) {
            console.error(`[Med] Usuário sem phone para medicamento ${med.id}`);
            continue;
          }
        }

        const phone = med.user?.phone || (await prisma.user.findUnique({ where: { id: med.userId } }))?.phone;
        if (!phone) continue;

        // Lock para evitar duplicatas
        const lockKey = `med_${med.id}_${minutoChave}`;
        const jaExiste = await prisma.memory.findFirst({
          where: { type: 'med_lock', content: lockKey }
        });
        if (jaExiste) continue;

        await prisma.memory.create({
          data: { userId: med.userId, type: 'med_lock', content: lockKey }
        });

        const msg = `💊 Hora do medicamento!\n\n*${med.name}*\n⏰ ${minutoChave}\n\nNão esquece de tomar certinho 😊\n\n💜 Restam ${med.remaining - 1} doses.`;

        await sendMessage(phone, msg);

        await prisma.medication.update({
          where: { id: med.id },
          data: { remaining: { decrement: 1 } }
        });

        console.log(`[Med] ${med.name} → ${phone}`);
      } catch (e) {
        console.error(`[Med] Erro no medicamento ${med.id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('Erro meds:', e.message);
  }
}, { timezone: 'America/Sao_Paulo' });

// ====================== LIMPEZA LOCKS ANTIGOS ======================
// Roda todo dia às 3h para limpar locks de medicamentos do dia anterior
cron.schedule('0 3 * * *', async () => {
  try {
    const ontem = new Date(nowBRT());
    ontem.setDate(ontem.getDate() - 1);
    await prisma.memory.deleteMany({
      where: { type: 'med_lock', createdAt: { lt: ontem } }
    });
    console.log('[Cleanup] Locks de medicamentos antigos removidos');
  } catch (e) {
    console.error('Erro cleanup locks:', e.message);
  }
}, { timezone: 'America/Sao_Paulo' });

console.log('Clara reminders iniciado 💜');
