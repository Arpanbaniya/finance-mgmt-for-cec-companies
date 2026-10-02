"use client";
import { Button } from "@/components/ui/button";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main className="mx-auto max-w-lg px-5 py-24"><h1 className="text-2xl">This page could not load</h1><p className="my-5 text-muted-foreground">Your saved records are preserved. Try loading the page again.</p><Button onClick={reset}>Try again</Button></main>;
}
