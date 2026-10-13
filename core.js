'use strict';
/* EHSAN core: exchange access, derivatives tracker, scanner, liquidation map. Runs in the BROWSER (so your VPN applies) and in Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./indicators.js'));
  else root.EhsanCore = factory(root.Ind);
})(typeof self !== 'undefined' ? self : this, function (Ind) {
const MOCK = (typeof process !== 'undefined' && process.env && process.env.EHSAN_MOCK === '1') || (typeof location !== 'undefined' && /[?&]mock=1/.test(location.search));
/* ------------------------------------------------------------------ helpers */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const numOr0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

async function getJSON(url, timeoutMs) {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs || 9000) });
  if (!res.ok) { const e = new Error('HTTP ' + res.status + ' from ' + new URL(url).host); e.status = res.status; throw e; }
  return res.json();
}
async function getAny(urls) {
  let last;
  for (const u of urls) { try { return await getJSON(u); } catch (e) { last = e; } }
  throw last || new Error('no url');
}
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = null; } }
  }));
  return out;
}
const cacheMap = new Map();
function cached(key, ttl, fn) {
  const hit = cacheMap.get(key);
  const now = Date.now();
  if (hit && now - hit.t < ttl) return hit.p;
  const p = fn();
  cacheMap.set(key, { t: now, p });
  p.catch(() => { if (cacheMap.get(key) && cacheMap.get(key).p === p) cacheMap.delete(key); });
  if (cacheMap.size > 2000) for (const [k, v] of cacheMap) if (now - v.t > 60000) cacheMap.delete(k);
  return p;
}

/* ------------------------------------------------------------------ exchanges */
// Normalised ticker: { pair:'BTC/USDT', last, changePct, high, low, quoteVolume, markPrice?, fundingRate?, openInterestUsd? }
// Candle: { time (sec), open, high, low, close, volume }
const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];
const IV_SEC = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };

