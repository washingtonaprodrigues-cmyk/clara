require('dotenv').config();
const express = require('express');
const app = express();

app.use(express.json());

const webhookRoutes = require('./routes/webhook');
app.use('/webhook', webhookRoutes);

app.get('/', (req, res) => {
  res.json({ status: 'Clara online 💛', version: '1.0.0' });
});

require('./jobs/reminders');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Clara rodando na porta ${PORT}`);
});
