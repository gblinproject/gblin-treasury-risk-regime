/**
 * Contatori AGGREGATI della superficie MCP gratuita.
 *
 * Perche' esiste: contiamo le chiamate PAGATE su x402 (208 in due mesi, 23 wallet) ma sulla
 * superficie GRATUITA — l'MCP, che e' la porta da cui un agente entra davvero perche' non
 * costa nulla ed e' nei registri — non contavamo NIENTE. Risultato: 2.338 installazioni del
 * pacchetto npm e zero visibilita' su quante producano una sola chiamata. Ogni risposta alla
 * domanda "quanti agenti ci usano" copriva solo la meta' a pagamento, che i crawler di
 * catalogo tengono viva da soli.
 *
 * COSA SI CONTA: il nome del metodo JSON-RPC e, per tools/call, il nome dello strumento —
 * preso dalla NOSTRA lista fissa, mai dal testo del chiamante (altrimenti chiunque potrebbe
 * scrivere chiavi arbitrarie nel contatore).
 *
 * COSA NON SI CONTA, DI PROPOSITO: nessun IP, nessun user-agent, nessun identificativo del
 * chiamante, nessun argomento, nessun orario per singola chiamata. Solo totali giornalieri
 * per chiave. Non e' un tracciamento di chi chiama: e' un conteggio di cosa viene chiamato,
 * e la differenza e' esattamente la regola che ci siamo dati sul non profilare nessuno.
 *
 * PRECISIONE DICHIARATA: i totali sono un LIMITE INFERIORE. I contatori vivono in memoria
 * nell'isolate che serve la richiesta e vengono scaricati su KV a lotti; un isolate sfrattato
 * prima dello scarico perde il suo lotto, e due scarichi simultanei possono sovrascriversi.
 * Meglio un numero onestamente approssimato per difetto che un numero preciso inventato.
 *
 * BUDGET KV: le scritture sono limitate dal numero di chiamate (nessuna chiamata, nessuna
 * scrittura) e comunque a un lotto ogni 20 secondi per isolate, che diventano 5 minuti dopo
 * 200 scarichi. Il tetto free e' 1000 scritture al giorno e ne usiamo gia' circa 600 per
 * l'osservatore delle promesse.
 */

const GIORNI_TTL = 120 * 86400;
const LOTTO_MAX = 1000;        // il lotto non forza mai la scrittura: comanda solo l'orologio
let attesaMs = 60_000;         // un lotto al minuto per isolate (con D1 il budget lo regge)
const RALLENTA_DOPO = 240;     // dopo 240 lotti si passa a 5 minuti: freno anti-fuga, non budget
const STOP_DOPO = 600;         // tetto di sicurezza per isolate, non un limite atteso

// 27/08, ORE 8 DEL MATTINO: Cloudflare ha avvisato che l'account era al 90% del tetto KV
// giornaliero. Il consumo nuovo era questo contatore, acceso ieri sera: uno scanner esterno
// enumera la superficie ogni due minuti e ogni chiamata faceva una scrittura. Il conteggio
// serve a sapere QUANTE chiamate al giorno, non a quale minuto siano arrivate: un lotto
// all'ora da' lo stesso numero al costo di 24 scritture invece di 500.
// La regola resta: i sigilli delle promesse vengono prima del contatore. Se il budget si
// stringe, si perde il conteggio, mai il sigillo.

// Misurato il 27/08: uno scanner esterno enumera la superficie ~ogni due minuti (495 chiamate
// in sette ore). A quel ritmo una scrittura per chiamata mangerebbe il tetto KV free (1000 al
// giorno) di cui ~600 servono ai sigilli delle promesse: sforare significherebbe non sigillare,
// cioe' rompere proprio la promessa che attestiamo. Il conteggio non vale quel rischio, quindi
// il contatore si strozza da solo e lo dichiara nel report.

// Elenco CHIUSO dei metodi JSON-RPC. Il 26/08 nel contatore e' comparsa la chiave
// "this/method/does/not/exist": avevo protetto i nomi dei TOOL prendendoli dalla nostra lista,
// ma i nomi dei METODI li scrivevo come arrivavano — cioe' chiunque poteva creare chiavi nuove
// all'infinito e gonfiare il documento del giorno. Fuori da questo elenco si conta "other".
const METODI = new Set([
  "initialize", "ping", "tools/list", "tools/call",
  "prompts/list", "prompts/get", "resources/list", "resources/read",
]);
export const metodoNoto = (m) => (METODI.has(m) ? m : "other");

// Misurato il 26/08 al primo collaudo: con la soglia a 10 chiamate / 10 minuti, su 12
// chiamate ne risultavano 5. Non era un errore di conteggio, era il regime sbagliato: le
// richieste si spargono su piu' isolate, nessuno riempie il lotto e nessuno vive abbastanza
// da far scadere il timer, quindi i lotti muoiono con l'isolate. A dieci chiamate al giorno
// il batching non serve: serve scrivere subito. Il lotto resta solo come protezione se un
// giorno il traffico esplode.