const binance = (() => {
  const spotBases = ['https://api.binance.com/api/v3', 'https://data-api.binance.vision/api/v3', 'https://api1.binance.com/api/v3', 'https://api2.binance.com/api/v3'];
  const futBase = ['https://fapi.binance.com/fapi/v1'];
  const bases = (m) => (m === 'spot' ? spotBases : futBase);
  const api = (m, p) => getAny(bases(m).map((b) => b + p));
  const sym = (pair) => pair.replace('/', '');
  const pairOf = (s) => (s.endsWith('USDT') && !s.endsWith('UPUSDT') && !s.endsWith('DOWNUSDT') ? s.slice(0, -4) + '/USDT' : null);
  const parse = (o) => {
    const pair = pairOf(o.symbol);
    return pair && { pair, last: numOr0(o.lastPrice), changePct: numOr0(o.priceChangePercent), high: numOr0(o.highPrice), low: numOr0(o.lowPrice), quoteVolume: numOr0(o.quoteVolume) };
  };
  return {
    id: 'binance', name: 'Binance', markets: ['spot', 'futures'], intervals: INTERVALS,
    tradeUrl: (pair, m) => { const [b, q] = pair.split('/'); return m === 'spot' ? `https://www.binance.com/en/trade/${b}_${q}?type=spot` : `https://www.binance.com/en/futures/${b}${q}`; },
    async tickers(m) {
      const [list, prem] = await Promise.all([
        api(m, '/ticker/24hr'),
        m === 'futures' ? getJSON('https://fapi.binance.com/fapi/v1/premiumIndex').catch(() => []) : Promise.resolve([]),
      ]);
      const pm = new Map(prem.map((o) => [o.symbol, o]));
      const out = [];
      for (const o of list) {
        const t = parse(o);
        if (!t) continue;
        const p = pm.get(sym(t.pair));
        if (p) { t.markPrice = num(p.markPrice); t.fundingRate = num(p.lastFundingRate); }
        out.push(t);
      }
      return out;
    },
    async ticker(pair, m) { const t = parse(await api(m, '/ticker/24hr?symbol=' + sym(pair))); if (!t) throw new Error('Unsupported pair'); return t; },
    async candles(pair, m, iv, limit) {
      const arr = await api(m, `/klines?symbol=${sym(pair)}&interval=${iv}&limit=${Math.min(limit, 1000)}`);
      return arr.map((k) => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
    },
    async futuresInfo(pair) {
      const s = sym(pair);
      const [p, oi] = await Promise.all([
        getJSON('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=' + s),
        getJSON('https://fapi.binance.com/fapi/v1/openInterest?symbol=' + s).catch(() => null),
      ]);
      const mark = numOr0(p.markPrice);
      const oiBase = oi ? num(oi.openInterest) : null;
      return { mark, index: num(p.indexPrice), funding: num(p.lastFundingRate), nextFundingTime: num(p.nextFundingTime), oiBase, oiUsd: oiBase == null ? null : oiBase * mark };
    },
    async derivatives(top) {
      const arr = await api('futures', '/premiumIndex');
      const oiRes = await pool(top.slice(0, 25), 4, (pair) => api('futures', '/openInterest?symbol=' + sym(pair)).then((o) => num(o.openInterest)));
      const oi = new Map(top.slice(0, 25).map((p, i) => [p, oiRes[i]]));
      const out = new Map();
      for (const o of arr) {
        const pair = pairOf(o.symbol);
        if (!pair) continue;
        const mark = numOr0(o.markPrice), index = numOr0(o.indexPrice);
        let est = null;
        if (index > 0) { const prem = (mark - index) / index; est = prem + Math.min(0.0005, Math.max(-0.0005, 0.0001 - prem)); }
        const ob = oi.get(pair);
        out.set(pair, { oiUsd: ob == null ? null : ob * mark, funding: num(o.lastFundingRate), fundingEst: est });
      }
      return out;
    },
    pairOf,
  };
})();

const bybit = (() => {
  const bases = ['https://api.bybit.com/v5/market', 'https://api.bytick.com/v5/market'];
  const api = (p) => getAny(bases.map((b) => b + p));
  const cat = (m) => (m === 'spot' ? 'spot' : 'linear');
  const sym = (pair) => pair.replace('/', '');
  const ivMap = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D', '1w': 'W' };
  const parse = (o) => {
    if (!o.symbol.endsWith('USDT')) return null;
    return {
      pair: o.symbol.slice(0, -4) + '/USDT', last: numOr0(o.lastPrice), changePct: numOr0(o.price24hPcnt) * 100,
      high: numOr0(o.highPrice24h), low: numOr0(o.lowPrice24h), quoteVolume: numOr0(o.turnover24h),
      markPrice: num(o.markPrice), fundingRate: num(o.fundingRate), openInterestUsd: num(o.openInterestValue),
    };
  };
  return {
    id: 'bybit', name: 'Bybit', markets: ['spot', 'futures'], intervals: INTERVALS,
    tradeUrl: (pair, m) => { const [b, q] = pair.split('/'); return m === 'spot' ? `https://www.bybit.com/en/trade/spot/${b}/${q}` : `https://www.bybit.com/trade/usdt/${b}${q}`; },
    async tickers(m) { return (await api('/tickers?category=' + cat(m))).result.list.map(parse).filter(Boolean); },
    async ticker(pair, m) { const t = parse((await api(`/tickers?category=${cat(m)}&symbol=${sym(pair)}`)).result.list[0]); if (!t) throw new Error('Unsupported pair'); return t; },
    async candles(pair, m, iv, limit) {
      const l = (await api(`/kline?category=${cat(m)}&symbol=${sym(pair)}&interval=${ivMap[iv]}&limit=${Math.min(limit, 1000)}`)).result.list;
      return l.map((k) => ({ time: Math.floor(+k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] })).reverse();
    },
    async futuresInfo(pair) {
      const o = (await api('/tickers?category=linear&symbol=' + sym(pair))).result.list[0];
      const mark = numOr0(o.markPrice), oi = num(o.openInterest);
      return { mark, index: num(o.indexPrice), funding: num(o.fundingRate), nextFundingTime: num(o.nextFundingTime), oiBase: oi, oiUsd: num(o.openInterestValue) ?? (oi == null ? null : oi * mark) };
    },
    async derivatives() {
      const out = new Map();
      for (const t of await this.tickers('futures')) out.set(t.pair, { oiUsd: t.openInterestUsd ?? null, funding: t.fundingRate ?? null, fundingEst: t.fundingRate ?? null });
      return out;
    },
  };
})();

const okx = (() => {
  const rest = 'https://www.okx.com/api/v5';
  const inst = (pair, m) => pair.replace('/', '-') + (m === 'futures' ? '-SWAP' : '');
  const barMap = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D', '1w': '1W' };
  const parse = (o, m) => {
    const suffix = m === 'spot' ? '-USDT' : '-USDT-SWAP';
    if (!o.instId.endsWith(suffix)) return null;
    const last = numOr0(o.last), open = numOr0(o.open24h);
    const qv = m === 'spot' ? numOr0(o.volCcy24h) : numOr0(o.volCcy24h) * last;
    return { pair: o.instId.split('-USDT')[0] + '/USDT', last, changePct: open > 0 ? (last / open - 1) * 100 : 0, high: numOr0(o.high24h), low: numOr0(o.low24h), quoteVolume: qv };
  };
  const pairOfSwap = (id) => (id.endsWith('-USDT-SWAP') ? id.slice(0, -10) + '/USDT' : null);
  return {
    id: 'okx', name: 'OKX', markets: ['spot', 'futures'], intervals: INTERVALS,
    tradeUrl: (pair, m) => { const p = pair.replace('/', '-').toLowerCase(); return m === 'spot' ? `https://www.okx.com/trade-spot/${p}` : `https://www.okx.com/trade-swap/${p}-swap`; },
    async tickers(m) { return (await getJSON(`${rest}/market/tickers?instType=${m === 'spot' ? 'SPOT' : 'SWAP'}`)).data.map((o) => parse(o, m)).filter(Boolean); },
    async ticker(pair, m) { const t = parse((await getJSON(`${rest}/market/ticker?instId=${inst(pair, m)}`)).data[0], m); if (!t) throw new Error('Unsupported pair'); return t; },
    async candles(pair, m, iv, limit) {
      const d = (await getJSON(`${rest}/market/candles?instId=${inst(pair, m)}&bar=${barMap[iv]}&limit=${Math.min(limit, 300)}`)).data;
      return d.map((k) => ({ time: Math.floor(+k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] })).reverse();
    },
    async futuresInfo(pair) {
      const id = inst(pair, 'futures');
      const [f, mk, oi, idx] = await Promise.all([
        getJSON(`${rest}/public/funding-rate?instId=${id}`).then((r) => r.data[0]),
        getJSON(`${rest}/public/mark-price?instType=SWAP&instId=${id}`).then((r) => numOr0(r.data[0].markPx)),
        getJSON(`${rest}/public/open-interest?instType=SWAP&instId=${id}`).then((r) => num(r.data[0].oiCcy)).catch(() => null),
        getJSON(`${rest}/market/index-tickers?instId=${pair.replace('/', '-')}`).then((r) => num(r.data[0].idxPx)).catch(() => null),
      ]);
      return { mark: mk, index: idx, funding: num(f.fundingRate), nextFundingTime: num(f.nextFundingTime), oiBase: oi, oiUsd: oi == null ? null : oi * mk };
    },
    async derivatives() {
      const [oiRes, frRes] = await Promise.all([
        getJSON(`${rest}/public/open-interest?instType=SWAP`),
        getJSON(`${rest}/public/funding-rate?instId=ANY`).catch(() => ({ data: [] })),
      ]);
      const oi = new Map(), fr = new Map();
      for (const o of oiRes.data) { const p = pairOfSwap(o.instId); if (p) oi.set(p, num(o.oiUsd)); }
      for (const o of frRes.data) { const p = pairOfSwap(o.instId); if (p) fr.set(p, num(o.fundingRate)); }
      const out = new Map();
      for (const p of new Set([...oi.keys(), ...fr.keys()])) out.set(p, { oiUsd: oi.get(p) ?? null, funding: fr.get(p) ?? null, fundingEst: fr.get(p) ?? null });
      return out;
    },
  };
})();

const deribit = (() => {
  const api = 'https://www.deribit.com/api/v2/public';
  const inst = (pair) => { const [b, q] = pair.split('/'); return q === 'USD' ? b + '-PERPETUAL' : b + '_' + q + '-PERPETUAL'; };
  const pairOf = (name) => { if (!name.endsWith('-PERPETUAL')) return null; const core = name.slice(0, -10); return core.includes('_') ? core.replace('_', '/') : core + '/USD'; };
  const parse = (o) => {
    const pair = pairOf(o.instrument_name);
    if (!pair) return null;
    const mark = num(o.mark_price);
    const oi = num(o.open_interest);
    return {
      pair, last: num(o.last) ?? numOr0(o.mark_price), changePct: numOr0(o.price_change), high: numOr0(o.high), low: numOr0(o.low),
      quoteVolume: num(o.volume_notional) ?? numOr0(o.volume_usd), markPrice: mark, fundingRate: num(o.current_funding),
      openInterestUsd: oi == null ? null : (pair.endsWith('/USD') ? oi : oi * (mark || 1)),
    };
  };
  const res = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '1d': '1D' };
  return {
    id: 'deribit', name: 'Deribit', markets: ['futures'], intervals: ['1m', '5m', '15m', '1h', '1d'],
    tradeUrl: (pair) => 'https://www.deribit.com/futures/' + inst(pair),
    async tickers() {
      const out = [];
      for (const cur of ['BTC', 'ETH', 'USDC']) {
        try { out.push(...(await getJSON(`${api}/get_book_summary_by_currency?currency=${cur}&kind=future`)).result.map(parse).filter(Boolean)); } catch (e) { /* skip */ }
      }
      if (!out.length) throw new Error('Deribit returned no data');
      return out;
    },
    async ticker(pair) { const t = parse((await getJSON(`${api}/get_book_summary_by_instrument?instrument_name=${inst(pair)}`)).result[0]); if (!t) throw new Error('Unsupported pair'); return t; },
    async candles(pair, m, iv, limit) {
      const now = Date.now(), start = now - IV_SEC[iv] * 1000 * limit;
      const r = (await getJSON(`${api}/get_tradingview_chart_data?instrument_name=${inst(pair)}&start_timestamp=${start}&end_timestamp=${now}&resolution=${res[iv]}`)).result;
      return r.ticks.map((t, i) => ({ time: Math.floor(t / 1000), open: r.open[i], high: r.high[i], low: r.low[i], close: r.close[i], volume: r.volume[i] }));
    },
    async futuresInfo(pair) {
      const r = (await getJSON(`${api}/ticker?instrument_name=${inst(pair)}`)).result;
      const mark = numOr0(r.mark_price), oi = num(r.open_interest), inv = pair.endsWith('/USD');
      return { mark, index: num(r.index_price), funding: num(r.current_funding), nextFundingTime: null, oiBase: oi == null ? null : (inv ? oi / mark : oi), oiUsd: oi == null ? null : (inv ? oi : oi * mark) };
    },
    async derivatives() {
      const out = new Map();
      for (const t of await this.tickers()) out.set(t.pair, { oiUsd: t.openInterestUsd ?? null, funding: t.fundingRate ?? null, fundingEst: t.fundingRate ?? null });
      return out;
    },
  };
})();

