const { classify, searchWeb, freeResponse, generateMemorySummary } = require('./groq');
const { sendMessage, sendReminderWithButtons } = require('./whatsapp');
const memory = require('./memory');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// ====================== MENU ======================
const MENU = `✨ *Clara online* 💜

Posso te ajudar com praticamente tudo do dia a dia 😊

🔔 Lembretes e tarefas
📝 Anotações rápidas
💰 Controle de gastos
💊 Medicamentos e bem-estar
📍 Registro de ponto e horas trabalhadas
🌦️ Clima, pesquisas e informações
💬 E até bater papo quando quiser

Pode falar comigo naturalmente, como se estivesse conversando com uma amiga ✨

Exemplos:
• _"Me lembra de tomar remédio às 22h"_
• _"Cheguei às 9 horas no trabalho"_
• _"Vai chover amanhã?"_
• _"Horóscopo de Libra"_
• _"Anota um gasto de 42 reais"_
• _"Senha do Wi-Fi"_

Tô por aqui 💜`;

const MENU_FOOTER = '\n\n_Digite *menu* para voltar ao início 🏠_';

const BOAS_VINDAS_MODO = {
 'lembrete':  `⏰ *Lembretes*\n\nPosso te lembrar de uma reunião, uma tarefa ou qualquer compromisso que desejar!\n\nExemplos:\n• _"Me lembra às 19h de buscar minha filha"_\n• _"Lembrete amanhã às 8h de tomar remédio"_\n• _"Me lembra sexta às 18h da reunião"_\n\n_É só me dizer!_ 😊`,
 'anotacao':  `📝 *Anotações*\n\nGuardo qualquer informação pra você consultar quando quiser!\n\nExemplos:\n• _"Senha do Wi-Fi: 12345"_\n• _"Código do cliente: ABC123"_\n• _"Endereço da minha médica"_\n• _"Senha do cartão: 9010"_\n\n_O que quer guardar?_ 😊`,
 'gasto':     `💰 *Gastos*\n\nRegistro tudo e te mostro um resumo certinho do mês!\n\nExemplos:\n• _"Gastei 45 reais no mercado"_\n• _"Paguei 120 no restaurante"_\n• _"Quanto gastei esse mês?"_\n\n_Me conta seu gasto!_ 💸`,
 'saude':     `💊 *Saúde*\n\nCuido dos seus remédios e te aviso na hora certinha!\n\nExemplos:\n• _"Tomo Losartana todo dia às 8h"_\n• _"Vitamina C às 9h e às 21h"_\n\n_Qual medicamento quer registrar?_ 😊`,
 'ponto':     `📍 *Ponto Digital*\n\nRegistro sua jornada e calculo horas extras!\n\nExemplos:\n• _"Entrei às 8:15"_\n• _"Saí pra almoçar às 12:30"_\n• _"Voltei do almoço às 14:10"_\n• _"Saí do trabalho às 18:05"_\n\nOu tudo de uma vez:\n_"Entrei 8h, saí almoçar 12h, voltei 13h, saí 17h"_\n\n_Pode me dizer!_ 📍`,
 'pesquisar': `🔍 *Pesquisar*\n\nBusco qualquer coisa pra você na internet!\n\n☀️ _"Como está o tempo hoje?"_\n🔮 _"Horóscopo de Áries"_\n📞 _"Telefone da farmácia mais próxima"_\n📍 _"Endereço do Detran"_\n💵 _"Preço do dólar hoje"_\n\n_O que quer pesquisar?_ ✨`,
 'conversar': `💬 *Conversar*\n\nAdoro uma boa conversa! Pode falar à vontade sobre qualquer assunto 😄\n\n_Pode começar!_ 🥰`,
};

// ====================== UTILITÁRIOS ======================
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

async function getModoAtual(userId) {
 const mems = await memory.getRecentMemories(userId, 10);
 return mems.find(m => m.type === 'modo_atual')?.content || null;
}

