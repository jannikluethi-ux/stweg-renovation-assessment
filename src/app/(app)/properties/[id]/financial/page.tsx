import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getProperty, latestAssessmentId, loadBundle } from "@/lib/repo";
import { formatChfPlain } from "@/domain/calculations";
import { FinancialForm } from "@/components/assessment-forms";

export default async function FinancialPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ scenario?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const query = await searchParams;
  const property = getProperty(user.organizationId, id);
  if (!property) notFound();
  const assessmentId = latestAssessmentId(user.organizationId, id);
  if (!assessmentId) return <p>Start an assessment before entering the reserve fund.</p>;
  const scenario = query.scenario === "low" || query.scenario === "high" ? query.scenario : "moderate";
  const bundle = loadBundle(user.organizationId, assessmentId, scenario);
  if (!bundle) notFound();
  return (
    <div className="stack">
      <h1>Reserve fund — {property.name}</h1>
      <p className="lede">Assessment v{bundle.assessment.version}. Planned expenditure uses the high end of the base estimate for the selected scenario. Contingency is not hidden inside that figure.</p>
      {property.isDemo ? <p className="banner">DEMO / synthetic reserve figures. Not market data.</p> : null}
      <form method="get" className="row">
        <label>Scenario
          <select name="scenario" defaultValue={scenario}>
            <option value="low">Low / minimum</option>
            <option value="moderate">Moderate / recommended</option>
            <option value="high">High / comprehensive</option>
          </select>
        </label>
        <button className="btn secondary" type="submit">Show projection</button>
      </form>
      <FinancialForm assessmentId={assessmentId} initial={bundle.financial} />
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Year</th><th className="num">Opening</th><th className="num">Contributions</th><th className="num">Other funding</th><th className="num">Planned expenditure</th><th className="num">Closing</th><th>Flag</th></tr></thead>
          <tbody>
            {bundle.reserveRows.length === 0 ? <tr><td colSpan={7}>Enter an opening balance and an annual contribution to project the reserve.</td></tr> : bundle.reserveRows.map((row) => (
              <tr key={row.year}>
                <td>{row.year}</td>
                <td className="num">{formatChfPlain(row.opening)}</td>
                <td className="num">{formatChfPlain(row.contributions)}</td>
                <td className="num">{formatChfPlain(row.otherFunding)}</td>
                <td className="num">{formatChfPlain(row.plannedExpenditure)}</td>
                <td className="num">{formatChfPlain(row.closing)}</td>
                <td>{row.fundingGap ? "Projected funding gap" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
