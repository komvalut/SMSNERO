const express = require('express');
const path = require('path');
const axios = require('axios');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const ALBY_TOKEN = process.env.ALBY_TOKEN ? process.env.ALBY_TOKEN.trim() : null;

// Privremena baza za SMS poruke
let smsDatabase = {}; 

// FIX: Ova ruta osigurava da se otvori SAJT, a ne kod
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// RUTA ZA SMS FORWARDER (Tvoj telefon šalje ovde)
app.post('/api/incoming-sms', (req, res) => {
    const { from, message } = req.body; 
    console.log(`Stigao SMS od: ${from}, Sadržaj: ${message}`);
    smsDatabase[from] = message;
    res.status(200).send("OK");
});

// PRAVLJENJE ALBY RAČUNA
app.post('/api/make-invoice', async (req, res) => {
    try {
        const { amount, memo } = req.body;
        const response = await axios.post('https://api.getalby.com/invoices', 
            { amount: parseInt(amount), memo: memo }, 
            { headers: { 'Authorization': `Bearer ${ALBY_TOKEN}` } }
        );
        res.json(response.data);
    } catch (e) { res.status(500).json({ error: "Alby error" }); }
});

// PROVERA UPLATE
app.get('/api/check-payment/:hash', async (req, res) => {
    try {
        const response = await axios.get(`https://api.getalby.com/invoices/${req.params.hash}`, {
            headers: { 'Authorization': `Bearer ${ALBY_TOKEN}` }
        });
        res.json({ settled: response.data.settled });
    } catch (e) { res.status(500).json({ error: "Check error" }); }
});

// SLANJE KODA KUPCU
app.get('/api/get-my-code/:serviceName', (req, res) => {
    const messages = Object.values(smsDatabase);
    if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        res.json({ code: lastMessage });
    } else {
        res.json({ code: null });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Sistem spreman na portu " + PORT));
