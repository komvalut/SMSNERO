const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const API_KEY = process.env.SWISS_API_KEY;
const BASE_URL = process.env.RENDER_EXTERNAL_URL;

let trenutnaCena = 500; 
let zadnjiKod = "Čekam uplatu...";
let statusUplate = false;

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { background: #0b0b0b; color: white; font-family: sans-serif; text-align: center; margin: 0; padding-top: 40px; }
        .node { color: #0f0; font-size: 13px; margin-bottom: 15px; }
        .nav { display: flex; justify-content: center; gap: 8px; margin-bottom: 25px; }
        .nav-btn { background: #222; border: none; color: #666; padding: 12px 20px; border-radius: 12px; font-weight: bold; font-size: 12px; }
        .active { background: #333; color: #ff9500; border: 1px solid #444; }
        .container { background: #151515; max-width: 380px; margin: auto; padding: 25px; border-radius: 25px; border: 1px solid #222; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        .market-item { background: #1a1a1a; margin: 12px 0; padding: 18px; border-radius: 18px; display: flex; justify-content: space-between; align-items: center; border: 1px solid #2a2a2a; }
        .buy-btn { background: none; border: 1px solid #ff9500; color: #ff9500; padding: 8px 16px; border-radius: 10px; cursor: pointer; font-weight: bold; font-size: 14px; }
        .buy-btn:hover { background: #ff9500; color: black; }
        h1 { font-style: italic; font-size: 28px; margin-bottom: 5px; }
        .footer-links { margin-top: 30px; font-size: 12px; color: #444; }
        .footer-links a { color: #4477ff; text-decoration: none; margin: 0 10px; }
    </style>
</head>
<body>
    <h1>SMSNERO ⚡</h1>
    <div class="node">● Node: <span style="color:#0f0">Online</span></div>

    <div class="nav">
        <button class="nav-btn">RECEIVE</button>
        <button class="nav-btn active">P2P MARKET</button>
        <button class="nav-btn">RENT</button>
    </div>

    <div class="container">
        <h2 style="margin:0; font-size:20px;">P2P SMS Market</h2>
        <p style="color: #666; font-size: 14px; margin-bottom: 20px;">Buy SMS from private sellers</p>
        
        <div class="market-item">
            <span style="font-size:15px; letter-spacing:1px;">RS +381 64 XXX XXXX</span>
            <button class="buy-btn" onclick="buy()">${trenutnaCena} sats</button>
        </div>

        <div class="market-item">
            <span style="font-size:15px; letter-spacing:1px;">RS +381 61 TEST BR</span>
            <button class="buy-btn" onclick="buy()">450 sats</button>
        </div>

        <p style="font-size:12px; color:#444; margin-top:15px;">Sellers: Alby Connected</p>
        <div id="status" style="margin-top:15px; color:#ff9500; font-weight:bold;"></div>
    </div>

    <div class="footer-links">
        <a href="#">Support</a> | <a href="#">My History</a>
    </div>

    <script>
        let invId = null;
        async function buy() {
            document.getElementById('status').innerText = "Generating Invoice...";
            try {
                const r = await fetch('/api/create-inv', {method:'POST'});
                const d = await r.json();
                if(d.url) { invId = d.id; window.location.href = d.url; }
                else { document.getElementById('status').innerText = "Error!"; }
            } catch(e) { document.getElementById('status').innerText = "Server error."; }
        }
        setInterval(async () => {
            if(!invId) return;
            const r = await fetch('/api/check-status');
            const d = await r.json();
            if(d.paid && d.code != "Čekam uplatu...") {
                document.body.innerHTML = "<div style='padding-top:150px; background:#0b0b0b; height:100vh;'><h1>TVOJ KOD:</h1><div style='font-size:60px; color:#ff9500; border:4px dashed #ff9500; display:inline-block; padding:30px; margin-top:20px;'>"+d.code+"</div><br><button onclick='location.reload()' style='margin-top:30px; background:#222; color:white; border:none; padding:10px 20px; border-radius:10px;'>Nazad</button></div>";
            }
        }, 3000);
    </script>
</body>
</html>
    `);
});

// --- BACKEND LOGIKA (Automatika + Admin) ---

app.post('/api/incoming-sms', (req, res) => {
    zadnjiKod = req.body.message || req.body.text;
    res.send("OK");
});

app.post('/api/webhook', (req, res) => {
    if (req.body.status === 'confirmed' || req.body.status === 'paid') {
        statusUplate = true;
    }
    res.send("OK");
});

app.get('/api/check-status', (req, res) => { res.json({ paid: statusUplate, code: zadnjiKod }); });

app.post('/api/create-inv', async (req, res) => {
    try {
        const r = await axios.post('https://api.swiss-bitcoin-pay.ch/checkout', {
            amount: trenutnaCena, unit: "sats", description: "SMS P2P Market",
            webhook: BASE_URL + '/api/webhook'
        }, { headers: { 'api-key': API_KEY } });
        statusUplate = false;
        res.json({ url: r.data.checkoutUrl, id: r.data.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin panel za cenu i ručno kucanje
app.post('/admin/set-price', (req, res) => { trenutnaCena = req.body.cena; res.sendStatus(200); });
app.get('/admin-nero', (req, res) => {
    res.send(`<h1>Admin</h1><input id="c" placeholder="Cena"><button onclick="fetch('/admin/set-price',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cena:document.getElementById('c').value})})">Set Price</button>`);
});

app.listen(process.env.PORT || 10000);