// ====================== HANDLER PRINCIPAL ======================
async function handleMessage(phone, text, location = null) {
 try {
   const user = await memory.getOrCreateUser(phone);

   if (location && location.latitude) {
     await memory.saveMemory(user.id, 'localizacao',
       JSON.stringify({ latitude: location.latitude, longitude: location.longitude, updatedAt: new Date().toISOString() })
     );
     return await sendMessage(phone, '✅ Localização recebida! Agora posso te ajudar melhor com clima, farmácias e lojas próximas.' + MENU_FOOTER);
   }

   if (!text) return;

   const textLower = text.trim().toLowerCase();

   // MENU
   if (['menu', 'início', 'inicio', 'voltar', 'começo'].includes(textLower)) {
     await memory.saveMemory(user.id, 'modo_atual', '');
     return await sendMessage(phone, MENU);
   }

   // ESCOLHA DO MODO POR PALAVRA-CHAVE
   const modoMap = {
     'lembretes': 'lembrete', 'lembrete': 'lembrete',
     'anotações': 'anotacao', 'anotacoes': 'anotacao', 'anotação': 'anotacao', 'anotacao': 'anotacao',
     'gastos': 'gasto', 'gasto': 'gasto',
     'saúde': 'saude', 'saude': 'saude',
     'ponto digital': 'ponto', 'ponto': 'ponto',
     'pesquisar algo': 'pesquisar', 'pesquisar': 'pesquisar', 'pesquisa': 'pesquisar',
     'conversar': 'conversar', 'bater papo': 'conversar',
   };

   if (modoMap[textLower]) {
     const modo = modoMap[textLower];
     await memory.saveMemory(user.id, 'modo_atual', modo);
     return await sendMessage(phone, BOAS_VINDAS_MODO[modo] + MENU_FOOTER);
   }

   // VERIFICA MODO ATUAL
   const modoAtual = await getModoAtual(user.id);

   // MODO ANOTAÇÃO → salva direto
   if (modoAtual === 'anotacao') {
     await memory.saveMemory(user.id, 'anotacao', text, { titulo: text.substring(0, 50) });
     return await sendMessage(phone, '📝 Anotado! Guardei aqui comigo com carinho. ✨' + MENU_FOOTER);
   }

   // MODO CONVERSAR → responde livremente
   if (modoAtual === 'conversar') {
     const resp = await freeResponse(text);
     return await sendMessage(phone, resp + MENU_FOOTER);
   }

   const classified = await classify(text);
   console.log(`[${phone}] Tipo: ${classified.tipo}`);

   switch (classified.tipo) {
     case 'ponto_multiplo':
       await handlePontoMultiplo(user, phone, classified.acoes, text);
       break;
     case 'cidade':
       await handleCidade(user, phone, classified.cidade);
       break;
     case 'busca':
       await handleBusca(user, phone, classified.query || text);
       break;
     case 'anotacao':
       await handleNote(user, phone, classified);
       break;
     case 'tarefa':
       await handleTask(user, phone, classified);
       break;
     case 'gasto':
       await handleExpense(user, phone, classified);
       break;
     case 'consulta':
       await handleQuery(user, phone, text);
       break;
     case 'saudacao':
       await handleSaudacao(user, phone);
       break;
     default:
       const resp = await freeResponse(text);
       await sendMessage(phone, resp + MENU_FOOTER);
   }
 } catch (error) {
   console.error('Erro handleMessage:', error.message);
   await sendMessage(phone, 'Ops, tive um probleminha. Pode repetir?');
 }
}

// ====================== SAUDAÇÃO ======================
async function handleSaudacao(user, phone) {
 const cidade = await getCidadeUsuario(user.id);
 await sendMessage(phone, MENU);
 if (!cidade) {
   setTimeout(async () => {
     await sendMessage(phone, '📍 _Dica: me diz sua cidade e vou buscar clima e locais pra você!_');
   }, 1500);
 }
}

async function getCidadeUsuario(userId) {
 const mems = await memory.getRecentMemories(userId, 50);
 return mems.find(m => m.type === 'cidade')?.content || null;
}

// ====================== CIDADE ======================
async function handleCidade(user, phone, cidade) {
 await memory.saveMemory(user.id, 'cidade', cidade);
 await sendMessage(phone, `Anotei! 📍 Vou usar *${cidade}* para buscas locais.` + MENU_FOOTER);
}

