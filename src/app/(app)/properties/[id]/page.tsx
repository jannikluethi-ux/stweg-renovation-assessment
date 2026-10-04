import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getProfile, getProperty, latestAssessmentId, listDocuments, loadBundle } from "@/lib/repo";
import { cantonName } from "@/domain/constants";
import { formatIsoDateSwiss } from "@/domain/calculations";
import { PropertyForm } from "@/components/property-forms";
import { propertyToWrite } from "@/lib/property-form-defaults";
import { StartAssessmentButton } from "@/components/misc-forms";

export default async function PropertyPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const property = getProperty(user.organizationId, id);
  if (!property) notFound();
  const assessmentId = latestAssessmentId(user.organizationId, id);
  const bundle = assessmentId ? loadBundle(user.organizationId, assessmentId) : null;
  const profile = getProfile(id);
  const documents = listDocuments(user.organizationId, id);
  return (
    <div className="stack">
      {property.isDemo ? <p className="banner">DEMO / synthetic data for workflow demonstration. Not a real inspection and not market data.</p> : null}
      <h1>{property.name}</h1>
      <p className="lede">{property.street}, {property.zip} {property.municipality}, {cantonName(property.canton)} ({property.canton}), {property.country}. Built {property.yearBuilt ?? "unknown"}. {property.units ?? "—"} apartments, {property.buildings ?? "—"} buildings, {property.floors ?? "—"} floors.</p>
      <div className="row">
        {assessmentId ? <Link className="btn" href={`/assessments/${assessmentId}`}>Open assessment</Link> : <StartAssessmentButton propertyId={property.id} />}
        <Link className="btn secondary" href={`/properties/${property.id}/profile`}>Building profile</Link>
        <Link className="btn secondary" href={`/documents?property=${property.id}`}>Documents ({documents.length})</Link>
        {assessmentId ? <Link className="btn secondary" href={`/properties/${property.id}/financial`}>Financial model</Link> : null}
        {assessmentId ? <Link className="btn secondary" href={`/roadmaps/${assessmentId}`}>Roadmap</Link> : null}
        {assessmentId ? <Link className="btn secondary" href={`/assessments/${assessmentId}/quality`}>Quality check</Link> : null}
        {assessmentId ? <Link className="btn secondary" href={`/reports/${assessmentId}`}>Report</Link> : null}
      </div>
      {bundle ? (
        <>
          <section className="panel">
            <h2>Assessment completeness {bundle.completeness.overall}%</h2>
            <ul>
              <li>Property data: {bundle.completeness.propertyData}%</li>
              <li>Building envelope: {bundle.completeness.envelope}%</li>
              <li>Technical systems: {bundle.completeness.technical}%</li>
              <li>Common areas: {bundle.completeness.common}%</li>
              <li>Financial data: {bundle.completeness.financial}%</li>
              <li>Documentation: {bundle.completeness.documentation}%</li>
            </ul>
            {Object.entries({ "Property data": bundle.completeness.propertyData, "Building envelope": bundle.completeness.envelope, "Technical systems": bundle.completeness.technical, "Financial data": bundle.completeness.financial, Documentation: bundle.completeness.documentation }).map(([label, value]) => (
              <p key={label}>{label}<span className="bar"><i style={{ width: `${value}%` }} /></span></p>
            ))}
          </section>
          <section>
            <h2>Planning Health Indicator</h2>
            <p className="muted">Five separate dimensions. This is not a safety rating, an engineering certificate, or a property value.</p>
            <div className="health">
              {bundle.health.map((dimension) => (
                <article key={dimension.key} className="card">
                  <h3>{dimension.label}</h3>
                  <b>{dimension.score == null ? "Unknown" : dimension.score}</b>
                  <p className="muted">{dimension.note}</p>
                </article>
              ))}
            </div>
          </section>
          <section>
            <h2>Versions</h2>
            <ul>{bundle.versions.map((version) => <li key={version.id}><Link href={`/assessments/${version.id}`}>Version {version.version}</Link> — {version.status}, {formatIsoDateSwiss(version.assessmentDate)}</li>)}</ul>
          </section>
        </>
      ) : <p>No assessment has been started. The profile can still be completed.</p>}
      <section>
        <h2>Profile snapshot</h2>
        <p className="muted">{profile.filter((field) => field.status === "unknown").length} fields are explicitly unknown.</p>
      </section>
      <section className="panel">
        <h2>Edit property record</h2>
        <PropertyForm mode="edit" propertyId={property.id} initial={propertyToWrite(property)} />
      </section>
    </div>
  );
}
