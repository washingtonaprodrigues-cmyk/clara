// Clara handler v3.0 - Mais humana, natural e inteligente

const {
  classify,
  searchWeb,
  generateSearchResponse,
  generateMemorySummary,
} = require('../services/groq');

const { sendMessage } = require('../services/whatsapp');
const memory = require('../services/memory');
const axios = require('axios');

// ============================================
// MAIN
// ============================================

async function handleMessage(phone, text, audioUrl = null) {
  try {
    const user = await memory.getOrCreateUser(phone);

    const {
      name: userName,
      tom,
    } = await memory.getUserPreference(user.id);

    // ============================================
    // PRIMEIRO CONTATO
    // ============================================

    if (!user.name && !user.metadata) {
      const isFirst = await checkFirstMessage(user.id);

      if (isFirst) {
        await memory.saveConversationMessage(
          user.id,
          'user',
          text || 'audio'
        );

        const msg =
`Oi! Que bom te ver aqui ✨

Eu sou a Clara, sua assistente pessoal 💜

Antes da gente começar, me conta uma coisa rapidinho:

1 - Pode ser mais carinhosa comigo 😊
2 - Prefiro que me chame pelo nome
3 - Prefiro algo mais direto

Pode responder só com 1, 2 ou 3 ✨`;

        await sendMessage(phone, msg);

        await memory.saveConversationMessage(
          user.id,
          'assistant',
          msg
        );

        await memory.prisma.user.update({
          where: { id: user.id },
          data: {
            metadata: JSON.stringify({
              tom: 'aguardando_preferencia',
            }),
          },
        });

        return;
      }
    }

    // ============================================
    // AGUARDANDO ESCOLHA
    // ============================================

    if (user.metadata) {
      try {
        const meta = JSON.parse(user.metadata);

        if (meta.tom === 'aguardando_preferencia') {
          await handleTomChoice(user, phone, text || '');
          return;
        }

        if (meta.tom === 'aguardando_nome') {
          const nome = (text || '').trim().split(' ')[0];

          await memory.saveUserPreference(
            user.id,
            nome,
            'nome'
          );

          const msg =
`Perfeito, ${nome} ✨

Agora sim, oficialmente apresentados 😄
Pode contar comigo pro que precisar!`;

          await sendMessage(phone, msg);

          await memory.saveConversationMessage(
            user.id,
            'assistant',
            msg
          );

          return;
        }

      } catch (e) {}
    }

    // ============================================
    // TRANSCRIÇÃO DE ÁUDIO
    // ============================================

    if (audioUrl && !text) {
      try {
        const transcricao = await transcribeAudio(audioUrl);

        if (transcricao) {
          text = transcricao;

          console.log(
            `[Áudio] ${phone}: ${text}`
          );
        } else {
          await sendMessage(
            phone,
            'Não consegui entender o áudio 😢 Pode me mandar digitado?'
          );

          return;
        }

      } catch (e) {
        console.error('Erro transcrição:', e.message);

        await sendMessage(
          phone,
          'Tive dificuldade pra entender o áudio 😢'
        );

        return;
      }
    }

    if (!text) return;

    // ============================================
    // CANCELA LEMBRETES PENDENTES
    // ============================================

    await cancelPendingReminders(user.id);

    // ============================================
    // HISTÓRICO
    // ============================================

    const history = await memory.getConversationHistory(
      user.id,
      8
    );

    await memory.saveConversationMessage(
      user.id,
      'user',
      text
    );

    // ============================================
    // CLASSIFICA
    // ============================================

    const classified = await classify(
      text,
      history,
      userName,
      tom
    );

    console.log(
      `[${phone}] Tipo identificado: ${classified.tipo}`
    );

    let resposta = '';

    switch (classified.tipo) {

      case 'reminder':
        resposta = await handleReminder(
          user,
          phone,
          classified
        );
        break;

      case 'tarefa':
        resposta = await handleTask(
          user,
          phone,
          classified
        );
        break;

      case 'remedio':
        resposta = await handleMedication(
          user,
          phone,
          classified
        );
        break;

      case 'compra':
        resposta = await handlePurchase(
          user,
          phone,
          classified
        );
        break;

      case 'gasto':
        resposta = await handleExpense(
          user,
          phone,
          classified
        );
        break;

      case 'segredo':
        resposta = await handleSecret(
          user,
          phone,
          classified
        );
        break;

      case 'consulta_memoria':
        resposta = await handleMemoryQuery(
          user,
          phone,
          text,
          userName,
          tom
        );
        break;

      case 'pressao':
      case 'glicemia':
      case 'humor':
        resposta = await handleHealth(
          user,
          phone,
          classified
        );
        break;

      case 'confirmacao':
        resposta = await handleConfirmacao(
          phone,
          classified
        );
        break;

      case 'preferencia_tom':
        resposta = await handlePreferenciaTom(
          user,
          phone,
          classified
        );
        break;

      case 'busca':
        resposta = await handleBusca(
          phone,
          classified,
          history,
          userName,
          tom
        );
        break;

      default:
        resposta =
          classified.resposta ||
          'Estou aqui 💜';

        await sendMessage(phone, resposta);
    }

    if (resposta) {
      await memory.saveConversationMessage(
        user.id,
        'assistant',
        resposta
      );
    }

  } catch (error) {
    console.error('Erro handleMessage:', error);

    await sendMessage(
      phone,
      'Tive um probleminha aqui 😢 Pode repetir pra mim?'
    );
  }
}

