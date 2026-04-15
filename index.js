const express = require('express');
const path = require('path');
const axios = require('axios');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const ALBY_TOKEN = process.env.ALBY_TOKEN ? process.env.ALBY_TOKEN.trim() : null;

// Privremena memorija za poruke i uplate
let smsDatabase = {}; 

// RUTA ZA TVOJ SMS FORWARDER (Unesi ovaj URL u aplikaciju)
app.post('/api/incoming-sms', (req, res) => {
    const { from, message } = req.body; 
    console.log(`Stigao SMS od: ${from}, Sadržaj: ${message}`);
    
    // Čuvamo poruku. 'from' je broj koji je poslao SMS (npr. "Google" ili "+46...")
    smsDatabase[from] = message;
    res.status(200).send("OK");
});

// PRAVLJENJE RAČUNA
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

// KUPAC TRAŽI SVOJ KOD
app.get('/api/get-my-code/:serviceName', (req, res) => {
    const service = req.params.serviceName; // Npr. "Telegram" ili "+447..."
    const foundMsg = Object.keys(smsDatabase).find(key => key.includes(service) || smsDatabase[key].includes(service));
    
    if (foundMsg) {
        res.json({ code: smsDatabase[foundMsg] });
    } else {
        res.json({ code: null });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Sistem spreman na portu " + PORT));
