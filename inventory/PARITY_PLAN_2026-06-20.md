# Plan de décomposition de parité — agentic-ai (stratégie "full alignment")

**Date:** 2026-06-20
**Auteur:** agent de synthèse + critique de complétude
**Sources:** 5 analyses de capacité (memory, codebase, prd, reasoning, orchestration) + vérifications file:line ce jour
**Stratégie retenue (choix user):** full alignment — porter/réconcilier vers parité complète, pas seulement la surface MCP.

---

## 0. Décisions tranchées (2026-06-20) — actées par user

> ✅ **D1 ACTÉE DÉFINITIVEMENT (2026-06-20, 2e passe user, confirmée ce jour) — SURCHARGE le bloc D1 v1 ci-dessous, qui devient pure trace de raisonnement.** Le user a tranché après la réserve zététique : **GARDER le moteur Rust** (automatised-pipeline v0.5.0), car le backport/catch-up vers l'écosystème cortex devient alors **mince** (le moteur est déjà à parité). La **seule obligation dure = conformité Anthropic** (form « Built with Node.js ») ; l'objectif = agentic-ai **100% fonctionnel + ISO cortex**. **Réalisation :** une **surface MCP Node.js mince** (l'adapter `packages/codebase` forward déjà le JSON-RPC au binaire) + le **binaire Rust statique embarqué dans le `.mcpb`** (`entry_point` Node, pattern **esbuild/swc/napi** → « Built with Node.js » est satisfait par le serveur MCP Node, pas par l'absence de binaire natif). **Pas de port complet Rust→TS.** Le fork `codebase-rust` v0.0.4 est **retiré** (moteur = automatised-pipeline v0.5.0 directement) ; iso-fonctionnel trivial. **Effort codebase ~12-26 sp → ~2-5 sp** → total monorepo **~18-35 sp ≈ 4-8 mois-pers** (dans la cible). **RÉSERVE** (à confirmer à la soumission, non bloquant) : qu'Anthropic accepte un serveur Node embarquant un binaire natif — avis : oui (précédent esbuild/swc). **STATUT : ACTÉE définitivement par user (2026-06-20) — exécution autorisée.** Le bloc D1 v1 ci-dessous est conservé comme trace de raisonnement (et CB-2/3/4/5/6 + D6 restent obsolètes/morts dans les deux variantes).

**Loi de surface VÉRIFIÉE (source réelle identifiée).** La règle « livrable Directory = Node/TS » n'est PAS l'axiome non-sourcé que la critique de complétude (§ ligne 175-176) prétendait, ni attribuable à « EULER partner reco » (EULER = outil du programme partenaire : agreements/deals/commissions, sans rapport). Sa source réelle = le formulaire **« MCPB Desktop Extensions Submission »** d'Anthropic, Requirements : *« Publicly on GitHub · MIT · **Built with Node.js** · author→profil GitHub »* (établi session 2026-06-19, recall Cortex ; réaffirmé user 2026-06-20). Les verdicts « gap » sur surface non-Node sont donc fondés.

- **D1 [codebase] → TS/Node, PAS Rust — exception native RÉVOQUÉE par user.** Le moteur/store codebase doit converger vers TS/Node pour être Directory-éligible (« Built with Node.js »). Ni (a) re-sync du fork Rust ni (b) garder automatised-pipeline ne conviennent (les deux restent du Rust). → **codebase devient un PORT Rust→TS/Node complet** : moteur property-graph en TS (tree-sitter via bindings Node/WASM, graph store TS, recherche TS en remplacement de Tantivy). **Plus gros chantier unique du monorepo.**
  - **RÉSERVE zététique (surface, ne tranche pas la décision user) :** un binaire Rust STATIQUE est techniquement auto-suffisant dans un `.mcpb` (mémoire vérifiée 2026-06-19 : « binaire Rust statique OK » — contrairement à Python/Node qui exigent le runtime hôte). « Built with Node.js » est donc une contrainte de POLITIQUE/conformité au formulaire, pas de faisabilité. Le port TS coûte ~3-6 mois-pers seul et n'achète PAS de capacité — il achète la conformité. Décision user assumée ; réserve documentée pour traçabilité.
  - **Conséquences backlog :** CB-1 résolu (= port TS). **CB-2 / CB-3 / CB-4 OBSOLÈTES** (supposaient un re-sync du fork Rust v0.5.0 — abandonné). **CB-6 RECLASSÉ → DIFFÉRÉ** : il ajoutait des tests de parité sur l'adapter Rust v0.0.4 qui va être REMPLACÉ → travail jetable. **CB-5/D6 → non-issue** (le bridge cross-repo Rust disparaît avec le port). Le nouveau chantier codebase = un sous-projet dédié (port complet), pas une réconciliation de fork.
  - **Reco séquencement :** stager le port codebase comme **phase dédiée APRÈS** memory (M2) / prd / orchestration — il domine le calendrier. Ship memory + prd + orchestration au Directory d'abord ; codebase TS suit en chantier parallèle long.
