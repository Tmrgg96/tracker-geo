function isBot(userAgent = '', headers = {}) {
  const ua = String(userAgent || '').toLowerCase();
  if (!ua) return true;

  if (/(bot|spider|crawler|facebookexternalhit|facebot|preview|slurp|bingpreview|curl|wget|headless|python-requests|go-http-client|axios|httpclient|uptime|monitor|validator|lighthouse|slackbot|discordbot|telegrambot|twitterbot|linkedinbot|whatsapp|bytespider|semrush|ahrefs|mj12bot)/i.test(ua)) {
    return true;
  }

  const purpose = String(headers.purpose || headers['x-purpose'] || headers['x-moz'] || '').toLowerCase();
  if (purpose.includes('preview') || purpose.includes('prefetch')) return true;

  const forwardedUserAgent = String(headers['x-forwarded-user-agent'] || '').toLowerCase();
  return /(facebookexternalhit|facebot|telegrambot|slackbot|discordbot|twitterbot|linkedinbot|whatsapp)/i.test(forwardedUserAgent);
}

function hasProxyHeaders(headers = {}) {
  return Boolean(
    headers.via ||
    headers.forwarded ||
    headers['x-forwarded-host'] ||
    headers['x-proxy-id'] ||
    headers['proxy-connection'] ||
    headers['x-real-ip']
  );
}

module.exports = { isBot, hasProxyHeaders };
