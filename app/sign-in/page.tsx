import Link from "next/link";
import { Brand } from "@/components/brand";
import { configured } from "@/db/client";
import { SignInForm } from "@/features/identity/sign-in-form";
import { Card, CardContent } from "@/components/ui/card";
export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };
export default function SignIn() {
  return <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-9 px-5 py-10"><Brand /><Card><CardContent className="pt-6"><p className="text-xs uppercase tracking-wider text-primary">Company workspace</p><h1 className="mt-3 text-2xl font-medium">Welcome back.</h1><p className="mb-7 mt-3 text-sm leading-6 text-muted-foreground">Use the account supplied by your organization administrator.</p>{configured() ? <SignInForm /> : <div className="rounded-lg border bg-muted p-4"><h2 className="font-medium">Workspace setup is in progress</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">Sign-in will be available once the hosted database and administrator account are configured.</p></div>}</CardContent></Card><Link href="/" className="text-sm text-muted-foreground">← Back to KaamLedger</Link></main>;
}
