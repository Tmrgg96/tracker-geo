const VPN_GATE_PARAM = '__vpn_checked';

function isVpnGateConfirmed(req) {
  const value = req.query?.[VPN_GATE_PARAM];
  return Array.isArray(value) ? value.includes('1') : String(value || '') === '1';
}

function buildVpnGateContinueUrl(req) {
  const target = new URL(req.originalUrl || req.url, 'https://tracker.local');
  target.searchParams.set(VPN_GATE_PARAM, '1');
  return `${target.pathname}${target.search}`;
}

function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[character]));
}

function renderVpnGatePage(continueUrl) {
  const safeContinueUrl = escapeAttribute(continueUrl);

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <meta name="theme-color" content="#eef6ff">
  <title>Проверка подключения</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #1b2b40;
      --muted: #64778f;
      --surface: #ffffff;
      --surface-strong: #eaf4ff;
      --line: #d5e3f2;
      --blue: #4d86c6;
      --blue-strong: #2f6eae;
      --blue-soft: #cfe5fb;
      --shadow: 0 28px 80px rgba(45, 88, 132, .17);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-width: 320px;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      color: var(--ink);
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at 18% 12%, rgba(126, 181, 233, .28), transparent 28rem),
        radial-gradient(circle at 90% 88%, rgba(190, 219, 248, .34), transparent 24rem),
        linear-gradient(rgba(64, 116, 169, .04) 1px, transparent 1px),
        linear-gradient(90deg, rgba(64, 116, 169, .04) 1px, transparent 1px),
        #f5f9fe;
      background-size: auto, auto, 32px 32px, 32px 32px, auto;
    }

    .shell {
      width: min(100%, 760px);
      display: grid;
      grid-template-columns: 1fr .78fr;
      border: 1px solid var(--line);
      border-radius: 26px;
      overflow: hidden;
      background: rgba(255, 255, 255, .96);
      box-shadow: var(--shadow);
      backdrop-filter: blur(18px);
      animation: arrive .45s cubic-bezier(.2, .8, .2, 1) both;
    }

    .main { padding: clamp(28px, 6vw, 54px); }

    .visual {
      min-height: 100%;
      padding: 32px;
      position: relative;
      display: grid;
      place-items: center;
      border-left: 1px solid var(--line);
      background:
        linear-gradient(145deg, rgba(255, 255, 255, .72), transparent 54%),
        var(--surface-strong);
      overflow: hidden;
    }

    .visual::before, .visual::after {
      content: "";
      position: absolute;
      border: 1px solid rgba(77, 134, 198, .22);
      border-radius: 50%;
    }

    .visual::before { width: 260px; height: 260px; }
    .visual::after { width: 190px; height: 190px; }

    .signal {
      width: 116px;
      height: 116px;
      position: relative;
      z-index: 1;
      display: grid;
      place-items: center;
      color: #ffffff;
      border-radius: 34px 34px 34px 12px;
      background: var(--blue);
      box-shadow: 0 22px 50px rgba(77, 134, 198, .24);
      transform: rotate(-4deg);
    }

    .signal svg { width: 56px; height: 56px; stroke-width: 1.8; }

    .eyebrow {
      margin: 0 0 18px;
      color: var(--blue-strong);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: .14em;
      text-transform: uppercase;
    }

    h1 {
      margin: 0;
      max-width: 480px;
      font-size: clamp(34px, 7vw, 58px);
      line-height: .98;
      letter-spacing: -.055em;
    }

    .lead {
      margin: 20px 0 0;
      max-width: 520px;
      color: var(--muted);
      font-size: 16px;
      line-height: 1.6;
    }

    .steps {
      margin: 28px 0;
      padding: 0;
      display: grid;
      gap: 11px;
      list-style: none;
      counter-reset: steps;
    }

    .steps li {
      display: flex;
      align-items: center;
      gap: 11px;
      color: #344a64;
      font-size: 14px;
      counter-increment: steps;
    }

    .steps li::before {
      content: counter(steps);
      width: 27px;
      height: 27px;
      flex: 0 0 auto;
      display: grid;
      place-items: center;
      border: 1px solid var(--line);
      border-radius: 9px;
      color: var(--blue-strong);
      background: #f7fbff;
      font-size: 12px;
      font-weight: 800;
    }

    .continue {
      width: 100%;
      min-height: 56px;
      padding: 0 20px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      border-radius: 15px;
      color: #ffffff;
      background: var(--blue);
      font-size: 15px;
      font-weight: 850;
      text-decoration: none;
      box-shadow: 0 14px 32px rgba(77, 134, 198, .22);
      transition: background-color .18s ease, box-shadow .18s ease;
    }

    .continue:hover { background: var(--blue-strong); box-shadow: 0 18px 38px rgba(77, 134, 198, .28); }
    .continue:focus-visible { outline: 3px solid rgba(77, 134, 198, .28); outline-offset: 3px; }
    .continue[aria-busy="true"] { color: #f1f7fd; background: #7ea7d2; pointer-events: none; }

    .note { margin: 14px 0 0; color: #7a8da3; font-size: 12px; line-height: 1.5; text-align: center; }

    @keyframes arrive {
      from { opacity: 0; transform: translateY(12px) scale(.99); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    @media (max-width: 700px) {
      body { padding: 12px; }
      .shell { grid-template-columns: 1fr; border-radius: 20px; }
      .main { padding: 30px 22px 26px; }
      .visual { min-height: 150px; order: -1; border-left: 0; border-bottom: 1px solid var(--line); }
      .visual::before { width: 190px; height: 190px; }
      .visual::after { width: 135px; height: 135px; }
      .signal { width: 84px; height: 84px; border-radius: 25px 25px 25px 9px; }
      .signal svg { width: 40px; height: 40px; }
      h1 { font-size: clamp(34px, 11vw, 48px); }
      .lead { font-size: 15px; }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; transition: none !important; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="main">
      <p class="eyebrow">Доступ к бонусу</p>
      <h1>Если вы из России, отключите VPN</h1>
      <p class="lead">Отключите VPN для получения бонуса. С включённым VPN сервис работать не будет.</p>
      <ol class="steps">
        <li>Выключите VPN или прокси</li>
        <li>Подождите пару секунд</li>
        <li>Нажмите кнопку ниже</li>
      </ol>
      <a class="continue" id="continueButton" href="${safeContinueUrl}">
        <span id="buttonLabel">VPN выключен, продолжить</span>
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
      </a>
      <p class="note">Если VPN уже выключен, просто нажмите кнопку.</p>
    </section>
    <aside class="visual" aria-hidden="true">
      <div class="signal">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg>
      </div>
    </aside>
  </main>
  <script>
    const button = document.getElementById('continueButton');
    const label = document.getElementById('buttonLabel');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      if (button.getAttribute('aria-busy') === 'true') return;
      button.setAttribute('aria-busy', 'true');
      label.textContent = 'Открываем предложение...';
      window.setTimeout(() => window.location.assign(button.href), 850);
    });
  </script>
</body>
</html>`;
}

function sendVpnGatePage(req, res) {
  return res
    .status(200)
    .set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'Referrer-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    })
    .type('html')
    .send(renderVpnGatePage(buildVpnGateContinueUrl(req)));
}

module.exports = {
  VPN_GATE_PARAM,
  buildVpnGateContinueUrl,
  isVpnGateConfirmed,
  renderVpnGatePage,
  sendVpnGatePage,
};
