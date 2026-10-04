import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { saveUploadedFile } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Your session has ended. Sign in again." }, { status: 401 });
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose a file before uploading." }, { status: 400 });
  const bytes = Buffer.from(await file.arrayBuffer());
  const named = String(form.get("name") || "").trim();
  const result = saveUploadedFile({
    user,
    propertyId: String(form.get("propertyId") || ""),
    category: String(form.get("category") || ""),
    originalName: named || file.name,
    description: String(form.get("description") || ""),
    source: String(form.get("source") || ""),
    documentDate: String(form.get("documentDate") || "") || null,
    bytes,
  });
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}
