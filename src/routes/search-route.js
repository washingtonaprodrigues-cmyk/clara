const express = require('express');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.status(400).json({ error: 'Query inválida' });

    const { tavily } = require('@tavily/core');
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Tavily não configurado' });

    const client = tavily({ apiKey });
    // Adiciona contexto pt-BR para forçar resultados em português
    const queryPT = q.trim();
    const response = await client.search(queryPT, {
      maxResults: 6,
      searchDepth: 'basic',
      includeAnswer: true,
      includeImages: false,
    });

    res.json({
      answer: response.answer || null,
      results: (response.results || []).map(r => ({
        title: r.title,
        content: r.content?.slice(0, 400),
        url: r.url,
        publishedDate: r.publishedDate || null,
      }))
    });
  } catch (e) {
    console.error('[Search] Erro:', e.message);
    res.status(500).json({ error: 'Erro na busca' });
  }
});

module.exports = router;
