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
// tenta o próximo. Retorna o texto da resposta ou lança o último erro.
async function geminiFreeResponse(msgs, opts = {}) {
  if (!geminiDisponivel()) {
    throw new Error('GEMINI_API_KEY não configurada');
  }

  let ultimoErro;
  for (const model of GEMINI_MODELS) {
    try {
      const resposta = await chamarGemini(model, msgs, opts);
      console.log(`[Gemini] modelo usado com sucesso: ${model}`);
      return resposta;
    } catch (err) {
      ultimoErro = err;
      console.error(`[Gemini] modelo ${model} falhou: ${err.message}`);
      // Se for erro de quota/rate limit, tenta o próximo modelo da lista.
      // Para outros erros (ex: timeout, erro de rede), também tenta o
      // próximo — mas o log já deixa claro qual foi o motivo.
      continue;
    }
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
