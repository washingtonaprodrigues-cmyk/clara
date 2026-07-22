// Clara memory v7 — Clara 3.0: perfil rico + curiosidade orgânica

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ====================== HELPERS ======================

function parseDateSafely(date) {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  return d;
}

// ====================== USER ======================

async function getOrCreateUser(phone) {
  let user = await prisma.user.findUnique({ where: { phone } });
  if (!user) {
    user = await prisma.user.create({ data: { phone } });
    console.log(`👤 Nova usuária: ${phone}`);
  }
  return user;
}

// ====================== JORNADA ======================

async function saveJornada(userId, minutos) {
  return prisma.user.update({ where: { id: userId }, data: { jornadaMinutos: minutos } });
}

async function getJornada(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { jornadaMinutos: true } });
  return user?.jornadaMinutos || 480;
}

// ====================== PREFERÊNCIAS ======================

async function saveUserPreference(userId, name, tom, saldo = null) {
  const data = {};
  if (name && typeof name === 'string' && name.trim().length > 0) {
    data.name = name.trim();
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  let meta = {};
  if (user?.metadata) { try { meta = JSON.parse(user.metadata); } catch {} }
  if (tom && typeof tom === 'string' && tom.trim().length > 0) meta.tom = tom.trim();
  if (saldo !== null && saldo !== undefined && !isNaN(saldo)) meta.saldo = parseFloat(saldo);
  data.metadata = JSON.stringify(meta);
  return prisma.user.update({ where: { id: userId }, data });
}

async function getUserPreference(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { name: null, tom: 'carinhoso', saldo: null };
  let tom = 'carinhoso', saldo = null;
  if (user.metadata) {
    try {
      const m = JSON.parse(user.metadata);
      tom = m.tom || 'carinhoso';
      saldo = m.saldo !== undefined ? m.saldo : null;
    } catch {}
  }
  return { name: user.name, tom, saldo };
}

// ====================== MEMÓRIA PESSOAL RICA ======================
// Clara 3.0: categorias expandidas para conhecer o usuário de verdade.
// Cada categoria alimenta tanto o contexto da Clara quanto alertas proativos.

const PERSONAL_INFO_TYPE = 'info_pessoal';

// Categorias do perfil rico — usadas pelo extractPersonalInfo (groq.js)
// e exibidas no Dashboard > Memórias com labels amigáveis
const CATEGORIAS_PERFIL = {
  familia:              { label: '👨‍👩‍👧 Família',                  emoji: '👨‍👩‍👧' },
  relacionamento:       { label: '❤️ Relacionamento',             emoji: '❤️' },
  filhos:               { label: '👶 Filhos',                     emoji: '👶' },
  trabalho:             { label: '💼 Trabalho',                   emoji: '💼' },
  hobbies:              { label: '🎯 Hobbies',                    emoji: '🎯' },
  entretenimento:       { label: '🎬 Entretenimento',             emoji: '🎬' },
  alimentacao:          { label: '🍔 Alimentação',                emoji: '🍔' },
  metas:                { label: '🎯 Metas',                      emoji: '🎯' },
  personalidade:        { label: '✨ Personalidade',              emoji: '✨' },
  saude:                { label: '💊 Saúde (dele)',               emoji: '💊' },
  saude_familia:        { label: '🏥 Saúde da Família',          emoji: '🏥' },
  datas:                { label: '📅 Datas importantes',          emoji: '📅' },
  rotina:               { label: '⏰ Rotina',                     emoji: '⏰' },
  objetivos:            { label: '🚀 Objetivos',                  emoji: '🚀' },
  referencias_compartilhadas: { label: '🤝 Referências & Piadas', emoji: '🤝' },
  relacionamento_clara: { label: '💜 Relação com a Clara',        emoji: '💜' },
  outro:                { label: '📌 Informações gerais',         emoji: '📌' },
};

// Campos que a Clara ainda não conhece e pode perguntar organicamente.
// Cada item tem: categoria, pergunta natural, e quando faz sentido perguntar.
// Usado pelo sistema de curiosidade orgânica no groq.js.
const CAMPOS_CURIOSIDADE = [
  // Família / Relacionamento
  { chave: 'conjuge',         categoria: 'relacionamento',  pergunta: 'você é casado(a) ou tem namorado(a)?',                    contexto: 'qualquer' },
  { chave: 'aniversario_relacionamento', categoria: 'relacionamento', pergunta: 'quando é o aniversário de vocês juntos?',        contexto: 'relacionamento' },
  { chave: 'filhos_nomes',    categoria: 'filhos',          pergunta: 'você tem filhos?',                                        contexto: 'qualquer' },
  { chave: 'filhos_idades',   categoria: 'filhos',          pergunta: 'quantos anos tem seu(s) filho(s)?',                       contexto: 'filhos' },
  // Trabalho
  { chave: 'empresa',         categoria: 'trabalho',        pergunta: 'em qual empresa você trabalha?',                          contexto: 'trabalho' },
  { chave: 'cargo',           categoria: 'trabalho',        pergunta: 'qual é o seu cargo?',                                     contexto: 'trabalho' },
  { chave: 'chefe',           categoria: 'trabalho',        pergunta: 'como é seu chefe? te dá espaço ou é mais controlador?',   contexto: 'trabalho' },
  // Entretenimento
  { chave: 'time_futebol',    categoria: 'entretenimento',  pergunta: 'você torce pra algum time de futebol?',                   contexto: 'qualquer' },
  { chave: 'series_favoritas', categoria: 'entretenimento', pergunta: 'tem alguma série que você está assistindo agora?',        contexto: 'lazer' },
  { chave: 'filmes_favoritos', categoria: 'entretenimento', pergunta: 'que tipo de filme você mais curte?',                     contexto: 'lazer' },
  { chave: 'musica_genero',   categoria: 'entretenimento',  pergunta: 'que tipo de música você mais ouve?',                     contexto: 'lazer' },
  // Hobbies
  { chave: 'hobby_principal', categoria: 'hobbies',         pergunta: 'o que você curte fazer quando está de folga?',            contexto: 'qualquer' },
  { chave: 'esporte',         categoria: 'hobbies',         pergunta: 'você pratica algum esporte ou academia?',                 contexto: 'saude' },
  // Alimentação
  { chave: 'comida_favorita', categoria: 'alimentacao',     pergunta: 'qual é sua comida favorita?',                            contexto: 'qualquer' },
  { chave: 'restricao_alimentar', categoria: 'alimentacao', pergunta: 'você tem alguma restrição alimentar?',                   contexto: 'saude' },
  // Personalidade
  { chave: 'signo',           categoria: 'personalidade',   pergunta: 'qual é o seu signo?',                                    contexto: 'qualquer' },
  { chave: 'introvertido_extrovertido', categoria: 'personalidade', pergunta: 'você se considera mais introvertido ou extrovertido?', contexto: 'qualquer' },
  // Metas
  { chave: 'meta_principal',  categoria: 'metas',           pergunta: 'qual é o seu maior objetivo agora?',                     contexto: 'qualquer' },
  { chave: 'meta_financeira', categoria: 'metas',           pergunta: 'você tem alguma meta financeira que está perseguindo?',  contexto: 'financeiro' },
];

async function savePersonalInfo(userId, chave, valor, categoria = 'outro', duracao = 'permanente') {
  // FILTRO HARD: nunca salvar info pessoal / referência compartilhada de
  // conteúdo íntimo/sexual. Cobre o caso de "referencias_compartilhadas" ou
  // qualquer categoria capturar uma conversa íntima de ontem e a Clara trazer
  // isso por iniciativa (bom dia, proativa). A instrução no prompt não basta —
  // esse bloqueio no código é a rede final.
  const textoCheck = `${chave || ''} ${valor || ''}`.toLowerCase();
  const FILTRO_INTIMO = /erótic|erotic|sexo|sexual|cena quente|cena de sexo|nudez|nud[ae]s\b|pelad|transar|transa\b|tesão|tesao|gemid|orgasm|excita|masturb|penetra|preliminar|amass|conteúdo sexual/i;
  if (FILTRO_INTIMO.test(textoCheck)) {
    console.log(`[InfoPessoal] BLOQUEADA (conteúdo íntimo): "${chave}"`);
    return null;
  }

  // Duração do fato: 'permanente' (quem a pessoa é, história, gosto — fica pra
  // sempre) ou 'temporaria' (algo acontecendo que vai passar). Fatos temporários
  // ganham uma data de expiração; permanentes nunca expiram. Isso é o que
  // permite a Clara lembrar "você foi DJ" pra sempre, mas esquecer "o carro deu
  // problema" depois que resolve.
  const ehTemporaria = duracao === 'temporaria';
  const expiraEm = ehTemporaria ? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString() : null;

  const existing = await prisma.memory.findFirst({
    where: {
      userId,
      type: PERSONAL_INFO_TYPE,
      metadata: { contains: `"chave":"${chave}"` },
    },
  });

  if (existing) {
    if (existing.content === valor) return existing;
    // Ao atualizar, se virou permanente (ex: "o carro deu problema" → depois
    // "consertei o carro, ficou ótimo"), mantém permanente. Uma vez permanente,
    // não volta a ser temporário.
    let metaAntiga = {}; try { metaAntiga = JSON.parse(existing.metadata || '{}'); } catch {}
    const jaEraPermanente = metaAntiga.duracao === 'permanente';
    const duracaoFinal = jaEraPermanente ? 'permanente' : duracao;
    return prisma.memory.update({
      where: { id: existing.id },
      data: {
        content: valor,
        metadata: JSON.stringify({ chave, categoria, duracao: duracaoFinal, expiraEm: duracaoFinal === 'temporaria' ? expiraEm : null, updatedAt: new Date().toISOString() }),
      },
    });
  }

  return prisma.memory.create({
    data: {
      userId,
      type: PERSONAL_INFO_TYPE,
      content: valor,
      metadata: JSON.stringify({ chave, categoria, duracao, expiraEm, createdAt: new Date().toISOString() }),
    },
  });
}

async function deletePersonalInfo(userId, memoryId) {
  // Verifica que a memória pertence ao usuário antes de deletar
  const mem = await prisma.memory.findFirst({
    where: { id: memoryId, userId, type: PERSONAL_INFO_TYPE }
  }).catch(() => null);
  if (!mem) return false;
  await prisma.memory.delete({ where: { id: memoryId } }).catch(() => {});
  // Quando o usuário deleta, marca que não quer ser perguntado sobre aquilo de novo por 30 dias
  let meta = {};
  try { meta = JSON.parse(mem.metadata || '{}'); } catch {}
  if (meta.chave) {
    await prisma.memory.create({
      data: {
        userId,
        type: 'perfil_deletado',
        content: meta.chave,
        metadata: JSON.stringify({ deletadoEm: new Date().toISOString(), expira: Date.now() + 30 * 24 * 60 * 60 * 1000 })
      }
    }).catch(() => {});
  }
  return true;
}

async function getPersonalInfo(userId, categoria = null) {
  const where = { userId, type: PERSONAL_INFO_TYPE };
  const mems = await prisma.memory.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });

  const agora = Date.now();
  const result = {};
  for (const m of mems) {
    let meta = {};
    try { meta = JSON.parse(m.metadata || '{}'); } catch {}
    if (categoria && meta.categoria !== categoria) continue;
    // Fatos temporários expirados não entram no contexto — "o carro deu
    // problema" some depois de resolver/expirar. Permanentes nunca expiram.
    if (meta.duracao === 'temporaria' && meta.expiraEm && new Date(meta.expiraEm).getTime() < agora) continue;
    result[meta.chave || m.id] = { id: m.id, valor: m.content, categoria: meta.categoria || 'outro', duracao: meta.duracao || 'permanente' };
  }
  return result;
}

