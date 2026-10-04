import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listProperties } from "@/lib/repo";
import { cantonName } from "@/domain/constants";
import { PropertyFilters } from "@/components/misc-forms";

export default async function PropertiesPage({ searchParams }: { searchParams: Promise<{ q?: string; canton?: string; status?: string; municipality?: string }> }) {
  const user = await requireUser();
  const query = await searchParams;
  const properties = listProperties(user.organizationId, query);
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Properties</h1>
        <Link className="btn" href="/properties/new">New property</Link>
      </div>
      <PropertyFilters q={query.q ?? ""} canton={query.canton ?? ""} status={query.status ?? ""} municipality={query.municipality ?? ""} />
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Name</th><th>Municipality</th><th>Canton</th><th>Year</th><th>Units</th><th>Status</th></tr></thead>
          <tbody>
            {properties.length === 0 ? <tr><td colSpan={6}>No properties match this filter.</td></tr> : properties.map((property) => (
              <tr key={property.id}>
                <td><Link href={`/properties/${property.id}`}>{property.name}</Link>{property.isDemo ? " · DEMO" : ""}</td>
                <td>{property.municipality}</td>
                <td>{property.canton} {cantonName(property.canton)}</td>
                <td>{property.yearBuilt ?? "—"}</td>
                <td>{property.units ?? "—"}</td>
                <td>{property.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
