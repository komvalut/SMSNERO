const express = require("express");
const http = require("http");
const crypto = require("crypto");
const QRCode = require("qrcode");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET || "change_this_secret";
const SWISS_API_KEY = process.env.SWISS_API_KEY;
const SWISS_SECRET_KEY = process.env.SWISS_SECRET_KEY;
const SWISS_API_URL = process.env.SWISS_API_URL || "https://api.swiss-bitcoin-pay.ch";

app.use(express.json());

let users = [];
let numbers = [{ id: 1, number: "+46700000001", price: 100 }];
let sessions = [];
let invoices = [];
let messages = [];
let sockets = new Set();
let rateBuckets = new Map();

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signToken(user) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify(user));
  const signature = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(header + "." + payload)
    .digest("base64url");

  return header + "." + payload + "." + signature;
}

function verifyToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid token");

  const expected = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(parts[0] + "." + parts[1])
    .digest("base64url");

  if (expected !== parts[2]) throw new Error("Invalid signature");

  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

function auth(req, res, next) {
  const header = req.headers.authorization;
  const token = header && header.startsWith("Bearer ")
    ? header.slice(7)
    : header;

  if (!token) return res.sendStatus(401);

  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.sendStatus(403);
  }
}

function rateLimit(req, res, next) {
  const key = req.ip || "unknown";
  const now = Date.now();
  const bucket = rateBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + 60000 });
    return next();
  }

  if (bucket.count >= 30) {
    return res.status(429).json({ error: "Too many requests. Try again later." });
  }

  bucket.count++;
  next();
}

function signPayload(payload) {
  if (!SWISS_SECRET_KEY) {
    throw new Error("SWISS_SECRET_KEY is missing");
  }

  return crypto
    .createHmac("sha256", SWISS_SECRET_KEY)
    .update(JSON.stringify(payload))
    .digest("hex");
}

function extractOTP(text) {
  const match = String(text).match(/\b\d{4,8}\b/);
  return match ? match[0] : null;
}

function broadcast(msg) {
  const payload = JSON.stringify(msg);

  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
    }
  }
}

app.use(rateLimit);

