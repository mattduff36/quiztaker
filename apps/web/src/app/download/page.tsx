import { AlertTriangle, Archive, CheckCircle2, Download, ShieldAlert } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { PageFrame, Panel } from '@/components/page-frame';
import { requireAuthenticatedUser } from '@/lib/auth';
import { getLatestHelperRelease } from '@/lib/releases';

export const dynamic = 'force-dynamic';

export default async function DownloadPage() {
  const user = await requireAuthenticatedUser();
  const release = await getLatestHelperRelease();
  return (
    <AppShell email={user.email}>
      <PageFrame eyebrow="Windows 10/11 x64" title="Download helper" description="A portable Node runtime and local automation executors packaged as a per-user MSI inside a browser-friendly ZIP.">
        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <Panel className="overflow-hidden">
            <div className="bg-slate-950 p-7 text-white">
              <Archive className="size-9 text-cyan-300" />
              <h2 className="mt-5 text-3xl font-semibold tracking-tight">QuizTaker Helper</h2>
              <p className="mt-2 font-mono text-xs uppercase tracking-[0.18em] text-slate-400">
                {release ? `Version ${release.version}` : 'No published release yet'}
              </p>
            </div>
            <div className="p-7">
              {release ? (
                <a
                  href={release.downloadUrl}
                  className="inline-flex items-center gap-2 rounded-md bg-cyan-700 px-5 py-3 font-semibold text-white hover:bg-cyan-800"
                >
                  <Download className="size-4" />
                  Download Windows ZIP
                </a>
              ) : (
                <div className="inline-flex items-center gap-2 rounded-md bg-slate-200 px-5 py-3 font-semibold text-slate-500">
                  <AlertTriangle className="size-4" />
                  Release pending
                </div>
              )}
              <div className="mt-7 grid gap-4 sm:grid-cols-2">
                <Detail icon={<CheckCircle2 />} title="No admin service">Runs only in your interactive Windows session.</Detail>
                <Detail icon={<CheckCircle2 />} title="Chrome stays local">SSO cookies never leave your machine.</Detail>
              </div>
              {release?.sha256 ? (
                <div className="mt-6 rounded-md bg-slate-100 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">ZIP SHA-256</p>
                  <code className="mt-2 block break-all font-mono text-[11px] text-slate-700">{release.sha256}</code>
                </div>
              ) : null}
            </div>
          </Panel>
          <Panel title="Unsigned private release">
            <div className="p-6">
              <ShieldAlert className="size-7 text-amber-600" />
              <p className="mt-4 text-sm leading-6 text-slate-600">
                This build is intentionally unsigned. Windows SmartScreen or endpoint protection may require an expert override after extraction.
              </p>
              <ol className="mt-5 space-y-3 text-sm text-slate-700">
                <li><strong>1.</strong> Download and extract the ZIP.</li>
                <li><strong>2.</strong> Verify SHA-256 if required.</li>
                <li><strong>3.</strong> Run the MSI and use More info → Run anyway if prompted.</li>
                <li><strong>4.</strong> Start the helper and pair it from the Local helper page.</li>
              </ol>
            </div>
          </Panel>
        </div>
      </PageFrame>
    </AppShell>
  );
}

function Detail(props: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-sm">
      <span className="mt-0.5 text-emerald-600 [&_svg]:size-4">{props.icon}</span>
      <div><p className="font-semibold text-slate-950">{props.title}</p><p className="mt-1 text-slate-600">{props.children}</p></div>
    </div>
  );
}
