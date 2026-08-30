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
let attesaMs = 3600_000;       // UNA scrittura all'ora per isolate, non di piu'
const RALLENTA_DOPO = 12;      // dopo 12 scritture (mezza giornata) si passa a 3 ore
const STOP_DOPO = 20;          // oltre 20 scritture al giorno per isolate si smette

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
// ─── SCRITTURE SOSPESE IL 28/08/2026 ────────────────────────────────────────
// Il 27/08 Cloudflare ha avvisato al 90% del tetto KV; ho messo un freno da 20 scritture
// al giorno e il 28/08 siamo andati oltre lo stesso. Il freno era sbagliato di concetto:
// contava PER ISOLATE, e Cloudflare ne fa girare molti — venti scritture ciascuno, per
// qualche decina di isolate, sono centinaia di scritture al giorno. Il tetto vero non e'
// per isolate, e con KV non c'e' modo di contarlo globalmente senza usare... KV.
//
// La priorita' e' dichiarata e non cambia: i sigilli delle promesse vengono prima del
// contatore. Un conteggio perso e' niente; un sigillo mancato romperebbe la promessa che
// attestiamo. Quindi il contatore continua ad accumulare in memoria (e /mcp/usage serve i
// giorni gia' registrati) ma NON scrive piu'.
//
// Cosa abbiamo gia' imparato e che non serve continuare a pagare: due giornate intere
// misurate, 1.031 e 1.136 chiamate, e ZERO tools/call. Il traffico e' scanner. Sapevamo
// solo questo e ci serviva solo questo.
//
// Se un giorno vorremo contare davvero, lo strumento giusto e' Analytics Engine, che non
// consuma scritture KV. Non e' una cosa da fare adesso.
const SCRITTURE_ATTIVE = false;

// ECCEZIONE STRETTA (30/08/2026). Con le scritture sospese non sapevamo se qualcuno avesse
// PROVATO a sigillare e fosse fallito: l'unica domanda che contava restava senza risposta.
// Queste due chiavi contano tentativi RARI (oggi: unita' al giorno, non centinaia come gli
// scanner), quindi passano anche a scritture sospese e costano una manciata di put. Il resto
// del traffico resta muto. La priorita' dichiarata non cambia: i sigilli delle promesse prima
// del contatore.
const CHIAVI_SEMPRE = new Set(["http:/v1/seal-demo", "tools/call:receipts.seal"]);
let urgente = false;

export async function scarica(env, forza = false) {
  if (!env.COHERENCE || buffer.size === 0) return;
  if (scarichiFatti >= STOP_DOPO) return; // budget dei sigilli prima del contatore
  if (!SCRITTURE_ATTIVE && !urgente) return;
  if (!forza && !urgente && !daScaricare()) return;
  if (inCorso) return inCorso;

  // A scritture sospese si porta via SOLO cio' che e' raro e ci serve; il rumore degli
  // scanner resta nel buffer in memoria e muore con l'isolate, come gia' oggi.
  const lotto = new Map(
    SCRITTURE_ATTIVE ? buffer : [...buffer].filter(([k]) => CHIAVI_SEMPRE.has(k)),
  );
  if (SCRITTURE_ATTIVE) buffer.clear();
  else for (const k of lotto.keys()) buffer.delete(k);
  urgente = false;
  if (lotto.size === 0) return;
  ultimoScarico = Date.now();
  // Freno sul budget KV (tetto free 1000 scritture/giorno, ~600 gia' usate dall'osservatore
  // delle promesse): se questo isolate ha gia' scritto tanto, rallenta invece di consumarlo.
  if (++scarichiFatti > RALLENTA_DOPO) attesaMs = 10 * 60_000;

  inCorso = (async () => {
    try {
      const giorno = utcDayKey();
      const k = chiaveGiorno(giorno);
      let doc = {};
      try { doc = JSON.parse((await env.COHERENCE.get(k)) || "{}"); } catch { doc = {}; }
      for (const [chiave, n] of lotto) doc[chiave] = (doc[chiave] || 0) + n;
      await env.COHERENCE.put(k, JSON.stringify(doc), { expirationTtl: GIORNI_TTL });
    } catch {
      // KV giu' o quota finita: il lotto e' perso e il totale resta un limite inferiore,
      // come dichiarato. Non lo rimettiamo nel buffer per non farlo crescere all'infinito.
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
  const oggi = new Date();
  const righe = [];
  const totali = {};
  for (let i = 0; i < giorni; i++) {
    const d = new Date(oggi.getTime() - i * 86400_000);
    const giorno = utcDayKey(d);
    let doc = null;
    try { doc = JSON.parse((await env.COHERENCE.get(chiaveGiorno(giorno))) || "null"); } catch { doc = null; }
    if (!doc) continue;
    righe.push({ day: giorno, calls: doc });
    for (const [k, n] of Object.entries(doc)) totali[k] = (totali[k] || 0) + n;
  }
  const somma = Object.values(totali).reduce((a, b) => a + b, 0);
  return {
    surface: "free surfaces: hosted MCP + the public proof endpoints (receipts, log, checkpoints, coherence)",
    window_days: giorni,
    total_calls: somma,
    by_key: totali,
    daily: righe,
    method:
      "Aggregate counts of WHAT was called: for MCP, the JSON-RPC method plus the tool name for tools/call (taken from this server's own fixed list); for HTTP, the free proof endpoints normalised to a fixed set of paths, so an invented path cannot create a new key. Counted since 2026-08-26.",
    not_collected:
      "No IP, no user agent, no caller identity, no arguments, no per-call timestamps. This counts calls, not callers, and there is no way to attribute any of these numbers to a person or an agent.",
    counting_suspended:
      "Writing was suspended on 2026-08-28. The per-isolate write cap set the day before did not bound the total: Cloudflare runs many isolates, so a cap of 20 writes each still added up to hundreds a day and pushed the account over the free KV quota — the same quota the daily seals of the public promises depend on. The seals come first. The days already recorded remain readable below.",
    still_counted:
      "One narrow exception since 2026-08-30: attempts to CREATE a receipt (http:/v1/seal-demo and tools/call:receipts.seal) are still recorded, because they are rare — units per day, not the hundreds the scanners generate — and because without them we cannot tell whether anyone tried to seal and failed. READ THIS CORRECTLY: for days from 2026-08-30 onward these two keys are the ONLY thing counted, so the totals for those days are NOT traffic totals and must not be compared with the earlier days.",
    write_budget:
      "The counter batches to at most one write per hour per isolate, then one per three hours after 12, and stops after 20 in a day. The daily seals of the public promises share the same 1000-writes/day free quota and come first: an uncounted call is a small loss, a missed seal would break the promise we attest. Counts are therefore hourly aggregates, not per-minute.",
    accuracy:
      "Lower bound. Counters are buffered in memory per isolate and flushed to storage in batches; an evicted isolate loses its batch and concurrent flushes can overwrite each other. Undercounting is preferred to a precise number we could not defend.",
    includes_our_own_traffic:
      "Yes, and this differs from the paid counter. /api/agent-stats excludes GBLIN's own wallets from the organic totals; here there is no caller identity to exclude by, so our own checks and tests are in these numbers too. Read them as an upper bound on outside interest, not a lower one.",
    paid_surface_is_separate: "https://gblin.digital/api/agent-stats",
  };
}