app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>SMSNero</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { background:#121212; color:white; font-family:Arial; margin:0; }
    main { max-width:900px; margin:auto; padding:30px; }
    .box { padding:16px; margin:14px 0; background:#1e1e1e; border-radius:12px; border:1px solid #333; }
    button { background:#facc15; border:none; padding:10px 14px; cursor:pointer; margin:5px; font-weight:bold; border-radius:8px; }
    input { padding:10px; margin:5px; border-radius:8px; border:1px solid #444; background:#151515; color:white; }
    a { color:#facc15; }
    img { background:white; padding:8px; border-radius:10px; }
    .error { color:#fca5a5; }
    .muted { color:#aaa; }
  </style>
</head>
<body>
<main>
  <h1>SMSNero</h1>
  <p class="muted">Temporary SMS numbers, QR payment and live OTP inbox.</p>

  <button onclick="register()">Register demo user</button>
  <div id="status"></div>
  <div id="qr"></div>
  <div id="app" class="box">Register to load numbers.</div>
  <div id="otp" class="box"><h3>OTP Inbox</h3></div>
</main>

<script>
let token = localStorage.getItem("smsnero_token") || "";

function setStatus(msg, error) {
  document.getElementById("status").innerHTML = "<p class='" + (error ? "error" : "muted") + "'>" + msg + "</p>";
}

function authHeaders(extra) {
  return Object.assign({}, extra || {}, { Authorization: "Bearer " + token });
}

async function register() {
  const r = await fetch("/register", { method: "POST" });
  const d = await r.json();
  token = d.token;
  localStorage.setItem("smsnero_token", token);
  setStatus("Registered.", false);
  load();
}

async function load() {
  if (!token) return;

  const r = await fetch("/numbers", {
    headers: authHeaders()
  });

  if (!r.ok) {
    setStatus("Please register again.", true);
    return;
  }

  const data = await r.json();

  document.getElementById("app").innerHTML =
    "<div class='box'>" +
    "<h3>Add Number</h3>" +
    "<input id='num' placeholder='e.g. +46700000001' />" +
    "<input id='price' type='number' placeholder='price CHF' />" +
    "<button onclick='addNumber()'>Add</button>" +
    "</div>" +
    data.map(function(n) {
      return "<div class='box'>" +
        n.number + " - " + n.price + " CHF " +
        "<button onclick='pay(" + n.price + "," + n.id + ")'>Buy</button>" +
        "</div>";
    }).join("");
}

async function addNumber() {
  const number = document.getElementById("num").value;
  const price = Number(document.getElementById("price").value);

  const r = await fetch("/marketplace/add", {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ number, price })
  });

  if (!r.ok) {
    const e = await r.json().catch(function(){ return { error: "Error" }; });
    setStatus(e.error, true);
    return;
  }

  setStatus("Number added.", false);
  load();
}

async function pay(amount, id) {
  const r = await fetch("/create-invoice", {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ amount, numberId: id })
  });

  const inv = await r.json();

  if (!r.ok) {
    setStatus(inv.error || "Payment error.", true);
    return;
  }

  document.getElementById("qr").innerHTML =
    "<div class='box'>" +
    "<h3>Scan QR to Pay</h3>" +
    "<img src='" + inv.qr + "' width='200' />" +
    "<br><a href='" + inv.checkoutUrl + "' target='_blank'>Open Checkout</a>" +
    "</div>";
}

const wsProtocol = location.protocol === "https:" ? "wss://" : "ws://";
const ws = new WebSocket(wsProtocol + location.host);

ws.onmessage = function(e) {
  const m = JSON.parse(e.data);
  document.getElementById("otp").innerHTML +=
    "<div>" + m.number + ": " + m.text + " (" + (m.otp || "") + ")</div>";
};

if (token) load();
</script>
</body>
</html>`);
});

app.post("/register", (req, res) => {
  const user = {
    id: Date.now(),
    username: "user" + Date.now()
  };

  users.push(user);

  res.json({
    token: signToken(user),
    user
  });
});

app.get("/numbers", auth, (req, res) => {
  res.json(numbers);
});

app.post("/marketplace/add", auth, (req, res) => {
  const number = String(req.body.number || "").trim();
  const price = Number(req.body.price);

  if (!number || !/^\\+[1-9]\\d{7,14}$/.test(number)) {
    return res.status(400).json({
      error: "Use international format, for example +46700000001"
    });
  }

  if (!Number.isFinite(price) || price <= 0) {
    return res.status(400).json({
      error: "Price must be a positive number"
    });
  }

  const item = {
    id: Date.now(),
    number,
    price,
    owner: req.user.id
  };

  numbers.push(item);
  res.json(item);
});

app.post("/create-invoice", auth, async (req, res) => {
  if (!SWISS_API_KEY || !SWISS_SECRET_KEY) {
    return res.status(503).json({
      error: "Payment is not configured. Add SWISS_API_KEY and SWISS_SECRET_KEY in Render environment variables."
    });
  }

  const amount = Number(req.body.amount);
  const numberId = Number(req.body.numberId);

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "Amount must be positive" });
  }

  if (!numbers.some(n => n.id === numberId)) {
    return res.status(400).json({ error: "Number does not exist" });
  }

  try {
    const payload = {
      amount,
      currency: "CHF",
      description: "SMSNero service payment"
    };

    const response = await fetch(SWISS_API_URL + "/v1/payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": SWISS_API_KEY,
        "x-signature": signPayload(payload)
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(502).json({
        error: "Payment provider rejected invoice"
      });
    }

    const checkoutUrl = data.checkoutUrl || data.url;

    if (!checkoutUrl) {
      return res.status(502).json({
        error: "Payment provider did not return checkout URL"
      });
    }

    const invoice = {
      id: Date.now(),
      providerPaymentId: data.id || data.paymentId,
      userId: req.user.id,
      numberId,
      status: "pending",
      amount,
      checkoutUrl,
      qr: await QRCode.toDataURL(checkoutUrl),
      createdAt: new Date().toISOString()
    };

    invoices.push(invoice);
    res.json(invoice);
  } catch (err) {
    res.status(500).json({
      error: "Payment error"
    });
  }
});

app.post("/webhook", (req, res) => {
  const event = req.body;
  const eventId = event.invoiceId || event.paymentId || event.id;

  const invoice = invoices.find(i =>
    String(i.id) === String(eventId) ||
    String(i.providerPaymentId) === String(eventId)
  );

  if (!invoice) return res.sendStatus(404);

  if (event.status === "paid") {
    invoice.status = "paid";

    sessions.push({
      id: Date.now(),
      userId: invoice.userId,
      numberId: invoice.numberId,
      expires: Date.now() + 10 * 60 * 1000
    });
  }

  res.sendStatus(200);
});

app.post("/sms", (req, res) => {
  const number = String(req.body.number || "").trim();
  const text = String(req.body.text || "").trim();

  if (!number || !text) {
    return res.status(400).json({
      error: "number