// Retorna lista de chaves que o usuário deletou recentemente (não perguntar de novo)
async function getChavesDeletadas(userId) {
  const mems = await prisma.memory.findMany({
    where: { userId, type: 'perfil_deletado' },
    orderBy: { createdAt: 'desc' }
  }).catch(() => []);
  const agora = Date.now();
  return mems
    .map(m => { try { const d = JSON.parse(m.metadata || '{}'); return d.expira > agora ? m.content : null; } catch { return null; } })
    .filter(Boolean);
}

// Retorna quais campos do CAMPOS_CURIOSIDADE a Clara ainda não conhece
// e o usuário não deletou — usados para perguntas orgânicas
async function getCamposDesconhecidos(userId) {
  const infos = await getPersonalInfo(userId);
  const chavesConhecidas = new Set(Object.keys(infos));
  const chavesDeletadas = new Set(await getChavesDeletadas(userId));

  return CAMPOS_CURIOSIDADE.filter(campo =>
    !chavesConhecidas.has(campo.chave) && !chavesDeletadas.has(campo.chave)
  );
}

// Retorna o próximo campo que faz sentido perguntar dado o contexto atual
// contextoAtual: 'qualquer' | 'trabalho' | 'lazer' | 'saude' | 'financeiro' | 'relacionamento'
async function getProximaCuriosidade(userId, contextoAtual = 'qualquer') {
  const desconhecidos = await getCamposDesconhecidos(userId);
  if (!desconhecidos.length) return null;

  // Prioriza campos que combinam com o contexto atual da conversa
  const contextuais = desconhecidos.filter(c => c.contexto === contextoAtual);
  const gerais = desconhecidos.filter(c => c.contexto === 'qualquer');

  const candidatos = contextuais.length > 0 ? contextuais : gerais;
  if (!candidatos.length) return desconhecidos[0]; // fallback: qualquer desconhecido

  // Retorna um aleatório entre os candidatos (evita sempre a mesma ordem)
  return candidatos[Math.floor(Math.random() * candidatos.length)];
}

