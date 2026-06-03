process.on('uncaughtException', (err) => {
  console.error('❌ ERRO FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ PROMISE REJEITADA:', reason);
  process.exit(1);
});

require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());

console.log('📦 Carregando rotas...');
const webhookRoutes = require('./routes/webhook');
const formsRoutes   = require('./routes/forms');
console.log('✅ Rotas carregadas');

app.use('/webhook', webhookRoutes);
app.use('/forms',   formsRoutes);

// Dashboard — acessível em /dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

app.get('/', (req, res) => {
  res.json({ status: 'Clara online 💛', version: '1.0.0' });
});

console.log('📦 Carregando jobs...');
require('./jobs/reminders');
console.log('✅ Jobs carregados');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Clara rodando na porta ${PORT}`);
});
