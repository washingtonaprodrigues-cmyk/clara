const { classify, extractPersonalInfo, searchWeb, freeResponse, generateMemorySummary } = require('./groq');
const { sendMessage, sendButtons, sendReminderWithButtons } = require('./whatsapp');
const memory = require('./memory');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { buildPersonalContext, savePersonalInfo, saveContact, getContacts, findContactByName } = memory;
const MENU = `✨ *Oi, eu sou a Clara.*

Posso cuidar de lembretes, anotações, gastos, saúde, ponto e pesquisas rápidas.

Você pode tocar em uma opção ou escrever do seu jeito:
- _"me lembra de tomar remédio às 22h"_
- _"gastei 42 reais no mercado"_
- _"cheguei às 9h no trabalho"_
- _"qual foi a senha do Wi-Fi?"_

O que vamos resolver agora?`;

const MENU_BUTTONS = [
  { id: 'criar_lembrete', label: '⏰ Lembrete' },
  { id: 'nova_anotacao', label: '📝 Anotação' },
  { id: 'novo_gasto', label: '💰 Gasto' },
  { id: 'bater_ponto', label: '📍 Ponto' },
  { id: 'pesquisar', label: '🔍 Pesquisa' },
  { id: 'conversar', label: '💬 Conversar' },
];

const BOAS_VINDAS_MODO = {
  'lembrete':  `⏰ *Lembretes*\n\nPosso te lembrar de uma reunião, uma tarefa ou qualquer compromisso que desejar!\n\nExemplos:\n• _"Me lembra às 19h de buscar minha filha"_\n• _"Lembrete amanhã às 8h de tomar remédio"_\n• _"Me lembra sexta às 18h da reunião"_\n\n_É só me dizer!_ 😊`,
  'anotacao':  `📝 *Anotações*\n\nGuardo qualquer informação pra você consultar quando quiser!\n\nExemplos:\n• _"Senha do Wi-Fi: 12345"_\n• _"Código do cliente: ABC123"_\n• _"Endereço da minha médica"_\n• _"Senha do cartão: 9010"_\n\n_O que quer guardar?_ 😊`,
  'gasto':     `💰 *Gastos*\n\nRegistro tudo e te mostro um resumo certinho do mês!\n\nExemplos:\n• _"Gastei 45 reais no mercado"_\n• _"Paguei 120 no restaurante"_\n• _"Quanto gastei esse mês?"_\n\n_Me conta seu gasto!_ 💸`,
  'saude':     `💊 *Saúde*\n\nCuido dos seus remédios e te aviso na hora certinha!\n\nExemplos:\n• _"Tomo Losartana todo dia às 8h"_\n• _"Vitamina C às 9h e às 21h"_\n\n_Qual medicamento quer registrar?_ 😊`,
  'ponto':     `📍 *Ponto Digital*\n\nRegistro sua jornada e calculo horas extras!\n\nExemplos:\n• _"Entrei às 8:15"_\n• _"Saí pra almoçar às 12:30"_\n• _"Voltei do almoço às 14:10"_\n• _"Saí do trabalho às 18:05"_\n\nOu tudo de uma vez:\n_"Entrei 8h, saí almoçar 12h, voltei 13h, saí 17h"_\n\n_Pode me dizer!_ 📍`,
  'pesquisar': `🔍 *Pesquisar*\n\nBusco qualquer coisa pra você na internet!\n\n☀️ _"Como está o tempo hoje?"_\n🔮 _"Horóscopo de Áries"_\n📞 _"Telefone da farmácia mais próxima"_\n📍 _"Endereço do Detran"_\n💵 _"Preço do dólar hoje"_\n\n_O que quer pesquisar?_ ✨`,
  'conversar': `💬 *Conversar*\n\nAdoro uma boa conversa! Pode falar à vontade sobre qualquer assunto 😄\n\n_Pode começar!_ 🥰`,
};

// Tipos de lista que precisam ser executados antes de gerar a resposta
const LISTA_TIPOS = ['lista_compras', 'lista_buscar', 'lista_marcar', 'lista_adicionar'];
const CONTATO_TIPOS = ['salvar_contato', 'deletar_contato', 'enviar_mensagem', 'enviar_mensagem_agendada'];

