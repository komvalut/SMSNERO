// SMSNero - Production server
// Node.js + Express + PostgreSQL + WebSocket + Swiss Bitcoin Pay (Lightning)
//
// Required env vars:
//   DATABASE_URL          PostgreSQL connection string
//   JWT_SECRET            Secret for signing JWTs (or SESSION_SECRET)
//   ADMIN_PASSWORD        Plain admin password
//   SWISS_API_KEY         Swiss Bitcoin Pay API key
//   SWISS_SECRET_KEY      Swiss Bitcoin Pay HMAC secret
//   SMS_WEBHOOK_SECRET    Shared HMAC secret for incoming SMS webhooks
// Optional:
//   SWISS_API_URL         defaults to https://api.swiss-bitcoin-pay.ch
//   PORT                  defaults to 3000
//   NODE_ENV              "production" enables SSL for Postgres
//   SESSION_MINUTES       active number lifetime in minutes (default 30)

const express = require("express");
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
const SMS_WEBHOOK_SECRET = process.env.SMS_WEBHOOK_SECRET;
const SWISS_API_KEY = process.env.SWISS_API_KEY;
const SWISS_SECRET_KEY = process.env.SWISS_SECRET_KEY;
const SWISS_API_URL = process.env.SWISS_API_URL || "https://api.swiss-bitcoin-pay.ch";
const SESSION_MINUTES = Number(process.env.SESSION_MINUTES || 30);

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

// ---------- helpers ----------

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

  const received = Buffer.from(parts[2]);
  const expectedBuf = Buffer.from(expected);

  if (
    received.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(received, expectedBuf)
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

// Periodic cleanup of stale rate-limit buckets
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

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

// ---------- database ----------

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
}

