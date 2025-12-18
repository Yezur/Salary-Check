# Salary Check (client-side)
https://yezur.github.io/Salary-Check/

Een eenvoudige, volledig client-side webapp die per maand een bruto salaris en een vlakke netto-indicatie berekent. Alle data blijft in de browser (localStorage); er is geen backend of tracking.

## Wat kun je ermee?
- Uurloon, standby-tarief en overwerkmultipliers invullen.
- Uren registreren voor normaal, 150% en 200% overwerk, plus standby.
- Vergoedingen (belast/onbelast) en inhoudingen beheren.
- Netto-indicatie met presets (25/35/45%) of een custom percentage.
- CSV-download en print/PDF-export.
- Autosave naar localStorage en reset naar defaults.

> Netto is een indicatie op basis van een vlak tarief. Er worden geen loonheffingstabellen of pensioenregels toegepast.

## Snel starten
Open `index.html` in je browser. Alle benodigde bestanden staan lokaal (geen build-stap nodig).

## Gebruiksinstructies
1. Vul de tarieven en uren in.
2. Voeg eventueel vergoedingen en inhoudingen toe via de tabellen.
3. Kies een netto preset of vul een custom percentage in.
4. Bekijk de resultaten in de kaarten “Betalingen”, “Inhoudingen” en “Totalen”.
5. Gebruik de knoppen om te downloaden als CSV, te printen/PDF-en of te resetten.

## GitHub Pages publiceren
1. Commit de bestanden (`index.html`, `style.css`, `print.css`, `config.js`, `app.js`, `README.md`).
2. Push naar GitHub.
3. In GitHub: Settings → Pages → Source: “Deploy from a branch”; kies de hoofdbranch en root-map.
4. De site draait op `https://<user>.github.io/<repo>/`.

## Privacy
Alle berekeningen en opslag gebeuren lokaal in de browser. Er is geen netwerkverkeer behalve het laden van de statische bestanden.
