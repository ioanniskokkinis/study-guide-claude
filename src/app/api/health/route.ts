import { NextResponse } from "next/server";
import { checkHealth } from "@/lib/health";

export async function GET() {
  const result = await checkHealth();
  return NextResponse.json(result, { status: result.status === "healthy" ? 200 : 503 });
}
