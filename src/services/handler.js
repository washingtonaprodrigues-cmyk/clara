const { classify, searchWeb, freeResponse, generateMemorySummary } = require('./groq');
const { sendMessage, sendReminderWithButtons } = require('./whatsapp');
const memory = require('./memory');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// ====================== MENU ======================
const MENU = `✨ *Olá! Que bom te ver por aqui!* 🥰

Sou a Clara, sua assistente pessoal. Posso te ajudar com:

1️⃣ *Lembretes* — compromissos e tarefas
2️⃣ *Anotações* — guardar informações
3️⃣ *Gastos* — controle financeiro
4️⃣ *Saúde* — medicamentos e bem-estar
5️⃣ *Ponto digital* — sua jornada de trabalho
6️⃣ *Pesquisar* — clima, horóscopo, telefones...
7️⃣ *Bater papo* — conversar sobre qualquer coisa

_Digite o número ou me diga diretamente o que precisa_ 😊`;

const MENU_FOOTER = '\n\n_Digite *menu* para voltar ao início 🏠_';

const BOAS_VINDAS_MODO = {
  '1': `⏰ *Lembretes*\n\nPosso te lembrar de uma reunião, uma tarefa ou qualquer compromisso que desejar!\n\nExemplos:\n• _"Me lembra às 19h de buscar minha filha"_\n• _"Lembrete amanhã às 8h de tomar remédio"_\n• _"Me lembra sexta às 18h da reunião"_\n\n_É só me dizer!_ 😊`,
  '2': `📝 *Anotações*\n\nGuardo qualquer informação pra você consultar quando quiser!\n\nExemplos:\n• _"Anota que a senha do wifi é 12345"_\n• _"Guarda o código do cliente: ABC123"_\n• _"Anota o endereço da minha médica"_\n\n_O que quer guardar?_ 😊`,
  '3': `💰 *Gastos*\n\nRegistro tudo e te mostro um resumo certinho do mês!\n\nExemplos:\n• _"Gastei 45 reais no mercado"_\n• _"Paguei 120 no restaurante"_\n• _"Quanto gastei esse mês?"_\n\n_Me conta seu gasto!_ 💸`,
  '4': `💊 *Saúde*\n\nCuido dos seus remédios e te aviso na hora certinha!\n\nExemplos:\n• _"Tomo Losartana todo dia às 8h"_\n• _"Vitamina C às 9h e às 21h"_\n\n_Qual medicamento quer registrar?_ 😊`,
  '5': `🕐 *Ponto Digital*\n\nRegistro sua jornada e calculo horas extras!\n\nExemplos:\n• _"Entrei às 8:15"_\n• _"Saí pra almoçar às 12:30"_\n• _"Voltei do almoço às 14:10"_\n• _"Saí do trabalho às 18:05"_\n\nOu tudo de uma vez:\n_"Entrei 8h, saí almoçar 12h, voltei 13h, saí 17h"_\n\n_Pode me dizer!_ 🕐`,
  '6': `🔍 *Pesquisar*\n\nBusco qualquer coisa pra você na internet!\n\n☀️ _"Como está o tempo hoje?"_\n🔮 _"Horóscopo de Áries"_\n📞 _"Telefone da farmácia mais próxima"_\n📍 _"Endereço do Detran"_\n💵 _"Preço do dólar hoje"_\n\n_O que quer pesquisar?_ ✨`,
  '7': `💬 *Bater papo*\n\nAdoro uma boa conversa! Pode falar à vontade sobre qualquer assunto 😄\n\n_Pode começar!_ 🥰`,
};

// ====================== UTILITÁRIOS ======================
function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function dateBRT() {
  const d = nowBRT();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function minutesToHours(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h${m > 0 ? m + 'min' : ''}`;
}

function horaStr(date) {
  if (!date) return '—';
  const d = new Date(date);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ====================== HANDLER PRINCIPAL ======================
async function handleMessage(phone, text, location = null) {
  try {
    const user = await memory.getOrCreateUser(phone);

    // LOCALIZAÇÃO
    if (location && location.latitude) {
      await memory.saveMemory(user.id, 'localizacao',
        JSON.stringify({ latitude: location.latitude, longitude: location.longitude, updatedAt: new Date().toISOString() })
      );
      return await sendMessage(phone, '✅ Localização recebida! Agora posso te ajudar melhor com clima, farmácias e lojas próximas.' + MENU_FOOTER);
    }

    if (!text) return;

    const textLower = text.trim().toLowerCase();

    // MENU
    if (['menu', 'início', 'inicio', 'voltar', 'começo'].includes(textLower)) {
      return await sendMessage(phone, MENU);
    }

    // ESCOLHA DO MODO (1-7)
    if (['1','2','3','4','5','6','7'].includes(text.trim())) {
      await memory.saveMemory(user.id, 'modo_
