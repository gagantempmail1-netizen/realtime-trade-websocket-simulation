/**
 * socketio_ohlc_simulator.js
 *
 * WebSocket OHLC simulator using Socket.IO
 * - Subscribe/unsubscribe per symbol
 * - Sends snapshot on subscribe
 * - Sends real-time updates
 */

const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 8080;
const BROADCAST_INTERVAL_MS = 800;
const MAX_RATE_PER_SECOND = 50;
const IST_OFFSET_MINUTES = 330; // UTC+5:30

// ---------------------------
// INSTRUMENTS BASE DATA
// ---------------------------
const BASE_OHLC = {
  AAPL: { open: 228.5, high: 232.4, low: 227.9, close: 231.85, volume: 58200000 },
  TSLA: { open: 405.2, high: 410.1, low: 404.1, close: 409.35, volume: 23400000 },
  MSFT: { open: 167.8, high: 170.25, low: 167.1, close: 169.95, volume: 26800000 },
  GOOG: { open: 148.5, high: 152.3, low: 147.9, close: 151.75, volume: 51200000 },
  AMZN: { open: 1250.0, high: 1286.4, low: 1245.5, close: 1280.75, volume: 312500000 },
  NVDA: { open: 427.4, high: 432.25, low: 426.1, close: 431.1, volume: 3900000 },
  META: { open: 172.8, high: 175.75, low: 172.2, close: 175.1, volume: 12800000 },
  NFLX: { open: 244.1, high: 248.55, low: 243.2, close: 247.6, volume: 7800000 },
  JPM: { open: 410.2, high: 417.4, low: 409.8, close: 416.25, volume: 3600000 },
  BAC: { open: 32.7, high: 33.25, low: 32.4, close: 33.05, volume: 42600000 },
  INTC: { open: 254.2, high: 261.8, low: 253.1, close: 259.7, volume: 102000000 },
  ORCL: { open: 160.3, high: 163.6, low: 159.85, close: 162.75, volume: 13200000 },
  IBM: { open: 147.4, high: 149.8, low: 146.9, close: 149.1, volume: 7500000 },
  CSCO: { open: 58.4, high: 59.65, low: 58.1, close: 59.2, volume: 14500000 },
  SAP: { open: 168.8, high: 171.9, low: 168.2, close: 171.25, volume: 5850000 },
  ADBE: { open: 155.4, high: 157.85, low: 155.0, close: 157.1, volume: 9200000 },
  UBER: { open: 525.1, high: 531.4, low: 523.8, close: 530.2, volume: 3580000 },
  LYFT: { open: 103.7, high: 106.4, low: 103.1, close: 105.85, volume: 11400000 },
  SNAP: { open: 98.2, high: 100.85, low: 97.8, close: 100.25, volume: 8750000 },
  TWTR: { open: 595.4, high: 612.1, low: 594.3, close: 608.5, volume: 5250000 }
};

// In-memory instrument state
const todayDate = new Date().toISOString().slice(0, 10);
const instruments = {};
for (const symbol in BASE_OHLC) {
  const b = BASE_OHLC[symbol];
  instruments[symbol] = {
    symbol,
    date: todayDate,
    open_price: b.open,
    high_price: b.high,
    low_price: b.low,
    close_price: b.close,
    volume: b.volume,
    ts: new Date().toISOString()
  };
}

// ---------------------------
// Helpers
// ---------------------------
function randPct(maxPct = 0.005) {
  return (Math.random() * 2 - 1) * maxPct;
}

function simulateTick(state) {
  const pct = randPct(0.004);
  const newPrice = +(state.close_price * (1 + pct)).toFixed(4);
  state.close_price = newPrice;
  if (newPrice > state.high_price) state.high_price = newPrice;
  if (newPrice < state.low_price) state.low_price = newPrice;
  state.volume += Math.floor(5000 + Math.random() * 20000);
  state.ts = new Date().toISOString();
  return { ...state };
}

function allowSendRate(meta) {
  const now = Date.now();
  if (!meta.lastWindowStart || now - meta.lastWindowStart > 1000) {
    meta.lastWindowStart = now;
    meta.sentInWindow = 0;
  }
  if (meta.sentInWindow >= MAX_RATE_PER_SECOND) return false;
  meta.sentInWindow++;
  return true;
}

