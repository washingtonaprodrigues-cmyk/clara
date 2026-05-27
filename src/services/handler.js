const {
  classify,
  searchWeb,
  freeResponse,
  generateMemorySummary
} = require('./groq');

const {
  sendMessage,
  sendButtons
} = require('./whatsapp');

const memory = require('./memory');

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const BASE_URL =
  'https://clara-production-8128.up.railway.app';

// ====================== MENU ======================

const MENU_TEXT = `📋 Menu da Clara

🔔 Lembretes
💊 Remédios
⏰ Registro de ponto
💰 Gastos
📅 Agenda
📊 Resumo do dia
💬 Conversar

Você pode simplesmente me pedir naturalmente 😊`;

// ====================== PRIMEIRA MENSAGEM ======================

const PRIMEIRA_MENSAGEM = `✨ Clara online 💜

Oi! Como posso te ajudar hoje? 😊

Posso cuidar dos seus:
🔔 lembretes
💊 horários de remédios
⏰ registro de ponto
💰 gastos
📅 rotina do dia

Digite *menu* a qualquer momento para ver tudo o que posso fazer.`;

// ====================== RESPOSTAS ======================

const respostasCurtas = [
  'Perfeito 😊',
  'Pode deixar 💜',
  'Tudo certo ✨',
  'Anotei aqui 😊',
  'Entendi 💜'
];

function respostaAleatoria() {
  return respostasCurtas[
    Math.floor(Math.random() * respostasCurtas.length)
  ];
}

const pensando = [
  '✨ Clareando ideias...',
  '✨ Organizando aqui...',
  '✨ Pensando rapidinho...',
  '✨ Deixa eu verificar...'
];

function pensandoAleatorio() {
  return pensando[
    Math.floor(Math.random() * pensando.length)
  ];
}

// ====================== HELPERS ======================

function nowBRT() {
  return new Date(
    new Date().toLocaleString(
      'en-US',
      { timeZone: 'America/Sao_Paulo' }
    )
  );
}

function dateBRT() {
  const d = nowBRT();

  return `${d.getFullYear()}-${String(
    d.getMonth() + 1
  ).padStart(2,'0')}-${String(
    d.getDate()
  ).padStart(2,'0')}`;
}

function amanhaBRT() {
  const d = nowBRT();

  d.setDate(d.getDate() + 1);

  return `${d.getFullYear()}-${String(
    d.getMonth() + 1
  ).padStart(2,'0')}-${String(
    d.getDate()
  ).padStart(2,'0')}`;
}

