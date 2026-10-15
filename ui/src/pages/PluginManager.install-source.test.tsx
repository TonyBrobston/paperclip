// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";

const mockPluginsApi = vi.hoisted(() => ({
  list: vi.fn(),
  listBundled: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}));

vi.mock("@/api/plugins", () => ({ pluginsApi: mockPluginsApi }));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: unknown }) =>
    createElement("a", { href: to, ...rest }, children as never),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: "company", name: "Company" } }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));

import { PluginManager } from "./PluginManager";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact(cycles = 6) {
  // The macrotask between cycles is what lets the plugin-list queries settle;
  // microtasks alone leave the page rendering its loading state.
  for (let i = 0; i < cycles; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await act(async () => {
      await Promise.resolve();
    });
  }
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function renderPluginManager() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(() => {
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, createElement(PluginManager)),
    );
  });
  await flushReact();
}

/** Open the "Install Plugin" dialog and submit `source` through its one text box. */
async function submitInstallSource(source: string) {
  const openButton = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Install Plugin"),
  );
  await act(() => openButton?.click());
  await flushReact();

  const input = document.querySelector<HTMLInputElement>("#packageName");
  if (!input) throw new Error("install dialog did not render its package input");

  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(() => {
    setValue?.call(input, source);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flushReact();

  const submit = [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Install",
  );
  await act(() => submit?.click());
  await flushReact();
}

describe("PluginManager install dialog source classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPluginsApi.list.mockResolvedValue([]);
    mockPluginsApi.listBundled.mockResolvedValue([]);
    mockPluginsApi.install.mockResolvedValue({ id: "plugin", status: "ready" });
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
  });

  it("sends isLocalPath for an absolute server path", async () => {
    await renderPluginManager();
    await submitInstallSource("/paperclip/plugins/paperclip-plugin-home-assistant");

    expect(mockPluginsApi.install).toHaveBeenCalledWith({
      packageName: "/paperclip/plugins/paperclip-plugin-home-assistant",
      isLocalPath: true,
    });
  });

  it("leaves an npm package name on the npm path", async () => {
    await renderPluginManager();
    await submitInstallSource("@paperclipai/plugin-example");

    expect(mockPluginsApi.install).toHaveBeenCalledWith({
      packageName: "@paperclipai/plugin-example",
      isLocalPath: false,
    });
  });

  it("trims a pasted path before sending it", async () => {
    await renderPluginManager();
    await submitInstallSource("  /opt/paperclip-plugin-home-assistant  ");

    expect(mockPluginsApi.install).toHaveBeenCalledWith({
      packageName: "/opt/paperclip-plugin-home-assistant",
      isLocalPath: true,
    });
  });
});
