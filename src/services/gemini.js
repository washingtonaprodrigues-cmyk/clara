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
  if (!text) {
    const finishReason = data?.candidates?.[0]?.finishReason;
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

module.exports = {
  geminiDisponivel,
  geminiFreeResponse,
  isGeminiRateLimit,
  GEMINI_MODELS,
};