// ====================== PONTO MÚLTIPLO ======================
async function handlePontoMultiplo(user, phone, acoes, originalText) {
 await sendMessage(phone, '📍 Registrando seus pontos...');

 const hoje = dateBRT();

 for (const acao of acoes) {
   let subtipo = (acao.subtipo || '').toLowerCase().trim();

   if (subtipo === 'entrada' || subtipo.includes('cheg') || subtipo.includes('entrei')) {
     subtipo = 'entrada';
   } else if (subtipo === 'saida_almoco' || subtipo.includes('saida_almoco') ||
     (subtipo.includes('almo') && (subtipo.includes('sai') || subtipo.includes('saí')))) {
     subtipo = 'saida_almoco';
   } else if (subtipo === 'volta_almoco' || subtipo.includes('volta_almoco') ||
     (subtipo.includes('almo') && (subtipo.includes('volt') || subtipo.includes('retorn')))) {
     subtipo = 'volta_almoco';
   } else if (subtipo === 'saida' || subtipo.includes('saí') || subtipo.includes('sai') || subtipo.includes('saida')) {
     subtipo = 'saida';
   }

   const horaUsada = acao.hora || 'agora';
   const timestamp = horaUsada !== 'agora' ? convertToDateWithTime(horaUsada) : nowBRT();

   const existing = await prisma.workLog.findFirst({
     where: { userId: user.id, type: subtipo, date: hoje }
   });

   if (existing) {
     await prisma.workLog.update({ where: { id: existing.id }, data: { timestamp } });
   } else {
     await prisma.workLog.create({
       data: { userId: user.id, type: subtipo, timestamp, date: hoje }
     });
   }
 }

 const pontosHoje = await prisma.workLog.findMany({
   where: { userId: user.id, date: hoje },
   orderBy: { timestamp: 'asc' }
 });

 const resumo = await gerarResumoDoBanco(pontosHoje, user.id);
 await sendMessage(phone, resumo + MENU_FOOTER);
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

 let tempoManha = null;
 let tempoTarde = null;
 let totalTrabalhado = null;
 let horasExtras = null;

 if (entrada && saidaAlmoco) {
   tempoManha = (new Date(saidaAlmoco.timestamp) - new Date(entrada.timestamp)) / 60000;
 }
 if (voltaAlmoco && saida) {
   tempoTarde = (new Date(saida.timestamp) - new Date(voltaAlmoco.timestamp)) / 60000;
 }
 if (tempoManha !== null && tempoTarde !== null) {
   totalTrabalhado = tempoManha + tempoTarde;
   horasExtras = totalTrabalhado - jornada;
 }

 let texto = `✨ *Resumo do seu dia*\n\n`;
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

// ====================== BUSCA ======================
async function handleBusca(user, phone, query) {
 await sendMessage(phone, '✨ _Clareando ideias..._');

 const mems = await memory.getRecentMemories(user.id, 20);
 let locationText = '';

 const locationMem = mems.find(m => m.type === 'localizacao');
 if (locationMem) {
   try {
     const loc = JSON.parse(locationMem.content);
     locationText = `${loc.latitude}, ${loc.longitude}`;
   } catch (e) {}
 }

 if (!locationText) {
   const cidadeMem = mems.find(m => m.type === 'cidade');
   if (cidadeMem) locationText = cidadeMem.content;
 }

 let queryFinal = query;
 if (locationText) {
   queryFinal = query
     .replace(/minha cidade/gi, locationText)
     .replace(/aqui/gi, locationText)
     .replace(/perto de mim/gi, `perto de ${locationText}`)
     .replace(/próximo a mim/gi, `próximo a ${locationText}`);
 }

 const resultado = await searchWeb(queryFinal, locationText);
 await sendMessage(phone, resultado + MENU_FOOTER);
}

// ====================== ANOTAÇÃO ======================
async function handleNote(user, phone, classified) {
 await memory.saveMemory(user.id, 'anotacao', classified.conteudo, {
   titulo: classified.titulo
 });
 await sendMessage(phone, '📝 Anotado! Guardei aqui comigo com carinho. ✨' + MENU_FOOTER);
}

// ====================== TAREFA ======================
async function handleTask(user, phone, classified) {
 await memory.saveMemory(user.id, 'tarefa', classified.titulo, {
   data: classified.data,
   hora: classified.hora,
 });

 let msg = 'Guardei! 📅';
 if (classified.hora) msg = `Combinado! Vou te lembrar às *${classified.hora}*. ⏰`;
 await sendMessage(phone, msg + MENU_FOOTER);
}

// ====================== GASTO ======================
async function handleExpense(user, phone, classified) {
 await memory.saveMemory(user.id, 'gasto', classified.descricao, {
   valor: classified.valor,
   categoria: classified.categoria,
 });
 await sendMessage(phone, `Registrado! 💰 R$ ${classified.valor.toFixed(2)} em *${classified.categoria}*.` + MENU_FOOTER);
}

// ====================== CONSULTA ======================
async function handleQuery(user, phone, question) {
 await sendMessage(phone, '💭 _Deixa eu ver isso pra você..._');
 const memories = await memory.getRecentMemories(user.id, 30);

 if (memories.length === 0) {
   await sendMessage(phone, 'Ainda não guardei nada pra você. Me conta algo!' + MENU_FOOTER);
   return;
 }

 const answer = await generateMemorySummary(memories, question);
 await sendMessage(phone, answer + MENU_FOOTER);
}

module.exports = { handleMessage };