/* ---- synthetic exchange for offline testing: EHSAN_MOCK=1 node server.js */
const mock = (() => {
  const coins = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT', 'TON', 'SUI', 'APT', 'ARB', 'OP', 'NEAR', 'INJ', 'PEPE', 'WIF', 'LTC', 'BCH'];
  const seedPrice = (c) => 5 + ((c.charCodeAt(0) * 131 + c.charCodeAt(1) * 17) % 900) * (c === 'BTC' ? 80 : 1);
  const rnd = (seed) => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
  const base = (pair) => seedPrice(pair.split('/')[0]);
  const price = (pair, tSec) => base(pair) * (1 + 0.08 * Math.sin(tSec / 9000 + pair.length) + 0.02 * Math.sin(tSec / 600));
  const tick = (c, m) => {
    const pair = c + '/USDT', now = Date.now() / 1000, p = price(pair, now), p0 = price(pair, now - 86400);
    return { pair, last: p, changePct: (p / p0 - 1) * 100, high: p * 1.02, low: p * 0.98, quoteVolume: base(pair) * 1e5 * (1 + (c.charCodeAt(0) % 7)), markPrice: m === 'futures' ? p * 1.0004 : undefined, fundingRate: m === 'futures' ? Math.sin(now / 3000 + c.length) * 0.0004 : undefined };
  };
  return {
    id: 'mock', name: 'Mock (test data)', markets: ['spot', 'futures'], intervals: INTERVALS,
    tradeUrl: () => 'https://example.com',
    async tickers(m) { return coins.map((c) => tick(c, m)); },
    async ticker(pair, m) { return tick(pair.split('/')[0], m); },
    async candles(pair, m, iv, limit) {
      const step = IV_SEC[iv], now = Math.floor(Date.now() / 1000), end = now - (now % step), out = [];
      for (let i = limit - 1; i >= 0; i--) {
        const t = end - i * step, r = rnd(t ^ pair.length), o = price(pair, t), c = price(pair, t + step) * (1 + (r() - 0.5) * 0.01);
        out.push({ time: t, open: o, high: Math.max(o, c) * (1 + r() * 0.004), low: Math.min(o, c) * (1 - r() * 0.004), close: c, volume: 100 + r() * 900 });
      }
      return out;
    },
    async futuresInfo(pair) {
      const t = tick(pair.split('/')[0], 'futures'), now = Date.now();
      return { mark: t.markPrice, index: t.last, funding: t.fundingRate, nextFundingTime: now + 3600000, oiBase: 1e4, oiUsd: 1e4 * t.last * (1 + 0.002 * Math.sin(now / 20000)) };
    },
    async derivatives(top) {
      const out = new Map(), now = Date.now();
      for (const c of coins) {
        const t = tick(c, 'futures'), ph = c.charCodeAt(0);
        out.set(c + '/USDT', { oiUsd: 1e8 * (1 + 0.03 * Math.sin(now / 40000 + ph) + now / 1e12), funding: t.fundingRate, fundingEst: t.fundingRate });
      }
      return out;
    },
  };
})();

