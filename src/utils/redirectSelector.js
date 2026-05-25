const FALLBACK_COUNTRY = '*';
const DEVICE_TYPES = new Set(['all', 'desktop', 'mobile', 'tablet']);

function normalizeCountryCode(value = '') {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw || raw === 'ANY' || raw === 'ALL' || raw === FALLBACK_COUNTRY) return FALLBACK_COUNTRY;
  return /^[A-Z]{2}$/.test(raw) ? raw : '';
}

function normalizeDeviceType(value = 'all') {
  const raw = String(value || 'all').trim().toLowerCase();
  return DEVICE_TYPES.has(raw) ? raw : 'all';
}

function pickWeightedUrl(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].url;

  const totalWeight = candidates.reduce((acc, row) => acc + Math.max(Number(row.weight) || 100, 1), 0);
  let random = Math.random() * totalWeight;

  for (const row of candidates) {
    random -= Math.max(Number(row.weight) || 100, 1);
    if (random <= 0) return row.url;
  }

  return candidates[candidates.length - 1].url;
}

async function findMatchingLinks(pool, campaignId, countryCode, deviceType) {
  const normalizedCountry = normalizeCountryCode(countryCode);
  const normalizedDevice = normalizeDeviceType(deviceType);

  if (normalizedCountry && normalizedCountry !== FALLBACK_COUNTRY) {
    const exactResult = await pool.query(
      `SELECT url, weight, country_code, device_type
       FROM tds_campaign_links
       WHERE campaign_id = $1
         AND country_code = $2
         AND (device_type = $3 OR device_type = 'all')
       ORDER BY CASE WHEN device_type = $3 THEN 0 ELSE 1 END, id ASC`,
      [campaignId, normalizedCountry, normalizedDevice]
    );

    if (exactResult.rows.length) return exactResult.rows;
  }

  const fallbackResult = await pool.query(
    `SELECT url, weight, country_code, device_type
     FROM tds_campaign_links
     WHERE campaign_id = $1
       AND country_code = $2
       AND (device_type = $3 OR device_type = 'all')
     ORDER BY CASE WHEN device_type = $3 THEN 0 ELSE 1 END, id ASC`,
    [campaignId, FALLBACK_COUNTRY, normalizedDevice]
  );

  return fallbackResult.rows;
}

async function selectRedirectUrl(pool, campaign, countryCode, deviceType) {
  const candidates = await findMatchingLinks(pool, campaign.id, countryCode, deviceType);
  return {
    redirectUrl: pickWeightedUrl(candidates) || campaign.default_url,
    matchedLinks: candidates,
  };
}

module.exports = {
  FALLBACK_COUNTRY,
  normalizeCountryCode,
  normalizeDeviceType,
  pickWeightedUrl,
  findMatchingLinks,
  selectRedirectUrl,
};
