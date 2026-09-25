"use client";

import { useState, useEffect, useRef } from "react";
import { createBrowserClient } from "@/lib/supabase/client";
import { HeroSearch } from "@/components/hero-search";
import { PipelineStatus } from "@/components/pipeline-status";
import { BuyerCard } from "@/components/buyer-card";
import { exportToCsv } from "@/lib/utils";
import { Download, Users } from "lucide-react";

export type Buyer = {
  name: string;
  purchase_count: number;
  last_purchase: string | null;
  avg_price: number | null;
  score: number;
  registered_agent: string | null;
  agent_address: string | null;
  contacts: Array<{
    name: string;
    phone: string | null;
    email: string | null;
    source: string;
    confidence: number;
  }>;
  transactions: Array<{
    grantor_name: string;
    property_address: string;
    sale_date: string;
    sale_price: number | null;
    deed_type: string | null;
  }>;
};

type QueueDeal = { id: number; address: string; created_at: string };
type OptIn = { domain: string; url: string | null };

type SearchState = "idle" | "running" | "done" | "error";

type ProgressRow = {
  step: string;
  percent: number;
  results?: Buyer[];
  error?: string;
};

export default function SearchPage() {
  const supabase = createBrowserClient();
  const [searchId, setSearchId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressRow | null>(null);
  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [state, setState] = useState<SearchState>("idle");
  const [searchedAddress, setSearchedAddress] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [queue, setQueue] = useState<QueueDeal[]>([]);
  const [optins, setOptins] = useState<OptIn[]>([]);
  const [queueMsg, setQueueMsg] = useState("");
  const [fbText, setFbText] = useState("");
  const [fbMsg, setFbMsg] = useState("");
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  useEffect(() => {
    if (!searchId) return;
    channelRef.current = supabase
      .channel(`search:${searchId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "searches", filter: `id=eq.${searchId}` },
        (payload) => {
          const row = payload.new as ProgressRow;
          setProgress(row);
          if (row.step === "complete" && row.results) {
            setBuyers(row.results);
            setState("done");
          }
          if (row.step === "error") setState("error");
        }
      )
      .subscribe();
    return () => { channelRef.current?.unsubscribe(); };
  }, [searchId, supabase]);

  async function handleSearch(address: string) {
    setState("running");
    setErrorMsg("");
    setBuyers([]);
    setProgress(null);
    setSearchedAddress(address);

    const { data: row, error } = await supabase
      .from("searches")
      .insert({ input_address: address, step: "queued", percent: 0 })
      .select("id")
      .single();

    if (error || !row) { setState("error"); return; }
    setSearchId(row.id);

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, search_id: row.id }),
      });
      if (res.status === 503) {
        setErrorMsg("The county scraper is not connected. Set SCRAPER_API_URL and SCRAPER_API_SECRET, then search again.");
        setState("error");
        return;
      }
      if (!res.ok) setState("error");
    } catch {
      setState("error");
    }
  }

  async function loadQueue() {
    setQueueMsg("Loading aged Deal Machine deals…");
    const res = await fetch("/api/snipe-queue");
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      setQueueMsg(data.error || "Could not load the sniping queue.");
      return;
    }
    setQueue(data.deals || []);
    setOptins(data.wholesaler_optins || []);
    setQueueMsg(`${(data.deals || []).length} deals older than ${data.aged_days} days · ${(data.wholesaler_optins || []).length} wholesaler lists opted in`);
  }

  async function fileFacebook() {
    setFbMsg("Reading comments…");
    const res = await fetch("/api/facebook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: fbText }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setFbMsg(data.error || "Could not read those comments.");
      return;
    }
    setFbMsg(data.error
      ? `Found ${data.found}. CLOZR: ${data.error}`
      : `Found ${data.found}, filed ${data.sent} in Buyer Prospects.`);
  }

  return (
    <div className="space-y-10">
      {/* Hero search */}
      <HeroSearch onSearch={handleSearch} loading={state === "running"} />

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-white">Aged deals to snipe</h2>
            <button type="button" onClick={loadQueue} className="text-xs font-medium text-blue-300 hover:text-white">Load 90-day queue</button>
          </div>
          <p className="text-xs text-slate-500">Deal Machine deals at least 90 days old, plus wholesaler lists the opt-in bot joined. Run sniping on an address to see who they sold it to.</p>
          {queueMsg ? <p className="text-xs text-slate-400">{queueMsg}</p> : null}
          <ul className="space-y-1 max-h-40 overflow-auto">
            {queue.map((deal) => (
              <li key={deal.id}>
                <button type="button" onClick={() => handleSearch(deal.address)} className="text-left text-xs text-slate-200 hover:text-white">
                  {deal.address}
                </button>
              </li>
            ))}
          </ul>
          {optins.length ? <p className="text-xs text-slate-500">{optins.slice(0, 8).map((o) => o.domain).join(" · ")}</p> : null}
        </section>
        <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-white">Facebook group comments</h2>
          <p className="text-xs text-slate-500">Paste comments from groups the Home Pros page is in. One person per line, name then email. They file into CLOZR Buyer Prospects.</p>
          <textarea value={fbText} onChange={(e) => setFbText(e.target.value)} rows={4} placeholder={"Sam Buyer: send it to sam@example.com"} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100" />
          <button type="button" onClick={fileFacebook} className="text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg px-3 py-1.5">File buyer prospects</button>
          {fbMsg ? <p className="text-xs text-slate-400">{fbMsg}</p> : null}
        </section>
      </div>

      {/* Pipeline progress */}
      {state === "running" && progress && (
        <div className="animate-fade-in">
          <PipelineStatus step={progress.step} percent={progress.percent} />
        </div>
      )}

      {/* Error */}
      {state === "error" && (
        <div className="animate-fade-up bg-red-950/40 border border-red-800 text-red-300 rounded-xl px-5 py-4 text-sm">
          {errorMsg || "Something went wrong. Check your Supabase connection and scraper URL, then try again."}
        </div>
      )}

      {/* Results */}
      {state === "done" && buyers.length > 0 && (
        <div className="space-y-5 animate-fade-in">
          {/* Results header bar */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-blue-600/20 border border-blue-600/30">
                <Users size={16} className="text-blue-400" />
              </div>
              <div>
                <p className="text-white font-semibold text-sm">
                  {buyers.length} Buyers Found
                </p>
                <p className="text-slate-500 text-xs truncate max-w-xs">
                  {searchedAddress}
                </p>
              </div>
            </div>
            <button
              onClick={() => exportToCsv(buyers, "buyr-results")}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors shadow-lg shadow-blue-900/30"
            >
              <Download size={14} />
              Export CSV
            </button>
          </div>

          {/* Cards */}
          <div className="space-y-3">
            {buyers.map((buyer, i) => (
              <div
                key={buyer.name}
                className={`animate-fade-up delay-${Math.min(i, 9)}`}
              >
                <BuyerCard rank={i + 1} buyer={buyer} />
              </div>
            ))}
          </div>
        </div>
      )}

      {state === "done" && buyers.length === 0 && (
        <div className="animate-fade-up text-center py-16">
          <p className="text-slate-500 text-sm">
            No buyers found for this market yet. Try a different address or add more wholesalers in Settings.
          </p>
        </div>
      )}
    </div>
  );
}