function normalizar(text) {
  return (text || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function horaStr(date) {
  if (!date) return '—';

  const d = new Date(date);

  return `${String(
    d.getHours()
  ).padStart(2,'0')}:${String(
    d.getMinutes()
  ).padStart(2,'0')}`;
}

function formatarDataBR(date) {
  if (!date) return '—';

  const d = new Date(date);

  return `${String(
    d.getDate()
  ).padStart(2,'0')}/${String(
    d.getMonth() + 1
  ).padStart(2,'0')}/${d.getFullYear()}`;
}

function formatarDataHoraBR(date) {
  if (!date) return '—';

  const d = new Date(date);

  const hoje = nowBRT();

  const amanha = new Date(hoje);

  amanha.setDate(
    amanha.getDate() + 1
  );

  const hStr = horaStr(d);

  if (
    d.toDateString() ===
    hoje.toDateString()
  ) {
    return `hoje às ${hStr}`;
  }

  if (
    d.toDateString() ===
    amanha.toDateString()
  ) {
    return `amanhã às ${hStr}`;
  }

  return `${formatarDataBR(d)} às ${hStr}`;
}

function criarDataBRT(dataStr, horaStr) {
  return new Date(
    `${dataStr}T${horaStr}:00-03:00`
  );
}

// ====================== RESPOSTA LIVRE ======================

async function responderLivre(
  user,
  phone,
  text
) {

  const history =
    await memory.getConversationHistory(
      user.id,
      10
    );

  const preferences =
    await memory.getUserPreference(
      user.id
    );

  const resp = await freeResponse(
    text,
    history,
    preferences
  );

  await memory.saveConversationMessage(
    user.id,
    'user',
    text
  );

  await memory.saveConversationMessage(
    user.id,
    'assistant',
    resp
  );

  return sendMessage(phone, resp);
}

// ====================== HANDLER ======================

async function handleMessage(
  phone,
  text,
  location = null
) {

  try {

    const user =
      await memory.getOrCreateUser(
        phone
      );

    if (!text) return;

    const textLower =
      normalizar(text);

    // ======================
    // MENU
    // ======================

    if (
      [
        'menu',
        'inicio',
        'ajuda',
        'opcoes'
      ].includes(textLower)
    ) {

      await memory.clearTemporaryContext(
        user.id
      );

      return await sendMessage(
        phone,
        MENU_TEXT
      );
    }

    // ======================
    // PRIMEIRA VEZ
    // ======================

    const preferencias =
      await memory.getUserPreference(
        user.id
      );

    const mems =
      await memory.getRecentMemories(
        user.id,
        10
      );

    const isNovo =
      mems.length === 0 &&
      !preferencias?.name;

    if (isNovo) {

      await memory.setTemporaryContext(
        user.id,
        'onboarding'
      );

      await sendMessage(
        phone,
        PRIMEIRA_MENSAGEM
      );

      setTimeout(async () => {

        await sendMessage(
          phone,

`✨ Antes de começarmos...

Pra eu conseguir te ajudar melhor no dia a dia, responde rapidinho algumas coisinhas 😊

👤 Como você prefere que eu te chame?

⏰ Qual seu horário de trabalho?
(Me fala a hora que entra, almoço e saída)

Exemplo:
“Entro 08:00, almoço 12:00 até 13:00 e saio 18:00”`
        );

      }, 1200);

      return;
    }

    // ======================
    // SEM NOME
    // ======================

    if (
      !preferencias?.name
    ) {

      await memory.setTemporaryContext(
        user.id,
        'onboarding'
      );

      return await sendMessage(
        phone,

`✨ Antes de começarmos...

Como você prefere que eu te chame? 😊`
      );
    }

    // ======================
    // CONTEXTO TEMPORÁRIO
    // ======================

    const contexto =
      await memory.getTemporaryContext(
        user.id
      );

    // ======================
    // ONBOARDING
    // ======================

    if (contexto === 'onboarding') {

      return await handleOnboarding(
        user,
        phone,
        text
      );
    }

    // ======================
    // CONVERSA LIVRE
    // ======================

    if (
      contexto === 'conversar'
    ) {

      return await responderLivre(
        user,
        phone,
        text
      );
    }

    // ======================
    // CLASSIFICAÇÃO
    // ======================

    const classified =
      await classify(text);

    console.log(
      `[${phone}] Tipo:`,
      classified.tipo
    );

    switch (classified.tipo) {

      case 'saudacao':

        return await sendMessage(
          phone,

`Oi${preferencias?.name ? ', ' + preferencias.name : ''} 😊

Como posso te ajudar hoje?`
        );

      case 'preferencia':

        await memory.saveUserPreference(
          user.id,
          classified.nome,
          classified.tom
        );

        return await sendMessage(
          phone,
          `Perfeito 😊`
        );

      case 'busca':

        await sendMessage(
          phone,
          pensandoAleatorio()
        );

        return await handleBusca(
          user,
          phone,
          classified.query || text
        );

      case 'consulta':

        await sendMessage(
          phone,
          pensandoAleatorio()
        );

        return await handleQuery(
          user,
          phone,
          text
        );

      case 'gasto':

        return await handleExpense(
          user,
          phone,
          classified
        );

      case 'tarefa':

        return await handleTask(
          user,
          phone,
          classified
        );

      case 'anotacao':

        return await handleNote(
          user,
          phone,
          classified
        );

      case 'medicamento':

        await memory.setTemporaryContext(
          user.id,
          'saude'
        );

        return await handleCadastroMedGuiado(
          user,
          phone,
          text
        );

      case 'ponto_multiplo':

        return await handlePontoMultiplo(
          user,
          phone,
          classified.acoes
        );

      default:

        return await responderLivre(
          user,
          phone,
          text
        );
    }

  } catch (error) {

    console.error(
      'Erro handleMessage:',
      error.message
    );

    await sendMessage(
      phone,
      'Tive um probleminha 😕'
    );
  }
}

// ====================== ONBOARDING ======================

async function handleOnboarding(
  user,
  phone,
  text
) {

  let nome = null;

  const nomeMatch =
    text.match(
      /(?:me chamo|meu nome é|pode me chamar de|sou o|sou a)\s+(.+)/i
    );

  if (nomeMatch) {
    nome = nomeMatch[1].trim();
  } else if (
    text.split(' ').length <= 3 &&
    !/\d/.test(text)
  ) {
    nome = text.trim();
  }

  if (nome) {

    await memory.saveUserPreference(
      user.id,
      nome,
      null
    );

    await memory.clearTemporaryContext(
      user.id
    );

    await sendMessage(
      phone,

`Prazer, ${nome} 😊

Agora ficou mais fácil cuidar da sua rotina 💜`
    );

    return await sendMessage(
      phone,
      MENU_TEXT
    );
  }

  return await sendMessage(
    phone,

`Pode me dizer como prefere ser chamado(a)? 😊`
  );
}
// ====================== ANOTAÇÕES ======================

async function handleNote(
  user,
  phone,
  classified
) {

  const conteudo =
    classified.conteudo ||
    classified.titulo ||
    '';

  await memory.saveMemory(
    user.id,
    'anotacao',
    conteudo,
    {
      titulo:
        classified.titulo
    }
  );

  return await sendMessage(
    phone,

`📝 Anotado com segurança

_"${conteudo}"_`
  );
}

// ====================== TAREFAS ======================

async function handleTask(
  user,
  phone,
  classified
) {

  await memory.saveMemory(
    user.id,
    'tarefa',
    classified.titulo,
    {
      data: classified.data,
      hora: classified.hora
    }
  );

  let hora =
    classified.hora;

  let data =
    classified.data;

  let semHorario =
    false;

  // SEM HORÁRIO
  // agenda automaticamente
  // para amanhã cedo

  if (!hora) {

    hora = '07:00';

    data = amanhaBRT();

    semHorario = true;
  }

  try {

    const scheduledAt =
      criarDataBRT(
        data || dateBRT(),
        hora
      );

    await prisma.reminder.create({
      data: {
        userId: user.id,
        phone,
        message:
          classified.titulo,
        scheduledAt
      }
    });

    const quando =
      semHorario
        ? 'amanhã de manhã'
        : formatarDataHoraBR(
            scheduledAt
          );

    return await sendMessage(
      phone,

`${respostaAleatoria()}

Vou te lembrar ${quando} 💜`
    );

  } catch (e) {

    console.error(
      'Erro reminder:',
      e.message
    );

    return await sendMessage(
      phone,

`${respostaAleatoria()}

Guardei isso aqui 😊`
    );
  }
}

// ====================== GASTOS ======================

async function handleExpense(
  user,
  phone,
  classified
) {

  const valor =
    Number(
      classified.valor
    ) || 0;

  const categoria =
    classified.categoria ||
    'outro';

  await memory.saveExpense(
    user.id,
    {
      valor,
      categoria,
      descricao:
        classified.descricao
    }
  );

  const icons = {
    mercado: '🛒',
    restaurante: '🍽️',
    saude: '💊',
    transporte: '🚗',
    lazer: '🎉',
    outro: '📦'
  };

  return await sendMessage(
    phone,

`💰 Gasto anotado

${icons[categoria] || '📦'} ${categoria}
💵 R$ ${valor.toFixed(2)}`
  );
}

// ====================== CONSULTAS ======================

async function handleQuery(
  user,
  phone,
  question
) {

  const memories =
    await memory.getRecentMemories(
      user.id,
      30
    );

  if (
    memories.length === 0
  ) {

    return await sendMessage(
      phone,

`Ainda não guardei nada 😊`
    );
  }

  const answer =
    await generateMemorySummary(
      memories,
      question
    );

  return await sendMessage(
    phone,
    answer
  );
}

// ====================== BUSCA ======================

async function handleBusca(
  user,
  phone,
  query
) {

  const cidade =
    await memory.getLastCity(
      user.id
    );

  const resultado =
    await searchWeb(
      query,
      cidade || ''
    );

  return await sendMessage(
    phone,
    resultado.text
  );
}

// ====================== PONTO ======================

async function handlePontoMultiplo(
  user,
  phone,
  acoes
) {

  const hoje =
    dateBRT();

  for (const acao of acoes) {

    const subtipo =
      acao.subtipo;

    const hora =
      acao.hora || horaStr(nowBRT());

    const timestamp =
      criarDataBRT(
        hoje,
        hora
      );

    const existing =
      await prisma.workLog.findFirst({
        where: {
          userId: user.id,
          type: subtipo,
          date: hoje
        }
      });

    if (existing) {

      await prisma.workLog.update({
        where: {
          id: existing.id
        },
        data: {
          timestamp
        }
      });

    } else {

      await prisma.workLog.create({
        data: {
          userId: user.id,
          type: subtipo,
          timestamp,
          date: hoje
        }
      });
    }
  }

  const pontos =
    await prisma.workLog.findMany({
      where: {
        userId: user.id,
        date: hoje
      },
      orderBy: {
        timestamp: 'asc'
      }
    });

  const msg =
    await gerarMensagemPonto(
      pontos,
      user.id
    );

  return await sendMessage(
    phone,
    msg
  );
}

// ====================== TEXTO PONTO ======================

async function gerarMensagemPonto(
  pontos,
  userId
) {

  const get =
    tipo =>
      pontos.find(
        p => p.type === tipo
      );

  const entrada =
    get('entrada');

  const saidaAlmoco =
    get('saida_almoco');

  const voltaAlmoco =
    get('volta_almoco');

  const saida =
    get('saida');

  const jornada =
    await memory.getJornada(
      userId
    );

  if (
    entrada &&
    !saidaAlmoco
  ) {

    return `✅ Entrada registrada

⏰ ${horaStr(
      entrada.timestamp
    )}

Bom trabalho hoje 😊`;
  }

  if (
    saidaAlmoco &&
    !voltaAlmoco
  ) {

    return `🍽️ Saída para almoço registrada

Bom almoço 😊`;
  }

  if (
    voltaAlmoco &&
    !saida
  ) {

    return `🔄 Retorno registrado

Bom trabalho 😊`;
  }

  if (saida) {

    let total = 0;

    if (
      entrada &&
      saidaAlmoco
    ) {

      total +=
        (
          new Date(
            saidaAlmoco.timestamp
          ) -
          new Date(
            entrada.timestamp
          )
        ) / 60000;
    }

    if (
      voltaAlmoco &&
      saida
    ) {

      total +=
        (
          new Date(
            saida.timestamp
          ) -
          new Date(
            voltaAlmoco.timestamp
          )
        ) / 60000;
    }

    const extras =
      total - jornada;

    return `🏁 Saída registrada

⏰ ${horaStr(
      saida.timestamp
    )}

📊 Total trabalhado:
${Math.floor(total / 60)}h${total % 60}min

${extras > 0
  ? `✨ Horas extras: ${Math.floor(extras / 60)}h`
  : '✅ Jornada concluída'}

Bom descanso 💜`;
  }

  return `Ponto atualizado 😊`;
}

// ====================== MEDICAMENTOS ======================

async function handleCadastroMedGuiado(
  user,
  phone,
  text
) {

  let cadastro =
    await memory.getMedicationContext(
      user.id
    );

  if (!cadastro) {

    cadastro = {
      etapa: 'nome'
    };
  }

  switch (cadastro.etapa) {

    case 'nome':

      cadastro.nome =
        text.trim();

      cadastro.etapa =
        'horario';

      await memory.saveMedicationContext(
        user.id,
        cadastro
      );

      return await sendMessage(
        phone,

`💊 Qual horário?

Exemplo:
08:00
ou
08:00 e 20:00`
      );

    case 'horario':

      const horarios =
        text.match(
          /\d{1,2}:\d{2}/g
        ) || ['08:00'];

      await memory.saveMedication(
        user.id,
        {
          nome:
            cadastro.nome,
          quantidade: 0,
          frequencia:
            horarios.length,
          horarios
        }
      );

      await memory.clearMedicationContext(
        user.id
      );

      await memory.clearTemporaryContext(
        user.id
      );

      return await sendMessage(
        phone,

`✅ Remédio cadastrado

💊 ${cadastro.nome}
🕒 ${horarios.join(', ')}

Vou te lembrar nos horários certinhos 😊`
      );
  }
}

// ====================== EXPORTS ======================

module.exports = {
  handleMessage
};