async function buildPersonalContext(userId) {
  const infos = await getPersonalInfo(userId);
  
  // Resumo evolutivo — contexto mais importante, nunca some
  const resumo = await getResumoRelacionamento(userId).catch(() => null);

  const grupos = {};
  for (const cat of Object.keys(CATEGORIAS_PERFIL)) grupos[cat] = [];

  for (const [chave, { valor, categoria }] of Object.entries(infos)) {
    const grupo = grupos[categoria] || grupos.outro;
    grupo.push(valor);
  }

  const labels = Object.fromEntries(
    Object.entries(CATEGORIAS_PERFIL).map(([cat, { label }]) => [cat, label])
  );

  let texto = '';
  
  // Resumo do relacionamento vem primeiro — é o contexto mais valioso
  if (resumo) {
    texto += `
[RESUMO DO RELACIONAMENTO — leia antes de tudo, define quem é essa pessoa pra você]
${resumo}`;
  }

  for (const [cat, items] of Object.entries(grupos)) {
    if (items.length === 0) continue;
    texto += `\n[${labels[cat]}]\n${items.map(i => `• ${i}`).join('\n')}`;
  }

  // ── Assuntos em aberto ──
  // Prioridade: mostra o MAIS RECENTE em destaque para manter o assunto
  // vivo. Se houver outros abertos, aparecem como contexto secundário
  // (menor peso) para não sobrecarregar a resposta.
  const pendencias = await getPendenciasAbertas(userId);
  if (pendencias.length > 0) {
    // [0] = mais recente (orderBy createdAt desc em getPendenciasAbertas)
    const principal = pendencias[0];
    texto += `\n\n[ASSUNTO EM ABERTO — prioridade máxima, retome quando houver abertura natural]\n• ${principal.assunto}: ${principal.contexto} → ${principal.como_retomar}`;
    // Demais assuntos: mencionados de forma mais leve, sem forçar
    if (pendencias.length > 1) {
      const outros = pendencias.slice(1, 3).map(p => `• ${p.assunto}: ${p.contexto}`).join('\n');
      texto += `\n\n[OUTROS ASSUNTOS EM ABERTO — só retome se surgir oportunidade muito natural]\n${outros}`;
    }
  }

  // ── Campos que a Clara ainda não conhece (para curiosidade orgânica) ──
  // Passa no contexto como dica para o modelo saber o que pode perguntar,
  // sem forçar — só aparece quando a conversa estiver esfriando.
  const desconhecidos = await getCamposDesconhecidos(userId);
  if (desconhecidos.length > 0) {
    const exemplos = desconhecidos.slice(0, 4).map(c => c.pergunta).join('; ');
    texto += `\n\n[AINDA NÃO SEI — posso perguntar organicamente quando a conversa permitir, MÁXIMO 1 por conversa, NUNCA force]: ${exemplos}`;
  }

  // ── Humor do dia — contexto emocional ──
  const humor = await getHumorDia(userId).catch(() => null);
  if (humor) {
    const estadoMap = {
      doente: '🤒 Não está se sentindo bem',
      cansado: '😴 Está cansado',
      estressado: '😤 Está estressado',
      preocupado: '😟 Está preocupado com algo',
      triste: '😢 Está triste',
      animado: '😊 Está animado e de bom humor',
    };
    const desc = estadoMap[humor.estado] || humor.estado;
    const motivo = humor.motivo ? ` (${humor.motivo})` : '';
    texto += `\n\n[ESTADO EMOCIONAL ATUAL${humor.intensidade === 'intenso' ? ' — INTENSO, seja especialmente cuidadosa' : ''}]: ${desc}${motivo}`;
  }

  // ── Localização: casa e trabalho permanentes + atual ──
  for (const [chave, label] of [['bairro_casa', 'Casa'], ['bairro_trabalho', 'Trabalho']]) {
    const info = await prisma.memory.findFirst({
      where: { userId, type: 'info_pessoal', metadata: { contains: chave } }
    }).catch(() => null);
    if (info) texto += `\n• ${label}: ${info.content}`;
  }

  const loc = await getLocalizacao(userId).catch(() => null);
  if (loc?.cidade) {
    const locTexto = loc.bairro ? `${loc.bairro}, ${loc.cidade}` : loc.cidade;
    texto += `\n\n[LOCALIZAÇÃO ATUAL (recente)]: ${locTexto} — pode referenciar se for natural`;
  }

  // ── Memória afetiva — como a Clara se relaciona com essa pessoa ──
  const afetiva = await getMemoriaAfetiva(userId).catch(() => ({}));
  if (Object.keys(afetiva).length > 0) {
    let textoAfetivo = '';
    if (afetiva.apelido_usuario) textoAfetivo += `\n• Como ele gosta de ser chamado: ${afetiva.apelido_usuario}`;
    if (afetiva.apelido_clara) textoAfetivo += `\n• Como ele chama você: ${afetiva.apelido_clara}`;
    if (afetiva.tom_relacao) textoAfetivo += `\n• Tom da relação: ${afetiva.tom_relacao}`;
    if (afetiva.piada_interna) textoAfetivo += `\n• Referência afetiva: ${afetiva.piada_interna}`;
    if (afetiva.emoji_combinado) textoAfetivo += `\n• Emojis da relação: ${afetiva.emoji_combinado}`;
    if (textoAfetivo) texto += `\n\n[MEMÓRIA DO RELACIONAMENTO — USE SEMPRE, define o tom da conversa]${textoAfetivo}`;
  }

  // ── Ponto 3: padrões de reação ──
  // Como ele REAGE em situações específicas — não fatos sobre ele, mas
  // comportamentos observados. Ajuda a Clara a calibrar o tom antes que
  // ele precise dizer que está estressado, animado, frustrado etc.
  const padroesReacao = await getPadroesReacao(userId).catch(() => []);
  if (padroesReacao.length > 0) {
    const linhas = padroesReacao.map(p => `• ${p.tema}: ${p.padrao}`).join('\n');
    texto += `\n\n[COMO ELE REAGE — calibre seu tom antes que ele precise dizer]\n${linhas}`;
  }

  // ── Personagem Clara: o que ela já contou sobre si mesma ──
  // Detalhes que ela inventou (amigas, lugares, atividades) — mantém consistência.
  // "Bia e Carol" continuam sendo Bia e Carol nas próximas conversas.
  const claraPersonagem = await prisma.memory.findMany({
    where: { userId, type: 'clara_personagem' },
    orderBy: { createdAt: 'desc' },
    take: 15
  }).catch(() => []);
  if (claraPersonagem.length > 0) {
    texto += '\n\n[DETALHES DA SUA PRÓPRIA VIDA — mantenha consistência, são coisas que você já contou]\n';
    texto += claraPersonagem.map(m => `• ${m.content}`).join('\n');
  }

  // ── Linha do tempo: eventos que o usuário mencionou ──
  // Se o evento já passou (baseado em criadoEm + followup_horas), Clara sabe
  // que aconteceu e pode perguntar como foi de forma natural.
  const agora = new Date();
  const linhaTempo = await prisma.memory.findMany({
    where: { userId, type: 'linha_tempo', createdAt: { gte: new Date(agora.getTime() - 72*60*60*1000) } },
    orderBy: { createdAt: 'desc' },
    take: 5
  }).catch(() => []);
  if (linhaTempo.length > 0) {
    const itensLinha = linhaTempo.map(m => {
      let meta = {}; try { meta = JSON.parse(m.metadata || '{}'); } catch {}
      // Usa followup_at absoluto se disponível, senão cálculo legado
      let jaPassou = false;
      if (meta.followup_at) {
        jaPassou = agora > new Date(meta.followup_at);
      } else {
        const criadoEm = new Date(meta.criadoEm || m.createdAt);
        const followupAt = new Date(criadoEm.getTime() + (meta.followup_horas || 24) * 60 * 60 * 1000);
        jaPassou = agora > followupAt;
      }
      return { content: m.content, quando: meta.quando || '', jaPassou };
    });
    const passados = itensLinha.filter(i => i.jaPassou);
    const futuros = itensLinha.filter(i => !i.jaPassou);
    if (passados.length > 0 || futuros.length > 0) {
      texto += '\n\n[LINHA DO TEMPO — o que o usuário mencionou]\n';
      if (passados.length > 0) {
        texto += 'Já aconteceu (se o momento for natural, pergunte como foi — 1 vez, sem insistir):\n';
        texto += passados.map(i => `• ${i.content}${i.quando ? ` (${i.quando})` : ''}`).join('\n') + '\n';
      }
      if (futuros.length > 0) {
        texto += 'Ainda vai acontecer:\n';
        texto += futuros.map(i => `• ${i.content}${i.quando ? ` (${i.quando})` : ''}`).join('\n') + '\n';
      }
    }
  }

  // ── Feature 1: Consciência emocional da semana ──
  // Mostra o fio emocional recente — hoje pesa mais que ontem,
  // ontem mais que anteontem. É contexto de fundo, não peso a carregar.
  const estadosEmo = await prisma.memory.findMany({
    where: { userId, type: 'estado_emocional', createdAt: { gte: new Date(Date.now() - 7*24*60*60*1000) } },
    orderBy: { createdAt: 'desc' }, // mais recente primeiro
    take: 7
  }).catch(() => []);
  if (estadosEmo.length > 0) {
    // Hoje sempre aparece; dias anteriores só se intensidade >= 2
    const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
    const filtrados = estadosEmo.filter((e, i) => {
      if (i === 0) return true; // hoje sempre
      try { return JSON.parse(e.metadata || '{}').intensidade >= 2; } catch { return false; }
    }).slice(0, 4); // máx 4 dias
    if (filtrados.length > 0) {
      texto += '\n\n[COMO ELE TEM ESTADO — contexto de fundo, não peso a carregar. HOJE é o que mais importa; responda ao momento atual, não ao acumulado]\n';
      texto += filtrados.map((e, i) => `${i === 0 ? '→ HOJE' : `  ${i}d atrás`}: ${e.content.replace(/^\[\d+\/\d+\]\s*/, '')}`).join('\n');
      texto += '\nIMPORTANTE: se hoje está leve, seja leve. Não dramatize contexto anterior nem projete emoções que ele não está sentindo agora.';
    }
  }

  // ── Feature 2: Conexão externo/interno — contexto integrado ──
  // Lê contexto preparado pelo processamento silencioso (cron 03h30).
  // Quando existe, é a síntese mais afiada do que é relevante agora —
  // combinando estado emocional + eventos externos + padrões.
  const ctxPrep = await prisma.memory.findFirst({
    where: { userId, type: 'contexto_preparado', createdAt: { gte: new Date(Date.now() - 24*60*60*1000) } },
    orderBy: { createdAt: 'desc' }
  }).catch(() => null);
  if (ctxPrep) {
    texto += `\n\n[CONTEXTO PREPARADO — síntese do que é mais relevante agora]\n${ctxPrep.content}`;
  }

  // ── Memória narrativa contínua — linha do tempo que nunca regride ──
  // Diferente do summary (substitui) e episódios (expiram), essa só acumula.
  // Lida em ordem cronológica pra Clara saber o fio do que foi acontecendo.
  const memoriaContínua = await prisma.memory.findMany({
    where: { userId, type: 'memoria_continua' },
    orderBy: { createdAt: 'asc' },
    take: 21 // ~3 semanas de entradas diárias
  }).catch(() => []);
  if (memoriaContínua.length > 0) {
    texto += '\n\n[LINHA DO TEMPO — o que foi acontecendo, em ordem cronológica. Use como fio condutor da conversa]\n';
    texto += memoriaContínua.map(m => m.content).join('\n');
  }

  // ── DEDUÇÃO — Peça 3: conectar os pontos ──
  // Nota: a memória é bilateral — o relationship summary captura tanto o que
  // o usuário disse quanto o que Clara disse (bom dia, proativas, boa noite
  // agora são salvas em conversa). Clara lembra dos dois lados naturalmente,
  // sem precisar de uma seção explícita "o que eu disse".
  // Faz a Clara ligar o que a pessoa fala AGORA ao que ela já sabe (pessoas,
  // lugares, temas recorrentes, tratamentos) em vez de tratar tudo como novo —
  // é o que faz parecer uma amiga que presta atenção, não um robô com amnésia.
  if (texto) {
    texto += `\n\n[CONECTE OS PONTOS — como uma amiga que lembra das coisas]\nAntes de responder, veja se o que ele está falando agora se liga a algo que você JÁ SABE dele acima (uma pessoa, um lugar, um tratamento, um assunto recorrente). Se ligar, CONECTE de forma natural em vez de tratar como novidade solta. Ex: se ele cita um remédio e você sabe que a filha dele estava doente, associe ("é pra Isis?"); se cita um nome novo num contexto que você já conhece (barbeiro, trabalho, vizinho), assuma o vínculo provável e confirme leve. NUNCA invente fato que não está na memória — na dúvida, pergunte com curiosidade em vez de afirmar. Uma conexão certeira vale mais que dez forçadas.`;
  }

  return texto ? `\n\n[PERFIL DO USUÁRIO — use para personalizar respostas e ser proativa]${texto}` : '';
}

