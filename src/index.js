require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());

const webhookRoutes = require('./routes/webhook');
const formsRoutes   = require('./routes/forms');

app.use('/webhook', webhookRoutes);
app.use('/forms',   formsRoutes);

// Dashboard — acessível em /dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

app.get('/', (req, res) => {
  res.json({ status: 'Clara online 💛', version: '1.0.0' });
});

require('./jobs/reminders');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Clara rodando na porta ${PORT}`);
});
