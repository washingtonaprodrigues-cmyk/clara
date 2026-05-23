// ... mantenha o resto igual (parte de ponto_multiplo)

async function handleMessage(phone, text, location = null) {
  try {
    const user = await memory.getOrCreateUser(phone);

    // Se recebeu localização
    if (location) {
      await memory.saveMemory(user.id, 'localizacao', `Lat: ${location.latitude}, Lng: ${location.longitude}`);
      return await sendMessage(phone, '✅ Localização recebida! Agora posso te ajudar com coisas próximas (clima, farmácias, etc).');
    }

    const classified = await classify(text);

    switch (classified.tipo) {
      case 'ponto_multiplo':
        await handlePontoMultiplo(user, phone, classified.acoes, text);
        break;

      case 'busca':
        await handleBusca(user, phone, classified.query || text);
        break;

      default:
        const resp = await freeResponse(text);
        await sendMessage(phone, resp);
    }
  } catch (error) {
    console.error('Erro:', error.message);
    await sendMessage(phone, 'Entendi! Pode repetir?');
  }
}

async function handleBusca(user, phone, query) {
  await sendMessage(phone, '🔍 Buscando informações pra você...');

  // Tenta pegar última localização salva
  const lastLocation = await memory.getRecentMemories(user.id, 1)
    .then(mems => mems.find(m => m.type === 'localizacao'));

  let locationText = '';
  if (lastLocation) {
    locationText = lastLocation.content;
  }

  const resultado = await searchWeb(query, locationText);
  await sendMessage(phone, resultado);
}
