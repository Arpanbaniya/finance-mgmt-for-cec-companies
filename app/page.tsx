import Link from "next/link";
import { ArrowUpRight, ArrowRight, Building2, ClipboardCheck, Wallet, Check, ShieldCheck } from "lucide-react";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { releases } from "@/features/platform/releases";

export default function Home() {
  return <div className="mx-auto max-w-[1400px] px-5 sm:px-10 lg:px-16">
    <header className="flex min-h-24 items-center justify-between gap-3 border-b"><Brand /><nav className="flex items-center gap-4 sm:gap-8" aria-label="Main navigation"><Link href="/roadmap" className="hidden text-sm text-muted-foreground hover:text-foreground sm:block">Build roadmap</Link><Button asChild variant="outline" size="sm"><Link href="/sign-in">Sign in <ArrowUpRight className="size-4" /></Link></Button></nav></header>
    <main>
      <section className="grid gap-12 py-16 sm:py-24 lg:grid-cols-[1.15fr_1fr] lg:items-center lg:gap-20">
        <div><Badge variant="outline" className="gap-2 border-primary/30 text-primary"><span className="size-1.5 rounded-full bg-primary" />PHASE 1 · FOUNDATION</Badge>
          <h1 className="mt-7 max-w-2xl text-5xl font-medium leading-[1.08] tracking-[-0.045em] sm:text-6xl lg:text-7xl">Your work.<br />Your books.<br /><span className="text-primary">One clear picture.</span></h1>
          <p className="mt-7 max-w-md text-base leading-7 text-muted-foreground">Finance and workforce operations, built for Nepal. Connect every amount to the people, work and evidence behind it.</p>
          <div className="mt-9 flex flex-wrap items-center gap-4"><Button asChild size="lg"><Link href="/workspace">Open workspace <ArrowRight className="ml-2 size-4" /></Link></Button><Link href="/roadmap" className="text-sm text-muted-foreground hover:text-foreground">See what we’re building</Link></div>
          <p className="mt-5 text-xs text-muted-foreground">First release under development · NPR · Nepal business dates</p>
        </div>
        <div className="rounded-2xl border bg-card p-6 sm:p-8"><div className="mb-8 flex items-start justify-between"><div><p className="text-xs uppercase tracking-[.16em] text-muted-foreground">The operating system</p><h2 className="mt-2 text-xl font-medium">Work to financial clarity</h2></div><ShieldCheck className="size-6 text-primary" /></div>
          {[{ icon: Building2, label: "Company & permissions", detail: "Separate legal entities and scoped access", state: "Foundation" }, { icon: ClipboardCheck, label: "Workforce & approvals", detail: "Attendance feeds pay and billing independently", state: "Next slices" }, { icon: Wallet, label: "Books & cash", detail: "Trace profit, collections and payroll funding", state: "Next slices" }].map((item, index) => <div key={item.label} className={`flex gap-4 py-6 ${index < 2 ? "border-b" : ""}`}><div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-primary"><item.icon size={19} /></div><div className="min-w-0 flex-1"><h3 className="text-sm font-medium">{item.label}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{item.detail}</p></div><span className="text-[10px] uppercase tracking-wider text-muted-foreground">{item.state}</span></div>)}
          <div className="mt-6 flex items-center gap-2 rounded-lg bg-muted p-3 text-xs text-muted-foreground"><Check className="size-4 shrink-0 text-primary" />Exact accounting. Preserved history. Evidence at every step.</div>
        </div>
      </section>
      <section className="border-t py-12"><div className="mb-7 flex items-end justify-between gap-4"><div><p className="text-xs uppercase tracking-[.16em] text-primary">The build sequence</p><h2 className="mt-2 text-2xl font-medium tracking-tight">One foundation. Four releases.</h2></div><Link href="/roadmap" className="hidden items-center gap-2 text-sm text-muted-foreground sm:flex">View roadmap <ArrowUpRight size={16} /></Link></div><div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">{releases.map(r => <article key={r.number} className="border-t pt-5"><div className="flex justify-between font-mono text-xs text-muted-foreground"><span>R{r.number}</span><span className={r.number === "01" ? "text-primary" : ""}>{r.status}</span></div><h3 className="mt-4 font-medium">{r.name}</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">{r.description}</p></article>)}</div></section>
    </main><footer className="flex flex-wrap justify-between gap-3 border-t py-6 text-xs text-muted-foreground"><span>KaamLedger · Built around your business.</span><span>Phase 1 foundation · No live financial data</span></footer>
  </div>;
}
