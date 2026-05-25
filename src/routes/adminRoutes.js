const express = require('express');
const crypto = require('crypto');
const { adminAuth } = require('../middleware/adminAuth');

function generateSlug() {
  return crypto.randomBytes(4).toString('hex');
}

function normalizeLinks(links) {
  if (!Array.isArray(links)) return [];

  return links
    .map((item) => ({
      country_code: String(item.country_code || '').trim().toUpperCase(),
      url: String(item.url || '').trim(),
      device_type: String(item.device_type || 'all').trim().toLowerCase(),
      weight: Number(item.weight) || 100,
    }))
    .filter((item) => item.country_code.length === 2 && item.url);
}

function buildAdminRoutes(pool) {
  const router = express.Router();

  router.get('/api/admin/me', adminAuth, (_req, res) => {
    res.json({ success: true });
  });

  router.get('/api/admin/tds/campaigns', adminAuth, async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT c.*,
          (SELECT COUNT(*) FROM tds_campaign_links l WHERE l.campaign_id = c.id) AS link_count,
          (SELECT COUNT(*) FROM tds_clicks clk WHERE clk.campaign_id = c.id) AS click_count
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
      const {
        name,
        slug,
        default_url,
        click_limit,
        start_date,
        end_date,
        block_bots = true,
        is_active = true,
        links = [],
      } = req.body;

      if (!name || !default_url) {
        return res.status(400).json({ success: false, error: 'name and default_url are required' });
      }

      await client.query('BEGIN');

      const campaignResult = await client.query(
        `INSERT INTO tds_campaigns
           (name, slug, default_url, click_limit, start_date, end_date, block_bots, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          name,
          slug || generateSlug(),
          default_url,
          click_limit ? Number(click_limit) : null,
          start_date || null,
          end_date || null,
          Boolean(block_bots),
          Boolean(is_active),
        ]
      );

      const campaign = campaignResult.rows[0];
      const preparedLinks = normalizeLinks(links);
      for (const link of preparedLinks) {
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
      return res.status(500).json({ success: false, error: 'Failed to create campaign' });
    } finally {
      client.release();
    }
  });

  router.get('/api/admin/tds/campaigns/:id', adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const campaignResult = await pool.query('SELECT * FROM tds_campaigns WHERE id = $1', [id]);
      if (!campaignResult.rows.length) {
        return res.status(404).json({ success: false, error: 'Campaign not found' });
      }

      const linksResult = await pool.query(
        'SELECT id, country_code, url, device_type, weight FROM tds_campaign_links WHERE campaign_id = $1 ORDER BY country_code',
        [id]
      );

      return res.json({ success: true, campaign: campaignResult.rows[0], links: linksResult.rows });
    } catch (error) {
      console.error('Get campaign error:', error);
      return res.status(500).json({ success: false, error: 'Failed to get campaign' });
    }
  });

  router.put('/api/admin/tds/campaigns/:id', adminAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      const {
        name,
        slug,
        default_url,
        click_limit,
        start_date,
        end_date,
        block_bots,
        is_active,
        links = [],
      } = req.body;

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
          name,
          slug,
          default_url,
          click_limit ? Number(click_limit) : null,
          start_date || null,
          end_date || null,
          Boolean(block_bots),
          Boolean(is_active),
          id,
        ]
      );

      if (!updateResult.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: 'Campaign not found' });
      }

      await client.query('DELETE FROM tds_campaign_links WHERE campaign_id = $1', [id]);
      const preparedLinks = normalizeLinks(links);

      for (const link of preparedLinks) {
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
      return res.status(500).json({ success: false, error: 'Failed to update campaign' });
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

  router.get('/api/admin/tds/campaigns/:id/stats', adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const totalResult = await pool.query('SELECT COUNT(*)::int AS total FROM tds_clicks WHERE campaign_id = $1', [id]);
      const byCountryResult = await pool.query(
        `SELECT COALESCE(country_code, 'N/A') AS country_code, COUNT(*)::int AS clicks
         FROM tds_clicks
         WHERE campaign_id = $1
         GROUP BY COALESCE(country_code, 'N/A')
         ORDER BY clicks DESC`,
        [id]
      );

      res.json({
        success: true,
        stats: {
          total: totalResult.rows[0].total,
          byCountry: byCountryResult.rows,
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