- **D2 [prd] → rapatrier dans le monorepo `@agentic/prd-*`.** Sens du backport = prd-spec-generator v0.4.0 → `@agentic/prd-*`, publier depuis le monorepo. PRD-BOUNDED-IO + PRD-GROUNDING-STEP2 conservés, direction vers le monorepo (archiver le repo partenaire après rapatriement).
- **D3 [orchestration] → `@anthropic-ai/claude-agent-sdk`** (spawn MCP stdio natif, correspond au data-model `command`/`args`). **G-ORCH-06 DROPPÉ** (pas de client stdio maison). G-ORCH-03 = effort **L** (pas XL). SDK à installer (absent du disque).
- **D4 [reasoning] → retirer le bloc `mcpServers`** du plugin reasoning (ne livrer que les 97 genius + 19 team comme agents/skills). **REASON-4 (chemin backend fantôme) DISPARAÎT**, REASON-2 résolu. Reste REASON-3 (aligner les 3 versions divergentes — 1 edit trivial).

**Décisions légères restantes :** D5 (version reasoning autoritaire, 1 edit) · D6 (résolu non-issue par D1) · D7 (scoping connection-rooted memory — à trancher au moment de MEM-G7).

**Impact effort net :** D3/D4 descopent (G-ORCH-06 droppé, REASON-4 disparaît) MAIS D1 UPSCOPE massivement (port Rust→TS complet remplace un re-sync conditionnel). L'estimation §Réserves (22-53 sp) est à RÉVISER À LA HAUSSE pour codebase : le port complet ≈ 12-26 sp seul (vs CB-2/3/4 ≈ 4,5-12 sp). Nouveau total indicatif ≈ **30-65 sp ≈ 7-15 mois-pers** ; tenir « 4-9 mois » calendaires EXIGE de paralléliser (≥2 ETP) ET de stager codebase comme chantier de fond.

---

## 1. Tableau de bord parité

