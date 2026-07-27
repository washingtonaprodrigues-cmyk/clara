// Clara memory v7 — Clara 3.0: perfil rico + curiosidade orgânica

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ── Retry automático em falha de conexão ──────────────────────────────
// O Postgres do Railway às vezes tem soluços momentâneos ("Can't reach
// database server") — sem retry, isso derruba a operação inteira (ex:
// getOrCreateUser falhando trava a mensagem inteira do usuário). Aqui a
// gente tenta de novo (até 3x, com pequena espera crescente) só pra esse
// tipo específico de erro de conexão — outros erros (dado inválido, etc)
// continuam falhando na hora, sem retry, como deveria ser.
prisma.$use(async (params, next) => {
  const MAX_TENTATIVAS = 3;
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    try {
      return await next(params);
    } catch (e) {
      const ehErroConexao = e?.code === 'P1001' || /can't reach database server/i.test(e?.message || '');
      if (!ehErroConexao || tentativa >= MAX_TENTATIVAS) throw e;
      const espera = 300 * tentativa; // 300ms, 600ms
      console.warn(`[Prisma] Conexão falhou (tentativa ${tentativa}/${MAX_TENTATIVAS}), retry em ${espera}ms — ${params.model}.${params.action}`);
      await new Promise(r => setTimeout(r, espera));
    }
  }
});

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
  familia:         { label: '👨‍👩‍👧 Família',          emoji: '👨‍👩‍👧' },
  relacionamento:  { label: '❤️ Relacionamento',     emoji: '❤️' },
  filhos:          { label: '👶 Filhos',              emoji: '👶' },
  trabalho:        { label: '💼 Trabalho',            emoji: '💼' },
  hobbies:         { label: '🎯 Hobbies',             emoji: '🎯' },
  entretenimento:  { label: '🎬 Entretenimento',      emoji: '🎬' },
  alimentacao:     { label: '🍔 Alimentação',         emoji: '🍔' },
  metas:           { label: '🎯 Metas',               emoji: '🎯' },
  personalidade:   { label: '✨ Personalidade',       emoji: '✨' },
  saude:           { label: '💊 Saúde',               emoji: '💊' },
  datas:           { label: '📅 Datas importantes',   emoji: '📅' },
  rotina:          { label: '⏰ Rotina',              emoji: '⏰' },
  objetivos:       { label: '🚀 Objetivos',           emoji: '🚀' },
  outro:           { label: '📌 Informações gerais',  emoji: '📌' },
  relacionamento_clara: { label: '💜 Relação com a Clara', emoji: '💜' },
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

