import { PropertyForm } from "@/components/property-forms";
import { propertyToWrite } from "@/lib/property-form-defaults";

export default function NewPropertyPage() {
  return (
    <div className="stack">
      <h1>New property</h1>
      <p className="lede">Country defaults to Switzerland. Leave a count empty if it is unknown. Do not invent it.</p>
      <PropertyForm mode="create" initial={propertyToWrite()} />
    </div>
  );
}
