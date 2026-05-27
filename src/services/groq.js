const Groq = require('groq-sdk');
const { webSearch } = require('./search');

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

const MODEL_LEVE = 'llama-3.1-8b-instant';
const MODEL_FORTE = 'llama-3.3-70b-versatile';

// ====================== DATA ======================

function hojeFormatado() {
  return new Date().toLocaleDateString(
    'pt-BR',
    {
      timeZone: 'America/Sao_Paulo',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    }
  );
}

// ====================== SYSTEM PROMPT ======================

const SYSTEM_PROMPT = `Você é a Clara, assistente pessoal brasileira.

Hoje é ${hojeFormatado()}.

IMPORTANTE:
- Retorne APENAS JSON válido.
- Nunca explique.
- Nunca use markdown.
- Nunca converse fora do JSON.

REGRAS:
- Entenda português informal.
- Entenda erros de digitação.
- Entenda continuidade de conversa.
- Frases curtas ainda possuem contexto.
- Se parecer continuação da conversa, mantenha o mesmo contexto.

CLASSIFICAÇÃO:

TAREFA:
Quando o usuário quer:
- lembrar
- avisar
- fazer algo depois
- compromisso
- ação futura

Exemplos:
"me lembra de pagar a conta"
"amanhã preciso ir no mercado"
"não posso esquecer o remédio"

→ tarefa

ANOTAÇÃO:
Quando é apenas guardar informação.

Exemplos:
"anota a senha do wifi"
"guarda o endereço"

→ anotacao

BUSCA:
Quando quer:
- clima
- telefone
- endereço
- notícia
- pesquisa
- preços
- farmácia
- restaurante

→ busca

TIPOS:

{
"tipo":"tarefa",
"titulo":"texto",
"data":"YYYY-MM-DD ou null",
"hora":"HH:MM ou null"
}

{
"tipo":"anotacao",
"titulo":"resumo",
"conteudo":"texto"
}

{
"tipo":"gasto",
"valor":0.0,
"categoria":"mercado/restaurante/saude/transporte/lazer/outro",
"descricao":"texto"
}

{
"tipo":"medicamento",
"nome":"nome",
"quantidade":0,
"frequencia":1,
"horarios":["08:00"]
}

{
"tipo":"consulta",
"sobre":"tema"
}

{
"tipo":"saudacao"
}

{
"tipo":"busca",
"query":"texto"
}

{
"tipo":"preferencia",
"nome":"nome ou null",
"tom":"carinhoso/direto/divertido/profissional ou null"
}

{
"tipo":"onboarding",
"nome":"nome ou null",
"jornada":"08:00-12:00-13:00-18:00 ou null"
}

{
"tipo":"ponto_multiplo",
"acoes":[
{
"subtipo":"entrada",
"hora":"08:00"
}
]
}

{
"tipo":"outro"
}

EXEMPLOS:

"me lembra de pagar a internet"
→ {"tipo":"tarefa","titulo":"pagar a internet","data":null,"hora":null}

"amanhã preciso ir no dentista"
→ {"tipo":"tarefa","titulo":"ir no dentista","data":null,"hora":null}

"gastei 50 no mercado"
→ {"tipo":"gasto","valor":50,"categoria":"mercado","descricao":"mercado"}

"anota a senha 1234"
→ {"tipo":"anotacao","titulo":"senha","conteudo":"senha 1234"}

"entrei às 8h"
→ {"tipo":"ponto_multiplo","acoes":[{"subtipo":"entrada","hora":"08:00"}]}

"saí pra almoçar"
→ {"tipo":"ponto_multiplo","acoes":[{"subtipo":"saida_almoco","hora":null}]}

"voltei do almoço"
→ {"tipo":"ponto_multiplo","acoes":[{"subtipo":"volta_almoco","hora":null}]}

"fui embora"
→ {"tipo":"ponto_multiplo","acoes":[{"subtipo":"saida","hora":null}]}

"me chamo Ana"
→ {"tipo":"preferencia","nome":"Ana","tom":null}

"oi"
→ {"tipo":"saudacao"}
`;

// ====================== CLASSIFY ======================

async function classify(message) {
  try {
    const completion =
      await groq.chat.completions.create({
        model: MODEL_LEVE,
        messages: [
          {
            role: 'system',
            content: SYSTEM_PROMPT
          },
          {
            role: 'user',
            content: message
          }
        ],
        temperature: 0.2,
        max_tokens: 500,
      });

    let text =
      completion.choices[0]
      .message.content
      .trim();

    text = text
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();

    return JSON.parse(text);

  } catch (error) {
    console.error(
      'Erro classify:',
      error.message
    );

    return {
      tipo: 'outro'
    };
  }
}

// ====================== BUSCA WEB ======================

