// ── Fallback Gemini ──
// Quando o Groq (70b) esgota (rate limit), tenta o Gemini Flash antes de
// cair pro modo direto. Gemini Flash tem free tier de 1.500 req/dia, sem
// cartão de crédito — boa rede de segurança pro uso pessoal.
//
// Usa fetch nativo (Node 18+), sem dependências novas.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

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

// Gera uma resposta via Gemini, no mesmo formato esperado pelo freeResponse.
// Retorna o texto da resposta ou lança erro (tratado pelo chamador).
async function geminiFreeResponse(msgs, { temperature = 0.7, maxTokens = 800 } = {}) {
  if (!geminiDisponivel()) {
    throw new Error('GEMINI_API_KEY não configurada');
  }

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

  const fetchPromise = fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const response = await Promise.race([fetchPromise, timeoutPromise]);

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    const err = new Error(`Gemini API erro ${response.status}: ${errText}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    // Pode ser bloqueio de safety filter ou resposta vazia
    const finishReason = data?.candidates?.[0]?.finishReason;
    throw new Error(`Gemini retornou vazio (finishReason: ${finishReason || 'desconhecido'})`);
  }

  return text.trim();
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
  GEMINI_MODEL,
};
