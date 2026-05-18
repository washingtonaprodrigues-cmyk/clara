// Clara handler v2.0
const { classify, searchWeb, generateSearchResponse, generateMemorySummary } = require('../services/groq');
const { sendMessage } = require('../services/whatsapp');
const memory = require('../services/memory');
const axios = require('axios');

async function handleMessage(phone, text, audioUrl = null) {
  try {
    const user = await memory.getOrCreateUser(phone);
    const { name: userName, tom } = await memory.getUserPreference(user.id);

    // Primeiro contato
    if (!user.name && !user.metadata) {
      const isFirst = await checkFirstMessage(user.id);
      if (isFirst) {
        await memory.saveConversationMessage(user.id, 'user', text || 'audio');
        const msg = `Ola! Eu sou a Clara, sua assistente pessoal.\n\nComo prefere que eu te trate?\n\n1 - Carinhosa (meu bem, amor)\n2 - Pelo nome\n3 - Direto e objetivo\n\nResponde com 1, 2 ou 3!`;
        await sendMessage(phone, msg);
        await memory.saveConversationMessage(user.id, 'assistant', msg);
        await memory.prisma.user.update({
          where: { id: user.id },
          data: { metadata: JSON.stringify({ tom: 'aguardando_preferencia' }) },
        });
        return;
      }
    }

    // Aguardando escolha de tom
    if (user.metadata) {
      try {
        const meta = JSON.parse(user.metadata);
        if (meta.tom === 'aguardando_preferencia') {
          await handleTomChoice(user, phone, text || '');
          return;
        }
        if (meta.tom === 'aguardando_nome') {
          const nome = (text || '').trim().split(' ')[0];
          await memory.saveUserPreference(user.id, nome, 'nome');
          const msg = `Prazer, ${nome}! Pode contar comigo. Como posso te ajudar hoje?`;
          await sendMessage(phone, msg);
          return;
        }
      } catch (e) {}
    }

    // Transcreve audio se necessario
    if (audioUrl && !text) {
      try {
        const transcricao = await transcribeAudio(audioUrl);
        if (transcricao) {
          text = transcricao;
          console.log(`Audio transcrito de ${phone}: ${text}`);
        } else {
          await sendMessage(phone, 'Nao consegui entender o audio. Pode digitar?');
          return;
        }
      } catch (e) {
        console.error('Erro transcrever audio:', e.message);
        await sendMessage(phone, 'Tive dificuldade com o audio. Pode digitar?');
        return;
      }
    }

    if (!text) return;

    // Historico da conversa (ultimas 6 mensagens)
    const history = await memory.getConversationHistory(user.id, 6);
    await memory.saveConversationMessage(user.id, 'user', text);

    // Classifica
    const classified = await classify(text, history, userName, tom);
    console.log(`[${phone}] Tipo: ${classified.tipo}`);

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
        resposta = classified.resposta || 'Estou aqui!';
        await sendMessage(phone, resposta);
    }

    if (resposta) {
      await memory.saveConversationMessage(user.id, 'assistant', resposta);
    }

  } catch (error) {
    console.error('Erro handleMessage:', error);
    await sendMessage(phone, 'Ops, tive um probleminha. Pode repetir?');
  }
}

async function checkFirstMessage(userId) {
  const count = await memory.prisma.memory.count({ where: { userId } });
  return count === 0;
}

async function handleTomChoice(user, phone, text) {
  const choice = text.trim().toLowerCase();
  if (choice === '1' || choice.includes('carinhosa') || choice.includes('carinhoso')) {
    await memory.saveUserPreference(user.id, null, 'carinhoso');
    await sendMessage(phone, 'Pode contar comigo, meu bem! Como posso te ajudar hoje?');
  } else if (choice === '2' || choice.includes('nome')) {
    await memory.prisma.user.update({ where: { id: user.id }, data: { metadata: JSON.stringify({ tom: 'aguardando_nome' }) } });
    await sendMessage(phone, 'Qual e o seu nome?');
  } else if (choice === '3' || choice.includes('diret')) {
    await memory.saveUserPreference(user.id, null, 'direto');
    await sendMessage(phone, 'Perfeito! Como posso ajudar?');
  } else {
    await sendMessage(phone, 'Responde com 1, 2 ou 3!\n\n1 - Carinhosa\n2 - Pelo nome\n3 - Direto');
  }
}

async function handlePreferenciaTom(user, phone, data) {
  const { tom, nome } = data;
  if (tom === 'nome' && !nome) {
    await memory.prisma.user.update({ where: { id: user.id }, data: { metadata: JSON.stringify({ tom: 'aguardando_nome' }) } });
    await sendMessage(phone, 'Qual e o seu nome?');
    return '';
  }
  await memory.saveUserPreference(user.id, nome || null, tom);
  await sendMessage(phone, data.resposta);
  return data.resposta;
}

