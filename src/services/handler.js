const { classify, searchWeb, freeResponse, generateMemorySummary } = require('./groq');
const { sendMessage, sendButtons, sendReminderWithButtons } = require('./whatsapp');
const memory = require('./memory');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// ====================== MENU ======================
const MENU = `✨ *Oi, eu sou a Clara.*

Posso cuidar de lembretes, anotações, gastos, saúde, ponto e pesquisas rápidas.

Você pode tocar em uma opção ou escrever do seu jeito:
• _"me lembra de tomar remédio às 22h"_
• _"gastei 42 reais no mercado"_
• _"cheguei às 9h no trabalho"_
• _"qual foi a senha do Wi-Fi?"_

O que vamos resolver agora?`;

const MENU_FOOTER = '\n\n_Digite *menu* para ver as opções 🏠_';

const MENU_BUTTONS = [
  { id: 'criar_lembrete', label: '⏰ Lembrete' },
  { id: 'nova_anotacao', label: '📝 Anotação' },
  { id: 'novo_gasto', label: '💰 Gasto' },
  { id: 'bater_ponto', label: '📍 Ponto' },
  { id: 'pesquisar', label: '🔍 Pesquisa' },
  { id: 'conversar', label: '💬 Conversar' },
];

const BOAS_VINDAS_MODO = {
  'lembrete':  `⏰ *Lembretes*\n\nPosso te lembrar de uma reunião, uma tarefa ou qualquer compromisso que desejar!\n\nExemplos:\n• _"Me lembra às 19h de buscar minha filha"_\n• _"Lembrete amanhã às 8h de tomar remédio"_\n• _"Me lembra sexta às 18h da reunião"_\n\n_É só me dizer!_ 😊`,
  'anotacao':  `📝 *Anotações*\n\nGuardo qualquer informação pra você consultar quando quiser!\n\nExemplos:\n• _"Senha do Wi-Fi: 12345"_\n• _"Código do cliente: ABC123"_\n• _"Endereço da minha médica"_\n• _"Senha do cartão: 9010"_\n\n_O que quer guardar?_ 😊`,
  'gasto':     `💰 *Gastos*\n\nRegistro tudo e te mostro um resumo certinho do mês!\n\nExemplos:\n• _"Gastei 45 reais no mercado"_\n• _"Paguei 120 no restaurante"_\n• _"Quanto gastei esse mês?"_\n\n_Me conta seu gasto!_ 💸`,
  'saude':     `💊 *Saúde*\n\nCuido dos seus remédios e te aviso na hora certinha!\n\nExemplos:\n• _"Tomo Losartana todo dia às 8h"_\n• _"Vitamina C às 9h e às 21h"_\n\n_Qual medicamento quer registrar?_ 😊`,
  'ponto':     `📍 *Ponto Digital*\n\nRegistro sua jornada e calculo horas extras!\n\nExemplos:\n• _"Entrei às 8:15"_\n• _"Saí pra almoçar às 12:30"_\n• _"Voltei do almoço às 14:10"_\n• _"Saí do trabalho às 18:05"_\n\nOu tudo de uma vez:\n_"Entrei 8h, saí almoçar 12h, voltei 13h, saí 17h"_\n\n_Pode me dizer!_ 📍`,
  'pesquisar': `🔍 *Pesquisar*\n\nBusco qualquer coisa pra você na internet!\n\n☀️ _"Como está o tempo hoje?"_\n🔮 _"Horóscopo de Áries"_\n📞 _"Telefone da farmácia mais próxima"_\n📍 _"Endereço do Detran"_\n💵 _"Preço do dólar hoje"_\n\n_O que quer pesquisar?_ ✨`,
  'conversar': `💬 *Conversar*\n\nAdoro uma boa conversa! Pode falar à vontade sobre qualquer assunto 😄\n\n_Pode começar!_ 🥰`,
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

function formatarDataBR(date) {
  if (!date) return '—';
  const d = new Date(date);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function formatarDataHoraBR(date) {
  if (!date) return '—';
  const d = new Date(date);
  const hoje = nowBRT();
  const amanha = new Date(hoje);
  amanha.setDate(amanha.getDate() + 1);

  const dStr = `${d.getDate()}/${d.getMonth() + 1}`;
  const hStr = horaStr(d);

  if (d.toDateString() === hoje.toDateString()) return `Hoje às ${hStr}`;
  if (d.toDateString() === amanha.toDateString()) return `Amanhã às ${hStr}`;

  const dias = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  return `${dias[d.getDay()]} ${dStr} às ${hStr}`;
}

async function getModoAtual(userId) {
  const mems = await memory.getRecentMemories(userId, 10);
  return mems.find(m => m.type === 'modo_atual')?.content || null;
}

function normalizar(text) {
  return (text || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

async function enviarMenu(phone) {
