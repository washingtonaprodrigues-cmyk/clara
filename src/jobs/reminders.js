const cron = require('node-cron');
// sendMessage com fallback direto via axios — evita o mesmo problema de
// circular dependency / ordem de carregamento que ocorreu no handler.js
// (sendMessage is not a function quando importado por destructuring direto).
async function sendMessage(phone, msg, delay) {
  try {
    const w = require('../services/whatsapp');
    if (w && typeof w.sendMessage === 'function') {
      return w.sendMessage(phone, msg, delay);
    }
  } catch (e) {
    console.error('[Reminders] Erro ao carregar whatsapp.js:', e.message);
  }
  const axios = require('axios');
  const BASE_URL = process.env.UAZAPI_URL || 'https://claravirtual.uazapi.com';
  const TOKEN = process.env.UAZAPI_TOKEN;
  console.log(`[Reminders/Fallback] Enviando direto para ${phone}: ${String(msg).slice(0,60)}`);
  return axios.post(`${BASE_URL}/send/text`,
    { number: phone, text: msg, delay: delay || 800 },
    { headers: { token: TOKEN, 'Content-Type': 'application/json' }, timeout: 30000 }
  );
}
const { freeResponse } = require('../services/groq');
const memory = require('../services/memory');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}
function pad(n) { return String(n).padStart(2, '0'); }
function dateBRT(d = nowBRT()) {
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function random(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function tomDesc(tom) {
  return {
    carinhoso: 'calorosa e próxima, como uma amiga que genuinamente se importa. Use emojis com moderação. Varie sempre o jeito de falar.',
    direto: 'direta e objetiva, sem rodeios ou fofice. Vá ao ponto. Sem emojis desnecessários.',
    divertido: 'animada, com humor e energia, usando gírias naturais. Leve e bem-humorada.',
    sarcastico: 'sarcástica e sem filtro — usa ironia fina, deboche carinhoso, nunca elogia à toa. Fala a verdade com um sorrisinho. NUNCA seja sentimental ou emotiva. Tom ácido mas com carinho real por baixo.',
    clara_sendo_clara: 'adaptável ao clima de cada mensagem — anime-se com quem brinca, seja direta com quem é prático, acolha quem está mal, devolva provocação com sarcasmo leve. Sempre genuína, nunca fria ou forçada. Use o humor/estilo da mensagem atual como guia.',
  }[tom || 'carinhoso'] || 'calorosa e próxima, como uma amiga que genuinamente se importa.';
}
const finais = [
  '😊 Já concluiu? (sim/não)',
  '✨ Já deu conta? (sim/não)',
  '🔔 Conseguiu fazer? (sim/não)',
  '😊 Já fez isso? (sim/não)',
];
async function jaEnviouHoje(userId, tipo) {
  const hoje = dateBRT();
  return prisma.memory.findFirst({ where: { userId, type: tipo, content: hoje } });
}
async function marcarEnviadoHoje(userId, tipo) {
  await prisma.memory.create({ data: { userId, type: tipo, content: dateBRT() } });
}
// Lock atomico por usuario/tipo/dia.
// Retorna true se esta chamada "ganhou" o lock (deve processar/enviar),
// e false se ja havia um lock para hoje (outra execucao ja esta/esteve
// processando - pular). Marcar o lock ANTES de gerar a mensagem evita
// duplicidade quando o cron dispara em paralelo (duas replicas, restart
// no mesmo minuto, etc).
//
// NOTA: o model Memory não tem @@unique([userId, type]) no schema, então
// não é possível usar upsert com where: { userId_type: {...} } (esse nome
// de campo composto só existe quando há esse unique constraint). Por isso
// usamos findFirst + create/update manual.
// Lock em memória do processo — primeira linha de defesa contra disparo
// duplicado dentro do MESMO processo Node (ex: cron disparando 2x por
// algum reschedule, ou duas chamadas concorrentes no mesmo tick).
// Não protege contra múltiplas réplicas do Railway, mas resolve o caso
// mais comum de "duas mensagens idênticas/parecidas no mesmo minuto".
const _locksEmMemoria = new Map(); // `${userId}_${tipo}_${dia}` -> true
// Verifica se houve troca de mensagens recente (usuário ou Clara) nos
// últimos N minutos. Usado para evitar que mensagens espontâneas (Meu
// Dia, proativa, tradições semanais) interrompam uma conversa em
// andamento de forma deslocada — ex: ela mandar "você tem 3 coisas hoje"
// no meio de uma brincadeira. Lembretes explícitos (compromissos
// marcados pelo usuário) NÃO usam essa checagem — esses devem sempre
// disparar no horário certo, independente de conversa em curso.
async function houveConversaRecente(userId, minutos = 5) {
  const limite = new Date(Date.now() - minutos * 60 * 1000);
  const recente = await prisma.memory.findFirst({
    where: { userId, type: 'conversa', createdAt: { gte: limite } }
  }).catch(() => null);
  return !!recente;
}
async function tentarLockDiario(userId, tipo) {
  const hoje = dateBRT();
  const chaveMemoria = `${userId}_${tipo}_${hoje}`;
  if (_locksEmMemoria.has(chaveMemoria)) return false;
  _locksEmMemoria.set(chaveMemoria, true);
  // Limpa entradas de dias antigos para não crescer indefinidamente
  if (_locksEmMemoria.size > 5000) {
    for (const k of _locksEmMemoria.keys()) {
      if (!k.endsWith(`_${hoje}`)) _locksEmMemoria.delete(k);
    }
  }
  const existente = await prisma.memory.findFirst({
    where: { userId, type: tipo },
    orderBy: { createdAt: 'desc' }
  }).catch(() => null);
  if (existente && existente.content === hoje) return false;
  if (existente) {
    await prisma.memory.update({
      where: { id: existente.id },
      data: { content: hoje }
    });
  } else {
    await prisma.memory.create({
      data: { userId, type: tipo, content: hoje }
    });
  }
  return true;
}
async function getUserContext(user) {
  const prefs = await memory.getUserPreference(user.id);
  const perfilTexto = await memory.buildPersonalContext(user.id);
  return { prefs, perfilTexto };
}
// BOM DIA INTELIGENTE (07:00)
cron.schedule('0 7 * * *', async () => {
  try {
    const now = nowBRT();
    const amanha = new Date(now); amanha.setDate(amanha.getDate() + 1);
    const amanhaStr = dateBRT(amanha);
    const hoje = dateBRT(now);
    const diasSemana = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
    const meses = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
    const diaTexto = `${diasSemana[now.getDay()]}, ${now.getDate()} de ${meses[now.getMonth()]}`;
    const users = await prisma.user.findMany({ where: { blocked: false } });
    for (const user of users) {
      try {
        if (!(await tentarLockDiario(user.id, 'bom_dia_lock'))) {
          console.log(`[Bom dia] ja enviado/processando hoje para ${user.phone}`);
          continue;
        }
        const inicioHoje = new Date(`${hoje}T00:00:00-03:00`);
        const fimHoje = new Date(`${hoje}T23:59:59-03:00`);
        const [lembretes, eventos, infoPessoal] = await Promise.all([
          prisma.reminder.findMany({
            where: { userId: user.id, confirmed: false, sent: false, scheduledAt: { gte: inicioHoje, lte: fimHoje } },
            orderBy: { scheduledAt: 'asc' }, take: 5
          }),
          prisma.event.findMany({
            where: { userId: user.id, date: { gte: inicioHoje, lte: new Date(`${amanhaStr}T23:59:59-03:00`) } }
          }).catch(() => []),
          memory.buildPersonalContext(user.id)
        ]);
        const { prefs } = await getUserContext(user);
        let ctx = `Hoje é ${diaTexto}.\n`;
        const totalLembretes = lembretes.length;
        if (lembretes.length > 0) {
          ctx += `\nLembretes de hoje (${totalLembretes} no total):\n`;
          lembretes.forEach(r => {
            const h = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
            ctx += `• ${h} — ${r.message}\n`;
          });
        }
        if (eventos.length > 0) {
          ctx += `\nEventos próximos:\n`;
          eventos.forEach(e => { ctx += `• ${e.title}${e.personName ? ` (${e.personName})` : ''}\n`; });
        }
        if (infoPessoal) ctx += infoPessoal;
        let systemBomDia;
        if (totalLembretes > 0) {
          const primeira = lembretes[0];
          const horaPrimeira = new Date(primeira.scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
          systemBomDia = `Você é a Clara, assistente pessoal. ${user.name ? `O nome do usuário é ${user.name}.` : ''}
Crie uma mensagem de bom dia OBJETIVA e INFORMATIVA — um resumo rápido do dia, não poética.
CONTEXTO DO DIA:
${ctx}
REGRAS OBRIGATÓRIAS:
- Diga "Bom dia" + quantas tarefas/compromissos tem hoje (${totalLembretes})
- Se houver 3 ou mais tarefas, liste-as em formato de lista (uma por linha, com "•" no início e o horário entre parênteses) — NÃO comprima tudo numa única frase corrida
- Se houver até 2 tarefas, pode mencionar em frase corrida normalmente
- Encerre com algo curto tipo "estarei aqui pra te lembrar de tudo" — adaptado ao seu tom
- Varie a abertura — não repita sempre a mesma frase
- Use no máximo 1 emoji
- NÃO seja sentimental ou poética. Seja prática.
- NUNCA coloque a mensagem inteira entre aspas
Tom: ${prefs.tom || 'carinhoso'}.`;
        } else {
          systemBomDia = `Você é a Clara, assistente pessoal. ${user.name ? `O nome do usuário é ${user.name}.` : ''}
Crie uma mensagem de bom dia SIMPLES e HUMANA — como se fosse a primeira vez que fala com a pessoa naquele dia.
CONTEXTO DO DIA:
${ctx}
REGRAS OBRIGATÓRIAS:
- Máximo 2-3 linhas
- Sem compromissos hoje — diga algo positivo e leve sobre o dia, sem mencionar a ausência de tarefas
- Varie sempre a abertura — NUNCA repita "Bom dia, [nome]! ☀️"
- Use no máximo 1 emoji
- NÃO pergunte. NÃO agende nada.
Tom: ${prefs.tom || 'carinhoso'}.`;
        }
        const msg = await freeResponse('Envie uma mensagem de bom dia para o usuário.', [], { _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso', _systemOverride: systemBomDia });
        if (!msg) { console.log(`[Bom dia] Rate limit, pulado para ${user.phone}`); continue; }
        await sendMessage(user.phone, msg);
        // ── Criar "Meu Dia" — lista especial sem horário ──
        // Criada automaticamente junto com o bom dia. Respeita flag de
        // exclusão permanente (meu_dia_desativado) caso o usuário tenha
        // pedido pra parar de criar.
        try {
          const desativado = await prisma.memory.findFirst({
            where: { userId: user.id, type: 'meu_dia_desativado' }
          });
          if (!desativado) {
            const jaTemHoje = await prisma.memory.findFirst({
              where: { userId: user.id, type: 'meu_dia_criado', content: dateBRT() }
            });
            if (!jaTemHoje) {
              // Busca tarefas pendentes sem horário ou com horário passado não confirmadas
              const tarefasPendentes = await prisma.reminder.findMany({
                where: { userId: user.id, confirmed: false, sent: false,
                  scheduledAt: { gte: new Date(`${dateBRT()}T00:00:00-03:00`), lte: new Date(`${dateBRT()}T23:59:59-03:00`) }
                },
                orderBy: { scheduledAt: 'asc' }, take: 10
              });
              // Monta lista "Meu Dia" no formato de grocery list existente
              const itens = tarefasPendentes.map((t, i) => ({
                id: i + 1,
                nome: t.message,
                done: false,
                lembreteId: t.id
              }));
              // Adiciona item padrão se lista vazia
              if (itens.length === 0) {
                itens.push({ id: 1, nome: 'Adicione tarefas do seu dia aqui 📝', done: false });
              }
              await prisma.groceryList.create({
                data: {
                  userId: user.id,
                  name: '📅 Meu Dia',
                  items: JSON.stringify(itens),
                  done: false
                }
              });
              await prisma.memory.create({
                data: { userId: user.id, type: 'meu_dia_criado', content: dateBRT() }
              });
              console.log(`[Meu Dia] Criado para ${user.phone}`);
            }
          }
        } catch (eMeuDia) { console.error(`[Meu Dia] Erro ${user.phone}:`, eMeuDia.message); }
        console.log(`[Bom dia] Enviado para ${user.phone}`);
      } catch (e) { console.error(`[Bom dia] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Bom dia] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });
// BOA NOITE INTELIGENTE (21:30)
cron.schedule('30 21 * * *', async () => {
  try {
    const now = nowBRT();
    const hoje = dateBRT(now);
    const amanha = new Date(now); amanha.setDate(amanha.getDate() + 1);
    const amanhaStr = dateBRT(amanha);
    const users = await prisma.user.findMany({ where: { blocked: false } });
    for (const user of users) {
      try {
        if (!(await tentarLockDiario(user.id, 'boa_noite_lock'))) {
          console.log(`[Boa noite] ja enviado/processando hoje para ${user.phone}`);
          continue;
        }
        const inicioAmanha = new Date(`${amanhaStr}T00:00:00-03:00`);
        const fimAmanha = new Date(`${amanhaStr}T23:59:59-03:00`);
        const inicioHoje = new Date(`${hoje}T00:00:00-03:00`);
        const fimHoje = new Date(`${hoje}T23:59:59-03:00`);
        const [lembretesAmanha, tarefasHoje, infoPessoal] = await Promise.all([
          prisma.reminder.findMany({
            where: { userId: user.id, confirmed: false, sent: false, scheduledAt: { gte: inicioAmanha, lte: fimAmanha } },
            orderBy: { scheduledAt: 'asc' }, take: 3
          }),
          prisma.reminder.findMany({
            where: { userId: user.id, scheduledAt: { gte: inicioHoje, lte: fimHoje } }
          }),
          memory.buildPersonalContext(user.id)
        ]);
        const { prefs } = await getUserContext(user);
        const concluidasHoje = tarefasHoje.filter(t => t.confirmed).length;
        const totalHoje = tarefasHoje.length;
        let ctx = `Hoje foi ${['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'][now.getDay()]}.\n`;
        if (totalHoje > 0) ctx += `O usuário tinha ${totalHoje} compromisso(s) hoje e concluiu ${concluidasHoje}.\n`;
        if (lembretesAmanha.length > 0) {
          ctx += `\nAmanhã tem ${lembretesAmanha.length} compromisso(s):\n`;
          lembretesAmanha.forEach(r => {
            const h = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
            ctx += `• ${h} — ${r.message}\n`;
          });
        }
        if (infoPessoal) ctx += infoPessoal;
        let systemBoaNoite;
        if (totalHoje > 0 || lembretesAmanha.length > 0) {
          // ── Sem repetir números do Fechamento (18:30) ──
          // Antes, essa mensagem também dizia "concluiu X/Y hoje", quase
          // idêntico ao que o cron de Fechamento já manda 3h antes — duas
          // mensagens recapitulando os mesmos números no mesmo dia soa
          // repetitivo, não como duas pessoas diferentes comentando. Agora
          // o boa noite é mais curto e mais "amiga": só toca no dia se for
          // genuíno fazer isso, sem citar contagem de tarefas, e foca em
          // olhar pra frente (amanhã) e fechar com carinho.
          systemBoaNoite = `Você é a Clara, parceira pessoal. ${user.name ? `O nome do usuário é ${user.name}.` : ''}
Crie uma mensagem de boa noite curta e genuína — como uma amiga próxima se despedindo, não um resumo do dia.
CONTEXTO (uso interno, NÃO cite números/contagens disso na mensagem — isso já foi dito mais cedo no fechamento do dia):
${ctx}
REGRAS OBRIGATÓRIAS:
- 1-2 linhas, curto mesmo
- NÃO mencione quantas tarefas foram concluídas nem quantos compromissos teve hoje — isso já foi comunicado antes, repetir parece forçado
- Se tem compromissos amanhã, pode mencionar BREVEMENTE e de forma leve (ex: "amanhã é dia corrido, descansa bem") sem listar quantidade exata
- Encerre com algo caloroso e diferente a cada dia, no seu jeito
- Varie a abertura — não repita sempre a mesma frase
- Máximo 1 emoji
Tom: ${prefs.tom || 'carinhoso'}.`;
        } else {
          systemBoaNoite = `Você é a Clara, assistente pessoal. ${user.name ? `O nome do usuário é ${user.name}.` : ''}
Crie uma mensagem de boa noite SIMPLES — como quem se despede de verdade ao final do dia.
CONTEXTO DO DIA:
${ctx}
REGRAS OBRIGATÓRIAS:
- Máximo 2-3 linhas, sem emojis
- Considere o dia da semana
- Varie sempre a abertura
- Encerre com algo caloroso e diferente a cada dia
- NÃO mencione falta de compromissos. NÃO pergunte. NÃO agende nada.
Tom: ${prefs.tom || 'carinhoso'}.`;
        }
        const msg = await freeResponse('Envie uma mensagem de boa noite para o usuário.', [], { _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso', _systemOverride: systemBoaNoite });
        if (!msg) { console.log(`[Boa noite] Rate limit, pulado para ${user.phone}`); continue; }
        await sendMessage(user.phone, msg);
        console.log(`[Boa noite] Enviado para ${user.phone}`);
      } catch (e) { console.error(`[Boa noite] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Boa noite] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });
// ALERTAS DE DATAS IMPORTANTES (08:00)
cron.schedule('0 8 * * *', async () => {
  try {
    const now = nowBRT();
    const users = await prisma.user.findMany({ where: { blocked: false } });
    for (const user of users) {
      try {
        const infos = await memory.getPersonalInfo(user.id, 'datas');
        for (const [chave, { valor }] of Object.entries(infos)) {
          const match = valor.match(/(\d{1,2})\s+de\s+(\w+)/i);
          if (!match) continue;
          const mesesMap = { janeiro:1,fevereiro:2,março:3,abril:4,maio:5,junho:6,julho:7,agosto:8,setembro:9,outubro:10,novembro:11,dezembro:12 };
          const dia = parseInt(match[1]);
          const mes = mesesMap[match[2].toLowerCase()];
          if (!dia || !mes) continue;
          const dataEvento = new Date(now.getFullYear(), mes - 1, dia);
          const diffDias = Math.round((dataEvento - now) / (1000 * 60 * 60 * 24));
          const lockKey = `alerta_data_${chave}_${dateBRT()}`;
          const jaEnviou = await prisma.memory.findFirst({ where: { userId: user.id, type: 'alerta_data_lock', content: lockKey } });
          if (jaEnviou) continue;
          let msg = null;
          if (diffDias === 0) msg = `🎉 ${valor.replace('Aniversário', 'Hoje é o aniversário')} — não esquece de dar os parabéns! 🎂`;
          else if (diffDias === 1) msg = `⏰ Amanhã: ${valor} Já preparou algo especial? 😊`;
          else if (diffDias === 3) msg = `📅 Em 3 dias: ${valor} 💜`;
          else if (diffDias === 7) msg = `📅 Em uma semana: ${valor} Já anotei pra te lembrar mais perto! 😊`;
          if (msg) {
            await sendMessage(user.phone, msg);
            await prisma.memory.create({ data: { userId: user.id, type: 'alerta_data_lock', content: lockKey } });
          }
        }
        const eventos = await prisma.event.findMany({ where: { userId: user.id, notified: false } }).catch(() => []);
        for (const ev of eventos) {
          const dataEv = new Date(ev.date);
          const diffDias = Math.round((dataEv - now) / (1000 * 60 * 60 * 24));
          let msg = null;
          // Para aniversário (hoje ou amanhã) de uma pessoa nomeada, busca
          // memórias pessoais sobre ela (ex: "filha gosta de Patrulha
          // Canina") e usa IA pra mencionar isso naturalmente — é o tipo
          // de detalhe que faz parecer que a Clara realmente conhece a
          // pessoa, não só uma data guardada num banco.
          if ((diffDias === 0 || diffDias === 1) && ev.personName) {
            try {
              const infoPessoalCompleta = await memory.buildPersonalContext(user.id).catch(() => '');
              const termoBusca = ev.personName.toLowerCase();
              // Filtra só as linhas do contexto pessoal que mencionam a
              // pessoa do aniversário (buildPersonalContext já retorna um
              // texto formatado com várias infos — pegamos só o relevante).
              const linhasRelacionadas = (infoPessoalCompleta || '')
                .split('\n')
                .filter(linha => linha.toLowerCase().includes(termoBusca));
              if (linhasRelacionadas.length > 0) {
                const prefs = await memory.getUserPreference(user.id).catch(() => null);
                const contextoPessoa = linhasRelacionadas.join('; ');
                const quando = diffDias === 0 ? 'hoje' : 'amanhã';
                const systemAniversario = `Você é a Clara, assistente pessoal. ${user.name ? `O nome do usuário é ${user.name}.` : ''}
Tom: ${prefs?.tom || 'carinhoso'}.
É ${quando} o aniversário de ${ev.personName}.
O que você sabe sobre ${ev.personName}: ${contextoPessoa}
Envie uma mensagem curta (1-2 linhas) avisando do aniversário e mencionando naturalmente esse detalhe pessoal (ex: sugestão de presente baseada no que ela gosta). NÃO liste como tópicos — fale naturalmente.`;
                msg = await freeResponse(`Aviso de aniversário de ${ev.personName}.`, [], {
                  _contexto: '', name: user.name, tom: prefs?.tom || 'carinhoso', _systemOverride: systemAniversario
                }).catch(() => null);
              }
            } catch (eMem) {
              console.error(`[Datas] Erro ao buscar memórias de ${ev.personName}:`, eMem.message);
            }
          }
          // Fallback para os templates fixos (sem memória pessoal disponível,
          // ou diffDias diferente de 0/1)
          if (!msg) {
            if (diffDias === 0) msg = `🎉 Hoje é ${ev.title}${ev.personName ? ` da ${ev.personName}` : ''}! 🎂`;
            else if (diffDias === 1) msg = `⏰ Amanhã é ${ev.title}${ev.personName ? ` da ${ev.personName}` : ''}! Não esquece 😊`;
            else if (diffDias === 3) msg = `📅 Em 3 dias: ${ev.title}${ev.personName ? ` da ${ev.personName}` : ''} 💜`;
            else if (diffDias === 7) msg = `📅 Em uma semana: ${ev.title}${ev.personName ? ` da ${ev.personName}` : ''} 😊`;
          }
          if (msg) {
            await sendMessage(user.phone, msg);
            await prisma.event.update({ where: { id: ev.id }, data: { notified: true } });
          }
        }
      } catch (e) { console.error(`[Datas] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Datas] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });
// MENSAGENS PROATIVAS INTELIGENTES (10:00 e 15:00)
cron.schedule('0 10 * * 1-5', async () => proativaInteligente('manha'), { timezone: 'America/Sao_Paulo' });
cron.schedule('0 15 * * 1-5', async () => proativaInteligente('tarde'), { timezone: 'America/Sao_Paulo' });
async function proativaInteligente(periodo) {
  try {
    const users = await prisma.user.findMany({ where: { blocked: false } });
    const now = nowBRT();
    for (const user of users) {
      try {
        const lockKey = `proativa_${periodo}_${dateBRT()}`;
        if (await prisma.memory.findFirst({ where: { userId: user.id, type: 'proativa_lock', content: lockKey } })) continue;
        // Pula esse ciclo se há conversa ativa nos últimos minutos — evita
        // interromper de forma deslocada (ex: mandar agenda no meio de
        // uma brincadeira). Não reagenda, apenas não envia hoje.
        if (await houveConversaRecente(user.id, 5)) continue;
        const ultimaConversa = await prisma.memory.findFirst({ where: { userId: user.id, type: 'conversa' }, orderBy: { createdAt: 'desc' } });
        if (!ultimaConversa) continue;
        const diasSemConversa = (now - new Date(ultimaConversa.createdAt)) / (1000 * 60 * 60 * 24);
        if (diasSemConversa > 3) continue;
        const [infoPessoal, memsRecentes, { prefs }] = await Promise.all([
          memory.buildPersonalContext(user.id),
          memory.getRecentMemories(user.id, 15),
          getUserContext(user)
        ]);
        if (!infoPessoal && memsRecentes.length < 3) continue;
        if (Math.random() > 0.33) continue;
        // ── Filtro de memórias com data futura ──
        // memsRecentes inclui qualquer tipo de memória (compromisso, gasto,
        // remédio etc.) só ordenado por criação, sem olhar se o ASSUNTO em
        // si já venceu ou ainda é futuro. Isso causava a IA falar de uma
        // tarefa com vencimento daqui a dias como se já tivesse acontecido
        // (ex: "você finalmente lembrou do pagamento do remédio?" sobre algo
        // que só vence dia 24). Cruza com a tabela Task: se a memória for do
        // tipo 'compromisso' e a Task correspondente tiver dueDate no futuro,
        // remove do contexto — só sobra o que já é passado/presente ou não
        // tem data (filtro conservador: na dúvida, mantém).
        const tasksFuturas = await prisma.task.findMany({
          where: { userId: user.id, completed: false, dueDate: { gt: now } },
          select: { title: true }
        }).catch(() => []);
        const titulosFuturos = new Set(tasksFuturas.map(t => t.title));
        const memsFiltradas = memsRecentes.filter(m => {
          if (m.type !== 'compromisso') return true;
          return !titulosFuturos.has(m.content);
        });
        const contextoMems = memsFiltradas
          .filter(m => !['conversa','bom_dia_enviado','boa_noite_enviado','proativa_lock','med_lock','alerta_data_lock'].includes(m.type))
          .slice(0, 8).map(m => `[${m.type}] ${m.content}`).join('\n');
        const tomDescLocal = {
          carinhoso: 'calorosa e próxima, como uma amiga que genuinamente se importa',
          direto: 'direta e objetiva, sem rodeios ou fofice',
          divertido: 'animada, com humor e energia, usando gírias naturais',
          sarcastico: 'sarcástica e sem filtro — usa ironia fina, deboche carinhoso, nunca elogia à toa. Fala a verdade com um sorrisinho. NUNCA seja sentimental ou emotiva.'
        }[prefs.tom || 'carinhoso'] || 'calorosa e próxima';
        const systemProativa = `Você é a Clara, parceira pessoal do ${user.name || 'usuário'} no WhatsApp.
SEU TOM AGORA: ${tomDescLocal}
Envie UMA mensagem curta e natural (1-2 linhas) como parceira presente — não como assistente genérica.
REGRAS:
- NUNCA comece com "Oi", "Olá" ou nome da pessoa
- NÃO agende nada, NÃO liste tarefas
- Use o contexto para algo genuíno e específico — nunca genérico
- NÃO trate nada do contexto como já feito, pago ou resolvido — se não tiver certeza se já aconteceu, pergunte de forma aberta em vez de cobrar como se já devesse ter sido feito
- Se não tiver nada relevante ou o contexto for fraco, responda APENAS: SKIP
- Respeite rigorosamente o tom acima — não misture estilos
Contexto recente: ${contextoMems}
${infoPessoal}`;
        const msg = await freeResponse('Envie uma mensagem proativa.', [], { _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso', _systemOverride: systemProativa });
        if (!msg || msg.trim() === 'SKIP' || msg.length < 5) continue;
        await sendMessage(user.phone, msg);
        await prisma.memory.create({ data: { userId: user.id, type: 'proativa_lock', content: lockKey } });
        console.log(`[Proativa ${periodo}] Enviado para ${user.phone}`);
      } catch (e) { console.error(`[Proativa] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error(`[Proativa ${periodo}] Erro geral:`, e.message); }
}
// ── RADAR DA CLARA (detecção de padrões) — domingo 09:30 ──
// Analisa estatisticamente os gastos/contas dos últimos meses pra notar
// padrões sem precisar de configuração: dia em que uma categoria de gasto
// costuma se repetir (ex: "internet sempre por volta do dia 20") e gastos
// fora do padrão em relação à média histórica da mesma categoria.
// Roda 1x por semana — observação ocasional, não um painel constante.
cron.schedule('30 9 * * 0', async () => {
  try {
    const users = await prisma.user.findMany({ where: { blocked: false } });
    const now = nowBRT();
    for (const user of users) {
      try {
        const lockKey = `radar_${dateBRT(now)}`;
        if (await prisma.memory.findFirst({ where: { userId: user.id, type: 'radar_lock', content: lockKey } })) continue;
        // Janela de análise: últimos 3 meses
        const tresMesesAtras = new Date(now); tresMesesAtras.setMonth(tresMesesAtras.getMonth() - 3);
        const gastos = await prisma.expense.findMany({
          where: { userId: user.id, createdAt: { gte: tresMesesAtras } },
          orderBy: { createdAt: 'asc' }
        });
        if (gastos.length < 6) continue; // pouco histórico, não vale a pena analisar ainda
        const insights = [];
        // ── Padrão de dia do mês por categoria (ex: internet sempre dia ~20) ──
        const porCategoria = {};
        gastos.forEach(g => {
          const cat = g.category || 'outro';
          if (!porCategoria[cat]) porCategoria[cat] = [];
          porCategoria[cat].push(g);
        });
        for (const [cat, lista] of Object.entries(porCategoria)) {
          if (lista.length < 3) continue; // precisa de pelo menos 3 ocorrências
          const dias = lista.map(g => new Date(g.createdAt).getDate());
          const media = dias.reduce((a, d) => a + d, 0) / dias.length;
          const desvios = dias.map(d => Math.abs(d - media));
          const desvioMedio = desvios.reduce((a, d) => a + d, 0) / desvios.length;
          // Desvio médio baixo = dia consistente entre as ocorrências
          if (desvioMedio <= 3) {
            const jaAvisado = await prisma.memory.findFirst({
              where: { userId: user.id, type: 'padrao_dia_avisado', content: cat }
            });
            if (!jaAvisado) {
              insights.push({ tipo: 'padrao_dia', categoria: cat, diaAproximado: Math.round(media) });
            }
          }
        }
        // ── Gasto fora do padrão no mês atual vs média histórica ──
        const inicioMesAtual = new Date(now.getFullYear(), now.getMonth(), 1);
        const gastosMesAtual = gastos.filter(g => new Date(g.createdAt) >= inicioMesAtual);
        const gastosAnteriores = gastos.filter(g => new Date(g.createdAt) < inicioMesAtual);
        for (const [cat, listaAtual] of Object.entries(
          gastosMesAtual.reduce((acc, g) => { const c = g.category || 'outro'; (acc[c] = acc[c] || []).push(g); return acc; }, {})
        )) {
          const totalAtual = listaAtual.reduce((a, g) => a + g.value, 0);
          const anterioresMesmaCat = gastosAnteriores.filter(g => (g.category || 'outro') === cat);
          if (anterioresMesmaCat.length < 2) continue; // precisa de histórico pra comparar
          // Calcula média mensal histórica (agrupando por mês)
          const porMes = {};
          anterioresMesmaCat.forEach(g => {
            const d = new Date(g.createdAt);
            const chave = `${d.getFullYear()}-${d.getMonth()}`;
            porMes[chave] = (porMes[chave] || 0) + g.value;
          });
          const mediasHistoricas = Object.values(porMes);
          if (mediasHistoricas.length < 1) continue;
          const mediaHistorica = mediasHistoricas.reduce((a, v) => a + v, 0) / mediasHistoricas.length;
          if (mediaHistorica > 0 && totalAtual > mediaHistorica * 1.4) {
            const percentual = Math.round((totalAtual / mediaHistorica - 1) * 100);
            insights.push({ tipo: 'gasto_fora_padrao', categoria: cat, percentual, valorAtual: totalAtual, valorMedio: mediaHistorica });
          }
        }
        if (insights.length === 0) continue;
        const prefs = await memory.getUserPreference(user.id).catch(() => null);
        const insightsTexto = insights.map(i => {
          if (i.tipo === 'padrao_dia') return `- A categoria "${i.categoria}" costuma ter gastos por volta do dia ${i.diaAproximado} do mês.`;
          if (i.tipo === 'gasto_fora_padrao') return `- Gasto com "${i.categoria}" este mês: R$ ${i.valorAtual.toFixed(2)}, ${i.percentual}% acima da média histórica (R$ ${i.valorMedio.toFixed(2)}).`;
          return '';
        }).join('\n');
        const systemRadar = `Você é a Clara, assistente pessoal. ${user.name ? `O nome do usuário é ${user.name}.` : ''}
Tom: ${prefs?.tom || 'carinhoso'}.
Você notou os seguintes padrões nos dados financeiros do usuário:
${insightsTexto}
Envie UMA mensagem natural (2-3 linhas) comentando esses padrões como uma observação genuína — não como relatório.
- Se for "padrao_dia": apenas comente que notou o padrão, sem fazer pergunta complexa.
- Se for "gasto_fora_padrao": pergunte de forma leve se foi uma exceção, sem cobrar ou julgar.
- Escolha o insight mais relevante (não liste todos formalmente).
NÃO use tópicos ou marcadores. NÃO termine com saudação de período.`;
        const msg = await freeResponse('Mensagem de radar/padrões.', [], {
          _contexto: '', name: user.name, tom: prefs?.tom || 'carinhoso', _systemOverride: systemRadar
        });
        if (!msg) continue;
        await sendMessage(user.phone, msg);
        await prisma.memory.create({ data: { userId: user.id, type: 'radar_lock', content: lockKey } });
        // Marca categorias de padrão_dia como já avisadas (evita repetir
        // o mesmo insight toda semana)
        for (const i of insights.filter(x => x.tipo === 'padrao_dia')) {
          await prisma.memory.create({ data: { userId: user.id, type: 'padrao_dia_avisado', content: i.categoria } }).catch(() => {});
        }
        console.log(`[Radar] Enviado para ${user.phone} (${insights.length} insight(s))`);
      } catch (e) { console.error(`[Radar] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Radar] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });
// TRADIÇÕES SEMANAIS — SEXTA (17:00)
// ── Roda às 18:00 (mesma hora do Fechamento diário) ──
// O Fechamento diário (mais abaixo) agora pula sextas-feiras de propósito
// — nesse dia, só esta mensagem semanal dispara às 18h, evitando duas
// mensagens de recap parecidas no mesmo horário.
cron.schedule('0 18 * * 5', async () => {
  try {
    const users = await prisma.user.findMany({ where: { blocked: false } });
    const now = nowBRT();
    const inicioSemana = new Date(now); inicioSemana.setDate(now.getDate() - 4); inicioSemana.setHours(0,0,0,0);
    for (const user of users) {
      try {
        if (!(await tentarLockDiario(user.id, 'sexta_enviado'))) {
          console.log(`[Sexta] ja enviado/processando hoje para ${user.phone}`);
          continue;
        }
        const [gastosSemana, tarefasSemana, { prefs }] = await Promise.all([
          prisma.expense.findMany({ where: { userId: user.id, createdAt: { gte: inicioSemana } } }),
          prisma.reminder.findMany({ where: { userId: user.id, scheduledAt: { gte: inicioSemana }, confirmed: true } }),
          getUserContext(user)
        ]);
        const totalGasto = gastosSemana.reduce((a, g) => a + g.value, 0);
        const infoPessoal = await memory.buildPersonalContext(user.id);
        const ctxSexta = tarefasSemana.length > 0
          ? `Essa semana o usuário concluiu ${tarefasSemana.length} compromisso(s)${totalGasto > 0 ? ` e registrou R$ ${totalGasto.toFixed(2)} em gastos` : ''}.`
          : ``;
        const ctx = `É sexta-feira à tarde.\n${ctxSexta}\n${infoPessoal}`;
        const systemSexta = `Você é a Clara, assistente pessoal. ${user.name ? `O nome é ${user.name}.` : ''}
Envie uma mensagem de sexta-feira calorosa e breve (2-3 linhas).
NÃO liste tarefas. NÃO agende nada. Tom: ${prefs.tom || 'carinhoso'}.
${ctx}`;
        const msg = await freeResponse('Envie mensagem de sexta.', [], { _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso', _systemOverride: systemSexta });
        if (!msg) { console.log(`[Sexta] Rate limit, pulado para ${user.phone}`); continue; }
        await sendMessage(user.phone, msg);
        console.log(`[Sexta] Enviado para ${user.phone}`);
      } catch (e) { console.error(`[Sexta] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Sexta] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });
// TRADIÇÕES SEMANAIS — DOMINGO (19:00)
cron.schedule('0 19 * * 0', async () => {
  try {
    const users = await prisma.user.findMany({ where: { blocked: false } });
    const now = nowBRT();
    const semanaQ = new Date(now); semanaQ.setDate(now.getDate() + 1);
    const fimSemanaQ = new Date(now); fimSemanaQ.setDate(now.getDate() + 7);
    for (const user of users) {
      try {
        if (!(await tentarLockDiario(user.id, 'domingo_enviado'))) {
          console.log(`[Domingo] ja enviado/processando hoje para ${user.phone}`);
          continue;
        }
        const [lembretesSemana, { prefs }, infoPessoal] = await Promise.all([
          prisma.reminder.findMany({ where: { userId: user.id, confirmed: false, sent: false, scheduledAt: { gte: semanaQ, lte: fimSemanaQ } }, orderBy: { scheduledAt: 'asc' }, take: 5 }),
          getUserContext(user),
          memory.buildPersonalContext(user.id)
        ]);
        const ctx = `É domingo à noite, véspera de uma nova semana.\n${lembretesSemana.length > 0 ? `Próximos compromissos:\n${lembretesSemana.map(r => `• ${r.message}`).join('\n')}` : 'Sem compromissos agendados para a semana.'}\n${infoPessoal}`;
        const systemDomingo = `Você é a Clara, assistente pessoal. ${user.name ? `O nome é ${user.name}.` : ''}
Envie uma mensagem de domingo à noite — tranquila, motivadora e breve (2-3 linhas).
NÃO liste tarefas. NÃO agende nada. Tom: ${prefs.tom || 'carinhoso'}.
${ctx}`;
        const msg = await freeResponse('Envie mensagem de domingo.', [], { _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso', _systemOverride: systemDomingo });
        if (!msg) { console.log(`[Domingo] Rate limit, pulado para ${user.phone}`); continue; }
        await sendMessage(user.phone, msg);
        console.log(`[Domingo] Enviado para ${user.phone}`);
      } catch (e) { console.error(`[Domingo] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Domingo] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });
// SUMIÇO — detecta quem sumiu por 5+ dias (09:00)
cron.schedule('0 9 * * *', async () => {
  try {
    const users = await prisma.user.findMany({ where: { blocked: false } });
    const now = nowBRT();
    for (const user of users) {
      try {
        const lockKey = `sumico_${dateBRT()}`;
        if (await prisma.memory.findFirst({ where: { userId: user.id, type: 'sumico_lock', content: lockKey } })) continue;
        const ultimaConversa = await prisma.memory.findFirst({ where: { userId: user.id, type: 'conversa' }, orderBy: { createdAt: 'desc' } });
        if (!ultimaConversa) continue;
        const diasSemConversa = Math.round((now - new Date(ultimaConversa.createdAt)) / (1000 * 60 * 60 * 24));
        if (diasSemConversa < 5 || diasSemConversa > 7) continue;
        const { prefs } = await getUserContext(user);
        const infoPessoal = await memory.buildPersonalContext(user.id);
        const systemSumico = `Você é a Clara, assistente pessoal. ${user.name ? `O nome é ${user.name}.` : ''}
O usuário não conversa com você há ${diasSemConversa} dias.
Envie uma mensagem curta e genuína perguntando como ele está — sem ser dramática, sem cobrar.
Máx 2 linhas. Tom: ${prefs.tom || 'carinhoso'}.
${infoPessoal}`;
        const msg = await freeResponse('Mensagem para usuário que sumiu.', [], { _contexto: '', name: user.name, tom: prefs.tom || 'carinhoso', _systemOverride: systemSumico });
        if (!msg) { console.log(`[Sumiço] Rate limit, pulado para ${user.phone}`); continue; }
        await sendMessage(user.phone, msg);
        await prisma.memory.create({ data: { userId: user.id, type: 'sumico_lock', content: lockKey } });
        console.log(`[Sumiço] ${user.phone} — ${diasSemConversa} dias sem conversar`);
      } catch (e) { console.error(`[Sumiço] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Sumiço] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });
// RESUMO DO MEIO-DIA (12:00)
cron.schedule('0 12 * * *', async () => {
  try {
    const now = nowBRT();
    const hoje = dateBRT(now);
    const users = await prisma.user.findMany({ where: { blocked: false } });
    for (const user of users) {
      try {
        // ── Lock atômico ──
        // Bug corrigido: o lock antigo (findFirst + create DEPOIS de
        // enviar) tinha a mesma falha de corrida já corrigida em outros
        // crons hoje (Fechamento, Sexta, Domingo, Bom dia, Boa noite) —
        // se o cron disparasse em paralelo (deploy reiniciando, múltiplas
        // réplicas no mesmo minuto), as duas execuções passavam pela
        // checagem ANTES de qualquer uma criar o lock, mandando a mesma
        // mensagem 2-3x com textos levemente diferentes (cada chamada de
        // IA gera uma variação). tentarLockDiario marca o lock ANTES de
        // gerar/enviar, então só a execução que "ganhar" o lock segue.
        if (!(await tentarLockDiario(user.id, 'meio_dia_lock'))) {
          console.log(`[Meio-dia] ja enviado/processando hoje para ${user.phone}`);
          continue;
        }
        const inicioDia = new Date(`${hoje}T00:00:00-03:00`);
        const meioDia = new Date(`${hoje}T12:00:00-03:00`);
        const pendentes = await prisma.reminder.findMany({
          where: { userId: user.id, sent: true, confirmed: false, scheduledAt: { gte: inicioDia, lt: meioDia } }
        });
        if (!pendentes.length) continue;
        const prefs = await memory.getUserPreference(user.id).catch(() => null);
        const listaPendentes = pendentes.map(r => {
          const h = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
          return `• ${h} — ${r.message}`;
        }).join('\n');
        const systemMeioDia = `Você é a Clara, assistente pessoal. ${user.name ? `O nome do usuário é ${user.name}.` : ''}
São 12h do dia. O usuário tem ${pendentes.length} tarefa(s) da manhã que ainda não foram marcadas como concluídas:
${listaPendentes}
Envie uma mensagem curta e natural (2-3 linhas) perguntando se conseguiu fazer alguma dessas tarefas — sem ser cobrador(a), sem listar formalmente, com leveza.
Diga que pode dar baixa ou remarcar.
IMPORTANTE: você está falando com UMA pessoa só, no singular — NUNCA use "pessoal", "vocês", "galera" ou qualquer tratamento de grupo.
Tom: ${prefs?.tom || 'carinhoso'}.`;
        const msg = await freeResponse('Mensagem de meio-dia.', [], {
          _contexto: '', name: user.name, tom: prefs?.tom || 'carinhoso', _systemOverride: systemMeioDia
        });
        if (!msg) continue;
        await sendMessage(user.phone, msg);
        console.log(`[Meio-dia] Enviado para ${user.phone}`);
      } catch(e) { console.error('[Meio-dia]', e.message); }
    }
  } catch(e) { console.error('[Meio-dia] Erro:', e.message); }
}, { timezone: 'America/Sao_Paulo' });
// FECHAMENTO DO DIA (18:00)
cron.schedule('0 18 * * *', async () => {
  try {
    const now = nowBRT();
    // Nas sextas, o cron "Parabéns da Semana" (18:00) já cobre o dia com
    // visão semanal — rodar o Fechamento também faria duas mensagens
    // seguidas no mesmo minuto. Pula sexta aqui, mantendo só a semanal.
    if (now.getDay() === 5) { console.log('[Fechamento] Pulado (sexta — coberto pelo resumo semanal)'); return; }
    const hoje = dateBRT(now);
    const lockKey = `fechamento_${hoje}`;
    const jaEnviou = await prisma.memory.findFirst({ where: { type: lockKey } });
    if (jaEnviou) { console.log('[Fechamento] já enviado hoje'); return; }
    await prisma.memory.create({ data: { userId: 'system', type: lockKey, content: '1' } }).catch(() => {});
    const users = await prisma.user.findMany({ where: { blocked: false } });
    for (const user of users) {
      try {
        const lockUser = `fechamento_user_${hoje}`;
        const jaEnviouUser = await prisma.memory.findFirst({ where: { userId: user.id, type: lockUser } });
        if (jaEnviouUser) continue;
        await prisma.memory.create({ data: { userId: user.id, type: lockUser, content: new Date().toISOString() } });
        const inicioDia = new Date(`${hoje}T00:00:00-03:00`);
        const fimTarde = new Date(`${hoje}T18:00:00-03:00`);
        const pendentes = await prisma.reminder.findMany({
          where: { userId: user.id, sent: true, confirmed: false, scheduledAt: { gte: inicioDia, lte: fimTarde } },
          orderBy: { scheduledAt: 'asc' }
        });
        const concluidos = await prisma.reminder.findMany({
          where: { userId: user.id, confirmed: true, scheduledAt: { gte: inicioDia, lte: fimTarde } }
        });
        if (!pendentes.length && !concluidos.length) continue;
        const prefs = await memory.getUserPreference(user.id).catch(() => null);
        const listaPendentes = pendentes.map((r, i) => {
          const h = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
          return `${i + 1}. ${h} — ${r.message}`;
        }).join('\n');
        // ── Mensagem breve e ACIONÁVEL ──
        // Pedido explícito do usuário: parabéns curto + lista de pendentes
        // + oferta real de "posso concluir todos?" ou remarcar — não só
        // uma frase bonita, a resposta dele precisa disparar uma ação de
        // verdade (ver branch 'fechamento_pendentes' em checkConfirmacaoPendente,
        // handler.js).
        const systemFechamento = `Você é a Clara, parceira pessoal. ${user.name ? `O nome do usuário é ${user.name}.` : ''}
São 18h. Resumo do dia:
- Concluídos hoje: ${concluidos.length}
- Pendentes (${pendentes.length}):
${listaPendentes || '(nenhum pendente)'}
Envie uma mensagem BREVE (2-3 linhas, direto):
- Parabenize rapidamente pelos concluídos (se houver)
- Se houver pendentes, pergunte de forma simples e direta: "posso concluir todos, ou me fala quais quer remarcar?" (adapte as palavras ao seu tom, mas mantenha essa pergunta objetiva no final)
- Se não houver pendentes, só celebre, sem inventar pergunta
- NÃO liste os itens formalmente no texto (já estão registrados, você só precisa saber que existem) — a pergunta de ação é o que importa
Tom: ${prefs?.tom || 'carinhoso'}.`;
        const msg = await freeResponse('Mensagem de fechamento do dia.', [], {
          _contexto: '', name: user.name, tom: prefs?.tom || 'carinhoso', _systemOverride: systemFechamento
        });
        if (!msg) { console.log(`[Fechamento] Rate limit, pulado para ${user.phone}`); continue; }
        await sendMessage(user.phone, msg);
        if (pendentes.length > 0) {
          await prisma.memory.create({
            data: {
              userId: user.id, type: 'confirmacao_pendente',
              content: JSON.stringify({
                tipo: 'fechamento_pendentes',
                reminderIds: pendentes.map(r => r.id),
                expira: Date.now() + 3 * 60 * 60 * 1000, // 3h de validade
              }),
            },
          });
        }
        console.log(`[Fechamento] Enviado para ${user.phone}`);
      } catch (e) { console.error(`[Fechamento] Erro ${user.phone}:`, e.message); }
    }
  } catch (e) { console.error('[Fechamento] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });
// LEMBRETES (a cada minuto)
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const reminders = await prisma.reminder.findMany({
      where: { sent: false, confirmed: false, scheduledAt: { lte: now } },
      orderBy: { scheduledAt: 'asc' }
    });
    if (!reminders.length) return;
    const grupos = {};
    for (const r of reminders) {
      const hora = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
      const key = `${r.phone}_${hora}`;
      if (!grupos[key]) grupos[key] = { phone: r.phone, hora, reminders: [] };
      grupos[key].reminders.push(r);
    }
    for (const key of Object.keys(grupos)) {
      const grupo = grupos[key];

      // ── Verificação de cancelamento por confirmação ──
      // Antes de processar QUALQUER item do grupo, separa os follow-ups
      // (prefixo __followup_origem__ID__) cujo lembrete original já foi
      // confirmado — esses são cancelados (deletados, nunca enviados) em
      // vez de disparados. Resolve: usuário confirma no lembrete original
      // OU no follow-up de 15min → o follow-up de 2h não chega depois.
      const reminderesParaEnviar = [];
      for (const r of grupo.reminders) {
        const matchOrigem = r.message.match(/^__followup_origem__([^_]+)__/);
        if (matchOrigem) {
          const idOriginal = matchOrigem[1];
          const original = await prisma.reminder.findUnique({ where: { id: idOriginal } }).catch(() => null);
          if (!original || original.confirmed) {
            await prisma.reminder.delete({ where: { id: r.id } }).catch(() => {});
            console.log(`[Follow-up] Cancelado (original já confirmado): "${r.message.slice(0, 60)}"`);
            continue;
          }
        }
        reminderesParaEnviar.push(r);
      }
      if (!reminderesParaEnviar.length) continue;
      grupo.reminders = reminderesParaEnviar;

      // ── Claim atômico (evita envio duplicado) ──
      // Antes deste fix: o "sent: true" só era gravado no FINAL do
      // processamento do grupo (depois de gerar mensagem, criar follow-ups
      // etc). Como o cron roda a cada minuto, se uma execução demorasse
      // mais que 1min (comum quando entra fallback de IA), a execução
      // seguinte pegava o MESMO lembrete ainda com sent:false e mandava de
      // novo — causando duplicidade (3 envios do mesmo lembrete, cada um
      // com uma variação aleatória de finais[]). Agora "reivindicamos" cada
      // lembrete individualmente ANTES de processar: só os que este
      // processo realmente conseguiu marcar como sent:true (ninguém mais
      // chegou primeiro) seguem adiante.
      const claimados = [];
      for (const r of grupo.reminders) {
        const resultado = await prisma.reminder.updateMany({
          where: { id: r.id, sent: false },
          data: { sent: true }
        });
        if (resultado.count === 1) claimados.push(r);
      }
      if (!claimados.length) continue;
      grupo.reminders = claimados;

      let msg;
      try {
        const user = await prisma.user.findFirst({ where: { phone: grupo.phone } });
        const prefs = user ? await memory.getUserPreference(user.id).catch(() => null) : null;
        const nome = prefs?.name || user?.name || null;
        const isFollowup = grupo.reminders.length === 1 && /^__followup(_origem__[^_]+__)?__/.test(grupo.reminders[0].message);
        if (isFollowup) {
          msg = grupo.reminders[0].message.replace(/^__followup(_origem__[^_]+__)?__/, '');
        } else if (grupo.reminders.length === 1) {
          const r = grupo.reminders[0];
          msg = `🔔 Lembrete\n\n${r.message}\n⏰ ${grupo.hora}\n\n${random(finais)}`;
        } else {
          // Múltiplos lembretes na mesma janela — numera cada um (1, 2...)
          // para que o usuário consiga confirmar/concluir um específico
          // sem ambiguidade (ex: "feito o 1", "concluído 2").
          const titulos = grupo.reminders.map((r, i) => `${i + 1}. ${r.message}`).join('\n');
          msg = `🔔 Você tem ${grupo.reminders.length} lembretes agora\n\n${titulos}\n\n⏰ ${grupo.hora}\n\n${random(finais)}`;
        }
      } catch(e) {
        msg = grupo.reminders.length === 1
          ? `🔔 Lembrete\n\n${grupo.reminders[0].message}\n⏰ ${grupo.hora}\n\n${random(finais)}`
          : `🔔 Você tem ${grupo.reminders.length} lembretes agora\n\n${grupo.reminders.map((r, i) => `${i + 1}. ${r.message}`).join('\n')}\n\n⏰ ${grupo.hora}\n\n${random(finais)}`;
      }
      await sendMessage(grupo.phone, msg);
      for (const r of grupo.reminders) {
        try {
          const isUrgente = await prisma.memory.findFirst({ where: { type: 'lembrete_urgente', content: r.id } });
          if (!isUrgente) continue;
          const user = await prisma.user.findFirst({ where: { phone: grupo.phone } });
          const prefs = user ? await memory.getUserPreference(user.id).catch(() => null) : null;
          const quinzeAntes = new Date(r.scheduledAt.getTime() - 15 * 60 * 1000);
          if (quinzeAntes > new Date()) {
            const jaTemAntes = await prisma.memory.findFirst({ where: { type: 'urgente_antes_lock', content: r.id } });
            if (!jaTemAntes) {
              await prisma.reminder.create({
                data: { userId: r.userId, phone: grupo.phone, message: `⚡ Em 15 minutos: ${r.message}`, scheduledAt: quinzeAntes }
              });
              await prisma.memory.create({ data: { userId: r.userId, type: 'urgente_antes_lock', content: r.id } });
            }
          }
          const quinzeDepois = new Date(r.scheduledAt.getTime() + 15 * 60 * 1000);
          const jaTemDepois = await prisma.memory.findFirst({ where: { type: 'urgente_followup_lock', content: r.id } });
          if (!jaTemDepois) {
            const systemFollowup = `Você é a Clara, parceira pessoal. Tom: ${tomDesc(prefs?.tom)}.
O usuário tinha um compromisso urgente: "${r.message}".
Já passou 15 minutos. Pergunte de forma natural, breve (1 linha) e DELICADA se já conseguiu fazer — algo como "me avisa quando concluir, por favor" — sem forçar resposta sim/não, é só uma cobrança gentil de segunda vez.
Respeite o tom — sarcástica não pergunta com fofice, mas ainda assim sem ser ríspida.`;
            let msgFollowup = await freeResponse('Pergunta de follow-up.', [], {
              _systemOverride: systemFollowup, tom: prefs?.tom || 'carinhoso'
            }).catch(() => `Me avisa quando concluir "${r.message}", por favor 😊`);
            if (!msgFollowup) msgFollowup = `Me avisa quando concluir "${r.message}", por favor 😊`;
            // Prefixo __followup_origem__ID__ guarda o ID do lembrete
            // original — usado na verificação de cancelamento no início
            // do processamento deste mesmo cron (acima).
            await prisma.reminder.create({
              data: { userId: r.userId, phone: grupo.phone, message: `__followup_origem__${r.id}__${msgFollowup}`, scheduledAt: quinzeDepois }
            });
            await prisma.memory.create({ data: { userId: r.userId, type: 'urgente_followup_lock', content: r.id } });
          }
          // ── Follow-up "como foi?" — 2h depois ──
          // Só é enviado se o lembrete original AINDA NÃO foi confirmado
          // até aquele momento (checagem feita no início do processamento
          // deste cron, via prefixo __followup_origem__). Se o usuário já
          // confirmou (no lembrete original ou no follow-up de 15min),
          // este follow-up de 2h é cancelado automaticamente sem enviar.
          const duasHorasDepois = new Date(r.scheduledAt.getTime() + 2 * 60 * 60 * 1000);
          const jaTemResultado = await prisma.memory.findFirst({ where: { type: 'urgente_resultado_lock', content: r.id } });
          if (!jaTemResultado) {
            const systemResultado = `Você é a Clara, parceira pessoal. Tom: ${tomDesc(prefs?.tom)}.
O usuário tinha um compromisso importante há 2 horas: "${r.message}".
Pergunte de forma natural e breve (1 linha) como foi / se deu tudo certo — não pergunte só "conseguiu fazer", pergunte sobre o RESULTADO (ex: "como foi a consulta?", "deu tudo certo na reunião?").
Respeite o tom — sarcástica não pergunta com fofice.`;
            let msgResultado = await freeResponse('Pergunta sobre resultado do compromisso.', [], {
              _systemOverride: systemResultado, tom: prefs?.tom || 'carinhoso'
            }).catch(() => `Oi! Como foi "${r.message}"? Deu tudo certo? 😊`);
            if (!msgResultado) msgResultado = `Oi! Como foi "${r.message}"? Deu tudo certo? 😊`;
            await prisma.reminder.create({
              data: { userId: r.userId, phone: grupo.phone, message: `__followup_origem__${r.id}__${msgResultado}`, scheduledAt: duasHorasDepois }
            });
            await prisma.memory.create({ data: { userId: r.userId, type: 'urgente_resultado_lock', content: r.id } });
          }
        } catch(e) { console.error(`[Urgência] Erro ${r.id}:`, e.message); }
      }
      for (const r of grupo.reminders) {
        if (r.recorrente && r.frequencia) {
          try {
            const proxima = new Date(r.scheduledAt);
            if (r.frequencia === 'diario') proxima.setDate(proxima.getDate() + 1);
            else if (r.frequencia === 'semanal') proxima.setDate(proxima.getDate() + 7);
            else if (r.frequencia === 'mensal') proxima.setMonth(proxima.getMonth() + 1);
            if (proxima > new Date()) {
              await prisma.reminder.create({
                data: {
                  userId: r.userId,
                  phone: r.phone,
                  message: r.message,
                  scheduledAt: proxima,
                  recorrente: true,
                  frequencia: r.frequencia,
                  sent: false,
                  confirmed: false,
                }
              });
              console.log(`[Recorrência] Recriado: "${r.message}" → ${proxima.toISOString()}`);
            }
          } catch(e) { console.error(`[Recorrência] Erro ao recriar lembrete ${r.id}:`, e.message); }
        }
      }
      await prisma.reminder.updateMany({
        where: { id: { in: grupo.reminders.map(r => r.id) } },
        data: { sent: true }
      });
      console.log(`[Reminder] ${grupo.phone} → ${grupo.reminders.length} lembrete(s)`);
    }
  } catch (e) { console.error('[Reminder] Erro:', e.message); }
}, { timezone: 'America/Sao_Paulo' });
// MEDICAMENTOS (a cada minuto)
cron.schedule('* * * * *', async () => {
  try {
    const nowLocal = nowBRT();
    const minutoChave = `${pad(nowLocal.getHours())}:${pad(nowLocal.getMinutes())}`;
    const meds = await prisma.medication.findMany({ where: { active: true, remaining: { gt: 0 } }, include: { user: true } });

    // ── Agrupamento por telefone ──
    // Bug de UX corrigido: antes, cada remédio gerava sua PRÓPRIA mensagem
    // completa ("Hora do medicamento! ... Não esquece de tomar certinho...
    // Responde tomei..."), então se dois remédios batiam no mesmo horário
    // (ex: 07:00), o usuário recebia duas mensagens quase idênticas
    // seguidas — poluição visual sem necessidade, já que todos os
    // medicamentos processados NESTE tick do cron compartilham o mesmo
    // minutoChave (mesmo horário). Agora juntamos numa mensagem só por
    // telefone, ainda criando uma pendência de confirmação POR remédio
    // (necessário pro controle individual de estoque/follow-up).
    const porTelefone = {};
    for (const med of meds) {
      try {
        let horarios = []; try { horarios = JSON.parse(med.times || '[]'); } catch {}
        if (!horarios.includes(minutoChave)) continue;
        const phone = med.user?.phone || (await prisma.user.findUnique({ where: { id: med.userId } }))?.phone;
        if (!phone) continue;
        const lockKey = `med_${med.id}_${minutoChave}`;
        const lockExistente = await prisma.memory.findFirst({
          where: { type: 'med_lock', content: lockKey },
          orderBy: { createdAt: 'desc' }
        });
        if (lockExistente) {
          const ageMs = Date.now() - new Date(lockExistente.createdAt).getTime();
          if (ageMs < 120000) continue;
          await prisma.memory.delete({ where: { id: lockExistente.id } }).catch(() => {});
          console.log(`[Med] Lock expirado removido: ${lockKey}`);
        }
        await prisma.memory.create({ data: { userId: med.userId, type: 'med_lock', content: lockKey } });
        if (!porTelefone[phone]) porTelefone[phone] = [];
        porTelefone[phone].push(med);
      } catch (e) { console.error(`[Med] Erro ${med.id}:`, e.message); }
    }

    for (const [phone, medsDoTelefone] of Object.entries(porTelefone)) {
      try {
        let msg;
        if (medsDoTelefone.length === 1) {
          const med = medsDoTelefone[0];
          msg = `💊 Hora do medicamento!\n\n*${med.name}*\n⏰ ${minutoChave}\n\nNão esquece de tomar certinho 😊\n\nResponde "tomei" quando tomar, combinado?`;
        } else {
          const lista = medsDoTelefone.map(m => `• ${m.name}`).join('\n');
          msg = `💊 Hora do medicamento!\n\n⏰ ${minutoChave} — você tem ${medsDoTelefone.length} remédios agora:\n${lista}\n\nNão esquece de tomar certinho 😊\n\nResponde "tomei [nome]" pra cada um conforme for tomando, combinado?`;
        }
        await sendMessage(phone, msg);
        const meiaNoite = new Date(nowLocal); meiaNoite.setHours(23, 59, 59, 999);
        for (const med of medsDoTelefone) {
          // ── NÃO decrementa remaining aqui ──
          // Bug corrigido: antes a dose era descontada automaticamente só
          // por o alarme ter disparado, SEM nenhuma confirmação real do
          // usuário — fazia o Dashboard mostrar "tomado" mesmo quando nunca
          // foi. Pior: se o usuário também respondesse "tomei" depois, ou
          // clicasse "Marcar como tomado" no Dashboard, a mesma dose era
          // descontada de novo (até 2-3x). Agora só decrementa quando há
          // confirmação real (webhook.js, resposta "tomei", ou botão do
          // Dashboard) — aqui só registramos a pendência de confirmação.
          await prisma.memory.create({
            data: {
              userId: med.userId, type: 'confirmacao_pendente',
              content: JSON.stringify({
                tipo: 'remedio_dose', medId: med.id, medNome: med.name, horario: minutoChave,
                expira: meiaNoite.getTime(), nudgeEnviado: false,
              }),
            },
          });
          console.log(`[Med] ${med.name} → ${phone} (aguardando confirmação)`);
        }
      } catch (e) { console.error(`[Med] Erro ao enviar pra ${phone}:`, e.message); }
    }
  } catch (e) { console.error('[Med] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });
// MENSAGENS AGENDADAS PARA CONTATOS (a cada minuto)
cron.schedule('* * * * *', async () => {
  try {
    const now = nowBRT();
    const msgs = await prisma.scheduledMessage.findMany({
      where: { sent: false, scheduledAt: { lte: now } },
      orderBy: { scheduledAt: 'asc' }
    });
    for (const msg of msgs) {
      try {
        const userRemetente = await prisma.user.findFirst({ where: { phone: msg.fromPhone } });
        const nomeRemetente = userRemetente?.name || 'seu contato';
        const foneFormatado = msg.fromPhone.replace('55', '').replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
        const msgFormatada = `Oi! Sou a Clara, secretária virtual do ${nomeRemetente}. Ele(a) pediu pra enviar esse recado:\n\n_${msg.message}_\n\nNão precisa me responder, tá? Dúvidas, é só chamar no WhatsApp do ${nomeRemetente}: ${foneFormatado} 😊`;
        await sendMessage(msg.toPhone, msgFormatada);
        await prisma.scheduledMessage.update({ where: { id: msg.id }, data: { sent: true } });
        const horaBRT = new Date(msg.scheduledAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
        await sendMessage(msg.fromPhone, `✅ Mensagem enviada para *${msg.toName || msg.toPhone}* às ${horaBRT}! 📤`);
        console.log(`[Msg Agendada] Enviada: ${msg.toName || msg.toPhone}`);
      } catch (e) { console.error(`[Msg Agendada] Erro msg ${msg.id}:`, e.message); }
    }
  } catch (e) { console.error('[Msg Agendada] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });
// FINALIZA LEMBRETES COM HORÁRIO PENDENTE (timeout) — a cada minuto
// Quando a Clara pergunta "que horas devo colocar?" (tipo: hora_lembrete em
// confirmacao_pendente) e o usuário não responde até expirar, cria o
// lembrete com horário provisório 09:00 e avisa que pode ser alterado.
cron.schedule('* * * * *', async () => {
  try {
    const pendentes = await prisma.memory.findMany({
      where: { type: 'confirmacao_pendente' }
    });
    for (const p of pendentes) {
      try {
        let dados;
        try { dados = JSON.parse(p.content); } catch { continue; }
        if (dados.tipo === 'remedio_dose') {
          // Pendência de confirmação de remédio expirada (virou meia-noite
          // sem resposta) — NÃO assume que foi tomado. Decisão deliberada:
          // silenciosamente assumir "tomado" por padrão esconderia
          // esquecimentos reais, que é justamente o que mais importa saber
          // quando o assunto é remédio. Só encerra a espera e remove a
          // pendência; o estoque (remaining) permanece intacto.
          if (Date.now() <= dados.expira) continue;
          await prisma.memory.delete({ where: { id: p.id } }).catch(() => {});
          console.log(`[Remédio] Dose não confirmada (expirou sem resposta): ${dados.medNome} às ${dados.horario}`);
          continue;
        }
        if (dados.tipo !== 'hora_lembrete') continue;
        if (Date.now() <= dados.expira) continue; // ainda não expirou
        const user = await prisma.user.findUnique({ where: { id: p.userId } }).catch(() => null);
        if (!user?.phone) { await prisma.memory.delete({ where: { id: p.id } }).catch(() => {}); continue; }
        const scheduledAt = new Date(`${dados.data}T09:00:00-03:00`);
        await prisma.reminder.create({ data: { userId: user.id, phone: user.phone, message: dados.titulo, scheduledAt } });
        await prisma.memory.delete({ where: { id: p.id } }).catch(() => {});
        const dataFmt = scheduledAt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
        await sendMessage(user.phone, `⏰ Não me respondeu o horário, então deixei "${dados.titulo}" pra ${dataFmt} às 09:00 (provisório). Pode me dizer o horário certo a qualquer momento que eu remarco 😊`);
        console.log(`[HoraLembrete] Finalizado com 09:00 provisório: "${dados.titulo}" → ${user.phone}`);
      } catch (e) { console.error(`[HoraLembrete] Erro pendente ${p.id}:`, e.message); }
    }
  } catch (e) { console.error('[HoraLembrete] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });
// ── FOLLOW-UP DE REMÉDIO 20 MINUTOS — REMOVIDO ──
// Decisão: remédio é rotina diária, não um evento pontual como consulta
// ou prazo — cobrar de novo 20min depois do alarme original (que já pediu
// "responde tomei quando tomar") é repetitivo e cansativo no dia a dia.
// O mecanismo de cobrança em camadas (15min/2h) continua existindo, só
// que reservado pra urgências de verdade (ver detectarUrgencia em
// handler.js, que não inclui mais remédio/farmácia/medicamento desde o
// ajuste anterior). A confirmação do remédio agora depende só da
// iniciativa do usuário (responder "tomei") ou do botão no Dashboard —
// sem nudge automático. A pendência ainda expira normalmente à meia-noite
// sem decrementar (ver cron "FINALIZA LEMBRETES COM HORÁRIO PENDENTE").
// LIMPEZA DE LOCKS ANTIGOS (03:00)
cron.schedule('0 3 * * *', async () => {
  try {
    const ontem = new Date(nowBRT()); ontem.setDate(ontem.getDate() - 2);
    await prisma.memory.deleteMany({
      where: {
        type: { in: ['med_lock', 'alerta_data_lock', 'proativa_lock', 'sumico_lock', 'bom_dia_lock', 'boa_noite_lock', 'meio_dia_lock', 'meu_dia_criado', 'urgente_resultado_lock', 'radar_lock'] },
        createdAt: { lt: ontem }
      }
    });
    console.log('[Cleanup] Locks antigos removidos');
  } catch (e) { console.error('[Cleanup] Erro:', e.message); }
}, { timezone: 'America/Sao_Paulo' });
// LIMPEZA DE PENDÊNCIAS EMOCIONAIS ANTIGAS (03:00)
// Pendências resolvidas ou perguntadas (respondidas ou não) com mais de
// 3 dias não fazem mais sentido manter — evita a tabela crescer indefinidamente
// e evita reabrir um assunto que já ficou velho demais pra cobrar.
cron.schedule('0 3 * * *', async () => {
  try {
    const limite = new Date(nowBRT().getTime() - 3 * 24 * 60 * 60 * 1000);
    const resultado = await prisma.pendencia.deleteMany({
      where: { createdAt: { lt: limite }, OR: [{ resolvido: true }, { perguntado: true }] }
    });
    if (resultado.count > 0) {
      console.log(`[Cleanup Pendências] ${resultado.count} pendência(s) antiga(s) removida(s)`);
    }
  } catch (e) { console.error('[Cleanup Pendências] Erro:', e.message); }
}, { timezone: 'America/Sao_Paulo' });
// Limpeza de med_lock a cada hora
cron.schedule('0 * * * *', async () => {
  try {
    const doisMinutosAtras = new Date(Date.now() - 2 * 60 * 1000);
    const resultado = await prisma.memory.deleteMany({
      where: { type: 'med_lock', createdAt: { lt: doisMinutosAtras } }
    });
    if (resultado.count > 0) console.log(`[Cleanup Med Locks] ${resultado.count} locks removidos`);
  } catch (e) { console.error('[Cleanup Med Locks] Erro:', e.message); }
}, { timezone: 'America/Sao_Paulo' });
// LIMPEZA DE LEMBRETES NÃO CONFIRMADOS > 48h (04:00)
cron.schedule('0 4 * * *', async () => {
  try {
    const limite = new Date(nowBRT().getTime() - 48 * 60 * 60 * 1000);
    const resultado = await prisma.reminder.deleteMany({
      where: { confirmed: false, scheduledAt: { lt: limite } }
    });
    if (resultado.count > 0) {
      console.log(`[Cleanup Lembretes] ${resultado.count} lembrete(s) não confirmados com mais de 48h removidos`);
    }
  } catch (e) { console.error('[Cleanup Lembretes] Erro:', e.message); }
}, { timezone: 'America/Sao_Paulo' });
// ALERTA ESTOQUE BAIXO DE REMÉDIO (08:30)
cron.schedule('30 8 * * *', async () => {
  try {
    const LIMITE_DOSES = 5;
    const meds = await prisma.medication.findMany({
      where: { active: true, remaining: { gt: 0, lte: LIMITE_DOSES } },
      include: { user: true }
    });
    for (const med of meds) {
      try {
        const phone = med.user?.phone || (await prisma.user.findUnique({ where: { id: med.userId } }))?.phone;
        if (!phone) continue;
        const lockKey = `estoque_baixo_${med.id}_${dateBRT()}`;
        if (await prisma.memory.findFirst({ where: { type: 'estoque_lock', content: lockKey } })) continue;
        await prisma.memory.create({ data: { userId: med.userId, type: 'estoque_lock', content: lockKey } });
        const urgencia = med.remaining === 1 ? '🚨 Última dose!' : `⚠️ Restam apenas ${med.remaining} doses`;
        await sendMessage(phone,
          `💊 ${urgencia}\n\n*${med.name}* está acabando.\n\nNão esquece de comprar mais para não interromper o tratamento! 🏥`
        );
        console.log(`[Estoque] Alerta enviado: ${med.name} → ${phone} (${med.remaining} doses)`);
      } catch (e) { console.error(`[Estoque] Erro ${med.id}:`, e.message); }
    }
  } catch (e) { console.error('[Estoque] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });
// PARCEIRA — avisa 30min antes, mas APENAS se detectar urgência no lembrete
// (médico, reunião, voo, consulta, prazo, etc). Lembretes simples/rotineiros
// não precisam de aviso antecipado — evita excesso de mensagens.
cron.schedule('* * * * *', async () => {
  try {
    const now = nowBRT();
    const em30min = new Date(now.getTime() + 30 * 60 * 1000);
    const em31min = new Date(now.getTime() + 31 * 60 * 1000);
    const proximos = await prisma.reminder.findMany({
      where: {
        sent: false,
        confirmed: false,
        scheduledAt: { gte: em30min, lt: em31min }
      }
    });
    if (!proximos.length) return;
    // Palavras que indicam urgência/importância — só avisa 30min antes
    // quando o lembrete tem pelo menos uma dessas.
    const URGENCIA_RE = /medico|médico|médica|medica|consulta|dentista|cirurgia|exame|laboratorio|laboratório|farmacia|farmácia|vacina|hospital|clinica|clínica|psico|terapia|fisio|upa|reuniao|reunião|apresentacao|apresentação|entrevista|prova|concurso|voo|aeroporto|embarque|onibus|ônibus|trem|documento|cartorio|cartório|contrato|assinar|protocolar|prazo|vencimento|vence|renovar|passaporte|entrega|importante|urgente|cnh|rg/i;
    for (const r of proximos) {
      try {
        // Só envia se o lembrete for urgente/importante
        if (!URGENCIA_RE.test(r.message)) {
          console.log(`[Parceira] Pulado (sem urgência): "${r.message}"`);
          continue;
        }
        const lockKey = `parceira_${r.id}`;
        if (await prisma.memory.findFirst({ where: { type: 'parceira_lock', content: lockKey } })) continue;
        await prisma.memory.create({ data: { userId: r.userId, type: 'parceira_lock', content: lockKey } });
        const user = await prisma.user.findFirst({ where: { id: r.userId } });
        if (!user?.phone) continue;
        const prefs = await memory.getUserPreference(r.userId).catch(() => null);
        const nome = prefs?.name || user.name || null;
        const infoPessoal = await memory.buildPersonalContext(r.userId).catch(() => '');
        const hora = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', {
          timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit'
        });
        const systemParceira = `Você é a Clara, parceira pessoal do ${nome || 'usuário'} no WhatsApp.
Tom obrigatório: ${tomDesc(prefs?.tom)}
Daqui a 30 minutos ele(a) tem algo IMPORTANTE: "${r.message}" às ${hora}.
${infoPessoal ? `\nO que você sabe sobre ele(a):\n${infoPessoal}` : ''}
Envie UMA mensagem curta (1-2 linhas) como parceira presente:
- Mencione o compromisso de forma natural, respeitando seu tom
- Ofereça ajuda ESPECÍFICA para aquele contexto (ex: "precisa de alguma coisa antes de ir?")
- NÃO use "lembrete" ou "aviso" — seja natural
- NÃO agende nada novo
- Respeite rigorosamente o tom acima — não misture estilos
- NUNCA termine com "boa sorte", "boa tarde" ou saudação de período`;
        const msg = await freeResponse('Envie mensagem de parceira para o compromisso próximo.', [], {
          _contexto: '',
          name: nome,
          tom: prefs?.tom || 'carinhoso',
          _systemOverride: systemParceira
        });
        if (!msg || msg.length < 5) continue;
        await sendMessage(user.phone, msg);
        console.log(`[Parceira] ${user.phone} → "${r.message}" em 30min (urgente)`);
      } catch (e) { console.error(`[Parceira] Erro lembrete ${r.id}:`, e.message); }
    }
  } catch (e) { console.error('[Parceira] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });
// PENDÊNCIAS EMOCIONAIS — a Clara volta a perguntar sozinha sobre algo que
// o usuário mencionou antes (mal-estar passageiro, evento com resultado
// incerto) quando o prazo calculado na extração (extractPendenciaEmocional,
// groq.js) vence. É isso que faz parecer que ela "lembrou" por conta
// própria, em vez de só reagir quando o assunto é trazido de novo. A
// resposta do usuário é tratada no branch "pendencia_emocional" dentro de
// checkConfirmacaoPendente (handler.js).
cron.schedule('*/5 * * * *', async () => {
  try {
    const vencidas = await prisma.pendencia.findMany({
      where: { perguntado: false, resolvido: false, checkInAt: { lte: new Date() } },
      include: { user: true },
    });
    for (const p of vencidas) {
      try {
        // Marca perguntado=true ANTES de gerar/enviar — mesma lógica de
        // lock atômico usada nos outros crons (evita pergunta duplicada
        // se o cron disparar em paralelo).
        const ganhou = await prisma.pendencia.updateMany({
          where: { id: p.id, perguntado: false },
          data: { perguntado: true },
        });
        if (ganhou.count === 0) continue;

        const phone = p.user?.phone;
        if (!phone) continue;

        const prefs = await memory.getUserPreference(p.userId).catch(() => null);
        const nome = prefs?.name || p.user?.name || null;

        const instrucaoCategoria = p.categoria === 'saude'
          ? 'Pergunte se já melhorou ou já cuidou disso, com cuidado genuíno — não repita a frase exata de antes, varie.'
          : 'Pergunte como foi/deu, com curiosidade genuína de quem realmente se importa com o resultado.';

        const systemPendencia = `Você é a Clara, parceira pessoal do ${nome || 'usuário'} no WhatsApp.
Tom obrigatório: ${tomDesc(prefs?.tom)}
Mais cedo ele(a) mencionou: "${p.resumo}".
${instrucaoCategoria}
Envie UMA mensagem curta (1-2 linhas), natural, como quem realmente lembrou e se importou — NÃO use as palavras "lembrete" ou "pendência", NÃO liste tópicos, NÃO termine com saudação de período.`;

        const msg = await freeResponse('Pergunte de volta sobre o que a pessoa mencionou.', [], {
          _contexto: '', name: nome, tom: prefs?.tom || 'carinhoso', _systemOverride: systemPendencia,
        });

        if (!msg || msg.length < 5) {
          // Libera para tentar de novo no próximo ciclo em vez de perder
          // a pendência por uma falha temporária de geração.
          await prisma.pendencia.update({ where: { id: p.id }, data: { perguntado: false } }).catch(() => {});
          continue;
        }

        await sendMessage(phone, msg);
        // Expira em 24h: dá tempo do usuário responder sem pressa, mas
        // evita que uma resposta de dias depois seja interpretada como
        // reação a essa pergunta específica.
        await prisma.memory.create({
          data: {
            userId: p.userId, type: 'confirmacao_pendente',
            content: JSON.stringify({
              tipo: 'pendencia_emocional', pendenciaId: p.id, categoria: p.categoria,
              resumo: p.resumo, expira: Date.now() + 24 * 60 * 60 * 1000,
            }),
          },
        });
        console.log(`[Pendência] ${phone} ← follow-up sobre "${p.resumo}" (${p.categoria})`);
      } catch (e) { console.error(`[Pendência] Erro pendência ${p.id}:`, e.message); }
    }
  } catch (e) { console.error('[Pendência] Erro geral:', e.message); }
}, { timezone: 'America/Sao_Paulo' });

console.log('Clara scheduler iniciado 💜');