const EXCHANGES = MOCK ? [mock] : [binance, bybit, okx, deribit];
const exById = (id) => EXCHANGES.find((e) => e.id === id) || EXCHANGES[0];

/* ------------------------------------------------------------------ derivatives tracker (OI / funding / squeeze signal) */
const KEEP_MS = 65 * 60000, LIQ_MS = 30 * 60000, LIVE_MS = 10 * 60000, MIN_AGE_MS = 45000;
const T = 0.2, T_AGAINST = 0.1, SIGNAL_MIN = 30;
const tanh = Math.tanh;

class Tracker {
  constructor() { this.hist = new Map(); this.liqs = new Map(); this.lastLiq = 0; this.first = 0; }
  addSnapshot(now, snap, tickers) {
    if (!this.first) this.first = now;
    for (const [pair, d] of snap) {
      const t = tickers.get(pair);
      if (!t) continue;
      let q = this.hist.get(pair);
      if (!q) this.hist.set(pair, (q = []));
      q.push({ t: now, oi: d.oiUsd, fund: d.fundingEst ?? d.funding, price: t.last });
      while (q.length && now - q[0].t > KEEP_MS) q.shift();
    }
  }
  addLiquidation(l) {
    const now = Date.now();
    this.lastLiq = now;
    let q = this.liqs.get(l.pair);
    if (!q) this.liqs.set(l.pair, (q = []));
    q.push({ t: now, usd: l.usd, short: l.short });
    while (q.length && now - q[0].t > LIQ_MS) q.shift();
  }
  warmupMin(now) { return this.first ? Math.floor((now - this.first) / 60000) : 0; }
  liqLive(now) { return now - this.lastLiq < LIVE_MS; }
  compute(now, pair, t) {
    const q = this.hist.get(pair);
    const first = q && q[0], last = q && q[q.length - 1];
    const enough = !!(first && last && last.t - first.t >= MIN_AGE_MS);
    const oi0 = first && first.oi, oi1 = last && last.oi;
    const oiChg = enough && oi0 != null && oi1 != null && oi0 > 0 ? (oi1 / oi0 - 1) * 100 : null;
    const f0 = first && first.fund, f1 = last && last.fund;
    const fDelta = enough && f0 != null && f1 != null ? f1 - f0 : null;
    const pChg = enough && first.price > 0 ? (t.last / first.price - 1) * 100 : null;
    const fund = f1 ?? t.fundingRate ?? null;
    const oiNow = oi1 ?? t.openInterestUsd ?? null;

    const live = now - this.lastLiq < LIVE_MS;
    let squeezeUsd = null, cS;
    if (live) {
      let net = 0;
      for (const l of this.liqs.get(pair) || []) if (now - l.t <= LIQ_MS) net += l.short ? l.usd : -l.usd;
      squeezeUsd = net;
      cS = tanh(net / Math.max(oiNow ?? t.quoteVolume * 0.2, 1) / 0.002);
    } else {
      const dir = pChg ?? t.changePct;
      cS = fund == null ? null : dir >= 0 ? tanh(Math.max(0, -fund) / 0.0003) : -tanh(Math.max(0, fund) / 0.0003);
    }
    const cP = 0.5 * tanh(t.changePct / 8) + 0.5 * (pChg != null ? tanh(pChg / 2) : tanh(t.changePct / 8));
    const cO = oiChg != null ? tanh(oiChg / 0.8) : null;
    const cF = fund == null ? null : 0.6 * (fDelta != null ? tanh(fDelta / 0.00005) : 0) + 0.4 * tanh(fund / 0.0003);

    const parts = [[cP, 0.25], [cO, 0.30], [cF, 0.20], [cS, 0.25]].filter((p) => p[0] != null);
    const wSum = parts.reduce((s, p) => s + p[1], 0);
    const score = Math.round(100 * parts.reduce((s, p) => s + p[0] * p[1], 0) / wSum);
    const known = [cP, cO, cF, cS].filter((v) => v != null);
    const hasDeriv = cO != null || cF != null;
    let aligned = 0;
    if (hasDeriv) {
      if (score >= SIGNAL_MIN && known.every((v) => v >= -T_AGAINST) && known.filter((v) => v > T).length >= 3) aligned = 1;
      else if (score <= -SIGNAL_MIN && known.every((v) => v <= T_AGAINST) && known.filter((v) => v < -T).length >= 3) aligned = -1;
    }
    return { oiUsd: oiNow, oiChg, funding: fund, fundingDelta: fDelta, squeezeUsd, sqEst: !live, cP, cO, cF, cS, score, aligned };
  }
}

