// Clara memory v4.1

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function parseDateSafely(date) {
  if (!date) return null;

  const d = new Date(date);

  if (isNaN(d.getTime())) {
    return null;
  }

  return d;
}

// ====================== USER ======================

async function getOrCreateUser(phone) {
  let user = await prisma.user.findUnique({
    where: { phone }
  });

  if (!user) {
    user = await prisma.user.create({
      data: { phone }
    });

    console.log(`👤 Nova usuária: ${phone}`);
  }

  return user;
}

// ====================== JORNADA ======================

async function saveJornada(userId, minutos) {
  return prisma.user.update({
    where: { id: userId },
    data: {
      jornadaMinutos: minutos
    }
  });
}

async function getJornada(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      jornadaMinutos: true
    }
  });

  return user?.jornadaMinutos || 480;
}

// ====================== PREFERÊNCIAS ======================

async function saveUserPreference(userId, name, tom) {
  const data = {};

  if (name) {
    data.name = name;
  }

  if (tom) {
    data.metadata = JSON.stringify({ tom });
  }

  return prisma.user.update({
    where: { id: userId },
    data
  });
}

async function getUserPreference(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId }
  });

  if (!user) {
    return {
      name: null,
      tom: 'carinhoso'
    };
  }

  let tom = 'carinhoso';

  if (user.metadata) {
    try {
      tom = JSON.parse(user.metadata).tom || 'carinhoso';
    } catch {}
  }

  return {
    name: user.name,
    tom
