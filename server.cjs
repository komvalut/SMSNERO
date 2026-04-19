"use strict";

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
const SWISS_API_KEY = process.env.SWISS_API_KEY;
const SWISS_SECRET_KEY = process.env.SWISS_SECRET_KEY;
const SWISS_API_URL = process.env.SWISS_API_URL || "https://api.swiss-bitcoin-pay.ch";
const SESSION_DURATION_HOURS = Number(process.env.SESSION_DURATION_HOURS) || 24;

if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!JWT_SECRET) throw new Error("JWT_SECRET / SESSION_SECRET is required");
if (!ADMIN_PASSWORD) throw new Error("ADMIN_PASSWORD is required");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

const sockets = new Set();
const rateBuckets = new Map();

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

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
  } catch (e) {
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
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    });
  };
}

function signPayload(payload) {
  if (!SWISS_SECRET_KEY) throw new Error("SWISS_SECRET_KEY is missing");
  return crypto.createHmac("sha256", SWISS_SECRET_KEY).update(JSON.stringify(payload)).digest("hex");
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
  await pool.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS numbers (id SERIAL PRIMARY KEY, phone_number TEXT NOT NULL UNIQUE, price_sats INTEGER NOT NULL CHECK (price_sats > 0), active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS invoices (id BIGSERIAL PRIMARY KEY, provider_payment_id TEXT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, number_id INTEGER NOT NULL REFERENCES numbers(id) ON DELETE CASCADE, amount_sats INTEGER NOT NULL CHECK (amount_sats > 0), status TEXT NOT NULL DEFAULT 'pending', checkout_url TEXT, qr TEXT, country TEXT, service TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (id BIGSERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, number_id INTEGER NOT NULL REFERENCES numbers(id) ON DELETE CASCADE, invoice_id BIGINT REFERENCES invoices(id) ON DELETE SET NULL, expires_at TIMESTAMPTZ NOT NULL, country TEXT, service TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS messages (id BIGSERIAL PRIMARY KEY, number_id INTEGER REFERENCES numbers(id) ON DELETE SET NULL, phone_number TEXT NOT NULL, text TEXT NOT NULL, otp TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS country TEXT`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS service TEXT`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS country TEXT`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS service TEXT`);
  await pool.query(`CREATE TABLE IF NOT EXISTS p2p_listings (id BIGSERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, phone_number TEXT NOT NULL, price_sats INTEGER NOT NULL CHECK (price_sats > 0), description TEXT, active BOOLEAN NOT NULL DEFAULT TRUE, approved BOOLEAN NOT NULL DEFAULT FALSE, owner_earned_sats INTEGER NOT NULL DEFAULT 0, owner_paid_sats INTEGER NOT NULL DEFAULT 0, number_id INTEGER REFERENCES numbers(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS p2p_listing_id BIGINT REFERENCES p2p_listings(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE p2p_listings ADD COLUMN IF NOT EXISTS number_id INTEGER REFERENCES numbers(id) ON DELETE SET NULL`);
  console.log("Database initialized.");
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>SMSNero</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body{background:#121212;color:white;font-family:Arial,sans-serif;margin:0}
    main{max-width:950px;margin:auto;padding:28px}
    .box{padding:16px;margin:14px 0;background:#1e1e1e;border-radius:12px;border:1px solid #333}
    button{background:#facc15;border:none;padding:10px 14px;cursor:pointer;margin:5px;font-weight:bold;border-radius:8px;color:#111}
    input,textarea,select{padding:10px;margin:5px;border-radius:8px;border:1px solid #444;background:#151515;color:white}
    a{color:#facc15}
    img{background:white;padding:8px;border-radius:10px}
    .error{color:#fca5a5}
    .muted{color:#aaa}
    .row{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
    .tabs{display:flex;gap:0;margin:18px 0 0 0;border-bottom:2px solid #333}
    .tab{background:none;border:none;color:#aaa;padding:10px 22px;font-size:1em;font-weight:bold;border-radius:10px 10px 0 0;cursor:pointer;margin:0}
    .tab.active{background:#1e1e1e;color:#facc15;border:2px solid #333;border-bottom:2px solid #1e1e1e}
    .badge{background:#facc15;color:#111;border-radius:10px;padding:1px 7px;font-size:0.78em;margin-left:5px}
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
    <div class="tabs">
      <button class="tab active" id="tab-btn-rent" onclick="switchTab('rent')">Rent</button>
      <button class="tab" id="tab-btn-p2p" onclick="switchTab('p2p')">P2P Market</button>
      <button class="tab" id="tab-btn-send" onclick="switchTab('send')">Send SMS</button>
    </div>
    <div id="tab-rent">
      <div id="qr"></div>
      <div id="numbers" class="box">Login or register to load numbers.</div>
      <div id="sessions" class="box"><h3>My active numbers</h3></div>
      <div id="otp" class="box"><h3>OTP Inbox</h3></div>
    </div>
    <div id="tab-p2p" style="display:none">
      <div class="box"><h3>P2P Market</h3><p class="muted">Numbers listed by the community. Pay via Bitcoin Lightning. Platform takes 50% commission.</p><div id="p2p-market"><p class="muted">Login to view marketplace.</p></div></div>
      <div class="box" id="p2p-submit-box" style="display:none"><h3>List your number</h3><input id="p2p-phone" placeholder="+46700000001" style="width:180px"><input id="p2p-price" type="number" min="1" placeholder="Price in sats" style="width:150px"><input id="p2p-desc" placeholder="Description (optional)" style="width:220px"><br><button onclick="submitP2P()">Submit for approval</button><p class="muted" style="font-size:0.85em;margin-top:8px;">Your earnings (50%) are tracked and paid out by the admin.</p></div>
      <div id="p2p-my-listings"></div>
    </div>
    <div id="tab-send" style="display:none">
      <div class="box" style="text-align:center;padding:40px">
        <h3>Send SMS</h3>
        <p class="muted">Coming soon &mdash; requires an outbound SMS gateway (e.g. Twilio).</p>
        <p class="muted" style="font-size:0.85em;">Contact admin to enable this feature.</p>
      </div>
    </div>
  </main>
  <script>
    var token=localStorage.getItem("smsnero_token")||"";
    var role=localStorage.getItem("smsnero_role")||"";
    var _activeTab="rent";
    function esc(v){return String(v).replace(/[&<>'"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]});}
    function setStatus(msg,err){var el=document.getElementById("status");el.className=err?"error":"muted";el.textContent=msg;}
    function authH(ex){return Object.assign({},ex||{},{Authorization:"Bearer "+token});}
    function saveSession(d){token=d.token;role=d.user.role;localStorage.setItem("smsnero_token",token);localStorage.setItem("smsnero_role",role);}
    function switchTab(name){_activeTab=name;["rent","p2p","send"].forEach(function(t){document.getElementById("tab-"+t).style.display=t===name?"block":"none";var btn=document.getElementById("tab-btn-"+t);btn.classList.toggle("active",t===name);});if(name==="p2p"&&token){loadP2PMarket();loadMyP2PListings();}}
    function logout(){token="";role="";localStorage.removeItem("smsnero_token");localStorage.removeItem("smsnero_role");setStatus("Logged out.",false);renderAdmin();document.getElementById("numbers").innerHTML="Login or register to load numbers.";document.getElementById("sessions").innerHTML="<h3>My active numbers</h3>";document.getElementById("otp").innerHTML="<h3>OTP Inbox</h3>";document.getElementById("p2p-market").innerHTML="<p class='muted'>Login to view marketplace.</p>";document.getElementById("p2p-submit-box").style.display="none";document.getElementById("p2p-my-listings").innerHTML="";}
    async function registerUser(){var r=await fetch("/register",{method:"POST"});var d=await r.json();if(!r.ok)return setStatus(d.error||"Register error.",true);saveSession(d);setStatus("Registered. Token saved.",false);refreshAll();}
    async function adminLogin(){var pw=document.getElementById("adminPass").value;var r=await fetch("/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:pw})});var d=await r.json();if(!r.ok)return setStatus(d.error||"Login failed.",true);saveSession(d);setStatus("Admin logged in.",false);refreshAll();}
    async function testSMS(){var n=prompt("Phone number (e.g. +46705536378):");if(!n)return;var t=prompt("SMS text (e.g. Your code is 123456):");if(!t)return;var r=await fetch("/test-sms",{method:"POST",headers:authH({"Content-Type":"application/json"}),body:JSON.stringify({number:n,text:t})});var d=await r.json().catch(function(){return{error:"Error"};});if(!r.ok)return setStatus(d.error||"Error.",true);setStatus("Test SMS injected! OTP: "+(d.otp||"none"),false);loadMessages();}
    function renderAdmin(){var box=document.getElementById("admin");if(role!=="admin"){box.style.display="none";box.innerHTML="";return;}box.style.display="block";box.innerHTML="<h3>Admin panel</h3><input id='an' placeholder='+46700000001'> <input id='ap' type='number' min='1' placeholder='sats'> <button onclick='addNum()'>Add number</button> <button onclick='testSMS()' style='background:#6366f1;color:white;'>Test SMS inject</button><div id='adminList'></div><hr style='border-color:#333;margin:16px 0'><h4>P2P Listings</h4><div id='adminP2PList'></div>";loadAdminNums();loadAdminP2P();}
    async function addNum(){var n=document.getElementById("an").value.trim();var p=Number(document.getElementById("ap").value);var r=await fetch("/admin/numbers",{method:"POST",headers:authH({"Content-Type":"application/json"}),body:JSON.stringify({number:n,priceSats:p})});var d=await r.json().catch(function(){return{error:"Error"};});if(!r.ok)return setStatus(d.error||"Error.",true);setStatus("Number saved.",false);loadAdminNums();loadNumbers();}
    async function delNum(id){var r=await fetch("/admin/numbers/"+id,{method:"DELETE",headers:authH()});if(!r.ok)return setStatus("Error.",true);setStatus("Disabled.",false);loadAdminNums();loadNumbers();}
    async function loadAdminNums(){if(role!=="admin")return;var r=await fetch("/admin/numbers",{headers:authH()});if(!r.ok)return;var data=await r.json();var h="";data.forEach(function(i){h+="<div class='box row'><span>"+esc(i.phone_number)+" &mdash; <strong>"+esc(i.price_sats)+" sats</strong> ["+(i.active?"active":"disabled")+"]</span><span style='display:flex;gap:6px;'><button onclick='editPrice("+i.id+","+i.price_sats+")' style='background:#6366f1;color:white;'>Edit price</button><button onclick='delNum("+i.id+")'>Disable</button></span></div>";});document.getElementById("adminList").innerHTML=h||"<p class='muted'>No numbers yet.</p>";}
    async function editPrice(id,current){var p=prompt("New price in sats (current: "+current+"):");if(!p)return;var n=Number(p);if(!Number.isInteger(n)||n<=0)return setStatus("Invalid price.",true);var r=await fetch("/admin/numbers/"+id+"/price",{method:"PUT",headers:authH({"Content-Type":"application/json"}),body:JSON.stringify({priceSats:n})});var d=await r.json().catch(function(){return{error:"Error"};});if(!r.ok)return setStatus(d.error||"Error.",true);setStatus("Price updated to "+n+" sats.",false);loadAdminNums();loadNumbers();}
    async function loadAdminP2P(){if(role!=="admin")return;var r=await fetch("/admin/p2p",{headers:authH()});if(!r.ok)return;var data=await r.json();var h="";data.forEach(function(i){var earned=i.owner_earned_sats||0;var paid=i.owner_paid_sats||0;var owed=earned-paid;h+="<div class='box'><div class='row'><span><strong>"+esc(i.phone_number)+"</strong> &mdash; "+esc(i.price_sats)+" sats &mdash; <span style='color:"+(i.approved?"#4ade80":"#fca5a5")+"'>"+(i.approved?"Approved":"Pending")+"</span></span><span style='display:flex;gap:6px;'>"+(i.approved?"":"<button onclick='approveP2P("+i.id+")' style='background:#4ade80;color:#111;'>Approve</button>")+"<button onclick='deleteP2P("+i.id+")' style='background:#ef4444;color:white;'>Remove</button></span></div><div style='margin-top:8px;font-size:0.85em;'><span class='muted'>Owner earned: </span><strong>"+earned+" sats</strong> &nbsp;|&nbsp; <span class='muted'>Paid out: </span><strong>"+paid+" sats</strong> &nbsp;|&nbsp; <span style='color:"+(owed>0?"#facc15":"#4ade80")+"'>Owed: "+owed+" sats</span>"+((owed>0)?"&nbsp;<button onclick='payoutP2P("+i.id+","+owed+")' style='background:#facc15;color:#111;padding:4px 10px;font-size:0.85em;'>Mark paid</button>":"")+"</div></div>";});document.getElementById("adminP2PList").innerHTML=h||"<p class='muted'>No P2P listings yet.</p>";}
    async function approveP2P(id){var r=await fetch("/admin/p2p/"+id+"/approve",{method:"PUT",headers:authH()});var d=await r.json().catch(function(){return{error:"Error"};});if(!r.ok)return setStatus(d.error||"Error.",true);setStatus("Listing approved.",false);loadAdminP2P();loadP2PMarket();}
    async function deleteP2P(id){if(!confirm("Remove this P2P listing?"))return;var r=await fetch("/admin/p2p/"+id,{method:"DELETE",headers:authH()});if(!r.ok)return setStatus("Error.",true);setStatus("Listing removed.",false);loadAdminP2P();loadP2PMarket();}
    async function payoutP2P(id,amount){if(!confirm("Mark "+amount+" sats as paid out to this owner?"))return;var r=await fetch("/admin/p2p/"+id+"/payout",{method:"POST",headers:authH({"Content-Type":"application/json"}),body:JSON.stringify({amount:amount})});var d=await r.json().catch(function(){return{error:"Error"};});if(!r.ok)return setStatus(d.error||"Error.",true);setStatus("Payout of "+amount+" sats marked.",false);loadAdminP2P();}
    async function submitP2P(){var phone=document.getElementById("p2p-phone").value.trim();var price=Number(document.getElementById("p2p-price").value);var desc=document.getElementById("p2p-desc").value.trim();if(!phone||!price)return setStatus("Enter phone number and price.",true);var r=await fetch("/p2p/submit",{method:"POST",headers:authH({"Content-Type":"application/json"}),body:JSON.stringify({phoneNumber:phone,priceSats:price,description:desc})});var d=await r.json().catch(function(){return{error:"Error"};});if(!r.ok)return setStatus(d.error||"Error.",true);setStatus("Listing submitted! Waiting for admin approval.",false);document.getElementById("p2p-phone").value="";document.getElementById("p2p-price").value="";document.getElementById("p2p-desc").value="";loadMyP2PListings();}
    async function loadP2PMarket(){if(!token)return;var r=await fetch("/p2p/market",{headers:authH()});if(!r.ok)return;var data=await r.json();var h="";if(!data.length)h="<p class='muted'>No listings in the marketplace yet. Be the first to list your number!</p>";data.forEach(function(i){h+="<div class='box row'><span><strong>"+esc(i.phone_number)+"</strong> &mdash; "+esc(i.price_sats)+" sats"+(i.description?"<br><span class='muted' style='font-size:0.85em;'>"+esc(i.description)+"</span>":"")+"</span><button onclick='buyP2P("+i.id+")'>Buy</button></div>";});document.getElementById("p2p-market").innerHTML=h;}
    async function loadMyP2PListings(){if(!token)return;var r=await fetch("/p2p/my-listings",{headers:authH()});if(!r.ok)return;var data=await r.json();if(!data.length){document.getElementById("p2p-my-listings").innerHTML="";document.getElementById("p2p-submit-box").style.display="block";return;}document.getElementById("p2p-submit-box").style.display="block";var h="<div class='box'><h4>My listings</h4>";data.forEach(function(i){var earned=i.owner_earned_sats||0;var paid=i.owner_paid_sats||0;h+="<div class='box' style='margin:8px 0;'><strong>"+esc(i.phone_number)+"</strong> &mdash; "+esc(i.price_sats)+" sats &mdash; <span style='color:"+(i.approved?"#4ade80":"#fca5a5")+"'>"+(i.approved?"Active":"Pending approval")+"</span><br><span class='muted' style='font-size:0.85em;'>Earned: "+earned+" sats | Paid out: "+paid+" sats | Owed: "+(earned-paid)+" sats</span></div>";});h+="</div>";document.getElementById("p2p-my-listings").innerHTML=h;}
    var _p2pData={};
    async function buyP2P(id){setStatus("Creating invoice...",false);var r=await fetch("/create-invoice",{method:"POST",headers:authH({"Content-Type":"application/json"}),body:JSON.stringify({p2pListingId:id})});var inv=await r.json().catch(function(){return{error:"Error"};});if(!r.ok)return setStatus(inv.error||"Error.",true);setStatus("Scan QR to pay.",false);_lightningInvoice=inv.lightning_invoice||"";var lnHtml="";if(_lightningInvoice){lnHtml="<textarea style='width:100%;box-sizing:border-box;background:#111;color:#facc15;border:1px solid #444;border-radius:8px;padding:8px;font-size:0.75em;margin-top:8px;resize:none;' rows='3' readonly>"+esc(_lightningInvoice)+"</textarea><br><button onclick='copyLightning()' style='margin-top:4px;'>Copy Lightning Invoice</button>";}var chkHtml=inv.checkout_url?"<br><a href='"+esc(inv.checkout_url)+"' target='_blank'>Open in Browser</a>":"";switchTab("rent");document.getElementById("qr").innerHTML="<div class='box'><h3>Scan Lightning QR (P2P)</h3><p>Amount: "+esc(inv.amount_sats)+" sats</p><img src='"+esc(inv.qr)+"' width='220' alt='QR'>"+lnHtml+chkHtml+"</div>";startPolling();}
    var COUNTRIES=["Sweden","USA","UK","Germany","France","Netherlands","Poland","Spain","Italy","Romania","Ukraine","Russia","Turkey","Brazil","India","Canada","Australia","Belgium","Czech Republic","Hungary","Portugal","Finland","Norway","Denmark","Switzerland","Austria","Greece","Serbia","Croatia","Bosnia","Slovenia","Slovakia","Bulgaria","Estonia","Latvia","Lithuania","Other"];
    var SERVICES=["Telegram","WhatsApp","Viber","Signal","Instagram","Facebook","Twitter / X","TikTok","Snapchat","Google","Apple","Microsoft","Amazon","Netflix","Uber","Airbnb","LinkedIn","Discord","Tinder","Bumble","Other"];
    var _numsData={};
    async function loadNumbers(){if(!token)return;var r=await fetch("/numbers",{headers:authH()});if(!r.ok)return setStatus("Login again.",true);var data=await r.json();_numsData={};var h="<h3>Available numbers</h3>";if(!data.length)h+="<p class='muted'>No numbers available.</p>";data.forEach(function(i){_numsData[i.id]={phone:i.phone_number,sats:i.price_sats};h+="<div class='box row'><span>"+esc(i.phone_number)+" &mdash; "+esc(i.price_sats)+" sats</span><button onclick='showBuyPanel("+i.id+")'>Buy</button></div>";});document.getElementById("numbers").innerHTML=h;}
    function showBuyPanel(id){var num=_numsData[id]||{};var phone=num.phone||"";var sats=num.sats||"";var cOpts=COUNTRIES.map(function(c){return"<option>"+esc(c)+"</option>";}).join("");var sOpts=SERVICES.map(function(s){return"<option>"+esc(s)+"</option>";}).join("");document.getElementById("qr").innerHTML="<div class='box'><h3>Select options for "+esc(phone)+"</h3><div class='row' style='gap:12px;margin-bottom:14px;'><div style='flex:1'><label class='muted' style='font-size:0.85em;'>Country</label><br><select id='selCountry' style='width:100%;padding:10px;border-radius:8px;border:1px solid #444;background:#151515;color:white;margin-top:4px;'>"+cOpts+"</select></div><div style='flex:1'><label class='muted' style='font-size:0.85em;'>Service</label><br><select id='selService' style='width:100%;padding:10px;border-radius:8px;border:1px solid #444;background:#151515;color:white;margin-top:4px;'>"+sOpts+"</select></div></div><p class='muted' style='font-size:0.9em;'>Price: "+esc(sats)+" sats</p><button onclick='buyNum("+id+")' style='width:100%;padding:12px;font-size:1em;'>Proceed to payment</button><button onclick='clearQR()' style='width:100%;background:#333;color:white;margin-top:6px;padding:10px;'>Cancel</button></div>";document.getElementById("qr").scrollIntoView({behavior:"smooth"});}
    var _lightningInvoice = "";
    var _pollTimer = null;
    function copyLightning(){if(!_lightningInvoice)return;navigator.clipboard.writeText(_lightningInvoice).then(function(){setStatus("Copied!",false);}).catch(function(){setStatus("Copy failed.",true);});}
    function clearQR(){document.getElementById("qr").innerHTML="";if(_pollTimer){clearInterval(_pollTimer);_pollTimer=null;}}
    function startPolling(){if(_pollTimer)clearInterval(_pollTimer);_pollTimer=setInterval(async function(){if(!token)return;var r=await fetch("/my-numbers",{headers:authH()});if(!r.ok)return;var data=await r.json();if(data.length){clearQR();setStatus("Payment confirmed! Your number is active.",false);loadSessions();document.getElementById("sessions").scrollIntoView({behavior:"smooth"});}},5000);}
    async function buyNum(id){setStatus("Creating invoice...",false);var country=document.getElementById("selCountry")?document.getElementById("selCountry").value:"";var service=document.getElementById("selService")?document.getElementById("selService").value:"";var r=await fetch("/create-invoice",{method:"POST",headers:authH({"Content-Type":"application/json"}),body:JSON.stringify({numberId:id,country:country,service:service})});var inv=await r.json().catch(function(){return{error:"Error"};});if(!r.ok)return setStatus(inv.error||"Error.",true);setStatus("Scan QR to pay. Waiting for confirmation...",false);_lightningInvoice=inv.lightning_invoice||"";var lnHtml="";if(_lightningInvoice){lnHtml="<textarea id='lnTxt' style='width:100%;box-sizing:border-box;background:#111;color:#facc15;border:1px solid #444;border-radius:8px;padding:8px;font-size:0.75em;margin-top:8px;resize:none;' rows='3' readonly>"+esc(_lightningInvoice)+"</textarea><br><button onclick='copyLightning()' style='margin-top:4px;'>Copy Lightning Invoice</button>";}var chkHtml=inv.checkout_url?"<br><a href='"+esc(inv.checkout_url)+"' target='_blank' style='display:inline-block;margin-top:8px;'>Open in Browser</a>":"";document.getElementById("qr").innerHTML="<div class='box'><h3>Scan Lightning QR</h3><p>Amount: "+esc(inv.amount_sats)+" sats</p><img src='"+esc(inv.qr)+"' width='220' alt='QR'>"+lnHtml+chkHtml+"<p class='muted' style='font-size:0.85em;margin-top:8px;'>Page auto-refreshes every 5 sec. After payment, scroll down to see your number.</p></div>";startPolling();}
    async function loadSessions(){if(!token||role==="admin")return;var r=await fetch("/my-numbers",{headers:authH()});if(!r.ok)return;var data=await r.json();var h="<h3>My active numbers</h3>";if(!data.length)h+="<p class='muted'>No active numbers yet.</p>";data.forEach(function(i){var tags="";if(i.country)tags+="<span style='background:#2a2a2a;border:1px solid #444;border-radius:6px;padding:2px 8px;font-size:0.8em;margin-right:6px;'>"+esc(i.country)+"</span>";if(i.service)tags+="<span style='background:#facc1522;border:1px solid #facc15;border-radius:6px;padding:2px 8px;font-size:0.8em;color:#facc15;'>"+esc(i.service)+"</span>";h+="<div class='box'><strong>"+esc(i.phone_number)+"</strong>"+(tags?" &nbsp;"+tags:"")+"<br><span class='muted' style='font-size:0.85em;'>active until "+esc(new Date(i.expires_at).toLocaleString())+"</span></div>";});document.getElementById("sessions").innerHTML=h;}
    async function loadMessages(){if(!token)return;var r=await fetch("/messages",{headers:authH()});if(!r.ok)return;var data=await r.json();var h="<h3>OTP Inbox</h3>";if(!data.length)h+="<p class='muted'>No messages yet.</p>";data.forEach(function(i){h+="<div class='box'><span class='muted'>"+esc(i.phone_number)+"</span><br>"+esc(i.text)+(i.otp?" <strong style='color:#facc15;font-size:1.2em'>"+esc(i.otp)+"</strong>":"")+"<br><span class='muted' style='font-size:0.85em'>"+esc(new Date(i.created_at).toLocaleString())+"</span></div>";});document.getElementById("otp").innerHTML=h;}
    function refreshAll(){renderAdmin();loadNumbers();loadSessions();loadMessages();}
    var wsP=location.protocol==="https:"?"wss://":"ws://";
    var ws=new WebSocket(wsP+location.host);
    ws.onopen=function(){console.log("WS connected");};
    ws.onmessage=function(e){try{var m=JSON.parse(e.data);if(m.type==="session_activated"){clearQR();setStatus("Payment confirmed! Your number is active.",false);loadSessions();loadMessages();setTimeout(function(){var el=document.getElementById("sessions");if(el)el.scrollIntoView({behavior:"smooth"});},300);}else if(m.type==="message"){loadMessages();}}catch(err){}};
    ws.onerror=function(){console.warn("WS error");};
    if(token)refreshAll();
  </script>
</body>
</html>`;

app.use(rateLimit);

app.get("/healthz", function(req, res) { res.json({ status: "ok" }); });
app.get("/favicon.ico", function(req, res) { res.status(204).end(); });
app.get("/", function(req, res) { res.send(HTML); });

app.post("/register", wrap(async function(req, res) {
  const username = "user" + Date.now();
  const result = await pool.query("INSERT INTO users (username, role) VALUES ($1, 'user') RETURNING id, username, role", [username]);
  const user = result.rows[0];
  res.json({ token: signToken(user), user: user });
}));

app.post("/admin/login", function(req, res) {
  if (String(req.body.password || "") !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: "Wrong admin password" });
  }
  const user = { id: 0, username: "admin", role: "admin" };
  return res.json({ token: signToken(user), user: user });
});

app.get("/numbers", auth, wrap(async function(req, res) {
  const result = await pool.query("SELECT id, phone_number, price_sats FROM numbers WHERE active = TRUE ORDER BY id DESC");
  res.json(result.rows);
}));

app.get("/my-numbers", auth, wrap(async function(req, res) {
  if (req.user.role === "admin") return res.json([]);
  const result = await pool.query(
    "SELECT s.id, s.expires_at, s.country, s.service, n.phone_number FROM sessions s JOIN numbers n ON n.id = s.number_id WHERE s.user_id = $1 AND s.expires_at > NOW() ORDER BY s.created_at DESC",
    [req.user.id]
  );
  res.json(result.rows);
}));

app.get("/messages", auth, wrap(async function(req, res) {
  if (req.user.role === "admin") {
    const result = await pool.query("SELECT id, phone_number, text, otp, created_at FROM messages WHERE phone_number NOT LIKE '\\%%' AND phone_number NOT LIKE '[%' ORDER BY created_at DESC LIMIT 200");
    return res.json(result.rows);
  }
  const sessResult = await pool.query("SELECT number_id FROM sessions WHERE user_id = $1 AND expires_at > NOW() ORDER BY created_at DESC", [req.user.id]);
  if (!sessResult.rows.length) return res.json([]);
  const ids = sessResult.rows.map(function(r) { return r.number_id; });
  const result = await pool.query(
    "SELECT id, phone_number, text, otp, created_at FROM messages WHERE number_id = ANY($1) AND phone_number NOT LIKE '\\%%' AND phone_number NOT LIKE '[%' AND otp IS NOT NULL ORDER BY created_at DESC LIMIT 200",
    [ids]
  );
  res.json(result.rows);
}));

app.get("/admin/numbers", auth, adminOnly, wrap(async function(req, res) {
  const result = await pool.query("SELECT id, phone_number, price_sats, active, created_at FROM numbers ORDER BY id DESC");
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
    "INSERT INTO numbers (phone_number, price_sats, active) VALUES ($1, $2, TRUE) ON CONFLICT (phone_number) DO UPDATE SET price_sats = EXCLUDED.price_sats, active = TRUE RETURNING id, phone_number, price_sats, active",
    [number, priceSats]
  );
  return res.json(result.rows[0]);
}));

app.delete("/admin/numbers/:id", auth, adminOnly, wrap(async function(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid number ID" });
  await pool.query("UPDATE numbers SET active = FALSE WHERE id = $1", [id]);
  res.json({ ok: true });
}));

app.put("/admin/numbers/:id/price", auth, adminOnly, wrap(async function(req, res) {
  const id = Number(req.params.id);
  const priceSats = Number(req.body.priceSats);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid number ID" });
  if (!Number.isInteger(priceSats) || priceSats <= 0) return res.status(400).json({ error: "Price must be a positive whole number of satoshis" });
  const result = await pool.query("UPDATE numbers SET price_sats = $1 WHERE id = $2 RETURNING id, phone_number, price_sats, active", [priceSats, id]);
  if (!result.rows.length) return res.status(404).json({ error: "Number not found" });
  res.json(result.rows[0]);
}));

app.post("/create-invoice", auth, wrap(async function(req, res) {
  if (req.user.role === "admin") return res.status(400).json({ error: "Admin cannot buy numbers" });
  if (!SWISS_API_KEY || !SWISS_SECRET_KEY) {
    return res.status(503).json({ error: "Payment not configured. Set SWISS_API_KEY and SWISS_SECRET_KEY." });
  }
  let number, p2pListingId = null;
  if (req.body.p2pListingId) {
    const lid = Number(req.body.p2pListingId);
    if (!Number.isInteger(lid) || lid <= 0) return res.status(400).json({ error: "Invalid P2P listing ID" });
    const lr = await pool.query("SELECT * FROM p2p_listings WHERE id = $1 AND approved = TRUE AND active = TRUE", [lid]);
    const listing = lr.rows[0];
    if (!listing) return res.status(400).json({ error: "P2P listing not available" });
    if (!listing.number_id) return res.status(400).json({ error: "P2P listing not linked to a number yet" });
    const nr = await pool.query("SELECT id, phone_number, price_sats FROM numbers WHERE id = $1 AND active = TRUE", [listing.number_id]);
    if (!nr.rows[0]) return res.status(400).json({ error: "P2P number not available" });
    number = nr.rows[0];
    number.price_sats = listing.price_sats;
    p2pListingId = lid;
  } else {
    const numberId = Number(req.body.numberId);
    if (!Number.isInteger(numberId) || numberId <= 0) return res.status(400).json({ error: "Invalid number ID" });
    const numberResult = await pool.query("SELECT id, phone_number, price_sats FROM numbers WHERE id = $1 AND active = TRUE", [numberId]);
    number = numberResult.rows[0];
    if (!number) return res.status(400).json({ error: "Number not available" });
  }
  const appUrl = process.env.APP_URL || ("https://" + (process.env.RENDER_EXTERNAL_HOSTNAME || "smsnero.onrender.com"));
  const payload = {
    title: "SMSNero",
    description: (p2pListingId ? "[P2P] " : "") + "Phone number: " + number.phone_number,
    amount: number.price_sats,
    unit: "sat",
    onChain: false,
    delay: 10,
    webhook: { url: appUrl + "/webhook" }
  };
  const response = await fetch(SWISS_API_URL + "/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": SWISS_API_KEY },
    body: JSON.stringify(payload),
  });
  const rawText = await response.text().catch(function() { return ""; });
  let data = {};
  try { data = JSON.parse(rawText); } catch(e) {}
  if (!response.ok) {
    console.error("Swiss Bitcoin Pay HTTP status:", response.status, "body:", rawText.slice(0, 500));
    return res.status(502).json({ error: "Payment error HTTP " + response.status + ": " + (data.message || data.error || data.detail || rawText.slice(0, 200) || "empty response") });
  }
  const checkoutUrl = data.checkoutUrl || data.url || data.paymentUrl || data.payment_url;
  const lightningInvoice = data.pr || data.paymentRequest || null;
  if (!checkoutUrl && !lightningInvoice) {
    console.error("Swiss Bitcoin Pay no URL:", JSON.stringify(data));
    return res.status(502).json({ error: "No checkout URL returned. Response: " + JSON.stringify(data) });
  }
  const qrSource = lightningInvoice || checkoutUrl;
  const qr = await QRCode.toDataURL(qrSource);
  const country = String(req.body.country || "").trim().slice(0, 100) || null;
  const service = String(req.body.service || "").trim().slice(0, 100) || null;
  const result = await pool.query(
    "INSERT INTO invoices (provider_payment_id, user_id, number_id, amount_sats, status, checkout_url, qr, country, service, p2p_listing_id) VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9) RETURNING *",
    [data.id || null, req.user.id, number.id, number.price_sats, checkoutUrl || qrSource, qr, country, service, p2pListingId]
  );
  const row = result.rows[0];
  row.lightning_invoice = lightningInvoice;
  return res.json(row);
}));

app.post("/webhook", wrap(async function(req, res) {
  const event = req.body || {};
  console.log("Webhook received from Swiss Bitcoin Pay:", JSON.stringify(event));
  const eventId = event.invoiceId || event.paymentId || event.id;
  const status = String(event.status || "").toLowerCase();
  if (!eventId) return res.sendStatus(400);
  const invoiceResult = await pool.query("SELECT * FROM invoices WHERE id::text = $1 OR provider_payment_id = $1 LIMIT 1", [String(eventId)]);
  const invoice = invoiceResult.rows[0];
  if (!invoice) return res.sendStatus(404);
  if (status === "paid" || status === "settled" || status === "confirmed") {
    await pool.query("UPDATE invoices SET status = 'paid' WHERE id = $1", [invoice.id]);
    const expiresAt = new Date(Date.now() + SESSION_DURATION_HOURS * 3600000);
    await pool.query("INSERT INTO sessions (user_id, number_id, invoice_id, expires_at, country, service) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING", [invoice.user_id, invoice.number_id, invoice.id, expiresAt, invoice.country || null, invoice.service || null]);
    if (invoice.p2p_listing_id) {
      const ownerShare = Math.floor(invoice.amount_sats * 0.5);
      await pool.query("UPDATE p2p_listings SET owner_earned_sats = owner_earned_sats + $1 WHERE id = $2", [ownerShare, invoice.p2p_listing_id]);
    }
    broadcast({ type: "session_activated", userId: invoice.user_id, numberId: invoice.number_id });
    return res.sendStatus(200);
  }
  if (status === "expired" || status === "cancelled" || status === "failed") {
    await pool.query("UPDATE invoices SET status = $1 WHERE id = $2", [status, invoice.id]);
  }
  return res.sendStatus(200);
}));

app.post("/test-sms", auth, adminOnly, wrap(async function(req, res) {
  const { number, text } = req.body || {};
  if (!number || !text) return res.status(400).json({ error: "Need number and text" });
  const numRes = await pool.query("SELECT id FROM numbers WHERE phone_number = $1 LIMIT 1", [number]);
  if (!numRes.rows.length) return res.status(404).json({ error: "Number not found" });
  const numberId = numRes.rows[0].id;
  const otp = extractOTP(text);
  await pool.query("INSERT INTO messages (number_id, phone_number, text, otp) VALUES ($1, $2, $3, $4)", [numberId, "+000test", text, otp]);
  broadcast({ type: "message", phoneNumber: "+000test", text: text, otp: otp });
  return res.json({ ok: true, otp: otp });
}));

app.post("/sms-webhook", wrap(async function(req, res) {
  const body = req.body || {};
  console.log("=== SMS WEBHOOK ===");
  console.log("Query:", JSON.stringify(req.query));
  console.log("Body:", JSON.stringify(body));
  console.log("Headers content-type:", req.headers["content-type"]);
  const sender = String(req.query.from || req.query.sender || req.query.originator || body.from || body.phone || body.sender || body.originator || body.msisdn || "").trim();
  const text = String(req.query.text || req.query.body || req.query.message || req.query.sms || body.text || body.message || body.body || body.sms || body.content || "").trim();
  console.log("Parsed sender:", sender, "text:", text);
  if (!sender || !text) {
    console.log("SMS webhook missing fields");
    return res.status(400).json({ error: "Missing sender and text fields", received: { query: req.query, body: body } });
  }
  // Find which of our rented numbers received this SMS:
  // 1. Check explicit "to" field in body or query param
  // 2. Fallback: use any currently active rented number
  const toField = String(req.query.to || req.query.number || body.to || body.recipient || body.number || "").trim();
  let numberId = null;
  if (toField) {
    const toResult = await pool.query("SELECT id FROM numbers WHERE phone_number = $1 LIMIT 1", [toField]);
    if (toResult.rows.length) numberId = toResult.rows[0].id;
  }
  if (!numberId) {
    // Fallback: assign to the most recently active rented number
    const activeResult = await pool.query("SELECT number_id FROM sessions WHERE expires_at > NOW() ORDER BY created_at DESC LIMIT 1");
    if (activeResult.rows.length) numberId = activeResult.rows[0].number_id;
  }
  console.log("SMS assigned to number_id:", numberId, "from:", sender);
  const otp = extractOTP(text);
  await pool.query("INSERT INTO messages (number_id, phone_number, text, otp) VALUES ($1, $2, $3, $4)", [numberId, sender, text, otp]);
  broadcast({ type: "message", phoneNumber: sender, text: text, otp: otp });
  return res.sendStatus(200);
}));

// P2P: submit a listing
app.post("/p2p/submit", auth, wrap(async function(req, res) {
  if (req.user.role === "admin") return res.status(400).json({ error: "Admin cannot submit P2P listings" });
  const phone = String(req.body.phoneNumber || "").trim();
  const price = Number(req.body.priceSats);
  const desc = String(req.body.description || "").trim().slice(0, 300) || null;
  if (!phone || !phone.startsWith("+")) return res.status(400).json({ error: "Phone number must start with +" });
  if (!Number.isInteger(price) || price <= 0) return res.status(400).json({ error: "Price must be a positive integer in sats" });
  const r = await pool.query(
    "INSERT INTO p2p_listings (user_id, phone_number, price_sats, description) VALUES ($1, $2, $3, $4) RETURNING id",
    [req.user.id, phone, price, desc]
  );
  res.json({ ok: true, id: r.rows[0].id });
}));

// P2P: get marketplace (approved & active listings, not owned by self)
app.get("/p2p/market", auth, wrap(async function(req, res) {
  const r = await pool.query(
    "SELECT id, phone_number, price_sats, description FROM p2p_listings WHERE approved = TRUE AND active = TRUE AND user_id <> $1 ORDER BY created_at DESC",
    [req.user.id]
  );
  res.json(r.rows);
}));

// P2P: get own listings with earnings
app.get("/p2p/my-listings", auth, wrap(async function(req, res) {
  const r = await pool.query(
    "SELECT id, phone_number, price_sats, description, approved, active, owner_earned_sats, owner_paid_sats FROM p2p_listings WHERE user_id = $1 ORDER BY created_at DESC",
    [req.user.id]
  );
  res.json(r.rows);
}));

// ADMIN: view all P2P listings
app.get("/admin/p2p", auth, adminOnly, wrap(async function(req, res) {
  const r = await pool.query(
    "SELECT p.*, u.username FROM p2p_listings p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC"
  );
  res.json(r.rows);
}));

// ADMIN: approve a P2P listing (adds number to numbers table)
app.put("/admin/p2p/:id/approve", auth, adminOnly, wrap(async function(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid ID" });
  const lr = await pool.query("SELECT * FROM p2p_listings WHERE id = $1", [id]);
  const listing = lr.rows[0];
  if (!listing) return res.status(404).json({ error: "Listing not found" });
  // Upsert the number into the numbers table
  const nr = await pool.query(
    "INSERT INTO numbers (phone_number, price_sats) VALUES ($1, $2) ON CONFLICT (phone_number) DO UPDATE SET active = TRUE, price_sats = EXCLUDED.price_sats RETURNING id",
    [listing.phone_number, listing.price_sats]
  );
  const numberId = nr.rows[0].id;
  await pool.query("UPDATE p2p_listings SET approved = TRUE, active = TRUE, number_id = $1 WHERE id = $2", [numberId, id]);
  res.json({ ok: true });
}));

// ADMIN: remove/deactivate a P2P listing
app.delete("/admin/p2p/:id", auth, adminOnly, wrap(async function(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid ID" });
  await pool.query("UPDATE p2p_listings SET active = FALSE WHERE id = $1", [id]);
  res.json({ ok: true });
}));

// ADMIN: mark a payout as done
app.post("/admin/p2p/:id/payout", auth, adminOnly, wrap(async function(req, res) {
  const id = Number(req.params.id);
  const amount = Number(req.body.amount);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid ID" });
  if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
  await pool.query("UPDATE p2p_listings SET owner_paid_sats = owner_paid_sats + $1 WHERE id = $2", [amount, id]);
  res.json({ ok: true });
}));

wss.on("connection", function(socket) {
  sockets.add(socket);
  socket.on("close", function() { sockets.delete(socket); });
  socket.on("error", function() { sockets.delete(socket); });
});

initDb().then(function() {
  server.listen(PORT, function() {
    console.log("SMSNero running on port " + PORT);
  });
}).catch(function(err) {
  console.error("Failed to initialize database:", err);
  process.exit(1);
});
