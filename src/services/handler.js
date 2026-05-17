const { classify, generateElaborateResponse, generateSearchResponse, generateMemorySummary, searchWeb } = require('../services/groq');
const axios = require('axios');
const { sendMessage } = require('../services/whatsapp');
const memory = require('../services/memory');

async function handleMessage(phone, text, audioUrl = null) {
  try {
    const user = await memory.getOrCreateUser(phone);
    const { name: userName, tom } = await memory.getUserPreference(user.id);

    // Primeiro contato — pergunta preferência de tom
    if (!user.name && !user.metadata) {
      const isFirstMessage = await checkFirstMessage(user.id);
      if (isFirstMessage) {
        await memory.saveConversationMessage(user.id, 'user', text);
        const msg = `Olá! Eu sou a Clara, sua assistente pessoal. 💛\n\nAntes de começar, como você prefere que eu te trate?\n\n1️⃣ *Carinhosa* — te chamo de "meu bem", "amor"\n2️⃣ *Pelo nome* — me diz seu nome e te chamo assim\n3️⃣ *Direta* — sem termos carinhosos, só objetivo\n\nMe responde com 1, 2 ou 3! 😊`;
        await sendMessage(phone, msg);
        await memory.saveConversationMessage(user.id, 'assistant', msg);

        // Salva flag de aguardando preferência
        await memory.prisma.user.update({
          where: { id: user.id },
          data: { metadata: JSON.stringify({ tom: 'aguardando_preferencia' }) },
        });
        return;
      }
    }

    // Usuário está respondendo a preferência de tom
    if (user.metadata) {
      try {
        const meta = JSON.parse(user.metadata);
        if (meta.tom === 'aguardando_preferencia') {
          await handleTomChoice(user, phone, text);
          return;
        }
        // Usuário informou nome após escolher tom "pelo nome"
        if (meta.tom === 'aguardando_nome') {
          const nome = text.trim().split(' ')[0];
          await memory.saveUserPreference(user.id, nome, 'nome');
          const msg = `Prazer, ${nome}! Pode contar comigo pra tudo. 😊 Como posso te ajudar hoje?`;
          await sendMessage(phone, msg);
          await memory.saveConversationMessage(user.id, 'assistant', msg);
          return;
        }
      } catch (e) {}
    }

    // Busca histórico da conversa
    const history = await memory.getConversationHistory(user.id);

    // Salva mensagem do usuário no histórico
    await memory.saveConversationMessage(user.id, 'user', text);

    // Classifica a mensagem
    const classified = await classify(text, history, userName, tom);
    console.log(`[${phone}] Tipo: ${classified.tipo}`, classified);

    let resposta = '';

    switch (classified.tipo) {
      case 'reminder':
        resposta = await handleReminder(user, phone, classified);
        break;
      case 'remedio':
        resposta = await handleMedication(user, phone, classified);
        break;
      case 'compra':
        resposta = await handlePurchase(user, phone, classified);
        break;
      case 'tarefa':
        resposta = await handleTask(user, phone, classified);
        break;
      case 'gasto':
        resposta = await handleExpense(user, phone, classified);
        break;
      case 'segredo':
        resposta = await handleSecret(user, phone, classified);
        break;
      case 'consulta_memoria':
        resposta = await handleMemoryQuery(user, phone, text, userName, tom);
        break;
      case 'pressao':
      case 'glicemia':
      case 'humor':
        resposta = await handleHealth(user, phone, classified);
        break;
      case 'confirmacao':
        resposta = await handleConfirmacao(user, phone, classified);
        break;
      case 'preferencia_tom':
        resposta = await handlePreferenciaTom(user, phone, classified);
        break;
      case 'busca':
        resposta = await handleBusca(user, phone, classified, history, userName, tom);
        break;
      default:
        resposta = await generateElaborateResponse(text, null, userName, tom, history);
        await sendMessage(phone, resposta);
    }

    // Salva resposta no histórico
    if (resposta) {
      await memory.saveConversationMessage(user.id, 'assistant', resposta);
    }

  } catch (error) {
    console.error('Erro handleMessage:', error);
    await sendMessage(phone, 'Ops, tive um probleminha aqui. Pode repetir? 💛');
  }
}