function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function dateBRT() {
  const d = nowBRT();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function minutesToHours(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h${m > 0 ? m + 'min' : ''}`;
}

function horaStr(date) {
  if (!date) return '—';
  const d = new Date(date);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatarDataBR(date) {
  if (!date) return '—';
  const d = new Date(date);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function formatarDataHoraBR(date) {
  if (!date) return '—';
  const d = new Date(date);
  const hoje = nowBRT();
  const amanha = new Date(hoje);
  amanha.setDate(amanha.getDate() + 1);
  const dStr = `${d.getDate()}/${d.getMonth() + 1}`;
  const hStr = horaStr(d);
  if (d.toDateString() === hoje.toDateString()) return `Hoje às ${hStr}`;
  if (d.toDateString() === amanha.toDateString()) return `Amanhã às ${hStr}`;
  const dias = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  return `${dias[d.getDay()]} ${dStr} às ${hStr}`;
}

function calcularHorarioRelativo(texto) {
  const t = (texto || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const minMatch = t.match(/daqui\s+(\d+)\s*(min|minuto|minutos)/);
  if (minMatch) { const d = nowBRT(); d.setMinutes(d.getMinutes() + parseInt(minMatch[1])); return d; }
  const hrMatch = t.match(/daqui\s+(\d+)\s*(h|hora|horas)/);
  if (hrMatch) { const d = nowBRT(); d.setHours(d.getHours() + parseInt(hrMatch[1])); return d; }
  const emMinMatch = t.match(/em\s+(\d+)\s*(min|minuto|minutos)/);
  if (emMinMatch) { const d = nowBRT(); d.setMinutes(d.getMinutes() + parseInt(emMinMatch[1])); return d; }
  const emHrMatch = t.match(/em\s+(\d+)\s*(h|hora|horas)/);
  if (emHrMatch) { const d = nowBRT(); d.setHours(d.getHours() + parseInt(emHrMatch[1])); return d; }
  return null;
}

async function getModoAtual(userId) {
  const mems = await memory.getRecentMemories(userId, 10);
  return mems.find(m => m.type === 'modo_atual')?.content || null;
}

function normalizar(text) {
  return (text || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

async function enviarMenu(phone) {
  return sendButtons(phone, MENU, MENU_BUTTONS);
}

// Executa ação de lista de forma síncrona e retorna dados para o contexto
async function executeListaAction(user, phone, classified) {
  try {
    const tipo = classified.tipo;

    // lista_compras com itens → cria lista nova
    if ((tipo === 'lista_compras') && classified.itens && classified.itens.length > 0) {
      const itemsJson = classified.itens.map((nome, i) => ({ id: i + 1, nome, done: false }));
      const lista = await prisma.groceryList.create({
        data: {
          userId: user.id,
          name: classified.nome || '🛒 Lista de compras',
          items: JSON.stringify(itemsJson),
          done: false,
        }
      });
      await memory.saveMemory(user.id, 'ultima_lista', lista.id);
      console.log(`[${phone}] Lista criada: ${lista.name} com ${itemsJson.length} itens`);
      return { acao: 'criada', listaNome: lista.name, listaItems: itemsJson };
    }

    // lista_buscar ou lista_compras sem itens → busca lista existente
    if (tipo === 'lista_buscar' || (tipo === 'lista_compras' && (!classified.itens || classified.itens.length === 0))) {
      const mems = await memory.getRecentMemories(user.id, 20);
      const listaRef = mems.find(m => m.type === 'ultima_lista');
      if (listaRef) {
        const lista = await prisma.groceryList.findUnique({ where: { id: listaRef.content } });
        if (lista && !lista.done) {
          let items = []; try { items = JSON.parse(lista.items); } catch {}
          return { acao: 'encontrada', listaNome: lista.name, listaItems: items };
        }
      }
      // Fallback: lista ativa mais recente
      const listaRecente = await prisma.groceryList.findFirst({
        where: { userId: user.id, done: false },
        orderBy: { createdAt: 'desc' }
      });
      if (listaRecente) {
        let items = []; try { items = JSON.parse(listaRecente.items); } catch {}
        await memory.saveMemory(user.id, 'ultima_lista', listaRecente.id);
        return { acao: 'encontrada', listaNome: listaRecente.name, listaItems: items };
      }
      return { acao: 'nenhuma', listaNome: null, listaItems: [] };
    }

    // lista_marcar
    if (tipo === 'lista_marcar' && classified.numeros && classified.numeros.length > 0) {
      const mems = await memory.getRecentMemories(user.id, 20);
      const listaRef = mems.find(m => m.type === 'ultima_lista');
      if (listaRef) {
        const lista = await prisma.groceryList.findUnique({ where: { id: listaRef.content } });
        if (lista) {
          let items = []; try { items = JSON.parse(lista.items); } catch {}
          items = items.map(i => classified.numeros.includes(i.id) ? { ...i, done: true } : i);
          const allDone = items.every(i => i.done);
          await prisma.groceryList.update({
            where: { id: lista.id },
            data: { items: JSON.stringify(items), done: allDone }
          });
          return { acao: 'marcada', listaNome: lista.name, listaItems: items, allDone };
        }
      }
      return null;
    }

    // lista_adicionar
    if (tipo === 'lista_adicionar' && classified.item) {
      const mems2 = await memory.getRecentMemories(user.id, 20);
      const listaRef2 = mems2.find(m => m.type === 'ultima_lista');
      if (listaRef2) {
        const lista2 = await prisma.groceryList.findUnique({ where: { id: listaRef2.content } });
        if (lista2) {
          let items2 = []; try { items2 = JSON.parse(lista2.items); } catch {}
          const newId = items2.length > 0 ? Math.max(...items2.map(i => i.id)) + 1 : 1;
          items2.push({ id: newId, nome: classified.item, done: false });
          await prisma.groceryList.update({
            where: { id: lista2.id },
            data: { items: JSON.stringify(items2) }
          });
          return { acao: 'adicionado', listaNome: lista2.name, listaItems: items2, itemAdicionado: classified.item };
        }
      }
      return null;
    }

    return null;
  } catch (e) {
    console.error(`[${phone}] Erro executeListaAction:`, e.message);
    return null;
  }
}

// Monta texto da lista para enviar no WhatsApp
function formatarListaWhatsApp(listaResult) {
  if (!listaResult || !listaResult.listaItems) return '';
  const { listaNome, listaItems } = listaResult;
  const itens = listaItems.map(i => `${i.done ? '✅' : '⬜'} ${i.id}. ${i.nome}`).join('\n');
  const done = listaItems.filter(i => i.done).length;
  return `🛒 *${listaNome}*\n\n${itens}\n\n_${done}/${listaItems.length} itens marcados_`;
}

async function responderLivre(user, phone, text, contextoExtra = '', skipContext = false) {
  try {
    const history = await memory.getConversationHistory(user.id, 10);
    const preferences = await memory.getUserPreference(user.id);

    // Saudações simples: responde direto sem buscar contexto (mais rápido)
    if (skipContext) {
      preferences._contexto = '';
      const resp = await freeResponse(text, history, preferences);
      await memory.saveConversationMessage(user.id, 'user', text);
      await memory.saveConversationMessage(user.id, 'assistant', resp);
      await sendMessage(phone, resp);
      return;
    }

    let contexto = '';
    try {
      const now = nowBRT();
      const pad = n => String(n).padStart(2,'0');
      const hm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
      const toDateStr = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
      const hoje = toDateStr(now);
      const amanha = new Date(now); amanha.setDate(amanha.getDate()+1);
      const amanhaStr = toDateStr(amanha);
      const inicioHoje = new Date(`${hoje}T00:00:00-03:00`);
      const fimAmanha = new Date(`${amanhaStr}T23:59:59-03:00`);
      const inicioMes = new Date(now.getFullYear(), now.getMonth(), 1);

      const [lembretes, meds, gastos, perfilPessoal] = await Promise.all([
        prisma.reminder.findMany({
          where: { userId: user.id, sent: false, confirmed: false, scheduledAt: { gte: inicioHoje, lte: fimAmanha } },
          orderBy: { scheduledAt: 'asc' }, take: 20
        }),
        prisma.medication.findMany({ where: { userId: user.id, active: true, remaining: { gt: 0 } } }),
        preferences.saldo != null ? prisma.expense.findMany({ where: { userId: user.id, createdAt: { gte: inicioMes } } }) : Promise.resolve([]),
        buildPersonalContext(user.id).catch(() => '')
      ]);

      if (lembretes.length > 0) {
        const fmtLemb = (r) => {
          const d = new Date(r.scheduledAt);
          const dStr = toDateStr(d) === hoje ? 'Hoje' : 'Amanhã';
          const horaBRT = d.toLocaleTimeString('pt-BR', {timeZone:'America/Sao_Paulo', hour:'2-digit', minute:'2-digit'});
          return `• ${dStr} às ${horaBRT} — ${r.message}`;
        };
        contexto += `\n\n[AGENDA]\n${lembretes.map(fmtLemb).join('\n')}`;
      } else {
        contexto += `\n\n[AGENDA]\nNenhum lembrete para hoje ou amanhã.`;
      }

      // Injetar contatos quando usuário menciona envio ou contatos
      try {
        const textLower = (text||'').toLowerCase();
        if (/envi|mand|recado|contato|mostr|lista/.test(textLower)) {
          const contatos = await getContacts(user.id);
          if (contatos.length > 0) {
            const listaCtx = contatos.map((c,i) => `${i+1}. ${c.name}${c.relation?` (${c.relation})`:''} — ${c.phone}`).join('\n');
            contexto += `\n\n[CONTATOS SALVOS]\n${listaCtx}`;
          }
        }
      } catch(e) {}

      if (meds.length > 0) {
        const fmtMed = (m) => {
          let times = []; try { times = JSON.parse(m.times || '[]'); } catch {}
          const proxima = times.find(t => t >= hm) || times[0] || '—';
          const quando = times.find(t => t >= hm) ? 'hoje' : 'amanhã';
          return `• ${m.name} — próxima dose: ${proxima} (${quando}), ${m.remaining} doses restantes`;
        };
        contexto += `\n\n[MEDICAMENTOS]\n${meds.map(fmtMed).join('\n')}`;
      }

      if (preferences.saldo != null) {
        const totalGasto = gastos.reduce((a, g) => a + g.value, 0);
        const restante = preferences.saldo - totalGasto;
        contexto += `\n\n[FINANCEIRO]\nOrçamento mensal: R$ ${preferences.saldo.toFixed(2)}\nGasto este mês: R$ ${totalGasto.toFixed(2)}\nSaldo restante: R$ ${restante.toFixed(2)}`;
      }

      if (contexto) contexto = `\n\nUse as informações abaixo para responder com precisão:${contexto}`;

      // Perfil pessoal já foi carregado em paralelo no Promise.all acima
      if (perfilPessoal) contexto += perfilPessoal;

      if (contextoExtra) contexto += contextoExtra;

      preferences._contexto = contexto;
    } catch (e) {
      console.error(`[${phone}] Erro contexto:`, e.message);
    }

    console.log(`[${phone}] Chamando freeResponse...`);
    const resp = await freeResponse(text, history, preferences);
    console.log(`[${phone}] Resposta gerada: ${String(resp).slice(0, 80)}`);
    await memory.saveConversationMessage(user.id, 'user', text);
    await memory.saveConversationMessage(user.id, 'assistant', resp);
    await sendMessage(phone, resp);
  } catch (e) {
    console.error(`[${phone}] Erro responderLivre:`, e.message);
    await sendMessage(phone, 'Ops, tive um probleminha. Pode repetir?');
  }
}

async function handleMessage(phone, text, location = null) {
  try {
    const user = await memory.getOrCreateUser(phone);

    if (location && location.latitude) {
      await memory.saveMemory(user.id, 'localizacao',
        JSON.stringify({ latitude: location.latitude, longitude: location.longitude, updatedAt: new Date().toISOString() })
      );
      return await sendMessage(phone, '✅ Localização recebida! Agora posso te ajudar melhor com clima, farmácias e lojas próximas.');
    }

    if (!text) return;

    const textLower = normalizar(text);

    // Verifica se há confirmação pendente de envio de mensagem
    const foiConfirmacao = await checkConfirmacaoPendente(user, phone, text);
    if (foiConfirmacao) return;

    if (['menu', 'inicio', 'voltar', 'comeco', 'ajuda', 'opcoes'].includes(textLower)) {
      await memory.saveMemory(user.id, 'modo_atual', '');
      return await enviarMenu(phone);
    }

    if (['ver lembretes', 'ver_lembretes'].includes(textLower)) return await listarLembretes(user, phone);
    if (['ver anotacoes', 'ver_anotacoes'].includes(textLower)) return await listarAnotacoes(user, phone);
    if (['ver gastos', 'ver_gastos', 'resumo_mes'].includes(textLower)) return await listarGastos(user, phone);
    if (['ver horas hoje', 'ver_horas_hoje'].includes(textLower)) return await listarPontoHoje(user, phone);
    if (['ver medicamentos', 'ver_medicamentos'].includes(textLower)) return await listarMedicamentos(user, phone);

    const modoMap = {
      'lembretes': 'lembrete', 'lembrete': 'lembrete',
      'criar_lembrete': 'lembrete', 'novo_lembrete': 'lembrete',
      'anotacoes': 'anotacao', 'anotacao': 'anotacao', 'nova_anotacao': 'anotacao',
      'gastos': 'gasto', 'gasto': 'gasto', 'novo_gasto': 'gasto', 'resumo_mes': 'gasto',
      'saude': 'saude', 'novo_remedio': 'saude',
      'ponto digital': 'ponto', 'ponto': 'ponto',
      'bater_ponto': 'ponto', 'ver_horas_hoje': 'ponto',
      'pesquisar algo': 'pesquisar', 'pesquisar': 'pesquisar', 'pesquisa': 'pesquisar',
      'conversar': 'conversar', 'bater papo': 'conversar',
    };

    if (modoMap[textLower]) {
      const modo = modoMap[textLower];
      await memory.saveMemory(user.id, 'modo_atual', modo);
      return await sendMessage(phone, BOAS_VINDAS_MODO[modo]);
    }

    const modoAtual = await getModoAtual(user.id);

    if (modoAtual === 'anotacao') {
      await memory.saveMemory(user.id, 'anotacao', text, { titulo: text.substring(0, 50) });
      return await sendButtons(phone,
        `📝 *Anotação salva!*\n\n_"${text}"_\n\nGuardei isso aqui com segurança 💜`,
        [{ id: 'ver_anotacoes', label: '📋 Ver anotações' }, { id: 'menu', label: '🏠 Menu' }]
      );
    }

    if (modoAtual === 'conversar') {
      return await responderLivre(user, phone, text);
    }

    // ── Classificar primeiro ──
    const classified = await classify(text);
    console.log(`[${phone}] Tipo: ${classified.tipo}`);

    // ── Para listas: executar ANTES de gerar resposta ──
    if (LISTA_TIPOS.includes(classified.tipo)) {
      const listaResult = await executeListaAction(user, phone, classified);

      let contextoExtra = '';
      if (listaResult) {
        const { acao, listaNome, listaItems, allDone, itemAdicionado } = listaResult;

        if (acao === 'criada') {
          const itensTexto = listaItems.map(i => i.nome).join(', ');
          contextoExtra = `\n\n[AÇÃO REALIZADA] Acabei de criar a lista "${listaNome}" com os itens: ${itensTexto}. Confirme ao usuário de forma animada que a lista foi criada. Não liste os itens na resposta pois eles já aparecem separadamente.`;
        } else if (acao === 'encontrada') {
          const itensTexto = listaItems.map(i => `${i.done ? '✅' : '⬜'} ${i.nome}`).join(', ');
          contextoExtra = `\n\n[LISTA ENCONTRADA] Encontrei a lista "${listaNome}" com: ${itensTexto}. Apresente-a de forma natural. Não liste os itens pois eles já aparecem separadamente abaixo da sua mensagem.`;
        } else if (acao === 'nenhuma') {
          contextoExtra = `\n\n[SEM LISTA] O usuário não tem nenhuma lista ativa no momento. Informe isso e ofereça criar uma nova.`;
        } else if (acao === 'marcada') {
          contextoExtra = `\n\n[AÇÃO REALIZADA] Marquei os itens solicitados na lista "${listaNome}".${allDone ? ' Todos os itens foram concluídos! 🎉' : ''} Confirme ao usuário.`;
        } else if (acao === 'adicionado') {
          contextoExtra = `\n\n[AÇÃO REALIZADA] Adicionei "${itemAdicionado}" à lista "${listaNome}". Confirme ao usuário.`;
        }

        // Enviar resposta de texto com contexto correto
        await responderLivre(user, phone, text, contextoExtra);

        // Enviar a lista formatada no WhatsApp (se encontrada ou criada)
        if ((acao === 'criada' || acao === 'encontrada' || acao === 'adicionado' || acao === 'marcada') && listaItems.length > 0) {
          const listaTexto = formatarListaWhatsApp(listaResult);
          await sendMessage(phone, listaTexto);
        }
      } else {
        // Nenhuma lista encontrada/criada — responde normalmente
        contextoExtra = `\n\n[SEM LISTA] Não foi possível encontrar ou criar a lista. Informe ao usuário e ofereça ajuda.`;
        await responderLivre(user, phone, text, contextoExtra);
      }

      // Extração de memória pessoal em background (mesmo para msgs de lista)
      extractAndSavePersonalInfo(user.id, text).catch(e =>
        console.error('[extract pessoal lista] erro:', e.message)
      );

      return;
    }

    // ── Contatos: salvar ou enviar mensagem ──
    if (CONTATO_TIPOS.includes(classified.tipo)) {
      await handleContatoAction(user, phone, classified);
      extractAndSavePersonalInfo(user.id, text).catch(() => {});
      return;
    }

    // ── Demais ações: executar em background ──
    executeAction(user, phone, classified, text).catch(e =>
      console.error('Erro executeAction:', e.message)
    );

    // Saudações simples: pular busca de contexto para resposta mais rápida
    const isSaudacao = classified.tipo === 'saudacao';
    await responderLivre(user, phone, text, '', isSaudacao);

    // ── Extração de memória pessoal em background ──
    extractAndSavePersonalInfo(user.id, text).catch(e =>
      console.error('[extract pessoal] erro:', e.message)
    );
  } catch (error) {
    console.error('Erro handleMessage:', error.message);
    await sendMessage(phone, 'Ops, tive um probleminha. Pode repetir?');
  }
}

async function getCidadeUsuario(userId) {
  const mems = await memory.getRecentMemories(userId, 50);
  return mems.find(m => m.type === 'cidade')?.content || null;
}

function convertToDateWithTime(horaStr) {
  const [hora, min] = horaStr.split(':').map(Number);
  const date = nowBRT();
  date.setHours(hora, min || 0, 0, 0);
  return date;
}

async function gerarResumoDoBanco(pontos, userId) {
  const get = (tipo) => pontos.find(p => p.type === tipo);
  const entrada     = get('entrada');
  const saidaAlmoco = get('saida_almoco');
  const voltaAlmoco = get('volta_almoco');
  const saida       = get('saida');
  const jornada = await memory.getJornada(userId);

  let tempoManha = null, tempoTarde = null, totalTrabalhado = null, horasExtras = null;

  if (entrada && saidaAlmoco) tempoManha = (new Date(saidaAlmoco.timestamp) - new Date(entrada.timestamp)) / 60000;
  if (voltaAlmoco && saida) tempoTarde = (new Date(saida.timestamp) - new Date(voltaAlmoco.timestamp)) / 60000;
  if (tempoManha !== null && tempoTarde !== null) {
    totalTrabalhado = tempoManha + tempoTarde;
    horasExtras = totalTrabalhado - jornada;
  }

  let texto = entrada && !saida
    ? `📍 *Entrada registrada!*\n\n🕘 Você iniciou seu expediente às *${horaStr(entrada.timestamp)}*.\n\nTenha um ótimo trabalho hoje 💜\n\n`
    : `✨ *Resumo do seu dia*\n\n`;

  texto += `🟢 Entrada: *${horaStr(entrada?.timestamp)}*\n`;
  texto += `🍽️ Saída almoço: *${horaStr(saidaAlmoco?.timestamp)}*\n`;
  if (tempoManha !== null) texto += `⏱️ Manhã: *${minutesToHours(tempoManha)}*\n`;
  texto += `🔄 Volta almoço: *${horaStr(voltaAlmoco?.timestamp)}*\n`;
  if (saida) texto += `🔴 Saída: *${horaStr(saida.timestamp)}*\n`;
  if (tempoTarde !== null) texto += `⏱️ Tarde: *${minutesToHours(tempoTarde)}*\n`;

  if (totalTrabalhado !== null) {
    texto += `\n📊 Total: *${minutesToHours(totalTrabalhado)}*\n`;
    if (horasExtras > 0) texto += `⭐ Horas extras: *${minutesToHours(horasExtras)}*\n`;
    else if (horasExtras < 0) texto += `⚠️ Faltam: *${minutesToHours(Math.abs(horasExtras))}*\n`;
    else texto += `✅ Jornada completa!\n`;
  }

  if (!saida) texto += `\n💡 Me avisa quando sair!`;
  return texto;
}

async function listarLembretes(user, phone) {
  const agora = new Date();
  const reminders = await prisma.reminder.findMany({
    where: { userId: user.id, sent: false, confirmed: false, scheduledAt: { gte: agora } },
    orderBy: { scheduledAt: 'asc' },
    take: 10,
  });

  if (reminders.length === 0) {
    return await sendButtons(phone,
      `📋 *Seus lembretes*\n\nVocê não tem lembretes ativos no momento 😊`,
      [{ id: 'lembrete', label: '➕ Criar lembrete' }, { id: 'menu', label: '🏠 Menu' }]
    );
  }

  const numeros = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
  let texto = `📋 *Seus lembretes ativos*\n\n`;
  reminders.forEach((r, i) => {
    texto += `${numeros[i] || `${i+1}.`} 📌 ${r.message}\n`;
    texto += `    🗓️ ${formatarDataHoraBR(r.scheduledAt)}\n\n`;
  });
  texto += `_${reminders.length} lembrete${reminders.length > 1 ? 's' : ''} ativo${reminders.length > 1 ? 's' : ''}_ ✨`;

  await sendButtons(phone, texto, [
    { id: 'criar_lembrete', label: '➕ Criar lembrete' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function listarAnotacoes(user, phone) {
  const mems = await memory.getRecentMemories(user.id, 50);
  const anotacoes = mems.filter(m => m.type === 'anotacao').slice(0, 10);

  if (anotacoes.length === 0) {
    return await sendButtons(phone,
      `📝 *Suas anotações*\n\nVocê ainda não tem anotações salvas 😊`,
      [{ id: 'anotacao', label: '➕ Nova anotação' }, { id: 'menu', label: '🏠 Menu' }]
    );
  }

  let texto = `📝 *Suas anotações*\n\n`;
  anotacoes.forEach((a) => {
    texto += `📌 _"${a.content}"_\n`;
    texto += `🗓️ ${formatarDataBR(a.createdAt)}\n\n`;
  });
  texto += `_${anotacoes.length} anotaç${anotacoes.length > 1 ? 'ões' : 'ão'} salva${anotacoes.length > 1 ? 's' : ''}_ 💜`;

  await sendButtons(phone, texto, [
    { id: 'nova_anotacao', label: '➕ Nova anotação' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function listarGastos(user, phone) {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  const gastos = await prisma.expense.findMany({
    where: { userId: user.id, createdAt: { gte: start } },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  if (gastos.length === 0) {
    return await sendButtons(phone,
      `💰 *Seus gastos*\n\nNenhum gasto registrado este mês 😊`,
      [{ id: 'gasto', label: '➕ Registrar gasto' }, { id: 'menu', label: '🏠 Menu' }]
    );
  }

  const total = gastos.reduce((acc, g) => acc + g.value, 0);
  const categoriaIcon = { mercado: '🛒', restaurante: '🍽️', saude: '💊', transporte: '🚗', lazer: '🎉', outro: '📦' };

  let texto = `💰 *Gastos do mês*\n\n`;
  gastos.forEach((g) => {
    const icon = categoriaIcon[g.category] || '📦';
    texto += `${icon} *${g.category}* — R$ ${g.value.toFixed(2)}\n`;
    texto += `🗓️ ${formatarDataBR(g.createdAt)}\n\n`;
  });
  texto += `───────────────\n💵 *Total: R$ ${total.toFixed(2)}*`;

  await sendButtons(phone, texto, [
    { id: 'novo_gasto', label: '➕ Novo gasto' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function listarPontoHoje(user, phone) {
  const hoje = dateBRT();
  const pontos = await prisma.workLog.findMany({
    where: { userId: user.id, date: hoje },
    orderBy: { timestamp: 'asc' }
  });

  if (pontos.length === 0) {
    return await sendButtons(phone,
      `📍 *Ponto de hoje*\n\nNenhum registro de ponto hoje ainda 😊`,
      [{ id: 'ponto', label: '📍 Bater ponto' }, { id: 'menu', label: '🏠 Menu' }]
    );
  }

  const resumo = await gerarResumoDoBanco(pontos, user.id);
  await sendButtons(phone, resumo, [
    { id: 'bater_ponto', label: '📍 Bater ponto' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function listarMedicamentos(user, phone) {
  const meds = await prisma.medication.findMany({
    where: { userId: user.id, active: true },
    orderBy: { createdAt: 'desc' },
  });

  if (meds.length === 0) {
    return await sendButtons(phone,
      `💊 *Seus medicamentos*\n\nNenhum medicamento cadastrado ainda 😊`,
      [{ id: 'saude', label: '➕ Cadastrar remédio' }, { id: 'menu', label: '🏠 Menu' }]
    );
  }

  let texto = `💊 *Seus medicamentos ativos*\n\n`;
  meds.forEach((m) => {
    const horarios = JSON.parse(m.times || '[]').join(', ');
    texto += `💊 *${m.name}*\n`;
    texto += `⏰ ${horarios} — ${m.frequency}x por dia\n`;
    texto += `💊 Restam: ${m.remaining} comprimidos\n\n`;
  });

  await sendButtons(phone, texto, [
    { id: 'novo_remedio', label: '➕ Novo remédio' },
    { id: 'menu', label: '🏠 Menu' },
  ]);
}

async function executeAction(user, phone, classified, originalText) {
  switch (classified.tipo) {
    case 'ponto_multiplo':
      await salvarPontoSilencioso(user, classified.acoes);
      break;
    case 'cidade':
      await memory.saveMemory(user.id, 'cidade', classified.cidade);
      break;
    case 'anotacao':
      await memory.saveMemory(user.id, 'anotacao', classified.conteudo || classified.titulo || originalText, { titulo: classified.titulo });
      break;
    case 'tarefa':
      await salvarTarefaSilenciosa(user, phone, classified, originalText);
      break;
    case 'editar_lembrete':
      await editarLembrete(user, phone, classified);
      contextoExtra = `\n\n[AÇÃO REALIZADA] Lembrete "${classified.titulo}" foi reagendado${classified.nova_hora ? ` para às ${classified.nova_hora}` : ''}${classified.nova_data ? ` em ${classified.nova_data}` : ''}. Confirme ao usuário de forma natural.`;
      break;
    case 'deletar_lembrete':
      await deletarLembretePorTitulo(user, phone, classified);
      contextoExtra = `\n\n[AÇÃO REALIZADA] Lembrete "${classified.titulo}" foi cancelado/deletado. Confirme ao usuário de forma natural.`;
      break;
    case 'deletar_remedio':
      if (classified.nome) {
        const nomeRemedio = classified.nome.toLowerCase();
        const remedios = await prisma.medication.findMany({ where: { userId: user.id } });
        const encontrados = remedios.filter(m => m.name.toLowerCase().includes(nomeRemedio) || nomeRemedio.includes(m.name.toLowerCase().split(' ')[0]));
        if (encontrados.length > 0) {
          await prisma.medication.deleteMany({ where: { id: { in: encontrados.map(m => m.id) } } });
          contextoExtra = `\n\n[AÇÃO REALIZADA] Medicamento "${encontrados[0].name}" foi excluído com sucesso. Confirme ao usuário de forma natural e diga que não receberá mais lembretes desse remédio.`;
        } else {
          contextoExtra = `\n\n[AÇÃO] Não foi encontrado nenhum medicamento com o nome "${classified.nome}". Informe o usuário que não encontrou esse remédio cadastrado.`;
        }
      }
      break;
    case 'gasto':
      await memory.saveExpense(user.id, {
        valor: classified.valor,
        categoria: classified.categoria || 'outro',
        descricao: classified.descricao || classified.categoria,
      });
      break;
    case 'medicamento':
      if (classified.nome) {
        await memory.saveMedication(user.id, {
          nome: classified.nome,
          quantidade: classified.quantidade || 0,
          frequencia: classified.frequencia || 1,
          horarios: classified.horarios || ['08:00'],
        });
      }
      break;
    case 'preferencia':
      await memory.saveUserPreference(user.id, classified.nome, classified.tom, null);
      break;
    case 'concluir_lembrete': {
      if (classified.titulo) {
        const lembretes = await prisma.reminder.findMany({
          where: { userId: user.id, confirmed: false, sent: false },
          orderBy: { scheduledAt: 'asc' }
        });
        const titulo = classified.titulo.toLowerCase();
        const match = lembretes.find(r =>
          r.message.toLowerCase().includes(titulo) ||
          titulo.includes(r.message.toLowerCase().substring(0, 10))
        ) || lembretes[0];
        if (match) {
          await prisma.reminder.update({
            where: { id: match.id },
            data: { confirmed: true, sent: true }
          });
          console.log(`[${phone}] Lembrete concluído: "${match.message}"`);
        }
      }
      break;
    }

    case 'saldo':
      if (classified.valor !== undefined && classified.valor !== null) {
        await memory.saveUserPreference(user.id, null, null, parseFloat(classified.valor));
        console.log(`[${phone}] Saldo atualizado: R$ ${classified.valor}`);
      }
      break;
    // listas são tratadas em handleMessage via executeListaAction — não chegam aqui
  }
}

async function salvarPontoSilencioso(user, acoes) {
  const hoje = dateBRT();
  for (const acao of acoes) {
    let subtipo = (acao.subtipo || '').toLowerCase().trim();
    if (subtipo.includes('entrada') || subtipo.includes('cheg')) subtipo = 'entrada';
    else if (subtipo.includes('saida_almoco') || (subtipo.includes('almo') && subtipo.includes('sai'))) subtipo = 'saida_almoco';
    else if (subtipo.includes('volta_almoco') || (subtipo.includes('almo') && subtipo.includes('volt'))) subtipo = 'volta_almoco';
    else if (subtipo.includes('saida') || subtipo.includes('sai')) subtipo = 'saida';
    const timestamp = acao.hora ? convertToDateWithTime(acao.hora) : nowBRT();
    const existing = await prisma.workLog.findFirst({ where: { userId: user.id, type: subtipo, date: hoje } });
    if (existing) {
      await prisma.workLog.update({ where: { id: existing.id }, data: { timestamp } });
    } else {
      await prisma.workLog.create({ data: { userId: user.id, type: subtipo, timestamp, date: hoje } });
    }
  }
}

async function salvarTarefaSilenciosa(user, phone, classified, originalText) {
  await memory.saveMemory(user.id, 'tarefa', classified.titulo, { data: classified.data, hora: classified.hora });

  let scheduledAt = null;

  if (originalText) {
    const relativo = calcularHorarioRelativo(originalText);
    if (relativo) {
      scheduledAt = relativo;
      console.log(`[${phone}] Horário relativo calculado: ${scheduledAt}`);
    }
  }

  if (!scheduledAt && classified.hora) {
    const hoje = classified.data || dateBRT();
    const [h, m] = classified.hora.split(':').map(Number);
    scheduledAt = new Date(`${hoje}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00-03:00`);
    if (!classified.data && scheduledAt < nowBRT()) scheduledAt.setDate(scheduledAt.getDate() + 1);
  }

  if (scheduledAt) {
    // Lembrete principal
    await prisma.reminder.create({ data: { userId: user.id, phone, message: classified.titulo, scheduledAt } });
    console.log(`[${phone}] Lembrete salvo: "${classified.titulo}" para ${scheduledAt}`);

    // Lembrete de antecedência (ex: "me lembra 30min antes")
    const antecedencia = classified.antecedencia;
    if (antecedencia && antecedencia > 0) {
      const scheduledAntes = new Date(scheduledAt.getTime() - antecedencia * 60 * 1000);
      if (scheduledAntes > new Date()) {
        await prisma.reminder.create({ data: {
          userId: user.id, phone,
          message: `⏰ Em ${antecedencia} minutos: ${classified.titulo}`,
          scheduledAt: scheduledAntes
        }});
        console.log(`[${phone}] Lembrete antecipado criado: ${antecedencia}min antes`);
      }
    }
  }
}

// ── Editar lembrete existente ──
async function editarLembrete(user, phone, classified) {
  try {
    const titulo = classified.titulo?.toLowerCase();
    if (!titulo) { await sendMessage(phone, 'Qual lembrete quer alterar? Me diz o nome 😊'); return; }

    const lembretes = await prisma.reminder.findMany({
      where: { userId: user.id, sent: false, confirmed: false }
    });
    const encontrado = lembretes.find(r => r.message.toLowerCase().includes(titulo));

    if (!encontrado) {
      await sendMessage(phone, `Não encontrei nenhum lembrete com "${classified.titulo}" 😕`);
      return;
    }

    let novoScheduledAt = new Date(encontrado.scheduledAt);
    if (classified.nova_hora) {
      const [h, m] = classified.nova_hora.split(':').map(Number);
      const data = classified.nova_data || encontrado.scheduledAt.toISOString().split('T')[0];
      novoScheduledAt = new Date(`${data}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00-03:00`);
    } else if (classified.nova_data) {
      const horaAtual = new Date(encontrado.scheduledAt).toLocaleTimeString('pt-BR', {timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'});
      const [h, m] = horaAtual.split(':').map(Number);
      novoScheduledAt = new Date(`${classified.nova_data}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00-03:00`);
    }

    await prisma.reminder.update({ where: { id: encontrado.id }, data: { scheduledAt: novoScheduledAt } });
    const horaBRT = novoScheduledAt.toLocaleTimeString('pt-BR', {timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'});
    const dataBRT = novoScheduledAt.toLocaleDateString('pt-BR', {timeZone:'America/Sao_Paulo'});
    console.log(`[${phone}] Lembrete editado: "${encontrado.message}" → ${novoScheduledAt}`);
    // resposta virá pelo freeResponse com contexto da ação
  } catch(e) { console.error('[editarLembrete]', e.message); }
}

// ── Deletar lembrete por título ──
async function deletarLembretePorTitulo(user, phone, classified) {
  try {
    const titulo = classified.titulo?.toLowerCase();
    if (!titulo) { await sendMessage(phone, 'Qual lembrete quer cancelar? Me diz o nome 😊'); return; }

    const lembretes = await prisma.reminder.findMany({
      where: { userId: user.id, sent: false, confirmed: false }
    });
    const encontrados = lembretes.filter(r => r.message.toLowerCase().includes(titulo));

    if (!encontrados.length) {
      await sendMessage(phone, `Não encontrei nenhum lembrete com "${classified.titulo}" 😕`);
      return;
    }

    await prisma.reminder.deleteMany({ where: { id: { in: encontrados.map(r => r.id) } } });
    console.log(`[${phone}] ${encontrados.length} lembrete(s) deletado(s)`);
  } catch(e) { console.error('[deletarLembrete]', e.message); }
}


// ── Trata ações de contato (salvar, deletar e enviar mensagem) ──
async function handleContatoAction(user, phone, classified) {
  try {
    // ── Listar contatos ──
    if (classified.tipo === 'listar_contatos') {
      const contatos = await getContacts(user.id);
      if (!contatos.length) {
        await sendMessage(phone, 'Você ainda não tem contatos salvos. Me diz o número de alguém: "o número do João é 43999998888" 😊');
        return;
      }
      const lista = contatos.map((c, i) =>
        `${i+1}. *${c.name}*${c.relation ? ` (${c.relation})` : ''} — ${c.phone}`
      ).join('\n');
      await sendMessage(phone, `📋 *Seus contatos:*\n\n${lista}\n\nPode dizer "envia mensagem pro contato 2" ou "lembra o contato 1 de tal coisa" 😊`);
      // Salvar lista para uso posterior por número
      await prisma.memory.upsert({
        where: { userId_type: { userId: user.id, type: 'contatos_listados' } },
        update: { content: JSON.stringify(contatos) },
        create: { userId: user.id, type: 'contatos_listados', content: JSON.stringify(contatos) }
      }).catch(() => {});
      return;
    }

    if (classified.tipo === 'deletar_contato') {
      const nome = classified.nome;
      if (!nome) {
        await sendMessage(phone, 'Qual contato quer apagar? Me diz o nome 😊');
        return;
      }
      const encontrados = await findContactByName(user.id, nome);
      if (encontrados.length === 0) {
        await sendMessage(phone, `Não encontrei nenhum contato com o nome "${nome}" 😕`);
        return;
      }
      for (const c of encontrados) {
        await prisma.contact.delete({ where: { id: c.id } });
      }
      const nomes = encontrados.map(c => c.name).join(', ');
      await sendMessage(phone, `✅ Contato${encontrados.length > 1 ? 's' : ''} removido${encontrados.length > 1 ? 's' : ''}: *${nomes}* 🗑️`);
      console.log(`[Contato] Deletado(s): ${nomes}`);
      return;
    }

    if (classified.tipo === 'salvar_contato') {
      if (!classified.nome || !classified.phone) {
        await sendMessage(phone, 'Preciso do nome e do número para salvar o contato 😊');
        return;
      }
      await saveContact(user.id, {
        nome: classified.nome,
        phone: classified.phone,
        relation: classified.relation || null,
        notes: classified.notes || null,
      });
      const relTxt = classified.relation ? ` (${classified.relation})` : '';
      await sendMessage(phone, `✅ Contato salvo! ${classified.nome}${relTxt} 📱`);
      console.log(`[Contato] Salvo: ${classified.nome} → ${classified.phone}`);
      return;
    }

    if (classified.tipo === 'enviar_mensagem_agendada') {
      let destinatarioPhone = classified.phone || null;
      let destinatarioNome = classified.destinatario || null;

      if (!destinatarioPhone && destinatarioNome) {
        const encontrados = await findContactByName(user.id, destinatarioNome);
        if (encontrados.length === 0) {
          await sendMessage(phone, `Não encontrei nenhum contato com o nome "${destinatarioNome}" 😕\n\nMe diz o número e eu salvo: "o número do ${destinatarioNome} é 43999..."`);
          return;
        }
        if (encontrados.length > 1) {
          const lista = encontrados.map((c, i) => `${i+1}. ${c.name}${c.relation ? ` (${c.relation})` : ''} — ${c.phone}`).join('\n');
          await memory.saveMemory(user.id, 'confirmacao_pendente', JSON.stringify({
            tipo: 'selecao_contato',
            opcoes: encontrados.map(c => ({ nome: c.name, phone: c.phone, relation: c.relation })),
            mensagem: classified.mensagem || '',
            expira: Date.now() + 3 * 60 * 1000,
          }));
          await sendMessage(phone, `Encontrei mais de um contato:\n\n${lista}\n\nQual você quer? Responde com o número (1, 2...)`);
          return;
        }
        destinatarioPhone = encontrados[0].phone;
        destinatarioNome = encontrados[0].name;
      }

      if (!destinatarioPhone) {
        await sendMessage(phone, 'Para quem quer enviar? Me diz o nome ou número 😊');
        return;
      }

      let phoneClean = destinatarioPhone.replace(/\D/g, '');
      if (!phoneClean.startsWith('55') && phoneClean.length <= 11) phoneClean = '55' + phoneClean;

      const mensagem = classified.mensagem || '';
      if (!mensagem) {
        await sendMessage(phone, 'O que quer que eu escreva? 😊');
        return;
      }

      const nowBRT = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
      const now = nowBRT();
      let scheduledAt = null;

      if (classified.data && classified.hora) {
        scheduledAt = new Date(`${classified.data}T${classified.hora}:00-03:00`);
      } else if (classified.hora) {
        const [h, m] = classified.hora.split(':').map(Number);
        scheduledAt = new Date(now);
        scheduledAt.setHours(h, m || 0, 0, 0);
        if (scheduledAt <= now) scheduledAt.setDate(scheduledAt.getDate() + 1);
      } else if (classified.quando) {
        const quando = classified.quando.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        if (quando.includes('amanha')) {
          scheduledAt = new Date(now);
          scheduledAt.setDate(scheduledAt.getDate() + 1);
          scheduledAt.setHours(9, 0, 0, 0);
        } else {
          const diasSemana = { 'segunda':1,'terca':2,'quarta':3,'quinta':4,'sexta':5,'sabado':6,'domingo':0 };
          for (const [nome, dia] of Object.entries(diasSemana)) {
            if (quando.includes(nome)) {
              scheduledAt = new Date(now);
              const diff = (dia - now.getDay() + 7) % 7 || 7;
              scheduledAt.setDate(scheduledAt.getDate() + diff);
              scheduledAt.setHours(9, 0, 0, 0);
              break;
            }
          }
        }
      }

      if (!scheduledAt || scheduledAt <= new Date()) {
        await sendMessage(phone, 'Não entendi quando quer enviar 😕 Me diz a hora certa, ex: "amanhã às 10h"');
        return;
      }

      // Pedir confirmação antes de agendar
      const horaPrev = scheduledAt.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
      const dataPrev = scheduledAt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: 'numeric', month: 'long' });

      await memory.saveMemory(user.id, 'confirmacao_pendente', JSON.stringify({
        tipo: 'mensagem_agendada',
        toPhone: phoneClean,
        toName: destinatarioNome,
        mensagem,
        scheduledAt: scheduledAt.toISOString(),
        expira: Date.now() + 2 * 60 * 1000,
      }));

      await sendMessage(phone, `📤 Vou enviar para *${destinatarioNome}*:

_"${mensagem}"_

📅 ${dataPrev} às ${horaPrev}

Confirma? (sim/não)`);
      return;

      // unreachable — mantido para referência
      if (destinatarioNome && classified.phone) {
        await saveContact(user.id, { nome: destinatarioNome, phone: phoneClean }).catch(() => {});
      }

      const horaBRT = scheduledAt.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
      const dataBRT = scheduledAt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: 'numeric', month: 'long' });
      await sendMessage(phone, `✅ Agendado!\n\nVou enviar para *${destinatarioNome || phoneClean}* ${dataBRT} às ${horaBRT}:\n\n_"${mensagem}"_`);
      console.log(`[Msg Agendada] ${destinatarioNome} (${phoneClean}) → ${scheduledAt}`);
      return;
    }

    if (classified.tipo === 'enviar_mensagem') {
      let destinatarioPhone = classified.phone || null;
      let destinatarioNome = classified.destinatario || null;

      // Suporte a contato por número da lista ("envia pro contato 2")
      if (classified.contato_numero) {
        try {
          const mem = await prisma.memory.findFirst({ where: { userId: user.id, type: 'contatos_listados' } });
          if (mem) {
            const lista = JSON.parse(mem.content);
            const c = lista[classified.contato_numero - 1];
            if (c) { destinatarioNome = c.name; destinatarioPhone = c.phone; }
          }
        } catch(e) {}
      }

      if (!destinatarioPhone && destinatarioNome) {
        const encontrados = await findContactByName(user.id, destinatarioNome);
        if (encontrados.length === 0) {
          await sendMessage(phone, `Não encontrei nenhum contato com o nome "${destinatarioNome}" 😕\n\nMe diz o número dele e eu salvo: "o número do ${destinatarioNome} é 43999..."`);
          return;
        }
        if (encontrados.length > 1) {
          const lista = encontrados.map((c, i) => `${i+1}. ${c.name}${c.relation ? ` (${c.relation})` : ''} — ${c.phone}`).join('\n');
          await memory.saveMemory(user.id, 'confirmacao_pendente', JSON.stringify({
            tipo: 'selecao_contato',
            opcoes: encontrados.map(c => ({ nome: c.name, phone: c.phone, relation: c.relation })),
            mensagem: classified.mensagem || '',
            expira: Date.now() + 3 * 60 * 1000,
          }));
          await sendMessage(phone, `Encontrei mais de um contato:\n\n${lista}\n\nQual você quer? Responde com o número (1, 2...)`);
          return;
        }
        destinatarioPhone = encontrados[0].phone;
        destinatarioNome = encontrados[0].name;
      }

      if (!destinatarioPhone) {
        await sendMessage(phone, 'Para quem quer enviar? Me diz o nome ou número 😊');
        return;
      }

      let phoneClean = destinatarioPhone.replace(/\D/g, '');
      if (!phoneClean.startsWith('55') && phoneClean.length <= 11) phoneClean = '55' + phoneClean;

      if (destinatarioNome && classified.phone) {
        await saveContact(user.id, { nome: destinatarioNome, phone: phoneClean }).catch(() => {});
        console.log(`[Contato] Auto-salvo: ${destinatarioNome} → ${phoneClean}`);
      }

      const mensagem = classified.mensagem || '';
      if (!mensagem) {
        await sendMessage(phone, 'O que quer que eu escreva na mensagem? 😊');
        return;
      }

      const preview = `📤 Vou enviar para *${destinatarioNome || phoneClean}*:\n\n_"${mensagem}"_\n\nConfirma? (sim/não)`;

      await memory.saveMemory(user.id, 'confirmacao_pendente', JSON.stringify({
        tipo: 'enviar_mensagem',
        destinatarioPhone: phoneClean,
        destinatarioNome: destinatarioNome || phoneClean,
        mensagem,
        expira: Date.now() + 2 * 60 * 1000,
      }));

      await sendMessage(phone, preview);
      console.log(`[Contato] Aguardando confirmação para enviar a ${destinatarioNome || phoneClean}`);
      return;
    }
  } catch (e) {
    console.error('[handleContatoAction] Erro:', e.message);
    await sendMessage(phone, 'Ops, tive um problema com isso. Pode tentar de novo?');
  }
}

// ── Verifica e processa confirmação pendente de envio de mensagem ──
async function checkConfirmacaoPendente(user, phone, text) {
  try {
    const mems = await memory.getRecentMemories(user.id, 10);
    const pendente = mems.find(m => m.type === 'confirmacao_pendente');
    if (!pendente) return false;

    let dados;
    try { dados = JSON.parse(pendente.content); } catch { return false; }

    // Verifica se expirou
    if (Date.now() > dados.expira) {
      await prisma.memory.delete({ where: { id: pendente.id } });
      return false;
    }

    const textNorm = text.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

    // Seleção de contato quando há múltiplos resultados
    if (dados.tipo === 'selecao_contato') {
      const num = parseInt(textNorm);
      if (!isNaN(num) && num >= 1 && num <= dados.opcoes.length) {
        const escolhido = dados.opcoes[num - 1];
        await prisma.memory.delete({ where: { id: pendente.id } });

        // Agora trata como envio normal — pede confirmação da mensagem
        let phoneClean = escolhido.phone.replace(/\D/g, '');
        if (!phoneClean.startsWith('55') && phoneClean.length <= 11) phoneClean = '55' + phoneClean;

        if (dados.mensagem) {
          const preview = `📤 Vou enviar para *${escolhido.nome}*:\n\n_"${dados.mensagem}"_\n\nConfirma? (sim/não)`;
          await memory.saveMemory(user.id, 'confirmacao_pendente', JSON.stringify({
            tipo: 'enviar_mensagem',
            destinatarioPhone: phoneClean,
            destinatarioNome: escolhido.nome,
            mensagem: dados.mensagem,
            expira: Date.now() + 2 * 60 * 1000,
          }));
          await sendMessage(phone, preview);
        } else {
          await sendMessage(phone, `Ok! ${escolhido.nome} selecionado. O que quer enviar para ele(a)?`);
        }
        return true;
      }
      // Resposta inválida — manter pendente
      if (!isNaN(num)) {
        await sendMessage(phone, `Número inválido. Escolha entre 1 e ${dados.opcoes.length}.`);
        return true;
      }
      // Se digitou algo que não é número, cancela
      if (['nao','n','não','cancelar','cancela'].includes(textNorm)) {
        await prisma.memory.delete({ where: { id: pendente.id } });
        await sendMessage(phone, 'Ok, cancelei 😊');
        return true;
      }
      return false;
    }

    if (['sim','s','ok','confirma','envia','manda','pode','yes'].includes(textNorm)) {
      // Envia a mensagem
      // Busca nome do remetente para personalizar a mensagem
      const remetente = await memory.getUserPreference(user.id);
      const nomeRemetente = remetente.name || 'seu contato';
      const foneFormatado = phone.replace('55', '').replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
      const msgFormatada = `Oi! Sou a Clara, assistente inteligente do ${nomeRemetente}.\n\n📌 Passando um lembrete:\n\n${dados.mensagem}\n\nNão precisa me responder! Se precisar de algo, é só chamar no WhatsApp: ${foneFormatado} 😊`;

      await sendMessage(dados.destinatarioPhone, msgFormatada);
      await prisma.memory.delete({ where: { id: pendente.id } });
      await sendMessage(phone, `✅ Mensagem enviada para *${dados.destinatarioNome}*! 📤`);
      console.log(`[Contato] Mensagem enviada para ${dados.destinatarioPhone}`);
      return true;
    }

    if (['nao','n','não','cancelar','cancela','para'].includes(textNorm)) {
      await prisma.memory.delete({ where: { id: pendente.id } });
      await sendMessage(phone, 'Ok, cancelei o envio 😊');
      return true;
    }

    return false;
  } catch (e) {
    console.error('[checkConfirmacaoPendente] Erro:', e.message);
    return false;
  }
}

// ── Extrai e salva informações pessoais da mensagem do usuário ──
async function extractAndSavePersonalInfo(userId, text) {
  const infos = await extractPersonalInfo(text);
  if (!infos || infos.length === 0) return;
  for (const { chave, valor, categoria } of infos) {
    if (!chave || !valor) continue;
    await savePersonalInfo(userId, chave, valor, categoria || 'outro');
    console.log(`[memória pessoal] salvo: ${chave} = "${valor}" (${categoria})`);
  }
}

module.exports = { handleMessage };
