// Rx Overlap Checker engine. Shared by the browser UI (index.html) and the API server (server.js).
// No dependencies; needs a global fetch (browsers, Node 18+).

/* ---------- Reference data ---------- */
// Typical adult maximum total daily oral dose in mg. Label-derived reference values; review clinically before production use.
export const LIMITS = {
  acetaminophen:{max:4000, perKg:75, note:"Many labels and clinicians advise staying at or under 3000 mg/day."},
  ibuprofen:{max:3200, perKg:40, note:"Without a doctor's direction, the OTC limit is 1200 mg/day."},
  naproxen:{max:1500, note:"OTC naproxen sodium: 660 mg/day. Prescription doses are usually 1000 mg/day or less."},
  aspirin:{max:4000, note:"Low-dose aspirin (75–150 mg) for heart protection still adds to the total and to bleeding risk."},
  aceclofenac:{max:200}, diclofenac:{max:150}, celecoxib:{max:400}, etoricoxib:{max:120}, meloxicam:{max:15},
  nimesulide:{max:200, note:"Adults only. Banned in India for children under 12. Shortest possible course."},
  "mefenamic acid":{max:1500, note:"Short courses only (up to 7 days)."},
  ketorolac:{max:40, note:"Oral; max 5 days total."},
  diphenhydramine:{max:300, note:"As a sleep aid: 50 mg/night."}, chlorpheniramine:{max:24},
  cetirizine:{max:10}, levocetirizine:{max:5}, loratadine:{max:10}, desloratadine:{max:5}, fexofenadine:{max:180},
  pseudoephedrine:{max:240}, phenylephrine:{max:60}, dextromethorphan:{max:120}, guaifenesin:{max:2400},
  caffeine:{max:400}, codeine:{max:360}, tramadol:{max:400, note:"Over 75 years old: 300 mg/day."},
  domperidone:{max:30, note:"Max 30 mg/day for up to 1 week (heart rhythm risk)."},
  metformin:{max:2550, note:"Extended-release: 2000 mg/day."}, glimepiride:{max:8}, gabapentin:{max:3600}, cyclobenzaprine:{max:30},
  sertraline:{max:200}, fluoxetine:{max:80}, escitalopram:{max:20},
  citalopram:{max:40, elderlyMax:20, note:"20 mg/day if over 60 (heart rhythm risk)."},
  atorvastatin:{max:80}, rosuvastatin:{max:40}, simvastatin:{max:40, note:"80 mg is only for long-term existing users."},
  amlodipine:{max:10}, lisinopril:{max:80}, losartan:{max:100}, telmisartan:{max:80}, montelukast:{max:10},
  loperamide:{max:16, note:"Without a doctor's direction, the OTC limit is 8 mg/day."},
  zolpidem:{max:10, femaleMax:5, note:"For immediate-release, FDA recommends 5 mg for women and older adults."},
};
// Same-purpose drug groups that RxNorm/ATC often can't classify for India-only molecules.
export const GROUPS = {
  "NSAIDs (anti-inflammatory painkillers)":["ibuprofen","naproxen","aspirin","diclofenac","aceclofenac","celecoxib","etoricoxib","meloxicam","ketorolac","indomethacin","ketoprofen","nimesulide","piroxicam","mefenamic acid","dexketoprofen"],
  "Antihistamines":["cetirizine","levocetirizine","loratadine","desloratadine","fexofenadine","chlorpheniramine","pheniramine","diphenhydramine","doxylamine","promethazine","hydroxyzine","bilastine","ebastine"],
  "Acid reducers (PPIs)":["omeprazole","esomeprazole","pantoprazole","rabeprazole","lansoprazole"],
  "Anti-nausea / prokinetics":["domperidone","metoclopramide","itopride","levosulpiride"],
  "Decongestants":["pseudoephedrine","phenylephrine"],
  "Statins":["atorvastatin","rosuvastatin","simvastatin","pravastatin"],
  "ACE inhibitors / ARBs":["lisinopril","enalapril","ramipril","losartan","telmisartan","olmesartan","valsartan"],
  "Sulfonylureas":["glimepiride","gliclazide","glipizide","glibenclamide"],
  "SSRIs":["sertraline","fluoxetine","escitalopram","citalopram","paroxetine"],
  "Opioids":["tramadol","codeine","tapentadol","oxycodone","hydrocodone","morphine"],
};
const NSAIDS = GROUPS["NSAIDs (anti-inflammatory painkillers)"];
const SEDATING_AH = ["diphenhydramine","chlorpheniramine","pheniramine","doxylamine","promethazine","hydroxyzine"];
// Allergy → drugs that share it. Name-only matching misses e.g. penicillin allergy + amoxicillin (Augmentin).
const ALLERGY_GROUPS = {
  penicillin:["penicillin","amoxicillin","ampicillin","cloxacillin","dicloxacillin","flucloxacillin","piperacillin","benzathine penicillin"],
  sulfa:["sulfamethoxazole","sulfasalazine","sulfadiazine","sulfacetamide"],
  nsaid:NSAIDS, aspirin:NSAIDS, // aspirin allergy often cross-reacts with other NSAIDs
};
ALLERGY_GROUPS.sulfonamide = ALLERGY_GROUPS.sulfa;
const BEERS =[...SEDATING_AH,"cyclobenzaprine","zolpidem","alprazolam","lorazepam","diazepam","clonazepam","glibenclamide"];
const ALIAS = { paracetamol:"acetaminophen", pcm:"acetaminophen", apap:"acetaminophen", amoxycillin:"amoxicillin",
  "clavulanic acid":"clavulanate", "chlorphenamine":"chlorpheniramine", "acetylsalicylic acid":"aspirin", "salbutamol":"albuterol",
  "glyburide":"glibenclamide", "frusemide":"furosemide" };
