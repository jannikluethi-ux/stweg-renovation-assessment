import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { loadBundle } from "@/lib/repo";
import { GenerateReportButton } from "@/components/misc-forms";

export default async function QualityPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const bundle = loadBundle(user.organizationId, id);
  if (!bundle) notFound();
  return (
    <div className="stack">
      <h1>Quality check — {bundle.property.name} v{bundle.assessment.version}</h1>
      <p className="lede">Errors block a released report. Warnings do not, once they are acknowledged. The preview can still be opened.</p>
      <p>Completeness {bundle.completeness.overall}%. {bundle.quality.canGenerateReport ? "No blocking errors." : "Report release is blocked."}</p>
      <section>
        <h2>Errors</h2>
        {bundle.quality.errors.length === 0 ? <p>None.</p> : <ul>{bundle.quality.errors.map((error) => <li key={error}>{error}</li>)}</ul>}
      </section>
      <section>
        <h2>Warnings</h2>
        {bundle.quality.warnings.length === 0 ? <p>None.</p> : <ul>{bundle.quality.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
      </section>
      <GenerateReportButton assessmentId={bundle.assessment.id} />
      <Link href={`/reports/${bundle.assessment.id}`}>Open print preview</Link>
    </div>
  );
}
