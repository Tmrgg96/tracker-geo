function isBot(userAgent = '') {
  const ua = userAgent.toLowerCase();
  return /(bot|spider|crawler|facebookexternalhit|preview|curl|wget|headless|python-requests)/i.test(ua);
}

module.exports = { isBot };
