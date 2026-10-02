import Link from "next/link";
export default function NotFound() { return <main className="mx-auto max-w-lg px-5 py-24"><h1 className="text-3xl">Page unavailable</h1><p className="my-5 text-muted-foreground">This page does not exist or is outside the available release.</p><Link href="/" className="text-primary">Return home →</Link></main>; }
