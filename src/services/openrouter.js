// ── Fallback OpenRouter ──
// Quando o Groq (70b) esgota (rate limit), tenta modelos gratuitos do
// OpenRouter antes de cair pro modo direto. Reaproveita a OPENROUTER_API_KEY
// já configurada (usada também no modo privado).
//
// Mesma interface do gemini.js (geminiDisponivel/geminiFreeResponse/isGeminiRateLimit)
// só que com nomes "openrouter*" — facilita trocar no groq.js.
//
// Usa fetch nativo (Node 18+), sem dependências novas.
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Lista de modelos gratuitos para tentar, em ordem de preferência.
// Modelos ":free" do OpenRouter têm limite diário generoso e não cobram nada.
// Slugs verificados: meta-llama/llama-3.1-8b-instruct:free e
// google/gemini-2.0-flash-exp:free foram descontinuados (404) — substituídos
// pelos slugs atuais abaixo.
const OPENROUTER_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'meta-llama/llama-3.1-405b-instruct:free',
  'google/gemini-2.0-flash-001:free',
  'google/gemini-flash-1.5-8b:free',
  'mistralai/mistral-7b-instruct:free',
  'qwen/qwen-2.5-72b-instruct:free',
];

function openrouterDisponivel() {
  return !!OPENROUTER_API_KEY;
}

// Identifica se o erro é de quota/rate limit (429) — usado para decidir
// se vale tentar o próximo modelo da lista.
function isQuotaError(err) {
  return err?.status === 429 || /quota|rate.?limit|resource_exhausted/i.test(err?.message || '');
}

// Faz uma chamada a um modelo específico do OpenRouter.
// msgs já está no formato OpenAI (role: system/user/assistant) — não precisa converter.
async function chamarOpenRouter(model, msgs, { temperature = 0.7, maxTokens = 800 } = {}) {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), 15000)
  );

  const fetchPromise = fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://clara-production-949e.up.railway.app',
      'X-Title': 'Clara IA',
    },
    body: JSON.stringify({
      model,
      messages: msgs,
      temperature,
      max_tokens: maxTokens,
    }),
  });

  const response = await Promise.race([fetchPromise, timeoutPromise]);

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    const err = new Error(`OpenRouter API erro ${response.status} (${model}): ${errText}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) {
    const finishReason = data?.choices?.[0]?.finish_reason;
    throw new Error(`OpenRouter retornou vazio (${model}, finish_reason: ${finishReason || 'desconhecido'})`);
  }
  return text.trim();
}

// Identifica se o erro é um 429 "temporário" do provedor upstream (ex:
// Venice sobrecarregado), diferente de quota diária esgotada — vale a
// pena tentar de novo rapidamente em vez de já trocar de modelo.
function isTemporaryUpstream429(err) {
  return err?.status === 429 && /temporarily|retry.?after|upstream/i.test(err?.message || '');
}

// Gera uma resposta via OpenRouter, no mesmo formato esperado pelo freeResponse.
// Tenta os modelos da lista OPENROUTER_MODELS em ordem; se um falhar (quota,
// 404, timeout, etc), tenta o próximo. Para 429 temporário do provedor,
// faz uma única retentativa rápida antes de passar pro próximo modelo.
// Retorna o texto da resposta ou lança o último erro se todos falharem.
async function openrouterFreeResponse(msgs, opts = {}) {
  if (!openrouterDisponivel()) {
    throw new Error('OPENROUTER_API_KEY não configurada');
  }

  let ultimoErro;
  for (const model of OPENROUTER_MODELS) {
    try {
      const resposta = await chamarOpenRouter(model, msgs, opts);
      console.log(`[OpenRouter] modelo usado com sucesso: ${model}`);
      return resposta;
    } catch (err) {
      ultimoErro = err;
      console.error(`[OpenRouter] modelo ${model} falhou: ${err.message}`);

      // 429 temporário do provedor (ex: "temporarily rate-limited upstream")
      // costuma resolver em poucos segundos — uma retentativa rápida vale a pena.
      if (isTemporaryUpstream429(err)) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const resposta = await chamarOpenRouter(model, msgs, opts);
          console.log(`[OpenRouter] modelo usado com sucesso (retry): ${model}`);
          return resposta;
        } catch (err2) {
          ultimoErro = err2;
          console.error(`[OpenRouter] modelo ${model} falhou na retentativa: ${err2.message}`);
        }
      }

      continue;
    }
  }

  throw ultimoErro || new Error('Todos os modelos OpenRouter falharam');
}

// Identifica se o erro do OpenRouter é rate limit (429) — para também
// sinalizar modo direto caso o OpenRouter também esgote.
function isOpenrouterRateLimit(err) {
  return err?.status === 429 || /quota|rate.?limit/i.test(err?.message || '');
}

module.exports = {
  // nomes "genéricos" (compatíveis com a interface do gemini.js)
  geminiDisponivel: openrouterDisponivel,
  geminiFreeResponse: openrouterFreeResponse,
  isGeminiRateLimit: isOpenrouterRateLimit,
  // nomes explícitos, caso prefira importar com nomes próprios
  openrouterDisponivel,
  openrouterFreeResponse,
  isOpenrouterRateLimit,
  OPENROUTER_MODELS,
};
