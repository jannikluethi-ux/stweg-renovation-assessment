import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listAssessments } from "@/lib/repo";
import { listReports } from "@/lib/mutations";
import { formatIsoDateTimeSwiss } from "@/domain/calculations";

export default async function ReportsPage() {
  const user = await requireUser();
  const reports = listReports(user.organizationId);
  const assessments = listAssessments(user.organizationId);
  return (
    <div className="stack">
      <h1>Reports</h1>
      <p className="lede">A released report is created only after the quality check passes. The print view is always available as a preview and uses the stored assessment, not placeholder text.</p>
      <h2>Released</h2>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Property</th><th>Report</th><th>Assessment</th><th>Generated</th></tr></thead>
          <tbody>
            {reports.length === 0 ? <tr><td colSpan={4}>No released report yet.</td></tr> : reports.map((report) => (
              <tr key={report.id}>
                <td><Link href={`/reports/${report.assessmentId}`}>{report.propertyName}</Link></td>
                <td>v{report.version} · {report.status}</td>
                <td>v{report.assessmentVersion}</td>
                <td>{formatIsoDateTimeSwiss(report.generatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Open a preview</h2>
      <ul>{assessments.map((assessment) => <li key={assessment.id}><Link href={`/reports/${assessment.id}`}>{assessment.propertyName} assessment v{assessment.version}</Link> · <Link href={`/assessments/${assessment.id}/quality`}>quality check</Link></li>)}</ul>
    </div>
  );
}
