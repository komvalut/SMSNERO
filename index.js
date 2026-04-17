const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const SECRET = 'test_tajna_123';
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// TESTNA RUTA: Da simuliraš dolazak SMS-a (pozovi ovo iz browsera ili preko kurla)
app.get('/test-sms', (req, res) => {
    const msg = { 
        number: '+46700123456', 
        text: 'Your login code is 554433', 
        otp: '554433', 
        time: new Date() 
    };
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(msg));
    });
    res.send('Test SMS poslat na dashboard!');
});

// LOGIN RUTA
app.post('/register', (req, res) => {
    const user = { id: Date.now(), username: 'Tester' };
    const token = jwt.sign(user, SECRET);
    res.json({ token });
});

// FRONTEND
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <title>SMSNero TEST</title>
        <style>
            body { background: #000; color: #0f0; font-family: monospace; padding: 20px; }
            .msg { border-bottom: 1px dashed #0f0; padding: 10px; margin-bottom: 10px; }
            .otp { background: #0f0; color: #000; font-weight: bold; padding: 2px 5px; }
        </style>
    </head>
    <body>
        <h1>SMSNero Live Test</h1>
        <button onclick="connect()" id="btn">Start System</button>
        <div id="status"></div>
        <div id="logs"></div>

        <script>
            let token = '';
            async function connect() {
                const res = await fetch('/register', { method: 'POST' });
                const data = await res.json();
                token = data.token;
                document.getElementById('btn').style.display = 'none';
                document.getElementById('status').innerText = 'System Online... Waiting for SMS...';
                
                const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
                const ws = new WebSocket(protocol + '//' + location.host);
                
                ws.onmessage = (e) => {
                    const m = JSON.parse(e.data);
                    const log = document.getElementById('logs');
                    log.innerHTML = '<div class="msg">[' + new Date().toLocaleTimeString() + '] Number: ' + m.number + '<br>Text: ' + m.text + '<br>Code: <span class="otp">' + m.otp + '</span></div>' + log.innerHTML;
                };
            }
        </script>
    </body>
    </html>
    `);
});

server.listen(PORT, () => console.log('Server running on ' + PORT));
