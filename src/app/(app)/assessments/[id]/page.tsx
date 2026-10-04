import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { loadBundle } from "@/lib/repo";
import { applyContingency, bandLegend, calculatePriority, formatChfRange, priorityFormulaText, requiresPriorityReview, scenarioTotals, suggestPlanningWindow, zurichYear } from "@/domain/calculations";
import { componentCost, scenarioItemsOf, scoreInput } from "@/lib/repo";
import { ComponentForm, EnergyForm, InterventionForm, MetaForm, VersionButton } from "@/components/assessment-forms";
import { PhotoUpload } from "@/components/misc-forms";

export default async function AssessmentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const bundle = loadBundle(user.organizationId, id);
  if (!bundle) notFound();
  const year = zurichYear();
  const items = scenarioItemsOf(bundle.interventions);
  const scenarios = (["low", "moderate", "high"] as const).map((key) => {
    const totals = scenarioTotals(items, key);
    const planning = applyContingency(totals.low, totals.high, bundle.assessment.contingencyPct);
    return { key, totals, planning };
  });
  return (
    <div className="stack">
      {bundle.property.isDemo ? <p className="banner">DEMO / synthetic assessment. Scores and costs are entered example data, not a site inspection and not market prices.</p> : null}
      <h1>{bundle.property.name} — assessment v{bundle.assessment.version}</h1>
      <p className="lede">Status {bundle.assessment.status.replaceAll("_", " ")}. Completeness {bundle.completeness.overall}%. Confidence {bundle.assessment.overallConfidence}.</p>
      <div className="row">
        <Link className="btn secondary" href={`/properties/${bundle.property.id}`}>Property</Link>
        <Link className="btn secondary" href={`/roadmaps/${bundle.assessment.id}`}>Roadmap</Link>
        <Link className="btn secondary" href={`/properties/${bundle.property.id}/financial`}>Reserve fund</Link>
        <Link className="btn secondary" href={`/assessments/${bundle.assessment.id}/quality`}>Quality check</Link>
        <Link className="btn secondary" href={`/reports/${bundle.assessment.id}`}>Report</Link>
        <VersionButton assessmentId={bundle.assessment.id} />
      </div>
      <section className="panel formula">
        <h2>Priority formula</h2>
        <p>{priorityFormulaText(bundle.assessment.weights)}</p>
        <p>Bands: {bandLegend(bundle.assessment.thresholds)}.</p>
        <p className="muted">If any input is unknown or missing, that component is excluded from the numeric priority and flagged. It is not scored as 1. These weights are the snapshot stored on this assessment.</p>
      </section>
      <MetaForm assessmentId={bundle.assessment.id} initial={{ assessmentDate: bundle.assessment.assessmentDate, status: bundle.assessment.status, overallConfidence: bundle.assessment.overallConfidence, notes: bundle.assessment.notes, contingencyPct: bundle.assessment.contingencyPct }} />
      <div className="split">
        <div className="stack">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Component</th><th>Condition</th><th>Urgency</th><th>Consequence</th><th>Escalation</th><th>Priority</th><th>Base cost</th></tr></thead>
              <tbody>
                {bundle.components.map((component) => {
                  const priority = calculatePriority(scoreInput(component), bundle.assessment.weights, bundle.assessment.thresholds);
                  const cost = componentCost(component);
                  const review = requiresPriorityReview(scoreInput(component));
                  return (
                    <tr key={component.id}>
                      <td><a href={`#group-${component.groupCode}`}>{component.groupCode}. {component.groupName}</a>{review ? " · review" : ""}</td>
                      <td>{component.conditionUnknown ? "Unknown" : component.conditionScore ?? "—"}</td>
                      <td>{component.urgencyUnknown ? "Unknown" : component.urgencyScore ?? "—"}</td>
                      <td>{component.consequenceUnknown ? "Unknown" : component.consequenceScore ?? "—"}</td>
                      <td>{component.escalationUnknown ? "Unknown" : component.escalationScore ?? "—"}</td>
                      <td>{priority.score == null ? "Not calculated" : `${priority.score} ${priority.band}`}</td>
                      <td>{formatChfRange(cost.low, cost.high)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {bundle.components.map((component) => {
            const open = component.groupCode === "E" || component.groupCode === "G";
            const cost = componentCost(component);
            const planning = cost.low != null && cost.high != null ? applyContingency(cost.low, cost.high, bundle.assessment.contingencyPct) : null;
            const window = component.installationYear && component.usefulLifeLow && component.usefulLifeHigh ? suggestPlanningWindow(component.installationYear, component.usefulLifeLow, component.usefulLifeHigh, year) : null;
            return (
              <details key={component.updatedAt + component.id} id={`group-${component.groupCode}`} className="group" open={open}>
                <summary>{component.groupCode}. {component.groupName}</summary>
                {planning && component.groupCode === "E" ? <p>Heating base {formatChfRange(cost.low, cost.high)}. Planning range at {bundle.assessment.contingencyPct}% contingency: {formatChfRange(planning.planningLow, planning.planningHigh)}.</p> : null}
                {window ? <p className="muted">{window.text}</p> : null}
                <ComponentForm assessmentId={bundle.assessment.id} component={component} weights={bundle.assessment.weights} thresholds={bundle.assessment.thresholds} contingencyPct={bundle.assessment.contingencyPct} currentYear={year} isAdmin={user.role === "admin"} />
                <h3>Photos</h3>
                <p className="muted">Photos are stored for evidence. They are not diagnosed automatically.</p>
                <ul>{bundle.photos.filter((photo) => photo.componentId === component.id).map((photo) => <li key={photo.id}>{photo.caption || "Untitled"} — <a href={`/api/files/photos/${photo.id}`}>view</a></li>)}</ul>
                <PhotoUpload componentId={component.id} />
              </details>
            );
          })}
          <section className="stack">
            <h2>Cost model by scenario</h2>
            <p className="muted">Totals sum intervention base ranges. Contingency is applied afterwards and is not inside the unit costs.</p>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Scenario</th><th className="num">Base</th><th className="num">Contingency</th><th className="num">Planning range</th></tr></thead>
                <tbody>
                  {scenarios.map((scenario) => (
                    <tr key={scenario.key}>
                      <td>{scenario.key}</td>
                      <td className="num">{formatChfRange(scenario.totals.low, scenario.totals.high)}</td>
                      <td className="num">{formatChfRange(scenario.planning.contingencyLow, scenario.planning.contingencyHigh)}</td>
                      <td className="num">{formatChfRange(scenario.planning.planningLow, scenario.planning.planningHigh)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="stack">
            <h2>Interventions</h2>
            {bundle.coordination.map((message) => <p key={message} className="msg warn">{message}</p>)}
            {bundle.interventions.map((intervention) => (
              <InterventionForm key={intervention.updatedAt + intervention.id} assessmentId={bundle.assessment.id} initial={intervention} components={bundle.components.map((component) => ({ id: component.id, groupName: component.groupName }))} />
            ))}
            <h3>Add intervention</h3>
            <InterventionForm assessmentId={bundle.assessment.id} initial={null} components={bundle.components.map((component) => ({ id: component.id, groupName: component.groupName }))} />
          </section>
          <section>
            <h2>Energy / modernization</h2>
            <EnergyForm assessmentId={bundle.assessment.id} initial={bundle.energy} />
          </section>
        </div>
        <aside className="panel stack">
          <h2>Draft assistant</h2>
          <p className="msg warn">{bundle.assistant.label}</p>
          <h3>Missing information</h3>
          <ul>{bundle.assistant.missing.slice(0, 12).map((item) => <li key={item}>{item}</li>)}</ul>
          <h3>Suggested questions</h3>
          <ul>{bundle.assistant.questions.slice(0, 8).map((item) => <li key={item}>{item}</li>)}</ul>
          <h3>Draft findings</h3>
          <ul>{bundle.assistant.findings.slice(0, 8).map((item) => <li key={item}>{item}</li>)}</ul>
          <h3>Draft client explanation</h3>
          {bundle.assistant.clientExplanation.map((item) => <p key={item}>{item}</p>)}
          <h3>Possible dependencies</h3>
          <ul>{bundle.assistant.dependencies.length === 0 ? <li>None from the entered interventions.</li> : bundle.assistant.dependencies.map((item) => <li key={item}>{item}</li>)}</ul>
        </aside>
      </div>
    </div>
  );
}
