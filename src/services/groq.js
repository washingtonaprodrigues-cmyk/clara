async function searchWeb(query, locationContext = '') {
  try {
    const cidade = locationContext || 'Brasil';
    const fullQuery = `${query} em ${cidade}`;
    console.log(`🔎 Buscando: ${fullQuery}`);

    const data = await webSearch(fullQuery);

    if (!data || !data.results || data.results.length === 0) {
      return "Não encontrei informações atualizadas. Pode tentar de outra forma?";
    }

    let resposta = '';

    if (data.answer) {
      resposta += `${data.answer}\n\n`;
    }

    data.results.slice(0, 3).forEach((r) => {
      if (r.title) resposta += `*${r.title}*\n`;
      if (r.content) resposta += `${r.content.substring(0, 200)}...\n\n`;
    });

    return resposta.trim();
  } catch (error) {
    console.error('Erro searchWeb:', error.message);
    return "Não consegui buscar essa informação agora.";
  }
}
