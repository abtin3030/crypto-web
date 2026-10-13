/* Indicator maths shared by the server (scanner) and the browser (charts). NaN = not enough data yet. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Ind = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var NaNv = NaN;

  function rsiVal(ag, al) { return al === 0 ? 100 : 100 - 100 / (1 + ag / al); }

  // Wilder RSI
  function rsi(c, period) {
    period = period || 14;
    var out = new Array(c.length).fill(NaNv);
    if (c.length <= period) return out;
    var gain = 0, loss = 0, i;
    for (i = 1; i <= period; i++) { var ch = c[i] - c[i - 1]; if (ch >= 0) gain += ch; else loss -= ch; }
    var ag = gain / period, al = loss / period;
    out[period] = rsiVal(ag, al);
    for (i = period + 1; i < c.length; i++) {
      var d = c[i] - c[i - 1];
      ag = (ag * (period - 1) + Math.max(d, 0)) / period;
      al = (al * (period - 1) + Math.max(-d, 0)) / period;
      out[i] = rsiVal(ag, al);
    }
    return out;
  }

  function sma(a, p) {
    var out = new Array(a.length).fill(NaNv);
    for (var i = p - 1; i < a.length; i++) {
      var s = 0, ok = true;
      for (var j = i - p + 1; j <= i; j++) { if (isNaN(a[j])) { ok = false; break; } s += a[j]; }
      if (ok) out[i] = s / p;
    }
    return out;
  }

  // Stochastic RSI (14, 14, 3, 3) -> {k, d} on a 0..100 scale
  function stochRsi(c, rsiLen, stochLen, kLen, dLen) {
    rsiLen = rsiLen || 14; stochLen = stochLen || 14; kLen = kLen || 3; dLen = dLen || 3;
    var r = rsi(c, rsiLen);
    var st = new Array(c.length).fill(NaNv);
    for (var i = rsiLen + stochLen - 1; i < c.length; i++) {
      var hi = -Infinity, lo = Infinity;
      for (var j = i - stochLen + 1; j <= i; j++) { hi = Math.max(hi, r[j]); lo = Math.min(lo, r[j]); }
      st[i] = hi - lo < 1e-12 ? 50 : (r[i] - lo) / (hi - lo) * 100;
    }
    var k = sma(st, kLen);
    return { k: k, d: sma(k, dLen) };
  }

  // Bollinger bands (20, 2 sigma) -> {up, mid, lo}
  function bollinger(c, period, mult) {
    period = period || 20; mult = mult || 2;
    var up = new Array(c.length).fill(NaNv), lo = up.slice(), mid = up.slice();
    for (var i = period - 1; i < c.length; i++) {
      var s = 0, j;
      for (j = i - period + 1; j <= i; j++) s += c[j];
      var m = s / period, v = 0;
      for (j = i - period + 1; j <= i; j++) v += (c[j] - m) * (c[j] - m);
      var sd = Math.sqrt(v / period);
      mid[i] = m; up[i] = m + mult * sd; lo[i] = m - mult * sd;
    }
    return { up: up, mid: mid, lo: lo };
  }

  var WINDOW = 3;

  /**
   * dir +1 = buy zone (K crossed above D below 30), -1 = sell zone (K crossed below D above 70), within the newest 3 candles.
   * bb: 0 none, 1 a recent candle touched the outer band, 2 a recent candle closed outside it.
   */
  function evaluate(candles, opts) {
    var LOW = (opts && opts.low) || 30, HIGH = (opts && opts.high) || 70;
    var n = candles.length;
    if (n < 60) return null;
    var close = candles.map(function (c) { return c.close; });
    var sr = stochRsi(close), k = sr.k, d = sr.d, bb = bollinger(close);
    var last = n - 1, dir = 0, cross = -1, i;
    for (i = last; i >= Math.max(1, last - WINDOW + 1); i--) {
      if (isNaN(k[i]) || isNaN(d[i]) || isNaN(k[i - 1]) || isNaN(d[i - 1])) continue;
      if (k[i - 1] <= d[i - 1] && k[i] > d[i] && k[i] < LOW && d[i] < LOW) { dir = 1; cross = i; break; }
      if (k[i - 1] >= d[i - 1] && k[i] < d[i] && k[i] > HIGH && d[i] > HIGH) { dir = -1; cross = i; break; }
    }
    if (!dir) return null;
    var touch = 0;
    for (var j = last; j >= Math.max(0, last - WINDOW + 1); j--) {
      var c = candles[j];
      if (dir > 0 && !isNaN(bb.lo[j])) { if (c.close < bb.lo[j]) touch = Math.max(touch, 2); else if (c.low <= bb.lo[j]) touch = Math.max(touch, 1); }
      if (dir < 0 && !isNaN(bb.up[j])) { if (c.close > bb.up[j]) touch = Math.max(touch, 2); else if (c.high >= bb.up[j]) touch = Math.max(touch, 1); }
    }
    var barsAgo = last - cross;
    var fresh = (WINDOW - barsAgo) / WINDOW * 40;
    var depth = (dir > 0 ? (LOW - Math.max(k[cross], d[cross])) / LOW : (Math.min(k[cross], d[cross]) - HIGH) / (100 - HIGH));
    depth = Math.min(1, Math.max(0, depth)) * 20;
    return { dir: dir, score: Math.round(fresh + depth + touch * 20), k: k[cross], d: d[cross], barsAgo: barsAgo, bb: touch };
  }

  /**
   * Zone check on the newest candle (no K/D cross needed): K and D both beyond low/high AND price touching, closing outside or
   * within `near` (fraction of band width) of the matching Bollinger band. dir +1 bullish (low zone, lower band), -1 bearish.
   * bb: 1 near, 2 touched, 3 closed outside.
   */
  function zone(candles, opts) {
    var low = (opts && opts.low) || 20, high = (opts && opts.high) || 80, near = (opts && opts.near) || 0.1;
    var n = candles.length;
    if (n < 60) return null;
    var close = candles.map(function (c) { return c.close; });
    var sr = stochRsi(close), bb = bollinger(close), L = n - 1, c = candles[L];
    var k = sr.k[L], d = sr.d[L], up = bb.up[L], lo = bb.lo[L];
    if (isNaN(k) || isNaN(d) || isNaN(up) || isNaN(lo) || up <= lo) return null;
    var w = up - lo, dir = 0, touch = 0;
    if (k < low && d < low) { dir = 1; touch = c.close < lo ? 3 : c.low <= lo ? 2 : (c.close - lo) / w <= near ? 1 : 0; }
    else if (k > high && d > high) { dir = -1; touch = c.close > up ? 3 : c.high >= up ? 2 : (up - c.close) / w <= near ? 1 : 0; }
    if (!dir || !touch) return null;
    var depth = dir > 0 ? (low - Math.max(k, d)) / low : (Math.min(k, d) - high) / (100 - high);
    return { dir: dir, k: k, d: d, bb: touch, score: Math.round(Math.min(1, Math.max(0, depth)) * 50 + touch * 16) };
  }

  // Latest K / D / band position, for the info panel
  function snapshot(candles) {
    var n = candles.length;
    if (n < 40) return null;
    var close = candles.map(function (c) { return c.close; });
    var sr = stochRsi(close), bb = bollinger(close);
    var L = n - 1, c = candles[L];
    var pos = bb.up[L] > bb.lo[L] ? (c.close - bb.lo[L]) / (bb.up[L] - bb.lo[L]) : NaNv; // 0 = lower band, 1 = upper band
    return { k: sr.k[L], d: sr.d[L], up: bb.up[L], lo: bb.lo[L], mid: bb.mid[L], close: c.close, pos: pos };
  }

  return { rsi: rsi, sma: sma, stochRsi: stochRsi, bollinger: bollinger, evaluate: evaluate, zone: zone, snapshot: snapshot };
});