// ============================================
// TOM
// ============================================

async function handleTomChoice(user, phone, text) {
  const choice = text.trim().toLowerCase();

  if (
    choice === '1' ||
    choice.includes('carinhosa') ||
    choice.includes('sim')
  ) {

    await memory.saveUserPreference(
      user.id,
      null,
      'carinhoso'
    );

    await sendMessage(
      phone,
`Aaaah, perfeito então 🥹💜

Pode deixar que vou cuidar direitinho de você por aqui.
E prometo não exagerar 😄`
    );

    return;
  }

  if (
    choice === '2' ||
    choice.includes('nome')
  ) {

    await memory.prisma.user.update({
      where: { id: user.id },
      data: {
        metadata: JSON.stringify({
          tom: 'aguardando_nome',
        }),
      },
    });

    await sendMessage(
      phone,
      'Perfeito ✨ E como você prefere que eu te chame?'
    );

    return;
  }

  if (
    choice === '3' ||
    choice.includes('direto')
  ) {

    await memory.saveUserPreference(
      user.id,
      null,
      'direto'
    );

    await sendMessage(
      phone,
      'Combinado 👍 Vou ser mais objetiva então.'
    );

    return;
  }

  await sendMessage(
    phone,
`Pode responder assim:

1 - Carinhosa
2 - Pelo nome
3 - Direta ✨`
  );
}

// ============================================
// LEMBRETES
// ============================================

async function handleReminder(user, phone, data) {
  try {

    let scheduledAt;

    if (
      data.minutos_relativos &&
      data.minutos_relativos > 0
    ) {

      scheduledAt = new Date(
        Date.now() +
        data.minutos_relativos * 60000
      );

    } else if (data.hora) {

      const [horas, minutos] =
        data.hora.split(':').map(Number);

      scheduledAt = new Date();

      scheduledAt.setHours(
        horas,
        minutos,
        0,
        0
      );

      if (scheduledAt < new Date()) {
        scheduledAt.setDate(
          scheduledAt.getDate() + 1
        );
      }

    } else {

      scheduledAt = new Date(
        Date.now() + 5 * 60000
      );
    }

    await memory.prisma.reminder.create({
      data: {
        userId: user.id,
        phone,
        message:
`✨ Só passando pra te lembrar:

${data.mensagem}

Depois me fala se deu tudo certo 💜`,
        scheduledAt,
        attempts: 0,
      },
    });

    const horarioStr =
      scheduledAt.toLocaleTimeString(
        'pt-BR',
        {
          hour: '2-digit',
          minute: '2-digit',
        }
      );

    const resposta =
`${data.resposta}

⏰ Vou te lembrar às ${horarioStr}.`;

    await sendMessage(phone, resposta);

    return resposta;

  } catch (error) {

    console.error(
      'Erro handleReminder:',
      error
    );

    await sendMessage(
      phone,
      data.resposta
    );

    return data.resposta;
  }
}

// ============================================
// TASKS
// ============================================

async function handleTask(user, phone, data) {
  const task = await memory.saveTask(
    user.id,
    data
  );

  let resposta = data.resposta;

  if (task.dueDate) {

    const dateStr =
      new Date(task.dueDate)
        .toLocaleDateString('pt-BR');

    resposta += `

📅 ${dateStr}`;

    if (task.dueTime) {
      resposta += ` às ${task.dueTime}`;
    }

    if (task.items) {
      resposta += `

🎒 Pra não esquecer:
${task.items}`;
    }

    resposta += `

Vou te lembrar antes ✨`;
  }

  await sendMessage(phone, resposta);

  return resposta;
}

// ============================================
// REMÉDIOS
// ============================================

async function handleMedication(user, phone, data) {

  if (
    !data.quantidade ||
    data.quantidade === 0
  ) {

    const resposta =
`${data.resposta}

💊 Quantos comprimidos vêm na caixa?
Assim consigo te avisar antes de acabar 😊`;

    await sendMessage(phone, resposta);

    return resposta;
  }

  await memory.saveMedication(
    user.id,
    data
  );

  const horariosText =
    (data.horarios || ['08:00'])
      .join(' e ');

  const resposta =
`${data.resposta}

💊 ${data.nome}
⏰ ${horariosText}
📦 ${data.quantidade} comprimidos

Vou acompanhar isso com você certinho 💜`;

  await sendMessage(phone, resposta);

  return resposta;
}

