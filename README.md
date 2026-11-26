# Rx Overlap Checker

[![test](https://github.com/saigagan99/rx-overlap-checker/actions/workflows/test.yml/badge.svg)](https://github.com/saigagan99/rx-overlap-checker/actions/workflows/test.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen) ![Dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)

**Catch hidden ingredient overlaps in Indian prescriptions before the next dose.**

Many Indian brands are fixed-dose combinations: *Combiflam* is ibuprofen + paracetamol, *Zerodol-P* is aceclofenac + paracetamol, *Pan-D* is pantoprazole + domperidone. A patient can be prescribed three brands that all contain paracetamol, and nothing on the strips makes that obvious. Rx Overlap Checker reads the prescription, works out what's inside each brand, totals every ingredient per day, and flags overlaps, same-class duplicates and doses over a safe limit for that patient.

It works as a **consumer web app** and as a **REST API** that hospitals and telemedicine platforms can call before a doctor signs a prescription.

![Results screen](docs/results.png)

<p align="center"><img src="docs/mobile.png" alt="Mobile view" width="300"></p>

## Features

- **Reads Indian prescriptions as written**: brand names and doctor shorthand (`1-0-1`, `BD`, `TDS`, `HS`, `SOS`, `q6h`, `½`). Header and advice lines like "Dr. Sharma MBBS" or "Review after 5 days" are skipped.
- **Indian brand → composition lookup**, with a fallback to the US NLM RxNorm database. The fallback rejects unconfident matches instead of guessing.
- **Per-patient limits**: adjusted for weight (children), liver disease or alcohol use, sex, and age 60+/65+. For children, a medicine without a weight-based limit is flagged as "not checked" instead of being compared with the adult dose.
- **Finds**: the same ingredient in several medicines, daily totals over the limit, two drugs from the same class (e.g. two NSAIDs), allergy-group matches (penicillin allergy + amoxicillin), and condition warnings (NSAIDs with kidney disease, ARBs or statins in pregnancy, domperidone with heart disease, and others). Low-dose aspirin (up to 325 mg/day) is treated as heart protection, not an anti-inflammatory dose.
- **Never says "ok" on missing data**: an unknown brand, a missing strength or a missing frequency gives `incomplete`, not a wrong total.
- **4-step guided form** with required fields, inline errors and a linked error summary. Accessible (WCAG AA contrast, keyboard, screen-reader labels) and mobile-first.
- **Pluggable drug data**: a Settings panel shows each source (free and paid) with its cost and whether it's connected.
- **Optional AI**: Claude or a local Ollama model reads handwritten prescriptions and writes a review. Off by default; the rule engine works without it.
- **Private by default**: everything runs in the browser, and health details are kept only for the current tab.

## Quick start

Requires Node.js 20 or newer. No `npm install` is needed; there are no dependencies.

```bash
git clone https://github.com/saigagan99/rx-overlap-checker.git
cd rx-overlap-checker
cp .env.example .env    # optional: add keys
npm start               # http://localhost:8787
npm test                # engine + server tests
```

Click **Fill an example** on step 2 to see it catch a paracetamol overlap.

## How it works

```
prescription text / photo
        │  parseLine()            "Combiflam 1-1-1" → name, 3 doses/day
        ▼
ingredient lookup                 Indian brand list → custom source → typed composition → RxNorm (guarded)
        │
        ▼
analyze()                         per-ingredient daily totals, limits for this patient,
        │                         same-class groups (curated + WHO ATC), allergy groups, conditions
        ▼
status: danger | incomplete | warning | ok   + alerts, suggestions for the doctor
```

| File | Purpose |
|---|---|
| `engine.js` | All checking logic. Shared by the browser and the server, with no dependencies. |
| `index.html` | The web app (vanilla JS, no build step). |
| `server.js` | Serves the app and the `/v1` API; holds API keys. |
| `data/brands-in.csv` | Starter list of 51 common Indian brands. |
| `test/` | `node:test` suites for the engine and the server (16 tests). |
| `.github/workflows/test.yml` | Runs the tests on Node 20, 22 and 24 on every push. |
| `docs/` | README screenshots. |

## Configuration

All keys live in `.env` on the server and never reach the browser. See [`.env.example`](.env.example).

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (default 8787) |
| `CLIENT_API_KEYS` | Comma-separated keys you issue to hospital/telemedicine clients (`x-api-key` header). **If empty, the API only answers requests from the same machine.** |
| `ANTHROPIC_API_KEY` / `OLLAMA_URL` | Optional AI for photo reading and reviews |
| `UI_AI_PROXY` | Let the web page use the server's AI key (default `true`; set `false` to turn off) |
| `UI_AI_LIMIT_PER_HOUR` | AI calls per IP per hour from the web page (default 30) |
| `OPENFDA_API_KEY` | Optional; higher openFDA rate limit |
| `CUSTOM_SOURCE_URL` / `_HEADER` / `_KEY` | A paid drug database or your own service |
| `BRANDS_CSV` | Extra brand lists, e.g. the [Kaggle A-Z Medicine Dataset of India](https://www.kaggle.com/datasets/shudhanshusingh/az-medicine-dataset-of-india) (check its licence) |

## API: check before signing a prescription

```http
POST /v1/check
x-api-key: <client key>
content-type: application/json

{
  "patient": { "age": 70, "sex": "female", "weight_kg": 58, "conditions": ["kidney"], "allergies": ["sulfa"] },
  "medicines": [
    { "name": "Zerodol-P", "frequency": "BD" },
    { "name": "Combiflam", "frequency": "1-1-1" },
    { "name": "Custom Brand X", "ingredients": [{ "name": "paracetamol", "mg": 500 }], "doses_per_day": 2 }
  ]
}
```

Response (texts shortened):

```json
{
  "status": "warning",
  "alerts": [
    { "level": "warning", "code": "duplicate_ingredient", "ingredients": ["acetaminophen"], "text": "Same ingredient in 3 medicines: paracetamol (acetaminophen) (Zerodol-P, Combiflam, Custom Brand X)." },
    { "level": "warning", "code": "same_class", "ingredients": ["aceclofenac", "ibuprofen"], "text": "Same drug class: aceclofenac + ibuprofen are both NSAIDs ..." },
    { "level": "warning", "code": "patient_factor", "ingredients": [], "text": "NSAIDs (aceclofenac, ibuprofen) can worsen kidney function. ..." }
  ],
  "suggestions": ["Zerodol-P contains paracetamol (acetaminophen) in addition to aceclofenac. Consider aceclofenac alone ..."],
  "ingredients": [{ "name": "acetaminophen", "mg_per_day": 2625, "reference_max_mg_per_day": 4000, "sources": ["..."] }],
  "medicines": ["..."],
  "incomplete": [],
  "unresolved": [],
  "class_check_partial": false,
  "disclaimer": "Decision support only. ..."
}
```

- **`status`**: `danger` > `incomplete` > `warning` > `ok`. Treat `incomplete` like `danger`, because the check couldn't see everything. A suggested integration: block **Sign** on `danger` or `incomplete` until the doctor enters an override reason, and show warnings inline.
- **Request options**: send `medicines` (structured), `prescription_text` (free text, one medicine per line), or both. Each medicine takes `name` plus `frequency` (shorthand like `BD`, `1-0-1`) or `doses_per_day`, optional `units_per_dose`, and optional `ingredients` or `composition` for brands the app doesn't know. `include_labels: false` skips openFDA label lookups (faster). `ai_review: true` adds an AI review if the server has an AI key.
- **Validation**: `patient.age` is required (0–120). Numbers must be JSON numbers (`"four"` or `"650mg"` → 400). Allowed `patient.conditions` values: `liver`, `alcohol`, `kidney`, `pregnant`, `breastfeeding`, `ulcer`, `heart`, `thinners`, `diabetes`, `asthma`.
- **Alert codes**: `over_limit`, `duplicate_ingredient`, `near_limit`, `same_class`, `patient_factor`, `incomplete`, `class_check_partial`.
- `GET /v1/lookup?q=Pan-D` returns the brand → composition lookup only.

## Testing

```bash
npm test
```

16 tests with Node's built-in test runner, no dependencies. The engine tests cover the prescription parser, brand matching (including "Zerodol P" vs "Zerodol-P" and brands without a strength), overdose detection across brands, children's limits, allergy groups, missing data, and the clinical rules above. The server tests start the real server and check API keys, input validation, oversized requests, that secret files aren't served, and the AI endpoint limits. GitHub Actions runs them on every push.

## Deploying

Run `node server.js` behind any HTTPS reverse proxy. With **nginx**, pass the original host through, or the web page's AI calls are refused as cross-site:

```nginx
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_set_header Host $host;
}
```

The AI rate limit is kept in memory per process. Use a shared store if you run several instances.

## Data sources and costs

Prices checked November 2026. Paid figures marked "reported" come from third-party estimates, because the vendors don't publish prices.

| Source | Gives | Cost | In the app |
|---|---|---|---|
| Built-in Indian brand list (`data/`) | Exact composition for common brands | Free | On by default |
| [NLM RxNorm / RxClass](https://lhncbc.nlm.nih.gov/RxNav/) | Generic names, WHO ATC drug classes | Free, no key | On by default (checked fallback) |
| [openFDA](https://open.fda.gov/apis/authentication/) | US label dosing text | Free; key optional (1,000 → 120,000 requests/day) | On; add key in Settings or `OPENFDA_API_KEY` |
| [ABDM Drug Registry](https://drugregistry.abdm.gov.in) (Govt. of India) | 123,000+ Indian brands with composition and same-composition alternatives | Free; requires ABDM integrator registration ([sandbox](https://sandbox.abdm.gov.in)) | Connect through an adapter (below) |
| [DrugSetu](https://drugsetu.com/pricing/) | Indian brands, composition, MRP; Growth adds classes and interaction notes | ₹1,499/mo (50k requests) or ₹2,599/mo (100k), + 18% GST; 7-day trial | Connect through an adapter |
| [DrugBank](https://go.drugbank.com/pricing/) | Global drug data, duplicate-ingredient and interaction checks (US/CA/EU products) | Usage-based quote; reported ~US$10k–50k+/yr for startups; free academic (non-commercial) | Connect through an adapter |
| FDB, Medi-Span, Micromedex | Hospital-grade interaction databases | Enterprise contracts; reported ~US$25k–250k+/yr | Connect through an adapter |

**Connecting a provider:** each one has its own response format and login. Run a small adapter on your server that calls the provider with your key and returns `{"matched": "...", "ingredients": [{"name": "paracetamol", "strength_mg": 325}]}`. Then set its URL in Settings → *Connect a provider*, or as `CUSTOM_SOURCE_URL` / `_HEADER` / `_KEY` in `.env`. It's tried right after the built-in brand list.

## Limitations

- **Not a medical device and not medical advice.** The reference limits and brand list are starting points and need review by a pharmacist before clinical use. In India, clinical decision support software may fall under CDSCO's medical device software rules.
- It checks duplication, daily limits, drug classes, allergy groups and some conditions. It is **not** a full drug–drug interaction database.
- AI output is labelled as advisory and can be wrong.

## License

[MIT](LICENSE) © 2026 saigagan
