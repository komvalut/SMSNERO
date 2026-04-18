"use strict";

const express = require("express")";
const http = require("http");
const crypto = require("crypto");
const QRCode = require("qrcode");
const { Pool } = require("pg");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SWISS_API_KEY = process.env.SWISS_API_KEY;
const SWISS_SECRET_KEY = process.env.SWISS_SECRET_KEY;
const SWISS_API_URL = process.env.SWISS_API_URL || "https://api.swiss-bitcoin-pay.ch";
const SESSION_DURATION_HOURS = Number(process.env.SESSION_DURATION_HOURS) || 24;

if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!JWT_SECRET) throw new Error("JWT_SECRET is required");
if (!ADMIN_PASSWORD) throw new Error("ADMIN_PASSWORD is required");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

const sockets = new Set();
const rateBuckets = new Map();

app.use(express.json({ limit: "1mb" }));

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function signToken(payload) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(header + "." + body)
    .digest("base64url");
  return header + "." + body + "." + signature;
}

function verifyToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("Invalid token");

  const expected = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(parts[0] + "." + parts[1])
    .digest("base64url");

  const receivedBuffer = Buffer.from(parts[2]);
  const expectedBuffer = Buffer.from(expected);

  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
  ) {
    throw new Error("Invalid token signature");
  }

  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    req.user = verifyToken(token);
    return next();
  } catch {
    return res.status(403).json({ error: "Invalid token" });
  }
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  return next();
}

function rateLimit(req, res, next) {
  const key = req.ip || "unknown";
  const now = Date.now();
  const bucket = rateBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + 60000 });
    return next();
  }

  if (bucket.count >= 120) {
    return res.status(429).json({ error: "Too many requests. Try again later." });
  }

  bucket.count += 1;
  return next();
}

function wrap(fn) {
  return function(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(function(err) {
      console.error(err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    });
  };
}

function signPayload(payload) {
  if (!SWISS_SECRET_KEY) throw new Error("SWISS_SECRET_KEY is missing");
  return crypto
    .createHmac("sha256", SWISS_SECRET_KEY)
    .update(JSON.stringify(payload))
    .digest("hex");
}

function extractOTP(text) {
  const match = String(text || "").match(/\b\d{4,8}\b/);
  return match ? match[0] : null;
}

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  }
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS numbers (
      id SERIAL PRIMARY KEY,
      phone_number TEXT NOT NULL UNIQUE,
      price_sats INTEGER NOT NULL CHECK (price_sats > 0),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id BIGSERIAL PRIMARY KEY,
      provider_payment_id TEXT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      number_id INTEGER NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
      amount_sats INTEGER NOT NULL CHECK (amount_sats > 0),
      status TEXT NOT NULL DEFAULT 'pending',
      checkout_url TEXT,
      qr TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      number_id INTEGER NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
      invoice_id BIGINT REFERENCES invoices(id) ON DELETE SET NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      number_id INTEGER REFERENCES numbers(id) ON DELETE SET NULL,
      phone_number TEXT NOT NULL,
      text TEXT NOT NULL,
      otp TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  console.log("Database initialized.");
}

function pageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>SMSNero</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { background: #121212; color: white; font-family: Arial, sans-serif; margin: 0; }
    main { max-width: 950px; margin: auto; padding: 28px; }
    .box { padding: 16px; margin: 14px 0; background: #1e1e1e; border-radius: 12px; border: 1px solid #333; }
    button { background: #facc15; border: none; padding: 10px 14px; cursor: pointer; margin: 5px; font-weight: bold; border-radius: 8px; color: #111; }
    input { padding: 10px; margin: 5px; border-radius: 8px; border: 1px solid #444; background: #151515; color: white; }
    a { color: #facc15; }
    img { background: white; padding: 8px; border-radius: 10px; }
    .error { color: #fca5a5; }
    .muted { color: #aaa; }
    .row { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  </style>
</head>
<body>
  <main>
    <h1>SMSNero</h1>
    <p class="muted">Rent phone numbers and receive SMS/OTP messages. Paid via Bitcoin Lightning.</p>

    <div class="box">
      <button onclick="registerUser()">Register</button>
      <input id="adminPass" type="password" placeholder="admin password">
      <button onclick="adminLogin()">Admin login</button>
      <button onclick="logout()">Logout</button>
      <div id="status" class="muted"></div>
    </div>

    <div id="admin" class="box" style="display:none"></div>
    <div id="qr"></div>
    <div id="numbers" class="box">Login or register to load numbers.</div>
    <div id="sessions" class="box"><h3>My active numbers</h3></div>
    <div id="otp" class="box"><h3>OTP Inbox</h3></div>
  </main>

  <script>
    let token = localStorage.getItem("smsnero_token") || "";
    let role = localStorage.getItem("smsnero_role") || "";

    function escapeHtml(value) {
      return String(value).replace(/[&<>'"]/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c];
      });
    }

    function setStatus(msg, isError) {
      const el = document.getElementById("status");
      el.className = isError ? "error" : "muted";
      el.textContent = msg;
    }

    function authHeaders(extra) {
      return Object.assign({}, extra || {}, { Authorization: "Bearer " + token });
    }
tElementById("numbers").innerHTML = "Login or register to load numbers.";
      document.getElementById("sessions").innerHTML = "<h3>My active numbers</h3>";
      document.getElementById("otp").innerHTML = "<h3>OTP Inbox</h3>";
    }
    function saveSession(data) {
      token = data.token;
      role = data.user.role;
      localStorage.setItem("smsnero_token", token);
      localStorage.setItem("smsnero_role", role);
    }

    function logout() {
      token = "";
      role = "";
      localStorage.removeItem("smsnero_token");
      localStorage.removeItem("smsnero_role");
      setStatus("Logged out.", false);
      renderAdmin();
      document.ge

    async function registerUser() {
      const r = await fetch("/register", { method: "POST" });
      const d = await r.json();
      if (!r.ok) return setStatus(d.error || "Register error.", true);
      saveSession(d);
      setStatus("Registered. Your token is saved.", false);
      refreshAll();
    }

    async function adminLogin() {
      const password = document.getElementById("adminPass").value;
      const r = await fetch("/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password })
      });
      const d = await r.json();
      if (!r.ok) return setStatus(d.error || "Admin login failed.", true);
      saveSession(d);
      setStatus("Admin logged in.", false);
      refreshAll();
    }

    function renderAdmin() {
      const box = document.getElementById("admin");
      if (role !== "admin") {
        box.style.display = "none";
        box.innerHTML = "";
        return;
      }
      box.style.display = "block";
      box.innerHTML =
        "<h3>Admin panel</h3>" +
        "<input id='adminNumber' placeholder='e.g. +46700000001'> " +
        "<input id='adminPrice' type='number' min='1' step='1' placeholder='price in sats'> " +
        "<button onclick='adminAddNumber()'>Add number</button>" +
        "<div id='adminList'></div>";
      loadAdminNumbers();
    }

    async function adminAddNumber() {
      const number = document.getElementById("adminNumber").value.trim();
      const priceSats = Number(document.getElementById("adminPrice").value);
      const r = await fetch("/admin/numbers", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ number, priceSats })
      });
      const d = await r.json().catch(function () { return { error: "Error" }; });
      if (!r.ok) return setStatus(d.error || "Could not add number.", true);
      setStatus("Number saved.", false);
      loadAdminNumbers();
      loadNumbers();
    }

    async function adminDeleteNumber(id) {
      const r = await fetch("/admin/numbers/" + id, {
        method: "DELETE",
        headers: authHeaders()
      });
      if (!r.ok) return setStatus("Could not disable number.", true);
      setStatus("Number disabled.", false);
      loadAdminNumbers();
      loadNumbers();
    }

    async function loadAdminNumbers() {
      if (role !== "admin") return;
      const r = await fetch("/admin/numbers", { headers: authHeaders() });
      if (!r.ok) return;
      const data = await r.json();
      let html = "";
      data.forEach(function (item) {
        const statusLabel = item.active ? "active" : "disabled";
        html += "<div class='box row'><span>" +
          escapeHtml(item.phone_number) + " â€” " +
          escapeHtml(item.price_sats) + " sats [" + statusLabel + "]" +
          "</span><button onclick='adminDeleteNumber(" + item.id + ")'>Disable</button></div>";
      });
      document.getElementById("adminList").innerHTML = html || "<p class='muted'>No numbers yet.</p>";
    }

    async function loadNumbers() {
      if (!token) return;
      const r = await fetch("/numbers", { headers: authHeaders() });
      if (!r.ok) return setStatus("Login again.", true);
      const data = await r.json();
      let html = "<h3>Available numbers</h3>";
      if (data.length === 0) {
        html += "<p class='muted'>No numbers available.</p>";
      }
      data.forEach(function (item) {
        html += "<div class='box row'><span>" +
          escapeHtml(item.phone_number) + " â€” " +
          escapeHtml(item.price_sats) + " sats" +
          "</span><button onclick='buyNumber(" + item.id + ")'>Buy</button></div>";
      });
      document.getElementById("numbers").innerHTML = html;
    }

    async function buyNumber(id) {
      setStatus("Creating invoice...", false);
      const r = await fetch("/create-invoice", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ numberId: id })
      });
      const invoice = await r.json().catch(function () { return { error: "Payment error" }; });
      if (!r.ok) return setStatus(invoice.error || "Payment error.", true);
      setStatus("Invoice created. Scan QR to pay.", false);
      document.getElementById("qr").innerHTML =
        "<div class='box'><h3>Scan Lightning QR</h3>" +
        "<p>Amount: " + escapeHtml(invoice.amount_sats) + " sats</p>" +
        "<img src='" + escapeHtml(invoice.qr) + "' width='200' alt='Lightning QR code'><br>" +
        "<a href='" + escapeHtml(invoice.checkout_url) + "' target='_blank'>Open Checkout</a>" +
        "</div>";
    }

    async function loadSessions() {
      if (!token || role === "admin") return;
      const r = await fetch("/my-numbers", { headers: authHeaders() });
      if (!r.ok) return;
      const data = await r.json();
      let html = "<h3>My active numbers</h3>";
      if (data.length === 0) {
        html += "<p class='muted'>No active numbers yet.</p>";
      }
      data.forEach(function (item) {
        html += "<div class='box'>" +
          "<strong>" + escapeHtml(item.phone_number) + "</strong>" +
          " â€” active until " + escapeHtml(new Date(item.expires_at).toLocaleString()) +
          "</div>";
      });
      document.getElementById("sessions").innerHTML = html;
    }

    async function loadMessages() {
      if (!token) return;
      const r = await fetch("/messages", { headers: authHeaders() });
      if (!r.ok) return;
      const data = await r.json();
      let html = "<h3>OTP Inbox</h3>";
      if (data.length === 0) {
        html += "<p class='muted'>No messages yet.</p>";
      }
      data.forEach(function (item) {
        html += "<div class='box'>" +
          "<span class='muted'>" + escapeHtml(item.phone_number) + "</span><br>" +
          escapeHtml(item.text) +
          (item.otp ? " <strong style='color:#facc15;font-size:1.2em'>" + escapeHtml(item.otp) + "</strong>" : "") +
          "<br><span class='muted' style='font-size:0.85em'>" + escapeHtml(new Date(item.created_at).toLocaleString()) + "</span>" +
          "</div>";
      });
      document.getElementById("otp").innerHTML = html;
    }

    function refreshAll() {
      renderAdmin();
      loadNumbers();
      loadSessions();
      loadMessages();
    }

    const wsProtocol = location.protocol === "https:" ? "wss://" : "ws://";
    const ws = new WebSocket(wsProtocol + location.host);

    ws.onopen = function () { console.log("WebSocket connected"); };
    ws.onmessage = function (evt) {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === "message" || msg.type === "session_activated") {
          loadMessages();
          loadSessions();
        }
      } catch {}
      loadMessages();
    };
    ws.onerror = function () { console.warn("WebSocket error"); };

    if (token) refreshAll();
  </script>
