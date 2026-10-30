export type PortConnection = {
  key: string;
  protocol: string;
  local: string;
  remote: string;
  state: string;
  pid: number | null;
  process: string;
};

// ss -tunap (Linux) and netstat -ano (Windows). Endpoint columns stay intact
// for IPv6, wildcard addresses and localized Windows headings/state names.
export function parsePorts(output: string): { items: PortConnection[]; unparsed: number } {
  const items: PortConnection[] = [];
  let unparsed = 0;
  for (const [index, line] of output.split(/\r?\n/).entries()) {
    const fields = line.trim().split(/\s+/);
    if (!/^(tcp|udp)(6)?$/i.test(fields[0] || "")) continue;
    const protocol = fields[0].toUpperCase();
    const linux = fields.length >= 6 && /^\d+$/.test(fields[2]) && /^\d+$/.test(fields[3]);
    let local: string, remote: string, state: string, pid: number | null;
    let process = "";
    if (linux) {
      [, state, , , local, remote] = fields;
      const details = fields.slice(6).join(" ");
      const ids = [...details.matchAll(/pid=(\d+)/g)];
      pid = ids.length ? Number(ids[0][1]) : null;
      process = [...new Set([...details.matchAll(/\("([^"]+)"/g)].map((m) => m[1]))].join(", ");
    } else {
      const udp = protocol.startsWith("UDP");
      if (fields.length < (udp ? 4 : 5) || !/^\d+$/.test(fields.at(-1) || "")) { unparsed++; continue; }
      local = fields[1]; remote = fields[2];
      state = udp ? "—" : fields[3];
      pid = Number(fields.at(-1));
    }
    if (!local.includes(":") || !remote.includes(":")) { unparsed++; continue; }
    items.push({ key: `${index}-${protocol}-${local}-${remote}`, protocol, local, remote, state, pid, process });
  }
  return { items, unparsed };
}
