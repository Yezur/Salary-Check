# Salary Check (client-side)
https://yezur.github.io/Salary-Check/

Een eenvoudige, volledig client-side webapp om per periode een salarisindicatie te maken. Je vult uurloon, standby-tarief, overwerkmultipliers en uren in, plus eventuele vergoedingen/inhoudingen. De app berekent bruto betalingen, belasting over overuren (50,33%), onbelaste onderdelen en het nettoresultaat. Alle data blijft in de browser (localStorage); er is geen backend of tracking.

## Wat kun je ermee?
- Uurloon, standby-tarief en overwerkmultipliers invullen.
- Uren registreren voor normaal, 150% en 200% overwerk, plus standby.
- Vergoedingen (belast/onbelast) en inhoudingen beheren.
- Automatische berekening van belasting over overuren (50,33%).
- Totale bruto, onbelaste onderdelen en netto inzichtelijk maken.
- CSV-download en print/PDF-export.
- Autosave naar localStorage en reset naar defaults.

> Alleen overuren worden belast (50,33%). Standby en onbelaste vergoedingen blijven buiten de belastingberekening; overige inhoudingen voeg je handmatig toe.

## Snel starten
Open `index.html` in je browser. Alle benodigde bestanden staan lokaal (geen build-stap nodig).

## Gebruiksinstructies
1. Vul de tarieven en uren in (optioneel kun je een uurloon invullen; dit bepaalt dan het basisloon en het overwerk).
2. Voeg eventueel vergoedingen en inhoudingen toe via de tabellen.
3. Bekijk de resultaten in de kaarten “Betalingen”, “Inhoudingen” en “Totalen”.
4. Gebruik de knoppen om te downloaden als CSV, te printen/PDF-en of te resetten.

## GitHub Pages publiceren
1. Commit de bestanden (`index.html`, `style.css`, `print.css`, `config.js`, `app.js`, `README.md`).
2. Push naar GitHub.
3. In GitHub: Settings → Pages → Source: “Deploy from a branch”; kies de hoofdbranch en root-map.
4. De site draait op `https://<user>.github.io/<repo>/`.

## Privacy
Alle berekeningen en opslag gebeuren lokaal in de browser. Er is geen netwerkverkeer behalve het laden van de statische bestanden.
