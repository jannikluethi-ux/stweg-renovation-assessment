import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { buildBundleReport, loadBundle } from "@/lib/repo";
import { latestReportVersion } from "@/lib/mutations";
import { renderReportHtml } from "@/domain/report-html";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ assessmentId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Sign in required.", { status: 401 });
  const { assessmentId } = await context.params;
  const bundle = loadBundle(user.organizationId, assessmentId, "moderate");
  if (!bundle) return new NextResponse("Report not found.", { status: 404 });
  try {
    const model = buildBundleReport(bundle, Math.max(latestReportVersion(assessmentId), 1));
    const html = renderReportHtml(model);
    return new NextResponse(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="stweg-assessment-${assessmentId}.html"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Totals do not reconcile.";
    return new NextResponse(message, { status: 409 });
  }
}
