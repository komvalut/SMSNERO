const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Uzimamo ključ iz Render podešavanja
const API_KEY = process.env.SWISS_API_KEY; 
let lastSms = null; 

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Prijem SMS-a sa telefona
app.post('/api/incoming-sms', (req, res) => {
    console.log("📩 SMS STIGAO NA SERVER:", req.body.message);
    lastSms = req.body.message;
    res.send("OK");
});

// Pravljenje fakture (1 SAT)
app.post('/api/make-invoice', async (req, res) => {
    try {
        console.log("Pokušavam da napravim račun... Ključ prisutan:", API_KEY ? "DA" : "NE");
        
        const response = await axios.post('https://api.swissbitcoinpay.com/checkout', {
            amount: 1,
            unit: "sats",
            description: "SMSnero Test"
        }, {
            headers: { 
                'api-key': API_KEY, 
                'Content-Type': 'application/json' 
            }
        });
        
        console.log("Račun uspešno napravljen ID:", response.data.id);
        res.json({ id: response.data.id, payment_url: response.data.payment_url });
    } catch (e) {
        // Ovo će ispisati TAČNU grešku u Render logovima
        console.error("GREŠKA SA SWISS PAY API-jem:");
        if (e.response) {
            console.error("Status:", e.response.status);
            console.error("Poruka:", e.response.data);
        } else {
            console.error("Poruka:", e.message);
        }
        res.status(500).json({ error: "API Error" });
    }
});

// Provera uplate
app.get('/api/check-payment/:id', async (req, res) => {
    try {
        const response = await axios.get(`https://api.swissbitcoinpay.com/invoice/${req.params.id}`, {
            headers: { 'api-key': API_KEY }
        });
        const isPaid = response.data.status === 'paid' || response.data.status === 'confirmed';
        res.json({ settled: isPaid });
    } catch (e) {
        res.json({ settled: false });
    }
});

// Slanje koda kupcu
app.get('/api/get-my-code', (req, res) => {
    res.json({ code: lastSms });
    if(lastSms) lastSms = null; // Brišemo nakon slanja
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Server je upaljen na portu " + PORT));
