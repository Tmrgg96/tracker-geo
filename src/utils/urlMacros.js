function safeValue(value, fallback = '') {
  if (Array.isArray(value)) return safeValue(value[0], fallback);
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function hasClickMacro(url) {
  return /\{\s*(click_id|subid)\s*\}/i.test(String(url || ''));
}

function replaceMacros(url, data = {}) {
  let output = String(url || '');
  const macros = {
    click_id: data.click_id,
    subid: data.click_id,
    campaign_id: data.campaign_id,
    campaign: data.campaign,
    offer_id: data.offer_id,
    country: data.country,
    device: data.device,
    source: data.source,
    external_id: data.external_id,
    cost: data.cost,
  };

  for (let i = 1; i <= 10; i += 1) {
    macros[`sub_id_${i}`] = data[`sub_id_${i}`];
  }

  for (const [key, value] of Object.entries(macros)) {
    output = output.replace(new RegExp(`\\{\\s*${key}\\s*\\}`, 'gi'), encodeURIComponent(safeValue(value)));
  }

  return output;
}

function appendClickIdIfNeeded(rawUrl, clickId) {
  if (!rawUrl || !clickId || hasClickMacro(rawUrl)) return rawUrl;

  try {
    const url = new URL(rawUrl);
    if (!url.searchParams.has('subid') && !url.searchParams.has('click_id')) {
      url.searchParams.set('subid', clickId);
    }
    return url.toString();
  } catch (_error) {
    const [base, hash = ''] = String(rawUrl).split('#');
    const [path, query = ''] = base.split('?');
    const params = new URLSearchParams(query);
    if (!params.has('subid') && !params.has('click_id')) {
      params.set('subid', clickId);
    }
    const nextQuery = params.toString();
    return `${path}${nextQuery ? `?${nextQuery}` : ''}${hash ? `#${hash}` : ''}`;
  }
}

function buildRedirectUrl(rawUrl, data = {}) {
  const withClickId = appendClickIdIfNeeded(rawUrl, data.click_id);
  return replaceMacros(withClickId, data);
}

module.exports = {
  applyRedirectMacros: buildRedirectUrl,
  scalar: safeValue,
  buildRedirectUrl,
  replaceMacros,
  appendClickIdIfNeeded,
  hasClickMacro,
};
