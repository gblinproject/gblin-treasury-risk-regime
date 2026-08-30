#!/bin/bash
# Da lanciare UNA VOLTA dopo che il founder ha ridistribuito GBLIN_WEBAPP su Vercel.
#
# PERCHE' SERVE: le sfide 402 anonime le serve il Worker al bordo, da un modulo GENERATO dalle
# fixture golden. Il 30/08/2026 abbiamo aggiunto `extensions.bazaar` alle sfide di /api/x402/seal
# e /api/x402/catalog (senza, non entravano nel catalogo Coinbase). Finche' questo script non
# gira, l'origine dice una cosa e il bordo ne dice un'altra: la dichiarazione nuova esisterebbe
# solo per chi paga, e chiunque legga la sfida in anonimo vedrebbe ancora quella vecchia.
set -e
cd "$(dirname "$0")/.."
R=~/Documents/GitHub

echo "1/4  ricattura le fixture dall'origine appena ridistribuita"
(cd "$R/GBLIN_WEBAPP/test/x402-golden" && node capture.mjs)

echo "2/4  rigenera il modulo delle sfide del bordo dalle fixture dei due repo"
node tools/genera-sfide.mjs

echo "3/4  deploy del Worker"
npx wrangler deploy

echo "4/4  controprova: bordo contro origine, byte per byte"
(cd "$R/GBLIN_WEBAPP/test/x402-golden" && node verify.mjs | tail -3)
(cd "$R/GBLIN_WEBAPP/test/x402-golden" && node verifica-metodi.mjs | tail -3)
(cd "$R/GBLIN-Sentinel/test/x402-golden" && node verify.mjs | tail -3)
echo
echo "Fatto. Se una riga sopra non dice 'identiche', NON lasciare lo stato cosi': indaga."
