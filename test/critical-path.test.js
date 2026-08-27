const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');

const { adminAuth, parseBasicAuth } = require('../src/middleware/adminAuth');
const { buildPublicRoutes, getClientIp } = require('../src/routes/publicRoutes');
const { createApp } = require('../src/server');

test('getClientIp uses Express trusted proxy result, not a raw forwarded header', () => {
  const request = {
    ip: '8.8.8.8',
    headers: { 'x-forwarded-for': '203.0.113.10' },
    socket: { remoteAddress: '127.0.0.1' },
  };

  assert.equal(getClientIp(request), '8.8.8.8');
});

test('Basic auth parser keeps colons inside the password', () => {
  const header = `Basic ${Buffer.from('operator:pass:word').toString('base64')}`;
  assert.deepEqual(parseBasicAuth(header), { username: 'operator', password: 'pass:word' });
});

test('adminAuth accepts configured credentials and rejects missing credentials', () => {
  const previousUsername = process.env.ADMIN_USERNAME;
  const previousPassword = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_USERNAME = 'operator';
  process.env.ADMIN_PASSWORD = 'secret';

  try {
    let nextCalled = false;
    const acceptedResponse = mockResponse();
    adminAuth(
      {
        headers: { authorization: `Basic ${Buffer.from('operator:secret').toString('base64')}` },
        originalUrl: '/api/admin/me',
      },
      acceptedResponse,
      () => { nextCalled = true; }
    );
    assert.equal(nextCalled, true);

    const rejectedResponse = mockResponse();
    adminAuth({ headers: {}, originalUrl: '/api/admin/me' }, rejectedResponse, () => {});
    assert.equal(rejectedResponse.statusCode, 401);
    assert.equal(rejectedResponse.headers['WWW-Authenticate'], 'Basic realm="Geo TDS Admin", charset="UTF-8"');
  } finally {
    restoreEnv('ADMIN_USERNAME', previousUsername);
    restoreEnv('ADMIN_PASSWORD', previousPassword);
  }
});

test('admin HTML and API cannot bypass Basic auth through static files', async () => {
  const previousUsername = process.env.ADMIN_USERNAME;
  const previousPassword = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_USERNAME = 'operator';
  process.env.ADMIN_PASSWORD = 'secret';

  const pool = {
    async query(sql) {
      if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
      throw new Error(`Unexpected SQL in auth test: ${sql.slice(0, 80)}`);
    },
  };
  const server = http.createServer(createApp(pool));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const path of ['/admin/', '/admin/index.html', '/api/admin/me']) {
      const response = await fetch(`${origin}${path}`, { redirect: 'manual' });
      assert.equal(response.status, 401, path);
    }

    const authorization = `Basic ${Buffer.from('operator:secret').toString('base64')}`;
    const adminResponse = await fetch(`${origin}/admin/`, { headers: { authorization } });
    assert.equal(adminResponse.status, 200);
    assert.match(await adminResponse.text(), /Geo TDS Tracker/);

    const apiResponse = await fetch(`${origin}/api/admin/me`, { headers: { authorization } });
    assert.equal(apiResponse.status, 200);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    restoreEnv('ADMIN_USERNAME', previousUsername);
    restoreEnv('ADMIN_PASSWORD', previousPassword);
  }
});

test('GET /go routes a trusted US proxy IP to the US rule and records it before redirecting', async () => {
  const inserts = [];
  const pool = {
    async query(sql, params = []) {
      if (sql.includes('SELECT * FROM tds_campaigns')) {
        return {
          rows: [{
            id: 13,
            name: 'US test',
            slug: 'us-test',
            default_url: 'https://offer.example/default',
            click_limit: null,
            start_date: null,
            end_date: null,
            block_bots: false,
            is_active: true,
          }],
        };
      }
      if (sql.includes('SELECT 1') && sql.includes('FROM tds_clicks')) return { rows: [] };
      if (sql.includes('FROM tds_campaign_links')) {
        assert.equal(params[1], 'US');
        return {
          rows: [{
            id: 1,
            url: 'https://offer.example/us',
            weight: 100,
            country_code: 'US',
            device_type: 'all',
            offer_id: 7,
            offer_name: 'US offer',
          }],
        };
      }
      if (sql.includes('INSERT INTO tds_clicks')) {
        inserts.push(params);
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in test: ${sql.slice(0, 80)}`);
    },
  };

  const app = express();
  app.set('trust proxy', 1);
  app.use(buildPublicRoutes(pool));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/go/us-test`, {
      redirect: 'manual',
      headers: {
        'user-agent': 'Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36',
        'x-forwarded-for': '8.8.8.8',
      },
    });

    assert.equal(response.status, 302);
    const location = response.headers.get('location');
    assert.match(location, /^https:\/\/offer\.example\/us\?subid=/);
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0][4], 'US');
    assert.equal(inserts[0][5], '8.8.8.8');
    assert.equal(inserts[0][9], location);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

function mockResponse() {
  return {
    headers: {},
    statusCode: 200,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
    send(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
