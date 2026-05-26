const crypto = require('crypto');
const express = require('express');
const geoip = require('geoip-lite');
const UAParser = require('ua-parser-js');
const { detectDevice } = require('../utils/deviceDetector');
const { isBot } = require('../utils/botDetector');
const { selectRedirectUrl } = require('../utils/redirectSelector');
const { applyRedirectMacros, scalar } = require('../utils/urlMacros');

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = (Array.isArray(forwarded) ? forwarded[0] : forwarded || '').split(',')[0]?.trim() || req.ip || '';
  return raw.replace(/^::ffff:/, '');
}

function pickParam(params, names, fallback = null) {
  for (const name of names) {
    const value = params[name];
    if (value !== undefined && value !== null && scalar(value).trim() !== '') {
      return scalar(value).trim();
    }
  }
  return fallback;
}

function parseDecimal(value) {
  const raw = scalar(value).replace(',', '.').trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseInteger(value) {
  const parsed = Number.parseInt(scalar(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeParams(query = {}) {
  return Object.fromEntries(
    Object.entries(query).map(([key, value]) => {
      if (Array.isArray(value)) return [key, value.map((item) => scalar(item))];
      if (value && typeof value === 'object') return [key, value];
      return [key, scalar(value)];
    })
  );
}

function extractLanguage(req) {
  const header = scalar(req.headers['accept-language']);
  return header.split(',')[0]?.split(';')[0]?.trim() || null;
}

function extractUserAgentDetails(userAgent) {
  const parser = new UAParser(userAgent);
  const browser = parser.getBrowser();
  const os = parser.getOS();

  return {
    browser: [browser.name, browser.version].filter(Boolean).join(' ') || null,
    os: [os.name, os.version].filter(Boolean).join(' ') || null,
  };
}

function extractTrackingParams(req) {
  const params = normalizeParams(req.query || {});
  const sourceId = parseInteger(pickParam(params, ['source_id', 'traffic_source_id']));

  const tracking = {
    source_id: sourceId,
    external_id: pickParam(params, ['external_id', 'externalid', 'clickid', 'click_id', 'fbclid', 'gclid', 'ttclid']),
    source: pickParam(params, ['source', 'src', 'utm_source']),
    keyword: pickParam(params, ['keyword', 'kw', 'utm_term']),
    ad_campaign_id: pickParam(params, ['ad_campaign_id', 'campaign_id', 'utm_campaign', 'adcampaignid']),
    creative_id: pickParam(params, ['creative_id', 'creative', 'ad_id', 'adid']),
    cost: parseDecimal(pickParam(params, ['cost', 'cpc', 'price'])),
    currency: pickParam(params, ['currency', 'currency_code', 'cur']),
    params,
  };

  for (let index = 1; index <= 10; index += 1) {
    tracking[`sub_id_${index}`] = pickParam(params, [`sub_id_${index}`, `subid${index}`, `sub${index}`]);
  }

  return tracking;
}

async function isUniqueClick(pool, campaignId, ip, userAgent) {
  try {
    const result = await pool.query(
      `SELECT 1
       FROM tds_clicks
       WHERE campaign_id = $1
         AND ip = $2
         AND user_agent = $3
         AND created_at >= NOW() - INTERVAL '24 hours'
       LIMIT 1`,
      [campaignId, ip, userAgent]
    );

    return result.rows.length === 0;
  } catch (error) {
    console.error('Unique click check error:', error);
    return true;
  }
}

async function resolveSourceId(pool, sourceId) {
  if (!sourceId) return null;

  try {
    const result = await pool.query('SELECT id FROM tds_traffic_sources WHERE id = $1 LIMIT 1', [sourceId]);
    return result.rows[0]?.id || null;
  } catch (error) {
    console.error('Traffic source lookup error:', error);
    return null;
  }
}

async function recordClick(pool, data) {
  await pool.query(
    `INSERT INTO tds_clicks (
       campaign_id,
       click_id,
       offer_id,
       source_id,
       country_code,
       ip,
       user_agent,
       device_type,
       is_bot,
       redirect_url,
       external_id,
       source,
       keyword,
       ad_campaign_id,
       creative_id,
       cost,
       currency,
       sub_id_1,
       sub_id_2,
       sub_id_3,
       sub_id_4,
       sub_id_5,
       sub_id_6,
       sub_id_7,
       sub_id_8,
       sub_id_9,
       sub_id_10,
       referrer,
       browser,
       os,
       language,
       city,
       region,
       is_unique,
       params
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
       $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
       $31, $32, $33, $34, $35
     )`,
    [
      data.campaign_id,
      data.click_id,
      data.offer_id,
      data.source_id,
      data.country_code,
      data.ip,
      data.user_agent,
      data.device_type,
      data.is_bot,
      data.redirect_url,
      data.external_id,
      data.source,
      data.keyword,
      data.ad_campaign_id,
      data.creative_id,
      data.cost,
      data.currency,
      data.sub_id_1,
      data.sub_id_2,
      data.sub_id_3,
      data.sub_id_4,
      data.sub_id_5,
      data.sub_id_6,
      data.sub_id_7,
      data.sub_id_8,
      data.sub_id_9,
      data.sub_id_10,
      data.referrer,
      data.browser,
      data.os,
      data.language,
      data.city,
      data.region,
      data.is_unique,
      JSON.stringify(data.params || {}),
    ]
  );
}

function normalizeStatus(value) {
  return scalar(value || 'lead')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .slice(0, 60) || 'lead';
}

async function upsertConversion(pool, payload, click) {
  const statusRaw = pickParam(payload, ['status', 'event', 'action'], 'lead');
  const status = normalizeStatus(statusRaw);
  const payout = parseDecimal(pickParam(payload, ['payout', 'revenue', 'sum', 'amount'])) || 0;
  const currency = pickParam(payload, ['currency', 'currency_code', 'cur']);
  const tid = pickParam(payload, ['tid', 'transaction_id', 'txid', 'order_id'], '');
  const raw = JSON.stringify(payload);

  const params = [
    click.click_id,
    click.campaign_id,
    click.offer_id,
    status,
    statusRaw,
    payout,
    currency ? currency.toUpperCase().slice(0, 12) : null,
    tid,
    raw,
  ];

  const result = await pool.query(
    `WITH updated AS (
       UPDATE tds_conversions
       SET campaign_id = $2,
           offer_id = $3,
           original_status = $5,
           payout = $6,
           currency = $7,
           raw = $9::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE click_id = $1
         AND status = $4
         AND COALESCE(tid, '') = COALESCE($8, '')
       RETURNING *
     ),
     inserted AS (
       INSERT INTO tds_conversions (
         click_id,
         campaign_id,
         offer_id,
         status,
         original_status,
         payout,
         currency,
         tid,
         raw
       )
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb
       WHERE NOT EXISTS (SELECT 1 FROM updated)
       ON CONFLICT DO NOTHING
       RETURNING *
     )
     SELECT * FROM updated
     UNION ALL
     SELECT * FROM inserted`,
    params
  );

  if (result.rows.length) return result.rows[0];

  const fallback = await pool.query(
    `SELECT *
     FROM tds_conversions
     WHERE click_id = $1
       AND status = $2
       AND COALESCE(tid, '') = COALESCE($3, '')
     LIMIT 1`,
    [click.click_id, status, tid]
  );

  return fallback.rows[0];
}

function buildPublicRoutes(pool) {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({ success: true, service: 'geo-tds-tracker' });
  });

  router.all('/postback', async (req, res) => {
    try {
      const payload = normalizeParams({ ...(req.query || {}), ...(req.body || {}) });
      const clickId = pickParam(payload, ['subid', 'click_id', 'sub_id', 'cid']);

      if (!clickId) {
        return res.status(400).json({ success: false, error: 'Missing subid or click_id' });
      }

      const clickResult = await pool.query(
        `SELECT click_id, campaign_id, offer_id
         FROM tds_clicks
         WHERE click_id = $1
         LIMIT 1`,
        [clickId]
      );

      if (!clickResult.rows.length) {
        return res.status(404).json({ success: false, error: 'Click not found' });
      }

      const conversion = await upsertConversion(pool, payload, clickResult.rows[0]);
      return res.json({ success: true, conversion });
    } catch (error) {
      console.error('Postback error:', error);
      return res.status(500).json({ success: false, error: 'Failed to process postback' });
    }
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

      const ua = scalar(req.headers['user-agent']);
      const detectedBot = isBot(ua, req.headers);
      if (campaign.block_bots && detectedBot) {
        return res.status(404).send('Link not found');
      }

      let limitReached = false;
      if (campaign.click_limit) {
        const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM tds_clicks WHERE campaign_id = $1', [campaign.id]);
        if (countResult.rows[0].count >= campaign.click_limit) {
          limitReached = true;
        }
      }

      const clickId = crypto.randomUUID();
      const normalizedIp = getClientIp(req);
      const geo = geoip.lookup(normalizedIp);
      const countryCode = geo?.country || null;
      const deviceType = detectDevice(ua);
      const tracking = extractTrackingParams(req);
      tracking.source_id = await resolveSourceId(pool, tracking.source_id);
      const { browser, os } = extractUserAgentDetails(ua);
      const referrer = scalar(req.headers.referer || req.headers.referrer, null);
      const uniqueClick = await isUniqueClick(pool, campaign.id, normalizedIp, ua);

      const selectedRedirect = limitReached
        ? { redirectUrl: campaign.default_url, offerId: null }
        : await selectRedirectUrl(pool, campaign, countryCode, deviceType);
      const { redirectUrl: rawRedirectUrl, offerId } = selectedRedirect;
      const redirectUrl = applyRedirectMacros(rawRedirectUrl, {
        ...tracking,
        click_id: clickId,
        campaign_id: campaign.id,
        campaign: campaign.slug,
        offer_id: offerId,
        country: countryCode,
        device: deviceType,
      });

      recordClick(pool, {
        ...tracking,
        campaign_id: campaign.id,
        click_id: clickId,
        offer_id: offerId,
        country_code: countryCode,
        ip: normalizedIp,
        user_agent: ua,
        device_type: deviceType,
        is_bot: detectedBot,
        redirect_url: redirectUrl,
        referrer,
        browser,
        os,
        language: extractLanguage(req),
        city: geo?.city || null,
        region: geo?.region || null,
        is_unique: uniqueClick,
      }).catch((error) => {
        console.error('Click insert error:', error);
      });

      return res.redirect(302, redirectUrl);
    } catch (error) {
      console.error('Redirect error:', error);
      return res.status(500).send('Internal error');
    }
  });

  return router;
}

module.exports = { buildPublicRoutes };