async function savePersonalInfo(userId, chave, valor, categoria = 'outro') {
  const existing = await prisma.memory.findFirst({
    where: {
      userId,
      type: PERSONAL_INFO_TYPE,
      metadata: { contains: `"chave":"${chave}"` },
    },
  });

  if (existing) {
    if (existing.content === valor) return existing;
    return prisma.memory.update({
      where: { id: existing.id },
      data: {
        content: valor,
        metadata: JSON.stringify({ chave, categoria, updatedAt: new Date().toISOString() }),
      },
    });
  }

  return prisma.memory.create({
    data: {
      userId,
      type: PERSONAL_INFO_TYPE,
      content: valor,
      metadata: JSON.stringify({ chave, categoria, createdAt: new Date().toISOString() }),
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

  const result = {};
  for (const m of mems) {
    let meta = {};
    try { meta = JSON.parse(m.metadata || '{}'); } catch {}
    if (categoria && meta.categoria !== categoria) continue;
    result[meta.chave || m.id] = { id: m.id, valor: m.content, categoria: meta.categoria || 'outro' };
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

// ── Suspeita de perfil ──────────────────────────────────────────────────
// A atualização noturna (reminders.js) não salva o que INFERE direto como
// fato — guarda como suspeita. A Clara pergunta organicamente na próxima
// conversa (mesmo mecanismo de curiosidade, MÁXIMO 1 por conversa, nunca
// força) e só vira fato de verdade (info_pessoal) quando o usuário
// confirma. Isso evita ela "aprender" e arquivar silenciosamente algo
// que pode estar errado (uma piada interpretada como fato, por exemplo).
async function salvarSuspeitaPerfil(userId, { chave, valor, categoria, pergunta }) {
  if (!chave || !valor) return;
  try {
    // Já é fato confirmado? Não precisa suspeitar.
    const jaConhecido = await prisma.memory.findFirst({
      where: { userId, type: 'info_pessoal', metadata: { contains: `"chave":"${chave}"` } }
    }).catch(() => null);
    if (jaConhecido) return;
    // Já existe suspeita igual? Não duplica.
    const jaSuspeita = await prisma.memory.findFirst({
      where: { userId, type: 'suspeita_perfil', metadata: { contains: `"chave":"${chave}"` } }
    }).catch(() => null);
    if (jaSuspeita) return;
    await prisma.memory.create({
      data: {
        userId, type: 'suspeita_perfil', content: valor,
        metadata: JSON.stringify({ chave, categoria: categoria || 'outro', pergunta: pergunta || `Você ${valor}?`, criadoEm: new Date().toISOString() })
      }
    }).catch(() => {});
  } catch {}
}

async function getSuspeitasPerfil(userId) {
  try {
    const mems = await prisma.memory.findMany({ where: { userId, type: 'suspeita_perfil' }, orderBy: { createdAt: 'desc' } }).catch(() => []);
    if (!mems.length) return [];
    const chavesConhecidas = new Set(Object.keys(await getPersonalInfo(userId)));
    const resultado = [];
    for (const m of mems) {
      let meta = {}; try { meta = JSON.parse(m.metadata || '{}'); } catch { continue; }
      // Já foi confirmada (virou fato de verdade)? Não pergunta mais, some da lista.
      if (chavesConhecidas.has(meta.chave)) continue;
      resultado.push({ chave: meta.chave, valor: m.content, categoria: meta.categoria, pergunta: meta.pergunta });
    }
    return resultado;
  } catch { return []; }
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
  const formatarIdade = (criadoEm) => {
    if (!criadoEm) return '';
    const dias = Math.floor((Date.now() - new Date(criadoEm).getTime()) / (24 * 60 * 60 * 1000));
    if (dias <= 0) return ' (hoje)';
    if (dias === 1) return ' (ontem)';
    return ` (há ${dias} dias)`;
  };
  const pendencias = await getPendenciasAbertas(userId);
  if (pendencias.length > 0) {
    // [0] = mais recente (orderBy createdAt desc em getPendenciasAbertas)
    const principal = pendencias[0];
    texto += `\n\n[ASSUNTO EM ABERTO${formatarIdade(principal.criadoEm)} — prioridade máxima, retome quando houver abertura natural. Use a idade acima pra calibrar: se foi ontem ou há dias, não trate como se tivesse acabado de acontecer]\n• ${principal.assunto}: ${principal.contexto} → ${principal.como_retomar}`;
    // Demais assuntos: mencionados de forma mais leve, sem forçar
    if (pendencias.length > 1) {
      const outros = pendencias.slice(1, 3).map(p => `• ${p.assunto}${formatarIdade(p.criadoEm)}: ${p.contexto}`).join('\n');
      texto += `\n\n[OUTROS ASSUNTOS EM ABERTO — só retome se surgir oportunidade muito natural]\n${outros}`;
    }
  }

  // ── Campos que a Clara ainda não conhece (para curiosidade orgânica) ──
  // Passa no contexto como dica para o modelo saber o que pode perguntar,
  // sem forçar — só aparece quando a conversa estiver esfriando.
  // Suspeitas (palpites da atualização noturna, específicos dessa pessoa)
  // vêm PRIMEIRO — valem mais que as perguntas genéricas de template.
  const suspeitas = await getSuspeitasPerfil(userId).catch(() => []);
  const desconhecidos = await getCamposDesconhecidos(userId);
  if (suspeitas.length > 0 || desconhecidos.length > 0) {
    const perguntasSuspeitas = suspeitas.slice(0, 2).map(s => s.pergunta);
    const perguntasGenericas = desconhecidos.slice(0, Math.max(0, 4 - perguntasSuspeitas.length)).map(c => c.pergunta);
    const todasPerguntas = [...perguntasSuspeitas, ...perguntasGenericas];
    const nota = suspeitas.length > 0 ? ' As primeiras são palpites seus de observar conversas recentes — priorize confirmá-las se fizer sentido no papo.' : '';
    texto += `\n\n[CURIOSIDADE — posso perguntar organicamente quando a conversa permitir, MÁXIMO 1 por conversa, NUNCA force.${nota}]: ${todasPerguntas.join('; ')}`;
  }

  // ── Humor do dia — contexto emocional ──
  const humor = await getHumorDia(userId).catch(() => null);
  if (humor) {
    const estadoMap = {
      trabalhando:  '💼 Está trabalhando agora',
      em_reunião:   '📞 Está em reunião',
      almoçando:    '🍽️ Está almoçando',
      em_casa:      '🏠 Está em casa',
      viajando:     '🚗 Está viajando / na estrada',
      doente:       '🤒 Não está se sentindo bem',
      cansado:      '😴 Está cansado',
      estressado:   '😤 Está estressado',
      preocupado:   '😟 Está preocupado com algo',
      triste:       '😢 Está triste',
      animado:      '😊 Está animado e de bom humor',
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

  // ── Clara Personagem: o que ela disse de si mesma ──
  // Quando ele tocar em algo que ela disse ("você falou que era fraquinha"),
  // ela lembra — não como novidade, mas como memória própria.
  try {
    const claraPersonagem = await prisma.memory.findMany({
      where: { userId, type: 'clara_personagem' },
      orderBy: { createdAt: 'desc' },
      take: 15
    }).catch(() => []);
    if (claraPersonagem.length > 0) {
      texto += '\n\n[COISAS QUE VOCÊ JÁ DISSE SOBRE SI — sua memória própria. Quando ele tocar nesses assuntos, você lembra naturalmente, sem tratar como novidade]\n';
      texto += claraPersonagem.map(m => `• ${m.content}`).join('\n');
    }
  } catch {}

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
  const msgs = await prisma.memory.findMany({
    where: { userId, type: 'conversa' },
    orderBy: { createdAt: 'desc' },
  });
  if (msgs.length > 40) {
    const toDelete = msgs.slice(40).map((m) => m.id);
    await prisma.memory.deleteMany({ where: { id: { in: toDelete } } });
  }
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

// ── Noção de tempo real entre mensagens ──────────────────────────────────
// O histórico (getConversationHistory) só guarda texto — a IA não tem como
// saber quanto tempo passou de verdade entre uma troca e outra. Isso fazia
// ela tratar planos futuros ("vou almoçar", "te chamo daqui a pouco") como
// se já tivessem acontecido, só porque fazia sentido textualmente. Essa
// função calcula o gap real desde a ÚLTIMA mensagem trocada (antes da atual),
// pra virar uma frase natural que a IA usa como referência de tempo.
async function getGapUltimaMensagem(userId) {
  const ultima = await prisma.memory.findFirst({
    where: { userId, type: 'conversa' },
    orderBy: { createdAt: 'desc' },
  }).catch(() => null);
  if (!ultima) return null;

  const diffMs = Date.now() - new Date(ultima.createdAt).getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return 'menos de 1 minuto';
  if (diffMin < 60) return `${diffMin} minuto${diffMin !== 1 ? 's' : ''}`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) {
    const restoMin = diffMin % 60;
    return restoMin > 0 ? `${diffH}h${restoMin}min` : `${diffH} hora${diffH !== 1 ? 's' : ''}`;
  }
  const diffD = Math.floor(diffH / 24);
  return `${diffD} dia${diffD !== 1 ? 's' : ''}`;
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
  const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
  return mems
    .map(m => { try { return { id: m.id, criadoEm: m.createdAt, ...JSON.parse(m.content) }; } catch { return null; } })
    .filter(Boolean)
    .filter(p => !p.encerrado && (agora - new Date(p.criadoEm).getTime()) < EXPIRY_MS);
}

async function salvarOuAtualizarPendencia(userId, { assunto, contexto, como_retomar }) {
  const existentes = await getPendenciasAbertas(userId);

  // Atualiza se já existe assunto parecido
  const mesmoAssunto = existentes.find(p =>
    p.assunto?.toLowerCase().includes(assunto?.toLowerCase()?.split(' ')[0]) ||
    assunto?.toLowerCase().includes(p.assunto?.toLowerCase()?.split(' ')[0])
  );
  if (mesmoAssunto) {
    await prisma.memory.update({
      where: { id: mesmoAssunto.id },
      data: { content: JSON.stringify({ assunto, contexto, como_retomar, encerrado: false }) }
    }).catch(() => {});
    return;
  }

  // Limite de 3 pendências ativas — remove a mais antiga se estourar
  // Evita acúmulo de assuntos irrelevantes que nunca são resolvidos
  if (existentes.length >= 3) {
    const maisAntiga = existentes[existentes.length - 1]; // já vem desc, então [last] é a mais antiga
    await prisma.memory.delete({ where: { id: maisAntiga.id } }).catch(() => {});
    console.log(`[Pendência] Removida antiga: "${maisAntiga.assunto}" (limite 3)`);
  }

  await prisma.memory.create({
    data: { userId, type: 'pendencia_conversa', content: JSON.stringify({ assunto, contexto, como_retomar, encerrado: false }) }
  }).catch(() => {});
  console.log(`[Pendência] Salva: "${assunto}"`);
}

async function fecharPendencia(userId, pendenciaId) {
  const mem = await prisma.memory.findUnique({ where: { id: pendenciaId } }).catch(() => null);
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
  // Uma pendência só fecha se o texto realmente menciona esse assunto E:
  // 1. Tem sinal de resolução ("resolvido", "tudo bem", "passou"...), ou
  // 2. Tem verbo no passado referente a ele ("já fiz", "já tomei"...)
  // Nunca fecha por sinal genérico isolado, sem menção ao assunto.
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

  // Fechamento só acontece quando o texto realmente menciona o assunto —
  // nunca por sinal genérico isolado. Antes, uma frase solta como "tá tudo
  // bem" ou "normal" (comuns em qualquer conversa, sobre QUALQUER coisa)
  // fechava a pendência mais recente mesmo sem nenhuma relação com ela —
  // isso fazia assuntos em aberto "sumirem" no meio do dia sem motivo real.

  for (const id of fechadas) {
    await fecharPendencia(userId, id);
  }

  // ── Limpeza automática de pendências velhas (> 7 dias) ──
  // Assunto de mais de uma semana sem resolução provavelmente já não é relevante.
  // Remove silenciosamente para não acumular lixo.
  const seteDiasAtras = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const velhas = pendencias.filter(p =>
    !fechadas.includes(p.id) &&
    p.criadoEm && new Date(p.criadoEm) < seteDiasAtras
  );
  for (const p of velhas) {
    await fecharPendencia(userId, p.id);
    console.log(`[Pendência] Expirada por idade (>7 dias): "${p.assunto}"`);
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

async function getLocalizacao(userId) {
  try {
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

// ── getCidadeAtual ─────────────────────────────────────────────────────────
async function getCidadeAtual(userId) {
  try {
    const gps = await prisma.memory.findFirst({ where: { userId, type: 'ultima_localizacao' } }).catch(() => null);
    if (gps) {
      const d = JSON.parse(gps.content);
      if (d.cidade && (!d.ts || Date.now() - d.ts < 7 * 24 * 60 * 60 * 1000)) return d.cidade;
    }
  } catch {}
  try {
    const t = await prisma.memory.findFirst({ where: { userId, type: 'cidade' }, orderBy: { createdAt: 'desc' } }).catch(() => null);
    if (t?.content) return t.content;
  } catch {}
  try {
    const infos = await prisma.memory.findMany({ where: { userId, type: 'info_pessoal' }, take: 60 }).catch(() => []);
    for (const info of infos) {
      let meta = {}; try { meta = JSON.parse(info.metadata || '{}'); } catch {}
      const chave = (meta.chave || '').toLowerCase();
      if (/cidade|mora|moradia|reside|residência|local/.test(chave)) return info.content;
    }
  } catch {}
  return '';
}

// ── Janela de conversa recorrente ──────────────────────────────────────
// Detecta se existe um padrão real: conversaram nessa mesma janela de
// horário em N dias seguidos (não intercalados). Isso é o que autoriza
// a Clara a SUGERIR uma chamada nesse horário — sem esse padrão, ela
// nunca sugere, só age se o usuário pedir (chamada_combinada explícita).
const JANELAS_HORARIO = {
  almoco: { inicio: 11 * 60 + 30, fim: 13 * 60 + 30 }, // 11:30–13:30
  noite:  { inicio: 19 * 60,      fim: 22 * 60 },      // 19:00–22:00
};
async function getJanelaConversaConsecutiva(userId, periodo, diasNecessarios = 3) {
  const janela = JANELAS_HORARIO[periodo];
  if (!janela) return false;
  try {
    const desde = new Date(Date.now() - (diasNecessarios + 1) * 24 * 60 * 60 * 1000);
    const msgs = await prisma.memory.findMany({
      where: { userId, type: 'conversa', createdAt: { gte: desde } },
      orderBy: { createdAt: 'asc' }
    }).catch(() => []);
    if (!msgs.length) return false;

    // Agrupa por dia (BRT) se teve pelo menos 1 mensagem dentro da janela
    const diasComConversaNaJanela = new Set();
    for (const m of msgs) {
      const d = new Date(m.createdAt);
      const brt = new Date(d.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
      const minutosDoDia = brt.getHours() * 60 + brt.getMinutes();
      if (minutosDoDia >= janela.inicio && minutosDoDia <= janela.fim) {
        const diaKey = `${brt.getFullYear()}-${brt.getMonth()}-${brt.getDate()}`;
        diasComConversaNaJanela.add(diaKey);
      }
    }

    // Confere se os últimos `diasNecessarios` dias (não contando hoje)
    // TODOS têm conversa nessa janela — precisa ser consecutivo, não só
    // "aconteceu 3 vezes esse mês".
    const hojeBRT = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    for (let i = 1; i <= diasNecessarios; i++) {
      const dia = new Date(hojeBRT); dia.setDate(dia.getDate() - i);
      const diaKey = `${dia.getFullYear()}-${dia.getMonth()}-${dia.getDate()}`;
      if (!diasComConversaNaJanela.has(diaKey)) return false;
    }
    return true;
  } catch { return false; }
}

// ── salvarMemoriaRelacional ────────────────────────────────────────────────
async function salvarMemoriaRelacional(userId, conteudo, categoria, tags = []) {
  try {
    const existe = await prisma.memory.findFirst({
      where: { userId, type: 'memoria_relacional', content: { contains: conteudo.slice(0, 20) } }
    }).catch(() => null);
    if (existe) return;
    const data = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
    await prisma.memory.create({ data: {
      userId, type: 'memoria_relacional',
      content: conteudo.slice(0, 300),
      metadata: JSON.stringify({ categoria, tags, data, criadoEm: new Date().toISOString() })
    }}).catch(() => {});
    console.log(`[MemóriaRelacional] ${categoria}: "${conteudo.slice(0, 60)}"`);
  } catch {}
}

module.exports = {
  prisma,
  getOrCreateUser,
  saveJornada, getJornada,
  saveUserPreference, getUserPreference,
  savePersonalInfo, deletePersonalInfo, getPersonalInfo, buildPersonalContext,
  getCamposDesconhecidos, getProximaCuriosidade, CAMPOS_CURIOSIDADE, CATEGORIAS_PERFIL,
  salvarSuspeitaPerfil, getSuspeitasPerfil,
  saveMemory, getRecentMemories,
  setTemporaryContext, getTemporaryContext, clearTemporaryContext,
  saveConversationMessage, getConversationHistory, getGapUltimaMensagem,
  saveMedication, saveTask,
  saveExpense, getMonthExpenses,
  saveContact, getContacts, findContactByName,
  savePendencia,
  getPendenciasAbertas, salvarOuAtualizarPendencia, fecharPendencia, fecharPendenciasPorResolucao, fecharPendenciaLembrete,
  salvarHumorDia, getHumorDia, salvarLocalizacao, getLocalizacao, getCidadeAtual,
  salvarMemoriaAfetiva, getMemoriaAfetiva,
  salvarResumoRelacionamento, getResumoRelacionamento,
  salvarMemoriaRelacional, getJanelaConversaConsecutiva,
};