// ============================================
// COMPRAS
// ============================================

async function handlePurchase(user, phone, data) {

  const result =
    await memory.savePurchase(
      user.id,
      data.item
    );

  let resposta = data.resposta;

  if (result.isRecurring) {
    resposta += `
    
👀 Acho que isso já virou compra recorrente por aí 😄`;
  }

  await sendMessage(phone, resposta);

  return resposta;
}

// ============================================
// GASTOS
// ============================================

async function handleExpense(user, phone, data) {

  await memory.saveExpense(
    user.id,
    data
  );

  const expenses =
    await memory.getMonthExpenses(user.id);

  const total = expenses.reduce(
    (sum, e) => sum + e.value,
    0
  );

  const resposta =
`${data.resposta}

💰 Total do mês:
R$ ${total.toFixed(2)}`;

  await sendMessage(phone, resposta);

  return resposta;
}

// ============================================
// SEGREDOS
// ============================================

async function handleSecret(user, phone, data) {

  await memory.saveSecret(
    user.id,
    data
  );

  const resposta =
`${data.resposta}

🔒 Guardado com segurança.`;

  await sendMessage(phone, resposta);

  return resposta;
}

// ============================================
// SAÚDE
// ============================================

async function handleHealth(user, phone, data) {

  await memory.saveHealthRecord(
    user.id,
    data.tipo,
    data
  );

  await sendMessage(
    phone,
    data.resposta
  );

  return data.resposta;
}

// ============================================
// MEMÓRIA
// ============================================

async function handleMemoryQuery(
  user,
  phone,
  question,
  userName,
  tom
) {

  const memories =
    await memory.getRecentMemories(
      user.id,
      20
    );

  if (memories.length === 0) {

    const resposta =
      'Ainda não tenho anotações suas aqui 😊';

    await sendMessage(phone, resposta);

    return resposta;
  }

  const resposta =
    await generateMemorySummary(
      memories,
      question,
      userName,
      tom
    );

  await sendMessage(phone, resposta);

  return resposta;
}

// ============================================
// BUSCA
// ============================================

async function handleBusca(
  phone,
  data,
  history,
  userName,
  tom
) {

  try {

    await sendMessage(
      phone,
      data.resposta
    );

    let searchResult = null;

    try {
      searchResult =
        await searchWeb(data.query);
    } catch (e) {}

    const resposta =
      await generateSearchResponse(
        data.query,
        searchResult,
        userName,
        tom,
        history
      );

    await sendMessage(phone, resposta);

    return resposta;

  } catch (error) {

    console.error(
      'Erro busca:',
      error.message
    );

    await sendMessage(
      phone,
      'Não consegui pesquisar agora 😢'
    );

    return '';
  }
}

// ============================================
// CONFIRMAÇÕES
// ============================================

async function handleConfirmacao(
  phone,
  data
) {

  await sendMessage(
    phone,
    data.resposta
  );

  return data.resposta;
}

// ============================================
// HELPERS
// ============================================

async function cancelPendingReminders(
  userId
) {
  try {

    await memory.prisma.reminder.updateMany({
      where: {
        userId,
        confirmed: false,
        sent: false,
      },
      data: {
        confirmed: true,
        sent: true,
      },
    });

  } catch (e) {}
}

async function checkFirstMessage(userId) {
  const count =
    await memory.prisma.memory.count({
      where: { userId },
    });

  return count === 0;
}

// ============================================
// ÁUDIO
// ============================================

async function transcribeAudio(audioUrl) {

  try {

    const audioResponse =
      await axios.get(audioUrl, {
        responseType: 'arraybuffer',
        timeout: 15000,
      });

    const audioBuffer =
      Buffer.from(audioResponse.data);

    const FormData = require('form-data');

    const form = new FormData();

    form.append(
      'file',
      audioBuffer,
      {
        filename: 'audio.ogg',
        contentType: 'audio/ogg',
      }
    );

    form.append(
      'model',
      'whisper-large-v3'
    );

    form.append(
      'language',
      'pt'
    );

    form.append(
      'response_format',
      'text'
    );

    const response = await axios.post(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization:
            `Bearer ${process.env.GROQ_API_KEY}`,
        },
        timeout: 30000,
      }
    );

    return typeof response.data === 'string'
      ? response.data.trim()
      : response.data?.text?.trim() || null;

  } catch (error) {

    console.error(
      'Erro transcribeAudio:',
      error.message
    );

    return null;
  }
}

module.exports = {
  handleMessage,
};
