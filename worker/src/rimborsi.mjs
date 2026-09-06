/**
 * REGISTRO DEI PAGAMENTI SENZA CONSEGNA.
 *
 * PERCHE' ESISTE
 * Il 05/09/2026 alle 19:00:43 UTC un operatore ha pagato 0,01 USDC per un sigillo e non ha
 * ricevuto nulla: nessuna foglia nel log, nessuna ricevuta. Non siamo stati in grado di dire
 * NEMMENO IN CHE MODO fosse fallito, perche' il percorso pagato non registrava niente. Trentotto
 * secondi dopo lo stesso indirizzo ha pagato un altro endpoint: non se n'era andato, stava
 * provando. Quello che gli dovevamo era un rimborso e una spiegazione, e non avevamo ne' l'uno
 * ne' l'altra.
 *
 * La ricerca presentata a USENIX Security 35 (agosto 2026) dice ai venditori x402 di fare una di
 * due cose: trattenere il servizio finche' il regolamento non riesce, OPPURE tenere un modo per
 * annullare quando il pagamento fallisce. La prima meta' ce l'abbiamo, e ce l'abbiamo per merito
 * della libreria. Questa e' la seconda.
 *
 * IL PROBLEMA DI PRIVACY, DICHIARATO
 * La nostra regola e' contare COSA viene chiamato, mai CHI. Qui l'indirizzo del pagante lo
 * scriviamo: senza di quello non si puo' restituire il denaro. Percio' questo NON e' un contatore
 * ed e' tenuto separato da quelli:
 *   - si scrive SOLO quando un pagamento e' stato incassato e non e' stata consegnata la cosa;
 *   - contiene solo cio' che serve a rimborsare: pagante, nonce, importo, asset, rete, percorso,
 *     motivo, quando. Nessun argomento della chiamata, nessun corpo, nessun contenuto;
 *   - NON e' pubblico. In pubblico esce solo il CONTEGGIO e il totale dovuto, mai gli indirizzi:
 *     chi ha diritto a un rimborso non ha nessun bisogno di comparire in un elenco;
 *   - il nonce e' la chiave primaria, quindi un ritentativo dello stesso pagamento non crea due
 *     righe. Il nonce e' anche cio' che rende la voce verificabile da fuori: USDC su Base emette
 *     AuthorizationUsed(authorizer, nonce) al regolamento, quindi il pagante puo' dimostrare da
 *     solo che quel pagamento e' suo.
 *
 * Il rimborso lo manda una persona, non questo codice: qui si registra il debito.
 */

const MOTIVI_RIMBORSO = new Set([
  "json",      // corpo non interpretabile
  "schema",    // corpo valido come JSON ma rifiutato dal validatore
  "metodo",    // pagato su un metodo che quella rotta non serve
  "upstream",  // il servizio a valle non ha risposto o ha risposto male
  "config",    // manca una configurazione nostra
  "internal",  // qualunque altra cosa: non si inventa una categoria
]);

/**
 * Registra un pagamento incassato senza consegna. Silenziosa in caso di guasto del database:
 * un errore qui non deve trasformare un fallimento in DUE fallimenti per chi ha pagato.
 *
 * @returns true se la riga e' stata scritta (o esisteva gia'), false se non si e' potuto
 */
export async function registraRimborso(env, d) {
  if (!env?.USAGE || !d?.nonce || !d?.payer) return false;
  const motivo = MOTIVI_RIMBORSO.has(d.motivo) ? d.motivo : "internal";
  try {
    await env.USAGE.prepare(
      "INSERT INTO rimborsi_dovuti (nonce,payer,importo,asset,rete,percorso,motivo,visto_a) " +
      "VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(nonce) DO NOTHING",
    ).bind(
      String(d.nonce), String(d.payer), d.importo ?? null, d.asset ?? null,
      d.rete ?? null, d.percorso ?? null, motivo, new Date().toISOString(),
    ).run();
    return true;
  } catch {
    return false;
  }
}

/**
 * Quanto dobbiamo, in pubblico. Conteggi e motivi, MAI indirizzi.
 */
export async function riepilogoRimborsi(env) {
  const vuoto = {
    what: "payments we took without delivering. Counts only: the addresses owed a refund are " +
          "deliberately not published — see src/rimborsi.mjs for why.",
    open: null, refunded: null, by_reason: {}, note: "ledger unavailable",
  };
  if (!env?.USAGE) return vuoto;
  try {
    const r = await env.USAGE.prepare(
      "SELECT motivo, COUNT(*) n, SUM(CASE WHEN rimborsato_tx IS NULL THEN 1 ELSE 0 END) aperti " +
      "FROM rimborsi_dovuti GROUP BY motivo",
    ).all();
    const per = {}; let aperti = 0, tot = 0;
    for (const x of r.results ?? []) { per[x.motivo] = x.n; aperti += x.aperti; tot += x.n; }
    return {
      what: vuoto.what,
      open: aperti,
      refunded: tot - aperti,
      by_reason: per,
      how_to_claim: "If you paid and received nothing, quote your EIP-3009 nonce to gblin.digital. " +
                    "The nonce is provable on-chain: USDC on Base emits AuthorizationUsed(authorizer, nonce) " +
                    "in the settlement transaction.",
    };
  } catch {
    return vuoto;
  }
}
