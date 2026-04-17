const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.text());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Varijable koje čuvaju stanje
let zadnjiKod = "Čekanje na uplatu...";
let statusUplate = false;

// 1. RUTA: Ovo vidi kupac na ekranu
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>P2P Market - Isplata</title>
            <meta charset="UTF-8">
            <style>
                body { background: #121212; color: white; font-family: sans-serif; text-align: center; padding-top: 50px; }
                .box { border: 2px dashed #ff9900; padding: 20px; display: inline-block; border-radius: 15px; background: #1e1e1e; min-width: 300px; }
                h1 { color: #ff9900; }
                #kod { font-size: 24px; font-weight: bold; margin: 20px; color: #00ff00; letter-spacing: 2px; }
                .btn { background: white; color: black; padding: 10px 20px; border-radius: 10px; text-decoration: none; cursor: pointer; border: none; font-weight: bold; }
            </style>
            <script>
                setInterval(async () => {
                    const response = await fetch('/proveri-status');
                    const data = await response.json();
                    if(data.uplaceno) {
                        document.getElementById('kod').innerText = data.kod;
                    }
                }, 2000);
            </script>
        </head>
        <body>
            <div class="box">
                <h1>✅ TVOJ KOD:</h1>
                <div id="kod">Skeniraj QR i plati...</div>
                <br>
                <button class="btn" onclick="window.location.reload()">ZATVORI</button>
            </div>
        </body>
        </html>
    `);
});

// 2. RUTA: Telefon šalje SMS ovde
app.post('/api/incoming-sms', (req, res) => {
    console.log("Podaci sa telefona:", req.body);
    
    let poruka = null;
    
    if (req.body && req.body.message) {
        poruka = req.body.message;
    } else if (typeof req.body === 'string' && req.body.length > 0) {
        poruka = req.body;
    }

    if (poruka && !poruka.includes("%SMS_BODY%")) {
        zadnjiKod = poruka;
        statusUplate = true;
        console.log("STIGAO KOD:", zadnjiKod);
        return res.status(200).send("OK");
    }
    
    return res.status(400).send("Greska: Nema poruke");
});

// 3. RUTA: Provera za kupčev ekran
app.get('/proveri-status', (req, res) => {
    res.json({
        uplaceno: statusUplate,
        kod: zadnjiKod
    });
    
    // Reset nakon što kupac dobije kod
    if (statusUplate) {
        statusUplate = false;
        zadnjiKod = "Čekanje na uplatu...";
    }
});

// Startovanje servera
app.listen(port, () => {
    console.log("Server radi na portu: " + port);
});