// ---------- HTML page ----------

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
    <p class="muted">Production version with database storage, admin number management, Bitcoin Lightning payment and live OTP inbox.</p>

    <div class="box">
      <button onclick="registerUser()">Register user</button>
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
      return String(value).replace(/[&<>'"]/g, function (char) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char];
      });
    }

    function setStatus(message, isError) {
      const el = document.getElementById("status");
      el.className = isError ? "error" : "muted";
      el.textContent = message;
    }

    function authHeaders(extra) {
      return Object.assign({}, extra || {}, { Authorization: "Bearer " + token });
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
      document.getElementById("numbers").innerHTML = "Login or register to load numbers.";
      document.getElementById("sessions").innerHTML = "<h3>My active numbers</h3>";
      document.getElementById("otp").innerHTML = "<h3>OTP Inbox</h3>";
    }

    async function registerUser() {
      const response = await fetch("/register", { method: "POST" });
      const data = await response.json();
      if (!response.ok) return setStatus(data.error || "Register error.", true);
      saveSession(data);
      setStatus("User registered.", false);
      refreshAll();
    }

    async function adminLogin() {
      const password = document.getElementById("adminPass").value;
      const response = await fetch("/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: password })
      });
      const data = await response.json();
      if (!response.ok) return setStatus(data.error || "Admin login failed.", true);
      saveSession(data);
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
        "<input id='adminNumber' placeholder='e.g. +46700000001'>" +
        "<input id='adminPrice' type='number' min='1' step='1' placeholder='price in sats'>" +
        "<button onclick='adminAddNumber()'>Add number</button>" +
        "<div id='adminList'></div>";
      loadAdminNumbers();
    }

    async function adminAddNumber() {
      const number = document.getElementById("adminNumber").value;
      const priceSats = Number(document.getElementById("adminPrice").value);
      const response = await fetch("/admin/numbers", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ number: number, priceSats: priceSats })
      });
      const data = await response.json().catch(function () { return { error: "Error" }; });
      if (!response.ok) return setStatus(data.error || "Could not add number.", true);
      setStatus("Number saved in database.", false);
      loadAdminNumbers();
      loadNumbers();
    }

    async function adminDeleteNumber(id) {
      const response = await fetch("/admin/numbers/" + id, {
        method: "DELETE",
        headers: authHeaders()
      });
      if (!response.ok) return setStatus("Could not delete number.", true);
      setStatus("Number disabled.", false);
      loadAdminNumbers();
      loadNumbers();
    }

    async function loadAdminNumbers() {
      if (role !== "admin") return;
      const response = await fetch("/admin/numbers", { headers: authHeaders() });
      if (!response.ok) return;
      const data = await response.json();
      let html = "";
      data.forEach(function (item) {
        html += "<div class='box row'><span>" +
          escapeHtml(item.phone_number) + " - " +
          escapeHtml(item.price_sats) + " sats" +
          (item.active ? "" : " (disabled)") +
          "</span><button onclick='adminDeleteNumber(" + item.id + ")'>Disable</button></div>";
      });
      document.getElementById("adminList").innerHTML = html || "<p class='muted'>No numbers yet.</p>";
    }

    async function loadNumbers() {
      if (!token) return;
      const response = await fetch("/numbers", { headers: authHeaders() });
      if (!response.ok) return setStatus("Login again.", true);
      const data = await response.json();
      let html = "<h3>Available numbers</h3>";
      data.forEach(function (item) {
        html += "<div class='box row'><span>" +
          escapeHtml(item.phone_number) + " - " +
          escapeHtml(item.price_sats) +
          " sats</span><button onclick='buyNumber(" + item.id + ")'>Buy</button></div>";
      });
      document.getElementById("numbers").innerHTML = html || "No numbers available.";
    }

    async function buyNumber(id) {
      const response = await fetch("/create-invoice", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ numberId: id })
      });
      const invoice = await response.json().catch(function () { return { error: "Payment error" }; });
      if (!response.ok) return setStatus(invoice.error || "Payment error.", true);
      document.getElementById("qr").innerHTML =
        "<div class='box'><h3>Scan Lightning QR</h3><p>Amount: " +
        escapeHtml(invoice.amount_sats) + " sats</p><img src='" +
        invoice.qr + "' width='200' alt='QR code'><br><a href='" +
        escapeHtml(invoice.checkout_url) + "' target='_blank'>Open Checkout</a></div>";
    }

    async function loadSessions() {
      if (!token || role === "admin") return;
      const response = await fetch("/my-numbers", { headers: authHeaders() });
      if (!response.ok) return;
      const data = await response.json();
      let html = "<h3>My active numbers</h3>";
      if (!data.length) html += "<p class='muted'>No active numbers.</p>";
      data.forEach(function (item) {
        html += "<div>" + escapeHtml(item.phone_number) +
          " active until " + escapeHtml(new Date(item.expires_at).toLocaleString()) + "</div>";
      });
      document.getElementById("sessions").innerHTML = html;
    }

    async function loadMessages() {
      if (!token) return;
      const response = await fetch("/messages", { headers: authHeaders() });
      if (!response.ok) return;
      const data = await response.json();
      let html = "<h3>OTP Inbox</h3>";
      if (!data.length) html += "<p class='muted'>No messages yet.</p>";
      data.forEach(function (item) {
        html += "<div>" + escapeHtml(item.phone_number) + ": " +
          escapeHtml(item.text) + " (" + escapeHtml(item.otp || "") + ")</div>";
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
    ws.onmessage = function () {
      loadMessages();
      loadSessions();
    };

    if (token) refreshAll();
  </script>
</body>
</html>`;
}

// ---------- routes ----------

app.use(rateLimit);

app.get("/healthz", function (req, res) {
  res.json({ status: "ok" });
});

app.get("/favicon.ico", function (req, res) {
  res.status(204).end();
});

app.get("/", function (req, res) {
  res.send(pageHtml());
});

app.post("/register", async function (req, res) {
  try {
    const username = "user" + Date.now();
    const result = await pool.query(
      "INSERT INTO users (username, role) VALUES ($1, 'user') RETURNING id, username, role",
      [username]
    );
    const user = result.rows[0];
    res.json({ token: signToken(user), user });
  } catch (err) {
    console.error("register error", err);
    res.status(500).json({ error: "Could not register user" });
  }
});

app.post("/admin/login", function (req, res) {
  if (String((req.body && req.body.password) || "") !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: "Wrong admin password" });
  }
  const user = { id: 0, username: "admin", role: "admin" };
  return res.json({ token: signToken(user), user });
});

app.get("/numbers", auth, async function (req, res) {
  try {
    const result = await pool.query(
      "SELECT id, phone_number, price_sats FROM numbers WHERE active = TRUE ORDER BY id DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("numbers error", err);
    res.status(500).json({ error: "Database error" });
  }
});

app.get("/admin/numbers", auth, adminOnly, async function (req, res) {
  try {
    const result = await pool.query(
      "SELECT id, phone_number, price_sats, active, created_at FROM numbers ORDER BY id DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("admin numbers error", err);
    res.status(500).json({ error: "Database error" });
  }
});

app.post("/admin/numbers", auth, adminOnly, async function (req, res) {
  const number = String((req.body && req.body.number) || "").trim();
  const priceSats = Number(req.body && req.body.priceSats);

  if (!number || !/^\+[1-9]\d{7,14}$/.test(number)) {
    return res.status(400).json({
      error: "Use international phone format, for example +46700000001",
    });
  }

  if (!Number.isInteger(priceSats) || priceSats <= 0) {
    return res.status(400).json({
      error: "Price must be a positive whole number of satoshis",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO numbers (phone_number, price_sats, active)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (phone_number) DO UPDATE SET price_sats = EXCLUDED.price_sats, active = TRUE
       RETURNING id, phone_number, price_sats, active`,
      [number, priceSats]
    );
    return res.json(result.rows[0]);
  } catch (err) {
    console.error("add number error", err);
    return res.status(500).json({ error: "Could not save number" });
  }
});

