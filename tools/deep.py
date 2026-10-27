#!/usr/bin/env python3
"""Pre-compute the text layer that the browser cannot afford to fetch.

The list endpoint has no job descriptions. Pulling ~1,100 detail endpoints per
company from a visitor's browser would take minutes, so we do it here once,
cache the raw JSON, and ship a small aggregate file next to the page.

    python3 tools/deep.py --company Ramboll3 --company AFRY

Writes docs/deep/{company}.json and docs/deep/index.json.
Stdlib only. Public API, no key.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import html
import json
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

API = "https://api.smartrecruiters.com/v1/companies"
ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / "cache"
OUT = ROOT / "docs" / "deep"
UA = "hiring-signal/1.0 (+https://github.com/edembey/hiring-signal)"

AI_RE = re.compile(
    r"\b(?:AI|A\.I\.|artificial intelligence|machine learning|LLM|LLMs|GenAI|generative AI)\b",
    re.IGNORECASE,
)
TERMS = [
    ("AI", re.compile(r"\bAI\b")),
    ("artificial intelligence", re.compile(r"\bartificial intelligence\b", re.I)),
    ("machine learning", re.compile(r"\bmachine learning\b", re.I)),
    ("LLM", re.compile(r"\bLLMs?\b")),
    ("GenAI", re.compile(r"\bGenAI\b", re.I)),
    ("automation", re.compile(r"\bautomation\b", re.I)),
    ("prompt", re.compile(r"\bprompts?\b", re.I)),
]
TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")


def get_json(url: str, attempts: int = 3) -> dict:
    last = None
    for attempt in range(attempts):
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code == 429 or exc.code >= 500:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as exc:
            last = exc
            time.sleep(1.0 * (attempt + 1))
    raise RuntimeError(f"failed: {url} ({last})")


def list_postings(company: str) -> list[dict]:
    out: list[dict] = []
    offset = 0
    total = None
    while True:
        page = get_json(f"{API}/{company}/postings?limit=100&offset={offset}")
        total = page.get("totalFound", 0)
        content = page.get("content") or []
        out.extend(content)
        offset += 100
        if not content or offset >= total:
            break
    print(f"  {company}: {len(out)} postings (totalFound={total})", file=sys.stderr)
    return out


def custom(post: dict, label: str) -> str | None:
    for field in post.get("customField") or []:
        if field.get("fieldLabel") == label:
            return field.get("valueLabel")
    return None


def fetch_detail(company: str, posting_id: str) -> dict:
    path = CACHE / company / f"{posting_id}.json"
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            path.unlink(missing_ok=True)
    data = get_json(f"{API}/{company}/postings/{posting_id}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")
    return data


def plain(raw: str | None) -> str:
    if not raw:
        return ""
    text = TAG_RE.sub(" ", raw)
    text = html.unescape(text)
    return WS_RE.sub(" ", text).strip()


def section(detail: dict, name: str) -> str:
    sections = (detail.get("jobAd") or {}).get("sections") or {}
    return plain((sections.get(name) or {}).get("text"))


def analyse(company: str, postings: list[dict], workers: int = 4) -> dict:
    ids = [str(p["id"]) for p in postings if p.get("id") is not None]
    details: dict[str, dict] = {}

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fetch_detail, company, pid): pid for pid in ids}
        done = 0
        for fut in concurrent.futures.as_completed(futures):
            pid = futures[fut]
            try:
                details[pid] = fut.result()
            except Exception as exc:  # noqa: BLE001 - one bad posting must not kill the run
                print(f"  ! {pid}: {exc}", file=sys.stderr)
            done += 1
            if done % 100 == 0:
                print(f"  fetched {done}/{len(ids)}", file=sys.stderr)

    ai_mentions = 0
    word_counts: list[int] = []
    empty_qualifications = 0
    term_counts: Counter[str] = Counter()
    boilerplate: Counter[str] = Counter()

    for post in postings:
        pid = str(post.get("id"))
        detail = details.get(pid)
        if not detail:
            continue
        body = " ".join(
            section(detail, name)
            for name in ("jobDescription", "qualifications", "additionalInformation")
        )
        if not body:
            continue
        word_counts.append(len(body.split()))
        if AI_RE.search(body):
            ai_mentions += 1
        for label, pattern in TERMS:
            term_counts[label] += len(pattern.findall(body))
        quals = section(detail, "qualifications")
        if len(quals) < 20:
            empty_qualifications += 1
        company_blurb = section(detail, "companyDescription")
        if company_blurb:
            boilerplate[company_blurb[:400]] += 1

    analysed = len(word_counts)

    # A single release day holding a large share of the board means the dates
    # were bulk-set, not that the company posted everything that day.
    days = Counter(
        p["releasedDate"][:10] for p in postings if p.get("releasedDate")
    )
    bulk_day = days.most_common(1)[0] if days else None

    return {
        "company": company,
        "name": (postings[0].get("company") or {}).get("name") if postings else company,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "analysed": analysed,
        "aiMentions": ai_mentions,
        "aiShare": round(ai_mentions / analysed, 4) if analysed else 0,
        "avgWords": round(sum(word_counts) / analysed) if analysed else 0,
        "emptyQualifications": empty_qualifications,
        "distinctBoilerplate": len(boilerplate),
        "topTerms": [[label, n] for label, n in term_counts.most_common(8) if n],
        "bulkDay": (
            {"date": bulk_day[0], "count": bulk_day[1], "share": round(bulk_day[1] / len(postings), 4)}
            if bulk_day
            else None
        ),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Pre-compute the text layer for hiring-signal.")
    ap.add_argument("--company", action="append", required=True, help="SmartRecruiters identifier, repeatable")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)

    for company in args.company:
        print(f"→ {company}", file=sys.stderr)
        postings = list_postings(company)
        if not postings:
            print(f"  no public postings for {company}, skipping", file=sys.stderr)
            continue
        data = analyse(company, postings, workers=args.workers)
        target = OUT / f"{company.lower()}.json"
        target.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(
            f"  wrote {target.relative_to(ROOT)}: "
            f"{data['aiMentions']}/{data['analysed']} mention AI, "
            f"avg {data['avgWords']} words",
            file=sys.stderr,
        )

    # Manifest so the page does not 404 on every company without a snapshot.
    available = sorted(p.stem for p in OUT.glob("*.json") if p.name != "index.json")
    (OUT / "index.json").write_text(
        json.dumps({"companies": available}, indent=2) + "\n", encoding="utf-8"
    )
    print(f"  wrote {(OUT / 'index.json').relative_to(ROOT)}: {', '.join(available)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