function nowInIST() {
  const now = new Date();
  const utcMillis = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utcMillis + IST_OFFSET_MINUTES * 60000);
}

function isMarketOpenIST() {
  const ist = nowInIST();
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  return minutes >= 10 * 60 && minutes < 19 * 60; // 10:00 to 18:59 IST
}

function formatQuote(state) {
  const last = state.close_price;
  const change = +(last - state.open_price).toFixed(4);
  const changePct = state.open_price ? +((change / state.open_price) * 100).toFixed(4) : 0;

  return {
    symbol: state.symbol,
    last,
    open: state.open_price,
    high: state.high_price,
    low: state.low_price,
    volume: state.volume,
    day_change: change,
    day_change_percent: changePct,
    event_ts: state.ts,
    currency: "USD",
    source: "simulator"
  };
}

// ---------------------------
// HTTP + Socket.IO Server
// ---------------------------
// Minimal HTTP handler so cron/uptime pings can hit a health endpoint
const httpServer = http.createServer((req, res) => {
  const path = (req.url || "/").split("?")[0];

  // Accept multiple friendly paths; include /cron-ping for Render health conflicts
  const healthPaths = new Set(["/", "/health", "/healthz", "/cron-ping", "/alive"]);
  if (req.method === "GET" && healthPaths.has(path)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        uptime_seconds: process.uptime(),
        timestamp: new Date().toISOString()
      })
    );
    return;
  }

  // Let Socket.IO handle its own endpoint
  if (path.startsWith("/socket.io")) return;

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});
const io = new Server(httpServer, {
  cors: { origin: "*" }
});

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
  socket.meta = { subs: new Set(), lastWindowStart: Date.now(), sentInWindow: 0 };

  // Send info message
  socket.emit("info", "Connected! Subscribe with socket.emit('subscribe', ['AAPL','TSLA'])");

  // Subscribe
  socket.on("subscribe", (symbols) => {
    socket.meta.subs.clear();
    if (!symbols || symbols.length === 0) {
      Object.keys(instruments).forEach(sym => socket.meta.subs.add(sym));
    } else {
      symbols.filter(sym => instruments[sym]).forEach(sym => socket.meta.subs.add(sym));
    }
    // Send snapshot
    const snapshot = Array.from(socket.meta.subs).map(sym => formatQuote(instruments[sym]));
    socket.emit("snapshot", snapshot);
  });

  // Unsubscribe
  socket.on("unsubscribe", (symbols) => {
    if (!symbols || !Array.isArray(symbols)) return;
    symbols.forEach(sym => socket.meta.subs.delete(sym));
    socket.emit("info", `Unsubscribed from: ${symbols.join(", ")}`);
  });

  // Ping
  socket.on("ping", () => {
    socket.emit("pong", Date.now());
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

// ---------------------------
// Simulation Loop
// ---------------------------
function startSimulation() {
  function tick() {
    // Only publish during market hours in IST
    if (!isMarketOpenIST()) {
      setTimeout(tick, 30000);
      return;
    }

    const symbols = Object.keys(instruments);
    const count = 3 + Math.floor(Math.random() * 4);
    const updateSymbols = new Set();
    while (updateSymbols.size < count) {
      const sym = symbols[Math.floor(Math.random() * symbols.length)];
      updateSymbols.add(sym);
    }

    const updates = [...updateSymbols].map(sym => simulateTick(instruments[sym]));

    io.sockets.sockets.forEach((socket) => {
      if (!allowSendRate(socket.meta)) return;
      const relevant = updates.filter(u => socket.meta.subs.has(u.symbol));
      relevant.forEach(u => socket.emit("update", formatQuote(u)));
    });

    setTimeout(tick, BROADCAST_INTERVAL_MS);
  }
  tick();
}

// ---------------------------
httpServer.listen(PORT, () => {
  console.log(`Socket.IO OHLC simulator running on http://localhost:${PORT}`);
  startSimulation();
});