app.delete("/admin/numbers/:id", auth, adminOnly, async function (req, res) {
  try {
    await pool.query("UPDATE numbers SET active = FALSE WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("delete number error", err);
    res.status(500).json({ error: "Could not disable number" });
  }
});

app.post("/create-invoice", auth, async function (req, res) {
  if (req.user.role === "admin") {
    return res.status(400).json({ error: "Admin cannot buy numbers" });
  }

  if (!SWISS_API_KEY || !SWISS_SECRET_KEY) {
    return res.status(503).json({
      error:
        "Payment is not configured. Add SWISS_API_KEY and SWISS_SECRET_KEY in environment variables.",
    });
  }

  const numberId = Number(req.body && req.body.numberId);
  if (!Number.isInteger(numberId) || numberId <= 0) {
    return res.status(400).json({ error: "Invalid number id" });
  }

  try {
    const numberResult = await pool.query(
      "SELECT id, phone_number, price_sats FROM numbers WHERE id = $1 AND active = TRUE",
      [numberId]
    );
    const number = numberResult.rows[0];
    if (!number) return res.status(400).json({ error: "Number does not exist" });

    const payload = {
      amount: number.price_sats,
      amountSats: number.price_sats,
      currency: "SATS",
      description: "SMSNero Lightning payment",
    };

    const response = await fetch(SWISS_API_URL + "/v1/payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": SWISS_API_KEY,
        "x-signature": signPayload(payload),
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      console.error("provider rejected invoice", response.status, data);
      return res.status(502).json({ error: "Payment provider rejected invoice" });
    }

    const checkoutUrl = data.checkoutUrl || data.url;
    if (!checkoutUrl) {
      return res.status(502).json({ error: "Payment provider did not return checkout URL" });
    }

    const qr = await QRCode.toDataURL(checkoutUrl);

    const result = await pool.query(
      `INSERT INTO invoices (provider_payment_id, user_id, number_id, amount_sats, status, checkout_url, qr)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6)
       RETURNING id, provider_payment_id, user_id, number_id, amount_sats, status, checkout_url, qr, created_at`,
      [data.id || data.paymentId || null, req.user.id, number.id, number.price_sats, checkoutUrl, qr]
    );

    return res.json(result.rows[0]);
  } catch (err) {
    console.error("create-invoice error", err);
    return res.status(500).json({ error: "Payment error" });
  }
});

// Provider webhook: marks invoice paid + creates session
app.post("/webhook", async function (req, res) {
  try {
    const event = req.body || {};
    const eventId = event.invoiceId || event.paymentId || event.id;
    const status = String(event.status || "").toLowerCase();

    if (!eventId) return res.status(400).json({ error: "Missing event id" });

    const invoiceResult = await pool.query(
      "SELECT * FROM invoices WHERE id::text = $1 OR provider_payment_id = $1 LIMIT 1",
      [String(eventId)]
    );
    const invoice = invoiceResult.rows[0];
    if (!invoice) return res.sendStatus(404);

    if (status === "paid" || status === "settled" || status === "confirmed") {
      if (invoice.status === "paid") return res.json({ ok: true, duplicate: true });

      await pool.query("UPDATE invoices SET status = 'paid' WHERE id = $1", [invoice.id]);

      const expiresAt = new Date(Date.now() + SESSION_MINUTES * 60 * 1000);
      const sessionResult = await pool.query(
        `INSERT INTO sessions (user_id, number_id, invoice_id, expires_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id, user_id, number_id, expires_at`,
        [invoice.user_id, invoice.number_id, invoice.id, expiresAt]
      );

      broadcast({ type: "invoice_paid", invoiceId: invoice.id, session: sessionResult.rows[0] });
      return res.json({ ok: true });
    }

    if (status === "expired" || status === "failed" || status === "cancelled") {
      await pool.query("UPDATE invoices SET status = $1 WHERE id = $2", [status, invoice.id]);
      return res.json({ ok: true });
    }

    return res.json({ ok: true, ignored: true });
  } catch (err) {
    console.error("webhook error", err);
    return res.status(500).json({ error: "Webhook error" });
  }
});

// Incoming SMS webhook from SMS provider. Verify HMAC in `x-signature` header.
app.post("/sms-webhook", async function (req, res) {
  try {
    if (!SMS_WEBHOOK_SECRET) {
      return res.status(503).json({ error: "SMS webhook not configured" });
    }

    const provided = String(req.headers["x-signature"] || "");
    const expected = crypto
      .createHmac("sha256", SMS_WEBHOOK_SECRET)
      .update(JSON.stringify(req.body || {}))
      .digest("hex");

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({ error: "Invalid signature" });
    }

    const phoneNumber = String((req.body && (req.body.to || req.body.phoneNumber)) || "").trim();
    const text = String((req.body && (req.body.text || req.body.message)) || "").trim();
    if (!phoneNumber || !text) {
      return res.status(400).json({ error: "Missing phoneNumber or text" });
    }

    const numberRow = await pool.query(
      "SELECT id FROM numbers WHERE phone_number = $1 LIMIT 1",
      [phoneNumber]
    );
    const numberId = numberRow.rows[0] ? numberRow.rows[0].id : null;
    const otp = extractOTP(text);

    const result = await pool.query(
      `INSERT INTO messages (number_id, phone_number, text, otp)
       VALUES ($1, $2, $3, $4)
       RETURNING id, number_id, phone_number, text, otp, created_at`,
      [numberId, phoneNumber, text, otp]
    );

    broadcast({ type: "sms", message: result.rows[0] });
    return res.json({ ok: true });
  } catch (err) {
    console.error("sms-webhook error", err);
    return res.status(500).json({ error: "SMS webhook error" });
  }
});

