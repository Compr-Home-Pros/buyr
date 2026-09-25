"""
Buyr — Wholesaler Sniping Tool — FastAPI Backend
Run: uvicorn main:app --reload
"""
import asyncio
import logging
from datetime import date
from collections import defaultdict
from typing import Any

logger = logging.getLogger(__name__)

from fastapi import FastAPI, BackgroundTasks, HTTPException, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from supabase import create_client, Client

from config import settings
from address_parser import parse_address
from counties.registry import get_scraper
from opencorporates.client import lookup_company
from skiptracing.orchestrator import get_contacts
from clozr import push_buyer_prospects

app = FastAPI(title="Buyr Scraper API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

supabase: Client = create_client(settings.supabase_url, settings.supabase_service_key)


def get_supabase_client() -> Client:
    return supabase


def verify_secret(x_api_secret: str = Header(default="")):
    if settings.api_secret and x_api_secret != settings.api_secret:
        raise HTTPException(status_code=401, detail="Unauthorized")


class SearchRequest(BaseModel):
    address: str
    search_id: str
    user_id: str = ""


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/search", dependencies=[Depends(verify_secret)])
async def run_search(req: SearchRequest, background_tasks: BackgroundTasks):
    background_tasks.add_task(pipeline, req)
    return {"status": "started", "search_id": req.search_id}


async def pipeline(req: SearchRequest):
    sid = req.search_id

    try:
        # ── Step 1: Parse address ──────────────────────────────────────────
        await _update(sid, "parsing_address", 8)
        api_keys = await _get_api_keys(req.user_id)
        maps_key = settings.google_maps_api_key or api_keys.get("google_maps_api_key") or ""
        county, state = await parse_address(req.address, maps_key)
        await _update(sid, "parsing_address", 15, parsed_county=county, parsed_state=state)

        # ── Step 2: Get wholesalers for this state ─────────────────────────
        await _update(sid, "finding_wholesalers", 20)
        wholesalers = await _get_wholesalers(state)
        if not wholesalers:
            await _update(sid, "error", 20, error=f"No wholesalers found for state {state}")
            return

        # ── Step 4: Scrape county deed records ─────────────────────────────
        await _update(sid, "searching_county_records", 30)
        scraper = get_scraper(county, state) if county != "unknown" else None

        all_transactions: list[dict] = []
        if scraper:
            pct_per_ws = 20 / max(len(wholesalers), 1)
            for i, ws_name in enumerate(wholesalers):
                try:
                    txns = await scraper.search_grantor(ws_name)
                    for t in txns:
                        row = {
                            "grantor_name": t.grantor_name,
                            "grantee_name": t.grantee_name,
                            "property_address": t.property_address,
                            "county": county,
                            "state": state,
                            "sale_date": t.sale_date,
                            "sale_price": t.sale_price,
                            "deed_type": t.deed_type,
                            "source_county_url": t.source_url,
                        }
                        all_transactions.append(row)
                    if txns:
                        supabase.table("transactions").upsert(txns_to_rows(txns, county, state)).execute()
                except Exception as exc:
                    logger.warning("Scraper error for wholesaler %r in %s/%s: %s", ws_name, county, state, exc)
                pct = 30 + int((i + 1) * pct_per_ws)
                await _update(sid, "searching_county_records", min(pct, 50))
                await asyncio.sleep(1.2)

        # ── Step 5: Rank top buyers ────────────────────────────────────────
        await _update(sid, "ranking_buyers", 55)
        top_buyers = _rank_buyers(all_transactions)[:10]

        if not top_buyers:
            await _update(sid, "complete", 100, results=[])
            return

        # ── Step 6: OpenCorporates lookup ──────────────────────────────────
        await _update(sid, "opencorporates_lookup", 65)
        oc_key = api_keys.get("opencorporates_api_key", "")
        enriched: list[dict] = []
        for buyer in top_buyers:
            llc_info = await lookup_company(buyer["name"], state, oc_key)
            buyer["registered_agent"] = llc_info.registered_agent
            buyer["agent_address"] = llc_info.agent_address
            buyer["officers"] = llc_info.officers or []

            # Cache in DB
            supabase.table("llc_entities").upsert({
                "name": buyer["name"],
                "state": state,
                "registered_agent": llc_info.registered_agent,
                "agent_address": llc_info.agent_address,
                "officers": llc_info.officers,
                "opencorporates_url": llc_info.opencorporates_url,
            }, on_conflict="name,state").execute()

            enriched.append(buyer)
            await asyncio.sleep(0.5)

        # ── Step 7: Skip trace ─────────────────────────────────────────────
        await _update(sid, "skip_tracing", 78)
        for buyer in enriched:
            agent_name = buyer.get("registered_agent") or ""
            agent_addr = buyer.get("agent_address") or ""
            contacts = await get_contacts(
                agent_name=agent_name,
                agent_address=agent_addr,
                llc_name=buyer["name"],
                state=state,
                api_keys=api_keys,
            )
            buyer["contacts"] = contacts

            # Store contacts
            for c in contacts:
                supabase.table("llc_contacts").upsert({
                    "llc_name": buyer["name"],
                    "agent_name": c.get("name"),
                    "agent_address": c.get("address"),
                    "phone": c.get("phone"),
                    "email": c.get("email"),
                    "source": c.get("source"),
                    "confidence": c.get("confidence"),
                }).execute()

            await asyncio.sleep(0.8)

        # Attach transactions to each buyer for UI drill-down
        txn_by_buyer: dict[str, list] = defaultdict(list)
        for t in all_transactions:
            txn_by_buyer[t["grantee_name"].upper()].append(t)

        for buyer in enriched:
            buyer["transactions"] = txn_by_buyer.get(buyer["name"].upper(), [])[:20]

        # ── Done ───────────────────────────────────────────────────────────
        filed = await push_buyer_prospects(
            settings.clozr_ingest_url,
            settings.clozr_ingest_key,
            sid,
            enriched,
            req.address,
        )
        if filed:
            logger.info("Filed %s buyer prospects in CLOZR for search %s", filed, sid)
        await _update(sid, "complete", 100, results=enriched)

    except Exception as exc:
        await _update(sid, "error", 0, error=str(exc))


def txns_to_rows(txns: list, county: str, state: str) -> list[dict]:
    rows = []
    for t in txns:
        rows.append({
            "grantor_name": t.grantor_name,
            "grantee_name": t.grantee_name,
            "property_address": t.property_address,
            "county": county,
            "state": state,
            "sale_date": t.sale_date,
            "sale_price": float(t.sale_price) if t.sale_price else None,
            "deed_type": t.deed_type,
            "source_county_url": t.source_url,
        })
    return rows


def _rank_buyers(transactions: list[dict]) -> list[dict]:
    counts: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"count": 0, "dates": [], "prices": []}
    )
    for t in transactions:
        key = t.get("grantee_name", "").upper().strip()
        if not key:
            continue
        counts[key]["count"] += 1
        if t.get("sale_date"):
            counts[key]["dates"].append(t["sale_date"])
        if t.get("sale_price"):
            counts[key]["prices"].append(float(t["sale_price"]))

    today = date.today()
    scored: list[dict] = []
    for name, data in counts.items():
        recency = 0.0
        last_purchase = None
        if data["dates"]:
            last_purchase = max(data["dates"])
            try:
                last_dt = date.fromisoformat(str(last_purchase)[:10])
                days_ago = (today - last_dt).days
                recency = max(0.0, 1.0 - days_ago / 365.0)
            except ValueError:
                pass

        avg_price = sum(data["prices"]) / len(data["prices"]) if data["prices"] else None
        score = round(data["count"] * 0.6 + recency * 40, 3)

        scored.append({
            "name": name,
            "purchase_count": data["count"],
            "last_purchase": str(last_purchase) if last_purchase else None,
            "avg_price": round(avg_price, 0) if avg_price else None,
            "score": score,
        })

    return sorted(scored, key=lambda x: x["score"], reverse=True)


