const express = require('express');
const crypto = require('crypto');
const { adminAuth } = require('../middleware/adminAuth');
const {
  FALLBACK_COUNTRY,
  normalizeCountryCode,
  normalizeDeviceType,
  selectRedirectUrl,
} = require('../utils/redirectSelector');

function generateSlug() {
  return crypto.randomBytes(4).toString('hex');
}

function normalizeSlug(value) {
  const raw = String(value || '').trim();
  if (!raw) return generateSlug();

  const slug = raw.toLowerCase().replace(/\s+/g, '-');
  if (!/^[a-z0-9][a-z0-9_-]{1,58}[a-z0-9]$/.test(slug)) {
    const error = new Error('Slug can contain latin letters, numbers, dash and underscore');
    error.statusCode = 400;
    throw error;
  }

  return slug;
}

function assertHttpUrl(value, fieldName, options = {}) {
  const raw = String(value || '').trim();
  if (!raw && options.optional) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Invalid protocol');
    return raw;
  } catch (_error) {
    const error = new Error(`${fieldName} must be a valid http or https URL`);
    error.statusCode = 400;
    throw error;
  }
}

function parseNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseNullablePositiveInt(value) {
  if (value === undefined || value === null || value === '') return null;
  return Math.max(Number(value) || 0, 1);
}

function normalizeCountries(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  return [...new Set(list.map((item) => normalizeCountryCode(item)).filter((item) => item && item !== FALLBACK_COUNTRY))];
}

function normalizeLinks(links) {
  if (!Array.isArray(links)) return [];

  return links
    .map((item, index) => {
      const countryCode = normalizeCountryCode(item.country_code);
      const offerId = item.offer_id ? Number(item.offer_id) : null;
      const url = String(item.url || '').trim();

      if (!countryCode && (url || offerId)) {
        const error = new Error(`Link #${index + 1}: country must be ISO code or ANY`);
        error.statusCode = 400;
        throw error;
      }

      if (!countryCode && !url && !offerId) return null;
      if (!offerId && !url) {
        const error = new Error(`Link #${index + 1}: URL or offer is required`);
        error.statusCode = 400;
        throw error;
      }

      return {
        country_code: countryCode,
        offer_id: offerId,
        url: url ? assertHttpUrl(url, `Link #${index + 1} URL`) : '',
        device_type: normalizeDeviceType(item.device_type),
        weight: Math.max(Number(item.weight) || 100, 1),
      };
    })
    .filter(Boolean);
}

function parseCampaignPayload(body, options = {}) {
  const name = String(body.name || '').trim();
  const defaultUrl = assertHttpUrl(body.default_url, 'Default URL');

  if (!name) {
    const error = new Error('name is required');
    error.statusCode = 400;
    throw error;
  }

  return {
    name,
    slug: normalizeSlug(body.slug),
    default_url: defaultUrl,
    click_limit: parseNullablePositiveInt(body.click_limit),
    start_date: body.start_date || null,
    end_date: body.end_date || null,
    block_bots: body.block_bots === undefined ? options.defaultBlockBots ?? true : Boolean(body.block_bots),
    is_active: body.is_active === undefined ? options.defaultActive ?? true : Boolean(body.is_active),
    links: normalizeLinks(body.links || []),
  };
}

function parseOfferPayload(body) {
  const name = String(body.name || '').trim();

  if (!name) {
    const error = new Error('Offer name is required');
    error.statusCode = 400;
    throw error;
  }

  return {
    name,
    url: assertHttpUrl(body.url, 'Offer URL'),
    payout_type: String(body.payout_type || 'CPA').trim().toUpperCase().slice(0, 20),
    payout: parseNumber(body.payout, 0),
    countries: normalizeCountries(body.countries),
    affiliate_network: String(body.affiliate_network || '').trim() || null,
    notes: String(body.notes || '').trim() || null,
    is_active: body.is_active === undefined ? true : Boolean(body.is_active),
    conversion_cap: parseNullablePositiveInt(body.conversion_cap),
  };
}

