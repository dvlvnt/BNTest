const express = require("express");
const dotenv  = require("dotenv");
const crypto  = require("crypto");
const axios   = require("axios");
const fs      = require("fs");
const path    = require("path");

dotenv.config();

const app = express();
app.use(express.text({ type: "*/*" }));

/* ───────────────── Config ───────────────── */

const PORT            = Number(process.env.PORT || 3000);
const DEFAULT_SYMBOL  = String(process.env.SYMBOL || "BTCUSDT").toUpperCase();
const QUOTE_PER_TRADE = Number(process.env.QUOTE_PER_TRADE || 50);
const COOLDOWN_MS     = Number(process.env.COOLDOWN_SECONDS || 30) * 1000;
const LEVERAGE          = Number(process.env.LEVERAGE || 5);
const SL_PERCENT        = Number(process.env.SL_PERCENT || 0.2);
const TP_PERCENT        = Number(process.env.TP_PERCENT || 2.5);
const BREAKEVEN_TRIGGER = Number(process.env.BREAKEVEN_TRIGGER || 0.3);
const BREAKEVEN_SECURE  = Number(process.env.BREAKEVEN_SECURE || 0.2);
const MONITOR_MS        = Number(process.env.MONITOR_INTERVAL_MS || 2000);

/* ── ATR Dynamic SL/TP ── */
const USE_ATR      = process.env.USE_ATR === "true";
const ATR_PERIOD   = Number(process.env.ATR_PERIOD || 14);
const ATR_SL_MULT  = Number(process.env.ATR_SL_MULT || 1.5);
const ATR_TP_MULT  = Number(process.env.ATR_TP_MULT || 3.0);

/* ── Trailing Take Profit ── */
const TRAIL_ACTIVATE_PCT = Number(process.env.TRAIL_ACTIVATE_PCT || 1.0);
const TRAIL_DISTANCE_PCT = Number(process.env.TRAIL_DISTANCE_PCT || 0.5);

/* ── Drawdown Guard ── */
const MAX_DAILY_LOSS_PCT     = Number(process.env.MAX_DAILY_LOSS_PCT || 3.0);
const MAX_CONSECUTIVE_LOSSES = Number(process.env.MAX_CONSECUTIVE_LOSSES || 3);

/* ── Adaptive Position Sizing ── */
const ADAPTIVE_SIZING = process.env.ADAPTIVE_SIZING === "true";
const SIZING_LOOKBACK = Number(process.env.SIZING_LOOKBACK || 20);
const MIN_SIZE_MULT   = Number(process.env.MIN_SIZE_MULT || 0.5);
const MAX_SIZE_MULT   = Number(process.env.MAX_SIZE_MULT || 2.0);

const API_KEY    = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const BASE_URL   = "https://testnet.binancefuture.com";

if (!API_KEY || !API_SECRET) {
  console.error("Missing BINANCE_API_KEY / BINANCE_API_SECRET in .env");
  process.exit(1);
}

/* ───────────── Binance Futures API helpers ───────────── */

function sign(queryString) {
  return crypto.createHmac("sha256", API_SECRET).update(queryString).digest("hex");
}

const api = axios.create({
  baseURL: BASE_URL,
  headers: { "X-MBX-APIKEY": API_KEY },
});

async function futuresRequest(method, endpoint, params = {}) {
  params.timestamp = Date.now();
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString();
  const url = `${endpoint}?${qs}&signature=${sign(qs)}`;
  const resp = await api({ method, url });
  return resp.data;
}

/* ───────────── Symbol info cache ───────────── */

const symbolInfoCache = {};