async def _get_wholesalers(state: str) -> list[str]:
    resp = (
        supabase.table("wholesalers")
        .select("name")
        .eq("state", state.upper())
        .execute()
    )
    return [row["name"] for row in (resp.data or [])]


async def _get_api_keys(user_id: str) -> dict:
    """Settings saves the shared team row. Per-user keys only exist when auth is on."""
    try:
        if user_id:
            resp = (
                supabase.table("user_api_keys")
                .select("*")
                .eq("user_id", user_id)
                .limit(1)
                .execute()
            )
            rows = resp.data or []
            if rows:
                return rows[0]
        resp = supabase.table("team_api_keys").select("*").eq("id", "team").limit(1).execute()
        rows = resp.data or []
        return rows[0] if rows else {}
    except Exception as exc:
        logger.warning("API key lookup failed: %s", exc)
        return {}


async def _update(
    search_id: str,
    step: str,
    percent: int,
    results: list | None = None,
    error: str | None = None,
    parsed_county: str | None = None,
    parsed_state: str | None = None,
):
    payload: dict[str, Any] = {"step": step, "percent": percent}
    if results is not None:
        payload["results"] = results
    if error:
        payload["error"] = error
    if parsed_county:
        payload["parsed_county"] = parsed_county
    if parsed_state:
        payload["parsed_state"] = parsed_state

    supabase.table("searches").update(payload).eq("id", search_id).execute()
