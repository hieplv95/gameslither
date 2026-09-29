'use strict';
// Dựng trang chủ cho từng ngôn ngữ từ 1 khung chung + file bản dịch trong locales/.
// Kết quả còn các chỗ trống {{SITE_URL}}, {{SEO_*}}, {{GSC_META}} và khối <!--PAID-->…<!--/PAID-->,
// server.js điền/gỡ khi trả trang.
const LOCALES = require('./locales');

const SITE_UPDATED = '2026-09-30';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Chuỗi trong file bản dịch có thể chứa HTML đơn giản (<b>, <strong>, <em>, <kbd>) do chính mình viết → chèn thẳng.
const paid = html => `<!--PAID-->${html}<!--/PAID-->`;
const jsonForScript = obj => JSON.stringify(obj).replace(/</g, '\\u003c');
const stripTags = s => String(s).replace(/<[^>]+>/g, '');

function langLinks(current, cls) {
  return LOCALES.map(l => `<a href="${l.path}" hreflang="${l.hreflang}" lang="${l.htmlLang}"${l.code === current.code ? ' aria-current="page"' : ''}${cls ? ` class="${cls}"` : ''}>${esc(l.name)}</a>`).join('\n          ');
}

function jsonLd(L) {
  const t = L.t, url = `{{SITE_URL}}${L.path}`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Organization', '@id': '{{SITE_URL}}/#org', name: 'GameSlither', url: '{{SITE_URL}}/', logo: '{{SITE_URL}}/favicon.svg' },
      { '@type': 'WebSite', '@id': '{{SITE_URL}}/#website', name: 'GameSlither', url: '{{SITE_URL}}/',
        inLanguage: LOCALES.map(l => l.htmlLang), publisher: { '@id': '{{SITE_URL}}/#org' } },
      { '@type': 'WebPage', '@id': `${url}#webpage`, url, name: stripTags(t.h1), inLanguage: L.htmlLang,
        isPartOf: { '@id': '{{SITE_URL}}/#website' }, about: { '@id': '{{SITE_URL}}/#game' }, dateModified: SITE_UPDATED },
      { '@type': 'VideoGame', '@id': '{{SITE_URL}}/#game', name: 'GameSlither', url: '{{SITE_URL}}/',
        description: stripTags(t.gameDesc), genre: ['Multiplayer online game', '.io game', 'Snake game', 'Arcade'],
        gamePlatform: ['Web browser', 'Desktop', 'Mobile', 'Tablet'], operatingSystem: 'Any (web browser)',
        applicationCategory: 'GameApplication', playMode: 'MultiPlayer',
        numberOfPlayers: { '@type': 'QuantitativeValue', minValue: 1, maxValue: 50 }, isAccessibleForFree: true,
        inLanguage: LOCALES.map(l => l.htmlLang), publisher: { '@id': '{{SITE_URL}}/#org' },
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', availability: 'https://schema.org/InStock' } },
      { '@type': 'HowTo', name: stripTags(t.howTitle), inLanguage: L.htmlLang,
        step: t.steps.map(([name, text], i) => ({ '@type': 'HowToStep', position: i + 1, name: stripTags(name), text: stripTags(text) })) },
      { '@type': 'FAQPage', inLanguage: L.htmlLang,
        mainEntity: t.faq.map(([q, a]) => ({ '@type': 'Question', name: stripTags(q), acceptedAnswer: { '@type': 'Answer', text: stripTags(a) } })) },
    ],
  };
}

