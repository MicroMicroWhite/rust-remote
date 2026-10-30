import { describe, expect, test } from "bun:test";
import { parsePorts } from "../src/ports";

describe("port command compatibility", () => {
  test("Linux TCP/UDP and IPv6 with multiple owners", () => {
    const result = parsePorts(`Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port Process
tcp LISTEN 0 128 [::]:22 [::]:* users:(("sshd",pid=42,fd=3),("sshd",pid=43,fd=3))
udp UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*`);
    expect(result.unparsed).toBe(0);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ protocol: "TCP", local: "[::]:22", remote: "[::]:*", pid: 42, process: "sshd" });
    expect(result.items[1]).toMatchObject({ pid: null, state: "UNCONN", local: "127.0.0.53%lo:53" });
  });
  test("Windows localized headers, states and UDP", () => {
    const result = parsePorts(`活动连接\r\n 协议 本地地址 外部地址 状态 PID
 TCP 0.0.0.0:135 0.0.0.0:0 LISTENING 100
 TCP [::1]:8080 [::1]:60000 ESTABLISHED 200
 UDP [::]:5353 *:* 300
 TCP 127.0.0.1:80 127.0.0.1:5000 已建立 201`);
    expect(result.items).toHaveLength(4);
    expect(result.items[2]).toMatchObject({ protocol: "UDP", state: "—", pid: 300 });
    expect(result.items[3].state).toBe("已建立");
  });
  test("malformed connection lines are reported", () => {
    expect(parsePorts("tcp invalid row\nUDP missing")).toEqual({ items: [], unparsed: 2 });
  });
});