</body>
</html>`;
}

app.use(rateLimit);

app.get("/healthz", function(req, res) {
  res.json({ status: "ok" });
});

app.get("/favicon.ico", function(req, res) {
  res.status(204).end();
});

app.get("/download-source", function(req, res) {
  const fs = require("fs");
  const path = require("path");
  const file = path.join(__dirname, "server.cjs");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=\"server.cjs\"");
  res.send(fs.readFileSync(file, "utf8"));
});

app.get("/", function(req, res) {
  res.send(pageHtml());
});

app.post("/register", wrap(async function(req, res) {
  const username = "user" + Date.now();
  const result = await pool.query(
    "INSERT INTO users (username, role) VALUES ($1, 'user') RETURNING id, username, role",
    [username]
  );
  const user = result.rows[0];
  res.json({ token: signToken(user), user });
}));

app.post("/admin/login", function(req, res) {
  if (String(req.body.password || "") !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: "Wrong admin password" });
  }
  const user = { id: 0, username: "admin", role: "admin" };
  return res.json({ token: signToken(user), user });
});

app.get("/numbers", auth, wrap(async function(req, res) {
  const result = await pool.query(
    "SELECT id, phone_number, price_sats FROM numbers WHERE active = TRUE ORDER BY id DESC"
  );
  res.json(result.rows);
}));

app.get("/admin/numbers", auth, adminOnly, wrap(async function(req, res) {
  const result = await pool.query(
    "SELECT id, phone_number, price_sats, active, created_at FROM numbers ORDER BY id DESC"
  );
  res.json(result.rows);
}));

app.post("/admin/numbers", auth, adminOnly, wrap(async function(req, res) {
  const number = String(req.body.number || "").trim();
  const priceSats = Number(req.body.priceSats);

  if (!number || !/^\+[1-9]\d{7,14}$/.test(number)) {
    return res.status(400).json({ error: "Use international format, e.g. +46700000001" });
  }

  if (!Number.isInteger(priceSats) || priceSats <= 0) {
    return res.status(400).json({ error: "Price must be a positive whole number of satoshis" });
  }

  const result = await pool.query(
    `INSERT INTO numbers (phone_number, price_sats, active)
     VALUES ($1, $2, TRUE)
     ON CONFLICT (phone_number) DO UPDATE SET price_sats = EXCLUDED.price_sats, active = TRUE
     RETURNING id, phone_number, price_sats, active`,
    [number, priceSats]
  );

  return res.json(result.rows[0]);
}));

app.delete("/admin/numbers/:id", auth, adminOnly, wrap(async function(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid number ID" });
  }
  await pool.query("UPDATE numbers SET active = FALSE WHERE id = $1", [id]);
  res.json({ ok: true });
}));

app.post("/create-invoice", auth, wrap(async function(req, res) {
  if (req.user.role === "admin") {
    return res.status(400).json({ error: "Admin cannot buy numbers" });
  }

  if (!SWISS_API_KEY || !SWISS_SECRET_KEY) {
    return res.status(503).json({
      error: "Payment not configured. Set SWISS_API_KEY and SWISS_SECRET_KEY environment variables."
    });
  }

  const numberId = Number(req.body.numberId);
  if (!Number.isInteger(numberId) || numberId <= 0) {
    return res.status(400).json({ error: "Invalid number ID" });
  }

  const numberResult = await pool.query(
    "SELECT id, phone_number, price_sats FROM numbers WHERE id = $1 AND active = TRUE",
    [numberId]
  );

  const number = numberResult.rows[0];
  if (!number) {
    return res.status(400).json({ error: "Number does not exist or is not available" });
  }

  const payload = {
    amount: number.price_sats,
    amountSats: number.price_sats,
    currency: "SATS",
    description: "SMSNero â€” " + number.phone_number,
  };

  const response = await fetch(SWISS_API_URL + "/v1/payment", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": SWISS_API_KEY,
      "x-signature": signPayload(payload),
    },
    body: JSON.stri
