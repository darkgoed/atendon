import { redirect } from "next/navigation";

// Canonical route: the library now lives with follow-up automation.
export default function LegacyStickersRoute() {
  redirect("/follow-ups");
}