/* ------------------------------------------------------------------ per (exchange, market) background state */
const states = new Map();
const IDLE_MS = 10 * 60000;

/* Scanner timeframes: Stoch RSI K/D cross outside [low, high] in the newest 3 candles + Bollinger confirmation. Edit here to change. */
const SCAN_TFS = [
  { iv: '15m', low: 20, high: 80, every: 5 * 60000 },
  { iv: '1h', low: 20, high: 80, every: 10 * 60000 },
  { iv: '4h', low: 20, high: 80, every: 15 * 60000 },
  { iv: '1d', low: 20, high: 80, every: 60 * 60000 },
  { iv: 'combo', low: 20, high: 80, every: 10 * 60000, combo: ['1h', '4h'] },
];
function newScan() {
  const tfs = {};
  for (const t of SCAN_TFS) tfs[t.iv] = { supported: true, running: false, hits: [], total: 0, updatedAt: 0, low: t.low, high: t.high };
  return { tfs, order: SCAN_TFS.map((t) => t.iv) };
}

function getState(exId, market) {
  const ex = exById(exId);
  if (!ex.markets.includes(market)) market = ex.markets[0];
  const key = ex.id + '|' + market;
  let st = states.get(key);
  if (!st) {
    st = { key, ex, market, tickers: new Map(), updatedAt: 0, error: null, tracker: new Tracker(), running: false, lastUsed: Date.now(), scan: newScan() };
    states.set(key, st);
  }
  st.lastUsed = Date.now();
  if (!st.running) startLoops(st);
  return st;
}

