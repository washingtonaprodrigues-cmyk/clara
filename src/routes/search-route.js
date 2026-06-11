const express = require('express');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { q, tipo = 'tudo' } = req.query;
    if (!q || q.trim().length < 2) return res.status(400).json({ error: 'Query inválida' });

    const { tavily } = require('@tavily/core');
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Tavily não configurado' });

    const client = tavily({ apiKey });

    // Query em português para forçar resultados PT-BR quando possível
    const query = q.trim();

    const options = {
      maxResults: tipo === 'imagens' ? 5 : 8,
      searchDepth: 'advanced',
      includeAnswer: tipo !== 'noticias',
      includeImages: tipo === 'tudo' || tipo === 'imagens',
      ...(tipo === 'noticias' && { topic: 'news' }),
    };

    const response = await client.search(query, options);

    res.json({
      answer: response.answer || null,
      images: (response.images || []).slice(0, tipo === 'imagens' ? 20 : 5),
      results: (response.results || []).map(r => ({
        title: r.title,
        content: r.content?.slice(0, 500),
        url: r.url,
        score: r.score,
        publishedDate: r.publishedDate || null,
      }))
    });
  } catch (e) {
    console.error('[Search] Erro:', e.message);
    res.status(500).json({ error: 'Erro na busca' });
  }
});

module.exports = router;
