const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// API ključ iz Render podešavanja
const API_KEY = process.env.SWISS_API_KEY; 
let lastSms = null; 

// Prikaz sajta
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Prijem SMS-a sa telefona
app.post('/api/incoming-sms', (req, res) => {
    console.log("📩 SMS STIGAO:", req.body.message);
    lastSms = req.body.message;
    res.send("OK");
});

// Pravljenje računa na Swiss Bitcoin Pay (1 sat)
app.post('/api/make-invoice', async (req, res) => {
    console.log("🚀 Zahtev za plaćanje...");
    try {
        const response = await axios.post('https://api.swissbitcoinpay.com/checkout', {
            amount: 1,
            unit: "sats",
            description: "SMS Service"
        }, {
            headers: { 
                'api-key': API_KEY, 
                'Content-Type': 'application/json' 
            }
        });
        console.log("✅ Račun napravljen!");
        res.json({ id: response.data.id, payment_url: response.data.payment_url });
    } catch (e) {
        console.error("❌ Greška:", e.message);
        res.status(500).json({ error: "Swiss Pay Error" });
    }
});

// Slanje koda kupcu
app.get('/api/get-my-code', (req, res) => {
    res.json({ code: lastSms });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Server je online!"));