function startLoops(st) {
  st.running = true;
  const alive = () => st.running && Date.now() - st.lastUsed < IDLE_MS;
  const stop = () => { if (st.running) { st.running = false; } };

  (async function tickerLoop() {
    while (alive()) {
      try {
        const list = await st.ex.tickers(st.market);
        const m = new Map();
        for (const t of list) if (t.last > 0) m.set(t.pair, t);
        st.tickers = m; st.updatedAt = Date.now(); st.error = null;
      } catch (e) { st.error = e.message || String(e); }
      await sleep(st.error ? 8000 : 4000);
    }
    stop();
  })();

  if (st.market === 'futures') {
    ensureLiquidations();
    (async function derivLoop() {
      while (alive()) {
        if (!st.tickers.size) { await sleep(1500); continue; }
        try {
          const top = [...st.tickers.values()].sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, 25).map((t) => t.pair);
          const snap = await st.ex.derivatives(top);
          st.tracker.addSnapshot(Date.now(), snap, st.tickers);
        } catch (e) { /* retry next round */ }
        await sleep(45000);
      }
    })();
  }

  (async function scanLoop() {
    const due = {};
    while (alive()) {
      if (!st.tickers.size) { await sleep(2500); continue; }
      const tf = SCAN_TFS.find((x) => (due[x.iv] || 0) <= Date.now());
      if (!tf) { await sleep(3000); continue; }
      const slot = st.scan.tfs[tf.iv];
      const need = tf.combo || [tf.iv];
      if (!need.every((v) => st.ex.intervals.includes(v))) { slot.supported = false; due[tf.iv] = Infinity; continue; }
      slot.running = true;
      try {
        const top = [...st.tickers.values()].sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, 150);
        const res = await pool(top, 4, async (t) => {
          if (tf.combo) {
            const a = Ind.zone(await st.ex.candles(t.pair, st.market, tf.combo[0], 100), { low: tf.low, high: tf.high });
            if (!a) return null;
            const b = Ind.zone(await st.ex.candles(t.pair, st.market, tf.combo[1], 100), { low: tf.low, high: tf.high });
            if (!b || b.dir !== a.dir) return null;
            return { dir: a.dir, score: a.score + b.score, a, b, pair: t.pair, last: t.last, changePct: t.changePct };
          }
          const h = Ind.evaluate(await st.ex.candles(t.pair, st.market, tf.iv, 100), { low: tf.low, high: tf.high });
          return h && Object.assign(h, { pair: t.pair, last: t.last, changePct: t.changePct });
        });
        Object.assign(slot, { running: false, hits: res.filter(Boolean).sort((a, b) => b.score - a.score), total: top.length, updatedAt: Date.now() });
      } catch (e) { slot.running = false; }
      due[tf.iv] = Date.now() + tf.every;
    }
  })();
}

