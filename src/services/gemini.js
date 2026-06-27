// touch redeploy
// ── Fallback Gemini ──
// Quando o Groq (70b) esgota (rate limit), tenta o Gemini Flash antes de
// cair pro modo direto. Gemini Flash tem free tier sem cartão de crédito —
// boa rede de segurança pro uso pessoal.
//
// Usa fetch nativo (Node 18+), sem dependências novas.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Lista de modelos para tentar, em ordem de preferência.
// gemini-1.5-flash e gemini-1.5-flash-8b foram descontinuados (404).
// gemini-2.0-flash retornou "limit: 0" no free tier para esta conta —
// tentamos as versões 2.5 (atuais) primeiro, com 2.0 como último recurso.
const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-flash-latest',
  'gemini-2.0-flash',
];

// ── Cache de quota esgotada (em memória) ──
// Quando um modelo retorna erro de quota, marcamos ele como "esgotado até
// o fim do dia" (a quota gratuita do Gemini reseta diariamente, geralmente
// à meia-noite UTC). Isso evita tentar os 4 modelos em sequência sempre
// que TODOS já estão sabidamente esgotados — antes disso, cada falha de
// quota ainda gastava até 15s de timeout por modelo, somando ~60s de
// espera real pro usuário antes de cair no próximo fallback (OpenRouter).
const _modelosEsgotados = new Map(); // model -> timestamp de quando esgotou

function proximaMeiaNoiteUTC() {
  const agora = new Date();
  const meiaNoite = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate() + 1, 0, 0, 0));
  return meiaNoite.getTime();
}

function marcarEsgotado(model) {
  _modelosEsgotados.set(model, proximaMeiaNoiteUTC());
}

function estaEsgotado(model) {
  const expiraEm = _modelosEsgotados.get(model);
  if (!expiraEm) return false;
  if (Date.now() >= expiraEm) {
    _modelosEsgotados.delete(model); // já passou da meia-noite, reseta
    return false;
  }
  return true;
}

function geminiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
}

function geminiDisponivel() {
  return !!GEMINI_API_KEY;
}

// Converte mensagens no formato OpenAI/Groq (role: system/user/assistant)
// para o formato do Gemini (system_instruction + contents com role user/model)
function converterMensagens(msgs) {
  let systemInstruction = null;
  const contents = [];
  for (const m of msgs) {
    if (m.role === 'system') {
      systemInstruction = systemInstruction
        ? systemInstruction + '\n\n' + m.content
        : m.content;
      continue;
    }
    const role = m.role === 'assistant' ? 'model' : 'user';
    contents.push({ role, parts: [{ text: m.content }] });
  }
  return { systemInstruction, contents };
}

// Identifica se o erro do Gemini é de quota/rate limit (429 com
// RESOURCE_EXHAUSTED) — usado para decidir se vale tentar o próximo modelo.
function isQuotaError(err) {
  return err?.status === 429 || /quota|rate.?limit|resource_exhausted/i.test(err?.message || '');
}