| Capacité | Verdict | Maturité | # gaps port-work | # décisions user bloquantes | Note |
|---|---|---|---|---|---|
| **memory** | **PASS** (au freeze v3.15.0) · backlog incrémental OUVERT | mature (99 427 LOC) | 6 (MEM-G1..G6) | 1 (MEM-G7) | Parité honorée au gel ed33435; 7 commits feat(memory/gate) post-gel non portés. Delta incrémental, **pas** une régression. |
| **codebase** | **PARTIAL** | mature (adapter 1 361 LOC + fork Rust v0.0.4) | 3 fermes (CB-6) + 3 conditionnels (CB-2/3/4) | 2 (CB-1, CB-5) | Adapter TS == fork v0.0.4 prouvé; fork lag source v0.5.0 (−1 tool, −8 parsers, −ZERA, −bridge). TS-vs-source NON prouvé. |
| **prd** | **PARTIAL** | mature (17 943 LOC) | 2 (PRD-GROUNDING, PRD-BOUNDED-IO) | 1 (PRD-DEDUP-RULING) | Byte-identique au rename près; canonical v0.4.0 ahead de 2 bundles (grounding étape-2, bounded-io). |
| **reasoning** | **N-A-by-design** (faux chantier de port) | absent-by-design (src 132 LOC) | 0 vrais + 1 hygiène (voir réserves) | 3 (REASON-2/3/4) | 97 genius + 19 team = agents/skills, jamais des tools MCP. Le "serveur MCP reasoning" est une 3e surface mémoire dupliquée. |
| **orchestration** | **FAIL** (skeleton, net-new, pas d'upstream) | skeleton (132 LOC, 0 caller, 0 test) | 3–4 (G-ORCH-02/03/04 [+06 cond.]) | 2 (G-ORCH-01, G-ORCH-05) | Maturité fonctionnelle, pas parité. Docstring contredit le SDK (mcp_servers = url-only). |

**Lecture globale:** une seule capacité est à parité honorée (memory, au gel). Deux sont à PARTIAL bloquées sur une décision de canonicité (codebase, prd). Une est un faux chantier de port (reasoning) avec de la dette d'hygiène. Une est un net-new immature (orchestration) qui n'a pas d'upstream et se mesure en maturité fonctionnelle, pas en parité.

---

## 2. Décisions USER bloquantes

Sept décisions, ordonnées par criticité (combien de travail elles débloquent). **Tant qu'une décision n'est pas tranchée, son travail aval reste indéterminé** (le sens du port — A→B ou B→A — n'est pas connu).

### D1 — [codebase] Canonicité du moteur Rust (CB-1) — BLOQUE CB-2/CB-3/CB-4
> **Quel artefact est le moteur codebase canonique à long terme ?**
> (a) re-synchroniser le fork `codebase-rust` v0.0.4 → source `automatised-pipeline` v0.5.0 (gagne `index_history` + 8 parsers + crate ZERA + bridge cross-repo), puis archiver la source en Phase 6 ; **ou**
> (b) garder `automatised-pipeline` v0.5.0 comme produit livré survivant et retirer `codebase-rust`.
>
> **Reco evidence-based:** Phase0 (ligne 67) recommande « ship depuis automatised-pipeline MAINTENANT ; re-sync codebase-rust avant tout cutover d'archivage » — mais le cutover lui-même n'est pas tranché.
> **Bloque:** CB-2 (tool index_history), CB-3 (8 parsers), CB-4 (re-capture golden v0.5.0). Si (b) → ces 3 items deviennent quasi-nuls (la source les expose déjà).

### D2 — [prd] Dedup ruling : quel arbre survit (PRD-DEDUP-RULING) — BLOQUE PRD-GROUNDING + PRD-BOUNDED-IO
> **Ship depuis `prd-spec-generator` v0.4.0 (déjà ahead, packaging .mcpb complet) en archivant `packages/prd-pipeline`+`plugins/prd` ? OU rapatrier le code partenaire DANS le monorepo sous `@agentic/prd-*` et publier de là ?**
>
> Les 2 arbres sont **byte-identiques au rename près**. Le seul choix = quel arbre devient canonique. `gh release list` partenaire = VIDE → aucune contrainte de publication ne force un côté.
> **Reco evidence-based:** garder le partenaire (déjà ahead + packaging complet) — mais arbitrage canonicité/marketplace, pas d'ingénierie.
> **Bloque:** le SENS du backport des 2 bundles (grounding étape-2, bounded-io). Le travail est le même volume des deux côtés, mais sa direction est indéterminée tant que non tranché.

### D3 — [orchestration] Substrat hôte SDK (G-ORCH-01) — BLOQUE G-ORCH-03/05/06
> **Quel substrat pour l'hôte Phase 6 ?**
> (a) `@anthropic-ai/claude-agent-sdk` (surface "agents" recommandée partenaire) : spawn natif de serveurs MCP **stdio locaux** — correspond au data-model `command`/`args` existant — et exécute la boucle agent ; **ou**
> (b) `@anthropic-ai/sdk` messages API brut + `mcp_servers` beta : supporte **uniquement** des connecteurs `url` distants (`BetaRequestMCPServerURLDefinition`, vérifié messages.d.ts:1388 `type:'url'`). Les 4 serveurs configurés sont tous stdio locaux → (b) force soit un client MCP stdio maison + tool-bridge (G-ORCH-06, XL), soit exposer chaque serveur en HTTP.
>
> **Bloque:** toute la forme du wiring + la survie du type `McpServerConfig` + G-ORCH-06 (qui n'existe que si (b)). **Aucun code de wiring ne doit être écrit avant.**

### D4 — [reasoning] Sort du 3e serveur mémoire (REASON-2) — BLOQUE/ANNULE REASON-4
> **Le serveur MCP du plugin reasoning** (identity hardcodée `memory-mcp-server`, 2 tools `memory`/`memory_extensions` délégant à `memory-tool.sh`) **crée une 3e surface mémoire** en concurrence de la capacité memory canonique (~48 tools).
> (a) Retirer entièrement le bloc mcpServers du plugin reasoning, ne livrer que les agents/skills (97 genius + 19 team) ; **ou**
> (b) le garder comme surface mémoire "lite" distincte (contrat Anthropic `memory_20250818` vs cortex hypermnesia) et documenter pourquoi 3 surfaces coexistent.
> **Si (a):** REASON-4 (chemin backend fantôme 8-niveaux) **disparaît**. Si (b): REASON-4 doit être corrigé (voir réserves — c'est un défaut de correctness, pas seulement une décision).

### D5 — [reasoning] Version autoritaire (REASON-3)
> **3 versions divergentes à HEAD:** `plugin.json`=0.0.5, `package.json`+`marketplace.json`=2.13.1, `mcp-servers/reasoning/package.json`=0.1.0. **Quelle est la version autoritaire ?** Décision + 1 edit trivial (aligner les 3 fichiers). Aucun mécanisme de sync n'existe.

### D6 — [codebase] Périmètre du bridge cross-repo / ZERA (CB-5)
> **ZERA** (crate 1038 LOC, BLAKE3+zstd) est de l'infra wire-protocol interne — **0 mention dans tool_schemas.rs**, donc **zéro travail TS** pour la parité de surface (non-issue surface). Le **bridge** ajoute des champs optionnels (`sibling graph paths`) à 3 tools existants (`get_symbol`/`get_impact`/`search`), sans nouveau nom de tool.
> **Question:** le port TS doit-il exposer ces champs optionnels ? Si oui → S port-work (3 champs Zod optionnels). Si la fédération cross-repo est hors-scope du monorepo consolidé → non-issue.

### D7 — [memory] Scoping connection-rooted (MEM-G7)
> Cortex a ajouté `CORTEX_ROOT_AGENT_TOPIC` (rootage du scoping sur une connexion-racine du graphe de topics, 216 ins). **Le port TS adopte-t-il ce mécanisme ou garde-t-il le modèle `agent_topic` plat actuel ?**
> Si adopté → reclasser **port-work effort S** (porter recall/remember + memory-config). Si divergence voulue → non-issue documenté. C'est un choix d'architecture de scoping mémoire, pas un pur portage mécanique.

**Décisions à trancher EN PREMIER (débloquent le plus de travail aval):** **D1 (codebase), D2 (prd), D3 (orchestration)** — ces trois gèlent respectivement 3, 2 et 3 items de port-work. D4 ferme un faux chantier et débloque l'hygiène reasoning. D5/D6/D7 sont des arbitrages légers (1 edit / S port-work / reclassement).

---

## 3. Backlog d'ingénierie priorisé

Tous les gaps "port-work", fusionnés, séquencés par dépendances PUIS par ratio valeur/effort. **`[cond:Dx]`** = conditionnel à la décision user Dx.

| Ordre | id | capacité | titre | effort | dépendances | critère de validation (test parity) |
|---|---|---|---|---|---|---|
| 1 | G-ORCH-02 | orchestration | Remplacer le modèle stale `claude-opus-4-5` (src:130) | S | — (indépendant de D3) | `grep claude-opus-4-5 src/` = 0 + `pnpm -F @agentic/orchestrator typecheck` vert ; modèle courant avec `// source:` lineup Anthropic. |
| 2 | CB-6 | codebase | 4 tools wirés sans test parity (getSymbol, resolveGraph, abortVerification, preparePrdInput) | S | — (indépendant de D1, ferme un trou sur baseline v0.0.4) | Les 23 méthodes du port exercées par ≥1 `*.parity.test.ts` (3 goldens existent déjà ; capturer `resolve_graph`). |
| 3 | MEM-G4 | memory | `include_related` — inline relation-walk recall mode | S | — | Fixture `recall/` avec `include_related=true` ; parity-runner diff TS vs expected (relation-walk inlined), tolérance MASKING.md. |
| 4 | MEM-G5 | memory | Hierarchical write-gate derrière flag `CORTEX_MEMORY_WRITE_GATE_HIERARCHICAL` | S | — (fonction `hierarchicalGateDecision` déjà présente, wiring/flag absent) | Bench gate-precision flat vs hierarchical ; flag unset → score byte-identique au mode flat (régression-guard recall.parity). |
| 5 | MEM-G7 | memory | Scoping `CORTEX_ROOT_AGENT_TOPIC` | S | **[cond:D7=adopté]** | Si adopté: parity recall/remember scoping sur connexion-racine. Si non: non-issue documenté. |
| 6 | MEM-G1 | memory | Supersession edges (`supersedes_id`/`superseded_by_id` sur table memories) | M | MEM-G6 | Fixture remember contradiction→supersede ; assert nouvelle row supersedes_id=old & old.superseded_by_id=new (pas merge destructif) ; recall tier-sort démote la chaîne ; LoCoMo byte-identique (default NULL). |
| 7 | MEM-G6 | memory | Tier-aware §8b two-tier block-replica (`try_block_replica_upsert`) | M | — | Fixtures remember/ (tag memory-replica) + consolidation/ (cls tier promotion) ; assert block-replica n'écrit pas de doublon archival ; recall lit le bon tier. |
| 8 | MEM-G2 | memory | MinHash entity-dedup engine + AST-symbol origin flag | L | — | Unit parity MinHash signatures + Jaccard threshold (cross-check Python entity_dedup même corpus) ; fixture consolidation/ étendu ; même set d'entités fusionnées. |
| 9 | MEM-G3 | memory | Mutating consolidate-time entity-merge cycle | M | MEM-G2 | Parity cycle consolidate: même nb d'entités avant/après merge ; ENTITY_DEDUP enregistré en ablation ; fixture consolidation/ parity-runner. |
| 10 | PRD-BOUNDED-IO | prd | Backport bounded-io Phase 1c/1d/3 (Zod size contracts, budget 100k, run governor/semaphore, run-store eviction TTL+LRU, evidence retention) | L | **[cond:D2]** | Oracles canonical: `state-bounds.test.ts` + `bound-full-state.test.ts` importés côté survivant passent ; grep MAX_RESPONSE_CHARS/MAX_CONCURRENT_RUNS/MAX_EVIDENCE_ROWS non-vide ; état saturé sur 3 caps sérialise <100k. |
| 11 | PRD-GROUNDING-STEP2 | prd | Backport grounding codebase étape-2 (`prepare_prd_input` feature-mode → `codebase_grounding` → bloc prompts + `validate_prd_against_graph`) | L | **[cond:D2]** | Diff src normalisé (rename) survivant↔v0.4.0 = 0 sur input-analysis/section-prompts/self-check/contracts/codebase + types/{state,actions}.ts ; prompt byte-identique quand grounding absent (back-compat). |
| 12 | CB-4 | codebase | Re-capture golden oracle contre source v0.5.0 (gelé v0.0.4) | S | **[cond:D1=(a)]** | `capture_codebase_expected.js` contre binaire v0.5.0 ; meta.json source_version → v0.5.0 / tools_count 24 ; 8 tests existants + nouveau index_history verts. |
| 13 | CB-2 | codebase | Exposer `index_history` comme 24e tool (Zod + CodebasePort + adapter) | M | **[cond:D1=(a)]**, CB-4 | 9e `*.parity.test.ts` couvrant index_history vert contre binaire v0.5.0. |
| 14 | CB-3 | codebase | Porter 8 tree-sitter parsers (c,cpp,go,java,kotlin,objc,swift) dans le fork | L→XL (voir réserves) | **[cond:D1=(a)]** | `index_codebase.parity.test.ts` étendu par-langage (fixtures .java/.go/.swift/…) ; node/edge counts == source v0.5.0 par langue. |
| 15 | CB-5 | codebase | Champs optionnels bridge (`sibling graph paths`) sur GetSymbol/GetImpact/Search Zod | S | **[cond:D6=oui]** | 3 schémas Zod gagnent les champs optionnels ; round-trip vers binaire avec sibling-graph arg. |
| 16 | G-ORCH-03 | orchestration | Wire l'hôte réel : boucle conversation + MCP attach + tool-call handling | L (Agent SDK) / **XL si raw API** | **[cond:D3]**, G-ORCH-05 | NOUVEAU test d'intégration orchestrator contre serveur memory stdio live : 1 user-turn → ≥1 tool mémoire invoqué → message assistant final. Bar = fonctionnel (pas byte-parity, net-new). |
| 17 | G-ORCH-06 | orchestration | (branche raw-API uniquement) Client MCP stdio local + tool-bridge | XL | **[cond:D3=(b)]**, G-ORCH-01 | Test G-ORCH-03 passe avec round-trips via le bridge maison. Si D3=(a) Agent SDK → **drop** (transport stdio natif). |
| 18 | G-ORCH-04 | orchestration | Risque dead-scaffolding (skeleton sans caller, hors graphe build/test) — §9 | S | G-ORCH-03 OU marker | Soit (a) test G-ORCH-03 vert prouvant un caller, soit (b) marker écrit "planned, not dead" (ADR/CHANGELOG). |
| — | REASON-4-fix | reasoning | Fail-clean si `MEMORY_BACKEND_CMD` absent (au lieu d'un chemin fantôme 8-niveaux) | S | **[cond:D4=garder]** | Voir réserves — défaut de correctness latent. Boot résout un memory-tool.sh existant SANS override, OU échoue avec message clair. Disparaît si D4=(a) retrait. |

**Valeur/effort:** les 4 items S indépendants (G-ORCH-02, CB-6, MEM-G4, MEM-G5) sont à faire d'abord — débloqués sans aucune décision, faible coût, ferment des trous réels (modèle stale, couverture parity, 2 features memory post-gel). MEM-G6→G1 et MEM-G2→G3 forment 2 chaînes memory internes. Les chantiers prd et codebase v0.5.0 et orchestration sont **tous gelés derrière une décision user** et ne doivent pas démarrer avant.

---

## 4. DAG de dépendances inter-capacités

```
DÉCISIONS USER (à trancher d'abord)
  D1 (codebase canonicité) ──┬─► CB-4 ──► CB-2
                             ├─► CB-3
                             └─► (si (b): CB-2/3/4 quasi-nuls — source expose déjà)
  D2 (prd dedup ruling) ─────┬─► PRD-BOUNDED-IO
                             └─► PRD-GROUNDING-STEP2
  D3 (orchestration SDK) ────┬─► G-ORCH-05(correction doc/types) ──► G-ORCH-03 ──► G-ORCH-04
                             └─► (si (b) raw API: G-ORCH-06 [XL] ──► G-ORCH-03)
  D4 (reasoning 3e serveur) ─┬─► (si (a) retrait: REASON-4 disparaît)
                             └─► (si (b) garder: REASON-4-fix + doc 3 surfaces)
  D6 (codebase bridge) ──────► CB-5
  D7 (memory scoping) ───────► MEM-G7

INDÉPENDANTS (aucune décision requise) :
  G-ORCH-02 ─ (autonome)
  CB-6 ───── (autonome, baseline v0.0.4)
  MEM-G4 ─── (autonome)
  MEM-G5 ─── (autonome ; fonction déjà présente)

CHAÎNES MEMORY INTERNES :
  MEM-G2 (MinHash) ──► MEM-G3 (entity-merge cycle)
  MEM-G6 (tier-aware) ──► MEM-G1 (supersession ; réutilise détecteur §8b)
```

**Croisement inter-capacités notable:** PRD-GROUNDING-STEP2 (prd) **appelle** `prepare_prd_input`/`validate_prd_against_graph` — qui sont des tools **AP-Rust** (positions 20–21). Si D1=(a) re-sync, ces tools côté Rust restent stables (déjà v0.0.4) ; le grounding prd ne dépend PAS de CB-* car il les appelle en client via `call_pipeline_tool`, pas via le serveur prd. Aucune dépendance dure prd→codebase, mais les deux pipelines se composent à l'exécution.

---

## 5. Jalons

### M0 — Décisions tranchées + faux chantiers fermés (objectif: débloquer tout)
**Objectif vérifiable:** les 7 décisions user (D1–D7) ont une réponse écrite (ADR/note) ; le plugin reasoning est ruling-clos (D4) ; REASON-3 aligné (1 valeur de version unique dans les 3 fichiers, `grep -r version` cohérent) ; aucune session future ne rouvre un non-issue (section 6 publiée).
**Contenu:** D1–D7 + REASON-3 edit + section "Faux chantiers fermés".

### M1 — Quick wins indépendants (objectif: fermer tous les S débloqués sans décision)
**Objectif vérifiable:** G-ORCH-02 (modèle courant, typecheck vert), CB-6 (23 méthodes codebase couvertes par parity-test), MEM-G4 (`include_related` fixture vert), MEM-G5 (gate hierarchical flag, recall.parity byte-identique flag-off) — tous mergés et verts. memory passe de "backlog ouvert" à "2/6 incrémentaux clos".
**Contenu:** G-ORCH-02, CB-6, MEM-G4, MEM-G5 (+ MEM-G7 si D7=adopté).

### M2 — Parité memory incrémentale fermée (objectif: memory au niveau HEAD Cortex, pas seulement au gel)
**Objectif vérifiable:** MEM-G6→G1 et MEM-G2→G3 mergés ; parity-runner cortex vert sur fixtures remember/consolidation étendues ; LoCoMo conv0 sans régression vs PARITY_REPORT 2026-05-06 (0.985 hit / 0.851 MRR). memory verdict → **PASS au HEAD Cortex v3.24.0** (plus seulement au gel v3.15.0).
**Contenu:** MEM-G6, MEM-G1, MEM-G2, MEM-G3.

### M3 — Réconciliations canoniques (objectif: prd + codebase à parité source, orchestration fonctionnel)
**Objectif vérifiable:** côté survivant prd (D2) = diff src normalisé == v0.4.0 sur les 2 bundles ; fork codebase (si D1=(a)) re-syncé v0.5.0, golden re-capturé tools_count=24, parsers par-langue verts ; orchestrator (D3) passe un test d'intégration réel (1 user-turn → tool mémoire → réponse), §9 dead-scaffolding discharge. prd → PASS ; codebase → TS-vs-source PROUVÉ ; orchestration → maturité fonctionnelle "working host".
**Contenu:** PRD-BOUNDED-IO, PRD-GROUNDING-STEP2, CB-4, CB-2, CB-3, CB-5 (cond.), G-ORCH-05/03/04/06 (cond.), REASON-4-fix (cond.).

---

## 6. Faux chantiers fermés (non-issue — NE PAS rouvrir)

| id | capacité | pourquoi ce n'est PAS un gap (preuve) |
|---|---|---|
| MEM-G8 | memory | `recall.parity.test.ts` est un **stub mort** (importe `cortex/recall.js` inexistant, `ls src/cortex/` = pas de dir, skip toujours). Le VRAI harness est `parity-runner/src/runners/cortex.ts` (subprocess MCP JSON-RPC vs fixtures, diff MASKING.md) — opérationnel. Dette de doc, pas de parité. Action max: supprimer/repointer le stub. |
| MEM-G9 | memory | Stack viz Cortex (~40 commits feat/fix(viz)) + extraction vers `cortex-viz` standalone (v3.21.0). CORTEX_DELTA Group 6: « TS port contract = ingestion de données fidèle, PAS visualization » ; ADR-0011 défère le dashboard post-cutover. Aucune viz dans packages/memory **par design**. CI/ruff/pyright/CodeQL du window = harness Python, hors port TS. |
| CB-7 | codebase | L'adapter TS **ne calcule pas** de résultats : il forward le JSON-RPC au binaire Rust et valide en Zod (deepToCamel). Result-grade parity = binary parity. Surface v0.0.4 = déjà PASS (23/23 in+out schemas exact-match, 8 parity tests verts). **Aucun backlog de ré-implémentation TS.** Le seul résidu TS est les ajouts de schéma minces de CB-2/CB-5 SI le fork avance. |
| ZERA (sous CB-5) | codebase | Crate `zera` 1038 LOC = infra wire-protocol interne (BLAKE3+zstd encoding payload graphe). **0 mention dans tool_schemas.rs** → pas un tool MCP → **zéro travail TS-adapter pour la parité de surface**. (Le bridge, lui, ajoute des champs optionnels — voir D6.) |
| PRD-MCP-TOOL-SURFACE | prd | Les 2 côtés enregistrent **17 tools identiques** (9 directs + 8 pipeline), noms byte-identiques. `prepare_prd_input`/`validate_prd_against_graph` ne sont PAS exposés par prd (tools AP-Rust appelés en client) — absence by-design des 2 côtés. Ensembles de 1ers-args `server.tool` strictement égaux. |
| PRD-IDENTICAL-PACKAGES | prd | validation/strategy/verification/benchmark/skill : diff src normalisé (rename @agentic↔@prd-gen) = **0 divergence logique**. core = 6/7 rename pur ; seuls evidence-repository.ts (89 l. réelles) + index.ts (1 l.) sont du vrai code — **déjà couverts par PRD-BOUNDED-IO**. LOC src égales (benchmark 1388/1388, validation 4783/4783, strategy 1089/1089, verification 1509/1509). |
| PRD-PARITY-HARNESS | prd | Aucun `*.parity.test.ts`/parity-oracle dédié n'existe (par design : réconciliation intra-TS byte-identique, pas portage cross-langage). La preuve de parité = diff src normalisé + suites vitest des features (583/583 @5bb7dd9). **NE PAS construire de parity-oracle séparé** — surdimensionné. |
| REASON-1 | reasoning | 97 patterns genius + 19 team = **agents/skills/commands Claude Code** (frontmatter `model/effort/shapes`), JAMAIS des tools MCP — `grep -l mcpServers\|StdioServerTransport agents/genius/*.md` = 0 ; `grep -rni feynman\|genius\|shapes` dans le serveur MCP src/ = 0. Ils n'étaient pas non plus des tools dans la source zetetic. Porter vers MCP serait une **régression de design**. |
| G-ORCH-07 | orchestration | H1 CLI-guard idiom (`URL().pathname === argv[1]`) **inerte sous tsc** (dist plain tsc, pas esbuild-bundled — la bombe import.meta.url-rewrite ne peut pas tirer). Zéro impact comportemental, pas d'upstream. Pré-emption d'hygiène **déjà cataloguée dans le backlog distribution Phase0** — hors scope parité (discipline anti-ré-audit). |

---

## Réserves de la synthèse (critique de complétude)

Corrections apportées aux classifications des 5 rapports après vérification file:line :

1. **CB-2 / CB-3 / CB-4 : "port-work" → "port-work CONDITIONNEL [cond:D1=(a)]".** Les rapports les titrent "port-work" mais leur `type_note` les rend entièrement conditionnels à CB-1. Si D1=(b) "ship source", ces trois items **collapsent à quasi-zéro** (la source v0.5.0 expose déjà index_history + parsers ; le golden cible alors directement le binaire source). Le backlog (§3) les gate explicitement sur D1 pour ne pas surestimer le travail garanti. Le **seul** item codebase garanti sans décision est **CB-6** (S).

2. **CB-3 (8 parsers) : effort "L" sous-estimé → "L→XL".** Porter 7 grammaires tree-sitter (c/cpp/go/java/kotlin/objc/swift) avec parité de node/edge-count **par langage** + ajout des 7 deps Cargo + extension de l'enum Language + recapture golden par-langue est plus proche de XL que de L. C'est le plus gros risque d'effort caché du backlog. Marqué L→XL.

3. **REASON-4 : "user-decision" → contient un DÉFAUT DE CORRECTNESS latent (ajout REASON-4-fix au backlog).** Le rapport classe le chemin backend 8-niveaux en pur user-decision couplé à REASON-2. **Mais le défaut est réel et vérifié:** `DEFAULT_BACKEND_CMD` résout (via 8× `../`) un chemin **fantôme** à la racine FS (`/zetetic-team-subagents/tools/memory-tool.sh`, `ls` = No such file). Le boot ne réussit dans AUCUN layout sans `MEMORY_BACKEND_CMD`. Si D4=(b) garder le serveur, alors **fail-clean si var absente** est un port-work S obligatoire (ne pas livrer un chemin fantôme silencieux) — ajouté au backlog comme `REASON-4-fix [cond:D4=garder]`. Si D4=(a) retrait, il disparaît. Ce n'est pas un gap de **parité** (la source Python utilise aussi un chemin FS), mais c'est un gap de **correctness de packaging** qui ne doit pas être enterré comme simple "décision".

4. **memory : verdict rapport "PARTIAL" → reconcilié en "PASS (au gel) + backlog incrémental".** La tâche attendait PASS. Les deux sont vrais et il ne faut pas confondre : la parité **au freeze v3.15.0 ed33435 est PASS et honorée** (TS épinglé cortex@ed33435, recall.parity PASS 2026-05-06, LoCoMo conv0 0.985/0.851). Les 7 commits feat(memory/gate) sont **postérieurs au gel** (juin 2026) — c'est un **delta incrémental d'upstream qui a avancé**, PAS une régression de parité. Le dashboard le note PASS au gel + backlog ouvert ; M2 ferme l'incrémental pour atteindre PASS au HEAD v3.24.0. Aucune autre capacité memory n'est en cause.

5. **PRD-GROUNDING-STEP2 vs PRD-BOUNDED-IO : ordre du recommendedOrder honoré (BOUNDED-IO avant GROUNDING).** Vérifié cohérent : bounded-io est de l'infra de robustesse pure (caps, eviction) sans dépendance sur le grounding ; grounding étape-2 touche plus de fichiers (input-analysis/section-prompts/self-check/contracts) et porte un risque de back-compat sur les prompts. Faire l'infra d'abord est correct. Les deux restent gelés derrière D2.

6. **orchestration G-ORCH-03 effort "L (Agent SDK) / XL (raw API)" : confirmé asymétrique.** Vérifié que `@anthropic-ai/sdk` `mcp_servers` est `url`-only (messages.d.ts:1388 `type:'url'`, aucun `stdio`/`StdioServer`/`command-based`) et que `claude-agent-sdk` est **absent du disque**. La branche raw-API force réellement G-ORCH-06 (client stdio MCP maison + tool-bridge, XL) car les 4 serveurs configurés sont stdio locaux. **D3 n'est donc pas cosmétique : il change le data-model et double potentiellement l'effort.** Bien classé user-decision load-bearing.

7. **Aucun rapport n'a sur-classé un vrai port-work en user-decision pour l'éviter**, à l'exception partielle de REASON-4 (réserve 3, défaut de correctness masqué). Les user-decisions D1/D2/D3 sont **authentiquement des arbitrages de canonicité/substrat** dont dépend le SENS du port — pas des esquives. D6/D7 sont des reclassements légitimes (S si "oui", non-issue si "non").

### Estimation d'effort agrégé (semaines-personne, 1 ingénieur)

Barème : S ≈ 0,3–0,6 sp ; M ≈ 1–2 sp ; L ≈ 3–5 sp ; XL ≈ 6–10 sp.

| Bloc | Items | Fourchette (sp) |
|---|---|---|
| Quick wins S indépendants | G-ORCH-02, CB-6, MEM-G4, MEM-G5 (+MEM-G7 cond.) | 1,2 – 2,9 |
| Chaînes memory M/L | MEM-G6, MEM-G1, MEM-G2, MEM-G3 | 6 – 11 |
| prd backport (2× L) | PRD-BOUNDED-IO, PRD-GROUNDING-STEP2 | 6 – 10 |
| codebase v0.5.0 [cond:D1=(a)] | CB-4(S), CB-2(M), CB-3(L→XL), CB-5(S cond.) | 4,5 – 12 |
| orchestration host | G-ORCH-03/04/05 (+G-ORCH-06 si raw API) | 4 – 16 |
| reasoning hygiène | REASON-3 edit, REASON-4-fix (cond.) | 0,3 – 1 |
| **TOTAL** | | **≈ 22 – 53 sp** |

**≈ 22–53 semaines-personne = ≈ 5–12 mois-personne** (1 ETP). La fourchette large reflète les 3 décisions load-bearing : si D1=(b) keep-source, D3=(a) Agent SDK, et D6/D7 = non, le bas de fourchette (~22 sp ≈ 5 mois) est atteignable. Si D1=(a) re-sync + D3=(b) raw API + tout adopté, le haut (~53 sp ≈ 12 mois) s'applique.

**Confrontation à la cible user "4–9 mois":** **cohérent en milieu/bas de fourchette, sous tension en haut.** Le bas (5 mois, 1 ETP) tient dans la cible. Le centre (~7–8 mois) est dans la cible haute. Le scénario maximaliste (12 mois, 1 ETP) **dépasse** 9 mois — mais il est évitable par les décisions de descope (D1=(b), D3=(a), D6/D7=non) qui sont précisément les recommandations evidence-based des rapports. **Avec ~1,5–2 ETP en parallèle** (les chaînes memory, prd, codebase, orchestration sont largement indépendantes une fois les décisions prises), même le scénario maximaliste rentre dans 4–9 mois calendaires. Verdict: **cible atteignable** sous réserve de trancher D1/D2/D3 vers le descope et/ou de paralléliser.