// Stato per-isolate. Non sopravvive allo sfratto: e' voluto e dichiarato sopra.
const buffer = new Map();
let ultimoScarico = 0;
let scarichiFatti = 0;
let inCorso = null;

export const utcDayKey = (d = new Date()) => d.toISOString().slice(0, 10);
const chiaveGiorno = (giorno) => `mcpuse:${giorno}`;

/**
 * Registra una chiamata. `strumento` viene passato SOLO se e' un nome che conosciamo.
 */
export function contaChiamata(metodo, strumento) {
  const chiave = strumento ? `${metodo}:${strumento}` : metodo;
  buffer.set(chiave, (buffer.get(chiave) || 0) + 1);
  // Un tentativo di sigillo e' raro e non deve morire con l'isolate aspettando l'orologio.
  if (CHIAVI_SEMPRE.has(chiave)) urgente = true;
}

function daScaricare() {
  if (buffer.size === 0) return false;
  let totale = 0;
  for (const n of buffer.values()) totale += n;
  return totale >= LOTTO_MAX || Date.now() - ultimoScarico >= attesaMs;
}

/**
 * Scarica il lotto su KV: una lettura + una scrittura, sulla chiave del giorno UTC.
 * Non solleva mai: un contatore non deve poter rompere una risposta.
 */
// ─── STORIA DI QUESTO CONTATORE ────────────────────────────────────────
// 27/08: Cloudflare avvisa che l'account e' al 90% del tetto KV giornaliero. Il consumo nuovo
// era questo contatore. 28/08: scritture SOSPESE, perche' il freno che avevo messo (20 scritture
// per isolate) non limitava niente — Cloudflare fa girare molti isolate, e venti ciascuno fanno
// comunque centinaia al giorno. Con KV non c'era modo di contarle globalmente senza usare... KV.
//
// 02/09/2026: RIACCESE, su un contenitore diverso. Il contatore ora scrive su **D1**, non su KV:
//   - il tetto free di D1 e' 100.000 righe scritte al giorno contro le 1.000 di KV;
//   - ed e' una QUOTA SEPARATA, quindi il contatore non puo' piu' mettere in pericolo i sigilli
//     giornalieri delle promesse, che restano su KV.
// In piu' l'UPSERT di D1 (`n = n + excluded.n`) e' ATOMICO: sparisce la perdita da scrittura
// concorrente che con KV eravamo costretti a dichiarare (leggi-modifica-scrivi).
//
// La priorita' dichiarata NON cambia: i sigilli delle promesse vengono prima del contatore.
// Semplicemente ora non sono piu' in concorrenza per la stessa quota.
//
// I giorni gia' registrati su KV (26-28/08, piu' i tentativi di sigillo dal 30/08) restano
// leggibili: il report li unisce a quelli nuovi.
const SCRITTURE_ATTIVE = true;

// ECCEZIONE STRETTA (30/08/2026). Con le scritture sospese non sapevamo se qualcuno avesse
// PROVATO a sigillare e fosse fallito: l'unica domanda che contava restava senza risposta.
// Queste due chiavi contano tentativi RARI (oggi: unita' al giorno, non centinaia come gli
// scanner), quindi passano anche a scritture sospese e costano una manciata di put. Il resto
// del traffico resta muto. La priorita' dichiarata non cambia: i sigilli delle promesse prima
// del contatore.
const CHIAVI_SEMPRE = new Set(["http:/v1/seal-demo", "tools/call:receipts.seal"]);
let urgente = false;

export async function scarica(env, forza = false) {
  if (buffer.size === 0) return;
  const db = env.USAGE;
  if (!db) return;                       // nessun D1 collegato (sviluppo locale): non si conta
  if (scarichiFatti >= STOP_DOPO) return;
  if (!SCRITTURE_ATTIVE && !urgente) return;
  if (!forza && !urgente && !daScaricare()) return;
  if (inCorso) return inCorso;

  const lotto = new Map(buffer);
  buffer.clear();
  urgente = false;
  if (lotto.size === 0) return;
  ultimoScarico = Date.now();
  if (++scarichiFatti > RALLENTA_DOPO) attesaMs = 5 * 60_000;

  inCorso = (async () => {
    try {
      const giorno = utcDayKey();
      const q = db.prepare(
        "INSERT INTO usage_daily (day,k,n) VALUES (?,?,?) " +
        "ON CONFLICT(day,k) DO UPDATE SET n = n + excluded.n",
      );
      await db.batch([...lotto].map(([k, n]) => q.bind(giorno, k, n)));
    } catch {
      // D1 giu': il lotto e' perso e il totale resta un limite inferiore, come dichiarato.
      // Non lo rimettiamo nel buffer per non farlo crescere all'infinito.
    } finally {
      inCorso = null;
    }
  })();
  return inCorso;
}

