import type { PropertyDTO } from "@/domain/dto";
import type { PropertyWrite } from "@/lib/mutations";

export function propertyToWrite(property?: PropertyDTO): PropertyWrite {
  return {
    name: property?.name ?? "",
    street: property?.street ?? "",
    zip: property?.zip ?? "",
    municipality: property?.municipality ?? "",
    canton: property?.canton ?? "ZH",
    country: property?.country || "Switzerland",
    yearBuilt: property?.yearBuilt ?? null,
    yearFirstOccupation: property?.yearFirstOccupation ?? null,
    buildings: property?.buildings ?? null,
    units: property?.units ?? null,
    owners: property?.owners ?? null,
    floors: property?.floors ?? null,
    basementPresent: property?.basementPresent ?? "unknown",
    undergroundParking: property?.undergroundParking ?? "unknown",
    outdoorParking: property?.outdoorParking ?? "unknown",
    hasLift: property?.hasLift ?? "unknown",
    balconyTerrace: property?.balconyTerrace ?? "unknown",
    garden: property?.garden ?? "unknown",
    status: property?.status ?? "active",
  };
}
