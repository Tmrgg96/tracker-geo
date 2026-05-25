function adminAuth(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    return res.status(500).json({ success: false, error: 'ADMIN_TOKEN is not configured' });
  }

  const auth = req.headers.authorization || '';
  const prefix = 'Bearer ';
  if (!auth.startsWith(prefix)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const incoming = auth.slice(prefix.length).trim();
  if (incoming !== token) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  next();
}

module.exports = { adminAuth };
