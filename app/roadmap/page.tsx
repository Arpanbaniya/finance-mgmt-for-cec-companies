import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Brand } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { releases } from "@/features/platform/releases";
export const metadata = { title: "Build roadmap" };
export default function Roadmap() {
  return <main className="mx-auto max-w-4xl px-5 py-10 sm:px-10"><Brand /><Link href="/" className="mt-10 flex items-center gap-2 text-sm text-muted-foreground"><ArrowLeft size={16} />Back to home</Link><p className="mt-12 text-xs uppercase tracking-widest text-primary">Product roadmap</p><h1 className="mt-3 text-4xl font-medium tracking-tight">Build the foundation.<br />Then extend the business.</h1><p className="mt-5 max-w-xl leading-7 text-muted-foreground">Each release has accounting, security and business acceptance gates. The first deployment establishes company setup and access; the remaining Phase 1 workflows follow in order.</p>
    <div className="mt-12">{releases.map(r => <section key={r.number} className="grid gap-4 border-t py-8 sm:grid-cols-[80px_1fr]"><span className="font-mono text-2xl text-muted-foreground">{r.number}</span><div><div className="flex flex-wrap items-center gap-3"><h2 className="text-xl font-medium">{r.name}</h2><Badge variant={r.number === "01" ? "default" : "outline"}>{r.status}</Badge></div><p className="mt-3 leading-7 text-muted-foreground">{r.description}</p><p className="mt-4 font-mono text-xs text-muted-foreground">{r.tasks} planned work packages · Acceptance evidence required</p></div></section>)}</div><p className="border-t py-6 text-sm text-muted-foreground">R5 is optional future scope: portals, worker self-service, statutory integrations and reviewed AI assistance.</p>
  </main>;
}
