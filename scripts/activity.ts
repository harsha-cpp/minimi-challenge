import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { activityReport, markTestVisitor } from "../src/runtime/visits.ts";

export function activityCommand(args: string[]): unknown {
  const [command,path,...rest] = args;
  if (!path) throw new Error("A database path is required.");
  if (command === "mark-test" && rest.length === 2) {
    markTestVisitor(path,rest[0]!,rest[1]!);
    return { visitor:rest[0],classification:"operator_labelled_test",label:rest[1] };
  }
  if (command !== "report" || rest.length % 2) throw new Error("Usage: activity.ts report DATABASE [--since ISO] [--until ISO] [--tz ZONE] [--limit 200] | mark-test DATABASE VISITOR LABEL");
  const options = new Map<string,string>();
  for(let index=0;index<rest.length;index+=2) {
    if(!["--since","--until","--tz","--limit"].includes(rest[index]!) || options.has(rest[index]!)) throw new Error("Invalid or duplicate activity option.");
    options.set(rest[index]!,rest[index+1]!);
  }
  const now=Date.now();
  const instant=(key:string,fallback:number) => { const raw=options.get(key);if(!raw)return fallback;
    if(!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) throw new Error("Activity timestamps require an explicit UTC offset.");
    return Date.parse(raw); };
  return activityReport(path,{since:instant("--since",now-86_400_000),until:instant("--until",now),timeZone:options.get("--tz") ?? "UTC",limit:options.has("--limit") ? Number(options.get("--limit")) : 200,now});
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(activityCommand(process.argv.slice(2)),null,2)+"\n"); }
  catch(error) { process.stderr.write((error instanceof Error ? error.message : "Activity report failed")+"\n");process.exitCode=1; }
}
