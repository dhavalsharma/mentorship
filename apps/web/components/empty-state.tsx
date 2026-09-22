/** Shared placeholder for a dashboard list page with nothing (or an error) to show. */
export function EmptyState({ message }: { message: string }) {
  return (
    <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
      {message}
    </p>
  );
}