async function checkFirstMessage(userId) {
  const count = await memory.prisma.memory.count({ where: { userId } });
  return count === 0;
}

async function handleTomChoice(user, phone, text) {
  const choice = text.trim();

  if (choice === '1' || choice.toLowerCase().includes('carinhosa')) {
    await memory.saveUserPreference(user.id, null, 'carinhoso');
    const msg = `Ótimo! Pode contar comigo, meu bem. 💛 Como posso te ajudar hoje?`;
    await sendMessage(phone, msg);
    await memory.saveConversationMessage(user.id, 'assistant', msg);

  } else if (choice === '2' || choice.toLowerCase().includes('nome')) {
    await memory.prisma.user.update({
      where: { id: user.id },
      data: { metadata: JSON.stringify({ tom: 'aguardando_nome' }) },
    });
    const msg = `Que ótimo! Me diz seu nome pra eu te chamar direitinho. 😊`;
    await sendMessage(phone, msg);
    await memory.saveConversationMessage(user.id, 'assistant', msg);

  } else if (choice === '3' || choice.toLowerCase().includes('direta') || choice.toLowerCase().includes('direto')) {
    await memory.saveUserPreference(user.id, null, 'direto');
    const msg = `Perfeito! Vou ser direta e objetiva. Como posso ajudar?`;
    await sendMessage(phone, msg);
    await memory.saveConversationMessage(user.id, 'assistant', msg);

  } else {
    const msg = `Me responde com 1, 2 ou 3 pra eu saber como te tratar! 😊\n\n1️⃣ Carinhosa\n2️⃣ Pelo nome\n3️⃣ Direta`;
    await sendMessage(phone, msg);
  }
}

async function handlePreferenciaTom(user, phone, data) {
  const { tom, nome } = data;

  if (tom === 'nome' && nome) {
    await memory.saveUserPreference(user.id, nome, 'nome');
  } else if (tom === 'nome' && !nome) {
    await memory.prisma.user.update({
      where: { id: user.id },
      data: { metadata: JSON.stringify({ tom: 'aguardando_nome' }) },
    });
    const msg = `Me diz seu nome pra eu te chamar direitinho! 😊`;
    await sendMessage(phone, msg);
    return msg;
  } else {
    await memory.saveUserPreference(user.id, null, tom);
  }

  await sendMessage(phone, data.resposta);
  return data.resposta;
}

async function handleBusca(user, phone, data, history, userName, tom) {
  try {
    await sendMessage(phone, data.resposta);
    let searchResult = null;
    try {
      searchResult = await searchWeb(data.query);
    } catch (e) {
      console.error('Erro searchWeb:', e.message);
    }
    const resposta = await generateSearchResponse(data.query, searchResult, userName, tom, history);
    await sendMessage(phone, resposta);
    return resposta;
  } catch (error) {
    console.error('Erro handleBusca:', error.message);
    const fallback = 'Nao consegui buscar agora, mas posso te ajudar com o que sei! Me pergunta direto que eu respondo. 😊';
    await sendMessage(phone, fallback);
    return fallback;
  }
}

async function handleReminder(user, phone, data) {
  try {
    let scheduledAt;

    if (data.minutos_relativos && data.minutos_relativos > 0) {
      scheduledAt = new Date(Date.now() + data.minutos_relativos * 60000);
    } else if (data.hora) {
      const [horas, minutos] = data.hora.split(':').map(Number);
      scheduledAt = new Date();
      scheduledAt.setHours(horas, minutos, 0, 0);
      if (scheduledAt < new Date()) {
        scheduledAt.setDate(scheduledAt.getDate() + 1);
      }
    } else {
      scheduledAt = new Date(Date.now() + 5 * 60000);
    }

    await memory.prisma.reminder.create({
      data: {
        userId: user.id,
        phone,
        message: `⏰ *Lembrete:* ${data.mensagem}\n\nJá fez isso? Me confirma aqui! 💛`,
        scheduledAt,
        attempts: 0,
      },
    });

    const horarioStr = scheduledAt.toLocaleTimeString('pt-BR', {
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
    });

    const resposta = `${data.resposta}\n\n⏰ Vou te avisar às ${horarioStr}! 💛`;
    await sendMessage(phone, resposta);
    console.log(`⏰ Reminder criado para ${phone} às ${scheduledAt}`);
    return resposta;
  } catch (error) {
    console.error('Erro handleReminder:', error);
    const resposta = 'Anotei o lembrete! 💛';
    await sendMessage(phone, resposta);
    return resposta;
  }
}

