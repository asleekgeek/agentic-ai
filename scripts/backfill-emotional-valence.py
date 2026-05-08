#!/usr/bin/env python3
"""
backfill-emotional-valence.py — one-shot backfill script.

Reads every memory from cortex_agentic, recomputes emotional_valence
via the VADER pipeline (identical to vader.py + emotional_tagging.py),
and UPDATEs in batches.

source: Hutto CJ & Gilbert E (2014) "VADER: A Parsimonious Rule-based Model
  for Sentiment Analysis of Social Media Text." ICWSM.
source: mcp_server/shared/vader.py
source: mcp_server/core/emotional_tagging.py
"""

import math
import re
import sys
import os
import psycopg2

# ── VADER constants (from Hutto & Gilbert 2014) ────────────────────────────
# source: mcp_server/shared/vader.py:22-24

ALPHA = 15          # source: Hutto & Gilbert (2014) ICWSM — normalization constant
N_SCALAR = -0.74    # source: Hutto & Gilbert (2014) ICWSM Table 2 — negation scalar H4

# source: mcp_server/shared/vader.py:30-97
LEXICON = {
    "error": -2.0, "exception": -2.0, "traceback": -2.5, "failed": -2.5,
    "failure": -2.5, "bug": -2.0, "crash": -3.0, "broken": -2.5,
    "timeout": -1.5, "denied": -1.5, "rejected": -1.5, "deprecated": -1.0,
    "frustrating": -2.5, "annoying": -2.0, "painful": -2.0, "struggle": -1.5,
    "nightmare": -3.0, "horrible": -3.0, "terrible": -3.0, "awful": -3.0,
    "hate": -3.0, "wtf": -3.0, "damn": -2.0, "ugh": -1.5, "argh": -1.5,
    "confusing": -1.5, "unclear": -1.0, "weird": -1.0, "bizarre": -1.5,
    "urgent": -1.5, "critical": -1.5, "blocking": -2.0, "outage": -3.0,
    "hotfix": -1.5,
    "fixed": 2.0, "resolved": 2.0, "working": 1.5, "success": 2.5,
    "passed": 1.5, "deployed": 2.0, "completed": 2.0, "shipped": 2.5,
    "merged": 1.5, "approved": 1.5, "elegant": 2.5, "beautiful": 2.5,
    "clean": 1.5, "perfect": 3.0, "excellent": 3.0, "awesome": 3.0,
    "great": 2.5, "finally": 1.0, "breakthrough": 3.0, "improvement": 1.5,
    "better": 1.5, "love": 2.5, "happy": 2.0, "proud": 2.0,
    "satisfying": 2.0, "insight": 2.0, "discovered": 2.0, "realized": 1.5,
    "eureka": 3.0, "interesting": 1.5,
}

# source: mcp_server/shared/vader.py:102-117
BOOSTERS = {
    "very": 0.293, "extremely": 0.293, "really": 0.293, "absolutely": 0.293,
    "incredibly": 0.293, "totally": 0.293, "completely": 0.293, "so": 0.293,
    "slightly": -0.293, "somewhat": -0.293, "barely": -0.293, "hardly": -0.293,
}

# source: mcp_server/shared/vader.py:121-146
NEGATIONS = frozenset({
    "not", "no", "never", "neither", "nobody", "nothing", "nowhere", "nor",
    "cannot", "can't", "couldn't", "shouldn't", "wouldn't", "won't",
    "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't",
    "without",
})

_WORD_RE = re.compile(r"[a-z]+(?:'t)?", re.IGNORECASE)


def _tokenize(text: str) -> list:
    return [m.group().lower() for m in _WORD_RE.finditer(text)]


def vader_compound(text: str) -> float:
    """source: mcp_server/shared/vader.py:156-201"""
    tokens = _tokenize(text)
    if not tokens:
        return 0.0
    sentiments = []
    for i, token in enumerate(tokens):
        valence = LEXICON.get(token, 0.0)
        if valence == 0.0:
            continue
        for j in range(max(0, i - 3), i):
            prev = tokens[j]
            if prev in BOOSTERS:
                boost = BOOSTERS[prev]
                dist = i - j
                valence += valence * boost / dist
        for j in range(max(0, i - 3), i):
            if tokens[j] in NEGATIONS:
                valence *= N_SCALAR
                break
        sentiments.append(valence)
    if not sentiments:
        return 0.0
    total = sum(sentiments)
    compound = total / math.sqrt(total * total + ALPHA)
    return max(-1.0, min(1.0, round(compound, 4)))


# ── Emotion domain regexes ─────────────────────────────────────────────────
# source: mcp_server/core/emotional_tagging.py:32-65

_ERROR_RE = re.compile(
    r"\b(error|exception|traceback|failed|failure|bug|crash|broken|timeout|"
    r"denied|rejected|deprecated|hours? debugging|still broken|"
    r"keeps? failing|won'?t work)\b", re.IGNORECASE)

