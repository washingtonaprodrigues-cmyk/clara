// touch redeploy
// ── Fallback Gemini ──
// Quando o Groq (70b) esgota (rate limit), tenta o Gemini Flash antes de
// cair pro modo direto. Gemini Flash tem free tier sem cartão de crédito —
// boa rede de segurança pro uso pessoal.
//
// Usa fetch nativo (Node 18+), sem dependências novas.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Cascata TOP → BÁSICO (ago/2026):
// 3.6-flash mais lento e ligeiramente diferente — 3.5-flash como primário comprovado.
const GEMINI_MODELS = [
  'gemini-3.5-flash',        // 1º — comprovado, personalidade plena, latência boa
  'gemini-3.6-flash',        // 2º — mais recente, entra se 3.5 falhar
  'gemini-3.5-flash-lite',   // 3º — econômico, personalidade mais fraca
  'gemini-3.1-flash-lite',   // 4º — último recurso Gemini
];

const GEMINI_MODELS_LITE = [
  'gemini-3.5-flash-lite',   // 1º — lite atual e disponível
  'gemini-3.1-flash-lite',   // 2º — estável até mai/2027
];

// ── Cache de quota esgotada (em memória) ──
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

function isQuotaError(err) {
  return err?.status === 429 || /quota|rate.?limit|resource_exhausted/i.test(err?.message || '');
}

async function chamarGemini(model, msgs, { temperature = 0.7, maxTokens = 800 } = {}) {
  const { systemInstruction, contents } = converterMensagens(msgs);
  
  const generationConfig = {
    temperature,
    maxOutputTokens: maxTokens,
  };

  // Envia thinkingConfig para evitar respostas cortadas,
  // EXCETO no 3.6 que retorna Erro 400 ao receber esse parâmetro.
  if (!model.includes('3.6')) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  const body = {
    contents,
    generationConfig,
  };

  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  const fetchPromise = fetch(geminiUrl(model), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const timeoutPromise = new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 6000);
    if (t.unref) t.unref();
  });

  let response;
  try {
    response = await Promise.race([fetchPromise, timeoutPromise]);
  } finally {
    fetchPromise.catch(() => {});
  }

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
  return { text: text.trim(), finishReason };
}

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
      const resultado = await chamarGemini(model, msgs, opts);
      console.log(`[Gemini] modelo usado com sucesso: ${model}`);
      return resultado.text;
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

async function geminiFreeResponseComContinuacao(msgs, opts = {}) {
  if (!geminiDisponivel()) {
    throw new Error('GEMINI_API_KEY não configurada');
  }

  let ultimoErro;
  let tentouAlgum = false;

  for (const model of GEMINI_MODELS) {
    if (estaEsgotado(model)) continue;
    tentouAlgum = true;
    try {
      const resultado = await chamarGemini(model, msgs, opts);
      console.log(`[Gemini] modelo usado com sucesso: ${model}`);

      if (resultado.finishReason === 'MAX_TOKENS' && resultado.text.length > 20) {
        try {
          const msgsContinuacao = [
            ...msgs,
            { role: 'assistant', content: resultado.text },
            { role: 'user', content: '(sua resposta foi cortada por limite de tamanho — continue EXATAMENTE de onde parou, sem repetir nada do que já disse, sem reintroduzir o assunto, sem comentar que foi cortada. Só emende a continuação direta.)' }
          ];
          const continuacao = await chamarGemini(model, msgsContinuacao, { ...opts, maxTokens: opts.maxTokens || 800 });
          console.log(`[Gemini] continuação automática gerada (resposta original estava cortada)`);
          return `${resultado.text} ${continuacao.text}`.trim();
        } catch (eCont) {
          console.error(`[Gemini] continuação falhou, devolvendo resposta cortada mesmo: ${eCont.message}`);
          return resultado.text;
        }
      }

      return resultado.text;
    } catch (err) {
      ultimoErro = err;
      console.error(`[Gemini] modelo ${model} falhou: ${err.message}`);
      if (isQuotaError(err)) marcarEsgotado(model);
      continue;
    }
  }

  if (!tentouAlgum) {
    throw new Error('Todos os modelos Gemini estão esgotados por hoje (quota diária zerada)');
  }
  throw ultimoErro || new Error('Todos os modelos Gemini falharam');
}

