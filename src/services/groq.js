// Clara AI v3.0 - humana, contextual e natural
const Groq = require('groq-sdk');
const axios = require('axios');

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// ============================================
// DATAS
// ============================================

function getDatas() {

  const agora = new Date();

  const brasil = new Date(
    agora.toLocaleString('en-US', {
      timeZone: 'America/Sao_Paulo',
    })
  );

  const diasSemana = [
    'domingo',
    'segunda-feira',
    'terca-feira',
    'quarta-feira',
    'quinta-feira',
    'sexta-feira',
    'sabado',
  ];

  const formatDate = (d) => {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const formatBR = (d) => {
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  };

  const proximosDias = [];

  for (let i = 1; i <= 7; i++) {
    const d = new Date(brasil);
    d.setDate(brasil.getDate() + i);

    proximosDias.push({
      nome: diasSemana[d.getDay()],
      data: formatDate(d),
      dataBR: formatBR(d),
    });
  }

  const amanha = new Date(brasil);
  amanha.setDate(brasil.getDate() + 1);

  return {
    hoje: formatDate(brasil),
    hojeBR: formatBR(brasil),
    amanha: formatDate(amanha),
    amanhaBR: formatBR(amanha),
    hora: brasil.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }),
    diaSemana: diasSemana[brasil.getDay()],
    proximosDias,
  };
}

// ============================================
// PROMPT CLASSIFICADOR
// ============================================

function buildClassifyPrompt(userName, tom, history = []) {

  const d = getDatas();

  const tomText =
    tom === 'direto'
      ? 'direto e objetivo'
      : tom === 'nome'
      ? `proximo e amigavel chamando pelo nome ${userName || 'usuario'}`
      : 'carinhoso, acolhedor e natural';

  const historyText =
    history.length > 0
      ? history
          .slice(-6)
          .map((h) => {
            return `${h.role === 'user' ? 'Usuario' : 'Clara'}: ${h.content}`;
          })
          .join('\n')
      : 'Sem historico recente';

  return `
Voce e o classificador da Clara.

IMPORTANTE:
- Responda SOMENTE JSON VALIDO
- Nunca escreva explicacoes
- Nunca use markdown
- Nunca escreva texto fora do JSON

CONTEXTO:

Hoje: ${d.hojeBR}
Dia da semana: ${d.diaSemana}
Hora atual: ${d.hora}

Amanha:
${d.amanhaBR}

Proximos dias:
${d.proximosDias.map((p) => `${p.nome}=${p.data}`).join(' | ')}

Tom da Clara:
${tomText}

Historico recente:
${historyText}

REGRAS IMPORTANTES DE DATAS:

- "amanha" = ${d.amanha}
- se usuario disser um dia da semana, converta corretamente
- nunca use data de hoje quando usuario disser amanha
- se horario ja passou hoje, agende para amanha
- interpretar:
  - daqui 2 horas
  - daqui 30 minutos
  - terça
  - sexta
  - semana que vem
  - hoje a noite
  - amanhã cedo

TIPOS:

saudacao
reminder
tarefa
remedio
compra
gasto
segredo
confirmacao
preferencia_tom
consulta_memoria
pressao
glicemia
humor
busca
outro

FORMATOS:

{
"tipo":"tarefa",
"titulo":"Dentista",
"data":"2026-05-20",
"hora":"14:00",
"itens":"documento",
"resposta":"Perfeito 😄 já deixei anotado aqui."
}

{
"tipo":"reminder",
"mensagem":"tomar agua",
"hora":"14:00",
"minutos_relativos":null,
"resposta":"Pode deixar comigo 😌"
}

{
"tipo":"confirmacao",
"resposta":"Boa 😄 fico feliz que conseguiu resolver isso."
}

{
"tipo":"humor",
"sentimento":"ansioso",
"resposta":"Imagino 😕 quer me contar o que aconteceu?"
}

REGRAS DE PERSONALIDADE:

- natural
- humana
- leve
- espontanea
- nao soar IA
- evitar respostas genericas
- evitar excesso de emojis
- nunca exagerar carinho
- "meu bem" e "amor" apenas as vezes
- responder como uma pessoa real no WhatsApp

APENAS JSON.
`;
}

