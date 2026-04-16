const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Uzima kljuc iz Render Environment Variables
const API_KEY = process.env.SWISS_API_KEY; 
let lastSms = null; 

// Glavna stranica
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Prijem SMS-a (Forwarder aplikacija sa telefona gadja ovo)
app.post('/api/incoming-sms', (req, res) => {
    console.log("📩 SMS PRIMLJEN:", req.body.message);
    lastSms = req.body.message;
    res.send("OK");
});

// Pravljenje racuna na Swiss Bitcoin Pay-u
app.post('/api/make-invoice', async (req, res) => {
    console.log("🚀 Zahtev za racun pokrenut...");
    try {
        const response = await axios.post('https://api.swissbitcoinpay.com/checkout', {
            amount: 1, // Cena 1 sat za test
            unit: "sats",
            description: "SMS Service Code"
        }, {
            headers: { 
                'api-key': API_KEY, 
                'Content-Type': 'application/json' 
            }
        });
        
        console.log("✅ Racun uspesno napravljen!");
        res.json({ id: response.data.id, payment_url: response.data.payment_url });
    } catch (e) {
        console.log("❌ GRESKA SA SWISS PAY:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// Provera da li je stigao SMS kod
app.get('/api/get-my-code', (req, res) => {
    res.json({ code: lastSms });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server online na portu ${PORT}`));
