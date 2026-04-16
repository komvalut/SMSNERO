const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const API_KEY = process.env.SWISS_API_KEY;
const BASE_URL = process.env.RENDER_EXTERNAL_URL;

// Ovo su tvoja podešavanja koja menjaš u Adminu
let trenutnaCenaSats = 100; 
let kodZaKupca = "Čekam da gazda unese kod...";
let statusUplate = false; // Da li je kupac platio

// --- KONTROLNA TABLA ZA TEBE (/admin-nero) ---
app.get('/admin-nero', (req, res) => {
    res.send(`
        <body style="background:#1a1a1a; color:#0f0; font-family:monospace; padding:30px;">
            <h1 style="color:#ff9500;">⚡ SMSNERO GAZDA PANEL</h1>
            <hr style="border-color:#333;">
            
            <div style="background:#000; padding:20px; border:2px solid #ff9500; border-radius:10px;">
                <h3>1. PODEŠAVANJE CENE</h3>
                <p>Trenutna cena: <span style="color:white; font-size:20px;">${trenutnaCenaSats} sats</span></p>
                <input type="number" id="novaCena" placeholder="Unesi cenu u sats" style="padding:10px; border-radius:5px;">
                <button onclick="updateCena()" style="padding:10px; background:#ff9500; border:none; cursor:pointer; font-weight:bold;">POSTAVI CENU</button>
                
                <hr style="margin:20px 0; border-color:#333;">
                
                <h3>2. UNOS BROJA/KODA</h3>
                <p>Kod koji kupac trenutno vidi: <span style="color:white;">${kodZaKupca}</span></p>
                <input type="text" id="noviKod" placeholder="Unesi broj ili kod" style="padding:10px; width:250px; border-radius:5px;">
                <button onclick="updateKod()" style="padding:10px; background:#0f0; border:none; cursor:pointer; font-weight:bold;">PUSTI KOD KUPCU</button>
                
                <hr style="margin:20px 0; border-color:#333;">
                <button onclick="location.reload()" style="width:100%; padding:10px;">OSVEŽI STANJE</button>
            </div>

            <script>
                async function updateCena() {
                    const c = document.getElementById('novaCena').value;
                    await fetch('/admin/set-price', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({cena:c})});
                    alert('Cena je promenjena!'); location.reload();
                }
                async function updateKod() {
                    const k = document.getElementById('noviKod').value;
                    await fetch('/admin/set-code', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({kod:k})});
                    alert('Kod je poslat!'); location.reload();
                }
            </script>
        </body>
    `);
});

// --- GLAVNA STRANA ZA KUPCE (/) ---
app.get('/', (req, res) => {
    res.send(`
        <body style="background:#0b0b0b; color:white; font-family:sans-serif; text-align:center; padding-top:100px;">
            <div style="max-width:400px; margin:auto; background:#151515; padding:40px; border-radius:20px; border:1px solid #333;">
                <h1 style="letter-spacing:2px;">SMSNERO ⚡</h1>
                <p style="color:#888;">Cena usluge: <b style="color:#ff9500;">${trenutnaCenaSats} sats</b></p>
                <button id="buyBtn" onclick="plati()" style="padding:20px; width:100%; background:#ff9500; border:none; border-radius:10px; font-weight:bold; cursor:pointer; font-size:18px;">KUPI KOD ODMAH</button>
                <div id="msg" style="margin-top:20px; color:#ff9500; font-weight:bold;"></div>
            </div>

            <script>
                let currentInvId = null;
                async function plati() {
                    document.getElementById('msg').innerText = "Generišem račun...";
                    const r = await fetch('/api/create-inv', {method:'POST'});
                    const d = await r.json();
                    if(d.url) { currentInvId = d.id; window.location.href = d.url; }
                    else { document.getElementById('msg').innerText = "Greška: " + d.error; }
                }

                setInterval(async () => {
                    if(!currentInvId) return;
                    const r = await fetch('/api/check-status');
                    const d = await r.json();
                    if(d.paid) {
                        document.body.innerHTML = "<div style='padding-top:100px;'><h1>TVOJ KOD:</h1><div style='font-size:60px; color:#ff9500; border:4px dashed #ff9500; display:inline-block; padding:30px; margin-top:20px;'>"+d.code+"</div></div>";
                    }
                }, 3000);
            </script>
        </body>
    `);
});

// --- BACKEND LOGIKA ---

app.post('/admin/set-price', (req, res) => { trenutnaCenaSats = req.body.cena; res.sendStatus(200); });
app.post('/admin/set-code', (req, res) => { kodZaKupca = req.body.kod; res.sendStatus(200); });

app.post('/api/create-inv', async (req, res) => {
    try {
        const response = await axios.post('https://api.swiss-bitcoin-pay.ch/checkout', {
            amount: trenutnaCenaSats, unit: "sats", description: "SMS Usluga",
            webhook: BASE_URL + '/api/webhook'
        }, { headers: { 'api-key': API_KEY } });
        statusUplate = false; // Resetuj za novog kupca
        res.json({ url: response.data.checkoutUrl, id: response.data.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/webhook', (req, res) => {
    if (req.body.status === 'confirmed' || req.body.status === 'paid') {
        statusUplate = true;
    }
    res.send("OK");
});

app.get('/api/check-status', (req, res) => {
    res.json({ paid: statusUplate, code: kodZaKupca });
});

app.listen(process.env.PORT || 10000);
