// src/services/search.js
const { tavily } = require('@tavily/core');

const tvly = tavily({
  apiKey: process.env.TAVILY_API_KEY,
});

async function webSearch(query) {
  try {
    console.log(`🔎 Buscando: ${query}`);

    const response = await tvly.search(query, {
      maxResults: 6,
      searchDepth: "basic",
    });

    return response.results || response;
  } catch (error) {
    console.error('Erro Tavily:', error.message);
    return null;
  }
}

module.exports = { webSearch };
