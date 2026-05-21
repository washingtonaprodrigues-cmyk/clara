// Clara handler v4.0 - CRM de vida pessoal
const { classify, searchWeb, generateGiftIdeas, generateSearchResponse, generateMemorySummary } = require('../services/groq');
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
        const msg = `Oi! Que bom te ver aqui\n\nEu sou a Clara, sua assistente pessoal.\n\nAntes de comecar, como prefere que eu te trate?\n\n1 - Pode ser calorosa e natural\n2 - Prefiro que me chame pelo nome\n3 - Prefiro algo mais direto\n\nResponde com 1, 2 ou 3!`;
        await sendMessage(phone, msg);
        await memory.saveConversationMessage(user.id, 'assistant', msg);
        await memory.prisma.user.update({ where: { id: user.id }, data: { metadata: JSON.stringify({ tom: 'aguardando_preferencia' }) } });
        return;
      }
    }

    // Aguardando escolha de tom
    if (user.metadata) {
      try {
        const meta = JSON.parse(user.metadata);
        if (meta.tom === 'aguardando_preferencia') { await handleTomChoice(user, phone, text || ''); return; }
        if (meta.tom === 'aguardando_nome') {
          const nome = (text || '').trim().split(' ')[0];
          await memory.saveUserPreference(user.id, nome, 'nome');
          const msg = `Perfeito, ${nome}! Agora sim, pode contar comigo pro que precisar.`;
          await sendMessage(phone, msg);
          await memory.saveConversationMessage(user.id, 'assistant', msg);
          return;
        }
        // Aguardando confirmacao/ajuste de titulo da anotacao
        if (meta.aguardando_titulo_nota) {
          await handleTituloNota(user, phone, text || '', meta);
          return;
        }
        // Aguardando info de pessoa para evento
        if (meta.aguardando_info_evento) {
          await handleEventPersonInfo(user, phone, text || '', meta);
          return;
        }
      } catch (e) {}
    }

    // Transcreve audio
    if (audioUrl && !text) {
      try {
        const transcricao = await transcribeAudio(audioUrl);
        if (transcricao) { text = transcricao; console.log(`Audio transcrito de ${phone}: ${text}`); }
        else { await sendMessage(phone, 'Nao consegui entender o audio. Pode digitar?'); return; }
      } catch (e) { await sendMessage(phone, 'Tive dificuldade com o audio. Pode digitar?'); return; }
    }

    if (!text) return;

    // Cancela lembretes pendentes
    await cancelPendingReminders(user.id);

    // Verifica se usuario ficou 48h sem interagir — manda menu de capacidades antes de processar
    const deveVerMenu = await verificar48hSemInteracao(user.id);
    if (deveVerMenu) {
      const nome = userName ? `, ${userName}` : '';
      const menuMsg = `Que bom te ver por aqui${nome}!\n\n${MENU_CAPACIDADES}`;
      await sendMessage(phone, menuMsg);
      await memory.saveConversationMessage(user.id, 'assistant', menuMsg);
      await marcarMenuEnviado(user.id);
    }

    const history = await memory.getConversationHistory(user.id, 8);
    await memory.saveConversationMessage(user.id, 'user', text);

    let classified = await classify(text, history, userName, tom);
    console.log(`[${phone}] Tipo: ${classified.tipo}`);

    // Fallback manual: se o usuario pediu pra anotar e o classificador nao reconheceu
    const textLower = text.toLowerCase().trim();
    const pedidoAnotacao = ['anota', 'so anota', 'salva isso', 'guarda isso', 'registra isso', 'quero lembrar', 'guarda essa', 'anota essa', 'anota isso', 'salva essa ideia'];
    if (classified.tipo !== 'anotacao' && pedidoAnotacao.some(p => textLower.includes(p))) {
      const lastUserMsg = history.filter(h => h.role === 'user').slice(-1)[0];
      const conteudo = lastUserMsg ? lastUserMsg.content : text;
      const palavras = conteudo.split(' ').slice(0, 5).join(' ');
      classified = {
        tipo: 'anotacao',
        conteudo,
        titulo_sugerido: palavras,
        resposta: `Anotado! Chamei de *${palavras}* — pode ser esse titulo?`
      };
    }

    let resposta = '';

    switch (classified.tipo) {
      case 'reminder': resposta = await handleReminder(user, phone, classified); break;
      case 'tarefa': resposta = await handleTask(user, phone, classified); break;
      case 'remedio': resposta = await handleMedication(user, phone, classified); break;
      case 'compra': resposta = await handlePurchase(user, phone, classified); break;
      case 'gasto': resposta = await handleExpense(user, phone, classified); break;
      case 'segredo': resposta = await handleSecret(user, phone, classified); break;
      case 'consulta_memoria': resposta = await handleMemoryQuery(user, phone, text, userName, tom); break;
      case 'pressao': case 'glicemia': case 'humor': resposta = await handleHealth(user, phone, classified); break;
      case 'sono': resposta = await handleSleep(user, phone, classified); break;
      case 'treino': resposta = await handleWorkout(user, phone, classified); break;
      case 'mercado': resposta = await handleGrocery(user, phone, classified); break;
      case 'meta': resposta = await handleGoal(user, phone, classified); break;
      case 'evento_especial': resposta = await handleSpecialEvent(user, phone, classified); break;
      case 'info_pessoa': resposta = await handlePersonInfo(user, phone, classified); break;
      case 'busca_surpresa': resposta = await handleSurpriseSearch(user, phone, classified); break;
      case 'confirmacao': resposta = await handleConfirmacao(user, phone, classified); break;
      case 'preferencia_tom': resposta = await handlePreferenciaTom(user, phone, classified); break;
      case 'anotacao': resposta = await handleNote(user, phone, classified); break;
      case 'consulta_notas': resposta = await handleConsultaNotas(user, phone, classified); break;
      default:
        resposta = classified.resposta || 'To aqui!';
        await sendMessage(phone, resposta);
    }

    if (resposta) await memory.saveConversationMessage(user.id, 'assistant', resposta);

  } catch (error) {
    console.error('Erro handleMessage:', error);
    await sendMessage(phone, 'Tive um probleminha aqui. Pode repetir?');
  }
}

