'use strict';
(function () {
  var $app = document.getElementById('app');
  var S = { exchanges: [], user: null, ex: lsGet('ex') || 'binance', market: lsGet('market') || 'futures', sort: { key: 'vol', dir: -1 }, filter: 'all', q: '' };
  var timers = [];      // intervals cleared on every view change
  var cleanups = [];    // functions run on every view change
  var viewId = 0;

  function lsGet(k) { try { return localStorage.getItem('ehsan_' + k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem('ehsan_' + k, v); } catch (e) { /* ignore */ } }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function every(fn, ms) { timers.push(setInterval(fn, ms)); }
  function resetView() { timers.forEach(clearInterval); timers = []; cleanups.forEach(function (f) { try { f(); } catch (e) { /* */ } }); cleanups = []; viewId++; }

  function api(path) {
    if (!S.user) { location.hash = '#/login'; return Promise.reject(new Error('login')); }
    var u = new URL(path, location.href);
    return Promise.resolve().then(function () { return window.EhsanCore.handle(u.pathname.replace(/^.*(\/api\/)/, '/api/'), u.searchParams); });
  }
  function b64(x) { var bin = atob(x), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  function checkLogin(user, pass) {
    if (!(window.crypto && crypto.subtle)) return Promise.reject(new Error('This page must be opened over https:// or http://localhost'));
    return fetch('users.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (users) {
      var rec = users.filter(function (u) { return String(u.user).toLowerCase() === String(user).trim().toLowerCase(); })[0];
      var salt = rec ? b64(rec.salt) : new Uint8Array(16);
      return crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']).then(function (k) {
        return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: rec ? rec.iter || 120000 : 120000 }, k, 256);
      }).then(function (bits) {
        if (!rec) return null;
        var got = new Uint8Array(bits), want = b64(rec.hash), diff = got.length ^ want.length;
        for (var i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
        return diff === 0 ? rec.user.toLowerCase() : null;
      });
    });
  }

  /* ---------- formatting ---------- */
  function fp(v) {
    if (v == null || isNaN(v)) return '—';
    var a = Math.abs(v);
    var d = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.1 ? 5 : a >= 0.01 ? 6 : 8;
    return v.toLocaleString('en-US', { minimumFractionDigits: d > 2 && a < 1000 ? Math.min(d, 4) : 2, maximumFractionDigits: d });
  }
  function compact(v) {
    if (v == null || isNaN(v)) return '—';
    var a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return v.toFixed(0);
  }
  function pct(v, d) { return v == null || isNaN(v) ? '—' : (v > 0 ? '+' : '') + v.toFixed(d == null ? 2 : d) + '%'; }
  function cls(v) { return v > 0 ? 'up' : v < 0 ? 'dn' : 'mut'; }
  function fundFmt(v) { return v == null ? '—' : (v * 100).toFixed(4) + '%'; }
  function base(pair) { return pair.split('/')[0]; }
  function logoSvg(sz) { return '<svg viewBox="0 0 64 64" width="' + sz + '" height="' + sz + '"><rect width="64" height="64" rx="14" fill="#181a20"/><path d="M14 46V22l9 14 9-20 9 20 9-14v24" fill="none" stroke="#f0b90b" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/></svg>'; }

  /* ---------- routing ---------- */
  window.addEventListener('hashchange', route);
  function route() {
    resetView();
    var h = location.hash.replace(/^#\/?/, '').split('/');
    if (!S.user) { try { S.user = sessionStorage.getItem('ehsan_user'); } catch (e) { /* */ } if (S.user) S.exchanges = window.EhsanCore.EXCHANGES_INFO(); }
    if (!S.user && h[0] !== 'login') { location.hash = '#/login'; return; }
    route2(h);
  }
  function route2(h) {
    if (h[0] === 'login') { if (S.user) { location.hash = '#/m'; return; } return loginView(); }
    if (h[0] === 'c' && h[3]) return detailView(h[1], h[2], decodeURIComponent(h[3]).replace('-', '/'));
    if (h[0] === 'm' && h[1]) { S.ex = h[1]; if (h[2]) S.market = h[2]; }
    marketsView();
  }
  function curEx() { return S.exchanges.filter(function (e) { return e.id === S.ex; })[0] || S.exchanges[0]; }

  /* ---------- login ---------- */
  function loginView() {
    $app.innerHTML = '<div class="login"><form id="lf"><div class="brand">' + logoSvg(34) + '<div>EHSAN <small>Crypto</small></div></div>' +
      '<input id="u" placeholder="Username" autocomplete="username" autofocus><input id="p" type="password" placeholder="Password" autocomplete="current-password">' +
      '<div class="err" id="e"></div><button class="btn" type="submit">Sign in</button></form></div>';
    document.getElementById('lf').onsubmit = function (ev) {
      ev.preventDefault();
      var e = document.getElementById('e'); e.textContent = '';
      var f = this, btn = f.querySelector('button'), pw = document.getElementById('p').value;
      btn.disabled = true;
      checkLogin(document.getElementById('u').value, pw).then(function (u) {
        btn.disabled = false;
        if (!u) { e.textContent = 'Wrong username or password'; return; }
        S.user = u; try { sessionStorage.setItem('ehsan_user', u); } catch (x) { /* */ }
        S.exchanges = window.EhsanCore.EXCHANGES_INFO(); location.hash = '#/m'; route();
      }).catch(function (x) { btn.disabled = false; e.textContent = x.message || 'Login failed'; });
    };
  }
  function logout() { try { sessionStorage.removeItem('ehsan_user'); } catch (e) { /* */ } S.user = null; location.hash = '#/login'; }

  /* ---------- markets ---------- */
  var lastMarkets = null;
  function topbar(inner) {
    return '<div class="top"><div class="brand" style="font-size:17px">' + logoSvg(26) + '<div>EHSAN <small>Crypto</small></div></div>' + inner +
      '<span class="grow"></span><span class="mut">' + esc(S.user || '') + '</span><button class="btn ghost" id="lo">Log out</button></div>';
  }
  function marketsView() {
    var vid = viewId, ex = curEx();
    if (ex.markets.indexOf(S.market) < 0) S.market = ex.markets[0];
    lsSet('ex', S.ex); lsSet('market', S.market);
    var exOpts = S.exchanges.map(function (e) { return '<option value="' + e.id + '"' + (e.id === S.ex ? ' selected' : '') + '>' + esc(e.name) + '</option>'; }).join('');
    var seg = ['futures', 'spot'].filter(function (m) { return ex.markets.indexOf(m) >= 0; }).map(function (m) { return '<button data-m="' + m + '" class="' + (m === S.market ? 'on' : '') + '">' + (m === 'spot' ? 'Spot' : 'Futures') + '</button>'; }).join('');
    $app.innerHTML = topbar('<select id="ex">' + exOpts + '</select><div class="seg" id="seg">' + seg + '</div>') +
      '<div class="wrap"><div id="status"></div><div class="scan" id="scan"></div>' +
      '<div class="tools"><input id="q" placeholder="Search coin…" value="' + esc(S.q) + '"><div class="seg" id="flt"></div></div>' +
      '<div class="tablewrap"><table><thead id="th"></thead><tbody id="tb"></tbody></table></div></div>';
    document.getElementById('lo').onclick = logout;
    document.getElementById('ex').onchange = function (e) { S.ex = e.target.value; location.hash = '#/m/' + S.ex; };
    document.getElementById('seg').onclick = function (e) { var m = e.target.getAttribute('data-m'); if (m) { S.market = m; lastMarkets = null; location.hash = '#/m/' + S.ex + '/' + m; } };
    document.getElementById('q').oninput = function (e) { S.q = e.target.value; renderTable(); };
    var fl = S.market === 'futures' ? [['all', 'All'], ['gain', 'Gainers'], ['lose', 'Losers'], ['long', 'LONG'], ['short', 'SHORT']] : [['all', 'All'], ['gain', 'Gainers'], ['lose', 'Losers']];
    if (!fl.some(function (f) { return f[0] === S.filter; })) S.filter = 'all';
    var fe = document.getElementById('flt');
    fe.innerHTML = fl.map(function (f) { return '<button data-f="' + f[0] + '" class="' + (f[0] === S.filter ? 'on' : '') + '">' + f[1] + '</button>'; }).join('');
    fe.onclick = function (e) { var f = e.target.getAttribute('data-f'); if (f) { S.filter = f; [].forEach.call(fe.children, function (b) { b.className = b.getAttribute('data-f') === f ? 'on' : ''; }); renderTable(); } };
    document.getElementById('tb').onclick = function (e) { var tr = e.target.closest('tr'); if (tr && tr.dataset.p) openCoin(tr.dataset.p); };
    document.getElementById('scan').onclick = function (e) { var c = e.target.closest('.card'); if (c) openCoin(c.dataset.p); };

    var cols = [['pair', 'Pair'], ['last', 'Price'], ['changePct', '24h %'], ['vol', 'Volume']];
    if (S.market === 'futures') cols.push(['oiUsd', 'Open Interest'], ['funding', 'Funding'], ['score', 'Signal']);
    var th = document.getElementById('th');
    th.innerHTML = '<tr><th>#</th>' + cols.map(function (c) { return '<th data-k="' + c[0] + '" class="' + (S.sort.key === c[0] ? 'sorted' : '') + '">' + c[1] + (S.sort.key === c[0] ? (S.sort.dir > 0 ? ' ▲' : ' ▼') : '') + '</th>'; }).join('') + '</tr>';
    th.onclick = function (e) {
      var k = e.target.getAttribute('data-k'); if (!k) return;
      S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : (k === 'pair' ? 1 : -1) };
      marketsView(); if (lastMarkets) paint();
    };

    function load() {
      api('/api/markets?ex=' + S.ex + '&market=' + S.market).then(function (j) { if (vid !== viewId) return; lastMarkets = j; paint(); }).catch(function (e) { if (e.message !== 'login') { var s = document.getElementById('status'); if (s) s.innerHTML = '<div class="warn">' + esc(e.message) + '</div>'; } });
    }
    function paint() { renderStatus(); renderScan(); renderTable(); }
    if (lastMarkets && lastMarkets.ex === S.ex && lastMarkets.market === S.market) paint();
    load(); every(load, 3000);
  }
  function openCoin(pair) { location.hash = '#/c/' + S.ex + '/' + S.market + '/' + encodeURIComponent(pair.replace('/', '-')); }

  function renderStatus() {
    var j = lastMarkets, el = document.getElementById('status'); if (!el || !j) return;
    var h = '';
    if (j.error) h += '<div class="warn">Exchange connection problem: ' + esc(j.error) + '. If this exchange is blocked in your country, turn on your VPN/proxy (see README).</div>';
    else if (!j.rows.length) h += '<div class="note">Loading market data…</div>';
    if (j.market === 'futures' && j.rows.length && j.warmupMin < 2) h += '<div class="note">Signals are warming up (needs ~1–2 minutes of OI/funding history).</div>';
    if (j.market === 'futures' && j.rows.length) h += '<div class="note">Liquidation feed: ' + (j.liqLive ? '<span class="up">live</span>' : '<span class="mut">not available — squeeze estimated from funding</span>') + '</div>';
    el.innerHTML = h;
  }
  function renderScan() {
    var j = lastMarkets, el = document.getElementById('scan'); if (!el || !j) return;
    var sig = j.ex + '|' + j.market + '|' + j.scan.order.map(function (iv) { var s = j.scan.tfs[iv]; return s.updatedAt + ':' + s.running + ':' + s.supported; }).join(',');
    if (sig === el.getAttribute('data-sig')) return;   // nothing changed: keep the lists (and their scroll position) untouched
    var scrolls = [].map.call(el.querySelectorAll('.list'), function (l) { return l.scrollTop; });
    var BBN = ['', 'near', 'touch', 'outside'];
    function item(h, c) {
      if (h.a) return '<div class="card ' + c + '" data-p="' + esc(h.pair) + '"><b>' + esc(base(h.pair)) + '</b> <span class="' + cls(h.changePct) + '">' + pct(h.changePct, 1) + '</span><div class="s">1h K' + h.a.k.toFixed(0) + '/D' + h.a.d.toFixed(0) + ' · BB ' + BBN[h.a.bb] + '</div><div class="s">4h K' + h.b.k.toFixed(0) + '/D' + h.b.d.toFixed(0) + ' · BB ' + BBN[h.b.bb] + ' · ' + h.score + '</div></div>';
      return '<div class="card ' + c + '" data-p="' + esc(h.pair) + '"><b>' + esc(base(h.pair)) + '</b> <span class="' + cls(h.changePct) + '">' + pct(h.changePct, 1) + '</span><div class="s">K ' + h.k.toFixed(0) + '/D ' + h.d.toFixed(0) + ' · ' + (h.barsAgo === 0 ? 'now' : h.barsAgo + ' ago') + (h.bb ? ' · BB' + (h.bb === 2 ? '✓✓' : '✓') : '') + ' · ' + h.score + '</div></div>'; }
    var cols = j.scan.order.map(function (iv) {
      var sc = j.scan.tfs[iv], title = (iv === 'combo' ? '1H + 4H' : iv.toUpperCase()) + ' <span class="mut" style="font-weight:400">· RSI ' + sc.low + '/' + sc.high + (iv === 'combo' ? ' · both TFs' : '') + '</span>';
      if (!sc.supported) return '<div class="scol"><h4>' + title + '</h4><div class="note">Not offered by this exchange</div></div>';
      var buy = sc.hits.filter(function (h) { return h.dir > 0; }).slice(0, 15), sell = sc.hits.filter(function (h) { return h.dir < 0; }).slice(0, 15);
      var status = sc.updatedAt ? '<div class="note">Scanned ' + sc.total + ' · ' + new Date(sc.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + (iv === 'combo' ? ' · 1h candidates ' + sc.cand + ' → both ' + sc.hits.length : '') + (sc.failed > sc.total * 0.1 ? ' · <span class="dn">' + sc.failed + ' requests failed</span>' : '') + '</div>' : '<div class="note">' + (sc.running ? 'Scanning…' : 'Waiting…') + '</div>';
      return '<div class="scol"><h4>' + title + (sc.running && sc.updatedAt ? ' <span class="mut" style="font-weight:400">↻</span>' : '') + '</h4>' + status +
        '<div class="sub up">▲ Bullish (' + buy.length + ')</div><div class="list">' + (buy.map(function (h) { return item(h, 'buy'); }).join('') || '<div class="note">—</div>') + '</div>' +
        '<div class="sub dn">▼ Bearish (' + sell.length + ')</div><div class="list">' + (sell.map(function (h) { return item(h, 'sell'); }).join('') || '<div class="note">—</div>') + '</div></div>';
    }).join('');
    var html = '<h3>Suggested coins · Stoch RSI × Bollinger scanner</h3><div class="note">Top 150 by volume. Columns 1–4 — bullish: K crosses above D below the low level; bearish: K crosses below D above the high level (newest 3 candles); BB✓ = touched band, ✓✓ = closed outside. Last column — no cross needed: on BOTH 1h and 4h, K is beyond 20/80 and price is near / touching / outside the same Bollinger band. Last number = score. Not financial advice.</div><div class="scols">' + cols + '</div>';
    el.setAttribute('data-sig', sig);
    [].forEach.call(el.querySelectorAll('.list'), function (l, i) { if (scrolls[i]) l.scrollTop = scrolls[i]; });
    if (el._sig === html) return;                       // nothing changed: leave the DOM (and scroll positions) alone
    var tops = [].map.call(el.querySelectorAll('.scol .list'), function (l) { return l.scrollTop; }), colTops = [].map.call(el.querySelectorAll('.scol'), function (c) { return c.scrollTop; });
    el._sig = html; el.innerHTML = html;
    [].forEach.call(el.querySelectorAll('.scol .list'), function (l, k) { if (tops[k]) l.scrollTop = tops[k]; });
    [].forEach.call(el.querySelectorAll('.scol'), function (c, k) { if (colTops[k]) c.scrollTop = colTops[k]; });
  }
  function renderTable() {
    var j = lastMarkets, tb = document.getElementById('tb'); if (!tb || !j) return;
    var q = S.q.trim().toUpperCase();
    var rows = j.rows.filter(function (r) {
      if (q && r.pair.indexOf(q) < 0) return false;
      if (S.filter === 'gain') return r.changePct > 0;
      if (S.filter === 'lose') return r.changePct < 0;
      if (S.filter === 'long') return r.aligned === 1;
      if (S.filter === 'short') return r.aligned === -1;
      return true;
    });
    var k = S.sort.key, d = S.sort.dir;
    rows.sort(function (a, b) { var x = a[k], y = b[k]; if (k === 'pair') return d * String(x).localeCompare(String(y)); return d * ((x == null ? -Infinity : x) - (y == null ? -Infinity : y)); });
    var fut = j.market === 'futures', html = '';
    rows.slice(0, 250).forEach(function (r, i) {
      html += '<tr data-p="' + esc(r.pair) + '"><td class="mut">' + (i + 1) + '</td><td><b>' + esc(base(r.pair)) + '</b><span class="mut">/' + esc(r.pair.split('/')[1]) + '</span></td><td class="mono">' + fp(r.last) + '</td><td class="mono ' + cls(r.changePct) + '">' + pct(r.changePct) + '</td><td class="mono">' + compact(r.vol) + '</td>';
      if (fut) {
        html += '<td class="mono">' + compact(r.oiUsd) + (r.oiChg != null ? ' <span class="' + cls(r.oiChg) + '" style="font-size:12px">' + pct(r.oiChg, 2) + '</span>' : '') + '</td><td class="mono ' + (r.funding > 0 ? 'up' : r.funding < 0 ? 'dn' : 'mut') + '">' + fundFmt(r.funding) + '</td>' +
          '<td>' + (r.aligned === 1 ? '<span class="pill long">LONG</span>' : r.aligned === -1 ? '<span class="pill short">SHORT</span>' : '<span class="mut">—</span>') + ' <span class="mut mono" style="font-size:12px">' + (r.score > 0 ? '+' : '') + r.score + '</span></td>';
      }
      html += '</tr>';
    });
    tb.innerHTML = html || '<tr><td colspan="9" class="mut" style="text-align:center;padding:24px">No coins</td></tr>';
  }

  /* ---------- charts ---------- */
  var LWC_PROMISE = null;
  function loadLib() {
    if (window.LightweightCharts) return Promise.resolve();
    if (LWC_PROMISE) return LWC_PROMISE;
    function tryUrl(u) { return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = u; s.onload = function () { window.LightweightCharts ? res() : rej(); }; s.onerror = rej; document.head.appendChild(s); }); }
    LWC_PROMISE = tryUrl('lib/lightweight-charts.js').catch(function () { return tryUrl('https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js'); }).catch(function () { return tryUrl('https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js'); });
    LWC_PROMISE.catch(function () { LWC_PROMISE = null; });
    return LWC_PROMISE;
  }
  var TZ = -new Date().getTimezoneOffset() * 60;

  function makeChart(box, pair, market, ex, iv, onData) {
    var vid = viewId, candles = [], lastT = {};
    var legend = box.parentNode.querySelector('.legend');
    var msg = box.parentNode.querySelector('.msg');
    function showMsg(t) { msg.style.display = t ? 'grid' : 'none'; msg.textContent = t || ''; }
    showMsg('Loading ' + iv + '…');
    loadLib().then(function () {
      if (vid !== viewId) return;
      var L = window.LightweightCharts;
      var chart = L.createChart(box, {
        autoSize: true,
        layout: { background: { color: '#ffffff' }, textColor: '#4b5563', fontSize: 11 },
        grid: { vertLines: { color: '#eef0f3' }, horzLines: { color: '#eef0f3' } },
        rightPriceScale: { borderColor: '#d5d9de', scaleMargins: { top: 0.06, bottom: 0.34 } },
        timeScale: { borderColor: '#d5d9de', timeVisible: true, secondsVisible: false },
        crosshair: { mode: 0 },
      });
      cleanups.push(function () { try { chart.remove(); } catch (e) { /* */ } });
      var cs = chart.addCandlestickSeries({ upColor: '#0ecb81', downColor: '#f6465d', borderVisible: false, wickUpColor: '#0ecb81', wickDownColor: '#f6465d', priceLineVisible: true });
      var vol = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.68, bottom: 0.3 } });
      var lo = { lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
      var bbU = chart.addLineSeries(Object.assign({ color: '#e53935' }, lo));
      var bbM = chart.addLineSeries(Object.assign({ color: '#9aa0a6', lineStyle: 2 }, lo));
      var bbL = chart.addLineSeries(Object.assign({ color: '#1e66f5' }, lo));
      var stK = chart.addLineSeries({ priceScaleId: 'st', color: '#2962ff', lineWidth: 1, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false, priceFormat: { type: 'custom', formatter: function (v) { return v.toFixed(0); } } });
      var stD = chart.addLineSeries({ priceScaleId: 'st', color: '#ff6d00', lineWidth: 1, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
      chart.priceScale('st').applyOptions({ scaleMargins: { top: 0.74, bottom: 0.02 } });
      [20, 80].forEach(function (v) { stK.createPriceLine({ price: v, color: '#b8bec6', lineWidth: 1, lineStyle: 2, axisLabelVisible: false }); });
      var stat = { cs: cs, vol: vol, bbU: bbU, bbM: bbM, bbL: bbL, stK: stK, stD: stD };
      var series = { cs: [], vol: [], bbU: [], bbM: [], bbL: [], stK: [], stD: [] };
      var calc = null;

      function compute() {
        var close = candles.map(function (c) { return c.close; });
        var bb = Ind.bollinger(close), sr = Ind.stochRsi(close);
        calc = { bb: bb, sr: sr };
        function line(arr) { var o = []; for (var i = 0; i < candles.length; i++) if (!isNaN(arr[i])) o.push({ time: candles[i].time + TZ, value: arr[i] }); return o; }
        series.cs = candles.map(function (c) { return { time: c.time + TZ, open: c.open, high: c.high, low: c.low, close: c.close }; });
        series.vol = candles.map(function (c) { return { time: c.time + TZ, value: c.volume, color: c.close >= c.open ? 'rgba(14,203,129,.30)' : 'rgba(246,70,93,.30)' }; });
        series.bbU = line(bb.up); series.bbM = line(bb.mid); series.bbL = line(bb.lo); series.stK = line(sr.k); series.stD = line(sr.d);
      }
      function apply(full) {
        Object.keys(series).forEach(function (k) {
          var arr = series[k];
          if (full) { stat[k].setData(arr); lastT[k] = arr.length ? arr[arr.length - 1].time : 0; return; }
          for (var i = Math.max(0, arr.length - 2); i < arr.length; i++) if (arr[i].time >= (lastT[k] || 0)) { stat[k].update(arr[i]); lastT[k] = arr[i].time; }
        });
      }
      function legendText(i) {
        if (!candles.length || !calc) return;
        if (i == null || i < 0 || i >= candles.length) i = candles.length - 1;
        var c = candles[i], k = calc.sr.k[i], d = calc.sr.d[i];
        legend.innerHTML = '<b>' + esc(pair) + ' · ' + iv + '</b> &nbsp;O ' + fp(c.open) + ' H ' + fp(c.high) + ' L ' + fp(c.low) + ' C <span class="' + (c.close >= c.open ? 'up' : 'dn') + '">' + fp(c.close) + '</span><br>' +
          'BB ' + (isNaN(calc.bb.up[i]) ? '—' : '<span style="color:#e53935">' + fp(calc.bb.up[i]) + '</span> / <span style="color:#1e66f5">' + fp(calc.bb.lo[i]) + '</span>') + ' &nbsp;<span style="color:#5b8cff">K ' + (isNaN(k) ? '—' : k.toFixed(1)) + '</span> <span style="color:#ff8a33">D ' + (isNaN(d) ? '—' : d.toFixed(1)) + '</span>';
      }
      chart.subscribeCrosshairMove(function (p) {
        if (!p || !p.time) return legendText(null);
        var t = p.time - TZ, lo2 = 0, hi = candles.length - 1;
        while (lo2 < hi) { var mid = (lo2 + hi + 1) >> 1; if (candles[mid].time <= t) lo2 = mid; else hi = mid - 1; }
        legendText(lo2);
      });

      var first = true, busy = false;
      function load() {
        if (busy) return; busy = true;
        api('/api/candles?ex=' + ex + '&market=' + market + '&pair=' + encodeURIComponent(pair) + '&interval=' + iv + '&limit=' + (first ? 1000 : 300)).then(function (data) {
          busy = false; if (vid !== viewId) return;
          if (!data.length) { if (first) showMsg('No candles for ' + iv); return; }
          if (first) candles = data;
          else { var t0 = data[0].time, older = candles.filter(function (c) { return c.time < t0; }); candles = older.concat(data); }
          compute(); apply(first);
          if (first) { first = false; showMsg(''); chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, candles.length - 110), to: candles.length + 6 }); }
          legendText(null); if (onData) onData(iv, candles);
        }).catch(function (e) { busy = false; if (first && e.message !== 'login') showMsg('Could not load ' + iv + ': ' + e.message); });
      }
      var loadingOld = false, exhausted = false;
      function loadOlder() {
        if (loadingOld || exhausted || first || !candles.length) return;
        loadingOld = true;
        var rng = chart.timeScale().getVisibleLogicalRange();
        api('/api/candles?ex=' + ex + '&market=' + market + '&pair=' + encodeURIComponent(pair) + '&interval=' + iv + '&limit=1000&end=' + (candles[0].time - 1)).then(function (data) {
          loadingOld = false; if (vid !== viewId) return;
          data = data.filter(function (c) { return c.time < candles[0].time; });
          if (data.length < 5) { exhausted = true; return; }
          candles = data.concat(candles); compute(); apply(true);
          if (rng) chart.timeScale().setVisibleLogicalRange({ from: rng.from + data.length, to: rng.to + data.length });
        }).catch(function () { loadingOld = false; });
      }
      chart.timeScale().subscribeVisibleLogicalRangeChange(function (r) { if (r && r.from < 25) loadOlder(); });
      load(); every(load, 6000);
    }).catch(function () { showMsg('Chart library could not be loaded. Check your internet / VPN, then reload.'); });
  }

  /* ---------- detail ---------- */
  function coinglassUrl(pair) { return 'https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=' + encodeURIComponent(base(pair)); }

  function detailView(ex, market, pair) {
    var vid = viewId;
    S.ex = ex; S.market = market;
    var exo = S.exchanges.filter(function (e) { return e.id === ex; })[0] || S.exchanges[0];
    var ivs = ['15m', '1h', '4h', '1d'].map(function (v) { return exo.intervals.indexOf(v) >= 0 ? v : null; });
    function cell(iv) { return iv ? '<div class="cell" data-iv="' + iv + '"><div class="chartbox"></div><div class="legend"></div><div class="msg"></div></div>' : '<div class="cell"><div class="msg" style="display:grid">Timeframe not offered by this exchange</div></div>'; }
    var heatUrl = coinglassUrl(pair);
    $app.innerHTML = topbar('<button class="btn ghost" id="back">← Markets</button>') +
      '<div class="dhead"><h2>' + esc(pair) + '</h2><span class="mut">' + esc(exo.name) + ' · ' + (market === 'spot' ? 'Spot' : 'Futures') + '</span><span class="px mono" id="hpx">—</span><span class="mono" id="hch"></span><span id="hsig"></span></div>' +
      '<div class="grid6">' + cell(ivs[0]) + cell(ivs[1]) + '<div class="cell info" id="info">Loading…</div>' + cell(ivs[2]) + cell(ivs[3]) +
      '<div class="cell heat"><div class="bar2"><b style="color:var(--tx)">Liquidation map · ' + esc(base(pair)) + '</b><span class="mut" id="hnote"></span><span class="grow"></span><a class="btn ghost" style="padding:4px 10px" target="_blank" rel="noopener" href="' + heatUrl + '">Coinglass ↗</a></div><div style="position:relative;flex:1;min-height:0"><canvas id="heatc" style="position:absolute;inset:0;width:100%;height:100%"></canvas><div class="msg" id="heatmsg">Loading…</div></div></div></div>';
    document.getElementById('lo').onclick = logout;
    document.getElementById('back').onclick = function () { location.hash = '#/m/' + ex + '/' + market; };

    function toggleBig(cellEl) {
      var was = cellEl.classList.contains('big');
      [].forEach.call(document.querySelectorAll('.cell.big'), function (c) { c.classList.remove('big'); });
      if (!was) cellEl.classList.add('big');
      document.body.classList.toggle('hasbig', !was);
    }
    [].forEach.call(document.querySelectorAll('.cell[data-iv]'), function (c) { c.title = 'Double-click to enlarge / restore'; c.addEventListener('dblclick', function () { toggleBig(c); }); });
    function onEsc(e) { if (e.key === 'Escape') { var b = document.querySelector('.cell.big'); if (b) toggleBig(b); } }
    document.addEventListener('keydown', onEsc); cleanups.push(function () { document.removeEventListener('keydown', onEsc); document.body.classList.remove('hasbig'); });

    var snap4h = null;
    [].forEach.call(document.querySelectorAll('.cell[data-iv]'), function (c) {
      makeChart(c.querySelector('.chartbox'), pair, market, ex, c.getAttribute('data-iv'), function (iv, cd) { if (iv === '4h') { snap4h = Ind.snapshot(cd); if (lastCoin) renderInfo(); } });
    });

    var lastCoin = null, nextFund = null;
    function renderInfo() {
      var j = lastCoin, el = document.getElementById('info'); if (!el || !j) return;
      var t = j.ticker, f = j.futures, dv = j.derived, h = '';
      if (t) {
        document.getElementById('hpx').textContent = fp(t.last);
        var hc = document.getElementById('hch'); hc.textContent = pct(t.changePct); hc.className = 'mono ' + cls(t.changePct);
      }
      var sg = document.getElementById('hsig');
      if (dv) sg.innerHTML = dv.aligned === 1 ? '<span class="pill long">LONG</span>' : dv.aligned === -1 ? '<span class="pill short">SHORT</span>' : '';
      function kv(a, b) { return '<div class="kv"><span>' + a + '</span><span class="mono">' + b + '</span></div>'; }
      if (j.tickerError && !t) h += '<div class="warn">' + esc(j.tickerError) + '</div>';
      if (t) {
        h += '<h4>Price (' + (market === 'spot' ? 'spot' : 'futures') + ')</h4>' + kv('Last', fp(t.last)) + kv('24h change', '<span class="' + cls(t.changePct) + '">' + pct(t.changePct) + '</span>') + kv('24h high', fp(t.high)) + kv('24h low', fp(t.low)) + kv('24h volume', '$' + compact(t.quoteVolume));
      }
      if (j.cap) {
        var c = j.cap;
        h += '<h4>Market cap · ' + esc(c.name) + '</h4>' + kv('Market cap', '$' + compact(c.cap) + (c.rank ? ' · #' + c.rank : '')) + kv('Fully diluted', c.fdv ? '$' + compact(c.fdv) : '—') + kv('Circulating supply', compact(c.circ)) + kv('Total / max supply', compact(c.total) + ' / ' + (c.max ? compact(c.max) : '∞')) + kv('All-time high', fp(c.ath) + ' <span class="dn">' + pct(c.athPct, 1) + '</span>');
      }
      if (market === 'futures') {
        h += '<h4>Futures data</h4>';
        if (j.spot != null) { var basis = t ? (t.last / j.spot - 1) * 100 : null; h += kv('Spot price', fp(j.spot)) + kv('Basis (fut − spot)', '<span class="' + cls(basis) + '">' + pct(basis, 3) + '</span>'); }
        if (f) {
          h += kv('Mark price', fp(f.mark)) + (f.index != null ? kv('Index price', fp(f.index)) : '') + kv('Funding rate', '<span class="' + (f.funding > 0 ? 'up' : f.funding < 0 ? 'dn' : 'mut') + '">' + fundFmt(f.funding) + '</span>');
          h += kv('Next funding', '<span id="fcd">—</span>') + kv('Open interest', f.oiUsd != null ? '$' + compact(f.oiUsd) : '—') + (f.oiBase != null ? kv('OI (coins)', compact(f.oiBase)) : '');
          nextFund = f.nextFundingTime;
        }
        if (dv) {
          h += kv('OI change (' + Math.max(j.warmupMin, 1) + ' min window)', dv.oiChg == null ? '<span class="mut">warming up…</span>' : '<span class="' + cls(dv.oiChg) + '">' + pct(dv.oiChg, 3) + '</span>');
          h += '<h4>Signal · ' + (dv.aligned === 1 ? '<span class="long">LONG setup</span>' : dv.aligned === -1 ? '<span class="short">SHORT setup</span>' : '<span class="mut">no setup</span>') + ' (' + (dv.score > 0 ? '+' : '') + dv.score + ')</h4>';
          [['Price momentum', dv.cP], ['Open interest', dv.cO], ['Funding', dv.cF], [dv.sqEst ? 'Squeeze (est.)' : 'Liquidations', dv.cS]].forEach(function (x) {
            var v = x[1]; h += '<div class="kv"><span>' + x[0] + '</span><span class="mono">' + (v == null ? '—' : (v * 100).toFixed(0)) + '</span></div><div class="bar"><i style="' + (v == null ? '' : v >= 0 ? 'left:50%;width:' + (v * 50) + '%;background:var(--long)' : 'right:50%;width:' + (-v * 50) + '%;background:var(--short)') + '"></i></div>';
          });
        }
      }
      if (snap4h) {
        var s = snap4h, zone = s.k < 30 && s.d < 30 ? '<span class="up">oversold</span>' : s.k > 70 && s.d > 70 ? '<span class="dn">overbought</span>' : '<span class="mut">neutral</span>';
        h += '<h4>4h indicators</h4>' + kv('Stoch RSI K / D', s.k.toFixed(1) + ' / ' + s.d.toFixed(1) + ' · ' + zone) + kv('Bollinger up / low', fp(s.up) + ' / ' + fp(s.lo)) + kv('Band position', (s.pos == null ? '—' : (s.pos * 100).toFixed(0) + '% (0 = lower, 100 = upper)'));
      }
      h += '<h4>Trade on exchange</h4><div class="links">' + Object.keys(j.trade).map(function (k) { var p = k.split('|'), e = S.exchanges.filter(function (x) { return x.id === p[0]; })[0]; return e ? '<a class="btn ghost" style="padding:4px 9px;font-size:12px" target="_blank" rel="noopener" href="' + esc(j.trade[k]) + '">' + esc(e.name) + ' ' + (p[1] === 'spot' ? 'Spot' : 'Futures') + '</a>' : ''; }).join('') + '</div>';
      el.innerHTML = h;
    }
    function loadCoin() {
      api('/api/coin?ex=' + ex + '&market=' + market + '&pair=' + encodeURIComponent(pair)).then(function (j) { if (vid !== viewId) return; lastCoin = j; var top = document.getElementById('info'); var sy = top ? top.scrollTop : 0; renderInfo(); if (top) top.scrollTop = sy; }).catch(function (e) { var el = document.getElementById('info'); if (el && !lastCoin && e.message !== 'login') el.innerHTML = '<div class="warn">' + esc(e.message) + '</div>'; });
    }
    var heatData = null;
    function drawHeat() {
      var cv = document.getElementById('heatc'); if (!cv || !heatData) return;
      var dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight; if (!W || !H) return;
      cv.width = W * dpr; cv.height = H * dpr; var g = cv.getContext('2d'); g.scale(dpr, dpr);
      g.fillStyle = '#181a20'; g.fillRect(0, 0, W, H);
      var d = heatData, bins = d.bins, bh = (H - 20) / bins.length, X0 = 62, X1 = W - 8;
      g.font = '11px sans-serif'; g.textBaseline = 'middle';
      bins.forEach(function (b, i) {
        var y = 10 + (bins.length - 1 - i) * bh, v = Math.max(b.long, b.short), isL = b.long >= b.short, w = (X1 - X0) * Math.pow(v, 0.7);
        if (v > 0.003) { g.fillStyle = isL ? 'rgba(32,201,166,' + (0.25 + 0.75 * v) + ')' : 'rgba(160,116,245,' + (0.25 + 0.75 * v) + ')'; g.fillRect(X0, y, w, Math.max(1, bh - 1)); }
        if (i % 9 === 4) { g.fillStyle = '#848e9c'; g.fillText(fp(b.p), 4, y + bh / 2); }
      });
      var py = 10 + (d.hi - d.price) / (d.hi - d.lo) * (H - 20);
      g.strokeStyle = '#f0b90b'; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(X0, py); g.lineTo(X1, py); g.stroke(); g.setLineDash([]);
      g.fillStyle = '#f0b90b'; g.fillText(fp(d.price), 4, py);
    }
    function loadHeat() {
      api('/api/liqmap?ex=' + ex + '&pair=' + encodeURIComponent(pair)).then(function (j) {
        if (vid !== viewId) return; heatData = j; document.getElementById('heatmsg').style.display = 'none';
        var r = j.recent, n = document.getElementById('hnote');
        n.textContent = ' estimated · ' + (r.live ? 'last 30m liquidated: longs $' + compact(r.longUsd) + ' / shorts $' + compact(r.shortUsd) : '');
        drawHeat();
      }).catch(function (e) { var m = document.getElementById('heatmsg'); if (m && !heatData && e.message !== 'login') m.textContent = 'Liquidation map unavailable: ' + e.message; });
    }
    window.addEventListener('resize', drawHeat); cleanups.push(function () { window.removeEventListener('resize', drawHeat); });
    loadHeat(); every(loadHeat, 60000);
    loadCoin(); every(loadCoin, 3000);
    every(function () {
      var el = document.getElementById('fcd'); if (!el) return;
      if (!nextFund) { el.textContent = '—'; return; }
      var s = Math.max(0, Math.floor((nextFund - Date.now()) / 1000));
      el.textContent = String(Math.floor(s / 3600)).padStart(2, '0') + ':' + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    }, 1000);
  }

  route();
})();