const DISPLAY = { acetaminophen:"paracetamol (acetaminophen)" };
const SALTS = /\s+(sodium|potassium|hydrochloride|hcl|maleate|besylate|besilate|citrate|succinate|tartrate|bitartrate|mesylate|hyclate|monohydrate|trihydrate|magnesium|calcium|dihydrate|fumarate|bromide)$/;
export const CONDITIONS = [
  ["liver","Liver disease"],["alcohol","3+ alcoholic drinks/day"],["kidney","Kidney disease"],
  ["pregnant","Pregnant"],["breastfeeding","Breastfeeding"],["ulcer","Stomach ulcer / GI bleeding"],
  ["heart","Heart disease / high blood pressure"],["thinners","On blood thinners"],["diabetes","Diabetes"],["asthma","Asthma"],
];

// Positive number or null. "650" counts; "650mg", "four", 0 and NaN don't, so bad input becomes "incomplete" instead of a wrong total.
export const posNum = v => { const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN; return Number.isFinite(n) && n > 0 ? n : null; };

// A prescription line that's a header or advice, not a medicine. Only used for lines no source could identify,
// so "Rx: Dolo 650" still counts as a medicine.
const NOTE_LINE = /^\s*(dr|doctor|rx|date|name|patient|pt|age|sex|diagnosis|dx|c\/o|complaints?|advice|advised|review|follow[\s-]?up|next visit|signature|sign|reg)\b|\b(mbbs|frcp|mrcp|dnb|clinic|hospital)\b/i;
export const isNoteLine = raw => NOTE_LINE.test(String(raw));

export function canon(n){
  n = String(n).toLowerCase().replace(/\s+/g," ").trim();
  if(ALIAS[n]) return ALIAS[n];
  while(SALTS.test(n) && !/^(calcium|sodium|potassium|magnesium)\b/.test(n)) n = n.replace(SALTS,"");
  return ALIAS[n] || n;
}
export const displayName = n => DISPLAY[n] || n;

/* ---------- Prescription line parser (handles Indian shorthand: 1-0-1, BD, TDS, HS, SOS) ---------- */
export function parseLine(raw){
  let s = " " + String(raw).toLowerCase().replace(/[–—]/g,"-") + " ";
  let perDay = null; const prn = /\b(prn|sos|as needed|when needed|if needed)\b/.test(s);
  let units = 1;
  const pat = s.match(/(?<![\d.])(\d(?:\.\d)?|½)\s*-\s*(\d(?:\.\d)?|½)\s*-\s*(\d(?:\.\d)?|½)(?:\s*-\s*(\d(?:\.\d)?|½))?(?![\d.])/);
  if(pat){ perDay = [pat[1],pat[2],pat[3],pat[4]||0].reduce((a,b) => a + (b==="½" ? .5 : +b), 0); s = s.replace(pat[0]," "); }
  const freq = [
    [/\b(qid|qds|four times( a day| daily)?|4 times( a day| daily)?)\b/,4],
    [/\b(tid|tds|thrice( a day| daily)?|three times( a day| daily)?|3 times( a day| daily)?)\b/,3],
    [/\b(bid|bd|twice( a day| daily)?|2 times( a day| daily)?)\b/,2],
    [/\b(od|qd|once( a day| daily)?|daily|hs|at night|bedtime|qhs|in the morning|qam)\b/,1],
  ];
  if(perDay == null){
    const q = s.match(/\b(?:q|every)\s*(\d{1,2})\s*(?:-\s*\d{1,2}\s*)?(?:h|hr|hrs|hours?)\b/);
    if(q){ perDay = Math.floor(24 / +q[1]); s = s.replace(q[0]," "); }
  }
  if(perDay == null) for(const [re,n] of freq){ if(re.test(s)){ perDay = n; break; } }
  for(const [re] of freq) s = s.replace(re," ");
  s = s.replace(/\b(prn|sos|as needed|when needed|if needed|after food|before food|with food|after meals?|before meals?|empty stomach|x\s*\d+\s*days?|for\s*\d+\s*(days?|weeks?)|\d+\s*days?|po|orally|by mouth)\b/g," ");
  const u = s.match(/(?<![\w.])(\d(?:\.\d)?|one|two|three|half|½)\s*(tabs?|tablets?|caps?|capsules?|pills?|caplets?)\b/);
  if(u){ units = {one:1,two:2,three:3,half:.5,"½":.5}[u[1]] ?? +u[1]; s = s.replace(u[0]," "); }
  s = s.replace(/\b(tab|tabs|tablet|tablets|cap|caps|capsule|capsules|syrup|inj|take|oral|sig|rx)\b\.?/g," ");
  s = s.replace(/^\s*\d+[.)]\s+/," "); // list numbering "1. "
  const nums = [...s.matchAll(/(\d+(?:\.\d+)?)/g)].map(m => +m[1]);
  const query = s.replace(/\s+/g," ").trim();
  const bare = s.replace(/\d+(\.\d+)?\s*(mg|mcg|g|ml)?/g," ").replace(/[\/,+]/g," ").replace(/\s+/g," ").trim();
  return { raw:String(raw).trim(), query, bare, nums, units, perDay: perDay ?? (prn ? 4 : 1), prn, guessedFreq: perDay == null };
}