/**
 * Scarico DIFFERITO: aspetta qualche secondo e poi scrive comunque.
 *
 * Serve perche' lo scarico "all'inizio della richiesta" scrive il lotto PRECEDENTE, quindi
 * l'ultima richiesta vista da un isolate resta sempre in sospeso e muore con lui. Misurato
 * il 26/08: su 5 rotte gratuite chiamate a distanza di un secondo, ne comparivano 3.
 * Con l'attesa, ogni richiesta fa scrivere anche se ne', e le chiamate ravvicinate si fondono
 * comunque perche' il buffer e' condiviso nell'isolate.
 *
 * Il `force` vale solo finche' questo isolate ha scritto poco: oltre la soglia si torna al
 * ritmo normale, perche' il tetto KV free e' 1000 scritture al giorno e ~600 servono ai sigilli.
 */
export async function scaricoDifferito(env, ms = 2000) {
  await new Promise((r) => setTimeout(r, ms));
  return scarica(env, scarichiFatti < RALLENTA_DOPO);
}

/**
 * Report pubblico e gratuito: ultimi `giorni` giorni, per chiave.
 */
export async function usoRecente(env, giorni = 14) {
  const perGiorno = new Map();   // giorno -> { chiave: n }
  const totali = {};
  const somma = (giorno, k, n) => {
    if (!perGiorno.has(giorno)) perGiorno.set(giorno, {});
    const d = perGiorno.get(giorno);
    d[k] = (d[k] || 0) + n;
    totali[k] = (totali[k] || 0) + n;
  };
  const daGiorno = utcDayKey(new Date(Date.now() - (giorni - 1) * 86400_000));

  // Sorgente corrente: D1 (dal 02/09/2026).
  let d1ok = false;
  if (env.USAGE) {
    try {
      const r = await env.USAGE.prepare(
        "SELECT day, k, n FROM usage_daily WHERE day >= ? ORDER BY day DESC",
      ).bind(daGiorno).all();
      for (const row of r.results || []) somma(row.day, row.k, row.n);
      d1ok = true;
    } catch { d1ok = false; }
  }

  // Sorgente storica: i giorni scritti su KV prima del trasloco. Si legge, non si scrive.
  if (env.COHERENCE) {
    for (let i = 0; i < giorni; i++) {
      const giorno = utcDayKey(new Date(Date.now() - i * 86400_000));
      let doc = null;
      try { doc = JSON.parse((await env.COHERENCE.get(chiaveGiorno(giorno))) || "null"); } catch { doc = null; }
      if (!doc) continue;
      for (const [k, n] of Object.entries(doc)) somma(giorno, k, n);
    }
  }

  const righe = [...perGiorno.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([day, calls]) => ({ day, calls }));

  return {
    surface: "free surfaces: hosted MCP + the public proof endpoints (receipts, log, checkpoints, coherence)",
    window_days: giorni,
    total_calls: Object.values(totali).reduce((a, b) => a + b, 0),
    by_key: totali,
    daily: righe,
    method:
      "Aggregate counts of WHAT was called: for MCP, the JSON-RPC method plus the tool name for tools/call (taken from this server's own fixed list); for HTTP, the free proof endpoints normalised to a fixed set of paths, so an invented path cannot create a new key. Counted since 2026-08-26.",
    not_collected:
      "No IP, no user agent, no caller identity, no arguments, no per-call timestamps. This counts calls, not callers, and there is no way to attribute any of these numbers to a person or an agent.",
    history:
      "Counting ran 2026-08-26 to 2026-08-28, was then SUSPENDED because it wrote to the same KV quota the daily seals of the public promises depend on — and the seals come first. Between 2026-08-30 and 2026-09-02 only attempts to create a receipt were recorded, so totals for those days are NOT traffic totals and must not be compared with the others. Full counting resumed on 2026-09-02.",
    storage:
      "Counts are written to D1, deliberately not to KV: D1's free allowance is 100,000 written rows per day against KV's 1,000, and it is a SEPARATE quota — so the counter can no longer put the promise seals at risk. Days recorded before the move are still read from KV and merged into this report." +
      (d1ok ? "" : " WARNING: D1 did not answer for this request, so recent days may be missing here."),
    accuracy:
      "Lower bound, and less of one than before. Counters are buffered in memory per isolate and flushed in batches, so an evicted isolate still loses its batch. But the D1 upsert (n = n + excluded.n) is atomic, so concurrent flushes no longer overwrite each other — that source of undercount, which we had to declare while on KV, is gone.",
    includes_our_own_traffic:
      "Yes, and this differs from the paid counter. /api/agent-stats excludes GBLIN's own wallets from the organic totals; here there is no caller identity to exclude by, so our own checks and tests are in these numbers too. Read them as an upper bound on outside interest, not a lower one.",
    paid_surface_is_separate: "https://gblin.digital/api/agent-stats",
  };
}
