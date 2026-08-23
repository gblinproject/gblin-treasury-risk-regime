/**
 * Genera src/x402-challenge.mjs dalle fixture golden dei due progetti che vendono via x402.
 *
 * Perche' un generatore e non un file scritto a mano: quei byte sono il contratto pubblico
 * indicizzato dai cataloghi x402, e devono essere IDENTICI a quelli dell'origin. Finche' il
 * modulo si scriveva a mano, "generato dalle fixture" era una promessa; adesso e' un comando.
 *
 * Sorgenti (i repo stanno tutti in ~/Documents/GitHub/, quindi percorsi fratelli):
 *   ../../GBLIN_WEBAPP/test/x402-golden/    -> 9 percorsi /api/x402/<nome>
 *   ../../GBLIN-Sentinel/test/x402-golden/  -> 4 percorsi /api/data/<nome>
 *
 * Uso:  cd worker && node tools/genera-sfide.mjs && npx wrangler deploy
 * Poi:  node verify.mjs in ENTRAMBE le cartelle golden, per confermare che bordo e origin
 *       continuano a rispondere gli stessi byte.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const qui = dirname(fileURLToPath(import.meta.url));
const WEBAPP = resolve(qui, "../../../GBLIN_WEBAPP/test/x402-golden");
const SENTINEL = resolve(qui, "../../../GBLIN-Sentinel/test/x402-golden");
const USCITA = resolve(qui, "../src/x402-challenge.mjs");

// I quattro percorsi guardati: senza questi parametri l'origin risponde 400 senza addebitare,
// e la sfida 402 la si vede solo con i parametri (fixture *.paid-params.json).
const GUARDATI = {
  quote: ["direction", "amount"],
  jit: ["usdc", "wallet"],
  invest: ["usdc", "wallet"],
  health: ["wallet"],
};

const leggi = (dir, file) => JSON.parse(readFileSync(`${dir}/${file}`, "utf8"));

function vociWebapp() {
  const nomi = ["attestation", "catalog", "governance", "seal", "treasury-state", "quote", "jit", "invest", "health"];
  return nomi.map((nome) => {
    const base = leggi(WEBAPP, `${nome}.json.json`);
    const voce = { chiave: `x402/${nome}` };
    if (GUARDATI[nome]) {
      if (base.status !== 400) throw new Error(`${nome}: attesa una guardia 400, trovato ${base.status}`);
      const pagata = leggi(WEBAPP, `${nome}.paid-params.json`);
      if (pagata.status !== 402) throw new Error(`${nome}: la fixture con parametri non e' un 402`);
      voce.requires = GUARDATI[nome];
      voce.guard400 = base.body;
      voce.challenge = pagata.body;
      voce.paymentRequired = pagata.headers["payment-required"];
    } else {
      if (base.status !== 402) throw new Error(`${nome}: attesa la sfida 402, trovato ${base.status}`);
      voce.challenge = base.body;
      voce.paymentRequired = base.headers["payment-required"];
    }
    if (!voce.paymentRequired) throw new Error(`${nome}: manca l'header payment-required nella fixture`);
    return voce;
  });
}

function vociSentinel() {
  const nomi = ["risk-pulse-pro", "base-risk-pulse", "gblin-analytics", "keeper-opps"];
  return nomi.map((nome) => {
    const base = leggi(SENTINEL, `${nome}.json.json`);
    if (base.status !== 402) throw new Error(`sentinel/${nome}: atteso 402, trovato ${base.status}`);
    if (!base.headers["payment-required"]) throw new Error(`sentinel/${nome}: manca payment-required`);
    return { chiave: `data/${nome}`, challenge: base.body, paymentRequired: base.headers["payment-required"] };
  });
}

const voci = [...vociWebapp(), ...vociSentinel()];

const corpoPaths = voci
  .map((v) => {
    const righe = [`  ${JSON.stringify(v.chiave)}: {`];
    if (v.requires) {
      righe.push(`    requires: ${JSON.stringify(v.requires)},`);
      righe.push(`    guard400: ${JSON.stringify(v.guard400)},`);
    }
    righe.push(`    challenge: ${JSON.stringify(v.challenge)},`);
    righe.push(`    paymentRequired: ${JSON.stringify(v.paymentRequired)},`);
    righe.push("  },");
    return righe.join("\n");
  })
  .join("\n");

const modulo = `// Sfide x402 ANONIME servite dal bordo, per non far partire una funzione Vercel.
//
// Perche': misurato il 22/08/2026, il 91 per cento della CPU fatturata su Vercel era il
// middleware x402 che risponde 402 a crawler e sonde (~6.000 richieste al giorno). Il
// middleware gira PRIMA della cache, quindi nessuna cache lo riduce, e su Vercel il 402
// non e' uno stato cacheabile. Una Project Routing Rule riscrive verso qui le richieste
// CHE NON PORTANO un header di pagamento; chi paga non matcha la regola e prosegue sulla
// pipeline vera, dove la verifica del pagamento resta l'unica autorita' che muove denaro.
//
// Due progetti, due famiglie di percorsi:
//  - gblin.digital            /api/x402/<nome>  (9 percorsi)
//  - gblin-sentinel.vercel.app /api/data/<nome> (4 percorsi)
// e dentro la prima famiglia due comportamenti:
//  - semplici: senza pagamento rispondono sempre la sfida 402.
//  - guardati (quote, jit, invest, health): se mancano i parametri richiesti rispondono
//    400 "nessun pagamento e' stato preso"; con i parametri rispondono la sfida 402.
//    Verificato il 22/08: la sfida NON dipende dal valore dei parametri (due quote con
//    amount diverso danno byte identici), quindi si puo' servire statica.
//
// VINCOLO: questi byte sono indicizzati dai cataloghi x402 e sono le fixture golden in
// GBLIN_WEBAPP/test/x402-golden/ e GBLIN-Sentinel/test/x402-golden/.
// FILE GENERATO — non modificarlo a mano: rigeneralo con
//   cd worker && node tools/genera-sfide.mjs
// altrimenti pubblichiamo termini diversi nei due posti. \`node verify.mjs\` se ne accorge.

const PATHS = {
${corpoPaths}
};

// Vercel, riscrivendo verso un URL esterno, inoltra il PERCORSO ORIGINALE della richiesta,
// non quello scritto nella destinazione: accettiamo sia /api/x402/... sia /x402/... (e
// altrettanto per /api/data/...), cosi' il Worker risponde anche quando lo si interroga
// direttamente. (Scoperto il 22/08 con un 404 del Worker che sembrava di Vercel.)
function nameFromPath(pathname) {
  const m = pathname.match(/^\\/(?:api\\/)?((?:x402|data)\\/[a-z0-9-]+)\\/?$/);
  return m && PATHS[m[1]] ? m[1] : null;
}

const json = (body, status, extra = {}) => new Response(body, {
  status,
  headers: {
    "content-type": "application/json",
    "cache-control": "public, max-age=60, s-maxage=300",
    "x-gblin-edge-challenge": "1",
    "access-control-allow-origin": "*",
    ...extra,
  },
});

export function x402StaticChallenge(request) {
  const url = new URL(request.url);
  const name = nameFromPath(url.pathname);
  if (!name) return null; // non e' un percorso che serviamo: decide il chiamante
  const p = PATHS[name];

  // Rete di sicurezza: se qui arrivasse una richiesta CON pagamento, NON rispondiamo la
  // sfida — sarebbe un pagante respinto. Meglio dirlo chiaramente che fingere.
  if (request.headers.get("x-payment") || request.headers.get("payment-signature")) {
    return json(JSON.stringify({
      error: "this edge path serves the unpaid challenge only; a request carrying payment must reach the origin",
    }), 421, { "cache-control": "no-store" });
  }

  // Guard: senza i parametri richiesti si risponde 400, come fa l'origin. Non e' un
  // dettaglio estetico — e' il messaggio che dice al chiamante che NON e' stato addebitato.
  if (p.requires && p.requires.some((k) => !url.searchParams.get(k))) {
    return json(p.guard400, 400);
  }

  return json(withMethod(p.challenge, request.method), 402, {
    "payment-required": headerWithMethod(p.paymentRequired, request.method),
  });
}

export const EDGE_CHALLENGE_PATHS = Object.keys(PATHS);

// L'origin ECHEGGIA il metodo della richiesta dentro la sfida, in due punti dei metadati
// Bazaar. Misurato il 22/08: fra GET e POST cambiano solo quei due campi (attestation 2369
// vs 2371 byte, governance 2187 vs 2189, treasury-state 1830 vs 1832) e le altre sfide non
// nominano affatto il metodo. Le fixture golden sono catturate in GET: qui rimettiamo il
// metodo vero, cosi' il bordo resta byte-identico all'origin anche fuori dal GET.
function withMethod(body, method) {
  if (method === "GET" || method === "HEAD") return body;
  if (!/^[A-Z]{3,10}$/.test(method)) return body; // metodo strano: meglio la sfida in GET
  return body
    .split('"method":"GET"').join('"method":"' + method + '"')
    .split('"enum":["GET"]').join('"enum":["' + method + '"]');
}

// Lo stesso echo del metodo vale per l'header payment-required, che e' il corpo della sfida
// in base64: va decodificato, sostituito e ricodificato. La sostituzione avviene sulla
// stringa binaria di atob, non sul testo decodificato in UTF-8: i due pezzi che tocchiamo
// sono ASCII puro, quindi restano intatti i byte multibyte (i trattini lunghi delle
// descrizioni) che btoa non saprebbe ricodificare.
function headerWithMethod(b64, method) {
  if (method === "GET" || method === "HEAD") return b64;
  if (!/^[A-Z]{3,10}$/.test(method)) return b64;
  let bin;
  try { bin = atob(b64); } catch { return b64; }
  const out = bin
    .split('"method":"GET"').join('"method":"' + method + '"')
    .split('"enum":["GET"]').join('"enum":["' + method + '"]');
  try { return btoa(out); } catch { return b64; }
}
`;

writeFileSync(USCITA, modulo);
console.log(`Generato ${USCITA}`);
console.log(`  ${voci.length} percorsi: ${voci.map((v) => v.chiave).join(", ")}`);