async function checkFirstMessage(userId) {
  const count = await memory.prisma.memory.count({ where: { userId } });
  return count === 0;
}

async function cancelPendingReminders(userId) {
  try {
    await memory.prisma.reminder.updateMany({
      where: { userId, confirmed: false, sent: false },
      data: { confirmed: true, sent: true },
    });
  } catch (e) {}
}

async function handleTomChoice(user, phone, text) {
  const choice = text.trim().toLowerCase();
  if (choice === '1' || choice.includes('calorosa') || choice.includes('sim') || choice.includes('pode')) {
    await memory.saveUserPreference(user.id, null, 'carinhoso');
    await sendMessage(phone, 'Combinado! Pode contar comigo pra tudo.');
  } else if (choice === '2' || choice.includes('nome')) {
    await memory.prisma.user.update({ where: { id: user.id }, data: { metadata: JSON.stringify({ tom: 'aguardando_nome' }) } });
    await sendMessage(phone, 'Como voce prefere que eu te chame?');
  } else if (choice === '3' || choice.includes('diret')) {
    await memory.saveUserPreference(user.id, null, 'direto');
    await sendMessage(phone, 'Combinado. Como posso ajudar?');
  } else {
    await sendMessage(phone, 'Responde com 1, 2 ou 3!\n\n1 - Calorosa\n2 - Pelo nome\n3 - Direta');
  }
}

async function handlePreferenciaTom(user, phone, data) {
  const { tom, nome } = data;
  if (tom === 'nome' && !nome) {
    await memory.prisma.user.update({ where: { id: user.id }, data: { metadata: JSON.stringify({ tom: 'aguardando_nome' }) } });
    await sendMessage(phone, 'Como voce prefere que eu te chame?');
    return '';
  }
  await memory.saveUserPreference(user.id, nome || null, tom);
  await sendMessage(phone, data.resposta);
  return data.resposta;
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
      data: { userId: user.id, phone, message: data.mensagem, scheduledAt, attempts: 0 },
    });
    const horarioStr = scheduledAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    const resposta = `${data.resposta}\nVou te avisar as ${horarioStr}.`;
    await sendMessage(phone, resposta);
    return resposta;
  } catch (error) {
    console.error('Erro handleReminder:', error);
    await sendMessage(phone, data.resposta);
    return data.resposta;
  }
}

async function handleConfirmacao(user, phone, data) {
  await sendMessage(phone, data.resposta);
  return data.resposta;
}

async function handleTask(user, phone, data) {
  const task = await memory.saveTask(user.id, data);
  let resposta = data.resposta;
  if (task.dueDate) {
    const dateStr = new Date(task.dueDate).toLocaleDateString('pt-BR');
    resposta += `\n\n${data.titulo} - ${dateStr}`;
    if (task.dueTime) resposta += ` as ${task.dueTime}`;
    if (task.items) resposta += `\nLevar: ${task.items}`;
    resposta += '\nVou te lembrar antes!';
  }
  await sendMessage(phone, resposta);
  return resposta;
}

async function handleMedication(user, phone, data) {
  if (!data.quantidade || data.quantidade === 0) {
    const resposta = `${data.resposta}\n\nQuantos comprimidos tem na caixa? Assim consigo te avisar antes de acabar.`;
    await sendMessage(phone, resposta);
    return resposta;
  }
  await memory.saveMedication(user.id, data);
  const horariosText = (data.horarios || ['08:00']).join(' e ');
  const resposta = `${data.resposta}\n\n${data.nome} - ${horariosText}\n${data.quantidade} comprimidos\nVou acompanhar o estoque pra voce.`;
  await sendMessage(phone, resposta);
  return resposta;
}

