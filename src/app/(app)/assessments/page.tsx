import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listAssessments } from "@/lib/repo";
import { formatIsoDateSwiss } from "@/domain/calculations";

export default async function AssessmentsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await requireUser();
  const query = await searchParams;
  const status = query.status ?? "";
  const rows = listAssessments(user.organizationId, status);
  return (
    <div className="stack">
      <h1>Assessments</h1>
      <form className="row" method="get">
        <label>Status
          <select name="status" defaultValue={status}>
            <option value="">All</option>
            <option value="draft">Draft</option>
            <option value="in_review">In review</option>
            <option value="completed">Completed</option>
          </select>
        </label>
        <button className="btn secondary" type="submit">Filter</button>
      </form>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Property</th><th>Version</th><th>Date</th><th>Status</th><th>Confidence</th></tr></thead>
          <tbody>
            {rows.length === 0 ? <tr><td colSpan={5}>No assessments yet. Open a property and start one.</td></tr> : rows.map((row) => (
              <tr key={row.id}>
                <td><Link href={`/assessments/${row.id}`}>{row.propertyName}</Link>{row.isDemo ? " · DEMO" : ""}</td>
                <td>v{row.version}</td>
                <td>{formatIsoDateSwiss(row.assessmentDate)}</td>
                <td>{row.status.replaceAll("_", " ")}</td>
                <td>{row.overallConfidence}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
