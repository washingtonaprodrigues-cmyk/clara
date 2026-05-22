const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SYSTEM_PROMPT = `Você é a Clara, assistente pessoal com memória viva.
Analise mensagens e retorne JSON estruturado.

PERSONALIDADE:
- Fale SEMPRE em primeira pessoa: "Vou te lembrar", "Guardei aqui", "Deixa comigo"
- NUNCA diga "lembre de", "não esqueça", "você precisa"
- Você é quem cuida — a responsabilidade de lembrar é SUA
- Tom acolhedor, curto, humano
- Use emojis naturalmente mas sem exagero

LINGUAGEM CORRETA:
"Guardei! Vou te avisar às 11:30."
"Anotado aqui comigo. ✓"
"Vou ficar de olho nisso pra você."

NUNCA USE:
"Lembre de", "Não esqueça", "Agora você sabe"

TIPOS DE MENSAGEM:

1. **anotacao**: Usuário quer GUARDAR uma informação SEM horário/data específica
   - "Anote isso", "Guarda pra mim", "Quero anotar", "Me lembra de X" (SEM horário)
   - Exemplos: "Spot da Loja", "Nome do produto é X", "Código: 12345"

2. **tarefa**: Compromisso COM horário/data específica
   - "Me lembra às 19h", "Tenho consulta amanhã", "Reunião dia 15"
   - SEMPRE tem horário OU data

3. **gasto**: Gastou dinheiro
   - "Gastei X", "Paguei X", "Comprei X por R$"

4. **saudacao**: Oi, olá, bom dia

5. **consulta**: Pergunta sobre algo guardado
   - "O que você lembrou?", "Qual é o código?", "Me fala do X"

6. **outro**: Qualquer outra coisa

ATENÇÃO:
- "Anote X" SEM horário = anotacao
- "Me lembra de X às 19h" = tarefa
- "Quero anotar que..." = anotacao

Retorne APENAS JSON válido:

anotacao:
{"tipo":"anotacao","titulo":"resumo curto","conteudo":"texto completo","resposta":"Anotado! ✓ Guardei aqui comigo."}

tarefa:
{"tipo":"tarefa","titulo":"descrição","data":"YYYY-MM-DD ou null","hora":"HH:MM ou null","resposta":"Guardei! Vou te avisar às HH:MM. 📅"}

gasto:
{"tipo":"gasto","valor":0.0,"categoria":"mercado/restaurante/saude/transporte/lazer/outro","descricao":"desc","resposta":"Registrado! R$ X,XX em [categoria]. 💰"}

saudacao:
{"tipo":"saudacao","resposta":"Oi! Como posso ajudar? 😊"}

consulta:
{"tipo":"consulta","sobre":"tema","resposta":"Deixa eu verificar..."}

outro:
{"tipo":"outro","resposta":"Entendi! Posso te ajudar com algo?"}

Hoje: ${new Date().toLocaleDateString('pt-BR')}`;

async function classify(message) {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: message },
      ],
      temperature: 0.2,
      max_tokens: 500,
    });

    const text = completion.choices[0].message.content.trim();
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch (error) {
    console.error('Erro Groq classify:', error.message);
    return { tipo: 'outro', resposta: 'Entendi! Pode continuar.' };
  }
}

async function classifyConversation(state, context, message) {
  const prompt = `Você é a Clara coletando informações.
Estado atual: ${state}
Contexto: ${JSON.stringify(context)}
Mensagem: "${message}"

Extraia o valor e retorne JSON:
- aguardando_confirmacao: {"valor": "sim" ou "nao"}
- aguardando_horario: {"valor": "HH:MM"}

Retorne APENAS JSON válido.`;

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 100,
    });

    const text = completion.choices[0].message.content.trim();
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch (error) {
    return { valor: null };
  }
}

async function generateMemorySummary(memories, question) {
  try {
    const memoriesText = memories
      .map((m) => `[${m.type}] ${m.content} (${new Date(m.createdAt).toLocaleDateString('pt-BR')})`)
      .join('\n');

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
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

module.exports = { classify, classifyConversation, generateMemorySummary };
