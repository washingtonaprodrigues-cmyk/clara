const { classify, searchWeb, freeResponse, generateMemorySummary } = require('./groq');
const { sendMessage, sendButtons } = require('./whatsapp');
const memory = require('./memory');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

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
  lembrete: `⏰ *Lembretes*\n\nMe diga o que lembrar e o horário.\n\nExemplos:\n• _"Me lembra às 19h de buscar minha filha"_\n• _"Lembrete amanhã às 8h de tomar remédio"_`,
  anotacao: `📝 *Anotações*\n\nMe diga o que quer guardar.\n\nExemplos:\n• _"Senha do Wi-Fi: 12345"_\n• _"Código do cliente: ABC123"_`,
  gasto: `💰 *Gastos*\n\nMe conte o valor e o motivo.\n\nExemplos:\n• _"Gastei 45 reais no mercado"_\n• _"Paguei 120 no restaurante"_`,
  saude: `💊 *Saúde*\n\nMe diga o remédio e os horários.\n\nExemplos:\n• _"Tomo Losartana todo dia às 8h"_\n• _"Vitamina C às 9h e às 21h"_`,
  ponto: `📍 *Ponto Digital*\n\nExemplos:\n• _"Entrei às 8:15"_\n• _"Saí pra almoçar às 12:30"_\n• _"Voltei do almoço às 14:10"_\n• _"Saí do trabalho às 18:05"_`,
  pesquisar: `🔍 *Pesquisar*\n\nMe diga o que você quer buscar.\n\nExemplos:\n• _"Como está o tempo hoje?"_\n• _"Telefone da farmácia mais próxima"_`,
  conversar: `💬 *Conversar*\n\nPode falar comigo à vontade. 😊`,
};

function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function dateBRT() {
  const d = nowBRT();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function normalizar(text) {
  return (text || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function minutesToHours(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h${m ? `${m}min` : ''}`;
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
  const hStr = horaStr(d);
  if (d.toDateString() === hoje.toDateString()) return `Hoje às ${hStr}`;
  if (d.toDateString() === amanha.toDateString()) return `Amanhã às ${hStr}`;
  const dias = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  return `${dias[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1} às ${hStr}`;
}

async function enviarMenu(phone) {
  return sendButtons(phone, MENU, MENU_BUTTONS);
}

async function getModoAtual(userId) {
  const mems = await memory.getRecentMemories(userId, 10);
  return mems.find((m) => m.type === 'modo_atual')?.content || null;
}

async function responderLivre(user, phone, text) {
  const history = await memory.getConversationHistory(user.id, 10);
  const preferences = await memory.getUserPreference(user.id);
  const resp = await freeResponse(text, history, preferences);
  await memory.saveConversationMessage(user.id, 'user', text);
  await memory.saveConversationMessage(user.id, 'assistant', resp);
  return sendMessage(phone, resp + MENU_FOOTER);
