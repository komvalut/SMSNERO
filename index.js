<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SMSNERO - Bitcoin SMS Gateway</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <div class="container">
        <h1>SMSNERO ⚡</h1>
        <p>Send anonymous SMS using Bitcoin Lightning Network</p>
        
        <div class="price-container">
            <p>Current Price: <span id="price" class="sats-amount">Loading price...</span></p>
        </div>

        <div class="sms-form">
            <input type="text" id="phone" placeholder="Phone number (e.g. +381...)" required>
            <textarea id="message" placeholder="Your message here..." required></textarea>
            <button class="btn-generate" id="generate-btn">
                ⚡ Generate Lightning Invoice
            </button>
        </div>

        <div class="footer-links">
            <a href="#">Support</a>
            <a href="#">Refunds</a>
            <a href="#">Terms</a>
        </div>
    </div>

    <script>
    async function getPrice() {
        try {
            // Povlačimo cenu sa tvog API-ja na Renderu
            const response = await fetch('/api/price');
            const data = await response.json();
            
            // Tražimo element gde piše "Loading price..."
            const priceElement = document.getElementById('price') || document.querySelector('.sats-amount'); 
            
            if (priceElement && data.price) {
                // Upisujemo cenu i dodajemo "sats"
                priceElement.innerText = data.price + " sats";
            }
        } catch (error) {
            console.error("Greška pri učitavanju cene:", error);
            const priceElement = document.getElementById('price') || document.querySelector('.sats-amount');
            if (priceElement) priceElement.innerText = "Service temporarily unavailable";
        }
    }

    // Pokreni funkciju čim se stranica učita
    window.onload = getPrice;

    // Dugme za generisanje fakture (osnova za kasnije)
    document.getElementById('generate-btn').addEventListener('click', () => {
        alert('Invoice generation coming soon! Check if price is loaded first.');
    });
    </script>

</body>
</html>
