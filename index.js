const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const API_KEY = process.env.SWISS_API_KEY;

// Čuva poslednji SMS i mapira invoice -> SMS kod
let lastSms = null;
const invoiceMap = {}; // invoiceId -> { paid: bool, code: string }

// ─── ČIŠĆENJE SMS PORUKE ───────────────────────────────────────────────────
function cleanMessage(msg) {
    if (!msg) return null;
    if (msg.includes("Känsligt") || msg.includes("dolt")) {
        return "ČEKAM PRAVI KOD... (Proveri obaveštenja na tel)";
    }
    const codeMatch = msg.match(/\d{4,8}/);
    return codeMatch ? codeMatch[0] : msg;
}

// ─── FRONTEND ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
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
        .code-box { background: #000; border: 2px dashed #ff9500; padding: 20px; font-size: 32px; margin-top: 20px; border-radius: 10px; letter-spacing: 4px; }
        .small { color: #555; font-size: 12px; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="box">
        <h1 style="letter-spacing: 2px;">SMSNERO ⚡</h1>
        <p style="color: #888;">Cena: 1 sat • Lightning instant</p>
        <button class="btn" onclick="buy()">KUPI KOD</button>
        <div id="res"></div>
        <p class="small">Plaćanje putem Bitcoin Lightning mreže</p>
    </div>
    <script>
        let currentInvoiceId = null;
        let pollInterval = null;

        async function buy() {
            const btn = document.querySelector('.btn');
            const resDiv = document.getElementById('res');
            resDiv.innerText = "Kreiram fakturu...";
            btn.disabled = true;

            try {
                const r = await fetch('/api/make-invoice', { method: 'POST' });
                const d = await r.json();

                if (d.checkoutUrl && d.invoiceId) {
                    currentInvoiceId = d.invoiceId;
                    resDiv.innerHTML = \`
                        <p>Faktura kreirana! ✅</p>
                        <a href="\${d.checkoutUrl}" target="_blank">
                            <button class="btn" style="margin-top:10px">PLATI OVDE ⚡</button>
                        </a>
                        <p style="color:#555;font-size:13px;margin-top:10px">Čekam potvrdu uplate...</p>
                    \`;
                    startPolling(d.invoiceId);
                } else {
                    resDiv.innerText = "Greška: " + (d.error || "Pokušaj ponovo");
                    btn.disabled = false;
                }
            } catch (e) {
                resDiv.innerText = "Mreža zauzeta, klikni opet.";
                btn.disabled = false;
            }
        }

        function startPolling(invoiceId) {
            if (pollInterval) clearInterval(pollInterval);
            pollInterval = setInterval(async () => {
                try {
                    const r = await fetch('/api/check-invoice/' + invoiceId);
                    const d = await r.json();

                    if (d.paid && d.code) {
                        clearInterval(pollInterval);
                        document.body.innerHTML = \`
                            <div class="box">
                                <h1>✅ PLAĆENO!</h1>
                                <p style="color:#888">Tvoj SMS kod:</p>
                                <div class="code-box">\${d.code}</div>
                                <button class="btn" style="margin-top:20px" onclick="location.reload()">NAZAD</button>
                            </div>
                        \`;
                    } else if (d.paid && !d.code) {
                        document.getElementById('res').innerHTML += '<br><span style="color:#aaa">Uplata primljena, čekam SMS...</span>';
                    }
                } catch (e) {}
            }, 3000);
        }
    </script>
</body>
</html>`);
});

// ─── KREIRANJE INVOICE ─────────────────────────────────────────────────────
app.post('/api/make-invoice', async (req, res) => {
    try {
        const response = await axios({
            method: 'POST',
            url: 'https://api.swiss-bitcoin-pay.ch/checkout',
            headers: {
                'api-key': API_KEY,
                'Content-Type': 'application/json'
            },
            data: {
                amount: 1,
                unit: 'sat',
                title: 'SMS Kod',
                description: 'Jednokratni pristupni kod',
                delay: 10,
                webhook: {
                    url: process.env.RENDER_EXTERNAL_URL + '/api/webhook'
                }
            },
            timeout: 15000
        });

        const { id, checkoutUrl } = response.data;

        // Rezerviši slot u mapi
        invoiceMap[id] = { paid: false, code: null };

        res.json({ invoiceId: id, checkoutUrl });
    } catch (e) {
        console.error("Invoice greška:", e.response?.data || e.message);
        res.status(500).json({ error: e.response?.data?.message || e.message });
    }
});

// ─── WEBHOOK OD SWISS BITCOIN PAY ─────────────────────────────────────────
// Poziva se automatski kad je faktura plaćena
app.post('/api/webhook', (req, res) => {
    const { id, isPaid, status } = req.body;
    console.log("Webhook primljen:", id, status);

    if ((isPaid || status === 'paid') && id && invoiceMap[id] !== undefined) {
        invoiceMap[id].paid = true;
        invoiceMap[id].code = lastSms; // Dodeli poslednji primljeni SMS
        console.log("Faktura plaćena:", id, "→ kod:", lastSms);
    }

    res.sendStatus(200);
});

// ─── PROVERA STATUSA INVOICE ───────────────────────────────────────────────
app.get('/api/check-invoice/:id', (req, res) => {
    const { id } = req.params;
    const entry = invoiceMap[id];

    if (!entry) return res.json({ paid: false, code: null });

    // Ako webhook još nije stigao, pitaj Swiss direktno
    if (!entry.paid) {
        axios.get(`https://api.swiss-bitcoin-pay.ch/checkout/${id}`)
            .then(r => {
                if (r.data.isPaid) {
                    invoiceMap[id].paid = true;
                    invoiceMap[id].code = lastSms;
                }
                res.json({ paid: invoiceMap[id].paid, code: invoiceMap[id].code });
            })
            .catch(() => res.json({ paid: false, code: null }));
    } else {
        res.json({ paid: entry.paid, code: entry.code });
    }
});

// ─── DOLAZNI SMS ───────────────────────────────────────────────────────────
app.post('/api/incoming-sms', (req, res) => {
    const rawMsg = req.body.message || req.body.text;
    lastSms = cleanMessage(rawMsg);
    console.log("SMS stigao:", lastSms);

    // Ažuriraj sve plaćene invoice koji čekaju kod
    for (const id in invoiceMap) {
        if (invoiceMap[id].paid && !invoiceMap[id].code) {
            invoiceMap[id].code = lastSms;
        }
    }

    res.send("OK");
});

// ─── START ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`SMSNERO running on port ${PORT}`));
