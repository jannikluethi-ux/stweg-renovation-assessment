import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listAssessments, loadBundle } from "@/lib/repo";

export default async function RoadmapsPage() {
  const user = await requireUser();
  const assessments = listAssessments(user.organizationId);
  const latest = new Map<string, (typeof assessments)[number]>();
  for (const assessment of assessments) {
    const current = latest.get(assessment.propertyId);
    if (!current || assessment.version > current.version) latest.set(assessment.propertyId, assessment);
  }
  const rows = [...latest.values()].map((assessment) => {
    const bundle = loadBundle(user.organizationId, assessment.id);
    const next = bundle?.interventions.filter((item) => item.targetYear != null).sort((a, b) => (a.targetYear ?? 0) - (b.targetYear ?? 0))[0];
    return { assessment, count: bundle?.interventions.length ?? 0, next };
  });
  return (
    <div className="stack">
      <h1>Roadmaps</h1>
      <p className="lede">Each roadmap belongs to an assessment version. Creating a new version copies the plan forward and keeps the previous version.</p>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Property</th><th>Version</th><th>Interventions</th><th>Next target</th></tr></thead>
          <tbody>
            {rows.length === 0 ? <tr><td colSpan={4}>No assessments yet.</td></tr> : rows.map((row) => (
              <tr key={row.assessment.id}>
                <td><Link href={`/roadmaps/${row.assessment.id}`}>{row.assessment.propertyName}</Link></td>
                <td>v{row.assessment.version}</td>
                <td>{row.count}</td>
                <td>{row.next ? `${row.next.targetYear} — ${row.next.title}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
