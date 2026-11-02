import { execFileSync, spawnSync } from "node:child_process";
import { expect, it } from "vitest";

interface PackResult {
  name: string;
  files: Array<{ path: string }>;
}

/** The published tarball, as `npm pack` builds it (runs `prepack`, i.e. the build). */
function packedFiles(): string[] {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
  const [result] = JSON.parse(output.slice(output.indexOf("["))) as PackResult[];
  return (result?.files ?? []).map((file) => file.path).sort();
}

it("publishes only the ESM build with type declarations, README and LICENSE", { timeout: 60_000 }, () => {
  const files = packedFiles();

  expect(files).toContain("dist/index.js");
  expect(files).toContain("dist/index.d.ts");
  expect(files.filter((file) => !file.startsWith("dist/"))).toEqual(["LICENSE", "README.md", "package.json"]);
  expect(files.filter((file) => file.startsWith("dist/") && !/\.(js|d\.ts)$/.test(file))).toEqual([]);

  const node = (code: string, type: "module" | "commonjs") =>
    spawnSync(process.execPath, [`--input-type=${type}`, "-e", code], { encoding: "utf8" });
  const imported = node(
    'const m = await import("@stibbons/chat-adapter-signal"); console.log(typeof m.createSignalAdapter)',
    "module",
  );
  expect(imported.stdout.trim()).toBe("function");
  const required = node('require("@stibbons/chat-adapter-signal")', "commonjs");
  expect(required.status).not.toBe(0);
  expect(required.stderr).toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");
});

it("installs nothing from signal-cli or libsignal (ADR-0001)", () => {
  const tree = JSON.parse(execFileSync("npm", ["ls", "--omit=dev", "--all", "--json"], { encoding: "utf8" })) as unknown;
  const names: string[] = [];
  const walk = (node: { dependencies?: Record<string, unknown> }) => {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      names.push(name);
      walk(child as { dependencies?: Record<string, unknown> });
    }
  };
  walk(tree as { dependencies?: Record<string, unknown> });

  expect(names).toContain("@chat-adapter/shared");
  expect(names.filter((name) => /signal-cli|libsignal/i.test(name))).toEqual([]);
});