async function handlePurchase(user, phone, data) {
  const result = await memory.savePurchase(user.id, data.item);
  let resposta = data.resposta;
  if (result.isRecurring) resposta += `\nJa e a ${result.purchase.buyCount}a vez que voce compra ${data.item}.`;
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
  const resposta = `${data.resposta}\nGuardado com seguranca.`;
  await sendMessage(phone, resposta);
  return resposta;
}

async function handleHealth(user, phone, data) {
  await memory.saveHealthRecord(user.id, data.tipo, data);
  await sendMessage(phone, data.resposta);
  return data.resposta;
}

async function handleSleep(user, phone, data) {
  await memory.saveSleepLog(user.id, data);
  await sendMessage(phone, data.resposta);
  return data.resposta;
}

async function handleWorkout(user, phone, data) {
  await memory.saveWorkout(user.id, data);
  await sendMessage(phone, data.resposta);
  return data.resposta;
}

async function handleGrocery(user, phone, data) {
  await memory.saveGroceryList(user.id, data.itens);
  const resposta = `${data.resposta}\n\nLista salva! Quer que eu organize por categoria?`;
  await sendMessage(phone, resposta);
  return resposta;
}

async function handleGoal(user, phone, data) {
  await memory.saveMemory(user.id, 'meta', data.titulo, { prazo: data.prazo, categoria: data.categoria });
  await sendMessage(phone, data.resposta);
  return data.resposta;
}

async function handleSpecialEvent(user, phone, data) {
  const event = await memory.saveEvent(user.id, { titulo: data.titulo, pessoa: data.pessoa, data: data.data, type: 'especial' });
  // Se nao tem nome da pessoa, pergunta
  if (!data.pessoa) {
    const meta = JSON.parse(user.metadata || '{}');
    meta.aguardando_info_evento = { eventId: event.id, titulo: data.titulo };
    await memory.prisma.user.update({ where: { id: user.id }, data: { metadata: JSON.stringify(meta) } });
  }
  await sendMessage(phone, data.resposta);
  return data.resposta;
}

async function handleEventPersonInfo(user, phone, text, meta) {
  try {
    const parts = text.trim().split(/[\s,]+/);
    const nome = parts[0];
    const idadeMatch = text.match(/(\d+)/);
    const idade = idadeMatch ? parseInt(idadeMatch[1]) : null;

    if (meta.aguardando_info_evento) {
      await memory.updateEventPerson(user.id, meta.aguardando_info_evento.eventId, nome, idade);
      const newMeta = JSON.parse(user.metadata || '{}');
      delete newMeta.aguardando_info_evento;
      await memory.prisma.user.update({ where: { id: user.id }, data: { metadata: JSON.stringify(newMeta) } });

      const msg = `Anotado! Vou te lembrar do ${meta.aguardando_info_evento.titulo} de ${nome}${idade ? ` (${idade} anos)` : ''} antes da data chegar.`;
      await sendMessage(phone, msg);
      await memory.saveConversationMessage(user.id, 'assistant', msg);
    }
  } catch (e) {
    console.error('Erro handleEventPersonInfo:', e.message);
  }
}

async function handlePersonInfo(user, phone, data) {
  await memory.saveMemory(user.id, 'pessoa', `${data.nome}: ${data.info}`);
  await sendMessage(phone, data.resposta);
  return data.resposta;
}

async function handleSurpriseSearch(user, phone, data) {
  try {
    await sendMessage(phone, data.resposta);
    const searchResult = await searchWeb(data.query);
    const eventMemory = await memory.prisma.event.findFirst({
      where: { userId: user.id, title: { contains: data.contexto || '' } },
      orderBy: { createdAt: 'desc' },
    });
    const resposta = await generateGiftIdeas(
      data.contexto || data.query,
      eventMemory?.personName || null,
      eventMemory?.personAge || null,
      searchResult
    );
    if (resposta) await sendMessage(phone, resposta);
    return resposta || '';
  } catch (error) {
    console.error('Erro handleSurpriseSearch:', error.message);
    return '';
  }
}

async function handleMemoryQuery(user, phone, question, userName, tom) {
  const memories = await memory.getRecentMemories(user.id, 30);
  if (memories.length === 0) {
    const resposta = 'Ainda nao tenho anotacoes suas aqui. Me conta algo!';
    await sendMessage(phone, resposta);
    return resposta;
  }
  const resposta = await generateMemorySummary(memories, question, userName, tom);
  await sendMessage(phone, resposta);
  return resposta;
}

// ── NOTAS ──────────────────────────────────────────────────────────────────────

