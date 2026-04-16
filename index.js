const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const API_KEY = process.env.SWISS_API_KEY; 
let lastSms = null; 

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

app.post('/api/incoming-sms', (req, res) => {
    lastSms = req.body.message;
    console.log("SMS primljen!");
    res.send("OK");
});

app.post('/api/make-invoice', async (req, res) => {
    try {
        const response = await axios.post('https://api.swissbitcoinpay.com/checkout', {
            amount: 1,
            unit: "sats",
            description: "SMS Service"
        }, {
            headers: { 'api-key': API_KEY, 'Content-Type': 'application/json' }
        });
        res.json({ payment_url: response.data.payment_url });
    } catch (e) {
        res.status(500).json({ error: "Proveri API ključ u Renderu" });
    }
});

app.get('/api/get-my-code', (req, res) => {
    res.json({ code: lastSms });
});

app.listen(process.env.PORT || 10000);
