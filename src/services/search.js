const { tavily } = require('@tavily/core');

let _client = null;

function getClient() {
  if (!_client) {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) throw new Error('TAVILY_API_KEY não configurada');
    _client = tavily({ apiKey });
  }
  return _client;
}

async function webSearch(query) {
  try {
    console.log(`🔎 Tavily: ${query}`);
    const tvly = getClient();
    const response = await tvly.search(query, {
      maxResults: 3,
      searchDepth: 'advanced',
      includeAnswer: true,
    });
    if (!response.results?.length) return null;
    const cleaned = response.results.map(result => ({
      title: result.title,
      content: result.content?.slice(0, 300),
      url: result.url,
    }));
    return {
      answer: response.answer || null,
      results: cleaned
    };
  } catch (error) {
    console.error('Erro Tavily:', error.message);
    return null;
  }
}

module.exports = { webSearch };
