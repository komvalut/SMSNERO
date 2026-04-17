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

const users = [];
const numbers = [{ id: 1, number: "+46700000001", price: 100 }];
const sessions = [];
const invoices = [];
const messages = [];
const sockets = new Set();
const rateBuckets = new Map();

app.use(express.json({ limit: "1mb" }));

function base64url(value) {
  return Buffer.from(value).toString("base64url");
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
  const parts = String(token || "").split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid token");
  }

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

  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }

  try {
    req.user = verifyToken(token);
    return next();
  } catch (error) {
    return res.status(403).json({ error: "Invalid token" });
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

  if (bucket.count >= 60) {
    return res.status(429).json({ error: "Too many requests. Try again later." });
  }

  bucket.count += 1;
  return next();
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
  const match = String(text || "").match(/\b\d{4,8}\b/);
  return match ? match[0] : null;
}

function broadcast(message) {
  const payload = JSON.stringify(message);

  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
    }
  }
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
    main { max-width: 900px; margin: auto; padding: 30px; }
    .box { padding: 16px; margin: 14px 0; background: #1e1e1e; border-radius: 12px; border: 1px solid #333; }
    button { background: #facc15; border: none; padding: 10px 14px; cursor: pointer; margin: 5px; font-weight: bold; border-radius: 8px; color: #111; }
    input { padding: 10px; margin: 5px; border-radius: 8px; border: 1px solid #444; background: #151515; color: white; }
    a { color: #facc15; }
    img { background: white; padding: 8px; border-radius: 10px; }
    .error { color: #fca5a5; }
    .muted { color: #aaa; }
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

    function escapeHtml(value) {
      return String(value).replace(/[&<>'"]/g, function (char) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\\"": "&quot;" }[char];
      });
    }

    function setStatus(message, isError) {
      document.getElementById("status").innerHTML =
        "<p class='" + (isError ? "error" : "muted") + "'>" + escapeHtml(message) + "</p>";
    }

    function authHeaders(extra) {
      return Object.assign({}, extra || {}, { Authorization: "Bearer " + token });
    }

    async function register() {
      const response = await fetch("/register", { method: "POST" });
      const data = await response.json();

      if (!response.ok) {
        setStatus(data.error || "Register error.", true);
        return;
      }

      token = data.token;
      localStorage.setItem("smsnero_token", token);
      setStatus("Registered.", false);
      load();
    }

    async function load() {
      if (!token) return;

      const response = await fetch("/numbers", { headers: authHeaders() });

      if (!response.ok) {
        setStatus("Please register again.", true);
        return;
      }

      const data = await response.json();
      let html = "";
      html += "<div class='box'>";
      html += "<h3>Add Number</h3>";
      html += "<input id='num' placeholder='e.g. +46700000001'>";
      html += "<input id='price' type='number' placeholder='price CHF'>";
      html += "<button onclick='addNumber()'>Add</button>";
      html += "</div>";

      data.forEach(function (item) {
        html += "<div class='box'>";
        html += escapeHtml(item.number) + " - " + escapeHtml(item.price) + " CHF ";
        html += "<button onclick='pay(" + Number(item.price) + "," + Number(item.id) + ")'>Buy</button>";
        html += "</div>";
      });

      document.getElementById("app").innerHTML = html;
    }

    async function addNumber() {
      const number = document.getElementById("num").value;
      const price = Number(document.getElementById("price").value);

      const response = await fetch("/marketplace/add", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ number: number, price: price })
      });

      const data = await response.json().catch(function () { return { error: "Error" }; });

      if (!response.ok) {
        setStatus(data.error || "Could not add number.", true);
        return;
      }

      setStatus("Number added.", false);
      load();
    }

    async function pay(amount, id) {
      const response = await fetch("/create-invoice", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ amount: amount, numberId: id })
      });

      const invoice = await response.json().catch(function () { return { error: "Payment error" }; });

      if (!response.ok) {
        setStatus(invoice.error || "Payment error.", true);
        return;
      }

      document.getElementById("qr").innerHTML =
        "<div class='box'>" +
        "<h3>Scan QR to Pay</h3>" +
        "<img src='" + invoice.qr + "' width='200' alt='QR code'>" +
        "<br><a href='" + escapeHtml(invoice.checkoutUrl) + "' target='_blank'>Open Checkout</a>" +
        "</div>";
    }

    const wsProtocol = location.protocol === "https:" ? "wss://" : "ws://";
    const ws = new WebSocket(wsProtocol + location.host);

    ws.onmessage = function (event) {
      const message = JSON.parse(event.data);
      document.getElementById("otp").innerHTML +=
        "<div>" + escapeHtml(message.number) + ": " + escapeHtml(message.text) +
        " (" + escapeHtml(message.otp || "") + ")</div>";
    };

    if (token) load();
  </script>
