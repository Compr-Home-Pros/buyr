import { NextResponse } from "next/server";
import { fetchSnipeQueue } from "@/lib/clozr";

export async function GET(req: Request) {
  const days = Number(new URL(req.url).searchParams.get("days") || "90");
  const queue = await fetchSnipeQueue(Number.isFinite(days) ? days : 90);
  return NextResponse.json(queue, { status: queue.ok ? 200 : 503 });
}
