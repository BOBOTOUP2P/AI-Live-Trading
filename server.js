const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

// ទាញយក API KEYS ដោយសម្ងាត់ពី Render Environment
const GEMINI_KEY = process.env.GEMINI_KEY;
const OR_KEY     = process.env.OR_KEY;
const GROQ_KEY   = process.env.GROQ_KEY;

async function fetchWithTimeout(url, options = {}, timeoutMs = 5500) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

// =========================================================================
// ១. សន្ទស្សន៍ប្រាក់ដុល្លារអាមេរិក (US DOLLAR INDEX - DXY LIVE ENGINE)
// =========================================================================
let dxyCache = { timestamp: 0, data: null };

async function getLiveDXY() {
  const now = Date.now();
  if (dxyCache.data && (now - dxyCache.timestamp) < 30 * 1000) {
    return dxyCache.data;
  }

  const yahooSymbols = ['DX-Y.NYB', 'DX=F'];
  for (const sym of yahooSymbols) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=15m&range=1d`;
      const res = await fetchWithTimeout(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      if (res.ok) {
        const json = await res.json();
        const meta = json?.chart?.result?.[0]?.meta;
        if (meta && meta.regularMarketPrice) {
          const price = parseFloat(meta.regularMarketPrice);
          const prevClose = parseFloat(meta.chartPreviousClose || meta.previousClose || price);
          const change = price - prevClose;
          const changePct = prevClose ? (change / prevClose) * 100 : 0;
          const quotes = json.chart.result[0]?.indicators?.quote?.[0] || {};
          const highs = (quotes.high || []).filter(Boolean);
          const lows = (quotes.low || []).filter(Boolean);

          const result = {
            success: true,
            symbol: 'DXY',
            price: price.toFixed(3),
            change: change.toFixed(3),
            changePct: changePct.toFixed(2),
            high: (highs.length ? Math.max(...highs) : price).toFixed(3),
            low: (lows.length ? Math.min(...lows) : price).toFixed(3),
            trend: change >= 0 ? 'UP' : 'DOWN',
            source: 'Yahoo Finance'
          };
          dxyCache = { timestamp: now, data: result };
          return result;
        }
      }
    } catch (e) {}
  }

  try {
    const res = await fetchWithTimeout('https://api.frankfurter.app/latest?from=USD&to=EUR,JPY,GBP,CAD,CHF');
    if (res.ok) {
      const json = await res.json();
      if (json.rates) {
        const eur = json.rates.EUR || 0.92;
        const jpy = json.rates.JPY || 150;
        const gbp = json.rates.GBP || 0.79;
        const cad = json.rates.CAD || 1.36;
        const chf = json.rates.CHF || 0.88;
        const synthDxy = 50.14348112 * Math.pow(eur, 0.576) * Math.pow(jpy, 0.136) * Math.pow(gbp, 0.119) * Math.pow(cad, 0.091) * Math.pow(chf, 0.036);
        const result = {
          success: true, symbol: 'DXY', price: synthDxy.toFixed(3), change: '0.000', changePct: '0.00',
          high: synthDxy.toFixed(3), low: synthDxy.toFixed(3), trend: 'NEUTRAL', source: 'FX Basket'
        };
        dxyCache = { timestamp: now, data: result };
        return result;
      }
    }
  } catch (e) {}

  return dxyCache.data || { success: false, symbol: 'DXY', price: '--', changePct: '0.00', trend: 'NEUTRAL', source: 'Offline' };
}

app.get('/api/dxy', async (req, res) => {
  const dxy = await getLiveDXY();
  res.json(dxy);
});

// =========================================================================
// ២. FOREX FACTORY CALENDAR + MULTI-SOURCE BREAKING NEWS RSS
// =========================================================================
let ffCache = { timestamp: 0, events: [] };
let rssCache = { timestamp: 0, headlines: [] };

async function getForexFactoryUSDNews() {
  const now = Date.now();
  if (ffCache.events.length > 0 && (now - ffCache.timestamp) < 10 * 60 * 1000) {
    return ffCache.events;
  }

  try {
    const res = await fetchWithTimeout('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
    if (res.ok) {
      const allEvents = await res.json();
      if (Array.isArray(allEvents)) {
        const usdEvents = allEvents
          .filter(ev => ev.country === 'USD' && (ev.impact === 'High' || ev.impact === 'Medium'))
          .map(ev => {
            const eventMs = new Date(ev.date).getTime();
            const khTime = new Date(eventMs).toLocaleString('en-GB', {
              timeZone: 'Asia/Phnom_Penh',
              day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
            });
            return {
              title: ev.title,
              impact: ev.impact,
              timestamp: eventMs,
              khTime: khTime,
              forecast: ev.forecast || '--',
              previous: ev.previous || '--',
              actual: ev.actual || ''
            };
          })
          .sort((a, b) => a.timestamp - b.timestamp);

        ffCache = { timestamp: now, events: usdEvents };
        return usdEvents;
      }
    }
  } catch (e) {}
  return ffCache.events;
}

function parseRssItems(xmlText, sourceName) {
  const items = [];
  const itemMatches = xmlText.match(/<item>[\s\S]*?<\/item>/gi) || [];
  for (const raw of itemMatches.slice(0, 8)) {
    const titleMatch = raw.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    const dateMatch = raw.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    if (titleMatch && titleMatch[1]) {
      const cleanTitle = titleMatch[1]
        .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, '').trim();
      const ts = dateMatch ? new Date(dateMatch[1]).getTime() : Date.now();
      items.push({ source: sourceName, title: cleanTitle, timestamp: ts });
    }
  }
  return items;
}

async function getBreakingGoldMacroNews() {
  const now = Date.now();
  if (rssCache.headlines.length > 0 && (now - rssCache.timestamp) < 5 * 60 * 1000) {
    return rssCache.headlines;
  }

  const feeds = [
    { name: 'Yahoo Gold/USD', url: 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=GC=F,DX-Y.NYB&region=US&lang=en-US' },
    { name: 'FXStreet', url: 'https://www.fxstreet.com/rss/news' }
  ];

  let collected = [];
  const settled = await Promise.allSettled(
    feeds.map(async (f) => {
      const res = await fetchWithTimeout(f.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (res.ok) {
        const xml = await res.text();
        return parseRssItems(xml, f.name);
      }
      return [];
    })
  );

  settled.forEach(s => {
    if (s.status === 'fulfilled' && Array.isArray(s.value)) collected = collected.concat(s.value);
  });

  const keywords = /gold|xau|dollar|usd|dxy|fed|cpi|nfp|inflation|rate|powell|jobs|treasury|yield|bullion/i;
  const filtered = collected
    .filter(item => keywords.test(item.title))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 6);

  const finalList = filtered.length > 0 ? filtered : collected.slice(0, 5);
  if (finalList.length > 0) {
    rssCache = { timestamp: now, headlines: finalList };
  }
  return rssCache.headlines;
}

app.get('/api/news', async (req, res) => {
  const [events, breaking] = await Promise.all([getForexFactoryUSDNews(), getBreakingGoldMacroNews()]);
  const now = Date.now();
  const relevant = events.filter(ev => ev.timestamp >= now - 2 * 3600 * 1000).slice(0, 8);
  res.json({ success: true, events: relevant, breaking });
});

// =========================================================================
// ៣. MARKET DATA PROXY (4h, 2h, 15m)
// =========================================================================
async function fetchMultiExchangeCandles(bybitInterval, okxBar, gateInterval, limit = 100) {
  try {
    const bRes = await fetchWithTimeout(`https://api.bybit.com/v5/market/kline?category=linear&symbol=XAUTUSDT&interval=${bybitInterval}&limit=${limit}`);
    if (bRes.ok) {
      const bJson = await bRes.json();
      if (bJson.retCode === 0 && bJson.result?.list?.length > 0) {
        return { source: 'Bybit', list: bJson.result.list };
      }
    }
  } catch (e) {}

  try {
    const oRes = await fetchWithTimeout(`https://www.okx.com/api/v5/market/candles?instId=XAUT-USDT-SWAP&bar=${okxBar}&limit=${Math.min(300, limit)}`);
    if (oRes.ok) {
      const oJson = await oRes.json();
      if (oJson.code === '0' && oJson.data?.length > 0) {
        return { source: 'OKX', list: oJson.data.map(c => [c[0], c[1], c[2], c[3], c[4], c[5], c[7]]) };
      }
    }
  } catch (e) {}

  try {
    const actualGateInt = gateInterval === '2h' ? '1h' : gateInterval;
    const gRes = await fetchWithTimeout(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=XAUT_USDT&interval=${actualGateInt}&limit=${Math.min(1000, limit * 2)}`);
    if (gRes.ok) {
      const gData = await gRes.json();
      if (Array.isArray(gData) && gData.length > 0) {
        if (gateInterval !== '2h') {
          return {
            source: 'Gate.io',
            list: gData.map(c => [String(c.t * 1000), String(c.o), String(c.h), String(c.l), String(c.c), String(c.v || 0), String(c.sum || 0)]).reverse()
          };
        }
        const grouped = new Map();
        gData.forEach(c => {
          const t2h = c.t - (c.t % 7200);
          if (!grouped.has(t2h)) grouped.set(t2h, { t: t2h, o: parseFloat(c.o), h: parseFloat(c.h), l: parseFloat(c.l), c: parseFloat(c.c), v: parseFloat(c.v || 0), sum: parseFloat(c.sum || 0) });
          else {
            const cur = grouped.get(t2h);
            cur.h = Math.max(cur.h, parseFloat(c.h)); cur.l = Math.min(cur.l, parseFloat(c.l));
            cur.c = parseFloat(c.c); cur.v += parseFloat(c.v || 0); cur.sum += parseFloat(c.sum || 0);
          }
        });
        return {
          source: 'Gate.io',
          list: Array.from(grouped.values()).map(x => [String(x.t * 1000), String(x.o), String(x.h), String(x.l), String(x.c), String(x.v), String(x.sum)]).reverse()
        };
      }
    }
  } catch (e) {}

  return { source: 'none', list: [] };
}

app.get('/api/klines', async (req, res) => {
  const { interval = '120' } = req.query;
  const fb = await fetchMultiExchangeCandles(interval, '2H', '2h', 1000);
  res.json({ retCode: 0, source: fb.source, result: { list: fb.list } });
});

app.get('/api/ticker', async (req, res) => {
  const { symbol = 'XAUTUSDT' } = req.query;
  try {
    const bRes = await fetchWithTimeout(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`);
    if (bRes.ok) {
      const bJson = await bRes.json();
      if (bJson.retCode === 0 && bJson.result?.list?.[0]) return res.json(bJson);
    }
    const gRes = await fetchWithTimeout('https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=XAUT_USDT');
    if (gRes.ok) {
      const gArr = await gRes.json();
      const g = gArr[0];
      if (g) {
        return res.json({
          retCode: 0,
          result: {
            list: [{
              lastPrice: g.last, markPrice: g.mark_price, highPrice24h: g.high_24h, lowPrice24h: g.low_24h,
              turnover24h: String(parseFloat(g.volume_24h_settle || 0)),
              price24hPcnt: String(parseFloat(g.change_percentage || 0) / 100)
            }]
          }
        });
      }
    }
    res.status(500).json({ error: 'Ticker unavailable' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch ticker' });
  }
});