/* ---- Binance liquidation feed (global, starts on first futures use) */
const liqTrackers = new Set();
let liqStarted = false;
function ensureLiquidations() {
  if (liqStarted || typeof WebSocket === 'undefined' || MOCK) return;
  liqStarted = true;
  const connect = () => {
    let ws;
    try { ws = new WebSocket('wss://fstream.binance.com/ws/!forceOrder@arr'); } catch (e) { setTimeout(connect, 15000); return; }
    ws.onmessage = (ev) => {
      try {
        const o = JSON.parse(ev.data).o;
        const pair = o && binance.pairOf(o.s);
        if (!pair) return;
        const px = Number(o.ap) > 0 ? Number(o.ap) : Number(o.p), qty = Number(o.z) > 0 ? Number(o.z) : Number(o.q);
        const l = { pair, usd: px * qty, short: o.S === 'BUY' };
        for (const st of states.values()) if (st.market === 'futures') st.tracker.addLiquidation(l);
      } catch (e) { /* ignore */ }
    };
    ws.onclose = ws.onerror = () => { try { ws.close(); } catch (e) { /* */ } setTimeout(connect, 5000); };
  };
  connect();
}

/* ------------------------------------------------------------------ API */
function marketsPayload(st) {
  const now = Date.now(), fut = st.market === 'futures';
  const rows = [...st.tickers.values()].sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, 700).map((t) => {
    const r = { pair: t.pair, last: t.last, changePct: t.changePct, high: t.high, low: t.low, vol: t.quoteVolume };
    if (fut) Object.assign(r, st.tracker.compute(now, t.pair, t));
    return r;
  });
  return {
    ex: st.ex.id, market: st.market, updatedAt: st.updatedAt, error: st.error, rows,
    warmupMin: fut ? st.tracker.warmupMin(now) : 0, liqLive: fut ? st.tracker.liqLive(now) : false,
    scan: st.scan,
  };
}

