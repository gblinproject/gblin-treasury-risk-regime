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
const LOTTO_MAX = 25;          // sotto carico, tante chiamate ravvicinate = una sola scrittura
let attesaMs = 20_000;         // a basso traffico: praticamente una scrittura per chiamata
const SCARICHI_PRIMA_DI_RALLENTARE = 200; // oltre questa soglia l'isolate scrive piu' di rado

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
export async function scarica(env, forza = false) {
  if (!env.COHERENCE || buffer.size === 0) return;
  if (!forza && !daScaricare()) return;
  if (inCorso) return inCorso;

  const lotto = new Map(buffer);
  buffer.clear();
  ultimoScarico = Date.now();
  // Freno sul budget KV (tetto free 1000 scritture/giorno, ~600 gia' usate dall'osservatore
  // delle promesse): se questo isolate ha gia' scritto tanto, rallenta invece di consumarlo.
  if (++scarichiFatti > SCARICHI_PRIMA_DI_RALLENTARE) attesaMs = 5 * 60_000;

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
  return scarica(env, scarichiFatti < 150);
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
    accuracy:
      "Lower bound. Counters are buffered in memory per isolate and flushed to storage in batches; an evicted isolate loses its batch and concurrent flushes can overwrite each other. Undercounting is preferred to a precise number we could not defend.",
    includes_our_own_traffic:
      "Yes, and this differs from the paid counter. /api/agent-stats excludes GBLIN's own wallets from the organic totals; here there is no caller identity to exclude by, so our own checks and tests are in these numbers too. Read them as an upper bound on outside interest, not a lower one.",
    paid_surface_is_separate: "https://gblin.digital/api/agent-stats",
  };
}
