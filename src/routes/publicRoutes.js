const express = require('express');
const geoip = require('geoip-lite');
const { detectDevice } = require('../utils/deviceDetector');
const { isBot } = require('../utils/botDetector');

function pickWeightedUrl(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].url;

  const totalWeight = candidates.reduce((acc, row) => acc + (Number(row.weight) || 100), 0);
  let random = Math.random() * totalWeight;

  for (const row of candidates) {
    random -= Number(row.weight) || 100;
    if (random <= 0) return row.url;
  }

  return candidates[candidates.length - 1].url;
}

function buildPublicRoutes(pool) {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({ success: true, service: 'geo-tds-tracker' });
  });

  router.get('/go/:slug', async (req, res) => {
    try {
      const { slug } = req.params;
      const campaignResult = await pool.query('SELECT * FROM tds_campaigns WHERE slug = $1', [slug]);

      if (!campaignResult.rows.length) {
        return res.status(404).send('Link not found');
      }

      const campaign = campaignResult.rows[0];
      if (!campaign.is_active) {
        return res.status(404).send('Link not found');
      }

      const now = new Date();
      if (campaign.start_date && now < new Date(campaign.start_date)) {
        return res.status(404).send('Link not found');
      }
      if (campaign.end_date && now > new Date(campaign.end_date)) {
        return res.status(410).send('Link expired');
      }

      const ua = req.headers['user-agent'] || '';
      if (campaign.block_bots && isBot(ua)) {
        return res.status(404).send('Link not found');
      }

      if (campaign.click_limit) {
        const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM tds_clicks WHERE campaign_id = $1', [campaign.id]);
        if (countResult.rows[0].count >= campaign.click_limit) {
          return res.redirect(302, campaign.default_url);
        }
      }

      const rawIp = (req.headers['x-forwarded-for'] || '').split(',')[0]?.trim() || req.ip || '';
      const normalizedIp = rawIp.replace(/^::ffff:/, '');
      const geo = geoip.lookup(normalizedIp);
      const countryCode = geo?.country || null;
      const deviceType = detectDevice(ua);

      let redirectUrl = campaign.default_url;
      if (countryCode) {
        const linksResult = await pool.query(
          `SELECT url, weight
           FROM tds_campaign_links
           WHERE campaign_id = $1
             AND country_code = $2
             AND (device_type = $3 OR device_type = 'all')`,
          [campaign.id, countryCode, deviceType]
        );

        if (linksResult.rows.length > 0) {
          redirectUrl = pickWeightedUrl(linksResult.rows) || campaign.default_url;
        }
      }

      pool.query(
        `INSERT INTO tds_clicks (campaign_id, country_code, ip, user_agent, device_type, is_bot, redirect_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [campaign.id, countryCode, rawIp, ua, deviceType, isBot(ua), redirectUrl]
      ).catch(() => {});

      return res.redirect(302, redirectUrl);
    } catch (error) {
      console.error('Redirect error:', error);
      return res.status(500).send('Internal error');
    }
  });

  return router;
}

module.exports = { buildPublicRoutes };
