const UAParser = require('ua-parser-js');

function detectDevice(userAgent = '') {
  const parser = new UAParser(userAgent);
  const type = parser.getDevice().type;

  if (type === 'mobile') return 'mobile';
  if (type === 'tablet') return 'tablet';
  return 'desktop';
}

module.exports = { detectDevice };