function parseSourcePayload(body) {
  const name = String(body.name || '').trim();
  if (!name) {
    const error = new Error('Source name is required');
    error.statusCode = 400;
    throw error;
  }

  let params = body.params || {};
  if (typeof params === 'string') {
    try {
      params = params.trim() ? JSON.parse(params) : {};
    } catch (_error) {
      const error = new Error('Source params must be valid JSON');
      error.statusCode = 400;
      throw error;
    }
  }

  if (body.external_id_param || body.param_mappings) {
    params = {
      ...params,
      external_id_param: String(body.external_id_param || params.external_id_param || '').trim(),
      param_mappings: body.param_mappings || params.param_mappings || {},
    };
  }

  return {
    name,
    postback_url: assertHttpUrl(body.postback_url, 'Postback URL', { optional: true }) || null,
    params,
  };
}

async function fetchCampaign(pool, id) {
  const result = await pool.query('SELECT * FROM tds_campaigns WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function hydrateLink(client, link, index) {
  if (!link.offer_id) return link;

  const offerResult = await client.query('SELECT id, url FROM tds_offers WHERE id = $1', [link.offer_id]);
  if (!offerResult.rows.length) {
    const error = new Error(`Link #${index + 1}: offer not found`);
    error.statusCode = 400;
    throw error;
  }

  return {
    ...link,
    url: link.url || offerResult.rows[0].url,
  };
}

function dateRange(req, startIndex = 1) {
  const clauses = [];
  const values = [];
  let i = startIndex;
  if (req.query.from) {
    clauses.push(`created_at >= $${i}`);
    values.push(req.query.from);
    i += 1;
  }
  if (req.query.to) {
    clauses.push(`created_at <= $${i}`);
    values.push(req.query.to);
    i += 1;
  }
  return { clauses, values, nextIndex: i };
}

function scopedDateRange(alias, req, startIndex = 1) {
  const clauses = [];
  const values = [];
  let i = startIndex;
  if (req.query.from) {
    clauses.push(`${alias}.created_at >= $${i}`);
    values.push(req.query.from);
    i += 1;
  }
  if (req.query.to) {
    clauses.push(`${alias}.created_at <= $${i}`);
    values.push(req.query.to);
    i += 1;
  }
  return { clauses, values, nextIndex: i };
}

function safeLimit(value, fallback = 100, max = 1000) {
  return Math.min(Math.max(Number(value) || fallback, 1), max);
}

function buildAdminRoutes(pool) {
  const router = express.Router();

  router.get('/api/admin/me', adminAuth, (_req, res) => {
    res.json({ success: true });
  });

  router.get('/api/admin/tds/offers', adminAuth, async (_req, res) => {
    try {
      const result = await pool.query('SELECT * FROM tds_offers ORDER BY created_at DESC');
      res.json({ success: true, offers: result.rows });
    } catch (error) {
      console.error('List offers error:', error);
      res.status(500).json({ success: false, error: 'Failed to list offers' });
    }
  });

  router.post('/api/admin/tds/offers', adminAuth, async (req, res) => {
    try {
      const payload = parseOfferPayload(req.body);
      const result = await pool.query(
        `INSERT INTO tds_offers (name, url, payout_type, payout, countries, affiliate_network, notes, is_active, conversion_cap)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [payload.name, payload.url, payload.payout_type, payload.payout, payload.countries, payload.affiliate_network, payload.notes, payload.is_active, payload.conversion_cap]
      );
      res.json({ success: true, offer: result.rows[0] });
    } catch (error) {
      console.error('Create offer error:', error);
      res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Failed to create offer' });
    }
  });

  router.put('/api/admin/tds/offers/:id', adminAuth, async (req, res) => {
    try {
      const payload = parseOfferPayload(req.body);
      const result = await pool.query(
        `UPDATE tds_offers
         SET name = $1, url = $2, payout_type = $3, payout = $4, countries = $5, affiliate_network = $6,
             notes = $7, is_active = $8, conversion_cap = $9, updated_at = CURRENT_TIMESTAMP
         WHERE id = $10
         RETURNING *`,
        [payload.name, payload.url, payload.payout_type, payload.payout, payload.countries, payload.affiliate_network, payload.notes, payload.is_active, payload.conversion_cap, req.params.id]
      );

      if (!result.rows.length) return res.status(404).json({ success: false, error: 'Offer not found' });
      res.json({ success: true, offer: result.rows[0] });
    } catch (error) {
      console.error('Update offer error:', error);
      res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Failed to update offer' });
    }
  });

  router.delete('/api/admin/tds/offers/:id', adminAuth, async (req, res) => {
    try {
      const result = await pool.query('DELETE FROM tds_offers WHERE id = $1 RETURNING *', [req.params.id]);
      if (!result.rows.length) return res.status(404).json({ success: false, error: 'Offer not found' });
      res.json({ success: true, deleted: result.rows[0] });
    } catch (error) {
      console.error('Delete offer error:', error);
      res.status(500).json({ success: false, error: 'Failed to delete offer' });
    }
  });

  router.get('/api/admin/tds/sources', adminAuth, async (_req, res) => {
    try {
      const result = await pool.query('SELECT * FROM tds_traffic_sources ORDER BY created_at DESC');
      res.json({ success: true, sources: result.rows });
    } catch (error) {
      console.error('List sources error:', error);
      res.status(500).json({ success: false, error: 'Failed to list sources' });
    }
  });

  router.post('/api/admin/tds/sources', adminAuth, async (req, res) => {
    try {
      const payload = parseSourcePayload(req.body);
      const result = await pool.query(
        `INSERT INTO tds_traffic_sources (name, postback_url, params)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [payload.name, payload.postback_url, payload.params]
      );
      res.json({ success: true, source: result.rows[0] });
    } catch (error) {
      console.error('Create source error:', error);
      res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Failed to create source' });
    }
  });

  router.put('/api/admin/tds/sources/:id', adminAuth, async (req, res) => {
    try {
      const payload = parseSourcePayload(req.body);
      const result = await pool.query(
        `UPDATE tds_traffic_sources
         SET name = $1, postback_url = $2, params = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $4
         RETURNING *`,
        [payload.name, payload.postback_url, payload.params, req.params.id]
      );
      if (!result.rows.length) return res.status(404).json({ success: false, error: 'Source not found' });
      res.json({ success: true, source: result.rows[0] });
    } catch (error) {
      console.error('Update source error:', error);
      res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Failed to update source' });
    }
  });

  router.delete('/api/admin/tds/sources/:id', adminAuth, async (req, res) => {
    try {
      const result = await pool.query('DELETE FROM tds_traffic_sources WHERE id = $1 RETURNING *', [req.params.id]);
      if (!result.rows.length) return res.status(404).json({ success: false, error: 'Source not found' });
      res.json({ success: true, deleted: result.rows[0] });
    } catch (error) {
      console.error('Delete source error:', error);
      res.status(500).json({ success: false, error: 'Failed to delete source' });
    }
  });

  router.get('/api/admin/tds/campaigns', adminAuth, async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT c.*,
          (SELECT COUNT(*)::int FROM tds_campaign_links l WHERE l.campaign_id = c.id) AS link_count,
          (SELECT COUNT(*)::int FROM tds_clicks clk WHERE clk.campaign_id = c.id) AS click_count,
          (SELECT COUNT(*)::int FROM tds_clicks clk WHERE clk.campaign_id = c.id AND clk.created_at >= NOW() - INTERVAL '24 hours') AS clicks_24h,
          (SELECT COUNT(*)::int FROM tds_conversions cv WHERE cv.campaign_id = c.id AND cv.status <> 'rejected') AS conversions,
          (SELECT COALESCE(SUM(cv.payout), 0)::float FROM tds_conversions cv WHERE cv.campaign_id = c.id AND cv.status <> 'rejected') AS revenue
        FROM tds_campaigns c
        ORDER BY c.created_at DESC
      `);
      res.json({ success: true, campaigns: result.rows });
    } catch (error) {
      console.error('List campaigns error:', error);
      res.status(500).json({ success: false, error: 'Failed to list campaigns' });
    }
  });

  router.post('/api/admin/tds/campaigns', adminAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const payload = parseCampaignPayload(req.body);
      await client.query('BEGIN');

      const campaignResult = await client.query(
        `INSERT INTO tds_campaigns
           (name, slug, default_url, click_limit, start_date, end_date, block_bots, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [payload.name, payload.slug, payload.default_url, payload.click_limit, payload.start_date, payload.end_date, payload.block_bots, payload.is_active]
      );

      const campaign = campaignResult.rows[0];
      for (let i = 0; i < payload.links.length; i += 1) {
        const link = await hydrateLink(client, payload.links[i], i);
        await client.query(
          `INSERT INTO tds_campaign_links (campaign_id, offer_id, country_code, url, device_type, weight)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [campaign.id, link.offer_id, link.country_code, link.url, link.device_type, link.weight]
        );
      }

      await client.query('COMMIT');
      return res.json({ success: true, campaign });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Create campaign error:', error);
      if (error.code === '23505') return res.status(400).json({ success: false, error: 'Slug already exists' });
      return res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Failed to create campaign' });
    } finally {
      client.release();
    }
  });

  router.get('/api/admin/tds/campaigns/:id', adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const campaign = await fetchCampaign(pool, id);
      if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

      const linksResult = await pool.query(
        `SELECT l.id, l.country_code, l.url, l.device_type, l.weight, l.offer_id, o.name AS offer_name
         FROM tds_campaign_links l
         LEFT JOIN tds_offers o ON o.id = l.offer_id
         WHERE l.campaign_id = $1
         ORDER BY CASE WHEN l.country_code = $2 THEN 1 ELSE 0 END, l.country_code, l.device_type, l.id`,
        [id, FALLBACK_COUNTRY]
      );

      return res.json({ success: true, campaign, links: linksResult.rows });
    } catch (error) {
      console.error('Get campaign error:', error);
      return res.status(500).json({ success: false, error: 'Failed to get campaign' });
    }
  });

  router.put('/api/admin/tds/campaigns/:id', adminAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      const payload = parseCampaignPayload(req.body, { defaultBlockBots: true, defaultActive: true });
      await client.query('BEGIN');

      const updateResult = await client.query(
        `UPDATE tds_campaigns
         SET name = $1, slug = $2, default_url = $3, click_limit = $4, start_date = $5, end_date = $6,
             block_bots = $7, is_active = $8, updated_at = CURRENT_TIMESTAMP
         WHERE id = $9
         RETURNING *`,
        [payload.name, payload.slug, payload.default_url, payload.click_limit, payload.start_date, payload.end_date, payload.block_bots, payload.is_active, id]
      );

      if (!updateResult.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: 'Campaign not found' });
      }

      await client.query('DELETE FROM tds_campaign_links WHERE campaign_id = $1', [id]);
      for (let i = 0; i < payload.links.length; i += 1) {
        const link = await hydrateLink(client, payload.links[i], i);
        await client.query(
          `INSERT INTO tds_campaign_links (campaign_id, offer_id, country_code, url, device_type, weight)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, link.offer_id, link.country_code, link.url, link.device_type, link.weight]
        );
      }

      await client.query('COMMIT');
      return res.json({ success: true, campaign: updateResult.rows[0] });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Update campaign error:', error);
      if (error.code === '23505') return res.status(400).json({ success: false, error: 'Slug already exists' });
      return res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Failed to update campaign' });
    } finally {
      client.release();
    }
  });

  router.patch('/api/admin/tds/campaigns/:id/status', adminAuth, async (req, res) => {
    try {
      const result = await pool.query(
        `UPDATE tds_campaigns SET is_active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
        [Boolean(req.body.is_active), req.params.id]
      );
      if (!result.rows.length) return res.status(404).json({ success: false, error: 'Campaign not found' });
      return res.json({ success: true, campaign: result.rows[0] });
    } catch (error) {
      console.error('Update status error:', error);
      return res.status(500).json({ success: false, error: 'Failed to update status' });
    }
  });

  router.post('/api/admin/tds/campaigns/:id/duplicate', adminAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const source = await fetchCampaign(pool, req.params.id);
      if (!source) return res.status(404).json({ success: false, error: 'Campaign not found' });

      const sourceLinks = await pool.query(
        'SELECT country_code, url, device_type, weight, offer_id FROM tds_campaign_links WHERE campaign_id = $1 ORDER BY id',
        [req.params.id]
      );

      await client.query('BEGIN');
      const newSlug = `${source.slug}-${generateSlug().slice(0, 4)}`.slice(0, 60);
      const campaignResult = await client.query(
        `INSERT INTO tds_campaigns (name, slug, default_url, click_limit, start_date, end_date, block_bots, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, false)
         RETURNING *`,
        [`${source.name} copy`, newSlug, source.default_url, source.click_limit, source.start_date, source.end_date, source.block_bots]
      );

      for (const link of sourceLinks.rows) {
        await client.query(
          `INSERT INTO tds_campaign_links (campaign_id, offer_id, country_code, url, device_type, weight)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [campaignResult.rows[0].id, link.offer_id, link.country_code, link.url, link.device_type, link.weight]
        );
      }

      await client.query('COMMIT');
      return res.json({ success: true, campaign: campaignResult.rows[0] });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Duplicate campaign error:', error);
      return res.status(500).json({ success: false, error: 'Failed to duplicate campaign' });
    } finally {
      client.release();
    }
  });

  router.delete('/api/admin/tds/campaigns/:id', adminAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM tds_conversions WHERE campaign_id = $1', [req.params.id]);
      const result = await client.query('DELETE FROM tds_campaigns WHERE id = $1 RETURNING *', [req.params.id]);
      if (!result.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: 'Campaign not found' });
      }
      await client.query('COMMIT');
      return res.json({ success: true, deleted: result.rows[0] });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Delete campaign error:', error);
      return res.status(500).json({ success: false, error: 'Failed to delete campaign' });
    } finally {
      client.release();
    }
  });

  router.get('/api/admin/tds/campaigns/:id/simulate', adminAuth, async (req, res) => {
    try {
      const campaign = await fetchCampaign(pool, req.params.id);
      if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

      const countryCode = normalizeCountryCode(req.query.country || FALLBACK_COUNTRY);
      const deviceType = normalizeDeviceType(req.query.device || 'desktop');
      const { redirectUrl, matchedLinks, offerId } = await selectRedirectUrl(pool, campaign, countryCode, deviceType);

      return res.json({
        success: true,
        result: {
          country_code: countryCode,
          device_type: deviceType,
          redirect_url: redirectUrl,
          offer_id: offerId,
          matched_links: matchedLinks,
          used_default: matchedLinks.length === 0,
        },
      });
    } catch (error) {
      console.error('Simulate error:', error);
      return res.status(500).json({ success: false, error: 'Failed to simulate route' });
    }
  });

  router.get('/api/admin/tds/campaigns/:id/stats', adminAuth, async (req, res) => {
    try {
      const id = req.params.id;
      const clicks = await pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE is_unique)::int AS unique_clicks,
                COUNT(*) FILTER (WHERE is_bot)::int AS bots,
                COALESCE(SUM(cost), 0)::float AS cost
         FROM tds_clicks WHERE campaign_id = $1`,
        [id]
      );
      const conversions = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE status <> 'rejected')::int AS conversions,
                COALESCE(SUM(payout) FILTER (WHERE status <> 'rejected'), 0)::float AS revenue
         FROM tds_conversions WHERE campaign_id = $1`,
        [id]
      );
      const byCountryResult = await pool.query(
        `SELECT COALESCE(country_code, 'N/A') AS country_code, COUNT(*)::int AS clicks
         FROM tds_clicks WHERE campaign_id = $1 GROUP BY COALESCE(country_code, 'N/A') ORDER BY clicks DESC`,
        [id]
      );
      const byDeviceResult = await pool.query(
        `SELECT COALESCE(device_type, 'unknown') AS device_type, COUNT(*)::int AS clicks
         FROM tds_clicks WHERE campaign_id = $1 GROUP BY COALESCE(device_type, 'unknown') ORDER BY clicks DESC`,
        [id]
      );
      const recentResult = await pool.query(
        `SELECT click_id, country_code, device_type, is_bot, is_unique, redirect_url, source, cost, created_at
         FROM tds_clicks WHERE campaign_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [id]
      );

      const clickRow = clicks.rows[0];
      const convRow = conversions.rows[0];
      const total = Number(clickRow.total) || 0;
      const cost = Number(clickRow.cost) || 0;
      const revenue = Number(convRow.revenue) || 0;
      const conversionCount = Number(convRow.conversions) || 0;
      const profit = revenue - cost;

      res.json({
        success: true,
        stats: {
          total,
          last24h: recentResult.rows.filter((row) => Date.now() - new Date(row.created_at).getTime() < 86400000).length,
          unique_clicks: Number(clickRow.unique_clicks) || 0,
          bots: Number(clickRow.bots) || 0,
          conversions: conversionCount,
          revenue,
          cost,
          profit,
          roi: cost ? (profit / cost) * 100 : 0,
          cr: total ? (conversionCount / total) * 100 : 0,
          epc: total ? revenue / total : 0,
          byCountry: byCountryResult.rows,
          byDevice: byDeviceResult.rows,
          recent: recentResult.rows,
        },
      });
    } catch (error) {
      console.error('Stats error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch stats' });
    }
  });

  router.get('/api/admin/tds/reports/summary', adminAuth, async (req, res) => {
    try {
      const clickRange = dateRange(req);
      const clickWhere = clickRange.clauses.length ? `WHERE ${clickRange.clauses.join(' AND ')}` : '';
      const convRange = dateRange(req);
      const convWhere = convRange.clauses.length ? `WHERE ${convRange.clauses.join(' AND ')} AND status <> 'rejected'` : "WHERE status <> 'rejected'";

      const clickResult = await pool.query(
        `SELECT COUNT(*)::int AS clicks,
                COUNT(*) FILTER (WHERE is_unique)::int AS unique_clicks,
                COUNT(*) FILTER (WHERE is_bot)::int AS bots,
                COALESCE(SUM(cost), 0)::float AS cost
         FROM tds_clicks ${clickWhere}`,
        clickRange.values
      );
      const convResult = await pool.query(
        `SELECT COUNT(*)::int AS conversions, COALESCE(SUM(payout), 0)::float AS revenue
         FROM tds_conversions ${convWhere}`,
        convRange.values
      );

      const clicks = Number(clickResult.rows[0].clicks) || 0;
      const cost = Number(clickResult.rows[0].cost) || 0;
      const conversions = Number(convResult.rows[0].conversions) || 0;
      const revenue = Number(convResult.rows[0].revenue) || 0;
      const profit = revenue - cost;

      res.json({
        success: true,
        summary: {
          clicks,
          unique_clicks: Number(clickResult.rows[0].unique_clicks) || 0,
          bots: Number(clickResult.rows[0].bots) || 0,
          conversions,
          revenue,
          cost,
          profit,
          roi: cost ? (profit / cost) * 100 : 0,
          cr: clicks ? (conversions / clicks) * 100 : 0,
          epc: clicks ? revenue / clicks : 0,
        },
      });
    } catch (error) {
      console.error('Summary report error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch summary' });
    }
  });

  router.get('/api/admin/tds/reports/breakdown', adminAuth, async (req, res) => {
    try {
      const groups = {
        campaign: { key: 'COALESCE(c.name, \'N/A\')', join: 'LEFT JOIN tds_campaigns c ON c.id = clk.campaign_id' },
        offer: { key: 'COALESCE(o.name, \'N/A\')', join: 'LEFT JOIN tds_offers o ON o.id = clk.offer_id' },
        country: { key: "COALESCE(clk.country_code, 'N/A')", join: '' },
        device: { key: "COALESCE(clk.device_type, 'unknown')", join: '' },
        source: { key: "COALESCE(clk.source, 'N/A')", join: '' },
        creative: { key: "COALESCE(clk.creative_id, 'N/A')", join: '' },
        sub_id_1: { key: "COALESCE(clk.sub_id_1, 'N/A')", join: '' },
      };
      const config = groups[req.query.group] || groups.campaign;
      const range = scopedDateRange('clk', req);
      const where = range.clauses.length ? `WHERE ${range.clauses.join(' AND ')}` : '';
      const result = await pool.query(
        `SELECT ${config.key} AS name,
                COUNT(clk.*)::int AS clicks,
                COUNT(clk.*) FILTER (WHERE clk.is_unique)::int AS unique_clicks,
                COALESCE(SUM(clk.cost), 0)::float AS cost,
                COUNT(cv.*) FILTER (WHERE cv.status <> 'rejected')::int AS conversions,
                COALESCE(SUM(cv.payout) FILTER (WHERE cv.status <> 'rejected'), 0)::float AS revenue
         FROM tds_clicks clk
         ${config.join}
         LEFT JOIN tds_conversions cv ON cv.click_id = clk.click_id
         ${where}
         GROUP BY ${config.key}
         ORDER BY clicks DESC
         LIMIT 100`,
        range.values
      );

      const rows = result.rows.map((row) => {
        const clicks = Number(row.clicks) || 0;
        const cost = Number(row.cost) || 0;
        const revenue = Number(row.revenue) || 0;
        const conversions = Number(row.conversions) || 0;
        const profit = revenue - cost;
        return {
          ...row,
          profit,
          roi: cost ? (profit / cost) * 100 : 0,
          cr: clicks ? (conversions / clicks) * 100 : 0,
          epc: clicks ? revenue / clicks : 0,
        };
      });

      res.json({ success: true, group: req.query.group || 'campaign', rows });
    } catch (error) {
      console.error('Breakdown report error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch breakdown' });
    }
  });

  router.get('/api/admin/tds/clicks', adminAuth, async (req, res) => {
    try {
      const values = [];
      const clauses = [];
      if (req.query.campaign_id) {
        values.push(req.query.campaign_id);
        clauses.push(`clk.campaign_id = $${values.length}`);
      }
      const range = scopedDateRange('clk', req, values.length + 1);
      values.push(...range.values);
      clauses.push(...range.clauses);
      values.push(safeLimit(req.query.limit));
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const result = await pool.query(
        `SELECT clk.*, c.name AS campaign_name, o.name AS offer_name
         FROM tds_clicks clk
         LEFT JOIN tds_campaigns c ON c.id = clk.campaign_id
         LEFT JOIN tds_offers o ON o.id = clk.offer_id
         ${where}
         ORDER BY clk.created_at DESC
         LIMIT $${values.length}`,
        values
      );
      res.json({ success: true, clicks: result.rows });
    } catch (error) {
      console.error('Clicks log error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch clicks' });
    }
  });

  router.get('/api/admin/tds/conversions', adminAuth, async (req, res) => {
    try {
      const values = [];
      const clauses = [];
      if (req.query.campaign_id) {
        values.push(req.query.campaign_id);
        clauses.push(`cv.campaign_id = $${values.length}`);
      }
      const range = scopedDateRange('cv', req, values.length + 1);
      values.push(...range.values);
      clauses.push(...range.clauses);
      values.push(safeLimit(req.query.limit));
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const result = await pool.query(
        `SELECT cv.*, c.name AS campaign_name, o.name AS offer_name
         FROM tds_conversions cv
         LEFT JOIN tds_campaigns c ON c.id = cv.campaign_id
         LEFT JOIN tds_offers o ON o.id = cv.offer_id
         ${where}
         ORDER BY cv.created_at DESC
         LIMIT $${values.length}`,
        values
      );
      res.json({ success: true, conversions: result.rows });
    } catch (error) {
      console.error('Conversions log error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch conversions' });
    }
  });

  return router;
}

module.exports = { buildAdminRoutes };
