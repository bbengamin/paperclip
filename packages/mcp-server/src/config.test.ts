import path from "node:path";
import { describe, expect, it } from "vitest";
import { readConfig } from "./config.js";

function makeReader(files: Record<string, unknown>) {
  return (filePath: string) => {
    const value = files[path.resolve(filePath)];
    return value === undefined ? null : JSON.stringify(value);
  };
}

describe("paperclip MCP config", () => {
  it("uses explicit env vars without reading CLI files", () => {
    const config = readConfig({
      env: {
        PAPERCLIP_API_URL: "https://env.paperclip.test/",
        PAPERCLIP_API_KEY: "env-token",
        PAPERCLIP_COMPANY_ID: "env-company",
        PAPERCLIP_AGENT_ID: "env-agent",
        PAPERCLIP_RUN_ID: "env-run",
      },
      readFile: () => {
        throw new Error("should not read CLI files");
      },
    });

    expect(config).toEqual({
      apiUrl: "https://env.paperclip.test/api",
      apiKey: "env-token",
      companyId: "env-company",
      agentId: "env-agent",
      runId: "env-run",
    });
  });

  it("falls back to active Paperclip CLI context and board credential", () => {
    const homeDir = "/tmp/paperclip-home";
    const contextPath = path.join(homeDir, ".paperclip", "context.json");
    const authPath = path.join(homeDir, ".paperclip", "auth.json");

    const config = readConfig({
      env: {},
      homeDir,
      readFile: makeReader({
        [contextPath]: {
          version: 2,
          currentProfile: "right-link",
          profiles: {
            "right-link": {
              apiBase: "https://paperclip.right.link/",
              companyId: "company-from-context",
            },
          },
        },
        [authPath]: {
          version: 1,
          credentials: {
            "https://paperclip.right.link": {
              apiBase: "https://paperclip.right.link",
              token: "board-token",
              createdAt: "2026-06-06T14:45:57.209Z",
              updatedAt: "2026-06-07T15:01:00.741Z",
            },
          },
        },
      }),
    });

    expect(config).toEqual({
      apiUrl: "https://paperclip.right.link/api",
      apiKey: "board-token",
      companyId: "company-from-context",
      agentId: null,
      runId: null,
    });
  });

  it("lets env values override CLI context values independently", () => {
    const homeDir = "/tmp/paperclip-home";
    const contextPath = path.join(homeDir, ".paperclip", "context.json");
    const authPath = path.join(homeDir, ".paperclip", "auth.json");

    const config = readConfig({
      env: {
        PAPERCLIP_API_URL: "https://env.paperclip.test",
        PAPERCLIP_COMPANY_ID: "env-company",
      },
      homeDir,
      readFile: makeReader({
        [contextPath]: {
          currentProfile: "default",
          profiles: {
            default: {
              apiBase: "https://context.paperclip.test",
              companyId: "context-company",
            },
          },
        },
        [authPath]: {
          credentials: {
            "https://env.paperclip.test": {
              apiBase: "https://env.paperclip.test",
              token: "env-base-board-token",
              createdAt: "2026-06-06T14:45:57.209Z",
              updatedAt: "2026-06-07T15:01:00.741Z",
            },
          },
        },
      }),
    });

    expect(config.apiUrl).toBe("https://env.paperclip.test/api");
    expect(config.apiKey).toBe("env-base-board-token");
    expect(config.companyId).toBe("env-company");
  });

  it("honors PAPERCLIP_CONTEXT and PAPERCLIP_AUTH_STORE overrides", () => {
    const contextPath = "/tmp/custom-context.json";
    const authPath = "/tmp/custom-auth.json";

    const config = readConfig({
      env: {
        PAPERCLIP_CONTEXT: contextPath,
        PAPERCLIP_AUTH_STORE: authPath,
      },
      homeDir: "/tmp/unused-home",
      readFile: makeReader({
        [contextPath]: {
          currentProfile: "custom",
          profiles: {
            custom: {
              apiBase: "https://custom.paperclip.test",
              companyId: "custom-company",
            },
          },
        },
        [authPath]: {
          credentials: {
            "https://custom.paperclip.test": {
              apiBase: "https://custom.paperclip.test",
              token: "custom-token",
              createdAt: "2026-06-06T14:45:57.209Z",
              updatedAt: "2026-06-07T15:01:00.741Z",
            },
          },
        },
      }),
    });

    expect(config.apiUrl).toBe("https://custom.paperclip.test/api");
    expect(config.apiKey).toBe("custom-token");
    expect(config.companyId).toBe("custom-company");
  });

  it("fails with setup instructions when CLI context is missing an apiBase", () => {
    expect(() =>
      readConfig({
        env: {},
        homeDir: "/tmp/no-context",
        readFile: () => null,
      }),
    ).toThrow(/paperclipai context set --api-base <url> --use/);
  });

  it("fails with auth instructions without leaking stored credential material", () => {
    const homeDir = "/tmp/paperclip-home";
    const contextPath = path.join(homeDir, ".paperclip", "context.json");
    const authPath = path.join(homeDir, ".paperclip", "auth.json");

    expect(() =>
      readConfig({
        env: {},
        homeDir,
        readFile: makeReader({
          [contextPath]: {
            currentProfile: "default",
            profiles: {
              default: {
                apiBase: "https://paperclip.right.link",
                companyId: "company-from-context",
              },
            },
          },
          [authPath]: {
            credentials: {},
          },
        }),
      }),
    ).toThrow(/paperclipai auth login --api-base https:\/\/paperclip\.right\.link/);
  });

  it("fails with context instructions when company context is missing", () => {
    const homeDir = "/tmp/paperclip-home";
    const contextPath = path.join(homeDir, ".paperclip", "context.json");
    const authPath = path.join(homeDir, ".paperclip", "auth.json");

    expect(() =>
      readConfig({
        env: {},
        homeDir,
        readFile: makeReader({
          [contextPath]: {
            currentProfile: "default",
            profiles: {
              default: {
                apiBase: "https://paperclip.right.link",
              },
            },
          },
          [authPath]: {
            credentials: {
              "https://paperclip.right.link": {
                apiBase: "https://paperclip.right.link",
                token: "board-token",
                createdAt: "2026-06-06T14:45:57.209Z",
                updatedAt: "2026-06-07T15:01:00.741Z",
              },
            },
          },
        }),
      }),
    ).toThrow(/paperclipai context set --company-id <company-id> --use/);
  });
});