function isGeminiRateLimit(err) {
  return err?.status === 429 || /quota|rate.?limit/i.test(err?.message || '');
}

function todosModelosEsgotados() {
  return GEMINI_MODELS.every(m => estaEsgotado(m));
}

async function geminiFreeResponseLite(msgs, opts = {}) {
  if (!geminiDisponivel()) throw new Error('GEMINI_API_KEY não configurada');
  let ultimoErro;
  for (const model of GEMINI_MODELS_LITE) {
    if (estaEsgotado(model)) continue;
    try {
      const resultado = await chamarGemini(model, msgs, opts);
      console.log(`[Gemini-Lite] ${model}`);
      return resultado.text;
    } catch (err) {
      ultimoErro = err;
      if (isQuotaError(err)) marcarEsgotado(model);
    }
  }
  return geminiFreeResponse(msgs, opts);
}

async function geminiVision(base64Image, mimeType, systemPrompt, userPrompt = 'O que você vê nesta imagem?', referenciaBase64 = null, referenciaMimeType = 'image/jpeg') {
  if (!geminiDisponivel()) throw new Error('GEMINI_API_KEY não configurada');

  const model = 'gemini-2.5-flash';
  const parts = [{ text: userPrompt }];
  if (referenciaBase64) {
    parts.push({ inlineData: { mimeType: referenciaMimeType, data: referenciaBase64 } });
  }
  parts.push({ inlineData: { mimeType: mimeType || 'image/jpeg', data: base64Image } });
  const body = {
    contents: [{ role: 'user', parts }],
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

const GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';

async function geminiGerarImagem(prompt) {
  if (!geminiDisponivel()) throw new Error('GEMINI_API_KEY não configurada');
  if (!prompt || !prompt.trim()) throw new Error('Prompt vazio');

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
  };

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), 30000)
  );
  const fetchPromise = fetch(geminiUrl(GEMINI_IMAGE_MODEL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const response = await Promise.race([fetchPromise, timeoutPromise]);
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini Imagem erro ${response.status}: ${errText.slice(0, 300)}`);
  }
  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find(p => p.inlineData?.data);
  if (!imgPart) {
    const bloqueio = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
    throw new Error(`Gemini não retornou imagem${bloqueio ? ` (${bloqueio})` : ''}`);
  }
  return { base64: imgPart.inlineData.data, mimeType: imgPart.inlineData.mimeType || 'image/png' };
}

const CLARA_APARENCIA = `a young Brazilian/Latina woman in her mid-to-late 20s, with warm olive skin tone, long dark brown/black wavy hair usually worn in a loose messy bun with a few face-framing strands falling naturally, brown eyes, defined natural eyebrows, an oval/heart-shaped face, and a warm, genuine smile with visible teeth. Natural, minimal makeup look. She dresses like a normal everyday Brazilian woman — casual blouses, tank tops, sundresses, shorts, skirts, leggings, jeans — always appropriate for the situation but never overly conservative or formal.`;

async function gerarPromptSelfieDetalhado(contextoConversa) {
  const msgs = [
    { role: 'system', content: `Você extrai, a partir de uma conversa em português, qual atividade/cena a pessoa está fazendo ou mencionou, e escreve uma descrição de selfie fotorealista EM INGLÊS pronta pra gerar imagem. Retorne APENAS a descrição em inglês, sem explicação.

FORMATO OBRIGATÓRIO: "photo of ${CLARA_APARENCIA}, [atividade específica], [objetos/equipamento visíveis do cenário], photorealistic casual photo, natural lighting"

Ela deve ser o assunto central da foto, em close ou meio-corpo, ativamente fazendo a atividade mencionada — nunca uma paisagem vazia.

Se não conseguir identificar uma atividade clara na conversa, use uma cena genérica coerente com o momento (ex: em casa, no sofá, tomando café). Não reproduza personagens ou IP com copyright.` },
    { role: 'user', content: contextoConversa }
  ];
  try {
    const resp = await geminiFreeResponseLite(msgs, { temperature: 0.4, maxTokens: 150 });
    if (resp && resp.trim().length > 10) return resp.trim();
  } catch (e) {
    console.error('[gerarPromptSelfieDetalhado] Erro:', e.message);
  }
  return `photo of ${CLARA_APARENCIA}, sitting comfortably at home, natural lighting, photorealistic casual photo`;
}

async function geminiGerarSelfie(cena, referenciaBase64, referenciaMimeType = 'image/jpeg') {
  if (!geminiDisponivel()) throw new Error('GEMINI_API_KEY não configurada');
  if (!cena || !cena.trim()) throw new Error('Cena vazia');
  if (!referenciaBase64) throw new Error('Foto de referência não disponível');

  const body = {
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: referenciaMimeType, data: referenciaBase64 } },
        { text: `Edit this photo. Replace the background/setting with: ${cena}. Change her clothing, pose and activity to naturally fit this new scene, with the objects/equipment mentioned clearly visible around her. Keep her face, hair and identity exactly as they are in the original photo — do not change her face. Output a photorealistic, natural selfie-style photo, not studio/posed.` }
      ]
    }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
  };

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), 30000)
  );
  const fetchPromise = fetch(geminiUrl(GEMINI_IMAGE_MODEL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const response = await Promise.race([fetchPromise, timeoutPromise]);
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini Selfie erro ${response.status}: ${errText.slice(0, 300)}`);
  }
  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find(p => p.inlineData?.data);
  const textPart = parts.find(p => p.text)?.text;
  const safetyRatings = data?.candidates?.[0]?.safetyRatings;
  const promptFeedback = data?.promptFeedback;
  console.log(`[Gemini-Selfie-DIAG] temImagem=${!!imgPart} textoJunto="${(textPart || '').slice(0, 200)}" promptFeedback=${JSON.stringify(promptFeedback || {})} safetyRatings=${JSON.stringify(safetyRatings || [])}`);
  if (!imgPart) {
    const bloqueio = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
    throw new Error(`Gemini não retornou selfie${bloqueio ? ` (${bloqueio})` : ''}`);
  }
  return { base64: imgPart.inlineData.data, mimeType: imgPart.inlineData.mimeType || 'image/png' };
}

async function geminiSearchGrounded(systemPrompt, userQuery, { temperature = 0.7, maxTokens = 600 } = {}) {
  if (!geminiDisponivel()) throw new Error('GEMINI_API_KEY não configurada');

  const model = 'gemini-3.5-flash';
  const body = {
    contents: [{ role: 'user', parts: [{ text: userQuery }] }],
    tools: [{ googleSearch: {} }],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  if (systemPrompt) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  const timeoutPromise = new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 20000);
    if (t.unref) t.unref();
  });
  const fetchPromise = fetch(geminiUrl(model), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const response = await Promise.race([fetchPromise, timeoutPromise]);
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    const err = new Error(`Gemini Search erro ${response.status}: ${errText.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }
  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
  if (!text) throw new Error('Gemini Search não retornou texto');
  return text;
}

module.exports = {
  geminiDisponivel,
  geminiFreeResponse,
  geminiFreeResponseComContinuacao,
  geminiFreeResponseLite,
  geminiVision,
  geminiGerarImagem,
  geminiGerarSelfie,
  gerarPromptSelfieDetalhado,
  geminiSearchGrounded,
  isGeminiRateLimit,
  todosModelosEsgotados,
  GEMINI_MODELS,
};
