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

// Lista de modelos para tentar, em ordem de preferência.
// "openrouter/free" é o Free Models Router oficial: escolhe automaticamente
// um modelo gratuito disponível agora, evitando o problema de slugs ":free"
// específicos ficarem desatualizados/404 com o tempo. Mantemos um modelo
// nomeado como segunda opção apenas como rede de segurança extra.
const OPENROUTER_MODELS = [
  'openrouter/free',
  'meta-llama/llama-3.3-70b-instruct:free',
];

function openrouterDisponivel() {
  return !!OPENROUTER_API_KEY;
}

// Identifica se o erro é de quota/rate limit (429) — usado para decidir
// se vale tentar o próximo modelo da lista.
function isQuotaError(err) {
  return err?.status === 429 || /quota|rate.?limit|resource_exhausted/i.test(err?.message || '');
}

// Alguns modelos gratuitos (via certos provedores) anexam metadados de
// classificação de segurança no final da resposta, tipo:
//   "User Safety: safe\nResponse Safety: safe"
// Isso não faz parte da resposta real e não deve ser enviado ao usuário.
function limparMetadadosSafety(texto) {
  let limpo = texto;

  // Alguns modelos "reasoning" do free router às vezes vazam o raciocínio
  // interno dentro do campo content, em vez de só a resposta final —
  // tanto em blocos <think>...</think>/<reasoning>...</reasoning> quanto
  // como texto solto de cadeia-de-pensamento ("Okay, let's see...",
  // "The user is saying...", etc) sem fechar a tag corretamente.
  // Remove blocos de tag conhecidos primeiro:
  limpo = limpo.replace(/<think>[\s\S]*?<\/think>/gi, '');
  limpo = limpo.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');
  // Tag aberta sem fechamento (resposta cortada no meio do raciocínio) —
  // remove a tag e tudo depois dela.
  limpo = limpo.replace(/<think>[\s\S]*$/gi, '');
  limpo = limpo.replace(/<reasoning>[\s\S]*$/gi, '');

  limpo = limpo
    .replace(/\n*\s*User\s*Safety:\s*\w+\s*\n*\s*Response\s*Safety:\s*\w+\s*$/i, '')
    .replace(/\n*\s*(User|Response)\s*Safety:\s*\w+\s*$/gim, '')
    .trim();

  // Heurística extra: alguns modelos vazam o raciocínio em inglês SEM
  // nenhuma tag de delimitação (texto solto começando com "Okay, let's
  // see...", "The user is...", etc), mesmo quando o contexto/system está
  // todo em português. Se o início do texto bate com esses padrões
  // típicos de chain-of-thought em inglês, tratamos como inválido —
  // não dá pra "limpar" isso de forma segura, então sinalizamos vazio
  // para o chamador tratar como erro e tentar outro modelo.
  const inicioChainOfThought = /^(okay|ok|alright|let'?s see|let me think|the user (is|says|wants|asked)|looking at|i need to|first,? i|so,? the user)/i;
  if (inicioChainOfThought.test(limpo)) {
    return '';
  }

  return limpo;
}

// Modelos gratuitos via "openrouter/free" variam em qualidade — alguns
// (mais fracos) tendem a "inventar" itens de listas/agendas em vez de usar
// os dados reais fornecidos no contexto. Esse reforço é injetado no início
// do system prompt apenas no fallback, para reduzir esse tipo de alucinação.
const REFORCO_ANTI_ALUCINACAO = 'INSTRUÇÃO CRÍTICA: ao mencionar lembretes, listas, agenda ou qualquer dado fornecido no contexto, use APENAS as informações exatas fornecidas — não invente, não reordene, não crie itens adicionais. Se não houver dados suficientes, diga isso claramente em vez de inventar.\n\n';

// Injeta o reforço anti-alucinação no início da primeira mensagem "system".
// Se não houver mensagem system, cria uma só com o reforço.
function reforcarMensagens(msgs) {
  const copia = msgs.map(m => ({ ...m }));
  const idx = copia.findIndex(m => m.role === 'system');
  if (idx >= 0) {
    copia[idx].content = REFORCO_ANTI_ALUCINACAO + copia[idx].content;
  } else {
    copia.unshift({ role: 'system', content: REFORCO_ANTI_ALUCINACAO });
  }
  return copia;
}

// Faz uma chamada a um modelo específico do OpenRouter.
// msgs já está no formato OpenAI (role: system/user/assistant) — não precisa converter.
async function chamarOpenRouter(model, msgs, { temperature = 0.7, maxTokens = 800 } = {}) {
  const msgsReforcadas = reforcarMensagens(msgs);

  // "openrouter/free" pode escolher modelos de reasoning, que gastam tokens
  // em "pensamento" interno antes do texto visível — sem margem extra,
  // a resposta vem vazia com finish_reason: length. Damos bem mais espaço
  // só para esse router.
  const maxTokensEfetivo = model === 'openrouter/free' ? Math.max(maxTokens * 2, 1500) : maxTokens;

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), 25000)
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
      messages: msgsReforcadas,
      temperature,
      max_tokens: maxTokensEfetivo,
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
  const limpo = limparMetadadosSafety(text.trim());
  if (!limpo) {
    // Texto não-vazio originalmente, mas ficou vazio após remover metadados
    // de safety (ex: resposta era só "User Safety: safe\nResponse Safety: safe").
    throw new Error(`OpenRouter retornou apenas metadados sem conteúdo real (${model})`);
  }
  return limpo;
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
