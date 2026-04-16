const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const API_KEY = process.env.SWISS_API_KEY; 
let lastSms = null; 

// FUNKCIJA KOJA ČISTI SMEĆE IZ PORUKE
function cleanMessage(msg) {
    if (!msg) return null;
    // Ako dobiješ onu švedsku poruku o sakrivenom sadržaju, ignoriši je
    if (msg.includes("Känsligt") || msg.includes("dolt")) return "ČEKAM PRAVI KOD... (Proveri obaveštenja na tel)";
    
    // Izvlači samo brojeve ako poruka sadrži kod
    const codeMatch = msg.match(/\d{4,8}/); 
    return codeMatch ? codeMatch[0] : msg;
}

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>SMSNERO ⚡</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { background: #0b0b0b; color: white; font-family: sans-serif; text-align: center; padding: 50px 20px; }
        .box { max-width: 350px; margin: auto; background: #151515; padding: 30px; border-radius: 20px; border: 1px solid #333; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        .btn { background: #ff9500; color: black; border: none; padding: 18px; width: 100%; border-radius: 12px; font-weight: bold; cursor: pointer; font-size: 18px; transition: 0.2s; }
        .btn:active { transform: scale(0.98); }
        #res { margin-top: 25px; color: #ff9500; font-weight: bold; min-height: 50px; }
        .code-box { background: #000; border: 2px dashed #ff9500; padding: 20px; font-size: 32px; margin-top: 20px; border-radius: 10px; }
    </style>
</head>
<body>
    <div class="box">
        <h1 style="letter-spacing: 2px;">SMSNERO ⚡</h1>
        <p style="color: #888;">Cena: 1 sat</p>
        <button class="btn" onclick="buy()">KUPI KOD</button>
        <div id="res"></div>
    </div>
    <script>
        async function buy() {
            const btn = document.querySelector('.btn');
            const resDiv = document.getElementById('res');
            resDiv.innerText = "Pokretanje uplate...";
            btn.disabled = true;

            try {
                const r = await fetch('/api/make-invoice', { method: 'POST' });
                const d = await r.json();
                if(d.url) {
                    window.location.href = d.url;
                } else {
                    resDiv.innerText = "Greška: " + (d.error || "Pokušaj ponovo");
                    btn.disabled = false;
                }
            } catch(e) {
                resDiv.innerText = "Mreža zauzeta, klikni opet.";
                btn.disabled = false;
            }
        }

        setInterval(async () => {
            try {
                const r = await fetch('/api/get-my-code');
                const d = await r.json();
                if(d.code && !d.code.includes("ČEKAM")) {
                    document.body.innerHTML = '<div class="box"><h1>TVOJ KOD:</h1><div class="code-box">' + d.code + '</div><button class="btn" style="margin-top:20px" onclick="location.reload()">NAZAD</button></div>';
                } else if (d.code) {
                    document.getElementById('res').innerText = d.code;
                }
            } catch(e) {}
        }, 3000);
    </script>
</body>
</html>
    `);
});

app.post('/api/incoming-sms', (req, res) => {
    const rawMsg = req.body.message || req.body.text; 
    lastSms = cleanMessage(rawMsg);
    console.log("Stiglo:", lastSms);
    res.send("OK");
});

app.post('/api/make-invoice', async (req, res) => {
    try {
        const response = await axios({
            method: 'post',
            url: 'https://api.swissbitcoinpay.com/checkout',
            headers: { 'api-key': API_KEY, 'Content-Type': 'application/json' },
            data: { amount: 1, unit: "sats", description: "SMS Code" },
            timeout: 15000 // Duži timeout ako mreža koči
        });
        res.json({ url: response.data.payment_url });
    } catch (e) {
        // Ako Swiss Pay baci grešku, šaljemo je nazad da je vidiš na ekranu
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/get-my-code', (req, res) => { res.json({ code: lastSms }); });

app.listen(process.env.PORT || 10000);