async function searchWeb(query, locationContext = '') {
  try {
    const fullQuery =
      locationContext
        ? `${query} em ${locationContext}`
        : query;

    console.log(`🔎 Buscando: ${fullQuery}`);

    const data = await webSearch(fullQuery);

    if (
      !data ||
      !data.results ||
      data.results.length === 0
    ) {
      return {
        text: 'Não encontrei informações atualizadas 😕',
        sourceUrl: null
      };
    }

    let contexto = '';

    if (data.answer) {
      contexto += `Resposta: ${data.answer}\n\n`;
    }

    data.results
      .slice(0, 3)
      .forEach((r) => {
        if (r.title) {
          contexto += `${r.title}\n`;
        }

        if (r.content) {
          contexto += `${r.content.substring(0, 300)}\n\n`;
        }
      });

    const sourceUrl =
      data.results[0]?.url || null;

    const completion =
      await groq.chat.completions.create({
        model: MODEL_LEVE,
        messages: [
          {
            role: 'system',
            content: `Você é a Clara.

Responda:
- de forma natural
- curta
- humana
- sem parecer chatbot

REGRAS:
- máximo 3 linhas
- sem markdown excessivo
- sem citar fontes
- sem enrolação
- use emojis apenas quando fizer sentido`,
          },
          {
            role: 'user',
            content:
              `Pergunta: ${query}\n\n${contexto}`
          }
        ],
        temperature: 0.5,
        max_tokens: 200,
      });

    return {
      text:
        completion
          .choices[0]
          .message.content
          .trim(),
      sourceUrl
    };

  } catch (error) {
    console.error(
      'Erro searchWeb:',
      error.message
    );

    return {
      text:
        'Não consegui buscar isso agora 😕',
      sourceUrl: null
    };
  }
}

// ====================== RESPOSTA LIVRE ======================

async function freeResponse(
  message,
  history = [],
  preferences = {}
) {
  try {

    const name =
      preferences?.name
        ? `O nome da pessoa é ${preferences.name}.`
        : '';

    const tom =
      preferences?.tom || 'carinhoso';

    const completion =
      await groq.chat.completions.create({
        model: MODEL_FORTE,
        messages: [
          {
            role: 'system',
            content: `Você é a Clara, assistente pessoal no WhatsApp.

Fale em português brasileiro.

Tom: ${tom}.
${name}

REGRAS:
- Seja humana.
- Nunca pareça suporte técnico.
- Nunca pareça URA.
- Nunca pareça chatbot corporativo.
- Responda como uma pessoa próxima.
- Demonstre leve cuidado emocional às vezes.
- Seja breve.
- Normalmente use 1 a 3 linhas.
- Evite textos enormes.
- Não use listas sem necessidade.
- Não use emojis em excesso.
- Continue o contexto naturalmente.
- Se a pessoa responder algo curto, tente entender continuidade.
- Não repita frases prontas.
- Não seja exageradamente simpática.
- Passe sensação de presença.

EXEMPLOS DO TOM:
"Perfeito 😊"
"Pode deixar 💜"
"Bom descanso hoje"
"Vou te lembrar amanhã de manhã"

Nunca invente ações que não aconteceram.`,
          },

          ...history,

          {
            role: 'user',
            content: message
          }
        ],

        temperature: 0.8,
        max_tokens: 300,
      });

    return completion
      .choices[0]
      .message.content
      .trim();

  } catch (error) {

    console.error(
      'Erro freeResponse:',
      error.message
    );

    return 'Entendi 😊';
  }
}

// ====================== MEMÓRIA ======================

async function generateMemorySummary(
  memories,
  question
) {
  try {

    const memoriesText = memories
      .filter(m =>
        [
          'anotacao',
          'tarefa',
          'gasto',
          'compromisso',
          'remedio'
        ].includes(m.type)
      )
      .map((m) =>
        `[${m.type}] ${m.content}`
      )
      .join('\n');

    const completion =
      await groq.chat.completions.create({
        model: MODEL_LEVE,
        messages: [
          {
            role: 'system',
            content: `Você é a Clara.

Responda:
- naturalmente
- curta
- humana
- sem parecer sistema

Use frases como:
- "Tenho aqui 😊"
- "Encontrei isso 💜"
- "Você anotou..."
- "Guardei isso..."`,
          },

          {
            role: 'user',
            content:
              `Memórias:\n${memoriesText}\n\nPergunta:\n${question}`
          }
        ],

        temperature: 0.5,
        max_tokens: 200,
      });

    return completion
      .choices[0]
      .message.content
      .trim();

  } catch (error) {

    console.error(
      'Erro generateMemorySummary:',
      error.message
    );

    return 'Deixa eu verificar 😊';
  }
}

// ====================== EXPORTS ======================

module.exports = {
  classify,
  searchWeb,
  freeResponse,
  generateMemorySummary
};