// User's currently active numbers (paid + not expired)
app.get("/my-numbers", auth, async function (req, res) {
  if (req.user.role === "admin") return res.json([]);
  try {
    const result = await pool.query(
      `SELECT s.id, s.expires_at, n.phone_number, n.id AS number_id
         FROM sessions s
         JOIN numbers n ON n.id = s.number_id
        WHERE s.user_id = $1 AND s.expires_at > NOW()
        ORDER BY s.expires_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("my-numbers error", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Messages visible to the requester:
//  - admin sees all recent messages
//  - users see only messages for numbers they currently have an active session on
app.get("/messages", auth, async function (req, res) {
  try {
    if (req.user.role === "admin") {
      const result = await pool.query(
        `SELECT id, number_id, phone_number, text, otp, created_at
           FROM messages ORDER BY id DESC LIMIT 100`
      );
      return res.json(result.rows);
    }

    const result = await pool.query(
      `SELECT m.id, m.number_id, m.phone_number, m.text, m.otp, m.created_at
         FROM messages m
         JOIN sessions s ON s.number_id = m.number_id
        WHERE s.user_id = $1
          AND s.expires_at > NOW()
          AND m.created_at >= s.created_at
        ORDER BY m.id DESC
        LIMIT 100`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("messages error", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ---------- WebSocket ----------

wss.on("connection", function (socket) {
  sockets.add(socket);
  socket.on("close", function () { sockets.delete(socket); });
  socket.on("error", function () { sockets.delete(socket); });
});

// ---------- startup ----------

initDb()
  .then(function () {
    server.listen(PORT, function () {
      console.log("SMSNero listening on port " + PORT);
    });
  })
  .catch(function (err) {
    console.error("DB init failed", err);
    process.exit(1);
  });

function shutdown() {
  console.log("Shutting down...");
  server.close(function () {
    pool.end().finally(function () { process.exit(0); });
  });
  setTimeout(function () { process.exit(1); }, 10000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
