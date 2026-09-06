require('dotenv').config();
const express = require('express');
const cors = require('cors');

const generateRoutes = require('./routes/generate');
const socialRoutes = require('./routes/social');
const videoRoutes = require('./routes/video');

const app = express();

app.set('trust proxy', 1); // necessario su Railway per avere req.protocol corretto (https)

app.use(cors()); // se vuoi restringere, sostituisci con { origin: process.env.FRONTEND_URL }
app.use(express.json({ limit: '5mb' }));
app.use('/videos', express.static(require('path').join(__dirname, 'public', 'videos')));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api', generateRoutes);
app.use('/api', socialRoutes);
app.use('/api', videoRoutes);

// Gestione errori centralizzata: qualsiasi throw nelle route arriva qui
app.use((err, req, res, next) => {
  console.error('Errore server:', err);
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Errore interno del server'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`InPostSocial backend attivo sulla porta ${PORT}`));