function render(L) {
  const t = L.t;
  const updated = new Intl.DateTimeFormat(L.numLocale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(SITE_UPDATED + 'T00:00:00Z'));
  const alternates = LOCALES.map(l => `<link rel="alternate" hreflang="${l.hreflang}" href="{{SITE_URL}}${l.path}">`).join('\n  ');
  const ogAlt = LOCALES.filter(l => l !== L).map(l => `<meta property="og:locale:alternate" content="${l.ogLocale}">`).join('\n  ');
  const ui = { ...LOCALES[0].ui, ...L.ui };

  return `<!doctype html>
<html lang="${L.htmlLang}" dir="${L.dir}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>{{SEO_TITLE}}</title>
  <meta name="description" content="{{SEO_DESCRIPTION}}">
  <meta name="keywords" content="{{SEO_KEYWORDS}}">
  {{GSC_META}}
  <link rel="canonical" href="{{SITE_URL}}${L.path}">
  ${alternates}
  <link rel="alternate" hreflang="x-default" href="{{SITE_URL}}/">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
  <meta name="theme-color" content="#0b0f14">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="GameSlither">
  <meta property="og:locale" content="${L.ogLocale}">
  ${ogAlt}
  <meta property="og:url" content="{{SITE_URL}}${L.path}">
  <meta property="og:title" content="{{SEO_TITLE}}">
  <meta property="og:description" content="{{SEO_DESCRIPTION}}">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="{{SEO_TITLE}}">
  <meta name="twitter:description" content="{{SEO_DESCRIPTION}}">
  <script type="application/ld+json">${jsonForScript(jsonLd(L))}</script>
  <script>window.I18N_DICT = ${jsonForScript(ui)};</script>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <a class="skip" href="#about">${esc(t.skip)}</a>

  <header class="site-header">
    <div class="container header-inner">
      <a class="brand" href="${L.path}" aria-label="${esc(t.homeAria)}">
        <img src="/favicon.svg" alt="" width="30" height="30">
        <span>Game<b>Slither</b></span>
      </a>
      <button class="nav-toggle" id="navToggle" aria-expanded="false" aria-controls="siteNav" aria-label="${esc(t.openMenu)}">☰</button>
      <nav id="siteNav" class="site-nav" aria-label="${esc(t.mainNav)}">
        <a href="#game-area">${t.nav[0]}</a>
        <a href="#how-to-play">${t.nav[1]}</a>
        <a href="#vs-slither-io">${t.nav[2]}</a>
        <a href="#snake-skins">${t.nav[3]}</a>
        <a href="#faq">${t.nav[4]}</a>
        <details class="lang-menu">
          <summary aria-label="${esc(t.langMenu)}">🌐 ${esc(L.name)}</summary>
          <div class="lang-list">
          ${langLinks(L)}
          </div>
        </details>
      </nav>
    </div>
  </header>

  <main>
    <section id="game-area" class="game-section" aria-label="${esc(t.gameAria)}">
      <div id="gameWrap" class="game-wrap" dir="ltr">
        <canvas id="game" aria-label="${esc(t.boardAria)}"></canvas>
        <button id="fullscreen" class="fs-btn" title="${esc(t.fullscreen)}" aria-label="${esc(t.fullscreen)}">⛶</button>

        <div id="hud" class="hidden">
          <div id="paidBar" class="hidden"></div>
          <div id="score"></div>
          <div id="lb">
            <div class="lb-title">${t.leaderboard}</div>
            <ol id="lbList"></ol>
            <div id="rank"></div>
          </div>
          <canvas id="minimap" width="140" height="140"></canvas>
          <button id="boostBtn" aria-label="${esc(t.boost)}">⚡</button>
        </div>

        <div id="menu" class="overlay">
          <div class="card wide" dir="${L.dir}">
            <div class="logo-big" dir="ltr">Game<span>Slither</span></div>
            <input id="name" maxlength="16" placeholder="${esc(t.nickname)}" autocomplete="off" spellcheck="false" aria-label="${esc(t.nickname)}">
            <div id="skins"></div>
            <div id="hues" class="hidden"></div>

            <div class="mode">
              <div class="mode-head"><div class="mode-title">🎮 ${t.freePlay}</div><span id="onlineInfo" class="muted"></span></div>
              <div class="row">
                <button id="play" class="btn">${t.playNow}</button>
                <button id="pickRoom" class="btn ghost">${t.pickRoom}</button>
              </div>
            </div>

            ${paid(`<div class="mode paid">
              <div class="mode-head">
                <div class="mode-title">💰 ${t.paidPlay}</div>
                <span class="balance">${t.balance}: <b id="balance">–</b> USDT</span>
              </div>
              <p class="muted small" id="paidRule"></p>
              <div id="tiers"></div>
              <div class="row small-btns">
                <button class="btn ghost sm" data-wallet="deposit">${t.deposit}</button>
                <button class="btn ghost sm" data-wallet="withdraw">${t.withdraw}</button>
                <button class="btn ghost sm" data-wallet="history">${t.history}</button>
              </div>
            </div>`)}

            <p class="help">${t.help}</p>
            <p id="status"></p>
          </div>
        </div>

        <div id="roomsModal" class="overlay hidden">
          <div class="card" dir="${L.dir}">
            <div class="card-title">${t.pickRoom}</div>
            <div id="roomList"></div>
            <div class="row">
              <input id="roomCode" maxlength="4" placeholder="${esc(t.roomCode)}" autocomplete="off" spellcheck="false" aria-label="${esc(t.roomCode)}">
              <button id="joinCode" class="btn sm">${t.join}</button>
            </div>
            <button id="createRoom" class="btn ghost">${t.createRoom}</button>
            <button class="link" data-close>${t.close}</button>
          </div>
        </div>

        ${paid(`<div id="walletModal" class="overlay hidden">
          <div class="card" dir="${L.dir}">
            <div class="card-title">${t.wallet}</div>
            <div class="tabs">
              <button data-tab="deposit">${t.deposit}</button>
              <button data-tab="withdraw">${t.withdraw}</button>
              <button data-tab="history">${t.history}</button>
            </div>
            <div data-pane="deposit">
              <div id="demoBox">
                <p class="warn">${t.testMode}</p>
                <button id="faucet" class="btn">${t.faucet}</button>
              </div>
              <p class="muted small">${t.realSoon}</p>
            </div>
            <div data-pane="withdraw">
              <input id="wdAmount" type="number" min="0" step="0.01" placeholder="${esc(t.amount)}" aria-label="${esc(t.amount)}">
              <input id="wdAddress" placeholder="${esc(t.address)}" autocomplete="off" spellcheck="false" aria-label="${esc(t.address)}">
              <button id="wdSubmit" class="btn">${t.requestWd}</button>
              <p class="muted small" id="wdNote"></p>
            </div>
            <div data-pane="history"><ul id="historyList"></ul></div>
            <button class="link" data-close>${t.close}</button>
          </div>
        </div>`)}

        ${paid(`<div id="queue" class="overlay hidden">
          <div class="card" dir="${L.dir}">
            <div class="card-title" id="qTitle"></div>
            <div id="qCount"></div>
            <div class="qbar"><div id="qFill"></div></div>
            <p id="qPrize"></p>
            <p id="qCountdown" class="warn"></p>
            <button id="qLeave" class="btn ghost">${t.leaveQueue}</button>
          </div>
        </div>`)}

        <div id="death" class="overlay hidden">
          <div class="card" dir="${L.dir}">
            <div class="card-title" id="deathTitle">${t.youDied}</div>
            <p id="deathText"></p>
            <button id="again" class="btn">${t.playAgain}</button>
            <button id="watch" class="btn ghost hidden">${t.keepWatching}</button>
            <button id="toMenu" class="link">${t.backLobby}</button>
          </div>
        </div>

        <div id="toast" class="hidden"></div>
      </div>
    </section>

    <article class="content container">
      <section id="about" class="intro">
        <h1>${t.h1}</h1>
        <p class="updated">${t.updatedLabel} <time datetime="${SITE_UPDATED}">${esc(updated)}</time></p>
        <p class="lead">${t.lead}</p>
        <ul class="highlights">
          ${t.highlights.map(([b, s]) => `<li><b>${b}</b><span>${s}</span></li>`).join('\n          ')}
        </ul>

        <h2 id="quick-facts">${t.factsTitle}</h2>
        <div class="facts-wrap">
          <table class="facts">
            <tbody>
              ${t.facts.map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`).join('\n              ')}
            </tbody>
          </table>
        </div>
      </section>

      <section id="how-to-play">
        <h2>${t.howTitle}</h2>
        <ol class="steps">
          ${t.steps.map(([h, p]) => `<li><h3>${h}</h3><p>${p}</p></li>`).join('\n          ')}
        </ol>
        <div class="keys">
          ${t.keys.map(k => `<div>${k}</div>`).join('\n          ')}
        </div>
      </section>

      <section id="modes">
        <h2>${t.modesTitle}</h2>
        <div class="modes-grid">
          <div class="mode-card">
            <h3>🎮 ${t.freeCard.h}</h3>
            <p>${t.freeCard.p}</p>
            <ul>${t.freeCard.items.map(i => `<li>${i}</li>`).join('')}</ul>
          </div>
          ${paid(`<div class="mode-card paid">
            <h3>💰 ${t.paidCard.h}</h3>
            <p>${t.paidCard.p}</p>
            <ul>${t.paidCard.items.map(i => `<li>${i}</li>`).join('')}</ul>
          </div>`)}
        </div>
      </section>

      <section id="vs-slither-io">
        <h2>${t.vsTitle}</h2>
        <p>${t.vsIntro}</p>
        <div class="compare">
          <div class="compare-col">
            <h3>${t.sameTitle}</h3>
            <ul>${t.same.map(i => `<li>${i}</li>`).join('')}</ul>
          </div>
          <div class="compare-col">
            <h3>${t.addsTitle}</h3>
            <ul>${t.adds.map(i => `<li>${i}</li>`).join('')}</ul>
          </div>
        </div>
        <p class="muted-note">${t.notAffiliated}</p>
      </section>

      <section id="snake-skins">
        <h2>${t.skinsTitle}</h2>
        <p>${t.skinsIntro}</p>
        <div class="skins-gallery" id="skinsGallery"></div>
      </section>

      <section id="tips">
        <h2>${t.tipsTitle}</h2>
        <ul class="tips">
          ${t.tips.map(([b, s]) => `<li><b>${b}</b> ${s}</li>`).join('\n          ')}
          ${paid(`<li><b>${t.paidTip[0]}</b> ${t.paidTip[1]}</li>`)}
        </ul>
      </section>

      <section id="faq">
        <h2>${t.faqTitle}</h2>
        ${t.faq.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join('\n        ')}
      </section>
    </article>
  </main>

  <footer class="site-footer">
    <div class="container footer-grid">
      <div class="footer-brand">
        <a class="brand" href="${L.path}"><img src="/favicon.svg" alt="" width="28" height="28"><span>Game<b>Slither</b></span></a>
        <p>${t.footerTagline}</p>
      </div>
      <nav aria-label="${esc(stripTags(t.footerGame))}">
        <div class="footer-title">${t.footerGame}</div>
        <a href="#game-area">${t.nav[0]}</a>
        <a href="#modes">${t.modesTitle}</a>
        <a href="#snake-skins">${t.nav[3]}</a>
      </nav>
      <nav aria-label="${esc(stripTags(t.footerGuide))}">
        <div class="footer-title">${t.footerGuide}</div>
        <a href="#how-to-play">${t.nav[1]}</a>
        <a href="#vs-slither-io">GameSlither vs Slither.io</a>
        <a href="#faq">${t.nav[4]}</a>
      </nav>
      ${paid(`<div class="footer-note">
        <div class="footer-title">${t.respTitle}</div>
        <p>${t.respText}</p>
      </div>`)}
    </div>
    <div class="container footer-langs">
      ${langLinks(L)}
    </div>
    <div class="container footer-bottom">© <span id="year">2026</span> GameSlither. ${t.rights}
      <p class="disclaimer">${t.disclaimer}</p></div>
  </footer>

  <script src="/i18n.js"></script>
  <script src="/skins.js"></script>
  <script src="/client.js"></script>
  <script src="/site.js"></script>
</body>
</html>
`;
}

// Dựng sẵn toàn bộ trang khi khởi động
const PAGES = new Map(LOCALES.map(L => [L.path, { lang: L.code, html: render(L) }]));

module.exports = { LOCALES, PAGES, SITE_UPDATED };
