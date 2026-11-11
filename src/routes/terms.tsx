import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/terms")({
  head: () => ({ meta: [{ title: "Terms of Service — Fleet" }] }),
  component: TermsPage,
});

// NOTE: Starter terms. Have counsel review before relying on them.
function TermsPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 text-sm leading-relaxed">
      <Link to="/auth" className="text-xs text-muted-foreground hover:underline">← Back</Link>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">Terms of Service</h1>
      <p className="mt-2 text-muted-foreground">Last updated: 10 November 2026</p>
      <div className="mt-6 space-y-4 text-muted-foreground">
        <p><b>Use of the service.</b> Fleet lets you monitor servers and run commands on machines you own or are authorised to administer. You are solely responsible for the commands you run and for the servers you connect.</p>
        <p><b>Your account.</b> Keep your credentials and agent tokens secret. Anyone with an agent token can report data for that server; anyone with your account can run commands on every server in it. Tell us promptly about any suspected compromise.</p>
        <p><b>Acceptable use.</b> Do not use the service to attack, disrupt or access systems you do not own or have permission to access, to evade the rate limits, or to store unlawful content.</p>
        <p><b>Availability and liability.</b> The service is provided "as is" without warranties. To the extent permitted by law we are not liable for data loss, downtime, or damage caused by commands executed through the service.</p>
        <p><b>Privacy.</b> See our <Link to="/privacy" className="underline">Privacy Policy</Link>.</p>
      </div>
    </main>
  );
}
