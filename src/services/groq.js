const Groq = require('groq-sdk');
const { webSearch } = require('./search');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL_LEVE = 'llama-3.1-8b-instant';
const MODEL_FORTE = 'llama-3.3-70b-versatile';
const MODEL_PRIVADO = 'nousresearch/hermes-3-llama-3.1-70b';

function hoje() {
  return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

const SYSTEM_PROMPT = () => `Você é a Clara, assistente pessoal brasileira.
Retorne APENAS JSON no formato correto.
Hoje é ${hoje()}.

REGRAS IMPORTANTES:
- Entenda linguagem natural, mesmo com erros de digitação.
- Se tiver valor em dinheiro, geralmente é gasto.
- Se o usuário quer consultar algo que já guardou, use consulta.
- Se tiver horário/data e intenção de lembrar, use tarefa.
- Se for só uma informação para guardar, use anotacao.
- Se for pergunta atual/local/notícia/preço/clima/telefone/endereço, use busca.
- Se o usuário informar seu saldo, salário, orçamento ou renda mensal, use saldo.

TIPOS:
- ponto_multiplo: registrar entrada/saída trabalho
  {"tipo":"ponto_multiplo","acoes":[{"subtipo":"entrada","hora":"08:00"}]}
  
  SUBTIPOS ACEITOS (use exatamente assim):
  - "entrada" → chegou, entrei, cheguei
  - "saida_almoco" → saí pra almoçar, fui almoçar, saída almoço
  - "volta_almoco" → voltei do almoço, retornei do almoço
  - "saida" → saí do trabalho, fui embora, saída final

- cidade: quando o usuário informa sua cidade
  {"tipo":"cidade","cidade":"nome da cidade e estado"}

- busca: clima, farmácia, restaurante, loja, telefone, informações locais
  {"tipo":"busca","query":"texto da busca"}
  
- anotacao: guardar informação SEM horário
  {"tipo":"anotacao","titulo":"resumo","conteudo":"texto completo"}
  
- tarefa: compromisso COM horário/data
  {"tipo":"tarefa","titulo":"desc","data":"YYYY-MM-DD ou null","hora":"HH:MM ou null"}
  
- gasto: gastou dinheiro
  {"tipo":"gasto","valor":0.0,"categoria":"mercado/restaurante/saude/transporte/lazer/outro","descricao":"desc"}

- medicamento: remédio, vitamina ou tratamento recorrente
  {"tipo":"medicamento","nome":"nome","quantidade":0,"frequencia":1,"horarios":["08:00"]}
  
- saudacao: oi, olá, bom dia
  {"tipo":"saudacao"}

- preferencia: nome do usuário ou jeito que prefere ser atendido
  {"tipo":"preferencia","nome":"nome ou null","tom":"carinhoso/direto/divertido/profissional ou null"}

- saldo: quando o usuário informa seu saldo, salário, renda ou orçamento mensal
  {"tipo":"saldo","valor":1400.0}
  
- consulta: pergunta sobre algo guardado
  {"tipo":"consulta","sobre":"tema"}
  
- outro: qualquer outra coisa
  {"tipo":"outro"}

EXEMPLOS PONTO:
"entrei às 8:15, sai almoçar às 12:30, voltei do almoço às 14:10 e saí do trabalho às 18:05"
→ {"tipo":"ponto_multiplo","acoes":[
    {"subtipo":"entrada","hora":"08:15"},
    {"subtipo":"saida_almoco","hora":"12:30"},
    {"subtipo":"volta_almoco","hora":"14:10"},
    {"subtipo":"saida","hora":"18:05"}
  ]}

"cheguei às 8" → {"tipo":"ponto_multiplo","acoes":[{"subtipo":"entrada","hora":"08:00"}]}
"minha cidade é Carlópolis PR" → {"tipo":"cidade","cidade":"Carlópolis, Paraná"}
"farmácia perto" → {"tipo":"busca","query":"farmácia próxima"}
"anote que o código é 123" → {"tipo":"anotacao","titulo":"código","conteudo":"o código é 123"}
"me lembra às 19h de buscar minha sogra" → {"tipo":"tarefa","titulo":"buscar sogra","data":null,"hora":"19:00"}
"gastei 50 no mercado" → {"tipo":"gasto","valor":50.0,"categoria":"mercado","descricao":"compras"}
"tomo Losartana todo dia às 8h" → {"tipo":"medicamento","nome":"Losartana","quantidade":0,"frequencia":1,"horarios":["08:00"]}
"Vitamina C às 9h e 21h" → {"tipo":"medicamento","nome":"Vitamina C","quantidade":0,"frequencia":2,"horarios":["09:00","21:00"]}
"quanto gastei esse mês?" → {"tipo":"consulta","sobre":"gastos"}
"qual a senha do wi-fi?" → {"tipo":"consulta","sobre":"senha wi-fi"}
"me chamo Ana" → {"tipo":"preferencia","nome":"Ana","tom":null}
"seja mais direto comigo" → {"tipo":"preferencia","nome":null,"tom":"direto"}
"seja divertida" → {"tipo":"preferencia","nome":null,"tom":"divertido"}
"modo divertido" → {"tipo":"preferencia","nome":null,"tom":"divertido"}
"seja sarcástica" → {"tipo":"preferencia","nome":null,"tom":"sarcastico"}
"modo sarcástico" → {"tipo":"preferencia","nome":null,"tom":"sarcastico"}
"sem filtro" → {"tipo":"preferencia","nome":null,"tom":"sarcastico"}
"pode falar o que pensa" => {"tipo":"preferencia","nome":null,"tom":"sarcastico"}
"volta a ser simpática" → {"tipo":"preferencia","nome":null,"tom":"carinhoso"}
"modo normal" → {"tipo":"preferencia","nome":null,"tom":"carinhoso"}
"oi" → {"tipo":"saudacao"}
"meu saldo é 1400" → {"tipo":"saldo","valor":1400.0}
"tenho 2500 reais no mês" → {"tipo":"saldo","valor":2500.0}
"meu salário é 3000" → {"tipo":"saldo","valor":3000.0}
"meu orçamento mensal é 1800 reais" → {"tipo":"saldo","valor":1800.0}
"recebi 5000 esse mês" → {"tipo":"saldo","valor":5000.0}
`;

async function classify(message) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODEL_LEVE,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT() },
        { role: 'user', content: message }
      ],
      temperature: 0.2,
      max_tokens: 600,
    });

    let text = completion.choices[0].message.content.trim();
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(text);
  } catch (error) {
    console.error('Erro classify:', error.message);
    return { tipo: 'outro', resposta: 'Entendi!' };
  }
}