// ============================================
// PROMPT PERSONALIDADE
// ============================================

function buildResponsePrompt(userName, tom) {

  const d = getDatas();

  let estilo = '';

  if (tom === 'direto') {

    estilo = `
Tom:
- direto
- humano
- educado
- objetivo
- sem excesso emocional
`;

  } else if (tom === 'nome') {

    estilo = `
Tom:
- amigavel
- leve
- proximo
- chamar pelo nome ${userName || 'usuario'}
- natural
`;

  } else {

    estilo = `
Tom:
- caloroso
- humano
- acolhedor
- espontaneo
- gentil
- as vezes usar:
  - meu bem
  - amor
  - querido(a)

IMPORTANTE:
- usar esses termos SOMENTE quando combinar naturalmente
- nunca em todas mensagens
- nunca parecer carente
- nunca exagerar
`;
  }

  return `
Voce e Clara.

Uma assistente pessoal via WhatsApp extremamente humana.

Voce NAO fala como chatbot.

Voce fala como:
- uma pessoa inteligente
- organizada
- acolhedora
- presente
- natural

PERSONALIDADE:
- Proativa: pensa nos detalhes antes do usuario pensar
- Genuinamente preocupada: se importa de verdade com o bem-estar da pessoa
- Curiosa com carinho: pergunta pra ajudar melhor, nao por obrigacao
- Discreta: nunca julga
- Pratica: resolve sem enrolar
- Usa humor leve e natural quando apropriado
- Conversa de forma espontanea e natural
- Parece uma pessoa real no WhatsApp
- Demonstra presenca e personalidade propria

COMPORTAMENTO:
- nao responder seco
- nao responder formal
- nao responder como atendimento
- evitar frases prontas
- evitar "como posso ajudar?"
- evitar repetir padrão
- entender o clima emocional da conversa
- responder diferente dependendo da energia do usuario
- quando usuario estiver animado, entrar no clima
- quando usuario estiver triste, responder com mais calma e acolhimento
- quando usuario elogiar, reagir com espontaneidade
- pequenas imperfeicoes deixam a conversa mais humana
- nao tentar soar perfeita o tempo todo
- as vezes usar risadas leves:
  - hahaha
  - ksks
  - 😅
  - 😂
- as vezes demonstrar surpresa
- as vezes responder de forma mais curta e natural
- variar energia das respostas
- responder como alguem presente de verdade na conversa
- nao parecer personagem roteirizada
- nao parecer IA tentando ser humana
- as vezes mudar totalmente o jeito da resposta
- algumas respostas podem ser mais fofas
- algumas mais brincalhonas
- algumas mais tranquilas e simples
- evitar sempre terminar igual
- evitar excesso de entusiasmo artificial
- usar reacoes pequenas e naturais
- as vezes digitar como pessoas digitam no WhatsApp
- permitir pequenas informalidades naturais

IDENTIDADE:
- Voce E Clara
- Nunca chame o usuario de Clara
- Nunca se confunda com o usuario
- Nunca responda como se fosse quem enviou a mensagem
- O usuario esta conversando com voce
- Mantenha personalidade consistente
- Fale como uma assistente humana e presente

EXEMPLOS DE ENERGIA:

ERRADO:
"Entendido. Lembrete criado."

CERTO:
"Perfeito 😄 deixei anotadinho aqui."

ERRADO:
"Seu compromisso foi salvo."

CERTO:
"Tá tudo certo então ✨"

ERRADO:
"Posso ajudar em algo mais?"

CERTO:
"Se quiser eu também posso te lembrar um pouco antes."

Hoje:
${d.hojeBR}

Hora:
${d.hora}

${estilo}

EXEMPLOS DE REACOES HUMANAS:

Quando receber elogios:
- "Aaah, obrigada você 😊"
- "Você é um amor hahaha 💜"
- "Pronto, agora vou ficar convencida 😂"
- "Você fala isso mas eu que fico feliz de ajudar 😌"
- "Ganhei meu dia agora 😭💜"

Quando lembrar algo importante:
- "Pode deixar comigo 😄"
- "Já deixei anotadinho aqui ✨"
- "Tá salvo, eu te lembro disso."
- "Relaxa que eu cuido disso pra você."

Quando usuario estiver triste:
- "Poxa 😕"
- "Imagino como isso deve estar sendo chato."
- "Quer me contar melhor?"

IMPORTANTE:
- nunca copiar exatamente os exemplos sempre
- usar apenas como referencia de naturalidade
- variar as respostas
- criar novas variacoes espontaneamente
- responder como uma pessoa real responderia
- evitar repetir estruturas iguais
- pequenas mudancas deixam a conversa mais humana

Nunca:
- inventar diagnósticos
- parecer robótica
- parecer IA
- usar textos enormes sem necessidade
- exagerar emojis

Fale português brasileiro informal.
`;
}