_SUCCESS_RE = re.compile(
    r"\b(fixed|resolved|working|success|passed|deployed|completed|shipped|"
    r"merged|approved|nailed|breakthrough|elegant|beautiful|clean|perfect|"
    r"excellent|awesome|improvement)\b", re.IGNORECASE)

_QUESTION_RE = re.compile(
    r"\?|\b(confus|unclear|don'?t understand|makes no sense|"
    r"weird|bizarre|unexpected|strange|mysterious|puzzling|"
    r"why does|how come|what the)\b", re.IGNORECASE)

_URGENCY_RE = re.compile(
    r"\b(urgent|critical|blocking|deadline|asap|immediately|"
    r"production|outage|down|hotfix|p0|sev[- ]?1)\b", re.IGNORECASE)

_INSIGHT_RE = re.compile(
    r"\b(realized|discovered|found out|turns out|TIL|"
    r"interesting|insight|key finding|important lesson|"
    r"aha|eureka|lightbulb)\b", re.IGNORECASE)


def detect_emotions(content: str) -> dict:
    """source: mcp_server/core/emotional_tagging.py:68-132"""
    compound = vader_compound(content)
    abs_compound = abs(compound)

    error_hits = min(len(_ERROR_RE.findall(content)), 3)
    success_hits = min(len(_SUCCESS_RE.findall(content)), 3)
    question_hits = min(len(_QUESTION_RE.findall(content)), 3)
    urgency_hits = min(len(_URGENCY_RE.findall(content)), 3)
    insight_hits = min(len(_INSIGHT_RE.findall(content)), 3)

    frustration = 0.0
    if compound < 0 and error_hits > 0:
        frustration = abs_compound * (error_hits / 3.0)
    elif error_hits >= 1:
        frustration = 0.2 * (error_hits / 3.0)

    satisfaction = 0.0
    if compound > 0 and success_hits > 0:
        satisfaction = abs_compound * (success_hits / 3.0)
    elif success_hits >= 1:
        satisfaction = 0.2 * (success_hits / 3.0)

    confusion = 0.0
    if question_hits > 0:
        certainty_factor = max(0.0, 1.0 - abs_compound * 2)
        confusion = certainty_factor * (question_hits / 3.0)

    urgency = 0.0
    if urgency_hits > 0:
        neg_weight = max(0.3, abs_compound) if compound <= 0 else 0.3
        urgency = neg_weight * (urgency_hits / 3.0)

    discovery = 0.0
    if insight_hits > 0:
        pos_weight = max(0.3, abs_compound) if compound >= 0 else 0.3
        discovery = pos_weight * (insight_hits / 3.0)

    return {
        "frustration": round(min(1.0, frustration), 4),
        "satisfaction": round(min(1.0, satisfaction), 4),
        "confusion": round(min(1.0, confusion), 4),
        "urgency": round(min(1.0, urgency), 4),
        "discovery": round(min(1.0, discovery), 4),
    }


def compute_emotional_valence(emotions: dict) -> float:
    """source: mcp_server/core/emotional_tagging.py:151-167"""
    positive = emotions["satisfaction"] + emotions["discovery"]
    negative = emotions["frustration"] + emotions["urgency"]
    total = positive + negative + emotions["confusion"]
    if total == 0:
        return 0.0
    return round(max(-1.0, min(1.0, (positive - negative) / max(total, 1.0))), 4)


# ── Backfill ────────────────────────────────────────────────────────────────

PG_URL = os.environ.get("PG_URL", "postgresql://localhost/cortex_agentic")
BATCH_SIZE = 200

conn = psycopg2.connect(PG_URL)
conn.autocommit = False
cur = conn.cursor()

cur.execute("SELECT id, content FROM memories ORDER BY id")
rows = cur.fetchall()
print(f"Fetched {len(rows)} memories for backfill")

updated = 0
zero_count = 0
i = 0

while i < len(rows):
    batch = rows[i:i + BATCH_SIZE]
    updates = []
    for (mem_id, content) in batch:
        v = compute_emotional_valence(detect_emotions(content or ""))
        updates.append((v, mem_id))
        if v != 0.0:
            updated += 1
        else:
            zero_count += 1
    cur.executemany("UPDATE memories SET emotional_valence = %s WHERE id = %s", updates)
    conn.commit()
    i += BATCH_SIZE
    print(f"  processed {min(i, len(rows))}/{len(rows)}", end="\r", flush=True)

print(f"\nBackfill complete: {updated} non-zero, {zero_count} remain 0")

# Post-backfill stats
cur.execute("""
    SELECT
        COUNT(DISTINCT emotional_valence) AS distinct_vals,
        COUNT(*) FILTER (WHERE emotional_valence > 0) AS pos,
        COUNT(*) FILTER (WHERE emotional_valence < 0) AS neg,
        MIN(emotional_valence) AS min_val,
        MAX(emotional_valence) AS max_val
    FROM memories
""")
row = cur.fetchone()
print(f"Post-backfill: distinct={row[0]}, pos={row[1]}, neg={row[2]}, min={row[3]}, max={row[4]}")

cur.close()
conn.close()