async function handleNote(user, phone, data) {
  try {
    const { conteudo, titulo_sugerido, resposta } = data;

    // Salva estado aguardando confirmacao do titulo
    const meta = JSON.parse(user.metadata || '{}');
    meta.aguardando_titulo_nota = { conteudo, titulo_sugerido };
    await memory.prisma.user.update({ where: { id: user.id }, data: { metadata: JSON.stringify(meta) } });

    await sendMessage(phone, resposta);
    return resposta;
  } catch (error) {
    console.error('Erro handleNote:', error);
    return data.resposta;
  }
}

async function handleTituloNota(user, phone, text, meta) {
  try {
    const { conteudo, titulo_sugerido } = meta.aguardando_titulo_nota;
    const input = text.trim();

    // Detecta se o usuario confirmou ou deu um titulo novo
    const confirmacoes = ['sim', 'pode', 'pode ser', 'ok', 'tá', 'ta', 'bom', 'isso', 'esse mesmo', 'beleza', 'perfeito', 'certo'];
    const confirmou = confirmacoes.some(c => input.toLowerCase() === c || input.toLowerCase().startsWith(c));

    const tituloFinal = confirmou ? titulo_sugerido : input;

    // Salva a nota
    await memory.saveNote(user.id, tituloFinal, conteudo);

    // Limpa estado
    const newMeta = JSON.parse(user.metadata || '{}');
    delete newMeta.aguardando_titulo_nota;
    await memory.prisma.user.update({ where: { id: user.id }, data: { metadata: JSON.stringify(newMeta) } });

    const msg = confirmou
      ? `Salvo como *${tituloFinal}*. É só pedir quando quiser ver.`
      : `Salvo como *${tituloFinal}*. Anotado!`;

    await sendMessage(phone, msg);
    await memory.saveConversationMessage(user.id, 'assistant', msg);
  } catch (e) {
    console.error('Erro handleTituloNota:', e.message);
    await sendMessage(phone, 'Tive um problema ao salvar. Pode repetir?');
  }
}

async function handleConsultaNotas(user, phone, data) {
  try {
    const { busca } = data;

    // Busca por tema especifico
    if (busca) {
      const nota = await memory.getNoteByTitle(user.id, busca);
      if (!nota) {
        const resposta = `Nao encontrei nenhuma anotacao sobre "${busca}". Quer ver todas?`;
        await sendMessage(phone, resposta);
        return resposta;
      }
      const dataFmt = nota.createdAt.toLocaleDateString('pt-BR');
      const resposta = `📝 *${nota.title}*\n${nota.content}\n\n_Anotado em ${dataFmt}_`;
      await sendMessage(phone, resposta);
      return resposta;
    }

    // Lista todas
    const notas = await memory.getNotes(user.id);
    if (notas.length === 0) {
      const resposta = 'Ainda nao tem nenhuma anotacao salva. Me manda uma ideia!';
      await sendMessage(phone, resposta);
      return resposta;
    }

    const lista = notas.map((n, i) => {
      const dataFmt = n.createdAt.toLocaleDateString('pt-BR');
      return `${i + 1}. *${n.title}* — ${dataFmt}`;
    }).join('\n');

    const resposta = `📝 Suas anotacoes:\n\n${lista}\n\nQuer ver o conteudo de alguma? Me fala o titulo.`;
    await sendMessage(phone, resposta);
    return resposta;
  } catch (error) {
    console.error('Erro handleConsultaNotas:', error);
    return '';
  }
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

// ── MENU CAPACIDADES ───────────────────────────────────────────────────────────

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

async function verificar48hSemInteracao(userId) {
  try {
    const ultimaMsg = await memory.prisma.memory.findFirst({
      where: { userId, type: 'conversa' },
      orderBy: { createdAt: 'desc' },
    });
    if (!ultimaMsg) return false; // primeiro contato — onboarding cuida disso
    const horasPassadas = (Date.now() - ultimaMsg.createdAt.getTime()) / (1000 * 60 * 60);
    if (horasPassadas < 48) return false;
    // Verifica se ja mandou menu recentemente (evita spam se usuario mandar varias msgs seguidas)
    const menuRecente = await memory.prisma.memory.findFirst({
      where: { userId, type: 'menu_enviado' },
      orderBy: { createdAt: 'desc' },
    });
    if (menuRecente) {
      const horasMenu = (Date.now() - menuRecente.createdAt.getTime()) / (1000 * 60 * 60);
      if (horasMenu < 48) return false; // ja mandou menu nas ultimas 48h
    }
    return true;
  } catch (e) {
    return false;
  }
}

async function marcarMenuEnviado(userId) {
  try {
    await memory.prisma.memory.create({
      data: { userId, type: 'menu_enviado', content: 'menu de capacidades enviado' },
    });
  } catch (e) {}
}

module.exports = { handleMessage };
