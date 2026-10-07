import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { allTerminals } from "./term.ts";

const run = promisify(execFile);
const sh = (cmd: string, args: string[]) => run(cmd, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).then((r) => r.stdout, () => ""); // lsof exits 1 when nothing matches

export type PortInfo = {
  port: number;
  addr: string;
  pid: number;
  ppid: number;
  name: string; // short process name
  command: string; // full command line
  cwd: string | null;
  started: string;
  user: string;
  cpu: number; // % of one core, as ps reports it
  mem: number; // resident bytes
  terminalId: string | null; // Zippy terminal session that (transitively) started it
  self: boolean; // Zippy's own server
};

type Proc = { pid: number; ppid: number; started: string; user: string; cpu: number; mem: number; command: string };

/** One `ps` for every process: parents, start time and full command lines. */
async function procs(): Promise<Map<number, Proc>> {
  const out = await sh("ps", ["-axo", "pid=,ppid=,user=,%cpu=,rss=,lstart=,command="]);
  const m = new Map<number, Proc>();
  for (const line of out.split("\n")) {
    // "  123   1 apple  0.3  45120 Fri Oct  2 19:58:43 2026 /usr/bin/foo --bar"
    const r = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
    if (r) m.set(Number(r[1]), { pid: Number(r[1]), ppid: Number(r[2]), user: r[3]!, cpu: Number(r[4]), mem: Number(r[5]) * 1024, started: new Date(r[6]!).toISOString(), command: r[7]! });
  }
  return m;
}

async function cwds(pids: number[]): Promise<Map<number, string>> {
  const m = new Map<number, string>();
  if (!pids.length) return m;
  let pid = 0;
  for (const line of (await sh("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fpn"])).split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n") m.set(pid, line.slice(1));
  }
  return m;
}

/** Listening TCP ports with the process behind each, like `lsof -iTCP -sTCP:LISTEN` with the parts people actually want. */
export async function listPorts(only?: number): Promise<PortInfo[]> {
  const raw = await sh("lsof", ["-nP", "-iTCP" + (only ? `:${only}` : ""), "-sTCP:LISTEN", "-Fpcn"]);
  const seen = new Map<string, { pid: number; name: string; addr: string; port: number }>();
  let pid = 0;
  let name = "";
  for (const line of raw.split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "c") name = line.slice(1);
    else if (line[0] === "n") {
      const i = line.lastIndexOf(":");
      const port = Number(line.slice(i + 1));
      const addr = line.slice(1, i);
      seen.set(`${pid}:${port}:${addr}`, { pid, name, addr, port }); // IPv4 + IPv6 rows collapse per addr
    }
  }
  const rows = [...seen.values()];
  if (!rows.length) return [];
  const [ps, cwd] = await Promise.all([procs(), cwds([...new Set(rows.map((r) => r.pid))])]);
  const termByPid = new Map(allTerminals().map((t) => [t.pid, t.id]));
  const ownerTerminal = (p: number) => {
    for (let hops = 0; hops < 50 && p > 1; hops++) {
      const hit = termByPid.get(p);
      if (hit) return hit;
      p = ps.get(p)?.ppid ?? 0;
    }
    return null;
  };
  return rows
    .map((r) => {
      const p = ps.get(r.pid);
      return {
        port: r.port,
        addr: r.addr,
        pid: r.pid,
        ppid: p?.ppid ?? 0,
        name: r.name,
        command: p?.command ?? r.name,
        cwd: cwd.get(r.pid) ?? null,
        started: p?.started ?? "",
        user: p?.user ?? "",
        cpu: p?.cpu ?? 0,
        mem: p?.mem ?? 0,
        terminalId: ownerTerminal(r.pid),
        self: r.pid === process.pid,
      };
    })
    .sort((a, b) => a.port - b.port || a.pid - b.pid);
}

/** SIGTERM by default; `force` sends SIGKILL. Never Zippy's own server. */
export function killPid(pid: number, force = false) {
  if (pid === process.pid || pid <= 1) throw new Error("Refusing to kill Zippy's own server");
  process.kill(pid, force ? "SIGKILL" : "SIGTERM");
}