// Faz uma chamada a um modelo específico do Gemini.
// Timeout reduzido de 15s para 6s: erros de quota (o caso mais comum de
// falha) retornam rápido do servidor do Google — não há motivo para
// esperar 15s por modelo quando o problema já é conhecido ser de cota.
async function chamarGemini(model, msgs, { temperature = 0.7, maxTokens = 800 } = {}) {
  const { systemInstruction, contents } = converterMensagens(msgs);
  const body = {
    contents,
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
      // CRÍTICO: os modelos 2.5 (flash/flash-lite) usam "thinking" por padrão,
      // e o raciocínio interno consome do MESMO orçamento de maxOutputTokens.
      // Sem isso, a resposta visível pode ser cortada no meio mesmo sendo
      // curta, porque a maior parte do limite foi gasta "pensando" antes de
      // escrever o texto. Modelos que não suportam thinking (ex: 2.0-flash)
      // simplesmente ignoram este campo, então é seguro mandar sempre.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), 6000)
  );

  const fetchPromise = fetch(geminiUrl(model), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const response = await Promise.race([fetchPromise, timeoutPromise]);

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    const err = new Error(`Gemini API erro ${response.status} (${model}): ${errText}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  const finishReason = data?.candidates?.[0]?.finishReason;
  const usage = data?.usageMetadata;
  console.log(`[Gemini-DIAG] model=${model} finishReason=${finishReason} thoughtsTokens=${usage?.thoughtsTokenCount || 0} outputTokens=${usage?.candidatesTokenCount || 0} maxTokens=${maxTokens}`);
  if (!text) {
    throw new Error(`Gemini retornou vazio (${model}, finishReason: ${finishReason || 'desconhecido'})`);
  }
  return text.trim();
}

// Gera uma resposta via Gemini, no mesmo formato esperado pelo freeResponse.
// Tenta os modelos da lista GEMINI_MODELS em ordem; se um der erro de quota,
// marca ele como esgotado (pulando-o em chamadas futuras até meia-noite UTC)
// e tenta o próximo. Retorna o texto da resposta ou lança o último erro.
async function geminiFreeResponse(msgs, opts = {}) {
  if (!geminiDisponivel()) {
    throw new Error('GEMINI_API_KEY não configurada');
  }

  let ultimoErro;
  let tentouAlgum = false;

  for (const model of GEMINI_MODELS) {
    if (estaEsgotado(model)) {
      console.log(`[Gemini] modelo ${model} pulado (esgotado até meia-noite UTC)`);
      continue;
    }
    tentouAlgum = true;
    try {
      const resposta = await chamarGemini(model, msgs, opts);
      console.log(`[Gemini] modelo usado com sucesso: ${model}`);
      return resposta;
    } catch (err) {
      ultimoErro = err;
      console.error(`[Gemini] modelo ${model} falhou: ${err.message}`);
      if (isQuotaError(err)) {
        marcarEsgotado(model);
      }
      continue;
    }
  }

  if (!tentouAlgum) {
    throw new Error('Todos os modelos Gemini estão esgotados por hoje (quota diária zerada)');
  }
  throw ultimoErro || new Error('Todos os modelos Gemini falharam');
}

// Identifica se o erro do Gemini é rate limit (429) — para também sinalizar
// modo direto caso o Gemini também esgote
function isGeminiRateLimit(err) {
  return err?.status === 429 || /quota|rate.?limit/i.test(err?.message || '');
}

// Verifica se TODOS os modelos da lista já estão marcados como esgotados
// (cache até meia-noite UTC). Permite ao chamador (groq.js) pular a etapa
// do Gemini inteira quando não há nenhum modelo "fresco" para tentar —
// evita o pequeno overhead de entrar na função e iterar a lista toda
// (mesmo que cada item individual já seja rápido por estar em cache),
// reduzindo ainda mais a latência da cascata Groq → Gemini → OpenRouter
// quando o Gemini está sabidamente fora de cota por todo o dia.
function todosModelosEsgotados() {
  return GEMINI_MODELS.every(m => estaEsgotado(m));
}

// Analisa uma imagem com o Gemini Vision. Recebe o base64 da imagem, o
// mimeType, e um prompt de sistema (a personalidade da Clara + instrução).
// Retorna o texto da análise no tom pedido.
async function geminiVision(base64Image, mimeType, systemPrompt, userPrompt = 'O que você vê nesta imagem?') {
  if (!geminiDisponivel()) throw new Error('GEMINI_API_KEY não configurada');

  // Modelo com visão — gemini-2.5-flash enxerga imagem nativamente
  const model = 'gemini-2.5-flash';
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: userPrompt },
        { inlineData: { mimeType: mimeType || 'image/jpeg', data: base64Image } }
      ]
    }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } },
  };
  if (systemPrompt) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), 15000)
  );
  const fetchPromise = fetch(geminiUrl(model), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const response = await Promise.race([fetchPromise, timeoutPromise]);
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini Vision erro ${response.status}: ${errText.slice(0, 200)}`);
  }
  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini Vision retornou vazio');
  return text.trim();
}

module.exports = {
  geminiDisponivel,
  geminiFreeResponse,
  geminiVision,
  isGeminiRateLimit,
  todosModelosEsgotados,
  GEMINI_MODELS,
};