// =========================================================================
// ៤. ក្បួនគណនា MULTI-TIMEFRAME (4h + 2h + 15m) & AI COUNCIL
// =========================================================================
function calcIndicators(candles) {
  if (!candles || candles.length < 5) return { ema7: '--', ema25: '--', rsi14: '--', recentHigh: '--', recentLow: '--', trend: 'NEUTRAL' };
  const closes = candles.map(c => c.close);
  const calcEMA = (period) => {
    const k = 2 / (period + 1);
    let ema = closes[0];
    for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
    return ema;
  };
  let gains = 0, losses = 0;
  const start = Math.max(1, closes.length - 14);
  for (let i = start; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const rs = losses === 0 ? 100 : (gains / 14) / (losses / 14);
  const rsi = 100 - (100 / (1 + rs));
  const recentHigh = Math.max(...candles.slice(-24).map(c => c.high));
  const recentLow = Math.min(...candles.slice(-24).map(c => c.low));
  const e7 = calcEMA(7), e25 = calcEMA(25);

  return {
    ema7: e7.toFixed(2),
    ema25: e25.toFixed(2),
    rsi14: rsi.toFixed(1),
    recentHigh: recentHigh.toFixed(2),
    recentLow: recentLow.toFixed(2),
    trend: e7 > e25 ? 'BULLISH' : 'BEARISH'
  };
}

function parseAIJson(rawText, currentPrice) {
  try {
    let clean = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) {
      const obj = JSON.parse(match[0]);
      return {
        signal: (obj.signal || 'WAIT').toUpperCase().includes('BUY') ? 'BUY' : (obj.signal || '').toUpperCase().includes('SELL') ? 'SELL' : 'WAIT',
        confidence: Math.min(99, Math.max(50, parseInt(obj.confidence) || 82)),
        entry: parseFloat(obj.entry) || currentPrice,
        tp: parseFloat(obj.tp) || (currentPrice + 35),
        sl: parseFloat(obj.sl) || (currentPrice - 18),
        reason_km: obj.reason_km || "វិភាគតាមរចនាសម្ព័ន្ធទៀនពហុម៉ោង និងសន្ទស្សន៍ប្រាក់ដុល្លារ។"
      };
    }
  } catch (e) {}
  return {
    signal: 'WAIT', confidence: 70, entry: currentPrice, tp: currentPrice + 30, sl: currentPrice - 15,
    reason_km: "ទីផ្សារកំពុងប្រែប្រួល រង់ចាំសញ្ញាណបំបែកតំបន់ច្បាស់លាស់។"
  };
}

