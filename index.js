const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Uzima ključ iz Render Environment Variables
const API_KEY = process.env.SWISS_API_KEY; 
let lastSms = null; 

// Prikazuje tvoj sajt
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// PRIMANJE SMS-a (Ovo šalje tvoja aplikacija sa telefona)
app.post('/api/incoming-sms', (req, res) => {
    console.log("📩 STIGAO SMS:", req.body.message);
    lastSms = req.body.message;
    res.send("OK");
});

// PRAVLJENJE RAČUNA (Poziva se kad klikneš na dugme)
app.post('/api/make-invoice', async (req, res) => {
    console.log("🚀 Zahtev za plaćanje primljen...");
    try {
        const response = await axios.post('https://api.swissbitcoinpay.com/checkout', {
            amount: 1, // Test cena: 1 sat
            unit: "sats",
            description: "SMS Service Code"
        }, {
            headers: { 
                'api-key': API_KEY, 
                'Content-Type': 'application/json' 
            }
        });
        
        console.log("✅ Swiss račun napravljen:", response.data.id);
        res.json({ id: response.data.id, payment_url: response.data.payment_url });
    } catch (e) {
        console.log("❌ GRESKA SA SWISS PAY-OM:", e.response ? e.response.data : e.message);
        res.status(500).json({ error: "API Error" });
    }
});

// SLANJE KODA NA EKRAN KUPCA
app.get('/api/get-my-code', (req, res) => {
    if (lastSms) {
        res.json({ code: lastSms });
        // Opciono: lastSms = null; // Otkomentariši ako želiš da se kod vidi samo jednom
    } else {
        res.json({ code: null });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server je online na portu ${PORT}`));
