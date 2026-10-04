import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listDocuments, listProperties } from "@/lib/repo";
import { categoryLabel, DOCUMENT_CATEGORIES } from "@/domain/constants";
import { formatIsoDateSwiss } from "@/domain/calculations";
import { DocumentUpload } from "@/components/misc-forms";

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<{ property?: string; category?: string }> }) {
  const user = await requireUser();
  const query = await searchParams;
  const properties = listProperties(user.organizationId, {});
  const documents = listDocuments(user.organizationId, query.property ?? "", query.category ?? "");
  return (
    <div className="stack">
      <h1>Documents</h1>
      <p className="lede">Files stay in private storage and are not published. Allowed types: PDF, JPG, JPEG, PNG, DOCX, XLSX.</p>
      <DocumentUpload properties={properties.map((property) => ({ id: property.id, name: property.name }))} />
      <form className="row" method="get">
        <label>Property
          <select name="property" defaultValue={query.property ?? ""}>
            <option value="">All</option>
            {properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}
          </select>
        </label>
        <label>Category
          <select name="category" defaultValue={query.category ?? ""}>
            <option value="">All</option>
            {DOCUMENT_CATEGORIES.map((category) => <option key={category.key} value={category.key}>{category.label}</option>)}
          </select>
        </label>
        <button className="btn secondary" type="submit">Filter</button>
      </form>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Name</th><th>Category</th><th>Property</th><th>Uploaded</th><th>Document date</th><th>Source</th></tr></thead>
          <tbody>
            {documents.length === 0 ? <tr><td colSpan={6}>No documents stored.</td></tr> : documents.map((document) => (
              <tr key={document.id}>
                <td><a href={`/api/files/documents/${document.id}`}>{document.originalName}</a><div className="muted">{document.description}</div></td>
                <td>{categoryLabel(document.category)}</td>
                <td><Link href={`/properties/${document.propertyId}`}>{document.propertyName}</Link></td>
                <td>{formatIsoDateSwiss(document.uploadDate)}</td>
                <td>{formatIsoDateSwiss(document.documentDate)}</td>
                <td>{document.source || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
