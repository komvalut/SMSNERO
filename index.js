const express = require('express');
const path = require('path');
const axios = require('axios');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const ALBY_TOKEN = process.env.ALBY_TOKEN ? process.env.ALBY_TOKEN.trim() : null;

let smsDatabase = {}; 

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// SMS FORWARDER RUTA
app.post('/api/incoming-sms', (req, res) => {
    const { from, message } = req.body; 
    console.log(`STIGAO SMS -> Od: ${from}, Poruka: ${message}`);
    // Čuvamo poruku pod ključem "last", tako je najsigurnije za test
    smsDatabase["last"] = message; 
    res.status(200).send("OK");
});

// KREIRANJE FAKTURE
app.post('/api/make-invoice', async (req, res) => {
    try {
        const response = await axios.post('https://api.getalby.com/invoices', 
            { amount: parseInt(req.body.amount), memo: req.body.memo }, 
            { headers: { 'Authorization': `Bearer ${ALBY_TOKEN}`, 'Content-Type': 'application/json' } }
        );
        res.json(response.data);
    } catch (e) { 
        console.error("Alby Error:", e.response ? e.response.data : e.message);
        res.status(500).json({ error: "Alby error" }); 
    }
});

// PROVERA UPLATE - POBOLJŠANA
app.get('/api/check-payment/:hash', async (req, res) => {
    try {
        const response = await axios.get(`https://api.getalby.com/invoices/${req.params.hash}`, {
            headers: { 'Authorization': `Bearer ${ALBY_TOKEN}` }
        });
        // Logujemo u konzolu da vidimo šta Alby kaže
        console.log("Status uplate:", response.data.settled);
        res.json({ settled: response.data.settled });
    } catch (e) { res.status(500).json({ settled: false }); }
});

// ISPORUKA KODA
app.get('/api/get-my-code/:phone', (req, res) => {
    const kod = smsDatabase["last"]; 
    if (kod) {
        res.json({ code: kod });
        // Brišemo kod nakon što ga kupac preuzme da ne bi ostao za sledećeg
        smsDatabase["last"] = null;
    } else {
        res.json({ code: null });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Server aktivan na portu " + PORT));
