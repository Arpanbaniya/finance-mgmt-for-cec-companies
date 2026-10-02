"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
export function SignInForm() {
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const router = useRouter();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(""); const values = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/sign-in/email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: values.get("email"), password: values.get("password") }) });
      if (!response.ok) { setError(response.status === 429 ? "Too many attempts. Wait a minute and try again." : "Sign-in failed. Check your email and password."); return; }
      router.push("/workspace"); router.refresh();
    } catch { setError("Could not reach the server. Check your connection and try again."); } finally { setPending(false); }
  }
  return <form onSubmit={submit} className="space-y-5"><div className="space-y-2"><Label htmlFor="email">Email</Label><Input id="email" name="email" type="email" autoComplete="username" required /></div><div className="space-y-2"><Label htmlFor="password">Password</Label><Input id="password" name="password" type="password" autoComplete="current-password" required /></div>{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}<Button className="w-full" type="submit" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</Button></form>;
}
