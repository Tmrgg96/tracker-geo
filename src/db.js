const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function addColumnIfMissing(table, column, definition) {
  await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
}

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

    CREATE TABLE IF NOT EXISTS tds_offers (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      url TEXT NOT NULL,
      payout_type VARCHAR(20) DEFAULT 'CPA',
      payout NUMERIC(12, 4) DEFAULT 0,
      countries TEXT[] DEFAULT '{}',
      affiliate_network VARCHAR(255),
      notes TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      conversion_cap INT DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tds_traffic_sources (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      postback_url TEXT,
      params JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tds_campaign_links (
      id SERIAL PRIMARY KEY,
      campaign_id INT NOT NULL REFERENCES tds_campaigns(id) ON DELETE CASCADE,
      offer_id INT REFERENCES tds_offers(id) ON DELETE SET NULL,
      country_code VARCHAR(2) NOT NULL,
      url TEXT NOT NULL,
      device_type VARCHAR(10) DEFAULT 'all',
      weight INT DEFAULT 100,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tds_clicks (
      id SERIAL PRIMARY KEY,
      click_id VARCHAR(40) UNIQUE,
      campaign_id INT NOT NULL REFERENCES tds_campaigns(id) ON DELETE CASCADE,
      offer_id INT REFERENCES tds_offers(id) ON DELETE SET NULL,
      source_id INT REFERENCES tds_traffic_sources(id) ON DELETE SET NULL,
      country_code VARCHAR(2),
      ip VARCHAR(45),
      user_agent TEXT,
      device_type VARCHAR(10),
      is_bot BOOLEAN DEFAULT FALSE,
      is_unique BOOLEAN DEFAULT TRUE,
      redirect_url TEXT,
      external_id TEXT,
      source TEXT,
      keyword TEXT,
      ad_campaign_id TEXT,
      creative_id TEXT,
      cost NUMERIC(12, 4) DEFAULT 0,
      currency VARCHAR(10),
      sub_id_1 TEXT,
      sub_id_2 TEXT,
      sub_id_3 TEXT,
      sub_id_4 TEXT,
      sub_id_5 TEXT,
      sub_id_6 TEXT,
      sub_id_7 TEXT,
      sub_id_8 TEXT,
      sub_id_9 TEXT,
      sub_id_10 TEXT,
      referrer TEXT,
      browser TEXT,
      os TEXT,
      language TEXT,
      city TEXT,
      region TEXT,
      params JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tds_conversions (
      id SERIAL PRIMARY KEY,
      click_id VARCHAR(40) NOT NULL,
      campaign_id INT REFERENCES tds_campaigns(id) ON DELETE SET NULL,
      offer_id INT REFERENCES tds_offers(id) ON DELETE SET NULL,
      status VARCHAR(40) NOT NULL,
      original_status VARCHAR(100),
      payout NUMERIC(12, 4) DEFAULT 0,
      currency VARCHAR(10),
      tid TEXT DEFAULT '',
      raw JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (click_id, status, tid)
    );
  `);

  await addColumnIfMissing('tds_campaign_links', 'offer_id', 'INT REFERENCES tds_offers(id) ON DELETE SET NULL');

  await addColumnIfMissing('tds_offers', 'payout_type', "VARCHAR(20) DEFAULT 'CPA'");
  await addColumnIfMissing('tds_offers', 'payout', 'NUMERIC(12, 4) DEFAULT 0');
  await addColumnIfMissing('tds_offers', 'countries', "TEXT[] DEFAULT '{}'");
  await addColumnIfMissing('tds_offers', 'affiliate_network', 'VARCHAR(255)');
  await addColumnIfMissing('tds_offers', 'notes', 'TEXT');
  await addColumnIfMissing('tds_offers', 'is_active', 'BOOLEAN DEFAULT TRUE');
  await addColumnIfMissing('tds_offers', 'conversion_cap', 'INT DEFAULT NULL');

  const clickColumns = [
    ['click_id', 'VARCHAR(40) UNIQUE'],
    ['offer_id', 'INT REFERENCES tds_offers(id) ON DELETE SET NULL'],
    ['source_id', 'INT REFERENCES tds_traffic_sources(id) ON DELETE SET NULL'],
    ['external_id', 'TEXT'],
    ['source', 'TEXT'],
    ['keyword', 'TEXT'],
    ['ad_campaign_id', 'TEXT'],
    ['creative_id', 'TEXT'],
    ['cost', 'NUMERIC(12, 4) DEFAULT 0'],
    ['currency', 'VARCHAR(10)'],
    ['sub_id_1', 'TEXT'],
    ['sub_id_2', 'TEXT'],
    ['sub_id_3', 'TEXT'],
    ['sub_id_4', 'TEXT'],
    ['sub_id_5', 'TEXT'],
    ['sub_id_6', 'TEXT'],
    ['sub_id_7', 'TEXT'],
    ['sub_id_8', 'TEXT'],
    ['sub_id_9', 'TEXT'],
    ['sub_id_10', 'TEXT'],
    ['referrer', 'TEXT'],
    ['browser', 'TEXT'],
    ['os', 'TEXT'],
    ['language', 'TEXT'],
    ['city', 'TEXT'],
    ['region', 'TEXT'],
    ['is_unique', 'BOOLEAN DEFAULT TRUE'],
    ['params', "JSONB DEFAULT '{}'::jsonb"],
  ];

  for (const [column, definition] of clickColumns) {
    await addColumnIfMissing('tds_clicks', column, definition);
  }

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tds_campaigns_slug ON tds_campaigns(slug);
    CREATE INDEX IF NOT EXISTS idx_tds_campaign_links_campaign ON tds_campaign_links(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_tds_campaign_links_lookup ON tds_campaign_links(campaign_id, country_code, device_type);
    CREATE INDEX IF NOT EXISTS idx_tds_campaign_links_offer ON tds_campaign_links(offer_id);
    CREATE INDEX IF NOT EXISTS idx_tds_clicks_campaign ON tds_clicks(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_tds_clicks_click_id ON tds_clicks(click_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tds_clicks_click_id_unique ON tds_clicks(click_id);
    CREATE INDEX IF NOT EXISTS idx_tds_clicks_offer ON tds_clicks(offer_id);
    CREATE INDEX IF NOT EXISTS idx_tds_clicks_source ON tds_clicks(source_id);
    CREATE INDEX IF NOT EXISTS idx_tds_clicks_uniqueness ON tds_clicks(campaign_id, ip, user_agent, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tds_clicks_created_at ON tds_clicks(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tds_clicks_campaign_created_at ON tds_clicks(campaign_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tds_conversions_click_id ON tds_conversions(click_id);
    CREATE INDEX IF NOT EXISTS idx_tds_conversions_campaign ON tds_conversions(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_tds_conversions_created_at ON tds_conversions(created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tds_conversions_dedupe ON tds_conversions(click_id, status, tid);
    CREATE INDEX IF NOT EXISTS idx_tds_offers_created_at ON tds_offers(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tds_traffic_sources_created_at ON tds_traffic_sources(created_at DESC);
  `);
}

module.exports = {
  pool,
  initSchema,
};