// ====================== MEMÓRIAS ======================

async function saveMemory(userId, type, content, metadata = null) {
  return prisma.memory.create({
    data: {
      userId, type, content,
      metadata: metadata ? JSON.stringify(metadata) : null,
    },
  });
}

async function getRecentMemories(userId, limit = 30) {
  const mems = await prisma.memory.findMany({
    where: { userId, type: { not: 'conversa' } },
    orderBy: { createdAt: 'desc' },
    take: limit + 10,
  });
  return mems
    .filter(m => !/^__.*__$/.test(m.type) && !m.type.startsWith('lock_') && m.type !== 'webhook_msgid' && m.type !== 'perfil_deletado')
    .slice(0, limit);
}

// ====================== CONTEXTO TEMPORÁRIO ======================

async function setTemporaryContext(userId, context, minutes = 10) {
  const expiresAt = Date.now() + (minutes * 60 * 1000);
  await saveMemory(userId, 'contexto_temp', JSON.stringify({ context, expiresAt }));
}

async function getTemporaryContext(userId) {
  const mems = await getRecentMemories(userId, 20);
  const ctx = mems.find(m => m.type === 'contexto_temp');
  if (!ctx) return null;
  try {
    const parsed = JSON.parse(ctx.content);
    if (Date.now() > parsed.expiresAt) return null;
    return parsed.context;
  } catch { return null; }
}