async function handleBusca(user, phone, data, history, userName, tom) {
  try {
    await sendMessage(phone, data.resposta);
    let searchResult = null;
    try { searchResult = await searchWeb(data.query); } catch (e) {}
    const resposta = await generateSearchResponse(data.query, searchResult, userName, tom, history);
    await sendMessage(phone, resposta);
    return resposta;
  } catch (error) {
    console.error('Erro handleBusca:', error.message);
    await sendMessage(phone, 'Nao consegui buscar agora. Tenta de novo!');
    return '';
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
      if (scheduledAt < new Date()) scheduledAt.setDate(scheduledAt.getDate() + 1);
    } else {
      scheduledAt = new Date(Date.now() + 5 * 60000);
    }

    await memory.prisma.reminder.create({
      data: { userId: user.id, phone, message: `Lembrete: ${data.mensagem}\n\nJa fez isso? Me confirma!`, scheduledAt, attempts: 0 },
    });

    const horarioStr = scheduledAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    const resposta = `${data.resposta}\nVou te avisar as ${horarioStr}!`;
    await sendMessage(phone, resposta);
    return resposta;
  } catch (error) {
    console.error('Erro handleReminder:', error);
    await sendMessage(phone, data.resposta);
    return data.resposta;
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
  const resposta = `${data.resposta}\n\nRemedio: ${data.nome}\n${data.frequencia}x por dia - ${horariosText}\n${data.quantidade} comprimidos - acaba em ~${daysTotal} dias\nVou lembrar nos horarios!`;
  await sendMessage(phone, resposta);
  return resposta;
}

async function handlePurchase(user, phone, data) {
  const result = await memory.savePurchase(user.id, data.item);
  let resposta = data.resposta;
  if (result.isRecurring) resposta += `\nE a ${result.purchase.buyCount}a vez que voce compra ${data.item}.`;
  await sendMessage(phone, resposta);
  return resposta;
}

async function handleTask(user, phone, data) {
  const task = await memory.saveTask(user.id, data);
  let resposta = data.resposta;
  if (task.dueDate) {
    const dateStr = new Date(task.dueDate).toLocaleDateString('pt-BR');
    const timeStr = task.dueTime ? ` as ${task.dueTime}` : '';
    resposta += `\n\nAgendado: ${data.titulo}\n${dateStr}${timeStr}`;
    if (task.items) resposta += `\nLevar: ${task.items}`;
    resposta += '\nVou te lembrar antes!';
  }
  await sendMessage(phone, resposta);
  return resposta;
}

async function handleExpense(user, phone, data) {
  await memory.saveExpense(user.id, data);
  const expenses = await memory.getMonthExpenses(user.id);
  const total = expenses.reduce((sum, e) => sum + e.value, 0);
  const resposta = `${data.resposta}\nTotal do mes: R$ ${total.toFixed(2)}`;
  await sendMessage(phone, resposta);
  return resposta;
}

async function handleSecret(user, phone, data) {
  await memory.saveSecret(user.id, data);
  const resposta = `${data.resposta}\nGuardado com seguranca. So voce tem acesso.`;
  await sendMessage(phone, resposta);
  return resposta;
}

async function handleHealth(user, phone, data) {
  await memory.saveHealthRecord(user.id, data.tipo, data);
  await sendMessage(phone, data.resposta);
  return data.resposta;
}

async function handleMemoryQuery(user, phone, question, userName, tom) {
  const memories = await memory.getRecentMemories(user.id, 20);
  if (memories.length === 0) {
    const resposta = 'Ainda nao guardei nada pra voce. Me conta algo!';
    await sendMessage(phone, resposta);
    return resposta;
  }
  const resposta = await generateMemorySummary(memories, question, userName, tom);
  await sendMessage(phone, resposta);
  return resposta;
}

async function transcribeAudio(audioUrl) {
  try {
    const audioResponse = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 15000 });
    const audioBuffer = Buffer.from(audioResponse.data);
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', audioBuffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });
    form.append('model', 'whisper-large-v3');
    form.append('language', 'pt');
    form.append('response_format', 'text');
    const response = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
      headers: { ...form.getHeaders(), 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      timeout: 30000,
    });
    return typeof response.data === 'string' ? response.data.trim() : response.data?.text?.trim() || null;
  } catch (error) {
    console.error('Erro transcribeAudio:', error.message);
    return null;
  }
}

module.exports = { handleMessage };
