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

function pickWeightedRow(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const totalWeight = candidates.reduce((acc, row) => acc + Math.max(Number(row.weight) || 100, 1), 0);
  let random = Math.random() * totalWeight;

  for (const row of candidates) {
    random -= Math.max(Number(row.weight) || 100, 1);
    if (random <= 0) return row;
  }

  return candidates[candidates.length - 1];
}

function pickWeightedUrl(candidates) {
  return pickWeightedRow(candidates)?.url || null;
}

async function findMatchingLinks(pool, campaignId, countryCode, deviceType) {
  const normalizedCountry = normalizeCountryCode(countryCode);
  const normalizedDevice = normalizeDeviceType(deviceType);
  const selectSql = `
    SELECT
      l.id,
      COALESCE(NULLIF(o.url, ''), l.url) AS url,
      l.weight,
      l.country_code,
      l.device_type,
      l.offer_id,
      o.name AS offer_name
    FROM tds_campaign_links l
    LEFT JOIN tds_offers o ON o.id = l.offer_id
    WHERE l.campaign_id = $1
      AND l.country_code = $2
      AND (l.device_type = $3 OR l.device_type = 'all')
      AND (l.offer_id IS NULL OR COALESCE(o.is_active, true) = true)
    ORDER BY CASE WHEN l.device_type = $3 THEN 0 ELSE 1 END, l.id ASC
  `;

  if (normalizedCountry && normalizedCountry !== FALLBACK_COUNTRY) {
    const exactResult = await pool.query(selectSql, [campaignId, normalizedCountry, normalizedDevice]);
    if (exactResult.rows.length) return exactResult.rows;
  }

  const fallbackResult = await pool.query(selectSql, [campaignId, FALLBACK_COUNTRY, normalizedDevice]);
  return fallbackResult.rows;
}

async function selectRedirectUrl(pool, campaign, countryCode, deviceType) {
  const candidates = await findMatchingLinks(pool, campaign.id, countryCode, deviceType);
  const selected = pickWeightedRow(candidates);
  return {
    redirectUrl: selected?.url || campaign.default_url,
    matchedLinks: candidates,
    selectedLink: selected || null,
    offerId: selected?.offer_id || null,
  };
}

module.exports = {
  FALLBACK_COUNTRY,
  normalizeCountryCode,
  normalizeDeviceType,
  pickWeightedRow,
  pickWeightedUrl,
  findMatchingLinks,
  selectRedirectUrl,
};
