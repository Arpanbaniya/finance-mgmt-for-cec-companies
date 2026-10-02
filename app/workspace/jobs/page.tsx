import Link from "next/link";
import { headers } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { configured } from "@/db/client";
import { auth } from "@/features/identity/auth";
import { uuid } from "@/features/platform/contracts";
import { DomainError } from "@/domain/errors";
import { getEntity } from "@/features/platform/service";
import { getJob } from "@/features/jobs/service";
import { JobCard } from "@/features/jobs/job-card";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Delivery job" };
export default async function JobsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!configured()) redirect("/sign-in");
  const identity = await auth().api.getSession({ headers: await headers() });
  if (!identity) redirect("/sign-in");
  const query = await searchParams, org = uuid.safeParse(query.org), entity = uuid.safeParse(query.entity), id = uuid.safeParse(query.job);
  if (!org.success || !entity.success || !id.success) notFound();
  let data;
  try { data = await Promise.all([getEntity(identity.user.id, org.data, entity.data), getJob(identity.user.id, org.data, entity.data, id.data)]); }
  catch (error) { if (error instanceof DomainError && [403, 404].includes(error.status)) notFound(); throw error; }
  const [company, job] = data;
  return <main className="mx-auto max-w-3xl px-5 py-8 sm:px-10"><header className="flex flex-wrap items-center justify-between gap-3 border-b pb-6"><Brand /><Button asChild variant="outline"><Link href={`/workspace/controls?org=${org.data}&entity=${entity.data}`}>Back to controls</Link></Button></header><div className="py-8"><h1 className="text-3xl font-medium">Delivery job</h1><p className="mt-3 break-words text-muted-foreground">{company.name} · Private reviewer delivery status and controlled recovery.</p></div><JobCard key={`${job.id}-${job.version}`} job={job} /></main>;
}
