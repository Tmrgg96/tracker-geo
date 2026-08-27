const crypto = require('crypto');

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''));
  const expectedBuffer = Buffer.from(String(expected || ''));
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function parseBasicAuth(header) {
  const match = /^Basic\s+(.+)$/i.exec(String(header || ''));
  if (!match) return null;

  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch (_error) {
    return null;
  }
}

function adminAuth(req, res, next) {
  const expectedUsername = process.env.ADMIN_USERNAME;
  const expectedPassword = process.env.ADMIN_PASSWORD;

  if (!expectedUsername || !expectedPassword) {
    console.error('Admin access is disabled: ADMIN_USERNAME and ADMIN_PASSWORD are required');
    return res.status(503).json({ success: false, error: 'Admin access is not configured' });
  }

  const credentials = parseBasicAuth(req.headers.authorization);
  if (
    credentials &&
    safeEqual(credentials.username, expectedUsername) &&
    safeEqual(credentials.password, expectedPassword)
  ) {
    res.set('Cache-Control', 'no-store');
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Geo TDS Admin", charset="UTF-8"');
  res.set('Cache-Control', 'no-store');
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }
  return res.status(401).send('Authentication required');
}

module.exports = { adminAuth, parseBasicAuth, safeEqual };