async function getSymbolInfo(symbol) {
  if (symbolInfoCache[symbol]) return symbolInfoCache[symbol];
  const resp = await api.get("/fapi/v1/exchangeInfo");
  const info = resp.data.symbols.find((s) => s.symbol === symbol);
  if (!info) throw new Error(`Symbol ${symbol} not found on exchange`);

  const lot   = info.filters.find((f) => f.filterType === "LOT_SIZE");
  const price = info.filters.find((f) => f.filterType === "PRICE_FILTER");

  symbolInfoCache[symbol] = {
    qtyStep:           Number(lot.stepSize),
    minQty:            Number(lot.minQty),
    priceStep:         Number(price.tickSize),
    pricePrecision:    info.pricePrecision,
    quantityPrecision: info.quantityPrecision,
  };
  return symbolInfoCache[symbol];
}

/* ───────────── Position / Order helpers ───────────── */

async function getPosition(symbol) {
  const positions = await futuresRequest("GET", "/fapi/v2/positionRisk", { symbol });
  return positions.find((p) => p.symbol === symbol && Number(p.positionAmt) !== 0);
}

async function getMarkPrice(symbol) {
  const resp = await api.get("/fapi/v1/premiumIndex", { params: { symbol } });
  return Number(resp.data.markPrice);
}

async function getATR(symbol, interval = "1m", period = ATR_PERIOD) {
  const resp = await api.get("/fapi/v1/klines", {
    params: { symbol, interval, limit: period + 1 },
  });
  const candles = resp.data;
  if (candles.length < 2) return 0;

  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const high      = Number(candles[i][2]);
    const low       = Number(candles[i][3]);
    const prevClose = Number(candles[i - 1][4]);
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);
  }
  return trueRanges.reduce((sum, tr) => sum + tr, 0) / trueRanges.length;
}

let lastATR = { value: 0, ts: 0 };

async function getCachedATR(symbol) {
  if (Date.now() - lastATR.ts < 60_000 && lastATR.value > 0) return lastATR.value;
  const atr = await getATR(symbol);
  lastATR = { value: atr, ts: Date.now() };
  return atr;
}

async function setLeverage(symbol, leverage) {
  try {
    return await futuresRequest("POST", "/fapi/v1/leverage", { symbol, leverage });
  } catch (err) {
    console.log("Leverage note:", err?.response?.data?.msg || err.message);
  }
}

async function cancelAllOrders(symbol) {
  try {
    return await futuresRequest("DELETE", "/fapi/v1/allOpenOrders", { symbol });
  } catch (err) {
    if (err?.response?.data?.code === -2011) return null;
    throw err;
  }
}

async function placeMarketOrder(symbol, side, quantity) {
  return futuresRequest("POST", "/fapi/v1/order", {
    symbol, side, type: "MARKET", quantity, newOrderRespType: "RESULT",
  });
}

async function closePosition(symbol, side, quantity) {
  return futuresRequest("POST", "/fapi/v1/order", {
    symbol, side, type: "MARKET", quantity, reduceOnly: "true",
  });
}

async function getPositionQty(symbol) {
  const pos = await getPosition(symbol);
  return pos ? Math.abs(Number(pos.positionAmt)) : 0;
}

/* ───────────── Precision helpers ───────────── */

function roundStep(value, step) {
  const precision = Math.max(0, Math.ceil(-Math.log10(step)));
  return (Math.floor(value / step) * step).toFixed(precision);
}

function roundPrice(value, pricePrecision) {
  return Number(value).toFixed(pricePrecision);
}

/* ───────────── Trade Logging ───────────── */

const TRADES_FILE = path.join(__dirname, "trades.json");