async function clearTemporaryContext(userId) {
  await saveMemory(userId, 'contexto_temp', '');
}

// ====================== CONVERSA ======================

async function saveConversationMessage(userId, role, content, privateMode = false) {
  if (privateMode) return;
  await prisma.memory.create({
    data: { userId, type: 'conversa', content: JSON.stringify({ role, content, ts: Date.now() }) },
  });
  // Aprendizado de janela: registra a hora em que o USUÁRIO fala, pra Clara ir
  // entendendo a rotina (que horas ele mais conversa de manhã/almoço/noite).
  // Silencioso, não afeta nada agora — só alimenta dados pra proativas ficarem
  // mais certeiras com o tempo. Só conta mensagem real, não confirmação curta.
  if (role === 'user' && content && content.trim().length > 6) {
    registrarHorarioConversa(userId).catch(() => {});
  }
  const msgs = await prisma.memory.findMany({
    where: { userId, type: 'conversa' },
    orderBy: { createdAt: 'desc' },
  });
  if (msgs.length > 40) {
    const toDelete = msgs.slice(40).map((m) => m.id);
    await prisma.memory.deleteMany({ where: { id: { in: toDelete } } });
  }
}

// Registra a hora atual (BRT) numa contagem por período. Guarda um histograma
// simples: quantas vezes o usuário falou em cada hora do dia. A proativa lê
// isso pra escolher o melhor horário dentro de cada janela.
async function registrarHorarioConversa(userId) {
  const horaBRT = parseInt(new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).getHours(), 10);
  const reg = await prisma.memory.findFirst({
    where: { userId, type: 'padrao_horario' }
  }).catch(() => null);
  let hist = {};
  if (reg) { try { hist = JSON.parse(reg.content) || {}; } catch { hist = {}; } }
  hist[horaBRT] = (hist[horaBRT] || 0) + 1;
  if (reg) {
    await prisma.memory.update({ where: { id: reg.id }, data: { content: JSON.stringify(hist) } }).catch(() => {});
  } else {
    await prisma.memory.create({ data: { userId, type: 'padrao_horario', content: JSON.stringify(hist) } }).catch(() => {});
  }
}

// Lê o horário preferido do usuário dentro de uma janela [horaIni, horaFim).
// Retorna a hora com mais registros na janela, ou null se ainda não há dados
// suficientes (< 3 registros na janela = usa o padrão da proativa).
async function getHorarioPreferido(userId, horaIni, horaFim) {
  const reg = await prisma.memory.findFirst({
    where: { userId, type: 'padrao_horario' }
  }).catch(() => null);
  if (!reg) return null;
  let hist = {};
  try { hist = JSON.parse(reg.content) || {}; } catch { return null; }
  let melhorHora = null, maxCount = 0, totalJanela = 0;
  for (let h = horaIni; h < horaFim; h++) {
    const c = hist[h] || 0;
    totalJanela += c;
    if (c > maxCount) { maxCount = c; melhorHora = h; }
  }
  if (totalJanela < 3) return null; // dados insuficientes → proativa usa padrão
  return melhorHora;
}

