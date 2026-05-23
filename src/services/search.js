// src/services/search.js
const { tavily } = require('@tavily/core');

const tvly = tavily({
  apiKey: process.env.TAVILY_API_KEY,
});

async function webSearch(query) {
  try {
    console.log(`🔎 Buscando: ${query}`);

    const response = await tvly.search(query, {
      maxResults: 3,
      searchDepth: "basic",
    });

    if (!response.results?.length) {
      return null;
    }

    // limpa e resume resultados
    const cleaned = response.results.map(result => ({
      title: result.title,
      content: result.content?.slice(0, 300),
    }));

    return cleaned;

  } catch (error) {
    console.error('Erro Tavily:', error.message);
    return null;
  }
}

module.exports = { webSearch };
