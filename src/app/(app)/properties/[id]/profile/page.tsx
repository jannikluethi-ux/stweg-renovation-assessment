import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getProfile, getProperty } from "@/lib/repo";
import { ProfileForm } from "@/components/property-forms";

export default async function ProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const property = getProperty(user.organizationId, id);
  if (!property) notFound();
  return (
    <div className="stack">
      <h1>Building profile — {property.name}</h1>
      <p className="lede">Construction, technical systems and common areas. Unknown and not applicable are valid answers.</p>
      <ProfileForm propertyId={property.id} initial={getProfile(property.id)} />
    </div>
  );
}
