import { readFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getStoredFile } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Sign in required.", { status: 401 });
  const { id } = await context.params;
  const file = getStoredFile(user.organizationId, "photos", id);
  if (!file) return new NextResponse("File not found.", { status: 404 });
  const bytes = readFileSync(file.absolutePath);
  const ext = path.extname(file.absolutePath).replace(".", "").toLowerCase();
  return new NextResponse(bytes, {
    headers: {
      "Content-Type": ext === "png" ? "image/png" : "image/jpeg",
      "Content-Disposition": "inline",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
