"""Push discovered buyers into CLOZR as Buyer Prospects.

CLOZR's ingest key for source `buyr` files them with status Prospect so they
do not sit on the vetted buyer list. Missing env is a no-op: a search still
finishes when Clozr is not connected.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)


async def push_buyer_prospects(
    ingest_url: str,
    ingest_key: str,
    search_id: str,
    buyers: list[dict],
    address: str,
) -> int:
    if not ingest_url or not ingest_key or not buyers:
        return 0
    sent = 0
    async with httpx.AsyncClient(timeout=20) as client:
        for buyer in buyers:
            contacts = buyer.get("contacts") or []
            email = next((c.get("email") for c in contacts if c.get("email")), None)
            phone = next((c.get("phone") for c in contacts if c.get("phone")), None)
            name = (buyer.get("name") or "").strip()
            if not name and not email and not phone:
                continue
            notes = f"Buyr sniping for {address}. {buyer.get('purchase_count', 0)} purchases"
            if buyer.get("last_purchase"):
                notes += f", last {buyer['last_purchase']}"
            agent = buyer.get("registered_agent")
            if agent:
                notes += f". Registered agent {agent}"
            payload = {
                "source": "buyr",
                "source_id": f"buyr:{search_id}:{name or email or phone}"[:240],
                "type": "buyer.captured",
                "buyer": {
                    "name": name or email or phone,
                    "company": name if _looks_like_entity(name) else None,
                    "email": email,
                    "phone": phone,
                    "notes": notes,
                    "tags": ["buyer-prospect", "buyr"],
                },
            }
            try:
                res = await client.post(
                    ingest_url,
                    json=payload,
                    headers={"Authorization": f"Bearer {ingest_key}", "Content-Type": "application/json"},
                )
                if res.status_code >= 400:
                    logger.warning("CLOZR ingest %s for %s: %s", res.status_code, name, res.text[:200])
                    continue
                sent += 1
            except httpx.HTTPError as exc:
                logger.warning("CLOZR ingest failed for %s: %s", name, exc)
    return sent


def _looks_like_entity(name: str) -> bool:
    upper = name.upper()
    return any(token in upper for token in (" LLC", " INC", " LP", " TRUST", " CORP", " LTD"))


async def fetch_snipe_queue(buyr_url: str, ingest_key: str, days: int = 90) -> dict[str, Any]:
    if not buyr_url or not ingest_key:
        return {"ok": False, "error": "CLOZR buyr queue is not configured", "deals": [], "wholesaler_optins": []}
    async with httpx.AsyncClient(timeout=20) as client:
        res = await client.post(
            buyr_url,
            json={"action": "queue", "days": days},
            headers={"Authorization": f"Bearer {ingest_key}", "Content-Type": "application/json"},
        )
        res.raise_for_status()
        return res.json()