/* ---- market cap etc. (CoinGecko public API, cached 10 min; optional) */
function geckoMap() {
  return cached('gecko', 10 * 60000, async () => {
    const map = new Map();
    for (const page of [1, 2, 3]) {
      const arr = await getJSON(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}&sparkline=false`, 15000);
      for (const c of arr) { const s = String(c.symbol).toUpperCase(); if (!map.has(s)) map.set(s, c); }
    }
    return map;
  });
}
function baseSymbol(pair) { return pair.split('/')[0].replace(/^(1000000|10000|1000|1M)/, ''); }

/* ---- estimated liquidation map (model, NOT exchange data): where leveraged positions opened in the last ~500 hours
   would be liquidated, keeping only those that price has not already crossed. */
const LEV = [[5, 0.10], [10, 0.30], [25, 0.30], [50, 0.20], [100, 0.10]];
async function liqMap(ex, pair, market) {
  const iv = ex.intervals.includes('1h') ? '1h' : ex.intervals[ex.intervals.length - 1];
  const c = await ex.candles(pair, market, iv, 500);
  const n = c.length;
  if (n < 30) throw new Error('Not enough candles');
  const price = c[n - 1].close;
  const sufLow = new Array(n + 1).fill(Infinity), sufHigh = new Array(n + 1).fill(-Infinity);
  for (let i = n - 1; i >= 0; i--) { sufLow[i] = Math.min(sufLow[i + 1], c[i].low); sufHigh[i] = Math.max(sufHigh[i + 1], c[i].high); }
  const lo = price * 0.82, hi = price * 1.18, B = 90, step = (hi - lo) / B;
  const longs = new Array(B).fill(0), shorts = new Array(B).fill(0);
  for (let i = 0; i < n - 1; i++) {
    const k = c[i], p = (k.high + k.low + k.close) / 3, w = k.volume * p;
    const up = k.close >= k.open, wl = w * (up ? 0.6 : 0.4), ws = w - wl;
    for (const [L, share] of LEV) {
      const lp = p * (1 - 0.9 / L), sp = p * (1 + 0.9 / L);
      if (lp < sufLow[i + 1] && lp >= lo && lp < price) longs[Math.min(B - 1, Math.floor((lp - lo) / step))] += wl * share;
      if (sp > sufHigh[i + 1] && sp <= hi && sp > price) shorts[Math.min(B - 1, Math.floor((sp - lo) / step))] += ws * share;
    }
  }
  const max = Math.max(1, ...longs, ...shorts);
  const bins = [];
  for (let b = 0; b < B; b++) bins.push({ p: lo + (b + 0.5) * step, long: longs[b] / max, short: shorts[b] / max });
  return { price, lo, hi, interval: iv, bins };
}

async function coinPayload(exId, pair, market) {
  const ex = exById(exId);
  if (!ex.markets.includes(market)) market = ex.markets[0];
  const st = getState(ex.id, market);
  const out = { ex: ex.id, pair, market, trade: {} };
  for (const e of EXCHANGES) for (const m of e.markets) { out.trade[e.id + '|' + m] = e.tradeUrl(pair, m); }
  const jobs = [cached(`t|${ex.id}|${market}|${pair}`, 2000, () => ex.ticker(pair, market)).then((t) => { out.ticker = t; }).catch((e) => { out.tickerError = e.message; })];
  if (market === 'futures') {
    jobs.push(cached(`f|${ex.id}|${pair}`, 2500, () => ex.futuresInfo(pair)).then((f) => { out.futures = f; }).catch(() => { }));
    if (ex.markets.includes('spot')) jobs.push(cached(`t|${ex.id}|spot|${pair}`, 2000, () => ex.ticker(pair, 'spot')).then((t) => { out.spot = t.last; }).catch(() => { }));
  }
  jobs.push(geckoMap().then((m) => { const c = m.get(baseSymbol(pair)); if (c) out.cap = { cap: c.market_cap, rank: c.market_cap_rank, fdv: c.fully_diluted_valuation, circ: c.circulating_supply, total: c.total_supply, max: c.max_supply, ath: c.ath, athPct: c.ath_change_percentage, name: c.name }; }).catch(() => { }));
  await Promise.all(jobs);
  const t = out.ticker || st.tickers.get(pair);
  if (market === 'futures' && t) {
    out.derived = st.tracker.compute(Date.now(), pair, t);
    out.warmupMin = st.tracker.warmupMin(Date.now());
    out.liqLive = st.tracker.liqLive(Date.now());
  }
  return out;
}


/* ------------------------------------------------------------------ request handler (same shape as the old /api routes) */
const PAIR_RE = /^[A-Z0-9]{1,20}\/[A-Z]{3,5}$/;
function bad(msg) { const e = new Error(msg); e.status = 400; return e; }
async function handle(path, q) {
  if (path === '/api/exchanges') return EXCHANGES.map((e) => ({ id: e.id, name: e.name, markets: e.markets, intervals: e.intervals }));
  if (path === '/api/markets') return marketsPayload(getState(q.get('ex'), q.get('market') || 'spot'));
  const pair = q.get('pair') || '';
  if (path === '/api/coin') { if (!PAIR_RE.test(pair)) throw bad('bad pair'); return coinPayload(q.get('ex'), pair, q.get('market') || 'spot'); }
  if (path === '/api/liqmap') {
    const ex = exById(q.get('ex'));
    if (!PAIR_RE.test(pair)) throw bad('bad pair');
    const market = ex.markets.includes('futures') ? 'futures' : ex.markets[0];
    const out = await cached(`lm|${ex.id}|${pair}`, 60000, () => liqMap(ex, pair, market));
    const st = getState(ex.id, market), now = Date.now();
    let l = 0, s = 0;
    for (const e of st.tracker.liqs.get(pair) || []) if (now - e.t <= LIQ_MS) { if (e.short) s += e.usd; else l += e.usd; }
    return Object.assign({}, out, { recent: { live: st.tracker.liqLive(now), longUsd: l, shortUsd: s } });
  }
  if (path === '/api/candles') {
    const ex = exById(q.get('ex')), iv = q.get('interval') || '15m';
    let market = q.get('market') || 'spot';
    if (!ex.markets.includes(market)) market = ex.markets[0];
    if (!PAIR_RE.test(pair) || !ex.intervals.includes(iv)) throw bad('bad request');
    const limit = Math.min(Math.max(parseInt(q.get('limit') || '300', 10) || 300, 20), 500);
    return cached(`c|${ex.id}|${market}|${pair}|${iv}|${limit}`, 2500, () => ex.candles(pair, market, iv, limit));
  }
  const e = new Error('not found'); e.status = 404; throw e;
}
return { handle, MOCK, EXCHANGES_INFO: () => EXCHANGES.map((e) => ({ id: e.id, name: e.name, markets: e.markets, intervals: e.intervals })) };
});
