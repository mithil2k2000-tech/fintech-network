import { AppShell, ButtonLink, Card, EmptyState } from "@fintech-network/design-system";

export function NotFoundScreen() {
  return (
    <AppShell title="Not found" back="/">
      <Card>
        <EmptyState icon="info" title="This page doesn't exist">
          <ButtonLink to="/">Go home</ButtonLink>
        </EmptyState>
      </Card>
    </AppShell>
  );
}
