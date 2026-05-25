const Groq = require('groq-sdk');
const { webSearch } = require('./search');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL_LEVE = 'llama-3.1-8b-instant';
const MODEL_FORTE = 'llama-3.3-70b-versatile';

const SYSTEM_PROMPT = `Você é a Clara, assistente pessoal brasileira.
Retorne APENAS JSON válido, sem markdown.

Hoje é ${new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.

TIPOS:
- saudacao:
{"tipo":"saudacao"}

- cidade:
{"tipo":"cidade","cidade":"nome da cidade e estado"}

- busca:
{"tipo":"busca","query":"texto da busca"}

- anotacao:
{"tipo":"anotacao","titulo":"resumo","conteudo":"texto completo"}

- tarefa:
{"tipo":"tarefa","titulo":"desc","data":"YYYY-MM-DD ou null","hora":"HH:MM ou null"}

- gasto:
{"tipo":"gasto","valor":0.0,"categoria":"mercado/restaurante/saude/transporte/lazer/outro","descricao":"desc"}

- medicamento:
{"tipo":"medicamento","nome":"nome","quantidade":0,"frequencia":1,"horarios":["08:00"]}

- ponto_multiplo:
{"tipo":"ponto_multiplo","acoes":[{"subtipo":"entrada","hora":"08:00"}]}

Subtipos de ponto:
entrada, saida_almoco, volta_almoco, saida

- consulta:
{"tipo":"consulta","sobre":"tema"}

- preferencia:
{"tipo":"preferencia","nome":"nome ou null","tom":"carinhoso/direto/divertido/profissional ou null"}

- outro:
{"tipo":"outro"}

REGRAS:
- Se tiver valor em dinheiro, geralmente é gasto.
- Se perguntar algo atual, local, clima, preço, endereço ou telefone, use busca.
- Se perguntar algo que já foi guardado, use consulta.
- Se tiver intenção de lembrar com horário/data, use tarefa.
- Se for remédio, vitamina ou tratamento recorrente, use medicamento.
- Se for informação para guardar sem horário, use anotacao.
- Entenda erros de digitação.

EXEMPLOS:
"oi" -> {"tipo":"saudacao"}
"minha cidade é Carlópolis PR" -> {"tipo":"cidade","cidade":"Carlópolis, Paraná"}
"vai chover amanhã?" -> {"tipo":"busca","query":"previsão do tempo amanhã"}
"farmácia perto de mim" -> {"tipo":"busca","query":"farmácia perto de mim"}
"anota senha do wifi 12345" -> {"tipo":"anotacao","titulo":"senha do wifi","conteudo":"senha do wifi 12345"}
"qual a senha do wifi?" -> {"tipo":"consulta","sobre":"senha do wifi"}
"me lembra às 19h de buscar minha filha" -> {"tipo":"tarefa","titulo":"buscar minha filha","data":null,"hora":"19:00"}
"gastei 50 no mercado" -> {"tipo":"gasto","valor":50.0,"categoria":"mercado","descricao":"mercado"}
"tomo Losartana todo dia às 8h" -> {"tipo":"medicamento","nome":"Losartana","quantidade":0,"frequencia":1,"horarios":["08:00"]}
"Vitamina C às 9h e 21h" -> {"tipo":"medicamento","nome":"Vitamina C","quantidade":0,"frequencia":2,"horarios":["09:00","21:00"]}
"entrei às 8, saí almoço 12h, voltei 13h e saí 17h" -> {"tipo":"ponto_multiplo","acoes":[{"subtipo":"entrada","hora":"08:00"},{"subtipo":"saida_almoco","hora":"12:00"},{"subtipo":"volta_almoco","hora":"13:00"},{"subtipo":"saida","hora":"17:00"}]}
"me chamo Ana" -> {"tipo":"preferencia","nome":"Ana","tom":null}
"seja mais direto comigo" -> {"tipo":"preferencia","nome":null,"tom":"direto"}
`;

