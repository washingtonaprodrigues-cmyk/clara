require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());

const webhookRoutes = require('./routes/webhook');
const formsRoutes   = require('./routes/forms');
const chatRoutes    = require('./routes/chat');

app.use('/webhook', webhookRoutes);
app.use('/forms',   formsRoutes);
app.use('/chat',    chatRoutes);

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
