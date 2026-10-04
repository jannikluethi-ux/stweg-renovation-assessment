import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { savePhoto } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Your session has ended. Sign in again." }, { status: 401 });
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose a JPG or PNG photo." }, { status: 400 });
  const result = savePhoto({
    user,
    componentId: String(form.get("componentId") || ""),
    caption: String(form.get("caption") || ""),
    location: "",
    relevance: "Assessment evidence. Not auto-diagnosed.",
    photoDate: null,
    originalName: file.name,
    bytes: Buffer.from(await file.arrayBuffer()),
  });
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}
