// Command witness-vectors generates the test vectors for the c2sp.org/tlog-witness
// add-checkpoint endpoint. Trees, consistency proofs and signed notes are produced with the
// reference Go implementation (golang.org/x/mod/sumdb/tlog and sumdb/note), independently of
// the code under test. All keys are derived from fixed labels and are used only by the tests.
//
//	go run . > vectors.json
package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"golang.org/x/mod/sumdb/note"
	"golang.org/x/mod/sumdb/tlog"
)

const origin = "example.test/log"
const witnessName = "gblin.digital/witness"

type Step struct {
	Name         string `json:"name"`
	Method       string `json:"method"`
	Path         string `json:"path"`
	Body         string `json:"body,omitempty"`
	Status       int    `json:"status"`
	ExpectBody   string `json:"expectBody,omitempty"`
	ExpectType   string `json:"expectType,omitempty"`
	CosignedText string `json:"cosignedText,omitempty"` // note text the 200 line must cosign
	ExpectSize   int64  `json:"expectSize,omitempty"`   // for GET checkpoint: size in the returned note
}

type Vectors struct {
	WitnessKey  string `json:"witnessKey"` // "<hex seed>:<hex pub>" (test key, never deployed)
	WitnessPub  string `json:"witnessPub"`
	WitnessVkey string `json:"witnessVkey"`
	Origin      string `json:"origin"`
	OriginHash  string `json:"originHash"`
	LogVkey     string `json:"logVkey"`
	NetCfg      string `json:"netcfg"` // value of KV key witness:netcfg
	Steps       []Step `json:"steps"`
	// RaceBodies are sent concurrently, all with old = RaceOld; exactly one must get 200
	RaceOld    int64    `json:"raceOld"`
	RaceBodies []string `json:"raceBodies"`
	RaceSizes  []int64  `json:"raceSizes"`
}

type detReader struct{ b []byte }

func (r *detReader) Read(p []byte) (int, error) { n := copy(p, r.b); r.b = r.b[n:]; return n, nil }

func seed(label string) []byte { s := sha256.Sum256([]byte(label)); return s[:] }

type tree struct {
	hashes map[int64]tlog.Hash
	n      int64
}

