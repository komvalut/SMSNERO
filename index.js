const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const API_KEY = process.env.SWISS_API_KEY;
const BASE_URL = process.env.RENDER_EXTERNAL_URL;

let trenutnaCenaSats = 100; 
let zadnjiKod = "Čekam uplatu i SMS...";
let statusUplate = false;

// --- KONTROLNA TABLA (/admin-nero) ---
app.get('/admin-nero', (req, res) => {
    res.send(`
        <body style="background:#1a1a1a; color:#0f0; font-family:monospace; padding:30px;">
            <h1>⚡ GAZDA PANEL</h1>
            <p>Trenutna cena: <b>${trenutnaCenaSats} sats</b></p>
            <input type="number" id="c" placeholder="Nova cena"><button onclick="setC()">SET</button>
            <hr>
            <p>Zadnji primljeni kod: <b style="color:white;">${zadnjiKod}</b></p>
            <input type="text" id="k" placeholder="Ručni kod"><button onclick="setK()">PUSTI RUČNO</button>
            <script>
                async function setC(){ await fetch('/admin/set-price',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cena:document.getElementById('c').value})}); location.reload(); }
                async function setK(){ await fetch('/api/incoming-sms',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:document.getElementById('k').value})}); alert('Poslato!'); }
            </script>
        </body>
    `);
});

// --- SAJT ZA KUPCE ---
app.get('/', (req, res) => {
    res.send(`
        <body style="background:#0b0b0b; color:white; font-family:sans-serif; text-align:center; padding-top:100px;">
            <h1>SMSNERO ⚡</h1>
            <p>Cena: ${trenutnaCenaSats} sats</p>
            <button onclick="buy()" style="padding:20px; background:#ff9500; font-weight:bold; cursor:pointer;">KUPI KOD</button>
            <div id="st" style="margin-top:20px; color:#ff9500;"></div>
            <script>
                let id = null;
                async function buy(){
                    const r = await fetch('/api/create-inv',{method:'POST'});
                    const d = await r.json();
                    if(d.url){ id = d.id; window.location.href = d.url; }
                }
                setInterval(async () => {
                    if(!id) return;
                    const r = await fetch('/api/check-status');
                    const d = await r.json();
                    if(d.paid && d.code != "Čekam uplatu i SMS...") {
                        document.body.innerHTML = "<h1>KOD: "+d.code+"</h1>";
                    }
                }, 3000);
            </script>
        </body>
    `);
});

// --- AUTOMATIZACIJA ---

// 1. Kad telefon pošalje SMS (AUTOMATSKI)
app.post('/api/incoming-sms', (req, res) => {
    zadnjiKod = req.body.message || req.body.text;
    console.log("Stigao SMS: " + zadnjiKod);
    res.send("OK");
});

// 2. Kad Swiss javi da je plaćeno (AUTOMATSKI)
app.post('/api/webhook', (req, res) => {
    if (req.body.status === 'confirmed' || req.body.status === 'paid') {
        statusUplate = true;
    }
    res.send("OK");
});

// Ostalo (Cena i provera)
app.post('/admin/set-price', (req, res) => { trenutnaCenaSats = req.body.cena; res.sendStatus(200); });
app.get('/api/check-status', (req, res) => { res.json({ paid: statusUplate, code: zadnjiKod }); });
app.post('/api/create-inv', async (req, res) => {
    try {
        const r = await axios.post('https://api.swiss-bitcoin-pay.ch/checkout', {
            amount: trenutnaCenaSats, unit: "sats", description: "SMS",
            webhook: BASE_URL + '/api/webhook'
        }, { headers: { 'api-key': API_KEY } });
        statusUplate = false;
        res.json({ url: r.data.checkoutUrl, id: r.data.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(process.env.PORT || 10000);
