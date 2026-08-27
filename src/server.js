const path = require('path');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { pool, initSchema } = require('./db');
const { buildPublicRoutes } = require('./routes/publicRoutes');
const { buildAdminRoutes } = require('./routes/adminRoutes');
const { adminAuth } = require('./middleware/adminAuth');

function trustProxySetting() {
  const configured = Number.parseInt(process.env.TRUST_PROXY_HOPS || '1', 10);
  return Number.isFinite(configured) && configured >= 0 ? configured : 1;
}

function createApp(database = pool) {
  const app = express();
  const publicDir = path.join(__dirname, '..', 'public');
  const adminDir = path.join(publicDir, 'admin');

  // Coolify routes traffic through Traefik, so req.ip must trust exactly that hop.
  app.set('trust proxy', trustProxySetting());

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.use('/admin', adminAuth, express.static(adminDir, { index: 'index.html' }));
  app.use(express.static(publicDir, { index: false }));

  app.use(buildPublicRoutes(database));
  app.use(buildAdminRoutes(database));

  return app;
}

async function start() {
  const app = createApp(pool);

  await initSchema();

  const port = Number(process.env.PORT || 8080);
  app.listen(port, () => {
    console.log(`Geo TDS Tracker listening on :${port}`);
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Fatal startup error:', error);
    process.exit(1);
  });
}

module.exports = { createApp, start, trustProxySetting };
