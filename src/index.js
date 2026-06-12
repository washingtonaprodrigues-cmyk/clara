require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();
app.use(express.json());

// Static files com cache normal (imagens, CSS, JS de libs)
app.use(express.static(path.join(__dirname, '../public'), {
  etag: false,
  setHeaders: (res, filePath) => {
    // dashboard.html nunca fica em cache
    if (filePath.endsWith('dashboard.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

const webhookRoutes = require('./routes/webhook');
const formsRoutes   = require('./routes/forms');
const chatRoutes    = require('./routes/chat');
const pushRoutes    = require('./routes/push');
const searchRoutes  = require('./routes/search-route');
app.use('/webhook', webhookRoutes);
app.use('/forms',   formsRoutes);
app.use('/chat',    chatRoutes);
app.use('/push',    pushRoutes);
app.use('/search',  searchRoutes);

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '../public/sw.js'));
});
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.sendFile(path.join(__dirname, '../public/manifest.json'));
});
app.get('/dashboard', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
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
