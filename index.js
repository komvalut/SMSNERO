const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const API_KEY = process.env.SWISS_API_KEY;
const BASE_URL = process.env.RENDER_EXTERNAL_URL;

let bazaBrojeva = []; 
let zadnjiKod = "Čekam uplatu...";
let statusUplate = false;

app.get('/', (req, res) => {
    let stavke = bazaBrojeva.map(b => `
        <div style="background:#1a1a1a; margin:10px 0; padding:18px; border-radius:15px; display:flex; justify-content:space-between; align-items:center; border:1px solid #2a2a2a;">
            <span style="font-size:15px; letter-spacing:1px; color:#eee; font-weight:bold;">RS ${b.broj}</span>
            <button onclick="buy(${b.cena})" style="background:none; border:1px solid #ff9500; color:#ff9500; padding:8px 16px; border-radius:10px; cursor:pointer; font-weight:bold; transition: 0.3s;">${b.cena} sats</button>
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
        .nav-btn { background: #1a1a1a; border: none; color: #666; padding: 12px 20px; border-radius: 12px; font-weight: bold; font-size: 12px; }
        .active { background: #222; color: #ff9500; border: 1px solid #333; }
        .card { background: #151515; max-width: 400px; margin: auto; padding: 25px; border-radius: 25px; border: 1px solid #222; }
        input { background: #000; border: 1px solid #333; color: #fff; padding: 12px; width: 85%; border-radius: 10px; margin-bottom: 10px; outline: none; }
        .btn-post { background: #ff9500; color: black; border: none; width: 92%; padding: 15px; border-radius: 12px; font-weight: bold; cursor: pointer; margin-bottom: 20px; }
        .invoice-box { background: #000; border: 2px dashed #ff9500; padding: 20px; margin-top: 20px; border-radius: 20px; }
        #qrcode { background: white; padding: 15px; display: inline-block; margin: 15px 0; border-radius: 15px; }
        #qrcode img { margin: 0 auto; }
        h1 { font-style: italic; font-size: 32px; margin-bottom: 5px; letter-spacing: -1px; }
    </style>
</head>
<body>
    <h1>SMSNERO ⚡</h1>
    <div class="node"><span class="dot"></span> Node: Online</div>

    <div class="nav">
        <button class="nav-btn">RECEIVE</button>
        <button class="nav-btn active">P2P MARKET</button>
        <button class="nav-btn">RENT</button>
    </div>

    <div class="card">
        <h3 style="margin-top:0; color:#888; font-size:14px;">Admin: Post to Market</h3>
        <input id="num" placeholder="+381 64 XXX XXXX">
        <input id="prc" type="number" placeholder="Cena u sats">
        <button class="btn-post" onclick="postToMarket()">POST TO MARKET</button>

        <div id="market-list">${stavke}</div>

        <div id="payment-area" style="display:none;">
            <div class="invoice-box">
                <h3 id="inv-status" style="color:#ff9500; margin:0;">Generating QR...</h3>
                <div id="qrcode"></div>
                <p style="font-size:11px; color:#555; word-break:break-all;" id="inv-text"></p>
                <p style="margin-bottom:0; font-weight:bold;">Waiting for payment...</p>
            </div>
        </div>
    </div>

    <div style="margin-top:30px; font-size:12px; color:#333;">
        Support | My History
    </div>

    <script>
        async function postToMarket() {
            const b = document.getElementById('num').value;
            const c = document.getElementById('prc').value;
            if(!b || !c) return;
            await fetch('/admin/add', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({broj:b, cena:c})});
            location.reload();
        }

        let invId = null;
        async function buy(amount) {
            document.getElementById('payment-area').scrollIntoView({behavior: 'smooth'});
            document.getElementById('payment-area').style.display = 'block';
            document.getElementById('qrcode').innerHTML = "";
            
            const r = await fetch('/api/create-inv', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({amount: amount})});
            const d = await r.json();
            
            if(d.pr) { 
                document.getElementById('inv-status').innerText = "Scan to Pay " + amount + " sats";
                new QRCode(document.getElementById("qrcode"), { text: d.pr, width: 180, height: 180 });
                document.getElementById('inv-text').innerText = d.pr;
                invId = d.id;
            }
        }

        setInterval(async () => {
            if(!invId) return;
            const r = await fetch('/api/check-status');
            const d = await r.json();
            if(d.paid) {
                document.body.innerHTML = "<div style='padding-top:150px; background:#0b0b0b; height:100vh;'><h1>KOD:</h1><div style='font-size:60px; color:#ff9500; border:4px dashed #ff9500; padding:30px; display:inline-block; margin-top:20px;'>"+d.code+"</div><br><button onclick='location.reload()' style='margin-top:40px; background:#222; color:white; border:none; padding:15px 30px; border-radius:15px; cursor:pointer;'>Back to Market</button></div>";
            }
        }, 2000);
    </script>
</body>
</html>`);
});

app.post('/admin/add', (req, res) => {
    bazaBrojeva.push({ id: Date.now().toString(), broj: req.body.broj, cena: parseInt(req.body.cena) });
    res.sendStatus(200);
});

app.post('/api/incoming-sms', (req, res) => {
    zadnjiKod = req.body.message || req.body.text;
    res.send("OK");
});

app.post('/api/webhook', (req, res) => {
    if (req.body.status === 'confirmed' || req.body.status === 'paid') statusUplate = true;
    res.send("OK");
});

app.get('/api/check-status', (req, res) => {
    res.json({ paid: statusUplate, code: zadnjiKod });
});

app.post('/api/create-inv', async (req, res) => {
    try {
        const r = await axios.post('https://api.swiss-bitcoin-pay.ch/checkout', {
            amount: req.body.amount, unit: "sats", description: "SMS OTP",
            webhook: BASE_URL + '/api/webhook'
        }, { headers: { 'api-key': API_KEY } });
        statusUplate = false;
        res.json({ pr: r.data.paymentRequest, id: r.data.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(process.env.PORT || 10000);
