import { describe, expect, it } from "vitest";

import { DENIED_SYSCALLS, DENIED_SYSCALLS_ARM64, SECCOMP_ARCH_AARCH64, SECCOMP_ARCH_X86_64, seccompBytes, seccompProgram, seccompSupported, seccompTarget, simulate } from "./seccomp.ts";

const denied = (name: string) => DENIED_SYSCALLS.find(([n]) => n === name)![1];

describe("the box's seccomp filter", () => {
  it("refuses each denied call with EPERM, allows everything else, and kills a foreign-architecture process", () => {
    const program = seccompProgram();
    for (const [name, nr] of DENIED_SYSCALLS) expect(simulate(program, SECCOMP_ARCH_X86_64, nr), name).toBe("eperm");
    // read, write, openat, clone, clone3, execve, unshare, ptrace, socket, connect: what engines, shells and Chrome use.
    for (const nr of [0, 1, 257, 56, 435, 59, 272, 101, 41, 42, 230, 202]) expect(simulate(program, SECCOMP_ARCH_X86_64, nr), String(nr)).toBe("allow");
    expect(simulate(program, 0xc00000b7, denied("mount"))).toBe("kill");
    expect(simulate(program, 0xc00000b7, 0)).toBe("kill");
  });

  it("packs instructions as the kernel reads struct sock_filter", () => {
    const bytes = seccompBytes(seccompProgram([["mount", 165]]));
    expect(bytes.length).toBe(7 * 8);
    // ld [4] (arch)
    expect([...bytes.subarray(0, 8)]).toEqual([0x20, 0x00, 0, 0, 4, 0, 0, 0]);
    // jeq AUDIT_ARCH_X86_64, +1, +0
    expect([...bytes.subarray(8, 16)]).toEqual([0x15, 0x00, 1, 0, 0x3e, 0x00, 0x00, 0xc0]);
    // ret KILL_PROCESS
    expect([...bytes.subarray(16, 24)]).toEqual([0x06, 0x00, 0, 0, 0x00, 0x00, 0x00, 0x80]);
    // jeq 165 → +1 (the EPERM return past the allow)
    expect([...bytes.subarray(32, 40)]).toEqual([0x15, 0x00, 1, 0, 165, 0, 0, 0]);
    expect([...bytes.subarray(48, 56)]).toEqual([0x06, 0x00, 0, 0, 0x01, 0x00, 0x05, 0x00]);
  });

  it("on arm64 refuses the same calls by arm64's numbers, allows the rest, and kills x86-64 and 32-bit compat processes", () => {
    const target = seccompTarget("arm64")!;
    expect(target.auditArch).toBe(SECCOMP_ARCH_AARCH64);
    const program = seccompProgram(target.denied, target.auditArch);
    for (const [name, nr] of DENIED_SYSCALLS_ARM64) expect(simulate(program, SECCOMP_ARCH_AARCH64, nr), name).toBe("eperm");
    // read, write, openat, clone, clone3, execve, unshare, ptrace, socket, connect, exit_group on arm64.
    for (const nr of [63, 64, 56, 220, 435, 221, 97, 117, 198, 203, 94]) expect(simulate(program, SECCOMP_ARCH_AARCH64, nr), String(nr)).toBe("allow");
    expect(simulate(program, SECCOMP_ARCH_X86_64, 0)).toBe("kill");
    expect(simulate(program, 0x40000028, 0)).toBe("kill");
    expect(DENIED_SYSCALLS_ARM64.map(([name]) => name).sort()).toEqual(DENIED_SYSCALLS.map(([name]) => name).filter((name) => name !== "iopl" && name !== "ioperm").sort());
  });

  it("every denied number is unique per architecture, and the filter is built for x86-64 and arm64 Linux only", () => {
    for (const list of [DENIED_SYSCALLS, DENIED_SYSCALLS_ARM64]) expect(new Set(list.map(([, nr]) => nr)).size).toBe(list.length);
    expect(seccompSupported("x64", "linux")).toBe(true);
    expect(seccompSupported("arm64", "linux")).toBe(true);
    expect(seccompSupported("riscv64", "linux")).toBe(false);
    expect(seccompSupported("x64", "darwin")).toBe(false);
  });
});
