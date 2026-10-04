import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { loadDashboard } from "@/lib/repo";
import { formatChfRange, formatIsoDateSwiss, formatIsoDateTimeSwiss } from "@/domain/calculations";

export default async function DashboardPage() {
  const user = await requireUser();
  const data = loadDashboard(user.organizationId);
  return (
    <div className="stack">
      <h1>Dashboard</h1>
      <p className="lede">Figures below are calculated from stored properties and the latest assessment of each one. They are indicative planning ranges, not quotations and not a safety rating.</p>
      <section className="grid-stats">
        <article className="card stat"><span>Properties</span><b>{data.propertyCount}</b></article>
        <article className="card stat"><span>Active assessments</span><b>{data.activeAssessments}</b></article>
        <article className="card stat"><span>Requiring review</span><b>{data.reviewAssessments}</b></article>
        <article className="card stat"><span>Completed assessments</span><b>{data.completedAssessments}</b></article>
        <article className="card stat"><span>High renovation risk</span><b>{data.highRiskProperties}</b></article>
        <article className="card stat"><span>Indicative future exposure (moderate, base)</span><b>{formatChfRange(data.exposureLow, data.exposureHigh)}</b></article>
      </section>
      <p className="muted">Planning budget range including contingency, still shown separately from the base: {formatChfRange(data.planningLow, data.planningHigh)}. Subject to technical inspection, tender and market conditions.</p>
      <section className="stack">
        <h2>Planning Health Indicator</h2>
        {data.properties.length === 0 ? <p>No properties yet.</p> : data.properties.map((property) => (
          <article key={property.id} className="panel">
            <h3><Link href={`/properties/${property.id}`}>{property.name}</Link> · {property.municipality} {property.canton}</h3>
            {property.isDemo ? <p className="banner">DEMO / synthetic data. Not market data.</p> : null}
            <p>Assessment completeness {property.completeness}%.</p>
            <div className="health">
              {property.health.map((dimension) => (
                <div key={dimension.key} className="card">
                  <strong>{dimension.label}</strong>
                  <b>{dimension.score == null ? "Unknown" : dimension.score}</b>
                  <p className="muted">{dimension.note}</p>
                </div>
              ))}
            </div>
          </article>
        ))}
      </section>
      <section className="table-wrap">
        <table className="data">
          <caption>High-priority components</caption>
          <thead><tr><th>Property</th><th>Component</th><th>Priority</th></tr></thead>
          <tbody>
            {data.highPriorityComponents.length === 0 ? <tr><td colSpan={3}>None on the latest assessments.</td></tr> : data.highPriorityComponents.map((item) => (
              <tr key={`${item.assessmentId}-${item.name}`}><td><Link href={`/properties/${item.propertyId}`}>{item.propertyName}</Link></td><td><Link href={`/assessments/${item.assessmentId}`}>{item.name}</Link></td><td>{item.priority}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      <div className="fields">
        <section className="panel">
          <h2>Interventions within 3 years</h2>
          <ul>{data.soonInterventions.length === 0 ? <li>None.</li> : data.soonInterventions.map((item) => <li key={`${item.assessmentId}-${item.title}`}>{item.year}: {item.title} — {item.propertyName}</li>)}</ul>
        </section>
        <section className="panel">
          <h2>Reserve-fund gaps</h2>
          <ul>{data.reserveGaps.length === 0 ? <li>No projected funding gap on the latest assessments.</li> : data.reserveGaps.map((item) => <li key={item.assessmentId}>{item.propertyName}: projected funding gap from {item.year}</li>)}</ul>
        </section>
        <section className="panel">
          <h2>Assessments overdue for update</h2>
          <ul>{data.overdue.length === 0 ? <li>None older than 12 months.</li> : data.overdue.map((item) => <li key={item.assessmentId}>{item.propertyName}: {formatIsoDateSwiss(item.assessmentDate)}</li>)}</ul>
        </section>
        <section className="panel">
          <h2>Recent activity</h2>
          <ul>{data.activity.length === 0 ? <li>No activity yet.</li> : data.activity.map((item) => <li key={item.id}>{formatIsoDateTimeSwiss(item.timestamp)} — {item.actor} {item.action.replaceAll("_", " ")} {item.entity}</li>)}</ul>
        </section>
      </div>
      <section className="row">
        <h2 className="wide">Quick actions</h2>
        <Link className="btn" href="/properties/new">New property</Link>
        <Link className="btn secondary" href="/properties">Start assessment</Link>
        <Link className="btn secondary" href="/documents">Upload documents</Link>
        <Link className="btn secondary" href="/reports">Generate report</Link>
      </section>
    </div>
  );
}