</body>
</html>`;
}

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

app.post("/register", function (req, res) {
  const user = { id: Date.now(), username: "user" + Date.now() };
  users.push(user);
  res.json({ token: signToken(user), user: user });
});

app.get("/numbers", auth, function (req, res) {
  res.json(numbers);
});

app.post("/marketplace/add", auth, function (req, res) {
  const number = String(req.body.number || "").trim();
  const price = Number(req.body.price);

  if (!number || !/^\+[1-9]\d{7,14}$/.test(number)) {
    return res.status(400).json({ error: "Use international phone format, for example +46700000001" });
  }

  if (!Number.isFinite(price) || price <= 0) {
    return res.status(400).json({ error: "Price must be a positive number" });
  }

  const item = { id: Date.now(), number: number, price: price, owner: req.user.id };
  numbers.push(item);
  return res.json(item);
});

app.post("/create-invoice", auth, async function (req, res) {
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

  const selectedNumber = numbers.find(function (item) { return item.id === numberId; });

  if (!selectedNumber) {
    return res.status(400).json({ error: "Number does not exist" });
  }

  try {
    const payload = { amount: amount, currency: "CHF", description: "SMSNero service payment" };
    const response = await fetch(SWISS_API_URL + "/v1/payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": SWISS_API_KEY,
        "x-signature": signPayload(payload)
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(function () { return {}; });

    if (!response.ok) {
      return res.status(502).json({ error: "Payment provider rejected invoice" });
    }

    const checkoutUrl = data.checkoutUrl || data.url;

    if (!checkoutUrl) {
      return res.status(502).json({ error: "Payment provider did not return checkout URL" });
    }

    const invoice = {
      id: Date.now(),
      providerPaymentId: data.id || data.paymentId,
      userId: req.user.id,
      numberId: numberId,
      status: "pending",
      amount: amount,
      checkoutUrl: checkoutUrl,
      qr: await QRCode.toDataURL(checkoutUrl),
      createdAt: new Date().toISOString()
    };

    invoices.push(invoice);
    return res.json(invoice);
  } catch (error) {
    return res.status(500).json({ error: "Payment error" });
  }
});

app.post("/webhook", function (req, res) {
  const event = req.body || {};
  const eventId = event.invoiceId || event.paymentId || event.id;

  const invoice = invoices.find(function (item) {
    return String(item.id) === String(eventId) || String(item.providerPaymentId) === String(eventId);
  });

  if (!invoice) {
    return res.sendStatus(404);
  }

  if (event.status === "paid") {
    invoice.status = "paid";
    sessions.push({
      id: Date.now(),
      userId: invoice.userId,
      numberId: invoice.numberId,
      expires: Date.now() + 10 * 60 * 1000
    });
  }

  return res.sendStatus(200);
});

app.post("/sms", function (req, res) {
  const number = String(req.body.number || "").trim();
  const text = String(req.body.text || "").trim();

  if (!number || !text) {
    return res.status(400).json({ error: "number and text are required" });
  }

  const message = {
    number: number,
    text: text,
    otp: extractOTP(text),
    time: new Date().toISOString()
  };

  messages.push(message);
  broadcast(message);
  return res.sendStatus(200);
});

app.get("/messages", auth, function (req, res) {
  res.json(messages);
});

app.get("/invoices", auth, function (req, res) {
  const userInvoices = invoices.filter(function (item) { return item.userId === req.user.id; });
  res.json(userInvoices);
});

wss.on("connection", function (socket) {
  sockets.add(socket);
  socket.on("close", function () { sockets.delete(socket); });
});

server.listen(PORT, function () {
  console.log("SMSNero running on port " + PORT);
});