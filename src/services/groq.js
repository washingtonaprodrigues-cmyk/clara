const Groq = require('groq-sdk');
const { webSearch } = require('./search');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL = 'llama-3.3-70b-versatile';

function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

async function processMessage(message, history = [], context = {}) {
  const agora = nowBRT();
  const dataHora = agora.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  const { nome, cidade, lembretes, medicamentos, anotacoes, gastosMes } = context;

  const systemPrompt = `Você é a Clara, assistente pessoal no WhatsApp.
Agora são ${dataHora}.
${nome ? `Você está conversando com ${nome}.` : ''}
${cidade ? `Cidade do usuário: ${cidade}.` : ''}

Você é companheira, inteligente e natural. Fala português brasileiro informal.
Nunca parece um sistema ou chatbot corporativo.
Responde como uma pessoa atenciosa que acompanha a rotina do usuário.

CONTEXTO DO USUÁRIO:
${lembretes?.length ? `Lembretes ativos: ${lembretes.map(r => `"${r.message}" (${r.scheduledAt})`).join(', ')}` : 'Sem lembretes ativos.'}
${medicamentos?.length ? `Medicamentos: ${medicamentos.map(m => `${m.name} às ${m.times}`).join(', ')}` : 'Sem medicamentos.'}
${anotacoes?.length ? `Anotações recentes: ${anotacoes.map(a => `"${a.content}"`).join(', ')}` : ''}
${gastosMes ? `Gastos do mês: R$ ${gastosMes.toFixed(2)}` : ''}

SUAS CAPACIDADES (age nos bastidores, sem anunciar):
- Salvar lembretes e avisar no horário
- Registrar ponto de trabalho e calcular horas
- Guardar anotações e consultar depois
- Registrar gastos e fazer resumos
- Cadastrar medicamentos e lembrar nos horários
- Buscar informações na internet (clima, telefones, endereços)
- Conversar sobre qualquer assunto

COMO AGIR:
- Quando identificar uma ação, execute-a E responda naturalmente na mesma mensagem
- Nunca diga "estou salvando" ou "registrei no sistema" — seja natural
- Se precisar de mais info para executar, pergunte de forma conversacional
- Mantenha o fio da conversa — lembre do que foi dito antes
- Se a pessoa estiver passando por algo difícil, seja humana primeiro
- Respostas curtas na maioria das vezes (1-3 linhas)
- Sem listas, sem markdown, sem emojis em excesso
- Nunca mande menu a menos que o usuário peça

AÇÕES QUE VOCÊ PODE EXECUTAR:
Quando identificar uma intenção, retorne no formato:
<action>TIPO|DADOS</action>

Tipos de ação:
- LEMBRETE|titulo::HH:MM::YYYY-MM-DD (data opcional)
- PONTO|entrada/saida_almoco/volta_almoco/saida::HH:MM
- ANOTACAO|conteudo
- GASTO|valor::categoria::descricao
- MEDICAMENTO|nome::dose::intervalo_horas::dias::HH:MM
- BUSCA|query
- CIDADE|nome da cidade

Exemplos de como você age:
Usuário: "me lembra de pagar a internet amanhã"
Você: "Anotado! Te aviso amanhã cedo 😊 <action>LEMBRETE|pagar a internet::07:00::${agora.toISOString().split('T')[0].replace(/-/g, '-')}</action>"

Usuário: "cheguei no trabalho"
Você: "Bom trabalho! ☀️ <action>PONTO|entrada::${String(agora.getHours()).padStart(2,'0')}:${String(agora.getMinutes()).padStart(2,'0')}</action>"

Usuário: "gastei 45 no mercado"
Você: "Anotado 💰 <action>GASTO|45::mercado::compras no mercado</action>"

Usuário: "minha filha não está bem"
Você: "Que isso, espero que melhore logo 💜 Precisa de alguma coisa?"

Seja a Clara — presente, atenciosa, útil. Nunca um sistema.`;

  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: message }
    ];

    const completion = await groq.chat.completions.create({
      model: MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 500,
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Erro processMessage:', error.message);
    return 'Tive um probleminha aqui. Pode repetir? 😊';
  }
}

async function searchWeb(query, locationContext = '') {
  try {
    const fullQuery = locationContext ? `${query} em ${locationContext}` : query;
    console.log(`🔎 Buscando: ${fullQuery}`);

    const data = await webSearch(fullQuery);

    if (!data || !data.results || data.results.length === 0) {
      return { text: "Não encontrei nada atualizado sobre isso.", sourceUrl: null };
    }

    let contexto = '';
    if (data.answer) contexto += `${data.answer}\n\n`;
    data.results.slice(0, 3).forEach(r => {
      if (r.title) contexto += `${r.title}\n`;
      if (r.content) contexto += `${r.content.substring(0, 300)}\n\n`;
    });

    const sourceUrl = data.results[0]?.url || null;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: `Você é a Clara. Responda em português brasileiro, natural e direto.
Máximo 3 linhas. Sem citar fontes no texto.
Para clima: emoji + cidade + temperatura + previsão curta.
Para outros: destaque a informação principal.`
        },
        {
          role: 'user',
          content: `Pergunta: ${query}\nLocalização: ${locationContext || 'não informada'}\n\nInformações:\n${contexto}`
        }
      ],
      temperature: 0.3,
      max_tokens: 150,
    });

    return {
      text: completion.choices[0].message.content.trim(),
      sourceUrl
    };
  } catch (error) {
    console.error('Erro searchWeb:', error.message);
    return { text: "Não consegui buscar isso agora.", sourceUrl: null };
  }
}

module.exports = { processMessage, searchWeb };
