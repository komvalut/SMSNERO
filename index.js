const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const API_KEY = process.env.SWISS_API_KEY;
const BASE_URL = process.env.RENDER_EXTERNAL_URL;

// Ovde se čuvaju brojevi koje ubaciš
let bazaBrojeva = []; 
let zadnjiKod = "Čekam uplatu...";
let statusUplate = false;

// --- GLAVNI SAJT (Ono što kupci vide) ---
app.get('/', (req, res) => {
    let stavke = bazaBrojeva.length > 0 ? bazaBrojeva.map(b => `
        <div style="background:#1a1a1a; margin:12px 0; padding:18px; border-radius:18px; display:flex; justify-content:space-between; align-items:center; border:1px solid #2a2a2a;">
            <span style="font-size:15px; letter-spacing:1px; color:#eee;">RS ${b.broj}</span>
            <button onclick="buy(${b.cena})" style="background:none; border:1px solid #ff9500; color:#ff9500; padding:8px 16px; border-radius:10px; cursor:pointer; font-weight:bold;">${b.cena} sats</button>
        </div>
    `).join('') : '<p style="color:#666;">Trenutno nema dostupnih brojeva.</p>';

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
        .container { background: #151515; max-width: 380px; margin: auto; padding: 25px; border-radius: 25px; border: 1px solid #222; }
    </style>
</head>
<body>
    <h1>SMSNERO ⚡</h1>
    <div class="node">● Node: Online</div>
    <div class="nav">
        <button class="nav-btn">RECEIVE</button>
        <button class="nav-btn active">P2P MARKET</button>
        <button class="nav-btn">RENT</button>
    </div>
    <div class="container">
        <h2 style="margin:0; font-size:20px;">P2P SMS Market</h2>
        <p style="color:#666; font-size:14px; margin-bottom:20px;">Izaberite broj i kupite OTP kod</p>
        ${stavke}
        <div id="status" style="margin-top:15px; color:#ff9500; font-weight:bold;"></div>
    </div>
    <script>
        let invId = null;
        async function buy(cena) {
            document.getElementById('status').innerText = "Otvaram račun...";
            const r = await fetch('/api/create-inv', {
                method:'POST', 
                headers:{'Content-Type':'application/json'}, 
                body:JSON.stringify({amount: cena})
            });
            const d = await r.json();
            if(d.url) { invId = d.id; window.location.href = d.url; }
        }
        setInterval(async () => {
            if(!invId) return;
            const r = await fetch('/api/check-status');
            const d = await r.json();
            if(d.paid) {
                document.body.innerHTML = "<div style='padding-top:150px;'><h1>KOD:</h1><div style='font-size:60px; color:#ff9500; border:4px dashed #ff9500; padding:30px; display:inline-block;'>"+d.code+"</div></div>";
            }
        }, 3000);
    </script>
</body>
</html>`);
});

// --- ADMIN PANEL (Direktno ubacivanje na /admin-nero) ---
app.get('/admin-nero', (req, res) => {
    let trenutni = bazaBrojeva.map(b => `
        <div style="border-bottom:1px solid #333; padding:10px; display:flex; justify-content:space-between;">
            <span>${b.broj} - <b>${b.cena} sats</b></span>
            <button onclick="obrisi('${b.id}')" style="background:red; color:white; border:none; cursor:pointer;">X</button>
        </div>
    `).join('');

    res.send(`
        <body style="background:#000; color:#0f0; padding:20px; font-family:monospace;">
            <h1>⚡ ADMIN PANEL</h1>
            <div style="background:#111; padding:20px; border:2px solid #0f0; border-radius:10px;">
                <h3>DODAJ BROJ I CENU:</h3>
                <input id="n" placeholder="Broj telefona (npr +381...)" style="padding:10px; width:200px;">
                <input id="c" type="number" placeholder="Cena u sats" style="padding:10px; width:100px;">
                <button onclick="dodaj()" style="padding:10px; background:#0f0; color:#000; font-weight:bold; cursor:pointer;">UBCI NA SAJT</button>
            </div>
            <br>
            <div style="background:#111; padding:20px; border:1px solid #444;">
                <h3>BROJEVI KOJI SU ONLINE:</h3>
                ${trenutni}
            </div>
            <br>
            <div style="background:#111; padding:20px; border:1px solid #ff9500;">
                <h3>RUČNI SMS KOD:</h3>
                <input id="k" placeholder="Unesi kod ovde" style="padding:10px;">
                <button onclick="pusti()" style="padding:10px; background:#ff9500; color:#000; font-weight:bold;">PUSTI KUPCU</button>
            </div>
            <script>
                async function dodaj() {
                    const b = document.getElementById('n').value;
                    const c = document.getElementById('c').value;
                    await fetch('/admin/add-number', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({broj:b, cena:c})});
                    location.reload();
                }
                async function obrisi(id) {
                    await fetch('/admin/delete-number', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id:id})});
                    location.reload();
                }
                async function pusti() {
                    const kod = document.getElementById('k').value;
                    await fetch('/api/incoming-sms', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({message:kod})});
                    alert('Kod je postavljen i čeka uplatu!');
                }
            </script>
        </body>
    `);
});

// --- LOGIKA I RUTE ---

app.post('/admin/add-number', (req, res) => {
    bazaBrojeva.push({ id: Date.now().toString(), broj: req.body.broj, cena: parseInt(req.body.cena) });
    res.sendStatus(200);
});

app.post('/admin/delete-number', (req, res) => {
    bazaBrojeva = bazaBrojeva.filter(b => b.id !== req.body.id);
    res.sendStatus(200);
});

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
        res.json({ url: r.data.checkoutUrl, id: r.data.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(process.env.PORT || 10000);