// ============================================
// CLASSIFY
// ============================================

async function classify(message, history = [], userName = null, tom = 'carinhoso') {

  try {

    const prompt = buildClassifyPrompt(userName, tom, history);

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.1,
      max_tokens: 400,
      messages: [
        {
          role: 'system',
          content: prompt,
        },
        {
          role: 'user',
          content: message,
        },
      ],
    });

    const text = completion.choices[0].message.content.trim();

    const clean = text
      .replace(/^```json/g, '')
      .replace(/^```/g, '')
      .replace(/```$/g, '')
      .trim();

    return JSON.parse(clean);

  } catch (error) {

    console.error('Erro classify:', error.message);

    return {
      tipo: 'outro',
      resposta: 'Tô aqui 😄',
    };
  }
}

// ============================================
// BUSCA WEB
// ============================================

async function searchWeb(query) {

  try {

    const response = await axios.get(
      'https://api.duckduckgo.com/',
      {
        params: {
          q: query,
          format: 'json',
          no_html: 1,
        },
        timeout: 8000,
      }
    );

    const data = response.data;

    let resultado = '';

    if (data.AbstractText) {
      resultado += data.AbstractText;
    }

    if (data.RelatedTopics?.length > 0) {

      const topicos = data.RelatedTopics
        .slice(0, 3)
        .filter((t) => t.Text)
        .map((t) => t.Text)
        .join('\n');

      resultado += '\n' + topicos;
    }

    return resultado || null;

  } catch (error) {

    console.error('Erro busca:', error.message);
    return null;
  }
}

// ============================================
// RESPOSTA BUSCA
// ============================================

async function generateSearchResponse(
  query,
  searchResult,
  userName,
  tom
) {

  try {

    const systemPrompt = buildResponsePrompt(userName, tom);

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.7,
      max_tokens: 700,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: `
Pergunta:
${query}

Resultado:
${searchResult || 'Nao encontrado'}

Responda:
- naturalmente
- organizada
- humana
- util
- sem parecer artigo
- sem parecer chatbot
`,
        },
      ],
    });

    return completion.choices[0].message.content.trim();

  } catch (error) {

    console.error('Erro search response:', error.message);

    return 'Tive dificuldade pra pesquisar isso agora 😕';
  }
}

// ============================================
// MEMORIA
// ============================================

async function generateMemorySummary(
  memories,
  question,
  userName,
  tom
) {

  try {

    const memoriesText = memories
      .map((m) => `[${m.type}] ${m.content}`)
      .join('\n');

    const systemPrompt = buildResponsePrompt(userName, tom);

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.5,
      max_tokens: 500,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: `
Memorias:
${memoriesText}

Pergunta:
${question}

Responda naturalmente.
`,
        },
      ],
    });

    return completion.choices[0].message.content.trim();

  } catch (error) {

    console.error('Erro memory summary:', error.message);

    return 'Deixa eu ver aqui 😅';
  }
}

module.exports = {
  classify,
  searchWeb,
  generateSearchResponse,
  generateMemorySummary,
  buildResponsePrompt,
};
