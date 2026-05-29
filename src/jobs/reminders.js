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

        // Marca ANTES de enviar para evitar duplicata
        await prisma.memory.create({
          data: { userId: user.id, type: 'bom_dia_enviado', content: hoje }
        });

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

        // Marca ANTES de enviar
        await prisma.memory.create({
          data: { userId: user.id, type: 'boa_noite_enviado', content: hoje }
        });

        const nome = user.name ? `, ${user.name}` : '';
        await sendMessage(user.phone,
          `Boa noite${nome} 💜\n\nComo foi seu dia?\n\nSe quiser, posso te lembrar de algo amanhã 😊`
        );
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
      take: 10, // limite de segurança
    });

    console.log(`[Cron] ${now.toLocaleTimeString('pt-BR')} — ${reminders.length} lembrete(s)`);

    for (const r of reminders) {
      // Marca como sent ANTES de enviar — evita loop se envio falhar
      await prisma.reminder.update({
        where: { id: r.id },
        data: r.attempts === 0
          ? { attempts: 1, scheduledAt: new Date(now.getTime() + 10 * 60000) }
          : { sent: true, attempts: 2 }
      });

      const frasesPrimeira = [
        `Ei, não esquece: ${r.message} 😊`,
        `Oi! Só passando pra lembrar: ${r.message}`,
        `Psiu! ${r.message} — era isso 😊`,
        `Lembrete: ${r.message} 👋`,
      ];

      const frasesSegunda = [
        `Ainda sobre "${r.message}" — já conseguiu? 😊`,
        `Oi! ${r.message} — tudo certo? 😉`,
        `Só conferindo: ${r.message} — feito? 😊`,
      ];

      const msg = r.attempts === 0
        ? random(frasesPrimeira)
        : random(frasesSegunda);

      await sendMessage(r.phone, msg).catch(e =>
        console.error(`Erro enviar reminder ${r.id}:`, e.message)
      );
    }
  } catch (e) {
    console.error('Erro reminder:', e.message);
  }
});

// ====================== MEDICAMENTOS ======================
cron.schedule('* * * * *', async () => {
  try {
    const now = nowBRT();
    const hoje = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const minutoChave = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

    const meds = await prisma.medication.findMany({
      where: { active: true, remaining: { gt: 0 } },
      include: { user: true },
    });

    for (const med of meds) {
      const horarios = JSON.parse(med.times || '[]');
      if (!horarios.includes(minutoChave)) continue;

      const lockKey = `med_${med.id}_${hoje}_${minutoChave}`;

      // Lock no banco — cria antes de enviar
      try {
        await prisma.memory.create({
          data: { userId: med.userId, type: 'med_lock', content: lockKey }
        });
      } catch {
        // Se já existe (unique constraint) ou qualquer erro → pula
        continue;
      }

      const frasesMed = [
        `Ei, hora do ${med.name}! 💊`,
        `Não esquece o ${med.name} 💊`,
        `${med.name} — tá na hora! 😊`,
        `Psiu, ${med.name}! Pode tomar 💊`,
      ];

      await sendMessage(med.user.phone, random(frasesMed)).catch(e =>
        console.error(`Erro enviar med ${med.name}:`, e.message)
      );

      await prisma.medication.update({
        where: { id: med.id },
        data: { remaining: { decrement: 1 } },
      });

      console.log(`[Cron] Med: ${med.name} → ${med.user.phone}`);
    }
  } catch (e) {
    console.error('Erro meds:', e.message);
  }
});

console.log('Reminders v5 iniciado');