function limparJson(text) {
  return text
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
}

async function classify(message) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODEL_LEVE,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: message }
      ],
      temperature: 0.2,
      max_tokens: 700,
    });

    const text = limparJson(completion.choices[0].message.content || '');
    return JSON.parse(text);
  } catch (error) {
    console.error('Erro classify:', error.message);
    return { tipo: 'outro' };
  }
}

async function searchWeb(query, locationContext = '') {
  try {
    const fullQuery = locationContext ? `${query} em ${locationContext}` : query;
    console.log(`🔎 Buscando: ${fullQuery}`);

    const data = await webSearch(fullQuery);

    if (!data || !data.results || data.results.length === 0) {
      return 'Não encontrei informações atualizadas. Pode tentar de outro jeito?';
    }

    let contexto = '';

    if (data.answer) {
      contexto += `Resposta direta: ${data.answer}\n\n`;
    }

    data.results.slice(0, 3).forEach((r) => {
      if (r.title) contexto += `Fonte: ${r.title}\n`;
      if (r.content) contexto += `${r.content.substring(0, 300)}\n\n`;
    });

    const completion = await groq.chat.completions.create({
      model: MODEL_LEVE,
      messages: [
        {
          role: 'system',
          content: `Você é a Clara, assistente pessoal simpática e direta.
Responda em português brasileiro, de forma natural e útil.
Não cite fontes.
Não repita a pergunta.
Para clima, use emoji e seja bem objetiva.
Para telefone, endereço ou local, destaque a informação principal.`
        },
        {
          role: 'user',
          content: `Pergunta: ${query}
Localização: ${locationContext || 'não informada'}

Informações encontradas:
${contexto}`
        }
      ],
      temperature: 0.4,
      max_tokens: 300,
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Erro searchWeb:', error.message);
    return 'Não consegui buscar essa informação agora.';
  }
}

async function freeResponse(message, history = [], preferences = {}) {
  try {
    const name = preferences?.name ? `O nome da pessoa é ${preferences.name}.` : '';
    const tom = preferences?.tom || 'carinhoso';

    const completion = await groq.chat.completions.create({
      model: MODEL_FORTE,
      messages: [
        {
          role: 'system',
          content: `Você é a Clara, uma assistente pessoal no WhatsApp.
Fale em português brasileiro.
Seja humana, acolhedora, objetiva e natural.
Tom preferido: ${tom}. ${name}

Regras:
- Responda em 2 a 5 linhas quando possível.
- Se faltar informação, faça uma pergunta simples.
- Não diga que salvou, pesquisou ou agendou se o sistema não fez essa ação.
- Evite texto corporativo.`
        },
        ...history,
        { role: 'user', content: message }
      ],
      temperature: 0.7,
      max_tokens: 450,
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Erro freeResponse:', error.message);
    return 'Entendi. Me conta um pouco melhor como posso te ajudar?';
  }
}

async function generateMemorySummary(memories, question) {
  try {
    const memoriesText = memories
      .map((m) => `[${m.type}] ${m.content} (${new Date(m.createdAt).toLocaleDateString('pt-BR')})`)
      .join('\n');

    const completion = await groq.chat.completions.create({
      model: MODEL_LEVE,
      messages: [
        {
          role: 'system',
          content: `Você é a Clara, assistente com memória.
Responda em primeira pessoa, como "Tenho aqui" ou "Guardei".
Seja clara, curta e natural.`
        },
        {
          role: 'user',
          content: `Memórias salvas:
${memoriesText}

Pergunta:
${question}`
        }
      ],
      temperature: 0.5,
      max_tokens: 350,
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Erro generateMemorySummary:', error.message);
    return 'Não consegui consultar minhas memórias agora. Pode tentar de novo?';
  }
}

module.exports = {
  classify,
  searchWeb,
  freeResponse,
  generateMemorySummary,
};
