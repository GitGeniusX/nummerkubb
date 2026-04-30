# Nummerkubb 🎯

Poängräknare för **nummerkubb** (numrerad kubb) – en webbapp som även kan installeras som app på mobilen (PWA).

Spelet stödjer 2–8 spelare. Pinnar 1–12. Först till exakt 50 poäng vinner.

## Spelregler

- **Pinnar 1–12** står uppställda. Varje pinne har sitt eget nummer.
- **Faller 1 pinne** (som standard): poängen blir pinnens nummer.
  - Detta kan i regelinställningarna ändras till "1 eller 2 pinnar = nummersumma, 3+ pinnar = antal pinnar".
- **Faller flera pinnar** över tröskeln: poängen blir antalet pinnar.
- **Först till 50 poäng vinner** matchen. Slår man över: regel går att ställa in (default = tillbaka till 25).
- **3 missar i rad** (0 poäng tre kast i rad) → spelaren åker ut. Sista som står kvar vinner.
- **Matchserie:** appen håller koll på vinster över flera matcher.

## Funktioner

- 🎮 Spelflöde med pinnurval (klicka alla fällda pinnar → "Klart")
- 📊 Live-poängställning högst upp
- ⚡ Flash-banner vid matchboll och sista chansen (3 strikes)
- 🔊 Ljudeffekter och röstuppläsning på svenska
- 🌗 Mörkt / ljust läge
- 🔇 Stäng av/på ljud
- ↩️ Ångra senaste kastet
- 📱 Installerbar som app på mobil (PWA – fungerar offline)

## Kör lokalt

```bash
# I projektmappen
python3 -m http.server 8000
# Öppna sedan http://localhost:8000 i webbläsaren
```

Alla filer är statiska – ingen build krävs.

## Installera på mobilen

Appen är en **PWA** (Progressive Web App) och kan installeras direkt från webbläsaren – ingen App Store behövs.

### iPhone / iPad (Safari)

1. Öppna appens URL i **Safari** (måste vara Safari på iOS).
2. Tryck på **Dela**-knappen (fyrkanten med pil uppåt) längst ner.
3. Bläddra ner och välj **"Lägg till på hemskärmen"**.
4. Tryck **"Lägg till"** uppe i högra hörnet.
5. Appikonen dyker nu upp på hemskärmen och öppnas i fullskärm utan adressfält.

### Android (Chrome)

1. Öppna appens URL i **Chrome**.
2. Tryck på **menyn** (tre prickar uppe till höger).
3. Välj **"Installera app"** eller **"Lägg till på startskärmen"**.
4. Bekräfta med **"Installera"**.
5. Appen läggs till på startskärmen och i applistan.

> Tips: När appen är installerad fungerar den även **offline** tack vare service worker:n.

## Publicering

Lägg upp innehållet i mappen på valfri statisk webbhost (GitHub Pages, Netlify, Cloudflare Pages, Vercel, S3, etc.). Inga byggsteg krävs.

För att PWA-installation ska fungera på mobilen krävs **HTTPS** (alla nämnda värdar ger detta automatiskt).

## Filstruktur

```
nummerkubb/
├── index.html              # Entrypoint
├── app.js                  # Spel-logik, ljudmotor, UI-rendering
├── styles.css              # Tema (mörkt/ljust), layout, animationer
├── manifest.webmanifest    # PWA-manifest
├── service-worker.js       # Offline-cache
├── icon.svg                # Logotyp
├── icon-192.png            # PWA-ikon (Android)
├── icon-512.png            # PWA-ikon (Android, splashscreen)
├── icon-180.png            # Apple touch-ikon (iOS)
└── README.md
```

## Teknik

- Vanlig HTML, CSS, JavaScript – inga ramverk.
- Web Audio API för ljudeffekter (FM-syntes, brus, ADSR-envelopes).
- Web Speech API för röstuppläsning.
- Service Worker för offline-stöd.

## Licens

MIT
