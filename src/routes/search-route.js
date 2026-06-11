const express = require('express');
const router = express.Router();
const { webSearch } = require('../services/search');

// GET /search?q=query
router.get('/', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.status(400).json({ error: 'Query inválida' });

    const { tavily } = require('@tavily/core');
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Tavily não configurado' });

    const client = tavily({ apiKey });
    const response = await client.search(q.trim(), {
      maxResults: 8,
      searchDepth: 'advanced',
      includeAnswer: true,
      includeImages: true,
    });

    res.json({
      answer: response.answer || null,
      images: (response.images || []).slice(0, 4),
      results: (response.results || []).map(r => ({
        title: r.title,
        content: r.content?.slice(0, 400),
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
