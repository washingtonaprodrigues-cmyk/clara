const { classify, searchWeb, freeResponse, generateMemorySummary } = require('./groq');
const { sendMessage, sendButtons } = require('./whatsapp');
const memory = require('./memory');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const MENU = `✨ *Clara, sua assistente pessoal*

Escolha uma opção pelo número ou escreva do seu jeito:

*1* ⏰ Criar lembrete
*2* 📝 Salvar anotação
*3* 💰 Registrar gasto
*4* 💊 Cadastrar remédio
*5* 📍 Bater ponto
*6* 🔍 Pesquisar algo
*7* 💬 Conversar comigo

*Atalhos rápidos*
• _ver lembretes_
• _ver anotações_
• _ver gastos_
• _ver medicamentos_
• _ver horas hoje_

Exemplos:
_"me lembra de tomar remédio às 22h"_
_"gastei 42 reais no mercado"_
_"cheguei às 9h no trabalho"_`;

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
  lembrete: `⏰ *Vamos criar um lembrete*\n\nMe diga o compromisso e o horário.\n\nExemplos:\n• _"me lembra às 19h de buscar minha filha"_\n• _"amanhã às 8h tomar remédio"_`,
  anotacao: `📝 *Vou guardar uma anotação pra você*\n\nPode mandar senha, código, endereço, ideia ou qualquer informação importante.\n\nExemplo:\n_"senha do Wi-Fi: 12345"_`,
  gasto: `💰 *Controle de gastos*\n\nMe conte o valor e onde foi.\n\nExemplos:\n• _"gastei 45 reais no mercado"_\n• _"paguei 120 no restaurante"_`,
  saude: `💊 *Cuidados de saúde*\n\nMe diga o remédio e os horários.\n\nExemplos:\n• _"Losartana todo dia às 8h"_\n• _"Vitamina C às 9h e às 21h"_`,
  ponto: `📍 *Ponto digital*\n\nVocê pode mandar um registro ou o dia completo.\n\nExemplo:\n_"entrei 8h, saí almoço 12h, voltei 13h e saí 17h"_`,
  pesquisar: `🔍 *Pesquisa rápida*\n\nMe diga o que quer saber.\n\nExemplos:\n• _"vai chover amanhã?"_\n• _"farmácia perto de mim"_`,
  conversar: `💬 *Estou aqui*\n\nPode falar comigo do seu jeito. 😊`,
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
