const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tds_campaigns (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(60) UNIQUE NOT NULL,
      default_url TEXT NOT NULL,
      click_limit INT DEFAULT NULL,
      start_date TIMESTAMPTZ DEFAULT NULL,
      end_date TIMESTAMPTZ DEFAULT NULL,
      block_bots BOOLEAN DEFAULT TRUE,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tds_campaign_links (
      id SERIAL PRIMARY KEY,
      campaign_id INT NOT NULL REFERENCES tds_campaigns(id) ON DELETE CASCADE,
      country_code VARCHAR(2) NOT NULL,
      url TEXT NOT NULL,
      device_type VARCHAR(10) DEFAULT 'all',
      weight INT DEFAULT 100,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tds_clicks (
      id SERIAL PRIMARY KEY,
      campaign_id INT NOT NULL REFERENCES tds_campaigns(id) ON DELETE CASCADE,
      country_code VARCHAR(2),
      ip VARCHAR(45),
      user_agent TEXT,
      device_type VARCHAR(10),
      is_bot BOOLEAN DEFAULT FALSE,
      redirect_url TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tds_offers (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      url TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_tds_campaigns_slug ON tds_campaigns(slug);
    CREATE INDEX IF NOT EXISTS idx_tds_campaign_links_campaign ON tds_campaign_links(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_tds_campaign_links_lookup ON tds_campaign_links(campaign_id, country_code, device_type);
    CREATE INDEX IF NOT EXISTS idx_tds_clicks_campaign ON tds_clicks(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_tds_clicks_created_at ON tds_clicks(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tds_clicks_campaign_created_at ON tds_clicks(campaign_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tds_offers_created_at ON tds_offers(created_at DESC);
  `);
}

module.exports = {
  pool,
  initSchema,
};
