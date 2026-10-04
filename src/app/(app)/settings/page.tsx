import { requireUser } from "@/lib/auth";
import { getBranding, getSettings, listAudit, listCostAssumptions, listUsefulLife, listUsers } from "@/lib/repo";
import { formatIsoDateTimeSwiss } from "@/domain/calculations";
import { SettingsForms } from "@/components/misc-forms";

export default async function SettingsPage() {
  const user = await requireUser();
  const branding = getBranding(user.organizationId);
  const settings = getSettings(user.organizationId);
  return (
    <div className="stack">
      <h1>Settings</h1>
      <p className="lede">Weights, thresholds, contingency, disclaimer, cost assumptions and branding are stored for this organization. They are not hard-coded in the screens.</p>
      <SettingsForms
        isAdmin={user.role === "admin"}
        branding={{ companyName: branding.companyName, productName: branding.productName, address: branding.address, footer: branding.footer }}
        settings={settings}
        assumptions={listCostAssumptions(user.organizationId)}
        lives={listUsefulLife(user.organizationId)}
      />
      <section>
        <h2>Users</h2>
        <p className="muted">Inviting additional users is not in this version.</p>
        <ul>{listUsers(user.organizationId).map((person) => <li key={person.id}>{person.name} — {person.email} — {person.role}</li>)}</ul>
      </section>
      <section>
        <h2>Audit log</h2>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th></tr></thead>
            <tbody>
              {listAudit(user.organizationId, 50).map((entry) => (
                <tr key={entry.id}><td>{formatIsoDateTimeSwiss(entry.timestamp)}</td><td>{entry.actor}</td><td>{entry.action}</td><td>{entry.entity}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
