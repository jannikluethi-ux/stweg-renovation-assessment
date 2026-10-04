import { requireUser } from "@/lib/auth";
import { listLeads, listProperties } from "@/lib/repo";
import { formatChfPlain, formatIsoDateTimeSwiss } from "@/domain/calculations";
import { LeadForm } from "@/components/misc-forms";

export default async function LeadsPage() {
  const user = await requireUser();
  const leads = listLeads(user.organizationId);
  const properties = listProperties(user.organizationId, {}).map((property) => ({ id: property.id, name: property.name }));
  return (
    <div className="stack">
      <h1>Leads</h1>
      <p className="lede">A simple pipeline for the service. It does not create invoices or accounting entries.</p>
      <LeadForm initial={null} properties={properties} />
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Name</th><th>Organization</th><th>Contact</th><th>Source</th><th>Stage</th><th>Opportunity</th><th>Next action</th><th>Updated</th></tr></thead>
          <tbody>
            {leads.map((lead) => (
              <tr key={lead.id}>
                <td>{lead.name}<div className="muted">{lead.notes}</div></td>
                <td>{lead.leadOrganization || "—"}</td>
                <td>{lead.contact || "—"}</td>
                <td>{lead.source || "—"}</td>
                <td>{lead.stage}</td>
                <td>{formatChfPlain(lead.estimatedOpportunity)}</td>
                <td>{lead.nextAction || "—"}</td>
                <td>{formatIsoDateTimeSwiss(lead.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