async function getConversationHistory(userId, limit = 10) {
  const msgs = await prisma.memory.findMany({
    where: { userId, type: 'conversa' },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return msgs.reverse().map((m) => {
    try {
      const parsed = JSON.parse(m.content);
      return { role: parsed.role, content: parsed.content };
    } catch { return null; }
  }).filter(Boolean);
}

// ====================== MEDICAMENTOS ======================

async function saveMedication(userId, data) {
  const { nome, quantidade, frequencia, horarios } = data;
  await prisma.medication.updateMany({
    where: { userId, active: true, name: { contains: nome, mode: 'insensitive' } },
    data: { active: false },
  });
  const med = await prisma.medication.create({
    data: {
      userId, name: nome,
      totalPills: quantidade || 0,
      remaining: quantidade || 0,
      frequency: frequencia || 1,
      times: JSON.stringify(horarios || ['08:00']),
    },
  });
  await saveMemory(userId, 'remedio', `${nome} - ${frequencia}x por dia`, { medId: med.id });
  return med;
}

// ====================== TAREFAS ======================

async function saveTask(userId, data) {
  const { titulo, data: date, hora } = data;
  let dueDate = parseDateSafely(date);
  if (dueDate) dueDate.setHours(12, 0, 0, 0);
  const task = await prisma.task.create({
    data: { userId, title: titulo, dueDate, dueTime: hora || null },
  });
  await saveMemory(userId, 'compromisso', titulo, { taskId: task.id });
  return task;
}

// ====================== GASTOS ======================

async function saveExpense(userId, data) {
  const { valor, categoria, descricao, createdAt } = data;
  const expenseData = {
    userId,
    value: parseFloat(valor) || 0,
    category: categoria || 'outro',
    description: descricao || '',
  };
  if (createdAt) expenseData.createdAt = createdAt;
  const expense = await prisma.expense.create({ data: expenseData });
  await saveMemory(userId, 'gasto', `R$ ${valor} em ${categoria}`);
  return expense;
}

async function getMonthExpenses(userId) {
  const start = new Date();
  start.setDate(1); start.setHours(0, 0, 0, 0);
  return prisma.expense.findMany({
    where: { userId, createdAt: { gte: start } },
    orderBy: { createdAt: 'desc' },
  });
}

// ====================== PENDÊNCIAS EMOCIONAIS ======================

async function savePendencia(userId, { categoria, resumo, horas = 4 }) {
  const checkInAt = new Date(Date.now() + horas * 60 * 60 * 1000);
  return prisma.pendencia.create({
    data: { userId, categoria, resumo, checkInAt },
  });
}

// ====================== CONTATOS ======================

async function saveContact(userId, { nome, phone, relation = null, notes = null }) {
  let phoneClean = phone.replace(/\D/g, '');
  if (!phoneClean.startsWith('55') && phoneClean.length <= 11) phoneClean = '55' + phoneClean;
  const existing = await prisma.contact.findFirst({ where: { userId, phone: phoneClean } });
  if (existing) {
    return prisma.contact.update({
      where: { id: existing.id },
      data: { name: nome, relation, notes, updatedAt: new Date() }
    });
  }
  return prisma.contact.create({
    data: { userId, name: nome, phone: phoneClean, relation, notes }
  });
}

async function getContacts(userId) {
  return prisma.contact.findMany({ where: { userId }, orderBy: { name: 'asc' } });
}

async function findContactByName(userId, nome) {
  return prisma.contact.findMany({
    where: { userId, name: { contains: nome, mode: 'insensitive' } }
  });
}

// ====================== ASSUNTOS EM ABERTO ======================

async function getPendenciasAbertas(userId) {
  const mems = await prisma.memory.findMany({
    where: { userId, type: 'pendencia_conversa' },
    orderBy: { createdAt: 'desc' },
    take: 10,
  }).catch(() => []);
  const agora = Date.now();
  const EXPIRY_MS = 3 * 24 * 60 * 60 * 1000;
  const EXPIRY_ALTA_MS = 5 * 24 * 60 * 60 * 1000; // "depois te conto" dura mais
  const lista = mems
    .map(m => { try { return { id: m.id, criadoEm: m.createdAt, prioridade: 'normal', origem: 'conversa', cobrancas: 0, ...JSON.parse(m.content) }; } catch { return null; } })
    .filter(Boolean)
    .filter(p => {
      if (p.encerrado) return false;
      const idade = agora - new Date(p.criadoEm).getTime();
      const limite = p.prioridade === 'alta' ? EXPIRY_ALTA_MS : EXPIRY_MS;
      return idade < limite;
    });
  // Ordena: prioridade alta ("depois te conto") primeiro, depois por mais recente
  lista.sort((a, b) => {
    if (a.prioridade === 'alta' && b.prioridade !== 'alta') return -1;
    if (b.prioridade === 'alta' && a.prioridade !== 'alta') return 1;
    return new Date(b.criadoEm).getTime() - new Date(a.criadoEm).getTime();
  });
  return lista;
}

async function salvarOuAtualizarPendencia(userId, { assunto, contexto, como_retomar, prioridade = 'normal', origem = 'conversa' }) {
  // FILTRO HARD: nunca salvar pendência de conteúdo íntimo/sexual/romântico.
  // A instrução no prompt do detectarAssuntoEmAberto às vezes é ignorada pela
  // IA, então esse bloqueio no código é a rede de segurança final. Se qualquer
  // campo tiver esses termos, descarta silenciosamente — não vira pendência,
  // não é retomado em proativas, não vaza.
  const textoCompleto = `${assunto || ''} ${contexto || ''} ${como_retomar || ''}`.toLowerCase();
  const FILTRO_INTIMO = /erótic|erotic|sexo|sexual|cena quente|cena de sexo|nudez|nud[ae]s\b|pelad|transar|transa\b|tesão|tesao|gemid|orgasm|excita|masturb|penetra|preliminar|amass|conteúdo sexual/i;
  if (FILTRO_INTIMO.test(textoCompleto)) {
    console.log(`[Pendência] BLOQUEADA (conteúdo íntimo): "${assunto}"`);
    return;
  }

  const existentes = await getPendenciasAbertas(userId);

  // Atualiza se já existe assunto parecido
  const mesmoAssunto = existentes.find(p =>
    p.assunto?.toLowerCase().includes(assunto?.toLowerCase()?.split(' ')[0]) ||
    assunto?.toLowerCase().includes(p.assunto?.toLowerCase()?.split(' ')[0])
  );
  if (mesmoAssunto) {
    // Preserva a prioridade mais alta se já existia (um "depois te conto" não
    // vira "normal" por uma atualização qualquer)
    const prioridadeFinal = mesmoAssunto.prioridade === 'alta' ? 'alta' : prioridade;
    await prisma.memory.update({
      where: { id: mesmoAssunto.id },
      data: { content: JSON.stringify({ assunto, contexto, como_retomar, encerrado: false, prioridade: prioridadeFinal, origem: mesmoAssunto.origem || origem, cobrancas: mesmoAssunto.cobrancas || 0 }) }
    }).catch(() => {});
    return;
  }

  // Limite de 3 pendências ativas — remove a mais antiga de prioridade NORMAL
  // se estourar (nunca remove uma de prioridade alta / "depois te conto").
  if (existentes.length >= 3) {
    const removivel = existentes.filter(p => p.prioridade !== 'alta');
    if (removivel.length > 0) {
      const maisAntiga = removivel[removivel.length - 1];
      await prisma.memory.delete({ where: { id: maisAntiga.id } }).catch(() => {});
      console.log(`[Pendência] Removida antiga: "${maisAntiga.assunto}" (limite 3)`);
    }
  }

  await prisma.memory.create({
    data: { userId, type: 'pendencia_conversa', content: JSON.stringify({ assunto, contexto, como_retomar, encerrado: false, prioridade, origem, cobrancas: 0 }) }
  }).catch(() => {});
  console.log(`[Pendência] Salva: "${assunto}"${prioridade === 'alta' ? ' [PRIORIDADE ALTA — depois te conto]' : ''}`);
}

// ═══════════════════════════════════════════════════════════════════════
// DEDUÇÃO — Peça 1: remédio acabou → pendência de acompanhamento
// ═══════════════════════════════════════════════════════════════════════
// Quando o estoque de um remédio ZERA (última dose tomada), vira um assunto
// em aberto. A Clara NÃO empurra nada — a pendência entra no contexto e ela
// puxa numa conversa natural quando houver abertura. O vínculo remédio↔pessoa
// (ex: "amoxilina é da Isis, que tava doente") vem da MEMÓRIA dela, que o
// buildPersonalContext já injeta — então ao formular ela conecta os pontos
// sozinha ("e a Isis, melhorou? vi que a amoxilina já acabou 💜"). Retentora
// de informação + amiga.
async function acompanharFimDeRemedio(userId, medNome) {
  if (!userId || !medNome) return;
  try {
    await salvarOuAtualizarPendencia(userId, {
      // Assunto começa pelo NOME do remédio: o dedup casa pela 1ª palavra, então
      // isso evita que "amoxilina..." e "triglicérides..." se fundam num só.
      assunto: `${medNome} (tratamento) terminou`,
      contexto: `O estoque de ${medNome} acabou — a pessoa tomou a última dose. Se pela memória de vocês você souber pra QUEM ou pra qual situação era esse remédio (ex: alguém que estava doente), pergunte com carinho e de forma natural se melhorou / como foi o tratamento. Se você NÃO souber o motivo (ex: remédio de uso contínuo), então NÃO pergunte "melhorou" — no máximo comente de leve se vai repor. Nunca soe como robô de farmácia.`,
      como_retomar: `Puxar numa conversa natural quando houver abertura, conectando com o que você já sabe sobre ${medNome} e sobre as pessoas da vida dele.`,
      prioridade: 'normal',
      origem: 'remedio_acabou'
    });
    console.log(`[Acompanhamento remédio] "${medNome}" zerou → pendência criada (user ${userId})`);
  } catch (e) { console.error('[acompanharFimDeRemedio]', e.message); }
}

async function fecharPendencia(userId, pendenciaId) {  const mem = await prisma.memory.findUnique({ where: { id: pendenciaId } }).catch(() => null);
  if (!mem || mem.userId !== userId) return;
  try {
    const dados = JSON.parse(mem.content);
    await prisma.memory.update({
      where: { id: pendenciaId },
      data: { content: JSON.stringify({ ...dados, encerrado: true }) }
    });
    console.log(`[Pendência] Fechada: "${dados.assunto}"`);
  } catch {}
}

async function fecharPendenciasPorResolucao(userId, textoUsuario) {
  const pendencias = await getPendenciasAbertas(userId);
  if (!pendencias.length) return;

  const textoLower = textoUsuario.toLowerCase();

  // ── Sinais explícitos de resolução ──
  const SINAIS_GERAIS = /\b(estou bem|tá bem|já passou|passou|deu certo|foi ótimo|foi bem|resolvido|resolveu|já fiz|normal|tranquilo|melhorei|melhor|alta|cheguei em casa|chegou|saiu|terminou|acabou|tudo certo|tudo bem|sem problema|não foi nada|era nada|nada grave|liberado|já bebi|já tomei|já fiz|já foi|feito|concluído|concluido|pronto|ok feito|fiz isso)\b/i;

  // ── Verifica cada pendência individualmente ──
  // Uma pendência é fechada se:
  // 1. O texto menciona palavras do assunto E tem sinal de resolução
  // 2. O texto menciona palavras do assunto E verbo no passado ("já X", "fiz X", "tomei X")
  // 3. Tem sinal geral E a pendência é a mais recente (fallback)
  const VERBOS_PASSADO = /\b(já |fiz |tomei |bebi |fui |foi |terminei |acabei |resolvi |concluí |fez |foram )\b/i;

  const fechadas = [];
  for (const p of pendencias) {
    const palavrasAssunto = (p.assunto || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const palavrasContexto = (p.contexto || '').toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const palavras = [...palavrasAssunto, ...palavrasContexto.slice(0, 4)];
    const mencionaAssunto = palavras.some(w => textoLower.includes(w));

    if (mencionaAssunto && (SINAIS_GERAIS.test(textoUsuario) || VERBOS_PASSADO.test(textoUsuario))) {
      fechadas.push(p.id);
    }
  }

  // Se não casou nenhum assunto específico mas tem sinal geral → fecha a mais recente
  if (!fechadas.length && SINAIS_GERAIS.test(textoUsuario)) {
    fechadas.push(pendencias[0].id);
  }

  for (const id of fechadas) {
    await fecharPendencia(userId, id);
  }

  // ── Limpeza automática de pendências velhas (> 3 dias) ──
  // Assunto de mais de 3 dias sem resolução já não é relevante pra puxar numa
  // proativa — vira aquele "notebook do Réveillon" ressuscitado. Remove.
  const seteDiasAtras = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const velhas = pendencias.filter(p =>
    !fechadas.includes(p.id) &&
    p.criadoEm && new Date(p.criadoEm) < seteDiasAtras
  );
  for (const p of velhas) {
    await fecharPendencia(userId, p.id);
    console.log(`[Pendência] Expirada por idade (>3 dias): "${p.assunto}"`);
  }
}

// ── fecharPendenciaLembrete ──
// Chamada quando o usuário confirma um lembrete — fecha automaticamente
// qualquer pendência com assunto relacionado ao título do lembrete.
// Ex: lembrete "beber água" confirmado → fecha pendência "beber água"
async function fecharPendenciaLembrete(userId, tituloLembrete) {
  if (!tituloLembrete) return;
  const pendencias = await getPendenciasAbertas(userId);
  if (!pendencias.length) return;

  const tituloLower = tituloLembrete.toLowerCase();
  const palavrasTitulo = tituloLower.split(/\s+/).filter(w => w.length > 3);

  for (const p of pendencias) {
    const palavrasAssunto = (p.assunto || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const palavrasContexto = (p.contexto || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const todasPalavras = [...palavrasAssunto, ...palavrasContexto.slice(0, 3)];

    const temRelacao = palavrasTitulo.some(w => todasPalavras.includes(w)) ||
                       todasPalavras.some(w => tituloLower.includes(w));
    if (temRelacao) {
      await fecharPendencia(userId, p.id);
      console.log(`[Pendência] Fechada por lembrete confirmado: "${p.assunto}" ← "${tituloLembrete}"`);
    }
  }
}

// ── Humor do dia ────────────────────────────────────────────────────────
async function salvarHumorDia(userId, humor) {
  if (!humor || !humor.estado) return;
  try {
    const existente = await prisma.memory.findFirst({ where: { userId, type: 'humor_dia' } }).catch(() => null);
    const content = JSON.stringify({
      estado: humor.estado,
      intensidade: humor.intensidade || 'leve',
      motivo: humor.motivo || null,
      expira: Date.now() + 48 * 60 * 60 * 1000
    });
    if (existente) {
      await prisma.memory.update({ where: { id: existente.id }, data: { content } }).catch(() => {});
    } else {
      await prisma.memory.create({ data: { userId, type: 'humor_dia', content } }).catch(() => {});
    }
  } catch {}
}

async function getHumorDia(userId) {
  try {
    const m = await prisma.memory.findFirst({ where: { userId, type: 'humor_dia' } }).catch(() => null);
    if (!m) return null;
    const d = JSON.parse(m.content);
    if (Date.now() > d.expira) {
      await prisma.memory.delete({ where: { id: m.id } }).catch(() => {});
      return null;
    }
    return d;
  } catch { return null; }
}

async function salvarLocalizacao(userId, dados) {
  try {
    const existente = await prisma.memory.findFirst({ where: { userId, type: 'ultima_localizacao' } }).catch(() => null);
    const content = JSON.stringify({ ...dados, ts: Date.now() });
    if (existente) {
      await prisma.memory.update({ where: { id: existente.id }, data: { content } }).catch(() => {});
    } else {
      await prisma.memory.create({ data: { userId, type: 'ultima_localizacao', content } }).catch(() => {});
    }
  } catch {}
}

// Item 4: cidade ATUAL do usuário pra buscas locais. Prioriza a última
// localização por GPS (reverse-geocode) numa janela de 7 dias — cidade é
// estável por dias, diferente do getLocalizacao (4h) que é pra "perto de mim".
// Cai pro que o usuário disse em texto. Retorna '' se não souber.
async function getCidadeAtual(userId) {
  try {
    const m = await prisma.memory.findFirst({ where: { userId, type: 'ultima_localizacao' } }).catch(() => null);
    if (m) {
      const d = JSON.parse(m.content);
      if (d.cidade && (!d.ts || Date.now() - d.ts < 7 * 24 * 60 * 60 * 1000)) return d.cidade;
    }
  } catch {}
  try {
    const t = await prisma.memory.findFirst({ where: { userId, type: 'cidade' }, orderBy: { createdAt: 'desc' } }).catch(() => null);
    if (t?.content) return t.content;
  } catch {}
  return '';
}

async function getLocalizacao(userId) {  try {
    const m = await prisma.memory.findFirst({ where: { userId, type: 'ultima_localizacao' } }).catch(() => null);
    if (!m) return null;
    const d = JSON.parse(m.content);
    if (Date.now() - d.ts > 4 * 60 * 60 * 1000) return null;
    return d;
  } catch { return null; }
}


// ====================== MEMÓRIA AFETIVA ======================
// Salva como a Clara se relaciona com o usuário:
// apelidos, tom, piadas internas, jeito de falar.
// Sobrevive a reboots — é a "personalidade da relação".

async function salvarMemoriaAfetiva(userId, tipo, valor) {
  // tipos: 'apelido_usuario', 'apelido_clara', 'tom_relacao', 'piada_interna', 'emoji_combinado'
  try {
    const existente = await prisma.memory.findFirst({
      where: { userId, type: 'memoria_afetiva', metadata: { contains: `"tipo":"${tipo}"` } }
    }).catch(() => null);
    const metadata = JSON.stringify({ tipo, updatedAt: new Date().toISOString() });
    if (existente) {
      await prisma.memory.update({ where: { id: existente.id }, data: { content: valor, metadata } }).catch(() => {});
    } else {
      await prisma.memory.create({ data: { userId, type: 'memoria_afetiva', content: valor, metadata } }).catch(() => {});
    }
    console.log(`[Afetiva] ${tipo}: "${valor}"`);
  } catch {}
}

async function getMemoriaAfetiva(userId) {
  try {
    const mems = await prisma.memory.findMany({
      where: { userId, type: 'memoria_afetiva' },
      orderBy: { createdAt: 'desc' }
    }).catch(() => []);
    const resultado = {};
    for (const m of mems) {
      try {
        const meta = JSON.parse(m.metadata || '{}');
        if (meta.tipo) resultado[meta.tipo] = m.content;
      } catch {}
    }
    return resultado;
  } catch { return {}; }
}

// ====================== RESUMO EVOLUTIVO DO RELACIONAMENTO ======================
// Cresce com o tempo, nunca é apagado — só atualizado.
// Contém: o que a Clara já sabe sobre a pessoa, momentos marcantes,
// assuntos recorrentes, como a relação evoluiu.

async function salvarResumoRelacionamento(userId, novoResumo) {
  try {
    const existente = await prisma.memory.findFirst({
      where: { userId, type: 'resumo_relacionamento' }
    }).catch(() => null);
    if (existente) {
      await prisma.memory.update({
        where: { id: existente.id },
        data: { content: novoResumo }
      }).catch(() => {});
    } else {
      await prisma.memory.create({
        data: { userId, type: 'resumo_relacionamento', content: novoResumo }
      }).catch(() => {});
    }
  } catch {}
}

async function getResumoRelacionamento(userId) {
  try {
    const m = await prisma.memory.findFirst({
      where: { userId, type: 'resumo_relacionamento' }
    }).catch(() => null);
    return m?.content || null;
  } catch { return null; }
}

// ====================== EXPORTS ======================

// ── Ponto 3: padrões de reação ────────────────────────────────────────────
// Salva como a pessoa REAGE em situações específicas (não o que ela gosta —
// isso vai em info_pessoal). Max 15 padrões por usuário; upsert por tema.
async function salvarPadraoReacao(userId, tema, padrao) {
  try {
    const chave = tema.toLowerCase().trim().slice(0, 50);
    const existente = await prisma.memory.findFirst({
      where: { userId, type: 'padrao_reacao', metadata: { contains: chave } }
    }).catch(() => null);
    const content = padrao.slice(0, 120);
    const meta = JSON.stringify({ tema: chave, updatedAt: new Date().toISOString() });
    if (existente) {
      await prisma.memory.update({ where: { id: existente.id }, data: { content, metadata: meta } }).catch(() => {});
    } else {
      // Limita a 15 padrões — remove o mais antigo se passar
      const total = await prisma.memory.count({ where: { userId, type: 'padrao_reacao' } }).catch(() => 0);
      if (total >= 15) {
        const maisAntigo = await prisma.memory.findFirst({
          where: { userId, type: 'padrao_reacao' }, orderBy: { createdAt: 'asc' }
        }).catch(() => null);
        if (maisAntigo) await prisma.memory.delete({ where: { id: maisAntigo.id } }).catch(() => {});
      }
      await prisma.memory.create({ data: { userId, type: 'padrao_reacao', content, metadata: meta } }).catch(() => {});
    }
    console.log(`[PadraoReacao] Salvo: "${chave}" → "${content.slice(0, 60)}"`);
  } catch (e) { console.error('[salvarPadraoReacao]', e.message); }
}

async function getPadroesReacao(userId) {
  try {
    const rows = await prisma.memory.findMany({
      where: { userId, type: 'padrao_reacao' },
      orderBy: { updatedAt: 'desc' },
      take: 15
    }).catch(() => []);
    return rows.map(r => {
      let tema = ''; try { tema = JSON.parse(r.metadata || '{}').tema || ''; } catch {}
      return { tema, padrao: r.content };
    }).filter(p => p.tema && p.padrao);
  } catch { return []; }
}

module.exports = {
  prisma,
  getOrCreateUser,
  saveJornada, getJornada,
  saveUserPreference, getUserPreference,
  savePersonalInfo, deletePersonalInfo, getPersonalInfo, buildPersonalContext,
  getCamposDesconhecidos, getProximaCuriosidade, CAMPOS_CURIOSIDADE, CATEGORIAS_PERFIL,
  saveMemory, getRecentMemories,
  setTemporaryContext, getTemporaryContext, clearTemporaryContext,
  saveConversationMessage, getConversationHistory, getHorarioPreferido,
  saveMedication, saveTask,
  saveExpense, getMonthExpenses,
  saveContact, getContacts, findContactByName,
  savePendencia,
  getPendenciasAbertas, salvarOuAtualizarPendencia, acompanharFimDeRemedio, fecharPendencia, fecharPendenciasPorResolucao, fecharPendenciaLembrete,
  salvarHumorDia, getHumorDia, salvarLocalizacao, getLocalizacao, getCidadeAtual,
  salvarPadraoReacao, getPadroesReacao,
  salvarMemoriaAfetiva, getMemoriaAfetiva,
  salvarResumoRelacionamento, getResumoRelacionamento,
};