function loadTrades() {
  try {
    return JSON.parse(fs.readFileSync(TRADES_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveTrades(trades) {
  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
}

function logTrade(trade) {
  const trades = loadTrades();
  trades.push(trade);
  saveTrades(trades);
}

function closeOpenTrade(symbol, exitReason, exitPrice) {
  const trades = loadTrades();
  const openTrade = trades.find((t) => t.symbol === symbol && t.status === "OPEN");
  if (!openTrade) return;

  const qty = Number(openTrade.quantity);
  const pnl = openTrade.action === "LONG"
    ? (exitPrice - openTrade.entryPrice) * qty
    : (openTrade.entryPrice - exitPrice) * qty;
  const pnlPercent = openTrade.action === "LONG"
    ? ((exitPrice - openTrade.entryPrice) / openTrade.entryPrice) * 100
    : ((openTrade.entryPrice - exitPrice) / openTrade.entryPrice) * 100;

  openTrade.status      = "CLOSED";
  openTrade.exitPrice   = exitPrice;
  openTrade.exitTime    = Date.now();
  openTrade.exitReason  = exitReason;
  openTrade.pnl         = Number(pnl.toFixed(4));
  openTrade.pnlPercent  = Number(pnlPercent.toFixed(2));

  saveTrades(trades);
  console.log(`Trade closed: ${openTrade.action} ${symbol} | ${exitReason} | PnL: ${pnl.toFixed(4)} USDT`);
}

/* ───────────── Drawdown Guard ───────────── */

function getDrawdownStatus() {
  const trades = loadTrades();
  const closed = trades.filter((t) => t.status === "CLOSED");
  if (closed.length === 0) return { paused: false, reason: null, consecutiveLosses: 0, dailyPnl: 0 };

  const recent = [...closed].reverse();
  let consecutiveLosses = 0;
  for (const t of recent) {
    if ((t.pnl || 0) <= 0) consecutiveLosses++;
    else break;
  }

  if (consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
    return { paused: true, reason: `${consecutiveLosses} art arda kayip`, consecutiveLosses, dailyPnl: 0 };
  }

  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const dailyClosed = closed.filter((t) => (t.exitTime || 0) >= dayAgo);
  const dailyPnl = dailyClosed.reduce((s, t) => s + (t.pnl || 0), 0);

  if (dailyPnl < 0) {
    const lossPct = (Math.abs(dailyPnl) / QUOTE_PER_TRADE) * 100;
    if (lossPct >= MAX_DAILY_LOSS_PCT) {
      return { paused: true, reason: `gunluk kayip ${lossPct.toFixed(1)}% >= ${MAX_DAILY_LOSS_PCT}%`, consecutiveLosses, dailyPnl };
    }
  }

  return { paused: false, reason: null, consecutiveLosses, dailyPnl: Number(dailyPnl.toFixed(4)) };
}

/* ───────────── Adaptive Position Sizing (Kelly) ───────────── */

function calcSizeMultiplier() {
  if (!ADAPTIVE_SIZING) return 1.0;

  const trades = loadTrades();
  const closed = trades.filter((t) => t.status === "CLOSED");
  if (closed.length < 5) return 1.0;

  const sample  = closed.slice(-SIZING_LOOKBACK);
  const wins    = sample.filter((t) => (t.pnl || 0) > 0);
  const losses  = sample.filter((t) => (t.pnl || 0) <= 0);

  const winRate = wins.length / sample.length;
  const avgWin  = wins.length   ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 1;

  const R     = avgLoss > 0 ? avgWin / avgLoss : 1;
  const kelly = R > 0 ? winRate - (1 - winRate) / R : 0;
  const clamped = Math.max(0, Math.min(1, kelly));

  return Number((MIN_SIZE_MULT + clamped * (MAX_SIZE_MULT - MIN_SIZE_MULT)).toFixed(2));
}

/* ───────────── SL/TP Price Monitor ───────────── */

async function monitorSLTP() {
  const trades = loadTrades();
  const openTrades = trades.filter((t) => t.status === "OPEN");

  for (const trade of openTrades) {
    try {
      const pos = await getPosition(trade.symbol);
      const posAmt = pos ? Number(pos.positionAmt) : 0;

      if (posAmt === 0) {
        closeOpenTrade(trade.symbol, "MANUAL", await getMarkPrice(trade.symbol));
        continue;
      }

      const mark = await getMarkPrice(trade.symbol);
      const info = await getSymbolInfo(trade.symbol);
      const absAmt = Math.abs(posAmt);

      const profitPct = trade.action === "LONG"
        ? ((mark - trade.entryPrice) / trade.entryPrice) * 100
        : ((trade.entryPrice - mark) / trade.entryPrice) * 100;

      let currentSlPrice = trade.slPrice;
      let needSave = false;

      /* ── Break-even trailing ── */
      if (profitPct >= BREAKEVEN_TRIGGER && !trade.breakevenApplied) {
        const newSl = trade.action === "LONG"
          ? trade.entryPrice * (1 + BREAKEVEN_SECURE / 100)
          : trade.entryPrice * (1 - BREAKEVEN_SECURE / 100);
        currentSlPrice = Number(roundPrice(newSl, info.pricePrecision));
        trade.slPrice = currentSlPrice;
        trade.breakevenApplied = true;
        needSave = true;
        console.log(`BREAKEVEN: ${trade.action} ${trade.symbol} | SL -> ${currentSlPrice}`);
      }

      /* ── Trailing Take Profit ── */
      if (profitPct >= TRAIL_ACTIVATE_PCT) {
        const hwm = trade.highWaterMark || trade.entryPrice;
        const newHwm = trade.action === "LONG" ? Math.max(hwm, mark) : Math.min(hwm, mark);

        if (newHwm !== hwm || !trade.trailingActive) {
          const trailStop = trade.action === "LONG"
            ? newHwm * (1 - TRAIL_DISTANCE_PCT / 100)
            : newHwm * (1 + TRAIL_DISTANCE_PCT / 100);
          trade.highWaterMark  = newHwm;
          trade.trailStopPrice = Number(roundPrice(trailStop, info.pricePrecision));
          trade.trailingActive = true;
          needSave = true;
        }
      }

      if (needSave) {
        const fresh = loadTrades();
        const ft = fresh.find((t) => t.id === trade.id);
        if (ft && ft.status === "OPEN") {
          ft.slPrice          = trade.slPrice;
          ft.breakevenApplied = trade.breakevenApplied;
          ft.trailingActive   = trade.trailingActive;
          ft.highWaterMark    = trade.highWaterMark;
          ft.trailStopPrice   = trade.trailStopPrice;
          saveTrades(fresh);
        }
      }

      /* ── SL / TP / TRAIL check ── */
      let hit = null;

      if (trade.action === "LONG") {
        if (currentSlPrice && mark <= currentSlPrice) hit = "SL";
        else if (trade.trailStopPrice && trade.trailingActive && mark <= trade.trailStopPrice) hit = "TRAIL";
        else if (trade.tpPrice && mark >= trade.tpPrice) hit = "TP";
      } else {
        if (currentSlPrice && mark >= currentSlPrice) hit = "SL";
        else if (trade.trailStopPrice && trade.trailingActive && mark >= trade.trailStopPrice) hit = "TRAIL";
        else if (trade.tpPrice && mark <= trade.tpPrice) hit = "TP";
      }

      if (hit) {
        const closeSide = trade.action === "LONG" ? "SELL" : "BUY";
        const qty = roundStep(absAmt, info.qtyStep);
        console.log(`${hit} HIT! ${trade.action} ${trade.symbol} @ ${mark} | closing...`);
        const order = await closePosition(trade.symbol, closeSide, qty);
        const exitPrice = Number(order.avgPrice) || mark;
        closeOpenTrade(trade.symbol, hit, exitPrice);
      }
    } catch (err) {
      console.error("Monitor error:", trade.id, err.message);
    }
  }
}

setInterval(monitorSLTP, MONITOR_MS);

/* ───────────── Cooldown & dedup ───────────── */

let lastTradeAt = 0;
const seen = new Map();
const SEEN_TTL = 5 * 60 * 1000;

function cleanSeen() {
  const now = Date.now();
  for (const [k, t] of seen) {
    if (now - t > SEEN_TTL) seen.delete(k);
  }
}

function makeKey(body) {
  const raw = `${body.symbol || ""}|${body.action || ""}|${body.time || ""}|${body.price || ""}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/* ───────────── Parsing ───────────── */

function normalizeAction(action) {
  const a = String(action || "").trim().toUpperCase();
  if (["LONG", "SHORT", "CLOSE_LONG", "CLOSE_SHORT"].includes(a)) return a;
  if (a === "BUY") return "LONG";
  if (a === "SELL") return "SHORT";
  return "";
}

function parseIncomingBody(reqBody) {
  let body = reqBody;
  if (typeof body === "object" && body !== null) return body;
  if (typeof body !== "string") return {};

  body = body.trim();
  if (body.startsWith('"') && body.endsWith('"')) body = body.slice(1, -1);
  body = body.replace(/\\"/g, '"');

  try { return JSON.parse(body); } catch { return {}; }
}

/* ───────────── Routes — Health & Dashboard ───────────── */

app.get("/health", (_, res) => res.json({ ok: true }));

app.get("/dashboard", (_, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/api/trades", (_, res) => {
  res.json(loadTrades());
});

app.get("/api/stats", (_, res) => {
  const trades = loadTrades();
  const closed = trades.filter((t) => t.status === "CLOSED");
  const open   = trades.filter((t) => t.status === "OPEN");

  const wins   = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const slHits = closed.filter((t) => t.exitReason === "SL");
  const tpHits = closed.filter((t) => t.exitReason === "TP");
  const trails = closed.filter((t) => t.exitReason === "TRAIL");
  const revs   = closed.filter((t) => t.exitReason === "REVERSE");
  const manuals = closed.filter((t) => t.exitReason === "MANUAL" || t.exitReason === "UNKNOWN");

  const longs      = closed.filter((t) => t.action === "LONG");
  const shorts     = closed.filter((t) => t.action === "SHORT");
  const longPnl    = longs.reduce((s, t) => s + (t.pnl || 0), 0);
  const shortPnl   = shorts.reduce((s, t) => s + (t.pnl || 0), 0);
  const totalPnl   = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  const avgPnl     = closed.length ? totalPnl / closed.length : 0;
  const maxWin     = closed.length ? Math.max(0, ...closed.map((t) => t.pnl || 0)) : 0;
  const maxLoss    = closed.length ? Math.min(0, ...closed.map((t) => t.pnl || 0)) : 0;

  let cumPnl = 0;
  const equityCurve = closed.map((t) => {
    cumPnl += t.pnl || 0;
    return { time: t.exitTime, pnl: Number(cumPnl.toFixed(4)) };
  });

  const dd       = getDrawdownStatus();
  const sizeMult = calcSizeMultiplier();

  res.json({
    totalTrades:   trades.length,
    openTrades:    open.length,
    closedTrades:  closed.length,
    wins:          wins.length,
    losses:        losses.length,
    winRate:       closed.length ? Number(((wins.length / closed.length) * 100).toFixed(1)) : 0,
    totalPnl:      Number(totalPnl.toFixed(4)),
    avgPnl:        Number(avgPnl.toFixed(4)),
    maxWin:        Number(maxWin.toFixed(4)),
    maxLoss:       Number(maxLoss.toFixed(4)),
    slHits:        slHits.length,
    tpHits:        tpHits.length,
    trailHits:     trails.length,
    reverseCloses: revs.length,
    manualCloses:  manuals.length,
    longCount:     longs.length,
    shortCount:    shorts.length,
    longPnl:       Number(longPnl.toFixed(4)),
    shortPnl:      Number(shortPnl.toFixed(4)),
    equityCurve,
    recentTrades:  [...trades].reverse().slice(0, 50),
    drawdownGuard: dd,
    sizeMult,
    lastATR:       lastATR.value ? Number(lastATR.value.toFixed(2)) : null,
    activeTrail:   open.length ? open.find((t) => t.trailingActive) || null : null,
  });
});

/* ───────────── Route — Webhook ───────────── */

app.post("/webhook", async (req, res) => {
  const body = parseIncomingBody(req.body);
  console.log("WEBHOOK RAW:", req.body);
  console.log("WEBHOOK PARSED:", body);

  try {
    const symbol = String(body.symbol || DEFAULT_SYMBOL).toUpperCase();
    const action = normalizeAction(body.action);

    if (!symbol || !action) {
      return res.status(400).json({
        ok: false,
        error: "bad payload: need symbol + action (LONG/SHORT/CLOSE_LONG/CLOSE_SHORT)",
        received: body,
      });
    }

    const now = Date.now();
    cleanSeen();

    if (now - lastTradeAt < COOLDOWN_MS) {
      return res.json({ ok: true, ignored: true, reason: "cooldown" });
    }

    const key = makeKey(body);
    if (seen.has(key)) {
      return res.json({ ok: true, ignored: true, reason: "duplicate" });
    }
    seen.set(key, now);

    const info = await getSymbolInfo(symbol);
    await setLeverage(symbol, LEVERAGE);

    /* ── Drawdown Guard (only blocks new entries, not closes) ── */
    if (action === "LONG" || action === "SHORT") {
      const dd = getDrawdownStatus();
      if (dd.paused) {
        console.log(`DRAWDOWN GUARD: sinyal reddedildi | ${dd.reason}`);
        return res.json({ ok: true, ignored: true, reason: "drawdown_guard", detail: dd.reason });
      }
    }

    /* ── CLOSE actions ── */
    if (action === "CLOSE_LONG" || action === "CLOSE_SHORT") {
      const pos = await getPosition(symbol);
      if (!pos) {
        return res.json({ ok: true, action, symbol, skipped: true, reason: "no_position" });
      }

      const amt       = Math.abs(Number(pos.positionAmt));
      const closeSide = action === "CLOSE_LONG" ? "SELL" : "BUY";

      await cancelAllOrders(symbol);
      const order = await closePosition(symbol, closeSide, roundStep(amt, info.qtyStep));

      const exitPrice = Number(order.avgPrice) || (await getMarkPrice(symbol));
      closeOpenTrade(symbol, "MANUAL", exitPrice);

      lastTradeAt = now;
      return res.json({ ok: true, action, symbol, order });
    }

    /* ── ENTRY actions (LONG / SHORT) ── */
    const entrySide = action === "LONG" ? "BUY"  : "SELL";
    const exitSide  = action === "LONG" ? "SELL" : "BUY";

    const existingPos = await getPosition(symbol);
    if (existingPos) {
      const posAmt = Number(existingPos.positionAmt);
      const isOpposite =
        (action === "LONG" && posAmt < 0) || (action === "SHORT" && posAmt > 0);
      if (isOpposite) {
        const closeSide = posAmt > 0 ? "SELL" : "BUY";
        await cancelAllOrders(symbol);
        const closeOrder = await closePosition(symbol, closeSide, roundStep(Math.abs(posAmt), info.qtyStep));
        const exitPrice = Number(closeOrder.avgPrice) || (await getMarkPrice(symbol));
        closeOpenTrade(symbol, "REVERSE", exitPrice);
      }
    }

    /* ── Adaptive position sizing ── */
    const sizeMult = calcSizeMultiplier();
    const effectiveQuote = QUOTE_PER_TRADE * sizeMult;

    const price  = Number(body.price) || (await getMarkPrice(symbol));
    const rawQty = (effectiveQuote * LEVERAGE) / price;
    const qty    = roundStep(rawQty, info.qtyStep);

    if (Number(qty) < info.minQty) {
      return res.status(400).json({
        ok: false, error: "quantity below minimum", qty, minQty: info.minQty,
      });
    }

    await cancelAllOrders(symbol);
    const entryOrder = await placeMarketOrder(symbol, entrySide, qty);
    console.log("ENTRY ORDER RESPONSE:", JSON.stringify(entryOrder));
    lastTradeAt = now;

    const filledQty  = (Number(entryOrder.executedQty) > 0 ? entryOrder.executedQty : null)
                       || entryOrder.origQty || qty;
    const entryPrice = Number(entryOrder.avgPrice) || price;

    /* ── SL/TP: ATR dynamic or webhook values or fixed % ── */
    let slPrice = Number(body.sl) || 0;
    let tpPrice = Number(body.tp) || 0;
    let atrValue = 0;

    if (USE_ATR && (!slPrice || !tpPrice)) {
      atrValue = await getCachedATR(symbol);
    }

    if (!slPrice) {
      if (USE_ATR && atrValue > 0) {
        slPrice = action === "LONG" ? price - atrValue * ATR_SL_MULT : price + atrValue * ATR_SL_MULT;
      } else {
        slPrice = action === "LONG" ? price * (1 - SL_PERCENT / 100) : price * (1 + SL_PERCENT / 100);
      }
    }
    if (!tpPrice) {
      if (USE_ATR && atrValue > 0) {
        tpPrice = action === "LONG" ? price + atrValue * ATR_TP_MULT : price - atrValue * ATR_TP_MULT;
      } else {
        tpPrice = action === "LONG" ? price * (1 + TP_PERCENT / 100) : price * (1 - TP_PERCENT / 100);
      }
    }

    slPrice = roundPrice(slPrice, info.pricePrecision);
    tpPrice = roundPrice(tpPrice, info.pricePrecision);

    logTrade({
      id:         `${symbol}_${now}`,
      symbol,
      action,
      entryPrice,
      entryTime:  now,
      quantity:   filledQty,
      slPrice:    Number(slPrice),
      tpPrice:    Number(tpPrice),
      breakevenApplied: false,
      trailingActive:   false,
      highWaterMark:    null,
      trailStopPrice:   null,
      atrValue:         atrValue || null,
      sizeMult,
      exitPrice:  null,
      exitTime:   null,
      exitReason: null,
      pnl:        null,
      pnlPercent: null,
      status:     "OPEN",
    });

    console.log(`TRADE LOGGED: ${action} ${symbol} @ ${entryPrice} | qty: ${filledQty} (x${sizeMult}) | SL: ${slPrice} | TP: ${tpPrice}${atrValue ? ` | ATR: ${atrValue.toFixed(2)}` : ""}`);

    return res.json({
      ok: true, action, symbol,
      entry: entryOrder,
      sl: { price: slPrice, monitored: true, atrBased: USE_ATR && atrValue > 0 },
      tp: { price: tpPrice, monitored: true, atrBased: USE_ATR && atrValue > 0 },
      sizeMult,
      atr: atrValue || null,
    });

  } catch (err) {
    const msg = err?.response?.data?.msg || err?.message || String(err);
    console.error("ERROR:", msg, err?.response?.data || "");
    return res.status(500).json({ ok: false, error: msg });
  }
});

/* ───────────── Start ───────────── */

app.listen(PORT, () => {
  console.log(`FUTURES BOT CALISIYOR -> PORT: ${PORT}`);
  console.log(`Leverage: ${LEVERAGE}x | Quote: $${QUOTE_PER_TRADE}`);
  console.log(`SL: ${USE_ATR ? `ATR(${ATR_PERIOD})x${ATR_SL_MULT}` : SL_PERCENT + "%"} | TP: ${USE_ATR ? `ATR(${ATR_PERIOD})x${ATR_TP_MULT}` : TP_PERCENT + "%"}`);
  console.log(`Breakeven: ${BREAKEVEN_TRIGGER}% -> ${BREAKEVEN_SECURE}% | Trail: ${TRAIL_ACTIVATE_PCT}% act, ${TRAIL_DISTANCE_PCT}% dist`);
  console.log(`Drawdown guard: ${MAX_CONSECUTIVE_LOSSES} consec / ${MAX_DAILY_LOSS_PCT}% daily | Sizing: ${ADAPTIVE_SIZING ? `Kelly (${MIN_SIZE_MULT}-${MAX_SIZE_MULT}x)` : "fixed"}`);
  console.log(`Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`Health:    http://localhost:${PORT}/health`);
});