/* ---------- Composition strings: "Ibuprofen (400mg) + Paracetamol (325mg)" or "ibuprofen 400 + paracetamol 325" ---------- */
export function parseComposition(str){
  return String(str).split(/\s*\+\s*|\s*,\s*(?=[a-z])/i).map(p => p.trim()).filter(Boolean).map(p => {
    const m = p.match(/^(.*?)[\s(]*([\d.]+)\s*(mg|mcg|µg|g|iu|%|ml)?\s*(\/\s*[\d.]*\s*\w+)?\s*\)?\s*$/i);
    if(!m) return { name: canon(p.replace(/[()]/g,"")), mg:null };
    const unit = (m[3] || "mg").toLowerCase(); let mg = +m[2];
    if(m[4] || unit === "iu" || unit === "%" || unit === "ml") mg = null;      // liquids / IU: per-unit mg not comparable
    else if(unit === "mcg" || unit === "µg") mg = mg / 1000;
    else if(unit === "g") mg = mg * 1000;
    return { name: canon(m[1].replace(/[()]/g,"")), mg };
  }).filter(i => i.name);
}

/* ---------- Brand database (CSV) ---------- */
// Accepts: our seed format (brand,composition), Kaggle "A-Z Medicine Dataset of India" (name, short_composition1, short_composition2),
// or Kaggle "Indian Medicine Data" (product_name, salt_composition).
function parseCSV(text){
  const rows = []; let row = [], f = "", q = false;
  for(let i = 0; i < text.length; i++){
    const c = text[i];
    if(q){ if(c === '"'){ if(text[i+1] === '"'){ f += '"'; i++; } else q = false; } else f += c; }
    else if(c === '"') q = true;
    else if(c === ","){ row.push(f); f = ""; }
    else if(c === "\n" || c === "\r"){ if(c === "\r" && text[i+1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if(f || row.length){ row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
const normBrand = s => String(s).toLowerCase()
  .replace(/\b(tablets?|tab|capsules?|cap|syrup|suspension|injection|strip of \d+.*|oral|film coated|er|sr|xr|mr|dt)\b\.?/g, m => /^(er|sr|xr|mr|dt)$/.test(m) ? m : " ")
  .replace(/[^a-z0-9.%+ ]/g," ") // hyphens become spaces: "Zerodol-P" and "Zerodol P" must match.replace(/\s+/g," ").trim();

export class BrandDB {
  constructor(){ this.map = new Map(); this.byFirst = new Map(); }
  get size(){ return this.map.size; }
  addCSV(text){
    const rows = parseCSV(text); if(!rows.length) return 0;
    const h = rows[0].map(x => x.trim().toLowerCase());
    const bi = ["brand","name","product_name"].map(k => h.indexOf(k)).find(i => i >= 0);
    const ci = ["composition","short_composition1","short_composition2","salt_composition"].map(k => h.indexOf(k)).filter(i => i >= 0);
    const di = h.indexOf("is_discontinued");
    if(bi == null || !ci.length) throw new Error("CSV needs a brand/name column and a composition column");
    let n = 0;
    for(const r of rows.slice(1)){
      if(di >= 0 && /true/i.test(r[di])) continue;
      const comp = ci.map(i => r[i]).filter(x => x && x.trim()).join(" + ");
      const ings = parseComposition(comp); if(!ings.length) continue;
      const key = normBrand(r[bi]); if(!key || this.map.has(key)) continue;
      this.map.set(key, { brand: r[bi].trim(), ings });
      const first = key.split(" ")[0]; (this.byFirst.get(first) || this.byFirst.set(first, []).get(first)).push(key);
      n++;
    }
    return n;
  }
  find(query){
    const q = normBrand(query); if(!q) return null;
    if(this.map.has(q)) return this.map.get(q);
    const cands = this.byFirst.get(q.split(" ")[0]) || [];
    if(!cands.length) return null;
    // Prefer the candidate sharing the most tokens (e.g. "pan 40" → "pan 40", not "pan d"); require all query numbers to match.
    const qt = q.split(" "), qnums = qt.filter(t => /^\d/.test(t));
    let best = [], bestScore = 0;
    for(const k of cands){
      const kt = k.split(" ");
      if(qnums.some(n => !kt.includes(n))) continue;
      const score = qt.filter(t => kt.includes(t)).length - 0.01 * Math.abs(kt.length - qt.length);
      if(score > bestScore + 1e-9){ best = [k]; bestScore = score; }
      else if(Math.abs(score - bestScore) < 1e-9 && score > 0) best.push(k);
    }
    if(!best.length) return null;
    const hits = best.map(k => this.map.get(k)), names = h => h.ings.map(i => i.name).sort().join("+");
    if(hits.every(h => JSON.stringify(h.ings) === JSON.stringify(hits[0].ings))) return hits[0];
    // Tie between brands with different ingredients ("Pan" → Pan 40 or Pan-D?): don't guess.
    if(hits.some(h => names(h) !== names(hits[0]))) return null;
    // Same ingredients, different strengths ("Dolo" → 500 or 650?): leave mg blank and offer the options.
    return { brand: hits.map(h => h.brand).join(" / "), ings: hits[0].ings.map(i => ({ name:i.name, mg:null,
      choices:[...new Set(hits.map(h => h.ings.find(x => x.name === i.name).mg))].sort((a,b) => a-b) })) };
  }
}

/* ---------- Engine ---------- */
const RX = "https://rxnav.nlm.nih.gov/REST";

export function createEngine({ brands = new BrandDB(), custom = null, fdaKey = "", fetchImpl = (...a) => fetch(...a) } = {}){
  const cache = new Map();
  async function getJSON(url, opts){
    if(!opts && cache.has(url)) return cache.get(url);
    const r = await fetchImpl(url, opts);
    if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const j = await r.json();
    if(!opts){ cache.set(url, j); if(cache.size > 5000) cache.delete(cache.keys().next().value); } // drop oldest so a long-running server stays bounded
    return j;
  }

  async function lookupCustom(med){
    const url = custom.url.replace("{name}", encodeURIComponent(med.query));
    const headers = {}; if(custom.header && custom.key) headers[custom.header] = custom.key;
    const j = await getJSON(url, {headers});
    if(!j.ingredients?.length) throw new Error("no ingredients");
    return { matched: j.matched || med.query, source:"custom",
      ings: j.ingredients.map(i => ({ name:canon(i.name), mg:i.strength_mg ?? null, choices:[] })), customMax: j.max_daily_mg || {} };
  }

  async function lookupRxNorm(med){
    let rxcui = null;
    for(const term of [med.query, med.bare]){
      if(!term) continue;
      const t = term.split(" ").map(w => ALIAS[w] || w).join(" ");
      const j = await getJSON(`${RX}/approximateTerm.json?term=${encodeURIComponent(t)}&maxEntries=1&option=1`);
      rxcui = j.approximateGroup?.candidate?.[0]?.rxcui;
      if(rxcui) break;
    }
    if(!rxcui) throw new Error("not found");
    const [props, rel] = await Promise.all([
      getJSON(`${RX}/rxcui/${rxcui}/properties.json`),
      getJSON(`${RX}/rxcui/${rxcui}/related.json?tty=IN+SCDC+BN`),
    ]);
    const groups = rel.relatedGroup?.conceptGroup || [];
    const names = n => (groups.find(g => g.tty === n)?.conceptProperties || []);
    const ins = names("IN").map(c => ({name:c.name.toLowerCase(), rxcui:c.rxcui}));
    const scdc = names("SCDC").map(c => c.name.toLowerCase());
    const matched = props.properties?.name || med.query;
    // Guard against fuzzy matches to unrelated US products (e.g. "Pan 40" → calcium carbonate).
    const word = (med.bare || med.query).split(" ").map(w => ALIAS[w] || w).find(w => w.length > 2) || "";
    const hay = [matched, ...ins.map(i => i.name), ...names("BN").map(b => b.name)].join(" | ").toLowerCase();
    if(!ins.length || (word && !hay.includes(word))) throw new Error("no confident match");
    const ings = ins.map(i => {
      const choices = [...new Set(scdc.filter(n => n.startsWith(i.name)).map(n => n.match(/([\d.]+)\s*mg$/)?.[1]).filter(Boolean).map(Number))].sort((a,b)=>a-b);
      let mg = null;
      if(choices.length === 1) mg = choices[0];
      else { const hit = med.nums.find(n => choices.includes(n)); if(hit != null) mg = hit; }
      if(mg == null && ins.length === 1 && med.nums.length === 1) mg = med.nums[0];
      return { name:canon(i.name), rxcui:i.rxcui, mg, choices };
    });
    return { matched, source:"rxnorm", ings };
  }

  // Resolution order: Indian brand DB → custom/paid source → generic composition typed inline → US RxNorm (guarded).
  async function lookup(med){
    const b = brands.find(med.query) || (med.bare !== med.query && brands.find(med.bare));
    if(b) return { matched: b.brand, source:"brand-db", ings: b.ings.map(i => ({choices:[], ...i})) };
    if(custom?.url){ try{ return await lookupCustom(med); }catch(e){ /* fall through */ } }
    const inline = parseComposition(med.query);
    if(inline.length > 1 && inline.every(i => i.mg != null)) return { matched: inline.map(i => i.name).join(" + "), source:"typed", ings: inline };
    try{ return await lookupRxNorm(med); }
    catch(e){ throw new Error("Not recognised. Type the composition from the strip, e.g. \"paracetamol 325 + ibuprofen 400\""); }
  }

  // Both throw on network errors so analyze() can report a partial check instead of silently finding nothing.
  async function rxcuiFor(name){
    const j = await getJSON(`${RX}/rxcui.json?name=${encodeURIComponent(name)}&search=0`); return j.idGroup?.rxnormId?.[0] || null;
  }
  async function atcClasses(rxcui){
    if(!rxcui) return [];
    const j = await getJSON(`${RX}/rxclass/class/byRxcui.json?rxcui=${rxcui}&relaSource=ATC`);
    const skip = /^(D|S|G02|R01A|R02|M02|C01EB|C05|A01)/; // topical / local-use classes
    const out = new Map();
    for(const x of j.rxclassDrugInfoList?.rxclassDrugInfo || []){
      if(x.minConcept.rxcui !== rxcui) continue;
      const c = x.rxclassMinConceptItem; if(!skip.test(c.classId)) out.set(c.classId, c.className);
    }
    return [...out].map(([id,name]) => ({id,name}));
  }
  async function fdaLabel(name){
    const url = `https://api.fda.gov/drug/label.json?search=openfda.generic_name:"${encodeURIComponent(name)}"&limit=1${fdaKey ? "&api_key="+encodeURIComponent(fdaKey) : ""}`;
    try{ const j = await getJSON(url); const d = j.results?.[0]?.dosage_and_administration?.[0]; return d ? d.slice(0, 700) : null; }catch{ return null; }
  }

  function limitFor(name, P, customMax){
    const L = LIMITS[name]; const notes = [];
    let max = customMax?.[name] ?? L?.max ?? null;
    if(max == null) return {max:null, notes};
    if(P.age != null && P.age < 18 && L?.perKg && !P.weight) return {max:null, notes:["Enter weight: the limit for children depends on body weight."]};
    if(P.age != null && P.age < 12 && !L?.perKg) return {max:null, notes:["Adult limit doesn't apply to children. Check the dose with a doctor."]};
    if(L?.perKg && P.weight && (P.weight < 50 || (P.age && P.age < 18))){ const kg = Math.min(max, L.perKg * P.weight); if(kg < max){ max = kg; notes.push(`Based on weight (${P.weight} kg × ${L.perKg} mg/kg).`); } }
    if(name === "acetaminophen" && (P.conds.liver || P.conds.alcohol)){ max = Math.min(max, 2000); notes.push("Lowered to 2000 mg because of liver disease or regular alcohol use."); }
    if(L?.femaleMax && P.sex === "female"){ max = Math.min(max, L.femaleMax); notes.push("Lower limit recommended for women."); }
    if(L?.femaleMax && P.age >= 65){ max = Math.min(max, L.femaleMax); notes.push("Lower limit recommended for older adults."); }
    if(L?.elderlyMax && P.age > 60){ max = Math.min(max, L.elderlyMax); notes.push("Lower limit for people over 60."); }
    if(L?.note) notes.push(L.note);
    return {max, notes};
  }

  // meds: [{raw, units, perDay, prn, ings:[{name, mg, rxcui?}], customMax?}]   P: {age, sex, weight, height, conds:{}, allergies}
  async function analyze(meds, P, { labels = true } = {}){
    P = { conds:{}, ...P };
    const listed = meds.filter(m => String(m.raw || "").trim() && (m.ings?.length || !isNoteLine(m.raw)));
    const valid = listed.filter(m => m.ings?.length);
    const byIng = new Map(); const customMax = {};
    for(const m of valid){
      Object.assign(customMax, m.customMax || {});
      for(const g of m.ings){
        const e = byIng.get(g.name) || {name:g.name, display:displayName(g.name), rxcui:g.rxcui, sources:[], total:0, unknown:false};
        const mg = posNum(g.mg), units = posNum(m.units), perDay = posNum(m.perDay);
        const daily = mg && units && perDay ? mg * units * perDay : null;
        e.sources.push({medicine:m.raw, mg_per_unit:mg, mg_per_day:daily});
        if(daily == null) e.unknown = true; else e.total += daily;
        e.rxcui ||= g.rxcui;
        byIng.set(g.name, e);
      }
    }
    const ings = [...byIng.values()];
    let classCheckPartial = false;
    await Promise.all(ings.map(async e => {
      try{ e.rxcui ||= await rxcuiFor(e.name); e.classes = await atcClasses(e.rxcui); }
      catch{ e.classes = []; classCheckPartial = true; }
      const l = limitFor(e.name, P, customMax); e.max = l.max; e.limitNotes = l.notes;
      if(labels && e.max == null) e.label = await fdaLabel(e.name);
    }));

    const alerts = [];
    const has = n => byIng.has(n);
    for(const e of ings) if(e.max && e.total > e.max)
      alerts.push({level:"danger", code:"over_limit", ingredients:[e.name], text:`Over the daily limit: ${e.display}. ${Math.round(e.total)} mg/day vs a limit of ${e.max} mg/day${e.sources.length > 1 ? `, coming from ${e.sources.length} medicines (${e.sources.map(s => s.medicine).join(", ")})` : ""}.`});
    for(const e of ings) if(e.sources.length > 1 && !(e.max && e.total > e.max))
      alerts.push({level:"warning", code:"duplicate_ingredient", ingredients:[e.name], text:`Same ingredient in ${e.sources.length} medicines: ${e.display} (${e.sources.map(s => s.medicine).join(", ")}).`});
    // A single medicine at its usual dose is the prescriber's intent; only warn when several sources add up.
    for(const e of ings) if(e.max && e.sources.length > 1 && e.total <= e.max && e.total >= 0.8 * e.max)
      alerts.push({level:"warning", code:"near_limit", ingredients:[e.name], text:`Close to the daily limit: ${e.display}. ${Math.round(e.total)} of ${e.max} mg/day.`});

    // Same therapeutic class across different ingredients: curated groups + ATC level 4.
    const seen = new Set(); const classDupes = [];
    const pushClass = (name, set) => { const k = [...set].sort().join("|"); if(set.size > 1 && !seen.has(k)){ seen.add(k); classDupes.push({name, ings:[...set]}); } };
    for(const [g, members] of Object.entries(GROUPS)) pushClass(g, new Set(ings.filter(e => members.includes(e.name)).map(e => e.name)));
    const atc = new Map();
    for(const e of ings) for(const c of e.classes){ const k = c.id.slice(0,5); const v = atc.get(k) || {name:c.name, ings:new Set()}; v.ings.add(e.name); atc.set(k, v); }
    for(const v of atc.values()) if(![...seen].some(k => [...v.ings].every(i => k.split("|").includes(i)))) pushClass(v.name, v.ings);
    for(const c of classDupes) alerts.push({level:"warning", code:"same_class", ingredients:c.ings, text:`Same drug class: ${c.ings.map(displayName).join(" + ")} are both ${c.name}. Their effects and side effects add up.`});

    const nsaids = ings.filter(e => NSAIDS.includes(e.name)).map(e => e.name);
    const anyN = nsaids.length > 0;
    // Low-dose aspirin (up to 325 mg/day) is taken to protect the heart, so it doesn't trigger the anti-inflammatory-dose warnings below.
    const nsaidsAntiInflam = nsaids.filter(n => n !== "aspirin" || byIng.get("aspirin").total > 325);
    const flag = (t, level = "info") => alerts.push({level, code:"patient_factor", ingredients:[], text:t});
    if(nsaidsAntiInflam.length && P.conds.kidney) flag(`NSAIDs (${nsaidsAntiInflam.join(", ")}) can worsen kidney function. Ask whether they're needed.`, "warning");
    if(anyN && P.conds.ulcer) flag("NSAIDs and aspirin raise the risk of stomach bleeding with ulcer or GI-bleed history.", "warning");
    if(anyN && P.conds.thinners) flag("NSAIDs or aspirin with a blood thinner significantly raises bleeding risk.", "warning");
    if(nsaidsAntiInflam.length && P.conds.heart) flag("NSAIDs can raise blood pressure and strain the heart.");
    if(anyN && P.conds.asthma) flag("Some people with asthma react badly to aspirin/NSAIDs.");
    if(nsaidsAntiInflam.length && P.conds.pregnant) flag("NSAIDs are generally avoided from 20 weeks of pregnancy onward unless a doctor directs it.", "warning");
    if(has("nimesulide") && P.age != null && P.age < 12) flag("Nimesulide is banned in India for children under 12.", "danger");
    if(P.conds.pregnant && ["lisinopril","enalapril","ramipril","losartan","telmisartan","olmesartan","valsartan"].some(has)) flag("ACE inhibitors and ARBs are not used in pregnancy.", "warning");
    if(P.conds.pregnant && ["atorvastatin","rosuvastatin","simvastatin"].some(has)) flag("Statins are usually stopped during pregnancy. Check with the prescriber.", "warning");
    if(P.conds.heart && ["pseudoephedrine","phenylephrine"].some(has)) flag("Decongestants (pseudoephedrine/phenylephrine) can raise blood pressure and heart rate.");
    if(P.conds.heart && has("domperidone")) flag("Domperidone can affect heart rhythm. Check it's appropriate with heart disease.", "warning");
    if(P.conds.kidney && has("metformin")) flag("Metformin dosing depends on kidney function (eGFR). Check it's been reviewed.");
    if(P.conds.kidney && has("gabapentin")) flag("Gabapentin needs a lower dose when kidney function is reduced.");
    if(P.age != null && P.age < 12){
      const unchecked = ings.filter(e => e.max == null && LIMITS[e.name] && !LIMITS[e.name].perKg).map(e => e.display);
      if(unchecked.length) flag(`Children's doses for ${unchecked.join(", ")} aren't in the reference table, so ${unchecked.length > 1 ? "they weren't" : "it wasn't"} checked. Confirm the dose for this child's age and weight.`, "warning");
    }
    if(P.age >= 65){ const b = ings.filter(e => BEERS.includes(e.name)).map(e => e.name); if(b.length) flag(`For adults 65+, ${b.join(", ")} ${b.length > 1 ? "are" : "is"} on the AGS Beers list (higher risk of confusion, falls). Ask about alternatives.`); }
    if(P.allergies) for(const a of String(P.allergies).toLowerCase().split(/[,;]/).map(x => canon(x)).filter(x => x.length > 2)){
      const group = ALLERGY_GROUPS[a] || ALLERGY_GROUPS[a.split(" ")[0].replace(/s$/, "")] || [];
      for(const e of ings) if(e.name.includes(a) || a.includes(e.name) || group.includes(e.name))
        flag(`Listed allergy to "${a}", and ${e.display} is in this prescription${group.includes(e.name) && !e.name.includes(a) ? " (same allergy group)" : ""}.`, "danger");
    }

    // Anything we couldn't read fully makes the result "incomplete", never "ok".
    const incomplete = [];
    for(const m of listed){
      if(!m.ings?.length) incomplete.push({medicine:m.raw, reason:"not identified"});
      else if(m.ings.some(g => !posNum(g.mg))) incomplete.push({medicine:m.raw, reason:"strength unknown"});
      if(m.ings?.length && !posNum(m.units)) incomplete.push({medicine:m.raw, reason:"tablets per dose missing"});
      if(m.ings?.length && (!posNum(m.perDay) || (m.guessedFreq && !m.prn))) incomplete.push({medicine:m.raw, reason:"how often it's taken is missing"});
    }
    if(P.age != null && P.age < 12 && !P.weight) incomplete.push({medicine:null, reason:"child's weight missing (limits depend on weight)"});
    for(const x of incomplete) alerts.push({level:"warning", code:"incomplete", ingredients:[], text:`Can't fully check${x.medicine ? " " + x.medicine : ""}: ${x.reason}.`});
    if(classCheckPartial) alerts.push({level:"info", code:"class_check_partial", ingredients:[], text:"Online drug-group lookup failed for some ingredients. Only the built-in groups were checked."});

    // Rule-based alternatives to discuss.
    const suggestions = [];
    for(const d of ings.filter(e => e.sources.length > 1)){
      const combos = valid.filter(m => m.ings.length > 1 && m.ings.some(g => g.name === d.name));
      const singles = valid.filter(m => m.ings.length === 1 && m.ings[0].name === d.name);
      for(const c of combos){
        const others = c.ings.filter(g => g.name !== d.name).map(g => displayName(g.name)).join(" + ");
        suggestions.push(`${c.raw} contains ${d.display} in addition to ${others}. Consider ${others} alone (single-ingredient product) so ${d.display} comes from just one source.`);
      }
      if(singles.length > 1) suggestions.push(`${singles.map(m => m.raw).join(" and ")} are the same medicine (${d.display}) under different brand names. Only one is likely needed.`);
    }
    if(nsaids.length > 1) suggestions.push(`${nsaids.length} NSAIDs (${nsaids.join(", ")}). Usually only one is used at a time.${!has("acetaminophen") && !P.conds.liver ? " For pain without inflammation, paracetamol is often the non-NSAID option." : ""}`);
    const sed = ings.filter(e => SEDATING_AH.includes(e.name)).map(e => e.name);
    if(sed.length && classDupes.some(c => c.name === "Antihistamines")) suggestions.push(`Multiple antihistamines including sedating ${sed.join(", ")}. One non-drowsy antihistamine (e.g. levocetirizine or fexofenadine) is usually enough.`);

    const order = {danger:0, warning:1, info:2};
    alerts.sort((a,b) => order[a.level] - order[b.level]);
    const status = alerts.some(a => a.level === "danger") ? "danger" : incomplete.length ? "incomplete" : alerts.some(a => a.level === "warning") ? "warning" : "ok";
    return {
      status, alerts, suggestions, incomplete, class_check_partial: classCheckPartial,
      ingredients: ings.map(e => ({ name:e.name, display:e.display, mg_per_day:Math.round(e.total), total_incomplete:e.unknown,
        reference_max_mg_per_day:e.max, limit_notes:e.limitNotes, classes:e.classes.map(c => c.name), sources:e.sources, label_excerpt:e.label || null })),
      medicines: valid.map(m => ({ as_written:m.raw, matched:m.matched, source:m.source, units_per_dose:m.units, doses_per_day:m.perDay, as_needed:!!m.prn,
        ingredients:m.ings.map(g => ({name:g.name, mg_per_unit:posNum(g.mg)})) })),
    };
  }

  return { lookup, analyze, brands };
}

/* ---------- AI providers (Claude or local Ollama) ---------- */
// cfg: {provider:"claude"|"ollama"|"server", claudeKey, claudeModel, ollamaUrl, ollamaModel, ollamaVisionModel, serverUrl}
// "server" only reaches the server's two fixed tasks (parse, review), never a free-form prompt, so its key can't be used as a general AI.
async function serverAI(cfg, path, body, fetchImpl = (...a) => fetch(...a)){
  const r = await fetchImpl((cfg.serverUrl || "") + path, {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body)});
  const j = await r.json(); if(!r.ok) throw new Error(j.error || r.status); return j;
}
export async function callAI(cfg, {system, text, image}, fetchImpl = (...a) => fetch(...a)){
  if(cfg.provider === "claude"){
    if(!cfg.claudeKey) throw new Error("no Claude API key configured");
    const content = [];
    if(image) content.push({type:"image", source:{type:"base64", media_type:image.type, data:image.data}});
    content.push({type:"text", text});
    const headers = { "content-type":"application/json", "x-api-key":cfg.claudeKey, "anthropic-version":"2023-06-01",
      "anthropic-beta":"server-side-fallback-2026-07-01" };
    if(typeof window !== "undefined") headers["anthropic-dangerous-direct-browser-access"] = "true";
    const r = await fetchImpl("https://api.anthropic.com/v1/messages", { method:"POST", headers,
      body: JSON.stringify({ model: cfg.claudeModel || "claude-opus-5-5", max_tokens:16000, system,
        output_config:{effort:"medium"}, fallbacks:"default", messages:[{role:"user", content}] }) });
    const j = await r.json();
    if(!r.ok) throw new Error(j.error?.message || r.status);
    if(j.stop_reason === "refusal") throw new Error("the model declined this request");
    return j.content.filter(b => b.type === "text").map(b => b.text).join("");
  }
  if(cfg.provider === "ollama"){
    const body = { model: image ? (cfg.ollamaVisionModel || "llama3.2-vision") : (cfg.ollamaModel || "llama3.2"), stream:false, format:"json",
      messages:[{role:"system", content:system}, {role:"user", content:text, ...(image ? {images:[image.data]} : {})}] };
    const r = await fetchImpl((cfg.ollamaUrl || "http://localhost:11434").replace(/\/$/,"") + "/api/chat", {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body)});
    if(!r.ok) throw new Error("Ollama " + r.status + " (is it running? From a browser, start it with OLLAMA_ORIGINS=*)");
    return (await r.json()).message?.content || "";
  }
  throw new Error("no AI provider configured");
}
const extractJSON = t => { const m = String(t).match(/\{[\s\S]*\}/); if(!m) throw new Error("no JSON in AI reply"); return JSON.parse(m[0]); };

const PARSE_PROMPT = `Extract every medicine from this prescription (likely Indian: brand names, 1-0-1 / BD / TDS / HS / SOS shorthand). Return ONLY JSON: {"meds":[{"raw":"one clean line: brand or generic name + strength","composition":"generic salts with strengths if you are confident, e.g. 'paracetamol 325mg + ibuprofen 400mg', else empty","units_per_dose":1,"doses_per_day":2,"as_needed":false}]}. Expand shorthand (BD=2, TDS=3, QID=4, 1-0-1=2, q6h=4, HS=1). If a line is unreadable, give your best guess and add "?" to raw.`;
const PARSE_SYSTEM = "You are a careful pharmacy assistant that transcribes prescriptions.";

export async function aiParse(cfg, {text, image}, fetchImpl){
  if(cfg.provider === "server") return (await serverAI(cfg, "/v1/ai/parse", {text, image}, fetchImpl)).meds;
  const out = extractJSON(await callAI(cfg, {system:PARSE_SYSTEM, text: PARSE_PROMPT + (text ? "\n\nPrescription:\n" + text : ""), image}, fetchImpl));
  return (out.meds || []).map(m => {
    const p = parseLine(m.raw || "");
    if(m.units_per_dose) p.units = +m.units_per_dose;
    if(m.doses_per_day){ p.perDay = +m.doses_per_day; p.guessedFreq = false; }
    p.prn = !!m.as_needed || p.prn;
    if(m.composition) p.aiComposition = m.composition;
    return p;
  });
}

export async function aiReview(cfg, patient, report, fetchImpl){
  if(cfg.provider === "server") return serverAI(cfg, "/v1/ai/review", {patient, report}, fetchImpl);
  const prompt = `Review this medication list (Indian prescription context; brand fixed-dose combinations are common) for duplicated active ingredients, same-class duplication, total daily doses above safe limits for this patient, and important interactions the rules may have missed. For each problem, suggest a realistic alternative (single-ingredient version, a different class, or dropping a duplicate) to raise with the prescriber. Never tell the patient to stop a medicine on their own. Return ONLY JSON:
{"summary":"2-3 plain-language sentences","concerns":[{"severity":"high|medium|low","issue":"...","why":"..."}],"alternatives":[{"instead_of":"...","consider":"...","reason":"..."}],"questions_for_doctor":["..."]}

${JSON.stringify({patient, medicines:report.medicines, ingredient_totals:report.ingredients.map(i => ({name:i.name, mg_per_day:i.mg_per_day, reference_max:i.reference_max_mg_per_day})), rule_alerts:report.alerts.map(a => a.text)}, null, 1)}`;
  return extractJSON(await callAI(cfg, {system:"You are a clinical pharmacist assistant. Be accurate, conservative and plain-spoken. If unsure, say so.", text:prompt}, fetchImpl));
}
