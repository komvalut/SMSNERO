const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const API_KEY = process.env.SWISS_API_KEY;
const BASE_URL = process.env.RENDER_EXTERNAL_URL;

let bazaBrojeva = []; 
let zadnjiKod = "Waiting for SMS...";
let statusUplate = false;

app.get('/', (req, res) => {
    let stavke = bazaBrojeva.map(b => `
        <div class="market-item">
            <div style="text-align:left;">
                <span style="font-size:10px; color:#ff9500; display:block;">${b.countryCode}</span>
                <span style="font-size:15px; color:#eee; font-weight:bold;">${b.broj}</span>
            </div>
            <button onclick="buy(${b.cena})" class="buy-btn">${b.cena} sats</button>
        </div>
    `).join('');

    res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
    <style>
        body { background: #0b0b0b; color: white; font-family: sans-serif; text-align: center; margin: 0; padding: 20px; }
        .node { color: #0f0; font-size: 13px; margin-bottom: 15px; display: flex; align-items: center; justify-content: center; gap: 5px; }
        .dot { height: 8px; width: 8px; background-color: #0f0; border-radius: 50%; display: inline-block; }
        .nav { display: flex; justify-content: center; gap: 8px; margin-bottom: 25px; }
        .nav-btn { background: #1a1a1a; border: none; color: #666; padding: 12px 20px; border-radius: 12px; font-weight: bold; font-size: 11px; cursor: pointer; }
        .active { background: #222 !important; color: #ff9500 !important; border: 1px solid #333; }
        .card { background: #151515; max-width: 400px; margin: auto; padding: 25px; border-radius: 25px; border: 1px solid #222; min-height: 300px; }
        .market-item { background:#1a1a1a; margin:10px 0; padding:15px; border-radius:15px; display:flex; justify-content:space-between; align-items:center; border:1px solid #2a2a2a; }
        .buy-btn { background:none; border:1px solid #ff9500; color:#ff9500; padding:8px 15px; border-radius:10px; cursor:pointer; font-weight:bold; }
        input, select { background: #000; border: 1px solid #333; color: #fff; padding: 12px; width: 92%; border-radius: 10px; margin-bottom: 10px; }
        .btn-post { background: #ff9500; color: black; border: none; width: 92%; padding: 15px; border-radius: 12px; font-weight: bold; cursor: pointer; }
        .invoice-box { background: #000; border: 2px dashed #ff9500; padding: 20px; margin-top: 20px; border-radius: 20px; }
        #qrcode { background: white; padding: 15px; display: inline-block; margin: 15px 0; border-radius: 15px; }
        h1 { font-style: italic; font-size: 32px; margin-bottom: 5px; letter-spacing: -1px; }
        .section { display: none; }
        .section.show { display: block; }
    </style>
</head>
<body>
    <h1>SMSNERO ⚡</h1>
    <div class="node"><span class="dot"></span> Node: Online</div>

    <div class="nav">
        <button class="nav-btn" onclick="showSection('receive', this)">RECEIVE</button>
        <button class="nav-btn active" onclick="showSection('market', this)">P2P MARKET</button>
        <button class="nav-btn" onclick="showSection('rent', this)">RENT</button>
    </div>

    <div class="card">
        <div id="receive" class="section">
            <h2 style="color:#ff9500;">Direct Receive</h2>
            <p style="color:#666;">Enter your target number to check for SMS.</p>
            <input type="text" placeholder="Check SMS for number...">
            <button class="btn-post" style="background:#222; color:#eee;">Check Now</button>
        </div>

        <div id="market" class="section show">
            <h3 style="margin-top:0; color:#888; font-size:12px;">Admin: Post to Market</h3>
            <select id="country">
                <option value="RS">🇷🇸 Serbia</option>
                <option value="SE">🇸🇪 Sweden</option>
                <option value="DE">🇩🇪 Germany</option>
                <option value="US">🇺🇸 USA</option>
            </select>
            <input id="num" placeholder="Phone Number">
            <input id="prc" type="number" placeholder="Price in sats">
            <button class="btn-post" onclick="postToMarket()">POST TO MARKET</button>
            <hr style="border:0.5px solid #222; margin:20px 0;">
            ${stavke.length > 0 ? stavke : '<p style="color:#444;">No numbers available.</p>'}
        </div>

        <div id="rent" class="section">
            <h2 style="color:#ff9500;">Rent Number</h2>
            <p style="color:#666;">Long-term rentals (7-30 days).</p>
            <div class="market-item"><span>Private UK (+44)</span> <button class="buy-btn">5000 sats</button></div>
            <div class="market-item"><span>Private DE (+49)</span> <button class="buy-btn">4500 sats</button></div>
        </div>

        <div id="payment-area" style="display:none;">
            <div class="invoice-box">
                <h3 id="inv-status" style="color:#ff9500; margin:0;">Pay to Reveal</h3>
                <div id="qrcode"></div>
                <p style="font-size:10px; color:#444; word-break:break-all;" id="inv-text"></p>
                <p>Waiting for payment...</p>
            </div>
        </div>
    </div>

    <script>
        function showSection(id, btn) {
            document.querySelectorAll('.section').forEach(s => s.classList.remove('show'));
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
            document.getElementById(id).classList.add('show');
            btn.classList.add('active');
            document.getElementById('payment-area').style.display = 'none';
        }

        async function postToMarket() {
            const b = document.getElementById('num').value;
            const c = document.getElementById('prc').value;
            const country = document.getElementById('country').value;
            if(!b || !c) return;
            await fetch('/admin/add', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({broj:b, cena:c, country:country})});
            location.reload();
        }

        let invId = null;
        async function buy(amount) {
            document.getElementById('payment-area').style.display = 'block';
            document.getElementById('qrcode').innerHTML = "";
            const r = await fetch('/api/create-inv', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({amount: amount})});
            const d = await r.json();
            if(d.pr) { 
                new QRCode(document.getElementById("qrcode"), { text: d.pr, width: 160, height: 160 });
                document.getElementById('inv-text').innerText = d.pr;
                invId = d.id;
            }
        }

        setInterval(async () => {
            if(!invId) return;
            const r = await fetch('/api/check-status');
            const d = await r.json();
            if(d.paid) {
                document.body.innerHTML = "<div style='padding-top:100px; background:#0b0b0b; height:100vh;'><h1>CODE:</h1><div style='font-size:60px; color:#ff9500; border:4px dashed #ff9500; padding:30px; display:inline-block;'>"+d.code+"</div></div>";
            }
        }, 3000);
    </script>
</body>
</html>`);
});

app.post('/admin/add', (req, res) => {
    bazaBrojeva.push({ id: Date.now().toString(), broj: req.body.broj, cena: parseInt(req.body.cena), countryCode: req.body.country });
    res.sendStatus(200);
});
app.post('/api/incoming-sms', (req, res) => { zadnjiKod = req.body.message || req.body.text; res.send("OK"); });
app.get('/api/check-status', (req, res) => { res.json({ paid: statusUplate, code: zadnjiKod }); });
app.post('/api/webhook', (req, res) => { if(req.body.status === 'confirmed' || req.body.status === 'paid') statusUplate = true; res.send("OK"); });
app.post('/api/create-inv', async (req, res) => {
    try {
        const r = await axios.post('https://api.swiss-bitcoin-pay.ch/checkout', { amount: req.body.amount, unit: "sats", description: "SMS", webhook: BASE_URL + '/api/webhook' }, { headers: { 'api-key': API_KEY } });
        statusUplate = false;
        res.json({ pr: r.data.paymentRequest, id: r.data.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(process.env.PORT || 10000);