func newTree(prefix string, n int) *tree {
	t := &tree{hashes: map[int64]tlog.Hash{}}
	for i := 0; i < n; i++ {
		hs, err := tlog.StoredHashes(t.n, []byte(fmt.Sprintf("%s-%d", prefix, i)), t)
		must(err)
		base := tlog.StoredHashCount(t.n)
		for j, h := range hs {
			t.hashes[base+int64(j)] = h
		}
		t.n++
	}
	return t
}
func (t *tree) ReadHashes(idx []int64) ([]tlog.Hash, error) {
	out := make([]tlog.Hash, len(idx))
	for i, x := range idx {
		h, ok := t.hashes[x]
		if !ok {
			return nil, fmt.Errorf("missing %d", x)
		}
		out[i] = h
	}
	return out, nil
}
func (t *tree) root(n int64) tlog.Hash {
	if n == 0 {
		return sha256.Sum256(nil)
	}
	h, err := tlog.TreeHash(n, t)
	must(err)
	return h
}
func (t *tree) proof(oldN, newN int64) []string {
	p, err := tlog.ProveTree(newN, oldN, t)
	must(err)
	// self-check with the reference implementation
	must(tlog.CheckTree(p, newN, t.root(newN), oldN, t.root(oldN)))
	out := []string{}
	for _, h := range p {
		out = append(out, base64.StdEncoding.EncodeToString(h[:]))
	}
	return out
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func ckText(o string, n int64, root tlog.Hash, ext ...string) string {
	s := fmt.Sprintf("%s\n%d\n%s\n", o, n, base64.StdEncoding.EncodeToString(root[:]))
	for _, e := range ext {
		s += e + "\n"
	}
	return s
}

func signNote(text string, signers ...note.Signer) string {
	b, err := note.Sign(&note.Note{Text: text}, signers...)
	must(err)
	return string(b)
}

func body(old int64, proof []string, checkpoint string) string {
	s := fmt.Sprintf("old %d\n", old)
	for _, p := range proof {
		s += p + "\n"
	}
	return s + "\n" + checkpoint
}

func gen() Vectors {
	// deterministic log key and test witness key
	skey, vkey, err := note.GenerateKey(&detReader{seed("interop log key")}, origin)
	must(err)
	signer, err := note.NewSigner(skey)
	must(err)
	verifier, err := note.NewVerifier(vkey)
	must(err)
	_ = verifier
	// same name, different key (different key ID): its lines are ignored
	skey2, _, err := note.GenerateKey(&detReader{seed("interop rogue key")}, origin)
	must(err)
	rogue, _ := note.NewSigner(skey2)
	// an origin the witness does not know
	skey3, _, err := note.GenerateKey(&detReader{seed("interop other log")}, "other.test/log")
	must(err)
	other, _ := note.NewSigner(skey3)
	// a foreign key with a different name: its lines are ignored
	skey4, _, err := note.GenerateKey(&detReader{seed("interop foreign")}, "foreign.test/witness")
	must(err)
	foreign, _ := note.NewSigner(skey4)

	wseed := seed("interop witness key")
	wpriv := ed25519.NewKeyFromSeed(wseed)
	wpub := wpriv.Public().(ed25519.PublicKey)
	kh := sha256.Sum256(append([]byte(witnessName+"\n\x04"), wpub...))
	wvkey := fmt.Sprintf("%s+%s+%s", witnessName, hex.EncodeToString(kh[:4]), base64.StdEncoding.EncodeToString(append([]byte{0x04}, wpub...)))

	t := newTree("leaf", 40)
	fork := newTree("fork", 40)
	ck := func(n int64, ext ...string) (string, string) {
		txt := ckText(origin, n, t.root(n), ext...)
		return txt, signNote(txt, signer)
	}
	hashB64 := base64.StdEncoding.EncodeToString(make([]byte, 32))

	var steps []Step
	add := func(s Step) {
		if s.Method == "" {
			s.Method = "POST"
			s.Path = "/witness/add-checkpoint"
		}
		steps = append(steps, s)
	}
	_, n5 := ck(5)
	t5, _ := ck(5)

	// malformed requests: 400
	add(Step{Name: "old with leading zero", Body: body(0, nil, n5)[:4] + "00\n\n" + n5, Status: 400})
	add(Step{Name: "old negative", Body: "old -1\n\n" + n5, Status: 400})
	add(Step{Name: "old missing", Body: "\n\n" + n5, Status: 400})
	add(Step{Name: "old with plus sign", Body: "old +0\n\n" + n5, Status: 400})
	add(Step{Name: "no blank line", Body: "old 0\n" + strings.Replace(n5, "\n\n", "\n", 1), Status: 400})
	many := make([]string, 64)
	for i := range many {
		many[i] = hashB64
	}
	add(Step{Name: "64 proof lines", Body: body(0, many, n5), Status: 400})
	nonCanon := hashB64[:42] + "B="
	add(Step{Name: "non-canonical base64 proof line", Body: body(0, []string{nonCanon}, n5), Status: 400})
	add(Step{Name: "31-byte proof line", Body: body(0, []string{base64.StdEncoding.EncodeToString(make([]byte, 31))}, n5), Status: 400})
	add(Step{Name: "unpadded proof line", Body: body(0, []string{strings.TrimRight(hashB64, "=")}, n5), Status: 400})
	add(Step{Name: "size with leading zero", Body: body(0, nil, signNote(strings.Replace(t5, "\n5\n", "\n05\n", 1), signer)), Status: 400})
	r5 := t.root(5)
	badRoot := base64.StdEncoding.EncodeToString(r5[:])
	badRoot = badRoot[:42] + string(badRoot[42]^1) + "="
	if _, err := base64.StdEncoding.Strict().DecodeString(badRoot); err == nil {
		// the last character must carry non-zero padding bits
		panic("expected a non-canonical root encoding")
	}
	add(Step{Name: "non-canonical root", Body: body(0, nil, signNote(origin+"\n5\n"+badRoot+"\n", signer)), Status: 400})
	add(Step{Name: "checkpoint without final newline", Body: body(0, nil, strings.TrimSuffix(n5, "\n")), Status: 400})
	add(Step{Name: "extension line added after signing", Body: body(0, nil, strings.Replace(n5, t5, t5+"ext\n", 1)), Status: 403})

	// origin and signatures
	add(Step{Name: "unknown origin", Body: body(0, nil, signNote(ckText("other.test/log", 5, t.root(5)), other)), Status: 404})
	add(Step{Name: "only a rogue key with the same name", Body: body(0, nil, signNote(t5, rogue)), Status: 403})
	add(Step{Name: "only a foreign key", Body: body(0, nil, signNote(t5, foreign)), Status: 403})
	// a line with the trusted name and key ID whose signature does not verify, next to a valid one
	good := signNote(t5, signer)
	sigLine := strings.TrimSuffix(good[len(t5)+1:], "\n")
	parts := strings.SplitN(sigLine, " ", 3)
	raw, _ := base64.StdEncoding.DecodeString(parts[2])
	raw[10] ^= 1
	broken := parts[0] + " " + parts[1] + " " + base64.StdEncoding.EncodeToString(raw)
	add(Step{Name: "trusted key line that fails to verify", Body: body(0, nil, t5+"\n"+sigLine+"\n"+broken+"\n"), Status: 403})

	// order of the checks, and state
	_, n3 := ck(3)
	add(Step{Name: "old larger than size", Body: body(5, nil, n3), Status: 400})
	add(Step{Name: "old differs from held size (none held)", Body: body(3, t.proof(3, 5), n5), Status: 409, ExpectBody: "0\n", ExpectType: "text/x.tlog.size"})
	zeroBad := ckText(origin, 0, t.root(5))
	add(Step{Name: "size 0 with non-empty root", Body: body(0, nil, signNote(zeroBad, signer)), Status: 422})
	add(Step{Name: "proof with old 0", Body: body(0, []string{hashB64}, n5), Status: 422})
	t0, n0 := ck(0)
	add(Step{Name: "size 0 with empty root", Body: body(0, nil, n0), Status: 200, CosignedText: t0})
	add(Step{Name: "monitoring after size 0", Method: "GET", Path: "/witness/" + originHash() + "/checkpoint", Status: 200, ExpectSize: 0})
	add(Step{Name: "first checkpoint size 5", Body: body(0, nil, n5), Status: 200, CosignedText: t5})
	t7, n7 := ck(7)
	add(Step{Name: "stale old 0", Body: body(0, nil, n7), Status: 409, ExpectBody: "5\n", ExpectType: "text/x.tlog.size"})
	add(Step{Name: "wrong proof (5->8 sent for 5->7)", Body: body(5, t.proof(5, 8), n7), Status: 422})
	p57 := t.proof(5, 7)
	add(Step{Name: "truncated proof", Body: body(5, p57[:len(p57)-1], n7), Status: 422})
	add(Step{Name: "empty proof for growth", Body: body(5, nil, n7), Status: 422})
	add(Step{Name: "extra proof line", Body: body(5, append(append([]string{}, p57...), hashB64), n7), Status: 422})
	forkTxt := ckText(origin, 5, fork.root(5))
	add(Step{Name: "same size, different root (fork)", Body: body(5, nil, signNote(forkTxt, signer)), Status: 422})
	add(Step{Name: "same size, same root, non-empty proof", Body: body(5, []string{hashB64}, n5), Status: 422})
	add(Step{Name: "same size, same root", Body: body(5, nil, n5), Status: 200, CosignedText: t5})
	add(Step{Name: "growth 5 -> 7", Body: body(5, p57, n7), Status: 200, CosignedText: t7})
	t8, n8 := ck(8)
	add(Step{Name: "growth 7 -> 8", Body: body(7, t.proof(7, 8), n8), Status: 200, CosignedText: t8})
	t13, n13 := ck(13)
	add(Step{Name: "growth 8 -> 13 (old is a power of two)", Body: body(8, t.proof(8, 13), n13), Status: 200, CosignedText: t13})
	t20 := ckText(origin, 20, t.root(20), "extension line one", "ext-2")
	n20 := signNote(t20, signer, foreign)
	add(Step{Name: "growth 13 -> 20 with extension lines and a foreign signature", Body: body(13, t.proof(13, 20), n20), Status: 200, CosignedText: t20})
	add(Step{Name: "rollback attempt 20 -> 13", Body: body(20, nil, n13), Status: 400})
	add(Step{Name: "old 13 after 20 is held", Body: body(13, t.proof(13, 20), n20), Status: 409, ExpectBody: "20\n", ExpectType: "text/x.tlog.size"})
	add(Step{Name: "monitoring endpoint", Method: "GET", Path: "/witness/" + originHash() + "/checkpoint", Status: 200, ExpectSize: 20})
	add(Step{Name: "monitoring endpoint, unknown origin", Method: "GET", Path: "/witness/" + strings.Repeat("ab", 32) + "/checkpoint", Status: 404})

	// concurrent requests that all carry old 20
	raceSizes := []int64{21, 25, 30, 33, 40}
	var raceBodies []string
	for _, s := range raceSizes {
		_, ns := ck(s)
		raceBodies = append(raceBodies, body(20, t.proof(20, s), ns))
	}

	cfg, _ := json.Marshal(map[string]any{origin: map[string]any{"vkey": vkey, "qpd": nil, "contact": nil, "addedAt": "2000-01-01T00:00:00.000Z", "list": "test"}})
	return Vectors{
		WitnessKey:  hex.EncodeToString(wseed) + ":" + hex.EncodeToString(wpub),
		WitnessPub:  hex.EncodeToString(wpub),
		WitnessVkey: wvkey,
		Origin:      origin,
		OriginHash:  originHash(),
		LogVkey:     vkey,
		NetCfg:      string(cfg),
		Steps:       steps,
		RaceOld:     20,
		RaceBodies:  raceBodies,
		RaceSizes:   raceSizes,
	}
}

func originHash() string { h := sha256.Sum256([]byte(origin)); return hex.EncodeToString(h[:]) }

func main() {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", " ")
	must(enc.Encode(gen()))
}
