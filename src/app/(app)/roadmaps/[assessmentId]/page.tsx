import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { loadBundle, scenarioItemsOf } from "@/lib/repo";
import { annualExpenditure, applyContingency, formatChfRange, roadmapYears, scenarioTotals, zurichYear } from "@/domain/calculations";
import { RoadmapForm } from "@/components/assessment-forms";

export default async function RoadmapPage({ params }: { params: Promise<{ assessmentId: string }> }) {
  const user = await requireUser();
  const { assessmentId } = await params;
  const bundle = loadBundle(user.organizationId, assessmentId);
  if (!bundle) notFound();
  const year = zurichYear();
  const items = scenarioItemsOf(bundle.interventions);
  const years = roadmapYears(year);
  return (
    <div className="stack">
      <h1>15-year roadmap — {bundle.property.name}</h1>
      <p className="lede">Window {years[0]}–{years[years.length - 1]} (current year through current year + 15). Suggested useful-life windows do not replace a year you set here.</p>
      {bundle.property.isDemo ? <p className="banner">DEMO / synthetic schedule. Not a commitment to replace anything.</p> : null}
      <RoadmapForm assessmentId={bundle.assessment.id} rows={bundle.interventions} />
      {(["low", "moderate", "high"] as const).map((scenario) => {
        const totals = scenarioTotals(items, scenario);
        const planning = applyContingency(totals.low, totals.high, bundle.assessment.contingencyPct);
        const annual = annualExpenditure(items, scenario);
        return (
          <section key={scenario}>
            <h2>{scenario === "low" ? "Low / minimum intervention" : scenario === "moderate" ? "Moderate / recommended" : "High / comprehensive"}</h2>
            <p>Base {formatChfRange(totals.low, totals.high)}. Contingency {bundle.assessment.contingencyPct}% {formatChfRange(planning.contingencyLow, planning.contingencyHigh)}. Planning range {formatChfRange(planning.planningLow, planning.planningHigh)}.</p>
            <div className="table-wrap">
              <table className="data">
                <thead><tr>{years.map((item) => <th key={item}>{item}</th>)}</tr></thead>
                <tbody>
                  <tr>
                    {years.map((item) => {
                      const found = annual.find((row) => row.year === item);
                      const names = bundle.interventions.filter((intervention) => intervention.targetYear === item && ((scenario === "low" && intervention.includeLow) || (scenario === "moderate" && intervention.includeModerate) || (scenario === "high" && intervention.includeHigh)));
                      return <td key={item}>{names.map((intervention) => intervention.title).join(", ") || "—"}{found ? ` ${formatChfRange(found.low, found.high)}` : ""}</td>;
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
      <Link href={`/properties/${bundle.property.id}/financial`}>Open reserve projection</Link>
    </div>
  );
}