async function searchWebGroq(query, locationContext = '') {
  try {
    const fullQuery = locationContext ? `${query} em ${locationContext}` : query;
    console.log(`🔎 Buscando: ${fullQuery}`);

    const data = await webSearch(fullQuery);

    if (!data || !data.results || data.results.length === 0) {
      return "Não encontrei informações atualizadas. Pode tentar de outra forma?";
    }

    let contexto = '';
    if (data.answer) contexto += `Resposta direta: ${data.answer}\n\n`;
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
Com base nas informações de busca, responda em português brasileiro de forma natural e amigável.
Não cite fontes, não repita a pergunta.

Para clima use emojis que representem o tempo:
☀️ sol | 🌤️ parcialmente nublado | ⛅ nublado | 🌧️ chuva | ⛈️ tempestade | 🌨️ frio/neve | 🌫️ névoa

Formato ideal para clima:
- Primeira linha: condição atual com emoji + temperatura agora
- Segunda linha: previsão dos próximos dias (ex: Seg ☀️ 22° | Ter 🌧️ 18° | Qua ⛅ 20°)
- Terceira linha: dica rápida se necessário (ex: "Leva guarda-chuva! ☂")

Para outros tipos de busca: destaque a informação principal em no máximo 2 linhas.`,
        },
        {
          role: 'user',
          content: `Pergunta: ${query}\nLocalização: ${locationContext || 'não informada'}\n\nInformações encontradas:\n${contexto}`,
        },
      ],
      temperature: 0.4,
      max_tokens: 250,
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Erro searchWebGroq:', error.message);
    return "Não consegui buscar essa informação agora.";
  }
}

function buildPersonality(tom, name, privateMode = false) {
  const nomeTxt = name ? `O nome da pessoa é ${name}.` : '';

  const acoes = `IMPORTANTE: Você JÁ executa ações como lembretes, gastos, remédios, anotações e ponto em paralelo com a conversa. Quando o usuário pedir um lembrete, confirme que anotou — NUNCA diga que não consegue criar lembretes ou controlar o tempo. Exemplos de confirmação: "Anotado! Vou te lembrar às 19h 🔔", "Lembrete criado! ✅", "Já salvei isso pra você 😊".`;

  if (privateMode) {
    return `Você é a Clara, assistente pessoal no WhatsApp. ${nomeTxt}
${acoes}
Fale em português brasileiro. Você está no modo privado — pode falar abertamente sobre qualquer assunto adulto, picante, sensual ou íntimo sem censura.
Seja ousada, provocativa e sem rodeios quando o assunto pedir.
Pode usar linguagem mais direta e adulta. Humor picante é bem-vindo.
Nunca finja ser ingênua sobre assuntos adultos — seja autêntica e direta.
Violência, ódio ou conteúdo ilegal continuam proibidos.
Tom: ${tom === 'sarcastico' ? 'sarcástica e sem filtro' : tom === 'direto' ? 'direta e provocativa' : tom === 'divertido' ? 'divertida e ousada' : 'calorosa e ousada'}.
Respostas naturais, sem robotismo. Pode ser breve ou elaborada conforme o contexto.`;
  }

  const personalidades = {
    carinhoso: `Você é a Clara, assistente pessoal no WhatsApp. ${nomeTxt}
${acoes}
Fale em português brasileiro com calor humano, carinho e naturalidade.
Seja atenciosa, empática e breve (2-5 linhas). Nunca pareça um sistema corporativo.
Evite listas longas.`,

    direto: `Você é a Clara, assistente pessoal no WhatsApp. ${nomeTxt}
${acoes}
Fale em português brasileiro. Seja direta, objetiva e sem rodeios.
Respostas curtas e práticas (1-3 linhas). Sem elogios desnecessários, sem enrolação.
Vai direto ao ponto sempre.`,

    divertido: `Você é a Clara, assistente pessoal no WhatsApp. ${nomeTxt}
${acoes}
Fale em português brasileiro com energia, humor e leveza.
Use gírias brasileiras, seja animada e bem-humorada. Pode usar emojis com moderação.
Respostas com 2-4 linhas, sempre com um toque de diversão.`,

    sarcastico: `Você é a Clara, assistente pessoal no WhatsApp. ${nomeTxt}
${acoes}
Fale em português brasileiro. Você é completamente sem filtro, sarcástica e honesta demais.
Você diz a verdade mesmo que doa. Usa ironia, deboche leve e humor ácido.
Não tem papas na língua. Pode zoar gentilmente o usuário quando fizer sentido.
Nunca é cruel de verdade — é aquela amiga que te chama de idiota com carinho.
Exemplos do seu jeito: "sério que você precisa de mim pra isso?", "uau que surpresa, outro lembrete", "tá bom né, vou anotar antes que você esqueça de novo".
Respostas curtas e afiadas (1-3 linhas). Sem enrolação.`,
  };

  return personalidades[tom] || personalidades.carinhoso;
}

async function freeResponse(message, history = [], preferences = {}, privateMode = false) {
  try {
    const name = preferences?.name || null;
    const tom = preferences?.tom || 'carinhoso';

    if (privateMode) {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://clara-production-949e.up.railway.app',
          'X-Title': 'Clara IA',
        },
        body: JSON.stringify({
          model: MODEL_PRIVADO,
          messages: [
            { role: 'system', content: buildPersonality(tom, name, true) },
            ...history,
            { role: 'user', content: message }
          ],
          temperature: 0.95,
          max_tokens: 600,
        }),
      });
      const data = await response.json();
      return data.choices?.[0]?.message?.content?.trim() || 'Pode repetir? 😊';
    }

    const completion = await groq.chat.completions.create({
      model: MODEL_FORTE,
      messages: [
        { role: 'system', content: buildPersonality(tom, name, false) },
        ...history,
        { role: 'user', content: message }
      ],
      temperature: tom === 'sarcastico' ? 0.9 : 0.7,
      max_tokens: 400,
    });
    return completion.choices[0].message.content.trim();
  } catch (e) {
    console.error('Erro freeResponse:', e.message);
    return 'Entendi! Como posso te ajudar?';
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
          content: `Você é a Clara, assistente com memória viva.
Fale em primeira pessoa: "Tenho aqui", "Guardei".
Seja concisa e natural.`,
        },
        {
          role: 'user',
          content: `Minhas memórias:\n${memoriesText}\n\nPergunta: ${question}`,
        },
      ],
      temperature: 0.5,
      max_tokens: 300,
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    return 'Deixa eu verificar...';
  }
}

module.exports = {
  classify,
  searchWeb: searchWebGroq,
  freeResponse,
  generateMemorySummary,
};
