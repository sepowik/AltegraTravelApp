# Travel Expenses

A personal travel expense app for Android, built as a PWA (web app you install to the home screen).
You record each trip and expense once, then copy it into whichever company's expense system needs it (Concur, Visma, Medius, in-house portals, etc.).

## Features

**One-tap trips**
- **Start trip** records the time and GPS position, looks up the address, and asks for the transport (own car, train, flight, taxi, …). Destination, purpose and company are optional and can be filled in later.
- **Change transport** starts a new leg with its own time and place, e.g. car to the airport, then a flight.
- **End trip** records arrival time and place. For car legs it calculates the driving distance by road.
- The trip view shows a timeline where every time, place, transport and km value can be corrected afterwards.
- **Mileage expense**: one tap creates an expense from the own-car km × your rate (default 25 SEK/mil, Skatteverket's tax-free rate).

**Cars and electric charging**
- Settings → **My cars**: add the cars you drive (name, registration, fuel). For electric cars, add range, connectors (CCS, Type 2, CHAdeMO, Tesla), minimum charger power and optionally battery size.
- When you start a trip (or change transport) by own car or company car, you pick which car. For an electric car you also enter the battery level, and can tick **I want to eat while charging**.
- **⚡ Charging stops** (home screen and trip view, electric cars only) plans stops from where you are to the trip's destination: it follows the road route, keeps you above a reserve (default 10%), charges up to a limit (default 80%), prefers fast chargers that fit your car, and estimates charging time. Each stop has a **Navigate** button that opens Google Maps.
- With *eat while charging* ticked, stops with restaurants, cafés or fast food within about 600 m are preferred and listed. **Rate** a place with 1–5 stars; places rated 1–2 stars are never suggested again, and places you liked come first. **＋ Expense** creates a meal expense for that place. Ratings can be changed under Settings → **Rated restaurants**.
- Chargers and restaurants come from OpenStreetMap (Overpass), the destination from Nominatim and the route from OSRM, only when you plan stops. Only positions and the destination text are sent.

**Expenses**
- Amount, currency, date, category, merchant, description, VAT, payment method, company, trip, status.
- Receipt photo straight from the camera (downscaled to save space) or a PDF/image file.
- Expenses added during an active trip are linked to it automatically.
- **Receipt reading**: after you take or pick a receipt photo, the app reads it on the phone (Tesseract OCR, Swedish, English and German) and fills in amount, date, merchant, VAT, currency and category. Only empty fields, or the default date and currency on a new expense, are filled in, and nothing you've typed is overwritten. Filled fields are outlined in green so you can check them. The reader (about 10 MB) downloads the first time and then works offline. It can be turned off in Settings. PDFs are not read.

**Copying out**
- Tap any field to copy it, then paste it into the other app, one field at a time.
- **Copy all** uses the company's own template, e.g. `{date}\t{amount}\t{currency}\t{category}` (tab-separated values paste straight into table rows).
- **Category mapping** per company: your "Taxi" can become "Local transport" for one company.
- Per-company decimal separator (`389,50` vs `389.50`).
- **Share receipt** opens Android's share menu to send the photo into the other app.
- **Next to report** walks you through a company's outstanding expenses one by one.
- CSV export (per company or all), bulk share of receipts, bulk "mark reported".
- Status per expense: *To report → Reported → Reimbursed*.

**Languages**
- English (default), Swedish, German, Spanish, Hindi and Tamil. Pick one under Settings → Language. The choice is saved on the phone and used every time the app opens.
- Categories, transports and statuses are stored language-neutral, so switching language never changes your data. Copied text (categories, payment method, trip summary) follows the selected language, unless a company has its own category names.
- A company's trip copy format is filled in with the current language when you create the company, and after that it's yours to edit.

**Data**
- Everything is stored on the phone (IndexedDB). Nothing is sent anywhere except:
  - coordinates to OpenStreetMap Nominatim, to look up the address (only when online)
  - start/end coordinates of car legs to the OSRM demo server, to calculate road distance
- Settings → **Export backup** saves everything (including receipts) to a JSON file; **Restore** merges it back in. Take backups regularly: if you lose the phone, anything not backed up is lost with it.
- Works offline after the first visit.

### Limitations (by design, for now)
- A web app can only read GPS while it is open. Positions are captured when you tap, not tracked continuously. The car distance is the road route between the recorded points, and you can edit it.
- Transport is picked manually, not detected automatically.
- Receipt reading works best on flat, sharp, well-lit photos. Crumpled or faded receipts may need manual entry. No currency conversion yet.

## Install on your Android phone

1. Enable GitHub Pages for this repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Merge to `main`. The workflow in `.github/workflows/pages.yml` runs the tests and publishes the site to `https://<user>.github.io/<repo>/`.
3. Open that URL in Chrome on the phone and choose **⋮ → Install app / Add to Home screen**.
4. Allow location when asked the first time you start a trip.

## Develop

No build step, just static files and ES modules.

```sh
npm start      # serves on http://localhost:8080
npm test       # unit tests for the pure helpers (Node 20+)
```

| File | Purpose |
| --- | --- |
| `index.html`, `css/app.css` | App shell and styles (light/dark) |
| `js/app.js` | Router and all views |
| `js/i18n.js` | Translations (en/sv/de/es/hi/ta) and the `t()` lookup |
| `js/util.js` | Pure helpers: templates, CSV, legs/distances, formatting (unit tested) |
| `js/db.js` | IndexedDB storage, backup export/import |
| `js/geo.js` | GPS, reverse geocoding, road distance |
| `js/ocr.js`, `js/receipt-parse.js` | On-device receipt reading and the rules that pick out amount, date, VAT etc. (unit tested) |
| `vendor/tesseract/` | Bundled OCR engine and language data, see its README |
| `js/ev.js`, `js/charging.js` | Cars, charging stop planning (unit tested), places to eat and ratings |
| `js/receipts.js` | Receipt storage, downscaling, sharing |
| `sw.js` | Offline cache. Bump `VERSION` when shipping changes. |

### Template placeholders

Expense: `{date} {amount} {currency} {category} {my_category} {merchant} {description} {vat} {payment} {company} {trip} {purpose} {destination}`

Trip: `{trip} {purpose} {destination} {start_date} {start_time} {start_place} {end_date} {end_time} {end_place} {transport} {car_km} {company}`

Use `\t` for tab and `\n` for new line.

## Ideas for later
- Traktamente (Swedish per diem) calculation from the recorded departure/return times, with meal deductions
- Currency conversion to SEK at the rate on the expense date
- A native (Flutter) version if continuous GPS tracking for mileage becomes important
