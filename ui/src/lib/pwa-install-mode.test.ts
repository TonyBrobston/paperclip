import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const uiRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function readManifest(): { display?: string; icons?: { sizes?: string; type?: string }[] } {
  return JSON.parse(readFileSync(resolve(uiRoot, "public/site.webmanifest"), "utf8"));
}

describe("PWA install mode", () => {
  it("launches home-screen installs without browser controls", () => {
    expect(readManifest().display).toBe("standalone");
  });

  it("declares the icon sizes browsers require to offer an install", () => {
    const declaredPngSizes = (readManifest().icons ?? [])
      .filter((icon) => icon.type === "image/png")
      .map((icon) => icon.sizes);

    expect(declaredPngSizes).toContain("192x192");
    expect(declaredPngSizes).toContain("512x512");
  });

  it("fetches the manifest with credentials so authenticating proxies can serve it", () => {
    const html = readFileSync(resolve(uiRoot, "index.html"), "utf8");

    // Browsers fetch <link rel="manifest"> in "omit credentials" mode unless
    // the link opts in. Behind an authenticating reverse proxy (e.g. a
    // managed-hosting front door), the cookie-less request is rejected on
    // every page load.
    expect(html).toContain('rel="manifest" href="/site.webmanifest" crossorigin="use-credentials"');
  });
});
