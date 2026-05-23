// src/services/search.js
const { TavilySearchResults } = require('@tavily/core');

const tavily = new TavilySearchResults({
  apiKey: process.env.TAVILY_API_KEY,
});

async function webSearch(query) {
  try {
    console.log(`🔎 Tavily buscando: ${query}`);

    const results = await tavily.invoke(query, {
      maxResults: 5,
      searchDepth: "basic",
    });

    return results;
  } catch (error) {
    console.error('Erro Tavily:', error.message);
    return null;
  }
}

module.exports = { webSearch };