async function handleConfirmacao(user, phone, data) {
  try {
    await memory.prisma.reminder.updateMany({
      where: { userId: user.id, confirmed: false, sent: false },
      data: { confirmed: true, sent: true },
    });
  } catch (e) {}
  await sendMessage(phone, data.resposta);
  return data.resposta;
}

async function handleMedication(user, phone, data) {
  await memory.saveMedication(user.id, data);
  const daysTotal = Math.floor((data.quantidade || 0) / (data.frequencia || 1));
  const horariosText = (data.horarios || ['08:00']).join(' e ');
  const resposta = `${data.resposta}\n\n💊 *${data.nome}*\n• ${data.frequencia}x por dia — ${horariosText}\n• ${data.quantidade} comprimidos — acaba em ~${daysTotal} dias\n\nVou te lembrar nos horários certinhos! 💛`;
  await sendMessage(phone, resposta);
  return resposta;
}

async function handlePurchase(user, phone, data) {
  const result = await memory.savePurchase(user.id, data.item);
  let resposta = data.resposta;
  if (result.isRecurring && result.daysSinceLast) {
    resposta += `\n\n🔄 É a ${result.purchase.buyCount}ª vez que você compra ${data.item}.`;
  }
  await sendMessage(phone, resposta);
  return resposta;
}

async function handleTask(user, phone, data) {
  const task = await memory.saveTask(user.id, data);
  let resposta = data.resposta;
  if (task.dueDate) {
    const dateStr = new Date(task.dueDate).toLocaleDateString('pt-BR');
    const timeStr = task.dueTime ? ` às ${task.dueTime}` : '';
    resposta += `\n\n📅 *${data.titulo}*\n• ${dateStr}${timeStr}`;
    if (task.items) resposta += `\n• Levar: ${task.items}`;
    resposta += `\n\nVou te lembrar antes! 💛`;
  }
  await sendMessage(phone, resposta);
  return resposta;
}

async function handleExpense(user, phone, data) {
  await memory.saveExpense(user.id, data);
  const expenses = await memory.getMonthExpenses(user.id);
  const total = expenses.reduce((sum, e) => sum + e.value, 0);
  const resposta = `${data.resposta}\n\n💰 Total gasto este mês: *R$ ${total.toFixed(2)}*`;
  await sendMessage(phone, resposta);
  return resposta;
}

async function handleSecret(user, phone, data) {
  await memory.saveSecret(user.id, data);
  const resposta = `${data.resposta}\n\n🔒 Guardado com carinho. Só você tem acesso.`;
  await sendMessage(phone, resposta);
  return resposta;
}

async function handleHealth(user, phone, data) {
  await memory.saveHealthRecord(user.id, data.tipo, data);
  await sendMessage(phone, data.resposta);
  return data.resposta;
}

async function handleMemoryQuery(user, phone, question, userName, tom) {
  const memories = await memory.getRecentMemories(user.id, 30);
  if (memories.length === 0) {
    const resposta = 'Ainda não guardei nada pra você. Me conta algo! 💛';
    await sendMessage(phone, resposta);
    return resposta;
  }
  const resposta = await generateMemorySummary(memories, question, userName, tom);
  await sendMessage(phone, resposta);
  return resposta;
}

async function transcribeAudio(audioUrl) {
  try {
    // Baixa o audio
    const audioResponse = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 15000 });
    const audioBuffer = Buffer.from(audioResponse.data);

    // Envia pro Groq Whisper via form-data
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', audioBuffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });
    form.append('model', 'whisper-large-v3');
    form.append('language', 'pt');
    form.append('response_format', 'text');

    const response = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
      headers: {
        ...form.getHeaders(),
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      timeout: 30000,
    });

    return typeof response.data === 'string' ? response.data.trim() : response.data?.text?.trim() || null;
  } catch (error) {
    console.error('Erro transcribeAudio:', error.message);
    return null;
  }
}

module.exports = { handleMessage };
