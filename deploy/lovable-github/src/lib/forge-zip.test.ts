import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  createProjectZip,
  inspectProjectSources,
  ZIP_MAX_BYTES,
  ZIP_MAX_FILE_BYTES,
} from "./forge-zip";
describe("source-only ZIP integrity", () => {
  it("round-trips exact UTF8, CRLF, empty files, .gitignore and the original README without injecting metadata", async () => {
    const files = [
      { name: "index.html", content: "<!doctype html>\r\n<h1>Žltý kôň 🐎</h1>\r\n" },
      { name: "README.md", content: "# Moje pokyny\nVlastný obsah." },
      { name: ".gitignore", content: "node_modules\n.env\n" },
      { name: "src/žltý.ts", content: "" },
    ];
    const before = structuredClone(files),
      promise = createProjectZip(files, "../Žltý: Projekt", 2);
    files[0]!.content = "changed while generating";
    const archive = await promise,
      zip = await JSZip.loadAsync(archive.bytes, { checkCRC32: true });
    expect(Object.keys(zip.files).sort()).toEqual(before.map((f) => f.name).sort());
    for (const file of before)
      expect(await zip.file(file.name)!.async("string")).toBe(file.content);
    expect(archive.filename).toBe("zlty-projekt-v2.zip");
    expect(archive.fileCount).toBe(4);
  });
  it.each([
    "/etc/passwd",
    "../x",
    "src/../x",
    "src/./x",
    "src//x",
    "src\\x",
    "C:/x",
    "x/",
    "src/a\u0000b",
    "src/a\u202eb",
    "src/a:stream",
    "src/CON.txt",
    "src/x. ",
    ".env.local",
    ".envrc",
    "src/" + "ž".repeat(128) + ".txt",
    "SRC/.ENV",
    ".git/config",
    "node_modules/a.js",
    "dist/app.js",
    ".npmrc",
  ])("rejects the whole archive for unsafe path %j", async (name) => {
    await expect(
      createProjectZip(
        [
          { name: "index.html", content: "valid" },
          { name, content: "data" },
        ],
        "test",
      ),
    ).rejects.toThrow();
  });
  it.each([
    ["src/App.tsx", "src/app.tsx"],
    ["src/é.ts", "src/e\u0301.ts"],
    ["src/a", "src/a/b.ts"],
  ])("rejects extraction collisions %j", async (a, b) => {
    await expect(
      createProjectZip(
        [
          { name: a!, content: "a" },
          { name: b!, content: "b" },
        ],
        "test",
      ),
    ).rejects.toThrow();
  });
  it.each([
    "ghp_" + "FAKE".repeat(5),
    "sk_live_" + "FAKE".repeat(5),
    "whsec_" + "FAKE".repeat(5),
    "-----BEGIN PRIVATE KEY-----",
    'OPENAI_API_KEY="synthetic-only-value"',
    '{"MISTRAL_API_KEY":"synthetic-only-value"}',
  ])("blocks credential-shaped content without omitting the file", async (content) => {
    await expect(createProjectZip([{ name: "src/config.ts", content }], "test")).rejects.toThrow(
      /kľúč/,
    );
  });
  it("uses UTF8 bytes for file/aggregate limits and refuses empty/over-count archives", () => {
    expect(inspectProjectSources([]).errors.length).toBeGreaterThan(0);
    expect(
      inspectProjectSources(
        Array.from({ length: 201 }, (_, i) => ({ name: `src/${i}.ts`, content: "" })),
      ).errors.length,
    ).toBeGreaterThan(0);
    const content = "ž".repeat(ZIP_MAX_FILE_BYTES / 2 + 1);
    expect(inspectProjectSources([{ name: "src/a.txt", content }]).errors.join()).toContain(
      "10 MiB",
    );
    const files = Array.from({ length: 6 }, (_, i) => ({
      name: `src/${i}.txt`,
      content: "x".repeat(ZIP_MAX_BYTES / 5),
    }));
    expect(inspectProjectSources(files).errors.join()).toContain("50 MiB");
  });
  it("preserves useful app content and reports incomplete sources without inventing missing files", async () => {
    const files = [
      { name: "src/login.ts", content: 'const password = ""; const apiKey = userInput;' },
    ];
    expect(inspectProjectSources(files).errors).toEqual([]);
    expect(inspectProjectSources(files).warnings).toHaveLength(2);
    const zip = await JSZip.loadAsync((await createProjectZip(files, "")).bytes);
    expect(Object.keys(zip.files)).toEqual(["src/login.ts"]);
  });
});