const SCAN_INTERVAL_MS = 30 * 60 * 1000;
let councilState = { round: 0, lastScanTime: 0, nextScanTime: 0, previousConsensus: null, latestResponse: null };
let activeScanPromise = null;

async function executeCouncilScan(clientCandles2h) {
  const [res4h, res15m, dxyData, ffEvents, rssNews] = await Promise.all([
    fetchMultiExchangeCandles('240', '4H', '4h', 60),
    fetchMultiExchangeCandles('15', '15m', '15m', 60),
    getLiveDXY(),
    getForexFactoryUSDNews(),
    getBreakingGoldMacroNews()
  ]);

  let candles2h = clientCandles2h;
  if (!candles2h || candles2h.length < 10) {
    const fb2h = await fetchMultiExchangeCandles('120', '2H', '2h', 60);
    candles2h = fb2h.list.reverse().slice(-60).map(c => ({
      open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]), vol: parseFloat(c[5] || 0)
    }));
  }
  if (!candles2h || candles2h.length === 0) throw new Error("No 2h candle data available");

  const toCandles = (list) => list.reverse().slice(-60).map(c => ({
    open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4])
  }));

  const ind4h  = calcIndicators(toCandles(res4h.list));
  const ind2h  = calcIndicators(candles2h);
  const ind15m = calcIndicators(toCandles(res15m.list));

  councilState.round += 1;
  const round = councilState.round;
  const previousVerdict = councilState.previousConsensus;

  const last = candles2h[candles2h.length - 1];
  const last8_2h = candles2h.slice(-8).map(c => `[O:${c.open},H:${c.high},L:${c.low},C:${c.close}]`).join(' ');

  const nowMs = Date.now();
  const nearFF = ffEvents.filter(n => Math.abs(n.timestamp - nowMs) <= 6 * 3600 * 1000).slice(0, 4);
  const ffSummary = nearFF.length > 0
    ? nearFF.map(n => {
        const diffMin = Math.round((n.timestamp - nowMs) / 60000);
        const timing = diffMin >= 0 ? `in ${diffMin}m` : `${Math.abs(diffMin)}m ago`;
        return `${n.impact} USD: "${n.title}" (${timing}, Fcst:${n.forecast}, Prev:${n.previous}${n.actual ? ', Actual:' + n.actual : ''})`;
      }).join(' | ')
    : "No major USD calendar events within ±6h.";

  const rssSummary = rssNews.length > 0
    ? rssNews.slice(0, 4).map(r => `[${r.source}] ${r.title}`).join(' | ')
    : "No breaking headlines.";

  const dxySummary = dxyData.success
    ? `DXY (US Dollar Index): ${dxyData.price} (${dxyData.changePct >= 0 ? '+' : ''}${dxyData.changePct}%, Trend: ${dxyData.trend} — Gold moves INVERSE to DXY)`
    : "DXY unavailable.";

  const verifyNote = previousVerdict
    ? `Previous 30m consensus was ${previousVerdict.signal} at $${previousVerdict.entry}. Verify if setup is CONFIRMED or REVERSED.`
    : `Round 1 initial scan.`;

  const prompt = `You are an elite Institutional Gold Futures (XAUTUSDT) Trader using Top-Down Multi-Timeframe + DXY + Macro News.
Current Gold Price: ${last.close}
${dxySummary}

MULTI-TIMEFRAME CONTEXT (Hidden Engine):
- 4H Macro Trend: ${ind4h.trend} | EMA7:${ind4h.ema7} EMA25:${ind4h.ema25} RSI:${ind4h.rsi14}
- 2H Primary Chart: ${ind2h.trend} | EMA7:${ind2h.ema7} EMA25:${ind2h.ema25} RSI:${ind2h.rsi14} | 48h High:${ind2h.recentHigh} Low:${ind2h.recentLow}
- 15m Entry Timing: ${ind15m.trend} | EMA7:${ind15m.ema7} EMA25:${ind15m.ema25} RSI:${ind15m.rsi14}
Last 8 Candles (2h): ${last8_2h}

MACRO & BREAKING NEWS:
- Forex Factory Calendar: ${ffSummary}
- Live Gold/USD Breaking RSS: ${rssSummary}
Context: ${verifyNote}

Rules:
- Combine 4H+2H+15m alignment, inverse DXY pressure, and breaking news/Forex Factory data.
- Do NOT hold back or output WAIT solely because major news (like CPI/NFP) is approaching; provide clear directional analysis (BUY or SELL) with smart 2h Entry, TP, and SL levels unless price action has zero edge.
- Respond ONLY with valid JSON:
{
  "signal": "BUY" or "SELL" or "WAIT",
  "confidence": 80-98,
  "entry": number,
  "tp": number,
  "sl": number,
  "reason_km": "សរសេរការវិភាគរួមរវាង 4h/2h/15m, សន្ទស្សន៍ DXY និងព័ត៌មានសង្ខេប ២ ប្រយោគជាភាសាខ្មែរច្បាស់លាស់"
}`;

  const callGemini = async () => {
    if (!GEMINI_KEY) throw new Error("Missing GEMINI_KEY");
    const r = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    }, 12000);
    const d = await r.json();
    const txt = d.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return { id: 'gemini', name: 'Gemini', ok: r.ok && !!txt, ...parseAIJson(txt, last.close) };
  };

  const callNemotronWithBackup = async () => {
    try {
      if (OR_KEY) {
        const r = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST', headers: { 'Authorization': `Bearer ${OR_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'nvidia/nemotron-3-ultra-550b-a55b:free', messages: [{ role: 'user', content: prompt }] })
        }, 12000);
        const d = await r.json();
        const txt = d.choices?.[0]?.message?.content || "";
        if (r.ok && txt) return { id: 'nemotron', name: 'Nemotron', ok: true, ...parseAIJson(txt, last.close) };
      }
    } catch (e) {}

    if (GROQ_KEY) {
      const r2 = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'openai/gpt-oss-20b', messages: [{ role: 'user', content: prompt }], temperature: 0.3 })
      }, 10000);
      const d2 = await r2.json();
      const txt2 = d2.choices?.[0]?.message?.content || "";
      if (r2.ok && txt2) return { id: 'nemotron', name: 'Nemotron (Backup)', ok: true, ...parseAIJson(txt2, last.close) };
    }
    throw new Error("Nemotron & Backup unavailable");
  };

  const callGPT = async () => {
    if (!GROQ_KEY) throw new Error("Missing GROQ_KEY");
    const r = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: prompt }], temperature: 0.3 })
    }, 12000);
    const d = await r.json();
    const txt = d.choices?.[0]?.message?.content || "";
    return { id: 'gpt120b', name: 'GPT-120B', ok: r.ok && !!txt, ...parseAIJson(txt, last.close) };
  };

  const callQwen = async () => {
    if (!GROQ_KEY) throw new Error("Missing GROQ_KEY");
    const r = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen/qwen3.8-27b', messages: [{ role: 'user', content: prompt }], temperature: 0.3 })
    }, 12000);
    const d = await r.json();
    const txt = d.choices?.[0]?.message?.content || "";
    return { id: 'qwen', name: 'Qwen 3.8', ok: r.ok && !!txt, ...parseAIJson(txt, last.close) };
  };

  const settled = await Promise.allSettled([callGemini(), callNemotronWithBackup(), callGPT(), callQwen()]);
  const results = settled.map((s, idx) => {
    const fallbacks = ['gemini', 'nemotron', 'gpt120b', 'qwen'];
    const names = ['Gemini', 'Nemotron', 'GPT-120B', 'Qwen 3.8'];
    if (s.status === 'fulfilled') return s.value;
    return { id: fallbacks[idx], name: names[idx], ok: false, signal: 'WAIT', confidence: 65, entry: last.close, tp: last.close + 30, sl: last.close - 15, reason_km: 'កំពុងភ្ជាប់ឡើងវិញ...' };
  });

  let buyVotes = 0, sellVotes = 0, waitVotes = 0;
  results.forEach(r => { if (r.signal === 'BUY') buyVotes++; else if (r.signal === 'SELL') sellVotes++; else waitVotes++; });

  let masterSignal = 'WAIT', voteCount = waitVotes;
  if (buyVotes >= sellVotes && buyVotes > waitVotes) { masterSignal = 'BUY'; voteCount = buyVotes; }
  else if (sellVotes > buyVotes && sellVotes > waitVotes) { masterSignal = 'SELL'; voteCount = sellVotes; }

  const aligned = results.filter(r => r.signal === masterSignal);
  const avgEntry = (aligned.reduce((a, b) => a + b.entry, 0) / aligned.length).toFixed(2);
  const avgTp    = (aligned.reduce((a, b) => a + b.tp, 0) / aligned.length).toFixed(2);
  const avgSl    = (aligned.reduce((a, b) => a + b.sl, 0) / aligned.length).toFixed(2);
  const avgConf  = Math.round(aligned.reduce((a, b) => a + b.confidence, 0) / aligned.length);

  const responsePayload = {
    success: true,
    round,
    timestamp: nowMs,
    market: { price: last.close, ...ind2h, dxy: dxyData },
    models: results,
    consensus: {
      signal: masterSignal,
      votes: `${voteCount}/4`,
      confidence: avgConf,
      entry: avgEntry,
      tp: avgTp,
      sl: avgSl,
      verifiedWithPrev: previousVerdict ? (previousVerdict.signal === masterSignal ? 'CONFIRMED' : 'CHANGED') : 'INITIAL'
    },
    prevSignal: previousVerdict ? previousVerdict.signal : null
  };

  councilState.lastScanTime = nowMs;
  councilState.nextScanTime = nowMs + SCAN_INTERVAL_MS;
  councilState.previousConsensus = { signal: masterSignal, entry: avgEntry, tp: avgTp, sl: avgSl };
  councilState.latestResponse = responsePayload;

  return responsePayload;
}

app.post('/api/ai-council', async (req, res) => {
  const now = Date.now();
  const { candles: clientCandles = [] } = req.body || {};

  try {
    if (councilState.latestResponse && now < councilState.nextScanTime) {
      const remainingSeconds = Math.max(1, Math.ceil((councilState.nextScanTime - now) / 1000));
      return res.json({ ...councilState.latestResponse, remainingSeconds, fromCache: true });
    }

    if (!activeScanPromise) {
      activeScanPromise = executeCouncilScan(clientCandles).finally(() => {
        activeScanPromise = null;
      });
    }

    const result = await activeScanPromise;
    const remainingSeconds = Math.max(1, Math.ceil((councilState.nextScanTime - Date.now()) / 1000));
    res.json({ ...result, remainingSeconds, fromCache: false });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.listen(PORT, () => console.log(`Server running on port ${PORT} - DXY + MTF + Multi-News Ready`));
