import { Badge } from "@/components/ui/badge";
import type { SeverityTone } from "@/lib/format";

export function ToneBadge({ tone, label }: { tone: SeverityTone; label: string }) {
  const variant =
    tone === "critical" ? "destructive" : tone === "warning" ? "secondary" : "outline";
  return <Badge variant={variant}>{label}</Badge>;
}
