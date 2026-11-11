import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/privacy")({
  head: () => ({ meta: [{ title: "Privacy Policy — Fleet" }, { name: "description", content: "How Fleet handles your data." }] }),
  component: PrivacyPage,
});

// NOTE: This is a plain-language policy describing what the app actually does.
// Have it reviewed by counsel and fill in the contact details before relying on it.
const CONTACT = "privacy@your-domain.example";

function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 text-sm leading-relaxed">
      <Link to="/auth" className="text-xs text-muted-foreground hover:underline">← Back</Link>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">Privacy Policy</h1>
      <p className="mt-2 text-muted-foreground">Last updated: 10 November 2026</p>

      <Section title="What we collect">
        <ul className="list-disc space-y-1 pl-5">
          <li><b>Account data:</b> your email address and a hashed password (we never see or store your plain password).</li>
          <li><b>Server inventory you add:</b> server names, tags, type/region/instance ID, connection notes, and — reported by the agent you install — hostname, IP address and operating system.</li>
          <li><b>Operational data:</b> CPU, memory, disk, network and load metrics; commands you run, their output and exit codes; interactive terminal input and output; automation playbooks and run logs; cost figures you enter.</li>
          <li><b>Technical data:</b> IP address and request metadata in hosting and security logs; authentication tokens in your browser's local storage.</li>
        </ul>
        <p className="mt-2">Command and terminal output can contain anything your servers print, including sensitive information. Do not run commands that print secrets you don't want stored.</p>
      </Section>

      <Section title="Why we use it">
        To provide the service (authenticate you, show your fleet, deliver commands to your agents), keep it secure (abuse and fraud prevention, rate limiting), and fix problems. We do not sell personal data or use it for advertising.
      </Section>

      <Section title="Who processes it">
        <ul className="list-disc space-y-1 pl-5">
          <li><b>Supabase</b> — database and authentication hosting.</li>
          <li><b>Our hosting provider</b> — serves the app and runs its API.</li>
          <li><b>Cloudflare Turnstile</b> — bot protection on sign-in forms, where enabled.</li>
          <li><b>Google Fonts</b> — serves fonts; your browser contacts Google when loading the page.</li>
        </ul>
      </Section>

      <Section title="Cookies and storage">
        We use only strictly necessary browser storage (your sign-in session and theme preference). We do not use analytics or advertising cookies.
      </Section>

      <Section title="Retention and deletion">
        Your data is kept while your account is active. Deleting a server removes its metrics, commands and terminal sessions. To delete your account and all associated data, contact us at the address below.
      </Section>

      <Section title="Your rights (GDPR / UK GDPR / CCPA)">
        Depending on where you live you may have the right to access, correct, export or delete your data, to object to or restrict processing, and (California) to know what is collected and to opt out of any sale or sharing — we do neither. Contact <a className="underline" href={`mailto:${CONTACT}`}>{CONTACT}</a> to exercise these rights. You may also complain to your local data-protection authority.
      </Section>

      <Section title="Security">
        Data is encrypted in transit, access to your data is restricted to your account by database row-level security, and agent tokens are secret per server. No system is perfectly secure; report issues to the contact above.
      </Section>

      <Section title="Changes">
        We'll update this page and its date when this policy changes.
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-2 text-muted-foreground">{children}</div>
    </section>
  );
}
