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

function assertHttpUrl(value, fieldName) {
  const raw = String(value || '').trim();
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

function normalizeLinks(links) {
  if (!Array.isArray(links)) return [];

  return links
    .map((item, index) => {
      const countryCode = normalizeCountryCode(item.country_code);
      const url = String(item.url || '').trim();

      if (!countryCode && url) {
        const error = new Error(`Link #${index + 1}: country must be ISO code or ANY`);
        error.statusCode = 400;
        throw error;
      }

      if (countryCode && !url) {
        const error = new Error(`Link #${index + 1}: URL is required`);
        error.statusCode = 400;
        throw error;
      }

      if (!countryCode && !url) return null;

      return {
        country_code: countryCode,
        url: assertHttpUrl(url, `Link #${index + 1} URL`),
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
    click_limit: body.click_limit ? Math.max(Number(body.click_limit) || 0, 1) : null,
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
  };
}

async function fetchCampaign(pool, id) {
  const result = await pool.query('SELECT * FROM tds_campaigns WHERE id = $1', [id]);
  return result.rows[0] || null;
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
        `INSERT INTO tds_offers (name, url)
         VALUES ($1, $2)
         RETURNING *`,
        [payload.name, payload.url]
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
         SET name = $1, url = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3
         RETURNING *`,
        [payload.name, payload.url, req.params.id]
      );

      if (!result.rows.length) {
        return res.status(404).json({ success: false, error: 'Offer not found' });
      }

      res.json({ success: true, offer: result.rows[0] });
    } catch (error) {
      console.error('Update offer error:', error);
      res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Failed to update offer' });
    }
  });

  router.delete('/api/admin/tds/offers/:id', adminAuth, async (req, res) => {
    try {
      const result = await pool.query('DELETE FROM tds_offers WHERE id = $1 RETURNING *', [req.params.id]);
      if (!result.rows.length) {
        return res.status(404).json({ success: false, error: 'Offer not found' });
      }
      res.json({ success: true, deleted: result.rows[0] });
    } catch (error) {
      console.error('Delete offer error:', error);
      res.status(500).json({ success: false, error: 'Failed to delete offer' });
    }
  });

  router.get('/api/admin/tds/campaigns', adminAuth, async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT c.*,
          (SELECT COUNT(*)::int FROM tds_campaign_links l WHERE l.campaign_id = c.id) AS link_count,
          (SELECT COUNT(*)::int FROM tds_clicks clk WHERE clk.campaign_id = c.id) AS click_count,
          (SELECT COUNT(*)::int FROM tds_clicks clk WHERE clk.campaign_id = c.id AND clk.created_at >= NOW() - INTERVAL '24 hours') AS clicks_24h
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
        [
          payload.name,
          payload.slug,
          payload.default_url,
          payload.click_limit,
          payload.start_date,
          payload.end_date,
          payload.block_bots,
          payload.is_active,
        ]
      );

      const campaign = campaignResult.rows[0];
      for (const link of payload.links) {
        await client.query(
          `INSERT INTO tds_campaign_links (campaign_id, country_code, url, device_type, weight)
           VALUES ($1, $2, $3, $4, $5)`,
          [campaign.id, link.country_code, link.url, link.device_type, link.weight]
        );
      }

      await client.query('COMMIT');
      return res.json({ success: true, campaign });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Create campaign error:', error);
      if (error.code === '23505') {
        return res.status(400).json({ success: false, error: 'Slug already exists' });
      }
      return res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Failed to create campaign' });
    } finally {
      client.release();
    }
  });

  router.get('/api/admin/tds/campaigns/:id', adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const campaign = await fetchCampaign(pool, id);
      if (!campaign) {
        return res.status(404).json({ success: false, error: 'Campaign not found' });
      }

      const linksResult = await pool.query(
        `SELECT id, country_code, url, device_type, weight
         FROM tds_campaign_links
         WHERE campaign_id = $1
         ORDER BY CASE WHEN country_code = $2 THEN 1 ELSE 0 END, country_code, device_type, id`,
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
         SET name = $1,
             slug = $2,
             default_url = $3,
             click_limit = $4,
             start_date = $5,
             end_date = $6,
             block_bots = $7,
             is_active = $8,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $9
         RETURNING *`,
        [
          payload.name,
          payload.slug,
          payload.default_url,
          payload.click_limit,
          payload.start_date,
          payload.end_date,
          payload.block_bots,
          payload.is_active,
          id,
        ]
      );

      if (!updateResult.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: 'Campaign not found' });
      }

      await client.query('DELETE FROM tds_campaign_links WHERE campaign_id = $1', [id]);
      for (const link of payload.links) {
        await client.query(
          `INSERT INTO tds_campaign_links (campaign_id, country_code, url, device_type, weight)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, link.country_code, link.url, link.device_type, link.weight]
        );
      }

      await client.query('COMMIT');
      return res.json({ success: true, campaign: updateResult.rows[0] });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Update campaign error:', error);
      if (error.code === '23505') {
        return res.status(400).json({ success: false, error: 'Slug already exists' });
      }
      return res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Failed to update campaign' });
    } finally {
      client.release();
    }
  });

  router.patch('/api/admin/tds/campaigns/:id/status', adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query(
        `UPDATE tds_campaigns
         SET is_active = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING *`,
        [Boolean(req.body.is_active), id]
      );

      if (!result.rows.length) {
        return res.status(404).json({ success: false, error: 'Campaign not found' });
      }

      return res.json({ success: true, campaign: result.rows[0] });
    } catch (error) {
      console.error('Update status error:', error);
      return res.status(500).json({ success: false, error: 'Failed to update status' });
    }
  });

  router.post('/api/admin/tds/campaigns/:id/duplicate', adminAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      const source = await fetchCampaign(pool, id);
      if (!source) return res.status(404).json({ success: false, error: 'Campaign not found' });

      const sourceLinks = await pool.query(
        'SELECT country_code, url, device_type, weight FROM tds_campaign_links WHERE campaign_id = $1 ORDER BY id',
        [id]
      );

      await client.query('BEGIN');
      const newSlug = `${source.slug}-${generateSlug().slice(0, 4)}`.slice(0, 60);
      const campaignResult = await client.query(
        `INSERT INTO tds_campaigns
           (name, slug, default_url, click_limit, start_date, end_date, block_bots, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, false)
         RETURNING *`,
        [`${source.name} copy`, newSlug, source.default_url, source.click_limit, source.start_date, source.end_date, source.block_bots]
      );

      for (const link of sourceLinks.rows) {
        await client.query(
          `INSERT INTO tds_campaign_links (campaign_id, country_code, url, device_type, weight)
           VALUES ($1, $2, $3, $4, $5)`,
          [campaignResult.rows[0].id, link.country_code, link.url, link.device_type, link.weight]
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
    try {
      const { id } = req.params;
      const result = await pool.query('DELETE FROM tds_campaigns WHERE id = $1 RETURNING *', [id]);
      if (!result.rows.length) {
        return res.status(404).json({ success: false, error: 'Campaign not found' });
      }
      return res.json({ success: true, deleted: result.rows[0] });
    } catch (error) {
      console.error('Delete campaign error:', error);
      return res.status(500).json({ success: false, error: 'Failed to delete campaign' });
    }
  });

  router.get('/api/admin/tds/campaigns/:id/simulate', adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const campaign = await fetchCampaign(pool, id);
      if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

      const countryCode = normalizeCountryCode(req.query.country || FALLBACK_COUNTRY);
      const deviceType = normalizeDeviceType(req.query.device || 'desktop');
      const { redirectUrl, matchedLinks } = await selectRedirectUrl(pool, campaign, countryCode, deviceType);

      return res.json({
        success: true,
        result: {
          country_code: countryCode,
          device_type: deviceType,
          redirect_url: redirectUrl,
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
      const { id } = req.params;
      const totalResult = await pool.query('SELECT COUNT(*)::int AS total FROM tds_clicks WHERE campaign_id = $1', [id]);
      const last24Result = await pool.query(
        `SELECT COUNT(*)::int AS total
         FROM tds_clicks
         WHERE campaign_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'`,
        [id]
      );
      const byCountryResult = await pool.query(
        `SELECT COALESCE(country_code, 'N/A') AS country_code, COUNT(*)::int AS clicks
         FROM tds_clicks
         WHERE campaign_id = $1
         GROUP BY COALESCE(country_code, 'N/A')
         ORDER BY clicks DESC`,
        [id]
      );
      const byDeviceResult = await pool.query(
        `SELECT COALESCE(device_type, 'unknown') AS device_type, COUNT(*)::int AS clicks
         FROM tds_clicks
         WHERE campaign_id = $1
         GROUP BY COALESCE(device_type, 'unknown')
         ORDER BY clicks DESC`,
        [id]
      );
      const recentResult = await pool.query(
        `SELECT country_code, device_type, is_bot, redirect_url, created_at
         FROM tds_clicks
         WHERE campaign_id = $1
         ORDER BY created_at DESC
         LIMIT 20`,
        [id]
      );

      res.json({
        success: true,
        stats: {
          total: totalResult.rows[0].total,
          last24h: last24Result.rows[0].total,
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

  return router;
}

module.exports = { buildAdminRoutes };
