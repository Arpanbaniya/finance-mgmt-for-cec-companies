import Link from "next/link";
import { Layers2 } from "lucide-react";
export function Brand() {
  return <Link href="/" className="inline-flex items-center gap-3 font-semibold tracking-tight" aria-label="KaamLedger home"><span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Layers2 size={20} aria-hidden="true" /></span><span className="text-xl">KaamLedger<span className="ml-1 text-primary">.</span></span></Link>;
}
