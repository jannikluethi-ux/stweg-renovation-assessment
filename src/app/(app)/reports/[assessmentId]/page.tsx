import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { buildBundleReport, loadBundle } from "@/lib/repo";
import { latestReportVersion } from "@/lib/mutations";
import { PrintButton } from "@/components/misc-forms";
import type { Block } from "@/domain/report";

function BlockView({ block }: { block: Block }) {
  if (block.type === "p") return <p>{block.text}</p>;
  if (block.type === "h3") return <h3>{block.text}</h3>;
  if (block.type === "note") return <p className={block.tone === "warning" ? "msg warn" : "msg"}>{block.text}</p>;
  if (block.type === "kv") {
    return (
      <div className="table-wrap">
        <table className="data"><tbody>{block.rows.map((row) => <tr key={row.label}><th>{row.label}</th><td>{row.value}</td></tr>)}</tbody></table>
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr>{block.headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
        <tbody>{block.rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export default async function ReportPage({ params }: { params: Promise<{ assessmentId: string }> }) {
  const user = await requireUser();
  const { assessmentId } = await params;
  const bundle = loadBundle(user.organizationId, assessmentId, "moderate");
  if (!bundle) notFound();
  const released = latestReportVersion(assessmentId);
  let failure = "";
  let model = null as ReturnType<typeof buildBundleReport> | null;
  try {
    model = buildBundleReport(bundle, Math.max(released, 1));
  } catch (error) {
    failure = error instanceof Error ? error.message : "The report totals do not reconcile.";
  }
  return (
    <div className="stack">
      <div className="row no-print">
        <PrintButton />
        <a className="btn secondary" href={`/api/reports/${assessmentId}/html`}>Download HTML</a>
        <Link href={`/assessments/${assessmentId}/quality`}>Quality check</Link>
      </div>
      {bundle.property.isDemo ? <p className="banner">DEMO / synthetic data. Not market data and not an engineering certificate.</p> : null}
      {released === 0 ? <p className="msg warn no-print">Preview only. Release the report from the quality check after errors are cleared and warnings are acknowledged.</p> : <p className="msg ok no-print">Released report v{released}. This page shows the current stored assessment.</p>}
      {bundle.quality.errors.length ? <div className="msg error"><strong>Not released — quality errors remain.</strong><ul>{bundle.quality.errors.map((error) => <li key={error}>{error}</li>)}</ul></div> : null}
      {failure ? <p className="msg error">{failure} No figures were adjusted to force a total.</p> : null}
      {model ? (
        <article className="report">
          {model.sections.map((section) => (
            <section key={section.id} id={section.id}>
              <h2>{section.title}</h2>
              {section.blocks.map((block, index) => <BlockView key={index} block={block} />)}
              {section.id === "appendix" ? (
                <div className="stack">
                  {bundle.photos.map((photo) => (
                    <figure key={photo.id}>
                      <img src={`/api/files/photos/${photo.id}`} alt={photo.caption || "Component photograph"} style={{ maxWidth: "280px" }} />
                      <figcaption>{photo.caption || "No caption"}</figcaption>
                    </figure>
                  ))}
                </div>
              ) : null}
            </section>
          ))}
        </article>
      ) : null}
    </div>
  );
}
