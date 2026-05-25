const path = require('path');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { pool, initSchema } = require('./db');
const { buildPublicRoutes } = require('./routes/publicRoutes');
const { buildAdminRoutes } = require('./routes/adminRoutes');

async function start() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/admin', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html'));
  });

  app.use(buildPublicRoutes(pool));
  app.use(buildAdminRoutes(pool));

  await initSchema();

  const port = Number(process.env.PORT || 8080);
  app.listen(port, () => {
    console.log(`Geo TDS Tracker listening on :${port}`);
  });
}

start().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
