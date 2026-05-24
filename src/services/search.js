const { tavily } = require('@tavily/core');

const tvly = tavily({
  apiKey: process.env.TAVILY_API_KEY,
});

async function webSearch(query) {
  try {
    console.log(`🔎 Tavily: ${query}`);

    const response = await tvly.search(query, {
      maxResults: 5,
      searchDepth: "basic",
    });

    if (!response.results?.length) {
      return null;
    }

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
